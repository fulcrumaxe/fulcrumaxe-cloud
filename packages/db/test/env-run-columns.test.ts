import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { ENV_BUILD_STATUSES, EnvInputError, finishEnvBuild, startEnvBuild } from '../src/env.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** D#5 E9 (migration 0738): the run's environment columns, written by agent_run_create, and the build states. */
const hex = (c: string) => c.repeat(64);
const digest = (c: string) => `sha256:${hex(c)}`;

/** $1 run id, $2 account, $3 env version id, $4 image digest. */
const CREATE_SQL = `SELECT agent_run_create($1::uuid, $2::uuid, NULL, NULL, 'code-reviewer', 'production', NULL, NULL, NULL, NULL, NULL,
                                            jsonb_build_object('accountId', $2::uuid::text), repeat('a', 64), NULL, $3::text, $4::text)`;

describe('environment columns on a run, and build states (0738)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let platformOps: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await writerPool.end();
    await appPool.end();
    await platformOps.end();
  });

  const create = async (envVersionId: string | null, imageDigest: string | null): Promise<string> => {
    const id = randomUUID();
    await withTenant(writerPool, refs.accountId, (c) => c.query(CREATE_SQL, [id, refs.accountId, envVersionId, imageDigest]));
    return id;
  };

  const columns = async (id: string) =>
    (await admin.query(`SELECT env_version_id, image_digest FROM agent_runs WHERE id = $1`, [id])).rows[0];

  describe('agent_run_create writes both columns', () => {
    it('a run created with an environment has both set', async () => {
      const id = await create(hex('1'), digest('2'));
      expect(await columns(id)).toEqual({ env_version_id: hex('1'), image_digest: digest('2') });
    });

    it('a run created without one leaves both null (a repo with no environment)', async () => {
      const id = await create(null, null);
      expect(await columns(id)).toEqual({ env_version_id: null, image_digest: null });
    });

    it('refuses one without the other, and a value of the wrong shape', async () => {
      await expect(create(hex('1'), null)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(create(null, digest('2'))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(create('v1', digest('2'))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(create(hex('1'), 'latest')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('there is one create path: the 14-argument function is gone', async () => {
      const { rows } = await admin.query(
        `SELECT pronargs FROM pg_proc WHERE proname = 'agent_run_create' ORDER BY pronargs`,
      );
      expect(rows.map((r: { pronargs: number }) => r.pronargs)).toEqual([16]);
    });
  });

  describe('platform_ops', () => {
    const insertable = async (): Promise<string[]> =>
      (
        await admin.query(
          `SELECT column_name FROM information_schema.column_privileges
            WHERE table_name = 'agent_runs' AND grantee = 'platform_ops' AND privilege_type = 'INSERT'`,
        )
      ).rows.map((r: { column_name: string }) => r.column_name);

    it('may insert the two new columns, and not the other columns earlier migrations kept from it', async () => {
      const cols = await insertable();
      expect(cols).toEqual(expect.arrayContaining(['env_version_id', 'image_digest']));
      for (const never of ['job_signed', 'runner_id', 'envelope', 'cc_session_id', 'created_at']) {
        expect(cols, never).not.toContain(never);
      }
    });

    it('still cannot insert a run directly: the grant is for the definer body, not a session', async () => {
      await expect(
        withTenant(platformOps, refs.accountId, (c) =>
          c.query(
            `INSERT INTO agent_runs (account_id, role, runtime, status, env_version_id, image_digest)
             VALUES ($1, 'code-reviewer', 'production', 'pending', $2, $3)`,
            [refs.accountId, hex('1'), digest('2')],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('cannot call agent_run_create at all', async () => {
      await expect(
        withTenant(platformOps, refs.accountId, (c) => c.query(CREATE_SQL, [randomUUID(), refs.accountId, hex('1'), digest('2')])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('the run columns are write-once (trigger, every role)', () => {
    it('refuses any later change, including from the table owner, and allows rewriting the same value', async () => {
      const id = await create(hex('1'), digest('2'));
      for (const set of [`env_version_id = '${hex('9')}'`, `image_digest = '${digest('9')}'`, `env_version_id = NULL, image_digest = NULL`]) {
        await expect(admin.query(`UPDATE agent_runs SET ${set} WHERE id = $1`, [id]), set).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      }
      await expect(admin.query(`UPDATE agent_runs SET tokens_out = 1, env_version_id = env_version_id WHERE id = $1`, [id])).resolves.toBeDefined();
      expect(await columns(id)).toEqual({ env_version_id: hex('1'), image_digest: digest('2') });
    });

    it('a run created without an environment cannot be given one afterwards', async () => {
      const id = await create(null, null);
      await expect(
        admin.query(`UPDATE agent_runs SET env_version_id = $2, image_digest = $3 WHERE id = $1`, [id, hex('1'), digest('2')]),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('the build lifecycle is enforced by the database', () => {
    const raw = (status: string, finished: string) =>
      admin.query(`INSERT INTO env_builds (account_id, env_version_id, status, budget, finished_at) VALUES ($1, $2, $3, 'foreground_compute', ${finished})`, [
        refs.accountId, hex('5'), status,
      ]);

    it('running means no finish time, and every other state has one', async () => {
      await expect(raw('succeeded', 'NULL')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(raw('failed', 'NULL')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(raw('running', 'now()')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('app_user cannot reopen a finished build or rewrite its cost, outcome or log', async () => {
      await withTenant(appPool, refs.accountId, async (client) => {
        const build = await startEnvBuild(client, { envVersionId: hex('6'), status: 'running', budget: 'foreground_compute' });
        await finishEnvBuild(client, build.id, { status: 'succeeded', costUsd: 0.5 });
        for (const set of [
          `status = 'running', finished_at = NULL`, `cost_usd = 0`, `status = 'failed'`, `log_ref = 'x'`, `failing_step = 'x'`, `finished_at = now()`,
        ]) {
          await client.query('SAVEPOINT s');
          await expect(client.query(`UPDATE env_builds SET ${set} WHERE id = $1`, [build.id]), set).rejects.toMatchObject({
            code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
          });
          await client.query('ROLLBACK TO SAVEPOINT s');
        }
        const { rows } = await client.query(`SELECT status, cost_usd FROM env_builds WHERE id = $1`, [build.id]);
        expect(rows[0]).toMatchObject({ status: 'succeeded', cost_usd: '0.5000' });
      });
    });

    it('the owner cannot change a finished build either', async () => {
      await withTenant(appPool, refs.accountId, async (client) => {
        const build = await startEnvBuild(client, { envVersionId: hex('7'), status: 'running', budget: 'foreground_compute' });
        await finishEnvBuild(client, build.id, { status: 'failed', failingStep: 'build', costUsd: 1 });
      });
      await expect(admin.query(`UPDATE env_builds SET cost_usd = 0 WHERE env_version_id = $1`, [hex('7')])).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
    });
  });

  describe('env_builds.status', () => {
    const insert = (status: string) =>
      admin.query(`INSERT INTO env_builds (account_id, env_version_id, status, budget, finished_at)
                   VALUES ($1, $2, $3, 'foreground_compute', CASE WHEN $3 = 'running' THEN NULL ELSE now() END)`, [
        refs.accountId,
        hex('3'),
        status,
      ]);

    it.each([...ENV_BUILD_STATUSES])('accepts the state %s', async (status) => {
      await expect(insert(status)).resolves.toBeDefined();
    });

    it('refuses any other value in the database, and in the accessors before a query is sent', async () => {
      for (const bad of ['done', 'RUNNING', 'pending', 'queued']) {
        await expect(insert(bad), bad).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      await withTenant(appPool, refs.accountId, async (client) => {
        // @ts-expect-error only `running` opens a build
        await expect(startEnvBuild(client, { envVersionId: hex('3'), status: 'failed', budget: 'emergency' })).rejects.toMatchObject({ code: 'env_bad_status' });
        // @ts-expect-error `running` is not an outcome
        await expect(finishEnvBuild(client, randomUUID(), { status: 'running', costUsd: 0 })).rejects.toBeInstanceOf(EnvInputError);
      });
    });

    it('a second finish changes nothing and reports nothing to do', async () => {
      await withTenant(appPool, refs.accountId, async (client) => {
        const build = await startEnvBuild(client, { envVersionId: hex('4'), status: 'running', budget: 'foreground_compute' });
        const first = await finishEnvBuild(client, build.id, { status: 'failed', failingStep: 'RUN make', costUsd: 0.1 });
        expect(first).toMatchObject({ status: 'failed', failing_step: 'RUN make' });
        const again = await finishEnvBuild(client, build.id, { status: 'succeeded', costUsd: 9 });
        expect(again).toBeNull();
        const { rows } = await client.query(`SELECT status, failing_step, cost_usd, finished_at FROM env_builds WHERE id = $1`, [build.id]);
        expect(rows[0]).toMatchObject({ status: 'failed', failing_step: 'RUN make', cost_usd: '0.1000' });
        expect(rows[0].finished_at).toEqual(first!.finished_at);
      });
    });
  });
});
