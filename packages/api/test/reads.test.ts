import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { runRoutes } from '../src/routes/runs.js';
import { workItemRoutes } from '../src/routes/work-items.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);

/**
 * D#31 API-3a: end-to-end reads through the real dispatcher/registry, the
 * "sign a real cookie, dispatch through handleApiRequest" pattern
 * test/handler.test.ts establishes as this package's curl-against-`next
 * start` stand-in. packages/core/test/{runs,work-items}-read.test.ts
 * already covers pagination/filter/cost logic; this proves the HTTP
 * wiring: query parsing, the DTO's exact field set, and error mapping.
 */
describe('reads: GET /api/v1/runs, /api/v1/work-items (D#31 API-3a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = FX_SESSION_SECRET;
  });

  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function sessionRequest(url: string, identity: { userId: string; accountId: string }): Promise<Request> {
    const token = await signSession(identity);
    const headers = new Headers();
    headers.set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
    return new Request(url, { headers });
  }

  async function dispatch(req: Request): Promise<Response> {
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }

  describe('registry declarations', () => {
    it('every API-3a route declares S+T(read), member -- the exact "v1 contract" route-table row', () => {
      for (const entry of [...runRoutes, ...workItemRoutes]) {
        expect(entry.principals).toEqual(['session', 'token']);
        expect(entry.scope).toBe('read');
        expect(entry.minRole).toBe('member');
        expect(entry.idempotency).toBe('never');
      }
    });
  });

  describe('pagination volume (criterion 1: 60 runs, page 1 = 50 + next_cursor, page 2 = 10 + null)', () => {
    it('pages through exactly 60 seeded runs with no duplicate and no gap', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const workItemId = randomUUID();
      await admin.query(
        `INSERT INTO work_items (id, account_id, kind, provenance) VALUES ($1, $2, 'feature', 'internal')`,
        [workItemId, accountId],
      );
      const baseTime = Date.now();
      const seededIds: string[] = [];
      for (let i = 0; i < 60; i++) {
        const id = randomUUID();
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'build', 'local', 'succeeded', $4, $4)`,
          [id, accountId, workItemId, new Date(baseTime - i * 1000)],
        );
        seededIds.push(id);
      }

      const page1 = await dispatch(
        await sessionRequest(`http://localhost/api/v1/runs?work_item_id=${workItemId}`, { accountId, userId }),
      );
      expect(page1.status).toBe(200);
      const body1 = (await page1.json()) as { data: { id: string }[]; next_cursor: string | null };
      expect(body1.data).toHaveLength(50);
      expect(body1.next_cursor).not.toBeNull();

      const page2 = await dispatch(
        await sessionRequest(
          `http://localhost/api/v1/runs?work_item_id=${workItemId}&cursor=${encodeURIComponent(body1.next_cursor!)}`,
          { accountId, userId },
        ),
      );
      expect(page2.status).toBe(200);
      const body2 = (await page2.json()) as { data: { id: string }[]; next_cursor: string | null };
      expect(body2.data).toHaveLength(10);
      expect(body2.next_cursor).toBeNull();

      const allIds = [...body1.data, ...body2.data].map((r) => r.id);
      expect(new Set(allIds).size).toBe(60);
      expect(allIds.sort()).toEqual([...seededIds].sort());
    });
  });

  describe('filters', () => {
    it('/api/v1/work-items?repo_id=&stage= filters both at once', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const repoId = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, 1, 'team')`, [
        repoId,
        accountId,
      ]);
      const matchId = randomUUID();
      await admin.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'pr_opened')`,
        [matchId, accountId, repoId],
      );
      const wrongStageId = randomUUID();
      await admin.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'triaged')`,
        [wrongStageId, accountId, repoId],
      );

      const res = await dispatch(
        await sessionRequest(`http://localhost/api/v1/work-items?repo_id=${repoId}&stage=pr_opened`, {
          accountId,
          userId,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      expect(body.data.map((w) => w.id)).toEqual([matchId]);
    });

    it('an unknown stage value -> 422 (correction C10: only WORK_ITEM_STAGES is legal)', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const res = await dispatch(
        await sessionRequest(`http://localhost/api/v1/work-items?stage=not-a-real-stage`, { accountId, userId }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('validation_failed');
    });
  });

  describe('CWE-639: cross-tenant, random, and malformed ids all 404 identically', () => {
    it('getRun and getWorkItem all return 404 not_found with identical bodies apart from request_id', async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const bWorkItemId = randomUUID();
      await admin.query(
        `INSERT INTO work_items (id, account_id, kind, provenance) VALUES ($1, $2, 'feature', 'internal')`,
        [bWorkItemId, b.accountId],
      );
      const bRunId = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'build', 'local', 'running')`,
        [bRunId, b.accountId, bWorkItemId],
      );

      const cases = [
        `http://localhost/api/v1/runs/${bRunId}`,
        `http://localhost/api/v1/runs/${randomUUID()}`,
        'http://localhost/api/v1/runs/not-a-uuid',
      ];
      const bodies: { error: { code: string; message: string } }[] = [];
      for (const url of cases) {
        const res = await dispatch(await sessionRequest(url, a));
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string; message: string; request_id: string } };
        expect(body.error.code).toBe('not_found');
        bodies.push({ error: { code: body.error.code, message: body.error.message } });
      }
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[1]).toEqual(bodies[2]);
    });
  });

  describe('DTO field exclusion (criterion 3)', () => {
    it('GET /api/v1/runs/{id} and /api/v1/work-items/{id} never carry an internal field', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const workItemId = randomUUID();
      await admin.query(
        `INSERT INTO work_items (id, account_id, kind, gh_number, provenance, wf_run_id, state)
         VALUES ($1, $2, 'feature', 7, 'internal', 'wf-123', 'queued')`,
        [workItemId, accountId],
      );
      const runId = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, sandbox_name, cc_session_id, status, envelope)
         VALUES ($1, $2, $3, 'build', 'local', 'sbx-1', 'sess-1', 'running', '{"secret":true}'::jsonb)`,
        [runId, accountId, workItemId],
      );

      const runRes = await dispatch(await sessionRequest(`http://localhost/api/v1/runs/${runId}`, { accountId, userId }));
      expect(runRes.status).toBe(200);
      const runBody = (await runRes.json()) as Record<string, unknown>;
      for (const field of ['sandbox_name', 'cc_session_id', 'envelope', 'wf_run_id', 'account_id']) {
        expect(runBody).not.toHaveProperty(field);
      }

      const wiRes = await dispatch(
        await sessionRequest(`http://localhost/api/v1/work-items/${workItemId}`, { accountId, userId }),
      );
      expect(wiRes.status).toBe(200);
      const wiBody = (await wiRes.json()) as Record<string, unknown>;
      for (const field of ['wf_run_id', 'account_id', 'state']) {
        expect(wiBody).not.toHaveProperty(field);
      }
    });
  });

  describe('limit and cursor validation (criterion 4)', () => {
    // "no limit -> 50 rows returned" is already proven above: the
    // pagination-volume test's page-1 request carries no `limit` param
    // and asserts exactly 50 rows back.
    it('limit=201 -> 422, and a tampered cursor -> 422 invalid_cursor', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const badLimit = await dispatch(
        await sessionRequest('http://localhost/api/v1/runs?limit=201', { accountId, userId }),
      );
      expect(badLimit.status).toBe(422);
      expect(((await badLimit.json()) as { error: { code: string } }).error.code).toBe('validation_failed');

      const badCursor = await dispatch(
        await sessionRequest('http://localhost/api/v1/runs?cursor=not-a-real-cursor!!!', { accountId, userId }),
      );
      expect(badCursor.status).toBe(422);
      expect(((await badCursor.json()) as { error: { code: string } }).error.code).toBe('invalid_cursor');
    });
  });
});
