import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { ENGINE_EVENTS_PATH, ingestEngineEvents, toResponse } from '@fx/runner-cloud';
import { newKey, registerKey, signed } from '../../runner-cloud/test/helpers.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';

/** The stated budget (L4): 10,000 events for one session ingested in 100 batches in under 60 s, then the log route's p95 over 50 page reads is at most 300 ms. */
const INGEST_BUDGET_MS = 60_000;
const P95_BUDGET_MS = 300;
const GH = 7070;

describe('engine log load [pg]', { timeout: 180_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let A: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    A = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });

  it(`ingests 10,000 events in 100 batches under ${INGEST_BUDGET_MS / 1000} s, then pages the whole log at p95 <= ${P95_BUDGET_MS} ms with at most 200 rows a page`, async () => {
    const key = newKey();
    const runnerId = await registerKey(admin, A.accountId, A.userId, key);
    await admin.query(`UPDATE repos SET execution_mode = 'runner_local', gh_repo_id = $2 WHERE id = $1`, [A.repoId, GH]);
    await admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[] WHERE id = $1`, [runnerId, A.repoId]);
    await admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)`, [A.accountId]);
    await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [A.accountId, A.repoId]);
    const deps = { appUserPool, origin: 'https://runner.example.test', failRunnerLeases: null };
    const instance = randomUUID();
    const t0 = Date.parse('2026-11-16T00:00:00.000Z');

    const started = Date.now();
    for (let b = 0; b < 100; b++) {
      const events = Array.from({ length: 100 }, (_, i) => {
        const n = b * 100 + i;
        return { v: 1, seq: n, ts: new Date(t0 + n * 1000).toISOString(), kind: 'team_log_line', engine_instance_id: instance, line_id: n.toString(16).padStart(16, '0'), actor_role: 'team-lead', category: 'heartbeat' };
      });
      // The daily quota (5,000 events a session) is EB-4's own rule, tested there; this test is about reading, so the day's count is cleared between batches.
      await admin.query(`UPDATE engine_sessions SET quota_count = 0 WHERE account_id = $1`, [A.accountId]);
      const req = signed(key, ENGINE_EVENTS_PATH, { session: { engine_instance_id: instance, repo_gh_id: GH, engine_version: '1.0.0' }, events });
      const res = (await toResponse(() => ingestEngineEvents(deps, req))) as { status: number };
      expect(res.status, `batch ${b}`).toBe(200);
    }
    const ingestMs = Date.now() - started;
    expect(ingestMs).toBeLessThan(INGEST_BUDGET_MS);
    expect(Number((await admin.query(`SELECT count(*) AS n FROM engine_events WHERE account_id = $1`, [A.accountId])).rows[0].n)).toBe(10_000);

    const cookie = `${SESSION_COOKIE_NAME}=${await signSession({ accountId: A.accountId, userId: A.userId })}`;
    const read = async (cursor: string | null) => {
      const url = `http://localhost/api/v1/engine/repos/${A.repoId}/log?limit=200${cursor ? `&cursor=${cursor}` : ''}`;
      const t = performance.now();
      const res = await handleApiRequest(new Request(url, { headers: { cookie, accept: 'application/json' } }), appUserPool, platformOpsPool, ROUTES);
      const ms = performance.now() - t;
      expect(res.status).toBe(200);
      return { ms, body: (await res.json()) as { items: { line_id: string }[]; next_cursor: string | null } };
    };
    const times: number[] = [];
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const { ms, body } = await read(cursor);
      times.push(ms);
      expect(body.items.length).toBeLessThanOrEqual(200);
      ids.push(...body.items.map((x) => x.line_id));
      cursor = body.next_cursor;
      if (cursor === null) break;
    }
    expect(ids).toHaveLength(10_000);
    expect(new Set(ids).size).toBe(10_000);
    expect(ids[0]).toBe((9999).toString(16).padStart(16, '0'));
    expect(times).toHaveLength(50);
    const p95 = [...times].sort((a, b) => a - b)[Math.ceil(0.95 * times.length) - 1]!;
    console.log(`engine-log-load: ingest ${ingestMs} ms (budget ${INGEST_BUDGET_MS}), log page p95 ${p95.toFixed(1)} ms (budget ${P95_BUDGET_MS})`);
    expect(p95).toBeLessThanOrEqual(P95_BUDGET_MS);
  });
});
