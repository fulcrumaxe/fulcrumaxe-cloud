import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { ACTIVITY_ROW_KIND, activityRowProblem } from '@fulcrumaxe/runner-protocol';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleEventsRequest, type StreamDeps, type StreamTarget } from '../src/sse/stream.js';
import { AccountPoller } from '../src/sse/poller.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { eventually, openSse, startServer, type SseConnection, type TestServer } from './helpers/sse.js';

/**
 * [pg] D#597 CC-6a-2, acceptance 1: the per-run event stream delivers an `agent.activity` row written for a RUNNER run, with no API change.
 * The row is inserted here in the exact shape the runner's event batch writes (`projectRunnerProgress`, D#6 C42-1: kind
 * `agent.activity`, payload `{tool, path|command}`); packages/runner/test/runnerActivityRow.pg.test.ts runs the real writer and asserts that same
 * shape, because this package must not import a runner writer (run-actions-boundary). The row is on a run whose runtime is `runner`; it is read back over a real SSE connection and through the JSON form of the same route. The workspace's
 * assistant panel (apps/workspace) counts these rows from that one stream; nothing in `packages/api/src` changed for it.
 */
describe('the run stream delivers a runner run\'s agent.activity row (real HTTP, real Postgres)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let poller: AccountPoller;
  let server: TestServer;
  let deps: StreamDeps;
  const open: SseConnection[] = [];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    process.env.FX_CURSOR_KEY_V1 = randomBytes(32).toString('base64');
    poller = new AccountPoller({ pool: appUserPool, platformOpsPool, activeIntervalMs: 40, idleIntervalMs: 40 });
    deps = { pool: appUserPool, platformOpsPool, poller, runPollIntervalMs: 40 };
    server = await startServer((req) => {
      const m = /^\/api\/v1\/runs\/([^/]+)\/events$/.exec(new URL(req.url).pathname);
      const target: StreamTarget = m ? { kind: 'run', runId: decodeURIComponent(m[1]!) } : { kind: 'account' };
      return handleEventsRequest(req, target, deps);
    });
  });
  afterEach(() => {
    for (const c of open.splice(0)) c.abort();
  });
  afterAll(async () => {
    await server.close();
    delete process.env.FX_SESSION_SECRET;
    delete process.env.FX_CURSOR_KEY_V1;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  const cookie = async (identity: { userId: string; accountId: string }) => `${SESSION_COOKIE_NAME}=${await signSession(identity, process.env, { epoch: 0 })}`;
  /** A row in the shape the runner writes (see the runner-side test for the writer's own output). */
  async function writeLikeTheRunner(accountId: string, runId: string, seq: number, payload: Record<string, string>): Promise<void> {
    expect(activityRowProblem({ kind: ACTIVITY_ROW_KIND, payload })).toBeNull(); // the shape the runner-side writer test also checks
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`, [accountId, runId, seq, ACTIVITY_ROW_KIND, JSON.stringify(payload)]);
  }

  it('a runner run\'s activity row, written after the stream opened, arrives as a run_event with the row\'s own payload; the JSON form lists the same row', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'build', 'runner', 'running')`, [runId, accountId]);
    const ck = await cookie({ accountId, userId });

    const stream = await openSse(`${server.url}/api/v1/runs/${runId}/events`, { cookie: ck });
    open.push(stream);
    expect(stream.status).toBe(200);
    expect(stream.events()).toEqual([]); // a runner run with no activity yet: nothing to replay (the panel's "no run data" state)

    await writeLikeTheRunner(accountId, runId, 1, { tool: 'read', path: 'src/theme.ts' });
    const frame = await stream.waitFor((f) => f.event === 'run_event');
    const body = JSON.parse(frame.data!) as { seq: number; kind: string; payload: Record<string, unknown> };
    expect(frame.id).toBe(String(body.seq));
    expect(body.kind).toBe('agent.activity');
    expect(body.payload).toEqual({ tool: 'read', path: 'src/theme.ts' });
    expect(Object.keys(body).sort()).toEqual(['at', 'kind', 'payload', 'seq']);

    // A second row follows on the same connection, in order.
    await writeLikeTheRunner(accountId, runId, 2, { tool: 'test', command: 'pnpm test' });
    await eventually(() => stream.events().length >= 2);
    expect(stream.events().map((f) => JSON.parse(f.data!).payload.tool)).toEqual(['read', 'test']);
    expect(stream.events().map((f) => f.event)).toEqual(['run_event', 'run_event']);

    // The JSON form of the same route returns the same rows (what the panel is seeded from when it opens).
    const res = await handleEventsRequest(new Request(`http://x/api/v1/runs/${runId}/events`, { headers: { cookie: ck, accept: 'application/json' } }), { kind: 'run', runId }, deps);
    const json = (await res.json()) as { data: { kind: string; payload: { tool: string } }[] };
    expect(json.data.filter((e) => e.kind === 'agent.activity').map((e) => e.payload.tool)).toEqual(['read', 'test']);
  });
});
