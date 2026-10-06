import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2606 K04: site-kit tables (sites, claims, site_versions, attestations,
 * sync_passes) in the same migrations directory D#2605 H02 owns.
 *
 * This file deliberately does NOT touch test/helpers/seed.ts (TENANT_TABLES,
 * ROW_BUILDERS, CROSS_TENANT_FK_CASES): that shared helper is H02's own
 * file, already consumed by rls-isolation.test.ts, account-soft-delete.test.ts
 * and cross-tenant-fk.test.ts. K04's Files list is exactly this migration
 * plus this test file, so isolation/cross-tenant-FK coverage for the five
 * new tables lives here instead, mirroring those files' patterns (same
 * SQLSTATE-assertion style, same withTenant/seedAccount helpers) rather than
 * widening a file outside K04's scope.
 *
 * `findRlsViolations` in rls-inventory.test.ts already sweeps every table
 * in `public` generically, so it picks up these five tables with zero
 * changes there -- the explicit check below just names them, the same way
 * rls-inventory.test.ts names `users`/`partners` explicitly on top of its
 * own generic sweep.
 */

/** SQLSTATEs not in helpers/pgErrors.ts -- this file is the only one that
 * currently needs them. */
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';

const SITEKIT_TABLES = ['sites', 'claims', 'site_versions', 'attestations', 'sync_passes'] as const;
type SitekitTable = (typeof SITEKIT_TABLES)[number];

interface SitekitRefs {
  siteId: string;
  claimId: string;
  /** A second claim on the same site, never attested -- lets the
   * isolation-insert test for `attestations` use a claim/version pair that
   * hasn't already been used, so it doesn't collide with the seeded
   * attestation's UNIQUE (claim_id, version_id) for the wrong reason. */
  spareClaimId: string;
  versionId: string;
  spareVersionId: string;
}

/** One full, FK-consistent row per site-kit table for `refs`'s account,
 * inserted as admin (bypasses RLS -- this is seeding, not the check). */
async function seedSitekit(admin: PoolClient, refs: SeedRefs): Promise<SitekitRefs> {
  const siteId = randomUUID();
  const claimId = randomUUID();
  const spareClaimId = randomUUID();
  const versionId = randomUUID();
  const spareVersionId = randomUUID();

  await admin.query(
    `INSERT INTO sites (id, account_id, repo_id, status) VALUES ($1, $2, $3, 'draft')`,
    [siteId, refs.accountId, refs.repoId],
  );
  await admin.query(
    `INSERT INTO claims (id, account_id, site_id, claim_key, text, kind, verdict)
     VALUES ($1, $2, $3, $4, 'seed claim text', 'feature', 'PENDING')`,
    [claimId, refs.accountId, siteId, `claim-${claimId}`],
  );
  await admin.query(
    `INSERT INTO claims (id, account_id, site_id, claim_key, text, kind, verdict)
     VALUES ($1, $2, $3, $4, 'spare claim text', 'feature', 'PENDING')`,
    [spareClaimId, refs.accountId, siteId, `claim-${spareClaimId}`],
  );
  await admin.query(
    `INSERT INTO site_versions (id, account_id, site_id, repo_sha, content, template_version, template_digest, content_schema_version)
     VALUES ($1, $2, $3, 'sha-seed', $4::jsonb, 'v1', 'digest-v1', 1)`,
    [versionId, refs.accountId, siteId, JSON.stringify({ pages: [] })],
  );
  await admin.query(
    `INSERT INTO site_versions (id, account_id, site_id, repo_sha, content, template_version, template_digest, content_schema_version)
     VALUES ($1, $2, $3, 'sha-spare', $4::jsonb, 'v1', 'digest-v1', 1)`,
    [spareVersionId, refs.accountId, siteId, JSON.stringify({ pages: [] })],
  );
  await admin.query(
    `INSERT INTO attestations (account_id, claim_id, version_id, user_id) VALUES ($1, $2, $3, $4)`,
    [refs.accountId, claimId, versionId, refs.userId],
  );
  await admin.query(
    `INSERT INTO sync_passes (account_id, site_id, trigger, status) VALUES ($1, $2, 'push', 'pending')`,
    [refs.accountId, siteId],
  );

  return { siteId, claimId, spareClaimId, versionId, spareVersionId };
}

/** One INSERT builder per site-kit table, shaped for `owner`'s account,
 * pointing every FK at `owner`'s own rows -- used by the isolation-insert
 * test to attempt a row that's valid in every way EXCEPT the account_id
 * written into it (which the caller overrides via `writeAccountId`). */
function buildInsert(
  table: SitekitTable,
  owner: SitekitRefs,
  writeAccountId: string,
  ownerUserId: string,
): { sql: string; params: unknown[] } {
  switch (table) {
    case 'sites':
      return {
        sql: `INSERT INTO sites (account_id, repo_id, status) VALUES ($1, $2, 'draft')`,
        params: [writeAccountId, owner.siteId],
      };
    case 'claims':
      return {
        sql: `INSERT INTO claims (account_id, site_id, claim_key, text, kind, verdict)
              VALUES ($1, $2, $3, 'fresh claim', 'feature', 'PENDING')`,
        params: [writeAccountId, owner.siteId, `claim-fresh-${randomUUID()}`],
      };
    case 'site_versions':
      return {
        sql: `INSERT INTO site_versions (account_id, site_id, repo_sha, content, template_version, template_digest, content_schema_version)
              VALUES ($1, $2, 'sha-fresh', '{}'::jsonb, 'v1', 'digest-v1', 1)`,
        params: [writeAccountId, owner.siteId],
      };
    case 'attestations':
      // Uses the SPARE claim/version pair: the seeded pair is already
      // attested, so reusing it would collide on UNIQUE (claim_id,
      // version_id) before RLS is ever evaluated -- the wrong reason to
      // reject (same class of bug the seed.ts helpers guard against).
      return {
        sql: `INSERT INTO attestations (account_id, claim_id, version_id, user_id) VALUES ($1, $2, $3, $4)`,
        params: [writeAccountId, owner.spareClaimId, owner.spareVersionId, ownerUserId],
      };
    case 'sync_passes':
      return {
        sql: `INSERT INTO sync_passes (account_id, site_id, trigger, status) VALUES ($1, $2, 'push', 'pending')`,
        params: [writeAccountId, owner.siteId],
      };
  }
}

describe('site-kit tables (D#2606 K04)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;
  let sitekitA: SitekitRefs;
  let sitekitB: SitekitRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);

    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
    sitekitA = await seedSitekit(admin, refsA);
    sitekitB = await seedSitekit(admin, refsB);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  describe('RLS inventory', () => {
    it('every site-kit table is enabled AND forced (on top of the generic sweep)', async () => {
      const violations = await findRlsViolations(admin);
      for (const table of SITEKIT_TABLES) {
        expect(violations).not.toContain(table);
      }

      const { rows } = await admin.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
         WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
        [SITEKIT_TABLES],
      );
      expect(rows).toHaveLength(SITEKIT_TABLES.length);
      for (const row of rows) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }
    });
  });

  describe('RLS isolation (as app_user)', () => {
    it.each(SITEKIT_TABLES)('SELECT on %s as tenant A never returns tenant B rows', async (table) => {
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        const { rows } = await client.query<{ account_id: string }>(`SELECT account_id FROM ${table}`);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.account_id).toBe(refsA.accountId);
        }
      });
    });

    it.each(SITEKIT_TABLES)('SELECT on %s with app.account_id unset returns zero rows (fail closed)', async (table) => {
      const client = await appUserPool.connect();
      try {
        // Deliberately no withTenant() here: app.account_id is unset.
        const { rows } = await client.query(`SELECT * FROM ${table}`);
        expect(rows).toEqual([]);
      } finally {
        client.release();
      }
    });

    it.each(SITEKIT_TABLES)(
      'INSERT into %s with account_id = tenant B is rejected under a tenant A session',
      async (table) => {
        await expect(
          withTenant(appUserPool, refsA.accountId, async (client) => {
            const { sql, params } = buildInsert(table, sitekitB, refsB.accountId, refsB.userId);
            await client.query(sql, params);
          }),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      },
    );

    it.each(SITEKIT_TABLES)(
      'UPDATE on %s re-parenting a tenant A row to account_id = tenant B is rejected',
      async (table) => {
        await expect(
          withTenant(appUserPool, refsA.accountId, async (client) => {
            await client.query(`UPDATE ${table} SET account_id = $1 WHERE account_id = $2`, [
              refsB.accountId,
              refsA.accountId,
            ]);
          }),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      },
    );
  });

  describe('cross-tenant composite foreign keys are rejected (CWE-639)', () => {
    // Run as admin (bypasses RLS): proves the FK constraint itself, not
    // RLS, rejects a cross-tenant parent id -- same rationale as
    // cross-tenant-fk.test.ts.
    it('sites.repo_id -> repos rejects tenant B\'s repo id', async () => {
      await expect(
        admin.query(`INSERT INTO sites (account_id, repo_id, status) VALUES ($1, $2, 'draft')`, [
          refsA.accountId,
          refsB.repoId,
        ]),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('claims.site_id -> sites rejects tenant B\'s site id', async () => {
      await expect(
        admin.query(
          `INSERT INTO claims (account_id, site_id, claim_key, text, kind, verdict)
           VALUES ($1, $2, $3, 'x', 'feature', 'PENDING')`,
          [refsA.accountId, sitekitB.siteId, `claim-${randomUUID()}`],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('site_versions.site_id -> sites rejects tenant B\'s site id', async () => {
      await expect(
        admin.query(
          `INSERT INTO site_versions (account_id, site_id, repo_sha, content, template_version, template_digest, content_schema_version)
           VALUES ($1, $2, 'sha-x', '{}'::jsonb, 'v1', 'digest-v1', 1)`,
          [refsA.accountId, sitekitB.siteId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('attestations.claim_id -> claims rejects tenant B\'s claim id', async () => {
      await expect(
        admin.query(
          `INSERT INTO attestations (account_id, claim_id, version_id, user_id) VALUES ($1, $2, $3, $4)`,
          [refsA.accountId, sitekitB.claimId, sitekitA.spareVersionId, refsA.userId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('attestations.version_id -> site_versions rejects tenant B\'s version id', async () => {
      await expect(
        admin.query(
          `INSERT INTO attestations (account_id, claim_id, version_id, user_id) VALUES ($1, $2, $3, $4)`,
          [refsA.accountId, sitekitA.spareClaimId, sitekitB.versionId, refsA.userId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('sync_passes.site_id -> sites rejects tenant B\'s site id', async () => {
      await expect(
        admin.query(`INSERT INTO sync_passes (account_id, site_id, trigger, status) VALUES ($1, $2, 'push', 'pending')`, [
          refsA.accountId,
          sitekitB.siteId,
        ]),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('sanity: the same insert shape succeeds against its OWN tenant\'s parent id', async () => {
      await expect(
        admin.query(`INSERT INTO sync_passes (account_id, site_id, trigger, status) VALUES ($1, $2, 'push', 'pending')`, [
          refsA.accountId,
          sitekitA.siteId,
        ]),
      ).resolves.toBeDefined();
    });
  });

  describe('claims.kind and claims.verdict enum CHECK constraints', () => {
    it('rejects a claims.kind value outside the K01 ClaimKind enum', async () => {
      await expect(
        admin.query(
          `INSERT INTO claims (account_id, site_id, claim_key, text, kind, verdict)
           VALUES ($1, $2, $3, 'x', 'not-a-real-kind', 'PENDING')`,
          [refsA.accountId, sitekitA.siteId, `claim-${randomUUID()}`],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('rejects a claims.verdict value outside the K01 ClaimVerdict enum', async () => {
      await expect(
        admin.query(
          `INSERT INTO claims (account_id, site_id, claim_key, text, kind, verdict)
           VALUES ($1, $2, $3, 'x', 'feature', 'NOT-A-REAL-VERDICT')`,
          [refsA.accountId, sitekitA.siteId, `claim-${randomUUID()}`],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it.each(['feature', 'figure', 'status', 'pricing', 'legal', 'security'])(
      'accepts claims.kind = %s',
      async (kind) => {
        await expect(
          admin.query(
            `INSERT INTO claims (account_id, site_id, claim_key, text, kind, verdict)
             VALUES ($1, $2, $3, 'x', $4, 'PENDING')`,
            [refsA.accountId, sitekitA.siteId, `claim-${randomUUID()}`, kind],
          ),
        ).resolves.toBeDefined();
      },
    );

    it.each(['VERIFIED', 'FALSE', 'UNVERIFIABLE', 'CONFLICT', 'PENDING', 'ATTESTED'])(
      'accepts claims.verdict = %s',
      async (verdict) => {
        await expect(
          admin.query(
            `INSERT INTO claims (account_id, site_id, claim_key, text, kind, verdict)
             VALUES ($1, $2, $3, 'x', 'feature', $4)`,
            [refsA.accountId, sitekitA.siteId, `claim-${randomUUID()}`, verdict],
          ),
        ).resolves.toBeDefined();
      },
    );
  });

  describe('site_versions.approved_by is required for published_at to be set', () => {
    it('rejects an INSERT with published_at set and approved_by NULL', async () => {
      await expect(
        admin.query(
          `INSERT INTO site_versions (account_id, site_id, repo_sha, content, template_version, template_digest, content_schema_version, published_at)
           VALUES ($1, $2, 'sha-bad', '{}'::jsonb, 'v1', 'digest-v1', 1, now())`,
          [refsA.accountId, sitekitA.siteId],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('rejects an UPDATE that sets published_at on a row with no approved_by', async () => {
      const versionId = randomUUID();
      await admin.query(
        `INSERT INTO site_versions (id, account_id, site_id, repo_sha, content, template_version, template_digest, content_schema_version)
         VALUES ($1, $2, $3, 'sha-noapprove', '{}'::jsonb, 'v1', 'digest-v1', 1)`,
        [versionId, refsA.accountId, sitekitA.siteId],
      );
      await expect(
        admin.query(`UPDATE site_versions SET published_at = now() WHERE id = $1`, [versionId]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('accepts published_at set together with approved_by', async () => {
      await expect(
        admin.query(
          `INSERT INTO site_versions (account_id, site_id, repo_sha, content, template_version, template_digest, content_schema_version, approved_by, approved_at, published_at)
           VALUES ($1, $2, 'sha-good', '{}'::jsonb, 'v1', 'digest-v1', 1, $3, now(), now())`,
          [refsA.accountId, sitekitA.siteId, refsA.userId],
        ),
      ).resolves.toBeDefined();
    });

    it('accepts approved_by set alone, with published_at left NULL (approved but not yet published)', async () => {
      await expect(
        admin.query(
          `INSERT INTO site_versions (account_id, site_id, repo_sha, content, template_version, template_digest, content_schema_version, approved_by, approved_at)
           VALUES ($1, $2, 'sha-approved-only', '{}'::jsonb, 'v1', 'digest-v1', 1, $3, now())`,
          [refsA.accountId, sitekitA.siteId, refsA.userId],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('site_versions.template_digest and content_schema_version (D#2606 Discussion amendment 2)', () => {
    it('rejects an INSERT with template_digest NULL', async () => {
      await expect(
        admin.query(
          `INSERT INTO site_versions (account_id, site_id, repo_sha, content, template_version, content_schema_version)
           VALUES ($1, $2, 'sha-no-digest', '{}'::jsonb, 'v1', 1)`,
          [refsA.accountId, sitekitA.siteId],
        ),
      ).rejects.toMatchObject({ code: NOT_NULL_VIOLATION });
    });

    it('rejects an INSERT with content_schema_version NULL', async () => {
      await expect(
        admin.query(
          `INSERT INTO site_versions (account_id, site_id, repo_sha, content, template_version, template_digest)
           VALUES ($1, $2, 'sha-no-schema-version', '{}'::jsonb, 'v1', 'digest-v1')`,
          [refsA.accountId, sitekitA.siteId],
        ),
      ).rejects.toMatchObject({ code: NOT_NULL_VIOLATION });
    });

    it('accepts an INSERT with template_digest and content_schema_version both set', async () => {
      const { rows } = await admin.query<{ template_digest: string; content_schema_version: number }>(
        `INSERT INTO site_versions (account_id, site_id, repo_sha, content, template_version, template_digest, content_schema_version)
         VALUES ($1, $2, 'sha-both-set', '{}'::jsonb, 'v1', 'sha256-deadbeef', 2)
         RETURNING template_digest, content_schema_version`,
        [refsA.accountId, sitekitA.siteId],
      );
      expect(rows).toEqual([{ template_digest: 'sha256-deadbeef', content_schema_version: 2 }]);
    });

    it('content_schema_version is an integer column, not text (rejects a non-numeric value)', async () => {
      await expect(
        admin.query(
          `INSERT INTO site_versions (account_id, site_id, repo_sha, content, template_version, template_digest, content_schema_version)
           VALUES ($1, $2, 'sha-bad-schema-version', '{}'::jsonb, 'v1', 'digest-v1', 'not-a-number')`,
          [refsA.accountId, sitekitA.siteId],
        ),
      ).rejects.toBeDefined();
    });
  });

  describe('site_versions column-limited UPDATE (security review MUST FIX)', () => {
    // Live-verified finding: a blanket UPDATE grant let app_user rewrite
    // content/template_digest/repo_sha/content_schema_version on an
    // already-approved-and-published row, and re-point approved_by or
    // backdate approved_at/published_at -- defeating the entire reason
    // template_digest exists (binding a K07 approval to the bytes that
    // actually rendered, not a label). The fix is a column-limited GRANT,
    // not a policy change, so these assert 42501 comes from the grant
    // itself -- the same mechanism that already rejects a re-parented
    // account_id (test above, unchanged).
    const WRITE_ONCE_COLUMNS: Array<{ column: string; sql: string }> = [
      { column: 'repo_sha', sql: `UPDATE site_versions SET repo_sha = 'sha-rewritten' WHERE id = $1` },
      { column: 'content', sql: `UPDATE site_versions SET content = '{"tampered":true}'::jsonb WHERE id = $1` },
      { column: 'template_version', sql: `UPDATE site_versions SET template_version = 'v2-tampered' WHERE id = $1` },
      { column: 'template_digest', sql: `UPDATE site_versions SET template_digest = 'digest-tampered' WHERE id = $1` },
      { column: 'content_schema_version', sql: `UPDATE site_versions SET content_schema_version = 99 WHERE id = $1` },
    ];

    it.each(WRITE_ONCE_COLUMNS)('UPDATE of site_versions.$column is rejected (write-once)', async ({ sql }) => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(sql, [sitekitA.versionId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('positive control: app_user CAN still update report/approved_by/approved_at/published_at', async () => {
      const versionId = randomUUID();
      await admin.query(
        `INSERT INTO site_versions (id, account_id, site_id, repo_sha, content, template_version, template_digest, content_schema_version)
         VALUES ($1, $2, $3, 'sha-lifecycle', '{}'::jsonb, 'v1', 'digest-v1', 1)`,
        [versionId, refsA.accountId, sitekitA.siteId],
      );
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE site_versions SET report = '{"blockers":0}'::jsonb, approved_by = $1, approved_at = now(), published_at = now() WHERE id = $2`,
          [refsA.userId, versionId],
        );
        expect(rowCount).toBe(1);
      });
    });
  });

  describe('grant decisions are locked in by tests (security review FIX)', () => {
    // "RLS was never the problem here, the base GRANT was" -- the same
    // round-7 finding that shaped ledger/audit_log's own privileges test.
    // These assert the deliberate grant choices this migration already
    // makes (no DELETE anywhere, attestations append-only) so a future
    // edit to this file can't silently widen one without a test going red.
    it.each(SITEKIT_TABLES)('DELETE on %s is refused for app_user', async (table) => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(`DELETE FROM ${table} WHERE account_id = $1`, [refsA.accountId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('UPDATE on attestations is refused for app_user (append-only)', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(`UPDATE attestations SET at = now() WHERE account_id = $1`, [
            refsA.accountId,
          ]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it.each(SITEKIT_TABLES)(
      'INSERT into %s with app.account_id unset (realistic pooled state) raises 42501',
      async (table) => {
        const client = await appUserPool.connect();
        try {
          // Deliberately no withTenant() here: app.account_id is unset,
          // matching the pooled-connection '' state, not NULL.
          const { sql, params } = buildInsert(table, sitekitA, refsA.accountId, refsA.userId);
          await expect(client.query(sql, params)).rejects.toMatchObject({
            code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
          });
        } finally {
          client.release();
        }
      },
    );

    // attestations has no UPDATE grant at all (asserted above), so it always
    // raises 42501 regardless of GUC state -- it can never reach "0 rows
    // affected". This covers the other four, which DO have an UPDATE grant.
    const UPDATE_WITH_NO_TENANT: Array<{ table: Exclude<SitekitTable, 'attestations'>; sql: string }> = [
      { table: 'sites', sql: `UPDATE sites SET status = 'draft'` },
      { table: 'claims', sql: `UPDATE claims SET text = 'x'` },
      { table: 'site_versions', sql: `UPDATE site_versions SET report = '{}'::jsonb` },
      { table: 'sync_passes', sql: `UPDATE sync_passes SET status = 'pending'` },
    ];

    it.each(UPDATE_WITH_NO_TENANT)(
      'UPDATE on $table with app.account_id unset affects 0 rows (fail closed, not an error)',
      async ({ sql }) => {
        const client = await appUserPool.connect();
        try {
          const { rowCount } = await client.query(sql);
          expect(rowCount).toBe(0);
        } finally {
          client.release();
        }
      },
    );
  });

  describe('attestations.user_id is bound to the signer (security review FIX)', () => {
    // Live-verified finding: the account_id-only WITH CHECK let app_user
    // insert an attestation naming ANY real row in the global `users`
    // table as user_id -- including another tenant's owner -- and because
    // this table is append-only, a wrong signer would be permanent with no
    // repair path, on the table whose entire purpose is naming who signed
    // off on legal/pricing/security text published in the customer's name.
    it('rejects an attestation naming a real user who is not a member of the tenant account', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, refsB.userId, async (client) => {
          await client.query(
            `INSERT INTO attestations (account_id, claim_id, version_id, user_id) VALUES ($1, $2, $3, $4)`,
            [refsA.accountId, sitekitA.spareClaimId, sitekitA.spareVersionId, refsB.userId],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('rejects an attestation whose user_id does not match the session\'s own app.user_id', async () => {
      await expect(
        // Session claims to be refsB.userId, but the row names refsA's own
        // member as the signer -- a mismatch either way should reject.
        withTenant(appUserPool, refsA.accountId, refsB.userId, async (client) => {
          await client.query(
            `INSERT INTO attestations (account_id, claim_id, version_id, user_id) VALUES ($1, $2, $3, $4)`,
            [refsA.accountId, sitekitA.spareClaimId, sitekitA.spareVersionId, refsA.userId],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('accepts an attestation naming the session\'s own member as signer', async () => {
      const { rows } = await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        return client.query<{ user_id: string }>(
          `INSERT INTO attestations (account_id, claim_id, version_id, user_id)
           VALUES ($1, $2, $3, $4) RETURNING user_id`,
          [refsA.accountId, sitekitA.spareClaimId, sitekitA.spareVersionId, refsA.userId],
        );
      });
      expect(rows).toEqual([{ user_id: refsA.userId }]);
    });
  });
});
