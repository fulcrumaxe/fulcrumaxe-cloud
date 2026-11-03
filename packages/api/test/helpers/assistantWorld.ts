import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { buildAad, connect, seal } from '@fx/model-connection';
import { resetPlanDataCache } from '@fx/plan-data';
import { fakeKekSource } from '../../../model-connection/test/helpers/fakeKek.js';
import { startStrictProviders, type StrictProviders } from '../../../model-connection/test/helpers/strictProviders.js';
import { turnEvents } from '../../../model-connection/test/helpers/anthropicMessagesFake.js';
import { chatTurnChunks } from '../../../model-connection/test/helpers/gatewayChatFake.js';
import { handleApiRequest } from '../../src/handler.js';
import { assistantDeps } from '../../src/routes/assistant.js';
import { seedAccountWithMember } from './seed.js';

export { turnEvents, chatTurnChunks };
/** A key built from parts at run time: no token-shaped literal in source. */
export const fakeKey = (tag: string) => ['sk', 'ant', 'api03', tag, '0123456789abcdef'].join('-');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** The plan-data test fixture with a sonnet-5.5 price (test figures only) unless `priced` is false, and the assistant cap unless null. */
export function planData(o: { cap: number | null; priced?: boolean }): Json {
  const d: Json = JSON.parse(readFileSync(new URL('../../../plan-data/fixtures/plan-data.fixture.json', import.meta.url), 'utf8'));
  if (o.priced !== false) d.pricing.claude['sonnet-5.5'] = { inputUsdPerMTok: 7, outputUsdPerMTok: 13, cacheWriteUsdPerMTok: 9, cacheReadUsdPerMTok: 11, contextWindowTokens: 200000 };
  if (o.cap !== null) d.assistant = { conversation_cap_usd: o.cap };
  return d;
}
export function usePlanData(value: Json | undefined): void {
  if (value === undefined) delete process.env.FX_PLAN_DATA;
  else process.env.FX_PLAN_DATA = JSON.stringify(value);
  resetPlanDataCache();
}

export interface Person {
  accountId: string;
  userId: string;
  repoId: string;
  key: string;
  cookie: string;
}

/** Real Postgres, the real dispatcher, and the strict TLS provider fakes: a person holds a sealed key and the assistant calls through Node's real connection path. */
export async function startWorld() {
  const adminPool = createPool(process.env.API_DATABASE_URL!);
  const admin: PoolClient = await adminPool.connect();
  const app: Pool = createPool(process.env.API_DATABASE_URL_APP_USER!);
  const ops: Pool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
  process.env.FX_SESSION_SECRET = 's'.repeat(32);
  const providers: StrictProviders = await startStrictProviders();
  providers.anthropic.messages.enabled = true;
  providers.ai_gateway.chat.enabled = true;
  const kek = fakeKekSource();
  /** A test can hold every provider call back (gate) to overlap two requests. */
  const gate: { wait: Promise<void> | null } = { wait: null };
  assistantDeps.kek = kek;
  assistantDeps.platformOpsPool = ops;
  assistantDeps.fetchImpl = (async (...a: Parameters<typeof fetch>) => {
    if (gate.wait) await gate.wait;
    return providers.transport(...a);
  }) as typeof fetch;

  async function person(o: { provider?: 'anthropic' | 'ai_gateway' | null; role?: 'owner' | 'admin' | 'member'; tag?: string } = {}): Promise<Person> {
    const t = await seedAccountWithMember(admin, { role: o.role ?? 'owner' });
    const repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', 'widgets')`, [repoId, t.accountId, Math.floor(Math.random() * 1e9) + 1]);
    const key = fakeKey(o.tag ?? randomUUID().slice(0, 8));
    const provider = o.provider === undefined ? 'ai_gateway' : o.provider;
    if (provider !== null) {
      await connect({ pool: app, platformOpsPool: ops, principal: t, httpClient: { validate: async () => ({ kind: 'ok' as const }) }, kek }, { provider: 'ai_gateway', key });
      if (provider === 'anthropic') {
        // connect() refuses 'anthropic' until its enable-flag, so that row is a gateway row re-sealed and retagged (as in model-call's world).
        const { id } = (await admin.query(`SELECT id FROM model_connections WHERE account_id = $1`, [t.accountId])).rows[0];
        const s = seal({ kek: kek.keyFor(1), aad: buildAad(t.accountId, id) }, key);
        await admin.query(`UPDATE model_connections SET provider = 'anthropic', credential_kind = 'anthropic', aad_version = 1, key_ciphertext = $2, key_nonce = $3, wrapped_dek = $4 WHERE account_id = $1`, [t.accountId, s.ciphertext, s.nonce, s.wrappedDek]);
        providers.anthropic.knownKeys.add(key);
      } else providers.ai_gateway.knownKeys.add(key);
    }
    return { ...t, repoId, key, cookie: `${SESSION_COOKIE_NAME}=${await signSession({ accountId: t.accountId, userId: t.userId })}` };
  }

  /** Another user in the same account (e.g. an owner beside a member), with their own session. */
  async function addMember(p: Person, role: 'owner' | 'admin' | 'member'): Promise<Person> {
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [p.accountId, userId, role]);
    return { ...p, userId, cookie: `${SESSION_COOKIE_NAME}=${await signSession({ accountId: p.accountId, userId })}` };
  }

  async function item(p: Person, title: string | null): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, title) VALUES ($1, $2, $3, 'bug', 'internal', $4)`, [id, p.accountId, p.repoId, title]);
    return id;
  }

  /** One request through the real dispatcher: JSON (the default) or the event stream. Returns the status and the raw body text. */
  async function send(p: Person | { cookie?: string; bearer?: string }, body: unknown, o: { stream?: boolean; signal?: AbortSignal } = {}) {
    const h = new Headers({ 'content-type': 'application/json', accept: o.stream ? 'text/event-stream' : 'application/json' });
    if ('cookie' in p && p.cookie) h.set('cookie', p.cookie);
    if ('bearer' in p && p.bearer) h.set('authorization', `Bearer ${p.bearer}`);
    const res = await handleApiRequest(new Request('http://localhost/api/v1/assistant/messages', { method: 'POST', headers: h, body: JSON.stringify(body), ...(o.signal ? { signal: o.signal } : {}) }), app, ops);
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', text, json: () => JSON.parse(text) as Json, events: () => parseSse(text) };
  }

  const conversation = async (id: string) => (await admin.query(`SELECT spent_micro_usd::int AS spent, reserved_micro_usd::int AS reserved, cap_micro_usd::int AS cap, turns FROM assistant_conversations WHERE id = $1`, [id])).rows[0] as { spent: number; reserved: number; cap: number; turns: number };

  return {
    admin, app, ops, providers, person, addMember, item, send, conversation, gate,
    calls: () => providers.anthropic.messages.calls.length + providers.ai_gateway.chat.calls.length,
    reset: () => {
      for (const f of [providers.anthropic.messages, providers.ai_gateway.chat]) {
        f.replies.length = 0;
        f.calls.length = 0;
        f.unscripted = 0;
        f.chunkBytes = 0;
      }
      providers.ai_gateway.chat.hangups = 0;
      for (const p of [providers.ai_gateway, providers.anthropic, providers.openai]) {
        p.seen.length = 0;
        p.refused.length = 0;
      }
      gate.wait = null;
    },
    stop: async () => {
      delete process.env.FX_SESSION_SECRET;
      delete assistantDeps.kek;
      delete assistantDeps.fetchImpl;
      delete assistantDeps.platformOpsPool;
      admin.release();
      await Promise.all([adminPool.end(), app.end(), ops.end(), providers.close()]);
    },
  };
}

export function parseSse(text: string): Array<{ event: string; data: Json }> {
  return text
    .split('\n\n')
    .filter((b) => b.trim() !== '' && !b.startsWith(':'))
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1] ?? '', data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) as Json }));
}
