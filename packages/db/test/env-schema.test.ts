import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migrate.js';
import {
  EnvInputError,
  finishEnvBuild,
  getEnvVersion,
  insertEnvVersion,
  startEnvBuild,
  type NewEnvVersion,
} from '../src/env.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** D#5 E5a (migrations/0674): env_versions, env_builds and the two nullable agent_runs columns. */
const hex = (c: string) => c.repeat(64);
const digest = (c: string) => `sha256:${hex(c)}`;

function version(repoId: string, over: Partial<NewEnvVersion> = {}): NewEnvVersion {
  return {
    repoId,
    envVersionId: hex('a'),
    canonicalSpec: '{"lang":"go"}',
    baseImageDigest: digest('b'),
    builtImageDigest: digest('c'),
    source: 'repo',
    ...over,
  };
}

describe('environment tables (D#5 E5a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    for (const r of [A, B]) {
      await admin.query(
        `INSERT INTO env_versions (account_id, repo_id, env_version_id, canonical_spec, base_image_digest, built_image_digest, source)
         VALUES ($1, $2, $3, 'spec', $4, $5, 'repo')`,
        [r.accountId, r.repoId, hex('d'), digest('b'), digest('c')],
      );
      await admin.query(
        `INSERT INTO env_builds (account_id, env_version_id, status, budget) VALUES ($1, $2, 'succeeded', 'foreground_compute')`,
        [r.accountId, hex('d')],
      );
    }
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  describe('row-level security', () => {
    it('is enabled and forced on both tables (findRlsViolations flags neither)', async () => {
      const violations = await findRlsViolations(admin);
      expect(violations).not.toContain('env_versions');
      expect(violations).not.toContain('env_builds');
    });

    it('a cross-tenant select returns nothing, by table scan and by the accessor', async () => {
      await withTenant(appPool, A.accountId, async (client) => {
        for (const table of ['env_versions', 'env_builds']) {
          const { rows } = await client.query<{ account_id: string }>(`SELECT account_id FROM ${table}`);
          expect(rows.map((r) => r.account_id)).toEqual([A.accountId]);
          const other = await client.query(`SELECT 1 FROM ${table} WHERE account_id = $1`, [B.accountId]);
          expect(other.rows).toEqual([]);
        }
        expect(await getEnvVersion(client, B.repoId, hex('d'))).toBeNull();
        expect((await getEnvVersion(client, A.repoId, hex('d')))?.account_id).toBe(A.accountId);
      });
    });

    it('rejects an insert into another tenant\'s account, and one that names another tenant\'s repo', async () => {
      await withTenant(appPool, A.accountId, async (client) => {
        await client.query('SAVEPOINT s1');
        await expect(
          client.query(
            `INSERT INTO env_builds (account_id, env_version_id, status, budget) VALUES ($1, $2, 'running', 'emergency')`,
            [B.accountId, hex('e')],
          ),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await client.query('ROLLBACK TO SAVEPOINT s1');
        await expect(insertEnvVersion(client, version(B.repoId, { envVersionId: hex('e') }))).rejects.toMatchObject({
          code: PG_ERROR.FOREIGN_KEY_VIOLATION,
        });
      });
    });
  });

  describe('env_builds.budget', () => {
    const insert = (budget: string | null) =>
      admin.query(`INSERT INTO env_builds (account_id, env_version_id, status, budget) VALUES ($1, $2, 'running', $3)`, [
        A.accountId,
        hex('e'),
        budget,
      ]);

    it('is NOT NULL and CHECKed to the three ledger names', async () => {
      await expect(insert(null)).rejects.toMatchObject({ code: '23502' });
      await expect(insert('foreground')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      for (const ok of ['foreground_compute', 'background_compute', 'emergency']) {
        await expect(insert(ok)).resolves.toBeDefined();
      }
    });

    it('cannot be changed by app_user once written, and the accessor requires one', async () => {
      await withTenant(appPool, A.accountId, async (client) => {
        const build = await startEnvBuild(client, { envVersionId: hex('f'), status: 'running', budget: 'background_compute' });
        expect(build.budget).toBe('background_compute');
        await client.query('SAVEPOINT s1');
        await expect(client.query(`UPDATE env_builds SET budget = 'emergency' WHERE id = $1`, [build.id])).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
        await client.query('ROLLBACK TO SAVEPOINT s1');
        // @ts-expect-error a build without a budget is a type error and a runtime one
        await expect(startEnvBuild(client, { envVersionId: hex('f'), status: 'running' })).rejects.toMatchObject({
          code: 'env_bad_budget',
        });
        const done = await finishEnvBuild(client, build.id, { status: 'failed', failingStep: 'RUN make', logRef: 'logs/1', costUsd: 0.25 });
        expect(done).toMatchObject({ status: 'failed', failing_step: 'RUN make', budget: 'background_compute' });
        expect(done!.finished_at).not.toBeNull();
      });
    });
  });

  describe('env_versions digests', () => {
    it('accepts a sha256 digest and refuses a tag, a short hash and a NULL, in the table and in the accessor', async () => {
      await withTenant(appPool, A.accountId, async (client) => {
        const row = await insertEnvVersion(client, version(A.repoId, { envVersionId: hex('1'), source: 'preset' }));
        expect(row).toMatchObject({ source: 'preset', built_image_digest: digest('c') });
        for (const bad of ['node:26', 'sha256:abc', `sha256:${hex('C')}`, '']) {
          await expect(insertEnvVersion(client, version(A.repoId, { builtImageDigest: bad }))).rejects.toBeInstanceOf(EnvInputError);
        }
      });
      const raw = (base: string | null, built: string | null, source = 'repo') =>
        admin.query(
          `INSERT INTO env_versions (account_id, repo_id, env_version_id, canonical_spec, base_image_digest, built_image_digest, source)
           VALUES ($1, $2, $3, 'spec', $4, $5, $6)`,
          [A.accountId, A.repoId, hex('2'), base, built, source],
        );
      await expect(raw('node:26', digest('c'))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(raw(digest('b'), 'latest')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(raw(null, digest('c'))).rejects.toMatchObject({ code: '23502' });
    });

    it('is insert-only for app_user: a digest cannot be rewritten or deleted, and a repeat is a conflict', async () => {
      await withTenant(appPool, A.accountId, async (client) => {
        for (const sql of [`UPDATE env_versions SET built_image_digest = '${digest('9')}'`, 'DELETE FROM env_versions']) {
          await client.query('SAVEPOINT s1');
          await expect(client.query(sql)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
          await client.query('ROLLBACK TO SAVEPOINT s1');
        }
        await expect(insertEnvVersion(client, version(A.repoId, { envVersionId: hex('d') }))).rejects.toMatchObject({
          code: PG_ERROR.UNIQUE_VIOLATION,
        });
      });
    });
  });

  describe('agent_runs columns', () => {
    it('exist, are nullable, and are null on a run that predates them', async () => {
      const { rows } = await admin.query<{ column_name: string; is_nullable: string; data_type: string }>(
        `SELECT column_name, is_nullable, data_type FROM information_schema.columns
          WHERE table_name = 'agent_runs' AND column_name IN ('env_version_id', 'image_digest')`,
      );
      expect(rows.map((r) => [r.column_name, r.is_nullable, r.data_type]).sort()).toEqual([
        ['env_version_id', 'YES', 'text'],
        ['image_digest', 'YES', 'text'],
      ]);
      const run = await admin.query(`SELECT env_version_id, image_digest FROM agent_runs WHERE id = $1`, [A.runId]);
      expect(run.rows[0]).toEqual({ env_version_id: null, image_digest: null });
    });

    it('are shape-checked, and no app_user write path reaches them', async () => {
      await expect(admin.query(`UPDATE agent_runs SET image_digest = 'node:26' WHERE id = $1`, [A.runId])).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });
      await withTenant(appPool, A.accountId, async (client) => {
        for (const col of ['env_version_id', 'image_digest']) {
          await client.query('SAVEPOINT s1');
          await expect(client.query(`UPDATE agent_runs SET ${col} = NULL WHERE id = $1`, [A.runId])).rejects.toMatchObject({
            code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
          });
          await client.query('ROLLBACK TO SAVEPOINT s1');
        }
      });
    });
  });

  describe('earlier migrations are untouched (R5)', () => {
    // sha256 of each file as merged on main before 0674. A later edit to any of
    // them fails here; a Spec-approved edit updates the pin in the same PR.
    const PINNED: Record<string, string> = {
      '0001_core.sql': 'adce1250d847b82e9b21114444426568eb8c05fa6791f16c6484af1acc182384',
      '0002_spend_fns.sql': '9a1cd916976042c396340f79164e84207bfac53c698d0e573ac1442b8c86cce6',
      '0003_spend_security_fixes.sql': '5276dd736dbc0d5b52e15c752960b6874ad6f42b996ba510ea56a601073da346',
      '0200_partners.sql': 'e09d9eb26387e15d6a04370ff68b7bf38f1ba707fa83d900c63cfe04762290d9',
    };

    it('0001-0003 and the 02xx partners migration match their pinned hashes', () => {
      for (const [file, want] of Object.entries(PINNED)) {
        const got = createHash('sha256').update(readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, file))).digest('hex');
        expect([file, got]).toEqual([file, want]);
      }
    });

    it('0674 is additive: two new tables, two new agent_runs columns, no DROP', () => {
      const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, '0674_env.sql'), 'utf8').replace(/^--.*$/gm, '');
      expect(sql).not.toMatch(/\bDROP\b/i);
      expect([...sql.matchAll(/^ALTER TABLE (\w+)\s+ADD COLUMN/gim)].map((m) => m[1])).toEqual(['agent_runs']);
      expect([...sql.matchAll(/^CREATE TABLE (\w+)/gim)].map((m) => m[1])).toEqual(['env_versions', 'env_builds']);
    });
  });
});
