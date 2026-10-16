import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { createPublishTargetResolver } from '../src/publishTargetResolver.js';
import { ensureGhProxyTestLogin } from './helpers/ghProxyLogin.js';
import { captureReports } from './helpers/captureReports.js';
import { seedAccountWithRepo, seedWorkItem, type SeedRefs } from './helpers/seed.js';

/**
 * D#598 P1f-4a, A3/A6 through the real adapter: the production resolver on the narrow gh-proxy login, against the real function
 * and real rows. The function's own cases (every way the answer goes away) are in packages/db/test/plane-publish-target.pg.test.ts.
 */
describe('createPublishTargetResolver on the narrow login (D#598 P1f-4a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let proxyPool: Pool;
  let ghProxyUrl: string;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    ghProxyUrl = await ensureGhProxyTestLogin(process.env.GITHUB_DATABASE_URL!);
    proxyPool = createPool(ghProxyUrl);
    admin = await adminPool.connect();
    refs = await seedAccountWithRepo(admin, 5353);
  });
  afterAll(async () => {
    admin.release();
    await proxyPool.end();
    await adminPool.end();
  });

  async function publishRun(status = 'running'): Promise<{ name: string; push: string; branch: string; attempt: string; codeRepo: string }> {
    const workItem = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: Math.floor(Math.random() * 1_000_000) + 1 });
    const codeRepo = `acme-${randomUUID().slice(0, 8)}/widgets-public`;
    const push = await admin.query<{ id: string; branch: string }>(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest) VALUES ($1, $2, $3, $4, $5) RETURNING id, branch`,
      [refs.accountId, workItem, refs.repoId, codeRepo, 'b'.repeat(64)],
    );
    const name = `pp-${randomUUID()}`;
    const run = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id) VALUES ($1, $2, $3, 'plane_publish', 'production', $4, $5, $6)`,
      [run, refs.accountId, workItem, status, name, refs.repoId],
    );
    const attempt = await admin.query<{ id: string }>(
      `INSERT INTO plane_push_attempts (account_id, plane_push_id, run_id, runtime, kind, attempt_no) VALUES ($1, $2, $3, 'sandbox', 'push', 1) RETURNING id`,
      [refs.accountId, push.rows[0]!.id, run],
    );
    return { name, push: push.rows[0]!.id, branch: push.rows[0]!.branch, attempt: attempt.rows[0]!.id, codeRepo };
  }

  it('resolves a live publish run to its recorded repository and branch', async () => {
    const r = await publishRun();
    expect(await createPublishTargetResolver(proxyPool)(r.name)).toEqual({ codeRepo: r.codeRepo, branch: r.branch });
  });

  it('stops resolving the moment the attempt is finished', async () => {
    const r = await publishRun();
    const resolve = createPublishTargetResolver(proxyPool);
    expect(await resolve(r.name)).not.toBeNull();
    await admin.query('UPDATE plane_push_attempts SET finished_at = now() WHERE id = $1', [r.attempt]);
    expect(await resolve(r.name)).toBeNull();
  });

  it('answers null for an unknown name and for an ended run', async () => {
    const resolve = createPublishTargetResolver(proxyPool);
    expect(await resolve(`pp-${randomUUID()}`)).toBeNull();
    expect(await resolve((await publishRun('failed')).name)).toBeNull();
  });

  it('answers null on a database error (a closed pool) and reports it by class only', async () => {
    const dead = createPool(ghProxyUrl);
    await dead.end();
    const reports = captureReports();
    expect(await createPublishTargetResolver(dead)(`pp-${randomUUID()}`)).toBeNull();
    expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'github.plane_publish_target_resolve', code: 'other' }]);
  });
});
