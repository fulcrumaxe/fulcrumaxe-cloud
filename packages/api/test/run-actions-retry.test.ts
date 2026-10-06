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
import { maxFixRounds } from '@fx/spend';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { TERMINAL_RUN_STATUSES, runActionDeps } from '../src/routes/run-actions.js';
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
const LIVE = ['pending', 'running', 'paused'];
let keyCounter = 0;
const freshKey = () => `retry-key-${process.pid}-${++keyCounter}`;

/** D#31 API-6b-1: POST /runs/{id}/retry through the real dispatcher against real Postgres. */
describe('D#31 API-6b-1: retry route', () => {
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

  async function call(who: Identity | string, urlPath: string, headers: Record<string, string> = { 'idempotency-key': freshKey() }): Promise<Response> {
    const h = new Headers(headers);
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method: 'POST', headers: h }), appUserPool, platformOpsPool, ROUTES);
  }
  const member = () => seedAccountWithMember(admin, { role: 'member' });
  async function tokenFor(who: Identity, scopes: Scope[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: who.accountId,
      createdBy: who.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  }
  async function seedWorkItem(accountId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance) VALUES ($1, $2, 'feature', 'internal')`, [id, accountId]);
    return id;
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
  async function seedFixRounds(accountId: string, workItemId: string, rounds: number) {
    for (let i = 0; i < rounds; i++) {
      await admin.query(
        `INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, reviewer, at, source, source_ref)
         VALUES ($1, $2, 'pr_opened', 'changes_requested', 'code', now(), 'control_plane', $3)`,
        [accountId, workItemId, `round-${i}-${randomUUID()}`],
      );
    }
  }
  const count = async (sql: string, accountId: string) => Number((await admin.query<{ n: string }>(sql, [accountId])).rows[0]!.n);
  const rowCount = (a: string) => count('SELECT count(*) AS n FROM run_action_requests WHERE account_id = $1', a);
  const auditCount = (a: string) => count(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = 'run_action.requested'`, a);
  async function expectNothingWritten(a: string) {
    expect(await rowCount(a)).toBe(0);
    expect(await auditCount(a)).toBe(0);
    expect(signal.sent).toEqual([]);
  }
  const code = async (res: Response) => ((await res.json()) as ErrBody).error.code;

  it.each([...TERMINAL_RUN_STATUSES])('a member session retries a %s run: 202 accepted, one retry_run row, one audit row, one signal', async (status) => {
    const m = await member();
    const run = await seedRun(m.accountId, status);
    const res = await call(m, `/runs/${run}/retry`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as Accepted;
    expect(body.state).toBe('accepted');
    const { rows } = await admin.query('SELECT kind, target_id, principal_kind FROM run_action_requests WHERE id = $1', [body.action_id]);
    expect(rows[0]).toMatchObject({ kind: 'retry_run', target_id: run, principal_kind: 'session' });
    expect(await rowCount(m.accountId)).toBe(1);
    expect(await auditCount(m.accountId)).toBe(1);
    expect(signal.sent).toHaveLength(1);
  });

  it('any token is 403 session_required, whatever its scope, and nothing is written', async () => {
    const m = await member();
    const run = await seedRun(m.accountId, 'failed');
    for (const scopes of [['read'], ['runs:cancel'], ['read', 'runs:cancel']] as Scope[][]) {
      const res = await call(await tokenFor(m, scopes), `/runs/${run}/retry`);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('session_required');
    }
    await expectNothingWritten(m.accountId);
  });

  it('a missing Idempotency-Key is 400 idempotency_key_required and nothing is written', async () => {
    const m = await member();
    const run = await seedRun(m.accountId, 'failed');
    const res = await call(m, `/runs/${run}/retry`, {});
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('idempotency_key_required');
    await expectNothingWritten(m.accountId);
  });

  it.each(LIVE)('a %s run is 409 run_not_retryable and writes nothing', async (status) => {
    const m = await member();
    const run = await seedRun(m.accountId, status);
    const res = await call(m, `/runs/${run}/retry`);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('run_not_retryable');
    await expectNothingWritten(m.accountId);
  });

  /** A child of `parent` (its retry or continuation); `started` adds the run.status_changed -> running event a real start writes. */
  async function seedChild(accountId: string, parent: string, o: { status: string; started: boolean; role?: string }): Promise<string> {
    const { rows } = await admin.query<{ work_item_id: string }>('SELECT work_item_id FROM agent_runs WHERE id = $1', [parent]);
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, parent_run_id, role, runtime, status) VALUES ($1, $2, $3, $4, $5, 'local', $6)`,
      [id, accountId, rows[0]!.work_item_id, parent, o.role ?? 'build', o.status],
    );
    if (o.started) {
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', '{"from":"pending","to":"running"}'::jsonb)`, [accountId, id]);
    }
    return id;
  }

  it.each([
    ['a pending (not yet running) retry child', { status: 'pending', started: false }],
    ['a running child', { status: 'running', started: true }],
    ['a child that started and then failed', { status: 'failed', started: true }],
    ['a continuation that started and finished', { status: 'succeeded', started: true }],
  ])('C1/C4: a run with %s is 409 run_not_retryable and writes nothing', async (_name, child) => {
    const m = await member();
    const run = await seedRun(m.accountId, 'failed');
    await seedChild(m.accountId, run, child);
    const res = await call(m, `/runs/${run}/retry`);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('run_not_retryable');
    await expectNothingWritten(m.accountId);
  });

  it.each([
    ['refused_spend', 'refused_spend'],
    ['dispatch-failed', 'failed'],
    ['cleanup-cancelled', 'cancelled'],
  ])('C2: a same-role child that was %s and never started does not block a retry', async (_name, status) => {
    const m = await member();
    const run = await seedRun(m.accountId, 'failed');
    await seedChild(m.accountId, run, { status, started: false });
    expect((await call(m, `/runs/${run}/retry`)).status).toBe(202);
  });

  it('C3: live or started children of other roles (planning-panel seats) do not block a retry', async () => {
    const m = await member();
    const run = await seedRun(m.accountId, 'failed');
    await seedChild(m.accountId, run, { status: 'running', started: true, role: 'reviewer' });
    await seedChild(m.accountId, run, { status: 'failed', started: true, role: 'architect' });
    expect((await call(m, `/runs/${run}/retry`)).status).toBe(202);
  });

  it('a run whose work item has used all its fix rounds is 409 escalate and writes nothing; one round fewer is 202', async () => {
    const m = await member();
    const wi = await seedWorkItem(m.accountId);
    await seedFixRounds(m.accountId, wi, maxFixRounds() - 1);
    const run = await seedRun(m.accountId, 'failed', wi);
    expect((await call(m, `/runs/${run}/retry`)).status).toBe(202);

    const other = await seedWorkItem(m.accountId);
    await seedFixRounds(m.accountId, other, maxFixRounds());
    const blocked = await seedRun(m.accountId, 'failed', other);
    const before = await rowCount(m.accountId);
    signal.sent.length = 0;
    const res = await call(m, `/runs/${blocked}/retry`);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('escalate');
    expect(await rowCount(m.accountId)).toBe(before);
    expect(signal.sent).toEqual([]);
  });

  it('K7: a finished run with no work item is 409 run_not_retryable and writes nothing, and a keyed replay still beats it', async () => {
    const m = await member();
    const run = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, NULL, 'build', 'local', 'failed')`, [run, m.accountId]);
    const res = await call(m, `/runs/${run}/retry`);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('run_not_retryable');
    await expectNothingWritten(m.accountId);
    const withItem = await seedRun(m.accountId, 'failed');
    const key = freshKey();
    const first = await call(m, `/runs/${withItem}/retry`, { 'idempotency-key': key });
    expect(first.status).toBe(202);
    await admin.query('DELETE FROM work_items WHERE id = (SELECT work_item_id FROM agent_runs WHERE id = $1)', [withItem]);
    expect((await call(m, `/runs/${withItem}/retry`, { 'idempotency-key': key })).status).toBe(202);
  });

  it('a malformed, an unknown and another account\'s run id all get the same 404 body, and nothing is written', async () => {
    const a = await member();
    const b = await member();
    const foreign = await seedRun(b.accountId, 'failed');
    const seen = new Set<string>();
    for (const p of ['/runs/not-a-uuid/retry', `/runs/${randomUUID()}/retry`, `/runs/${foreign}/retry`]) {
      const res = await call(a, p);
      expect(res.status, p).toBe(404);
      const body = (await res.json()) as ErrBody;
      seen.add(JSON.stringify({ ...body, error: { ...body.error, request_id: '' } }));
    }
    expect(seen.size).toBe(1);
    await expectNothingWritten(a.accountId);
    await expectNothingWritten(b.accountId);
  });

  it('keyed replay: the same key, run and user gets the original action_id with Idempotent-Replayed and no new row, even after the run stops being retryable or the api-layer key expires', async () => {
    const m = await member();
    const wi = await seedWorkItem(m.accountId);
    const run = await seedRun(m.accountId, 'failed', wi);
    const headers = { 'idempotency-key': 'k-retry-replay' };
    const first = await call(m, `/runs/${run}/retry`, headers);
    expect(first.status).toBe(202);
    const a = (await first.json()) as Accepted;

    const live = await call(m, `/runs/${run}/retry`, headers);
    expect(live.status).toBe(202);
    expect(live.headers.get('idempotent-replayed')).toBe('true');
    expect(((await live.json()) as Accepted).action_id).toBe(a.action_id);

    // Now make every early check refuse, and drop the api-layer copy of the key.
    await admin.query(`UPDATE agent_runs SET status = 'running' WHERE id = $1`, [run]);
    await seedFixRounds(m.accountId, wi, maxFixRounds());
    await admin.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 minute' WHERE account_id = $1 AND key = 'k-retry-replay'`, [m.accountId]);
    const replay = await call(m, `/runs/${run}/retry`, headers);
    expect(replay.status).toBe(202);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(((await replay.json()) as Accepted).action_id).toBe(a.action_id);
    expect(await rowCount(m.accountId)).toBe(1);
    expect(await auditCount(m.accountId)).toBe(1);
    expect(signal.sent).toHaveLength(1);
    // A fresh key against the same run is the plain refusal.
    expect(await code(await call(m, `/runs/${run}/retry`))).toBe('run_not_retryable');
  });

  it('the same key from another member of the account, or for another run, is 422 idempotency_key_reused with no new row', async () => {
    const m = await member();
    const r1 = await seedRun(m.accountId, 'failed');
    const r2 = await seedRun(m.accountId, 'failed');
    const headers = { 'idempotency-key': 'k-retry-diff' };
    expect((await call(m, `/runs/${r1}/retry`, headers)).status).toBe(202);
    // A second member of the same account (seeded directly) reusing the key.
    const otherUser = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [otherUser, `${otherUser}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [m.accountId, otherUser]);
    const res = await call({ accountId: m.accountId, userId: otherUser }, `/runs/${r1}/retry`, headers);
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('idempotency_key_reused');
    expect(await rowCount(m.accountId)).toBe(1);

    for (const expireFirst of [false, true]) {
      if (expireFirst) await admin.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 minute' WHERE account_id = $1`, [m.accountId]);
      const res = await call(m, `/runs/${r2}/retry`, headers);
      expect(res.status).toBe(422);
      expect(await code(res)).toBe('idempotency_key_reused');
    }
    expect(await rowCount(m.accountId)).toBe(1);
  });

  it('with no signal registered the route is 503 run_actions_unavailable before any write', async () => {
    runActionDeps.getRunActionSignal = () => null;
    const m = await member();
    const run = await seedRun(m.accountId, 'failed');
    const res = await call(m, `/runs/${run}/retry`);
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('run_actions_unavailable');
    await expectNothingWritten(m.accountId);
  });

  describe('H07: the author re-gate (API-6b-3)', () => {
    let nextIssue = 500;
    /** An external work item with a real repo and issue number, plus a failed run on it. */
    async function externalRun(accountId: string): Promise<{ run: string; issue: number }> {
      const repo = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', 'widgets')`, [repo, accountId, nextIssue + 9000]);
      const wi = randomUUID();
      const issue = nextIssue++;
      await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance, repo_id, gh_number) VALUES ($1, $2, 'issue', 'external', $3, $4)`, [wi, accountId, repo, issue]);
      return { run: await seedRun(accountId, 'failed', wi), issue };
    }
    function registerCheck(result: 'read' | 'write' | 'throw', allowlist: string[] = []) {
      const calls: unknown[] = [];
      runActionDeps.getAuthorCheck = () => ({
        allowlist,
        lookup: async (req) => {
          calls.push(req);
          if (result === 'throw') throw new Error('github down');
          return { status: 'found', login: 'outside-author-9', permission: result };
        },
      });
      return calls;
    }
    afterEach(() => {
      runActionDeps.getAuthorCheck = () => null;
    });

    it('an external run whose author has only read is 403 untrusted_author, writes nothing, and the body names no author and offers no override', async () => {
      const m = await member();
      const { run } = await externalRun(m.accountId);
      registerCheck('read');
      const res = await call(m, `/runs/${run}/retry`);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect((JSON.parse(text) as ErrBody).error.code).toBe('untrusted_author');
      expect(text).not.toContain('outside-author-9');
      expect(text.toLowerCase()).not.toContain('override');
      expect(Object.keys(JSON.parse(text).error).sort()).toEqual(['code', 'message', 'request_id']);
      await expectNothingWritten(m.accountId);
      expect(await count('SELECT count(*) AS n FROM idempotency_keys WHERE account_id = $1', m.accountId)).toBe(0);
    });

    it('the same author holding write is 202 and the lookup got the issue coordinates', async () => {
      const m = await member();
      const { run, issue } = await externalRun(m.accountId);
      const calls = registerCheck('write');
      expect((await call(m, `/runs/${run}/retry`)).status).toBe(202);
      expect(calls).toEqual([expect.objectContaining({ owner: 'acme', name: 'widgets', number: issue })]);
      expect(await rowCount(m.accountId)).toBe(1);
    });

    it('an allowlisted author is 202 whatever their permission', async () => {
      const m = await member();
      const { run } = await externalRun(m.accountId);
      registerCheck('read', ['Outside-Author-9']);
      expect((await call(m, `/runs/${run}/retry`)).status).toBe(202);
    });

    it('a lookup that throws is 503 author_check_unavailable and writes nothing', async () => {
      const m = await member();
      const { run } = await externalRun(m.accountId);
      registerCheck('throw');
      const res = await call(m, `/runs/${run}/retry`);
      expect(res.status).toBe(503);
      expect(await code(res)).toBe('author_check_unavailable');
      await expectNothingWritten(m.accountId);
    });

    it('with no check registered an external chain is 503 and an internal chain is 202 with zero lookup calls', async () => {
      const m = await member();
      const { run } = await externalRun(m.accountId);
      const res = await call(m, `/runs/${run}/retry`);
      expect(res.status).toBe(503);
      expect(await code(res)).toBe('author_check_unavailable');
      await expectNothingWritten(m.accountId);

      const calls = registerCheck('write');
      const internal = await seedRun(m.accountId, 'failed');
      expect((await call(m, `/runs/${internal}/retry`)).status).toBe(202);
      expect(calls).toEqual([]);
      runActionDeps.getAuthorCheck = () => null;
      const again = await seedRun(m.accountId, 'failed');
      expect((await call(m, `/runs/${again}/retry`)).status).toBe(202);
    });

    it('a keyed replay of an action accepted earlier returns the same action_id even though the author is now untrusted', async () => {
      const m = await member();
      const { run } = await externalRun(m.accountId);
      registerCheck('write');
      const headers = { 'idempotency-key': 'k-h07-replay' };
      const first = await call(m, `/runs/${run}/retry`, headers);
      expect(first.status).toBe(202);
      const a = (await first.json()) as Accepted;
      const calls = registerCheck('read');
      // Drop the api-layer copy of the key so the replay is answered by this route's own keyed check.
      await admin.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 minute' WHERE account_id = $1 AND key = 'k-h07-replay'`, [m.accountId]);
      const replay = await call(m, `/runs/${run}/retry`, headers);
      expect(replay.status).toBe(202);
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect(((await replay.json()) as Accepted).action_id).toBe(a.action_id);
      expect(calls).toEqual([]);
      expect(await rowCount(m.accountId)).toBe(1);
      // A fresh key against the same run is the plain refusal.
      expect(await code(await call(m, `/runs/${run}/retry`))).toBe('untrusted_author');
    });

    it('the early refusals still come first: a live external run is 409 before any lookup', async () => {
      const m = await member();
      const { run } = await externalRun(m.accountId);
      await admin.query(`UPDATE agent_runs SET status = 'running' WHERE id = $1`, [run]);
      const calls = registerCheck('read');
      expect(await code(await call(m, `/runs/${run}/retry`))).toBe('run_not_retryable');
      expect(calls).toEqual([]);
    });
  });

  it('drift: TERMINAL_RUN_STATUSES equals the statuses with no outgoing edge in statusTransitions.ts (read as text)', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'packages/runner/src/statusTransitions.ts'), 'utf8');
    const table = /RUN_STATUS_TRANSITIONS[^=]*=\s*deepFreezeTransitions<RunStatus>\(\{([\s\S]*?)\}\)/.exec(src)![1]!;
    const terminal = [...table.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].filter((m) => m[2]!.trim() === '').map((m) => m[1]!);
    expect(terminal.length).toBeGreaterThan(0);
    expect([...terminal].sort()).toEqual([...TERMINAL_RUN_STATUSES].sort());
  });

  it('openapi.json documents the route as session-only, 202, with the 409 and 503 answers', () => {
    const doc = JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages/api/openapi.json'), 'utf8'));
    const op = doc.paths['/api/v1/runs/{id}/retry'].post;
    expect(op.operationId).toBe('retryRun');
    expect(op.security).toEqual([{ session: [] }]);
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['202', '403', '404', '409', '422', '503']));
    expect(op.description).toContain('GET /api/v1/run-actions/{id}');
    expect(op.responses['403'].description).toContain('untrusted_author');
    expect(op.responses['503'].description).toContain('author_check_unavailable');
  });
});
