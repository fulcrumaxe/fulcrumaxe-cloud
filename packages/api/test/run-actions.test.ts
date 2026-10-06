import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { createRecordingRunActionSignal } from '@fx/core/src/runActions/index.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { CANCELLABLE_RUN_STATUSES, runActionDeps } from '../src/routes/run-actions.js';
import { seedAccountWithMember } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface ErrBody {
  error: { code: string; message: string; request_id: string };
}
interface Accepted {
  action_id: string;
  state: string;
}

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TERMINAL = ['succeeded', 'failed', 'timed_out', 'killed_spend', 'refused_spend', 'cancelled'];

/** D#31 API-6a-2 (C32, C33): the run-action routes through the real dispatcher against real Postgres. */
describe('D#31 API-6a-2: run-action routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const signal = createRecordingRunActionSignal();

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
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });
  beforeEach(() => {
    runActionDeps.getRunActionSignal = () => signal;
    signal.sent.length = 0;
  });
  afterEach(() => {
    runActionDeps.getRunActionSignal = () => null;
  });

  async function call(who: Identity | string, method: string, urlPath: string, headers: Record<string, string> = {}): Promise<Response> {
    const h = new Headers(headers);
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h }), appUserPool, platformOpsPool, ROUTES);
  }
  const member = () => seedAccountWithMember(admin, { role: 'member' });
  async function tokenFor(who: Identity, scopes: Scope[], expiresAt = new Date(Date.now() + 86_400_000)): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: who.accountId,
      createdBy: who.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes,
      expiresAt,
    });
    return plaintext;
  }
  async function seedRun(accountId: string, status: string, workItemId?: string): Promise<string> {
    const wi = workItemId ?? (await seedWorkItem(accountId));
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'build', 'local', $4)`,
      [id, accountId, wi, status],
    );
    return id;
  }
  async function seedWorkItem(accountId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance) VALUES ($1, $2, 'feature', 'internal')`, [id, accountId]);
    return id;
  }
  const count = async (sql: string, accountId: string) => Number((await admin.query<{ n: string }>(sql, [accountId])).rows[0]!.n);
  const rowCount = (a: string) => count('SELECT count(*) AS n FROM run_action_requests WHERE account_id = $1', a);
  const auditCount = (a: string) => count(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = 'run_action.requested'`, a);
  async function expectNothingWritten(a: string) {
    expect(await rowCount(a)).toBe(0);
    expect(await auditCount(a)).toBe(0);
  }

  it('a member session cancels a run: 202 { action_id, state: accepted }, one row, one audit row, one signal', async () => {
    const m = await member();
    const run = await seedRun(m.accountId, 'running');
    const res = await call(m, 'POST', `/runs/${run}/cancel`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as Accepted;
    expect(body.state).toBe('accepted');
    expect(await rowCount(m.accountId)).toBe(1);
    expect(await auditCount(m.accountId)).toBe(1);
    expect(signal.sent).toHaveLength(1);
  });

  it('a double click (no key) gets the same action_id and writes nothing more', async () => {
    const m = await member();
    const run = await seedRun(m.accountId, 'pending');
    const first = (await (await call(m, 'POST', `/runs/${run}/cancel`)).json()) as Accepted;
    const second = await call(m, 'POST', `/runs/${run}/cancel`);
    expect(second.status).toBe(202);
    expect(((await second.json()) as Accepted).action_id).toBe(first.action_id);
    expect(await rowCount(m.accountId)).toBe(1);
    expect(await auditCount(m.accountId)).toBe(1);
  });

  it.each(TERMINAL)('a %s run is 409 not_cancellable and writes nothing', async (status) => {
    const m = await member();
    const run = await seedRun(m.accountId, status);
    const res = await call(m, 'POST', `/runs/${run}/cancel`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrBody).error.code).toBe('not_cancellable');
    await expectNothingWritten(m.accountId);
    expect(signal.sent).toEqual([]);
  });

  it('a paused run can be cancelled', async () => {
    const m = await member();
    expect((await call(m, 'POST', `/runs/${await seedRun(m.accountId, 'paused')}/cancel`)).status).toBe(202);
  });

  it('keyed replay beats the 409: with the api-layer key expired, a retry of a cancelled run gets the original action_id (mutation proof: without the bypass this is 409)', async () => {
    const m = await member();
    const run = await seedRun(m.accountId, 'running');
    const headers = { 'idempotency-key': 'k-replay-1' };
    const first = await call(m, 'POST', `/runs/${run}/cancel`, headers);
    expect(first.status).toBe(202);
    const a = (await first.json()) as Accepted;
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [run]);
    await admin.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 minute' WHERE account_id = $1 AND key = 'k-replay-1'`, [m.accountId]);
    const retry = await call(m, 'POST', `/runs/${run}/cancel`, headers);
    expect(retry.status).toBe(202);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(((await retry.json()) as Accepted).action_id).toBe(a.action_id);
    expect(await rowCount(m.accountId)).toBe(1);
    expect(await auditCount(m.accountId)).toBe(1);
    expect(signal.sent).toHaveLength(1);
    // Without a key the same run is a plain 409.
    expect((await call(m, 'POST', `/runs/${run}/cancel`)).status).toBe(409);
  });

  it('a live idempotency key is served by the api layer: same action_id, Idempotent-Replayed', async () => {
    const m = await member();
    const run = await seedRun(m.accountId, 'running');
    const headers = { 'idempotency-key': 'k-live-1' };
    const a = (await (await call(m, 'POST', `/runs/${run}/cancel`, headers)).json()) as Accepted;
    const again = await call(m, 'POST', `/runs/${run}/cancel`, headers);
    expect(again.status).toBe(202);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(((await again.json()) as Accepted).action_id).toBe(a.action_id);
    expect(await rowCount(m.accountId)).toBe(1);
  });

  it('the same key on a different target is 422 idempotency_key_reused, in either layer, with no new row', async () => {
    const m = await member();
    const r1 = await seedRun(m.accountId, 'running');
    const r2 = await seedRun(m.accountId, 'running');
    const headers = { 'idempotency-key': 'k-diff-1' };
    expect((await call(m, 'POST', `/runs/${r1}/cancel`, headers)).status).toBe(202);
    for (const expireFirst of [false, true]) {
      if (expireFirst) await admin.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 minute' WHERE account_id = $1`, [m.accountId]);
      const res = await call(m, 'POST', `/runs/${r2}/cancel`, headers);
      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrBody).error.code).toBe('idempotency_key_reused');
      expect(await rowCount(m.accountId)).toBe(1);
    }
  });

  it('a work item with no cancellable run is 409; with a paused run it is 202; a double click shares the action', async () => {
    const m = await member();
    const none = await seedWorkItem(m.accountId);
    await seedRun(m.accountId, 'succeeded', none);
    const refused = await call(m, 'POST', `/work-items/${none}/cancel`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as ErrBody).error.code).toBe('not_cancellable');
    await expectNothingWritten(m.accountId);

    const live = await seedWorkItem(m.accountId);
    await seedRun(m.accountId, 'paused', live);
    const ok = await call(m, 'POST', `/work-items/${live}/cancel`);
    expect(ok.status).toBe(202);
    const again = await call(m, 'POST', `/work-items/${live}/cancel`);
    expect(((await again.json()) as Accepted).action_id).toBe(((await ok.clone().json()) as Accepted).action_id);
    expect(await rowCount(m.accountId)).toBe(1);
  });

  it('a read token on either POST is 403 insufficient_scope; a runs:cancel-only token on the GET is 403; nothing is written', async () => {
    const m = await member();
    const run = await seedRun(m.accountId, 'running');
    const wi = await seedWorkItem(m.accountId);
    const read = await tokenFor(m, ['read']);
    for (const p of [`/runs/${run}/cancel`, `/work-items/${wi}/cancel`]) {
      const res = await call(read, 'POST', p);
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrBody).error.code).toBe('insufficient_scope');
    }
    const cancelOnly = await tokenFor(m, ['runs:cancel']);
    const get = await call(cancelOnly, 'GET', `/run-actions/${randomUUID()}`);
    expect(get.status).toBe(403);
    expect(((await get.json()) as ErrBody).error.code).toBe('insufficient_scope');
    await expectNothingWritten(m.accountId);
  });

  it('a runs:cancel token cancels (actor is the token); a read token reads the action', async () => {
    const m = await member();
    const run = await seedRun(m.accountId, 'running');
    const res = await call(await tokenFor(m, ['runs:cancel']), 'POST', `/runs/${run}/cancel`);
    expect(res.status).toBe(202);
    const a = (await res.json()) as Accepted;
    const { rows } = await admin.query('SELECT requested_by, principal_kind FROM run_action_requests WHERE id = $1', [a.action_id]);
    expect(rows[0].principal_kind).toBe('token');
    expect(rows[0].requested_by).toMatch(/^token:/);
    const get = await call(await tokenFor(m, ['read']), 'GET', `/run-actions/${a.action_id}`);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ action_id: a.action_id, kind: 'cancel_run', target_id: run, state: 'accepted', outcome: null, error_code: null, finished_at: null });
  });

  it('an expired runs:cancel token is 401 invalid_token and writes nothing', async () => {
    const m = await member();
    const run = await seedRun(m.accountId, 'running');
    const token = await tokenFor(m, ['runs:cancel']);
    await admin.query(`UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [hashToken(token)]);
    const res = await call(token, 'POST', `/runs/${run}/cancel`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrBody).error.code).toBe('invalid_token');
    await expectNothingWritten(m.accountId);
  });

  it('a malformed, an unknown and another account\'s id all get the same 404 body, and nothing is written', async () => {
    const a = await member();
    const b = await member();
    const foreign = await seedRun(b.accountId, 'running');
    const foreignWi = await seedWorkItem(b.accountId);
    const seen = new Set<string>();
    for (const p of ['/runs/not-a-uuid/cancel', `/runs/${randomUUID()}/cancel`, `/runs/${foreign}/cancel`, '/work-items/zzz/cancel', `/work-items/${foreignWi}/cancel`]) {
      const res = await call(a, 'POST', p);
      expect(res.status, p).toBe(404);
      const body = (await res.json()) as ErrBody;
      seen.add(JSON.stringify({ ...body, error: { ...body.error, request_id: '' } }));
    }
    expect(seen.size).toBe(1);
    await expectNothingWritten(a.accountId);
    await expectNothingWritten(b.accountId);
  });

  it('with no signal registered both POSTs are 503 run_actions_unavailable before any read or write; the GET still works', async () => {
    runActionDeps.getRunActionSignal = () => null;
    const m = await member();
    const run = await seedRun(m.accountId, 'running');
    const wi = await seedWorkItem(m.accountId);
    for (const p of [`/runs/${run}/cancel`, `/work-items/${wi}/cancel`]) {
      const res = await call(m, 'POST', p);
      expect(res.status).toBe(503);
      expect(((await res.json()) as ErrBody).error.code).toBe('run_actions_unavailable');
    }
    await expectNothingWritten(m.accountId);
    expect((await call(m, 'GET', `/run-actions/${randomUUID()}`)).status).toBe(404);
  });

  it('GET /run-actions/{id}: another account, an unknown and a malformed id are the same 404', async () => {
    const a = await member();
    const b = await member();
    const run = await seedRun(b.accountId, 'running');
    const made = (await (await call(b, 'POST', `/runs/${run}/cancel`)).json()) as Accepted;
    expect((await call(b, 'GET', `/run-actions/${made.action_id}`)).status).toBe(200);
    const bodies = new Set<string>();
    for (const id of [made.action_id, randomUUID(), 'nope']) {
      const res = await call(a, 'GET', `/run-actions/${id}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrBody;
      bodies.add(JSON.stringify({ ...body, error: { ...body.error, request_id: '' } }));
    }
    expect(bodies.size).toBe(1);
  });

  it('two tenants: B cannot cancel A\'s work item and A\'s row is untouched', async () => {
    const a = await member();
    const b = await member();
    const wi = await seedWorkItem(a.accountId);
    await seedRun(a.accountId, 'running', wi);
    expect((await call(b, 'POST', `/work-items/${wi}/cancel`)).status).toBe(404);
    await expectNothingWritten(a.accountId);
  });

  it('drift: CANCELLABLE_RUN_STATUSES equals the statuses with an edge to cancelled in statusTransitions.ts (read as text)', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'packages/runner/src/statusTransitions.ts'), 'utf8');
    const table = /RUN_STATUS_TRANSITIONS[^=]*=\s*deepFreezeTransitions<RunStatus>\(\{([\s\S]*?)\}\)/.exec(src)![1]!;
    const cancellable = [...table.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].filter((m) => m[2]!.includes('"cancelled"')).map((m) => m[1]!);
    expect(cancellable.length).toBeGreaterThan(0);
    expect([...cancellable].sort()).toEqual([...CANCELLABLE_RUN_STATUSES].sort());
  });
});
