import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { statsRoutes, statsResponseSchema, timelineResponseSchema } from '../src/routes/stats.js';
import { seedAccountWithMember } from './helpers/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FX_SESSION_SECRET = 's'.repeat(32);

/**
 * The 16 `@fx/stats` `KPI_METRICS` ids (D#45 S2's binding registry),
 * spelled out literally here rather than imported: `@fx/api` has no
 * dependency on `@fx/stats` (only `@fx/core`, which re-exposes their
 * effect through `getStats`, does) -- S3's own file list adds `@fx/stats`
 * to `packages/core/package.json` only.
 */
const KPI_METRIC_IDS = [
  'lead_time_minutes',
  'time_to_merge_minutes',
  'spec_to_first_pr_minutes',
  'queue_wait_minutes',
  'review_latency_minutes',
  'fix_rounds',
  'first_pass_review_rate',
  'escalation_rate',
  'merged_count',
  'open_age_minutes',
  'run_success_rate',
  'model_usd_per_merged_pr',
  'compute_usd_per_merged_pr',
  'tokens_per_merged_pr',
  'abandoned_usd',
  'first_pr_from_install',
].sort();

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** S3 criterion 6: no write path lives under packages/api/src/**. */
describe('stats: static invariants (D#45 S3 criterion 6)', () => {
  const SRC_DIR = path.join(__dirname, '..', 'src');

  it('no file under packages/api/src/** mentions recordStage or work_item_transitions', () => {
    for (const file of listTsFiles(SRC_DIR)) {
      const contents = readFileSync(file, 'utf8');
      expect(contents).not.toMatch(/recordStage/);
      expect(contents).not.toMatch(/work_item_transitions/);
    }
  });

  it('no non-GET registry entry has a path containing /stats or /timeline', () => {
    for (const entry of ROUTES) {
      if (entry.path.includes('/stats') || entry.path.includes('/timeline')) {
        expect(entry.method).toBe('GET');
      }
    }
  });

  it('every S3 route declares S+T(read), member, idempotency never', () => {
    for (const entry of statsRoutes) {
      expect(entry.principals).toEqual(['session', 'token']);
      expect(entry.scope).toBe('read');
      expect(entry.minRole).toBe('member');
      expect(entry.idempotency).toBe('never');
      expect(entry.startsRun).toBe(false);
    }
  });
});

/** S3 criterion 3: key set equals KPI_METRICS ids; criterion 9: no price/margin/plan/budget/revenue key at any depth. */
describe('stats: response schema shape (D#45 S3 criteria 3, 9)', () => {
  it("metrics schema's key set equals KPI_METRICS' ids exactly", () => {
    const metricsKeys = Object.keys(statsResponseSchema.shape.metrics.shape).sort();
    const kpiIds = KPI_METRIC_IDS;
    expect(metricsKeys).toEqual(kpiIds);
  });

  it('carries runner_api_equivalent_usd beside metrics, not inside it, and as a required number', () => {
    expect(Object.keys(statsResponseSchema.shape)).toContain('runner_api_equivalent_usd');
    expect(Object.keys(statsResponseSchema.shape.metrics.shape)).not.toContain('runner_api_equivalent_usd');
    expect(statsResponseSchema.shape.runner_api_equivalent_usd.safeParse(1.25).success).toBe(true);
    expect(statsResponseSchema.shape.runner_api_equivalent_usd.safeParse(undefined).success).toBe(false);
  });

  it('no schema key anywhere matches /budget|plan|price|margin|revenue/i', () => {
    const FORBIDDEN = /budget|plan|price|margin|revenue/i;
    function walk(node: unknown): void {
      if (node === null || typeof node !== 'object') return;
      if ('shape' in (node as Record<string, unknown>)) {
        const shape = (node as { shape: Record<string, unknown> }).shape;
        for (const [key, value] of Object.entries(shape)) {
          expect(key).not.toMatch(FORBIDDEN);
          walk(value);
        }
      }
    }
    walk(statsResponseSchema);
    walk(timelineResponseSchema);
  });
});

describe('stats: GET /api/v1/stats, GET /api/v1/work-items/{id}/timeline (D#45 S3)', () => {
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

  describe('window validation (criterion 2)', () => {
    it('a malformed `from` -> 422 invalid_request', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const res = await dispatch(
        await sessionRequest('http://localhost/api/v1/stats?from=not-a-timestamp', { accountId, userId }),
      );
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    });

    it('a malformed `repo_id` -> 422 invalid_request', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const res = await dispatch(
        await sessionRequest('http://localhost/api/v1/stats?repo_id=not-a-uuid', { accountId, userId }),
      );
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    });

    it('from >= to -> 422 invalid_window', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const res = await dispatch(
        await sessionRequest(
          'http://localhost/api/v1/stats?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z',
          { accountId, userId },
        ),
      );
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_window');
    });

    it('a span over 366 days -> 422 invalid_window', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const res = await dispatch(
        await sessionRequest(
          'http://localhost/api/v1/stats?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z',
          { accountId, userId },
        ),
      );
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_window');
    });

    it('no `from` defaults to `to` minus 30 days', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const res = await dispatch(
        await sessionRequest('http://localhost/api/v1/stats?to=2026-06-15T00:00:00Z', { accountId, userId }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { window: { from: string; to: string } };
      expect(body.window.to).toBe('2026-06-15T00:00:00.000Z');
      expect(body.window.from).toBe('2026-05-16T00:00:00.000Z');
    });
  });

  describe('response shape (criterion 3)', () => {
    it('the response has window, generated_at and every KPI_METRICS id under metrics', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const res = await dispatch(await sessionRequest('http://localhost/api/v1/stats', { accountId, userId }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { window: unknown; generated_at: string; metrics: Record<string, unknown>; runner_api_equivalent_usd: number };
      expect(Object.keys(body).sort()).toEqual(['generated_at', 'metrics', 'runner_api_equivalent_usd', 'window']);
      expect(typeof body.runner_api_equivalent_usd).toBe('number');
      expect(Object.keys(body.metrics).sort()).toEqual(KPI_METRIC_IDS);
    });
  });

  describe('tenancy (criterion 4)', () => {
    it("A's merged_count is unaffected by B's repo_id or a random uuid, and both give identical bodies apart from generated_at/request_id", async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const bRepoId = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, 1, 'team')`, [
        bRepoId,
        b.accountId,
      ]);

      const withBRepo = await dispatch(
        await sessionRequest(`http://localhost/api/v1/stats?repo_id=${bRepoId}`, a),
      );
      const withRandom = await dispatch(
        await sessionRequest(`http://localhost/api/v1/stats?repo_id=${randomUUID()}`, a),
      );
      expect(withBRepo.status).toBe(200);
      expect(withRandom.status).toBe(200);
      const bodyB = (await withBRepo.json()) as { metrics: Record<string, unknown> };
      const bodyRandom = (await withRandom.json()) as { metrics: Record<string, unknown> };
      expect(bodyB.metrics).toEqual(bodyRandom.metrics);
      expect((bodyB.metrics.merged_count as { value: number }).value).toBe(0);
    });
  });

  describe('no "Claude Code" (criterion 11)', () => {
    it('the stats response never contains "Claude Code"', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const res = await dispatch(await sessionRequest('http://localhost/api/v1/stats', { accountId, userId }));
      const text = await res.text();
      expect(text).not.toContain('Claude Code');
    });
  });

  describe('timeline (criterion 5)', () => {
    it("a malformed id, a random uuid, and B's own work item id all 404 identically", async () => {
      const a = await seedAccountWithMember(admin);
      const b = await seedAccountWithMember(admin);
      const bWorkItemId = randomUUID();
      await admin.query(
        `INSERT INTO work_items (id, account_id, kind, provenance) VALUES ($1, $2, 'feature', 'internal')`,
        [bWorkItemId, b.accountId],
      );

      const cases = [
        `http://localhost/api/v1/work-items/${bWorkItemId}/timeline`,
        `http://localhost/api/v1/work-items/${randomUUID()}/timeline`,
        'http://localhost/api/v1/work-items/not-a-uuid/timeline',
      ];
      const bodies: { code: string; message: string }[] = [];
      for (const url of cases) {
        const res = await dispatch(await sessionRequest(url, a));
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('not_found');
        bodies.push({ code: body.error.code, message: body.error.message });
      }
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[1]).toEqual(bodies[2]);
    });

    it('returns the seeded stage and an empty, non-truncated transitions list for a fresh item', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const workItemId = randomUUID();
      await admin.query(
        `INSERT INTO work_items (id, account_id, kind, provenance) VALUES ($1, $2, 'feature', 'internal')`,
        [workItemId, accountId],
      );
      const res = await dispatch(
        await sessionRequest(`http://localhost/api/v1/work-items/${workItemId}/timeline`, { accountId, userId }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { work_item_id: string; stage: string; transitions: unknown[]; truncated: boolean };
      expect(body.work_item_id).toBe(workItemId);
      expect(body.stage).toBe('triaged');
      expect(body.transitions).toEqual([]);
      expect(body.truncated).toBe(false);
    });
  });
});
