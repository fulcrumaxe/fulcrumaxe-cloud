import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import type { HandoffCloudTarget } from '@fx/runner-cloud';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { handoffRouteDeps } from '../src/routes/run-handoff.js';
import { effectivePrincipals } from '../src/registry.js';
import { seedAccountWithMember } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Body {
  error?: { code: string };
  details?: Array<{ path: string; code: string }>;
  [key: string]: unknown;
}

/** [pg] D#599 HO-2a: the two handoff routes through the real dispatcher: who may call, the fail-closed default, the answers. The service has its own suite in @fx/runner-cloud. */
describe('run handoff routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const original = { ...handoffRouteDeps };

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end()]);
  });
  afterEach(() => Object.assign(handoffRouteDeps, original));

  /** Admits with two unattached reservations, as spend's `reserve()` does, or refuses. */
  const target = (refuse = false): HandoffCloudTarget => ({
    seat: async () => ({
      ok: true,
      reserve: async (client) => {
        if (refuse) return { ok: false, reason: 'model_budget_exceeded' };
        const insert = async (budget: string) =>
          (await client.query<{ id: string }>("INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES (current_setting('app.account_id')::uuid, NULL, 1, 'open', $1, 'run') RETURNING id", [budget])).rows[0]!.id;
        return { ok: true, reservations: { modelId: await insert('model'), computeId: await insert('foreground_compute') } };
      },
    }),
  });

  async function post(who: Identity | string, urlPath: string, body?: unknown): Promise<Response> {
    const h = new Headers({ 'content-type': 'application/json' });
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method: 'POST', headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  async function world(role: 'owner' | 'admin' | 'member' = 'owner') {
    const who = await seedAccountWithMember(admin, { role });
    const repo = randomUUID();
    await admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', 'widgets', 'runner_local')", [repo, who.accountId, Math.floor(Math.random() * 1e9) + 1]);
    const item = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')", [item, who.accountId, repo]);
    await admin.query("INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status) VALUES ($1, 'anthropic', $2, $3, $4, 1, 'fp', 'ok')", [who.accountId, Buffer.from('c'), Buffer.from('n'), Buffer.from('d')]);
    const run = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, work_item_id) VALUES ($1, $2, 'executor', 'runner', 'running', 'runner_local', $3, $4)", [run, who.accountId, repo, item]);
    // The runner holding the run is new enough to be told (a request for an older one is refused up front).
    const runner = randomUUID();
    await admin.query("INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode, protocol_version) VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription', 2)", [runner, who.accountId, who.userId, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: Buffer.from(runner.replace(/-/g, ''), 'hex').toString('base64url').padEnd(43, 'A').slice(0, 43) }), Buffer.from(runner.replace(/-/g, '') + runner.replace(/-/g, ''), 'hex').toString('base64url').slice(0, 43)]);
    await admin.query('UPDATE agent_runs SET runner_id = $2 WHERE id = $1', [run, runner]);
    return { who, run, item };
  }
  const handoffs = async (run: string) => (await admin.query('SELECT state FROM run_handoffs WHERE run_id = $1 ORDER BY created_at', [run])).rows.map((r) => r.state as string);

  it('both routes are session-only, owner or admin, and the request is one that starts a run (so no token may list it)', () => {
    for (const operationId of ['requestRunHandoff', 'cancelRunHandoff']) {
      const route = ROUTES.find((r) => r.operationId === operationId)!;
      expect(effectivePrincipals(route), operationId).toEqual(['session']);
      expect(route.minRole, operationId).toBe('admin');
      expect(route.idempotency, operationId).toBe('never');
    }
    expect(ROUTES.find((r) => r.operationId === 'requestRunHandoff')!.startsRun).toBe(true);
  });

  it('with nothing wired in it fails closed: 503 handoff_unavailable for either side, and nothing is written', async () => {
    const w = await world();
    const sandbox = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, work_item_id) VALUES ($1, $2, 'executor', 'production', 'running', 'sandbox', (SELECT repo_id FROM work_items WHERE id = $3), $3)", [sandbox, w.who.accountId, w.item]);
    for (const [run, to] of [[w.run, 'cloud'], [sandbox, 'runner']] as const) {
      const res = await post(w.who, `/runs/${run}/handoff`, { to });
      expect([res.status, ((await res.json()) as Body).error?.code], to).toEqual([503, 'handoff_unavailable']);
      expect(await handoffs(run)).toEqual([]);
    }
  });

  it('an owner moves a run to the cloud (202 with the request), a second ask is 409, and cancelling puts it back', async () => {
    handoffRouteDeps.cloudTarget = target();
    const w = await world();
    const res = await post(w.who, `/runs/${w.run}/handoff`, { to: 'cloud' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Body;
    expect(body).toMatchObject({ run_id: w.run, state: 'requested', from: 'runner', to: 'cloud' });
    expect(Date.parse(body.deadline as string) - Date.now()).toBeGreaterThan(290_000);
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    expect((await admin.query('SELECT placement FROM work_items WHERE id = $1', [w.item])).rows[0].placement).toBe('cloud');
    const again = await post(w.who, `/runs/${w.run}/handoff`, { to: 'cloud' });
    expect([again.status, ((await again.json()) as Body).error?.code]).toEqual([409, 'handoff_in_progress']);
    const cancelled = await post(w.who, `/runs/${w.run}/handoff/cancel`);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ run_id: w.run, state: 'cancelled', placement_restored: true });
    expect(await handoffs(w.run)).toEqual(['cancelled']);
    expect((await admin.query('SELECT count(*)::int AS n FROM spend_reservations WHERE account_id = $1 AND state = \'open\'', [w.who.accountId])).rows[0].n).toBe(0);
    const none = await post(w.who, `/runs/${w.run}/handoff/cancel`);
    expect(none.status).toBe(404);
  });

  it('a refused spend is 409 refused_spend with the closed reason in details; a member is 403; a token is refused whatever its scopes', async () => {
    handoffRouteDeps.cloudTarget = target(true);
    const w = await world();
    const refused = await post(w.who, `/runs/${w.run}/handoff`, { to: 'cloud' });
    const body = (await refused.json()) as Body;
    expect([refused.status, body.error?.code, body.details]).toEqual([409, 'refused_spend', [{ path: 'reason', code: 'model_budget_exceeded' }]]);
    const member = await world('member');
    expect((await post(member.who, `/runs/${member.run}/handoff`, { to: 'cloud' })).status).toBe(403);
    expect((await post(member.who, `/runs/${member.run}/handoff/cancel`)).status).toBe(403);
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: w.who.accountId, createdBy: w.who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read', 'runs:cancel', 'work_items:write'], expiresAt: new Date(Date.now() + 86_400_000) });
    expect([401, 403]).toContain((await post(plaintext, `/runs/${w.run}/handoff`, { to: 'cloud' })).status);
    expect(await handoffs(w.run)).toEqual([]);
    expect(await handoffs(member.run)).toEqual([]);
  });

  it('refuses a body that is not exactly { to: "cloud" | "runner" }', async () => {
    handoffRouteDeps.cloudTarget = target();
    const w = await world();
    for (const body of [{}, { to: 'sandbox' }, { to: 'cloud', extra: 1 }, { to: 'runner_verified' }, { to: null }]) {
      expect((await post(w.who, `/runs/${w.run}/handoff`, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(await handoffs(w.run)).toEqual([]);
  });
});
