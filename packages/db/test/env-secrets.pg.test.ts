import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import {
  deleteEnvSecretRef,
  listEnvSecretAccess,
  listEnvSecretRefs,
  isSecretReference,
  putEnvSecretRef,
  recordEnvSecretAccess,
} from '../src/envSecrets.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#5 E5b: env_secret_refs and env_secret_access (0675). References and counts only, never a value. */
describe('env secrets (0675)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  const ctxA = () => ({ pool: appUserPool, accountId: a.accountId });
  const ctxB = () => ({ pool: appUserPool, accountId: b.accountId });

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  async function columns(table: string): Promise<string[]> {
    const { rows } = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY 1`,
      [table],
    );
    return rows.map((r) => r.column_name);
  }

  describe('schema: no value column exists', () => {
    it('env_secret_refs has exactly the reference-shaped columns', async () => {
      expect(await columns('env_secret_refs')).toEqual(
        ['account_id', 'created_at', 'destination_host', 'id', 'kind', 'name', 'reference', 'repo_id', 'updated_at'],
      );
    });
    it('env_secret_access has exactly the ledger columns', async () => {
      expect(await columns('env_secret_access')).toEqual(
        ['account_id', 'destination_host', 'id', 'recorded_at', 'request_count', 'run_id', 'secret_name'],
      );
    });
    it('no column on either table is named like a carrier of a value', async () => {
      const all = [...(await columns('env_secret_refs')), ...(await columns('env_secret_access'))];
      expect(all.filter((c) => /value|plain|cipher|token|password|payload|data|blob/i.test(c))).toEqual([]);
    });
  });

  describe('kind and shape CHECKs', () => {
    const base = () => ({ repoId: a.repoId, name: 'STRIPE_TEST_KEY', reference: 'vault:tenant/a/stripe' });

    it('accepts brokered_http with a host and in_sandbox without one', async () => {
      const brokered = await putEnvSecretRef(ctxA(), { ...base(), kind: 'brokered_http', destinationHost: 'api.stripe.com' });
      expect(brokered).toMatchObject({ kind: 'brokered_http', destinationHost: 'api.stripe.com', reference: 'vault:tenant/a/stripe' });
      const local = await putEnvSecretRef(ctxA(), { ...base(), name: 'DB_PASS', kind: 'in_sandbox' });
      expect(local).toMatchObject({ kind: 'in_sandbox', destinationHost: null });
    });

    it.each([
      ['a third kind', { kind: 'proxied' as never }],
      ['brokered_http without a host', { kind: 'brokered_http' as const }],
      ['in_sandbox with a host', { kind: 'in_sandbox' as const, destinationHost: 'x.example.com' }],
    ])('rejects %s', async (_label, over) => {
      await expect(putEnvSecretRef(ctxA(), { ...base(), name: 'BAD_ONE', ...over })).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });
    });

    it.each([
      '*.example.com', 'x.example.com:5432', 'localhost', 'app.localhost', 'metadata.google.internal', 'instance-data.ec2.internal',
      '169.254.169.254', '10.0.0.1', '127.1', '0x7f.0x1', '::1', '[::1]', 'fd00::1', 'intranet', 'a..example.com', '-a.example.com',
      'a-.example.com', 'a.example.com.', 'x'.repeat(254) + '.com',
    ])('refuses the destination host %s', async (destinationHost) => {
      await expect(
        putEnvSecretRef(ctxA(), { ...base(), name: 'BAD_HOST', kind: 'brokered_http', destinationHost }),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await withTenant(appUserPool, a.accountId, async (c) => {
        await expect(
          c.query(
            `INSERT INTO env_secret_access (account_id, run_id, secret_name, destination_host, request_count) VALUES ($1, $2, 'X', $3, 1)`,
            [a.accountId, a.runId, destinationHost],
          ),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });
    });

    // Not pointers: no scheme, an unlisted scheme, a credential shape after a good scheme, or a bare password.
    const BAD_REFS = [
      'hunter2', 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0', 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2', 'https://vault.example.com/x', 'file:/etc/passwd',
      'vault:sk_live_' + 'a1B2c3D4e5F6g7H8', 'vault:x/ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2', 'env:github_pat_' + 'a1B2c3D4e5F6g7H8i9J0k1',
      'vault:xoxb-' + '1234567890-abcdef', 'vault:AKIA' + 'ABCDEFGHIJKLMNOP', 'vault:-----BEGIN', 'broker:eyJhbGciOi.eyJzdWIiOiJ4.c2lnbmF0dXJl',
      'vault:' + 'A1b2C3d4'.repeat(6), 'vault:has space', 'vault:', '', 'vault:' + 'x/'.repeat(101),
    ];
    it.each(BAD_REFS)('refuses the reference %#', async (reference) => {
      expect(isSecretReference(reference)).toBe(false);
      await expect(putEnvSecretRef(ctxA(), { ...base(), name: 'BAD_REF', kind: 'in_sandbox', reference })).rejects.toThrow(TypeError);
      await withTenant(appUserPool, a.accountId, async (c) => {
        await expect(
          c.query(`INSERT INTO env_secret_refs (account_id, repo_id, name, kind, reference) VALUES ($1, $2, 'BAD_REF', 'in_sandbox', $3)`, [
            a.accountId, a.repoId, reference,
          ]),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });
    });

    it.each(['vault:tenant/a/stripe', 'env:STRIPE_TEST_KEY', 'broker:stripe-test', 'vault:network_key/2026-09'])('accepts the pointer %s', (reference) => {
      expect(isSecretReference(reference)).toBe(true);
    });

    it('refuses a name shaped like a credential', async () => {
      await expect(putEnvSecretRef(ctxA(), { ...base(), name: 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0', kind: 'in_sandbox' })).rejects.toThrow(TypeError);
    });

    it('a ref must carry a reference: NULL is refused', async () => {
      await withTenant(appUserPool, a.accountId, async (c) => {
        await expect(
          c.query(
            `INSERT INTO env_secret_refs (account_id, repo_id, name, kind, reference) VALUES ($1, $2, 'NO_REF', 'in_sandbox', NULL)`,
            [a.accountId, a.repoId],
          ),
        ).rejects.toMatchObject({ code: '23502' });
      });
    });

    it('rejects a bad name', async () => {
      await expect(putEnvSecretRef(ctxA(), { ...base(), name: '1bad name', kind: 'in_sandbox' })).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });
    });

    it('putting the same name again replaces the ref (one set per repo)', async () => {
      await putEnvSecretRef(ctxA(), { ...base(), name: 'REPLACED', kind: 'in_sandbox', reference: 'vault:one' });
      await putEnvSecretRef(ctxA(), { ...base(), name: 'REPLACED', kind: 'in_sandbox', reference: 'vault:two' });
      const rows = (await listEnvSecretRefs(ctxA(), a.repoId)).filter((r) => r.name === 'REPLACED');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reference).toBe('vault:two');
    });

    it('a repo of another tenant cannot be referenced', async () => {
      await expect(putEnvSecretRef(ctxA(), { ...base(), repoId: b.repoId, kind: 'in_sandbox' })).rejects.toMatchObject({
        code: PG_ERROR.FOREIGN_KEY_VIOLATION,
      });
    });
  });

  describe('no value ever reaches the database', () => {
    const FAKE = `fx-fake-secret-${randomUUID()}-Zq9!`;
    const FAKE_KEY = 'sk_live_' + 'Q1w2E3r4T5y6U7i8O9p0';

    it('the accessors refuse a value field outright', async () => {
      await expect(
        putEnvSecretRef(ctxA(), { repoId: a.repoId, name: 'LEAK', kind: 'in_sandbox', reference: 'vault:x', value: FAKE } as never),
      ).rejects.toThrow(/unknown field "value"/);
      await expect(
        recordEnvSecretAccess(ctxA(), { runId: a.runId, secretName: 'LEAK', destinationHost: 'x.example.com', requestCount: 1, value: FAKE } as never),
      ).rejects.toThrow(/unknown field "value"/);
    });

    it('a full dump of every public table contains no trace of a secret injected through reference or name', async () => {
      // Secret-shaped fakes go in through the reference and name paths, by the accessor and by raw SQL; the whole database is then searched.
      const refFake = 'vault:' + FAKE_KEY;
      const nameFake = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8';
      await putEnvSecretRef(ctxA(), { repoId: a.repoId, name: 'DUMPED', kind: 'brokered_http', destinationHost: 'api.example.com', reference: 'vault:dumped' });
      await recordEnvSecretAccess(ctxA(), { runId: a.runId, secretName: 'DUMPED', destinationHost: 'api.example.com', requestCount: 3 });
      const bare = 'Zq9plainPassword'; // no scheme, no credential shape: only the scheme rule stops it
      await putEnvSecretRef(ctxA(), { repoId: a.repoId, name: 'LEAK1', kind: 'in_sandbox', reference: refFake }).catch(() => undefined);
      await putEnvSecretRef(ctxA(), { repoId: a.repoId, name: 'LEAK3', kind: 'in_sandbox', reference: bare }).catch(() => undefined);
      await withTenant(appUserPool, a.accountId, (c) =>
        c.query(`INSERT INTO env_secret_refs (account_id, repo_id, name, kind, reference) VALUES ($1, $2, 'LEAK4', 'in_sandbox', $3)`, [a.accountId, a.repoId, bare]),
      ).catch(() => undefined);
      await putEnvSecretRef(ctxA(), { repoId: a.repoId, name: nameFake, kind: 'in_sandbox', reference: 'vault:x' }).catch(() => undefined);
      await recordEnvSecretAccess(ctxA(), { runId: a.runId, secretName: nameFake, destinationHost: 'api.example.com', requestCount: 1 }).catch(() => undefined);
      for (const [sql, params] of [
        [`INSERT INTO env_secret_refs (account_id, repo_id, name, kind, reference) VALUES ($1, $2, 'LEAK2', 'in_sandbox', $3)`, [a.accountId, a.repoId, refFake]],
        [`INSERT INTO env_secret_refs (account_id, repo_id, name, kind, reference) VALUES ($1, $2, $3, 'in_sandbox', 'vault:x')`, [a.accountId, a.repoId, nameFake]],
        [`INSERT INTO env_secret_access (account_id, run_id, secret_name, destination_host, request_count) VALUES ($1, $2, $3, 'api.example.com', 1)`, [a.accountId, a.runId, nameFake]],
      ] as const) {
        await withTenant(appUserPool, a.accountId, (c) => c.query(sql, [...params])).catch(() => undefined);
      }
      const { rows } = await admin.query<{ dump: string }>(
        `SELECT string_agg(query_to_xml(format('SELECT * FROM %I.%I', schemaname, tablename), false, false, '')::text, '') AS dump
           FROM pg_tables WHERE schemaname = 'public'`,
      );
      const dump = rows[0]!.dump;
      expect(dump).toContain('vault:dumped'); // the dump really covers these tables
      for (const fake of [FAKE, FAKE_KEY, nameFake, bare]) expect(dump).not.toContain(fake);
    });
  });

  describe('access ledger', () => {
    it('sums requests per secret and host for a run', async () => {
      await recordEnvSecretAccess(ctxA(), { runId: a.runId, secretName: 'LEDGER', destinationHost: 'api.example.com', requestCount: 2 });
      await recordEnvSecretAccess(ctxA(), { runId: a.runId, secretName: 'LEDGER', destinationHost: 'api.example.com', requestCount: 5 });
      await recordEnvSecretAccess(ctxA(), { runId: a.runId, secretName: 'LEDGER', destinationHost: 'other.example.com', requestCount: 1 });
      const totals = (await listEnvSecretAccess(ctxA(), a.runId)).filter((t) => t.secretName === 'LEDGER');
      expect(totals).toEqual([
        { secretName: 'LEDGER', destinationHost: 'api.example.com', requestCount: 7 },
        { secretName: 'LEDGER', destinationHost: 'other.example.com', requestCount: 1 },
      ]);
    });

    it.each([0, -1, 1.5, Number.NaN])('refuses request count %s', async (requestCount) => {
      await expect(
        recordEnvSecretAccess(ctxA(), { runId: a.runId, secretName: 'LEDGER', destinationHost: 'x.example.com', requestCount }),
      ).rejects.toThrow(RangeError);
    });

    it("refuses another tenant's run", async () => {
      await expect(
        recordEnvSecretAccess(ctxB(), { runId: a.runId, secretName: 'LEDGER', destinationHost: 'x.example.com', requestCount: 1 }),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('is append-only for app_user', async () => {
      await withTenant(appUserPool, a.accountId, async (c) => {
        await expect(c.query(`UPDATE env_secret_access SET request_count = 1`)).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      });
      await withTenant(appUserPool, a.accountId, async (c) => {
        await expect(c.query(`DELETE FROM env_secret_access`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      });
    });
  });

  describe('row-level security', () => {
    it('another tenant reads none of these rows', async () => {
      await putEnvSecretRef(ctxA(), { repoId: a.repoId, name: 'ONLY_A', kind: 'in_sandbox', reference: 'vault:a' });
      await recordEnvSecretAccess(ctxA(), { runId: a.runId, secretName: 'ONLY_A', destinationHost: 'a.example.com', requestCount: 1 });
      expect((await listEnvSecretRefs(ctxA(), a.repoId)).some((r) => r.name === 'ONLY_A')).toBe(true);
      expect(await listEnvSecretRefs(ctxB(), a.repoId)).toEqual([]);
      expect(await listEnvSecretAccess(ctxB(), a.runId)).toEqual([]);
      for (const table of ['env_secret_refs', 'env_secret_access']) {
        const rows = await withTenant(appUserPool, b.accountId, async (c) => (await c.query(`SELECT * FROM ${table}`)).rows);
        expect(rows).toEqual([]);
      }
    });

    it('a tenant cannot write a row for another account', async () => {
      await withTenant(appUserPool, b.accountId, async (c) => {
        await expect(
          c.query(
            `INSERT INTO env_secret_refs (account_id, repo_id, name, kind, reference) VALUES ($1, $2, 'X', 'in_sandbox', 'vault:x')`,
            [a.accountId, a.repoId],
          ),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      });
      await withTenant(appUserPool, b.accountId, async (c) => {
        await expect(
          c.query(
            `INSERT INTO env_secret_access (account_id, run_id, secret_name, destination_host, request_count) VALUES ($1, $2, 'X', 'x.example.com', 1)`,
            [a.accountId, a.runId],
          ),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      });
    });

    it("another tenant's delete removes nothing", async () => {
      expect(await deleteEnvSecretRef(ctxB(), a.repoId, 'ONLY_A')).toBe(false);
      expect(await deleteEnvSecretRef(ctxA(), a.repoId, 'ONLY_A')).toBe(true);
    });
  });
});
