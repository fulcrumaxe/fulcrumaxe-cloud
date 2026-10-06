import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { findRlsViolations } from '../src/rlsInventory.js';

/** D#71 DS-1 criteria 2 and 3: RLS shape and tenant isolation on the 7 new tables. */
describe('discussions isolation (D#71 DS-1)', () => {
  const NEW_TABLES = [
    'discussion_counters',
    'discussions',
    'discussion_revisions',
    'discussion_comments',
    'spec_versions',
    'spec_corrections',
    'work_item_deps',
  ] as const;

  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  /** One row per new table, valid for `refs`, returning its selector (a WHERE-able column set). */
  async function seedRow(table: string, refs: SeedRefs): Promise<Record<string, unknown>> {
    switch (table) {
      case 'discussion_counters':
        await admin.query('INSERT INTO discussion_counters (account_id) VALUES ($1)', [refs.accountId]);
        return { account_id: refs.accountId };
      case 'discussions': {
        const id = randomUUID();
        await admin.query(
          `INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind)
           VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')`,
          [id, refs.accountId, Math.floor(Math.random() * 1_000_000_000) + 1, refs.workItemId],
        );
        return { id, account_id: refs.accountId };
      }
      case 'discussion_revisions': {
        const discussion = await seedRow('discussions', refs);
        await admin.query(
          `INSERT INTO discussion_revisions (account_id, discussion_id, rev, body, author_kind) VALUES ($1, $2, 1, 'x', 'user')`,
          [refs.accountId, discussion.id],
        );
        return { account_id: refs.accountId, discussion_id: discussion.id, rev: 1 };
      }
      case 'discussion_comments': {
        const discussion = await seedRow('discussions', refs);
        const id = randomUUID();
        await admin.query(
          `INSERT INTO discussion_comments (id, account_id, discussion_id, author_kind, body, provenance, origin)
           VALUES ($1, $2, $3, 'user', 'x', 'internal', 'fx')`,
          [id, refs.accountId, discussion.id],
        );
        return { id, account_id: refs.accountId };
      }
      case 'spec_versions': {
        const id = randomUUID();
        const body = `spec-${id}`;
        const version = Math.floor(Math.random() * 1_000_000_000) + 1;
        await admin.query(
          `INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, created_by_kind)
           VALUES ($1, $2, $3, $4, $5, $6, 'user')`,
          [id, refs.accountId, refs.workItemId, version, body, createHash('sha256').update(body, 'utf8').digest('hex')],
        );
        return { id, account_id: refs.accountId };
      }
      case 'spec_corrections': {
        const specVersion = await seedRow('spec_versions', refs);
        const id = randomUUID();
        await admin.query(
          `INSERT INTO spec_corrections (id, account_id, spec_version_id, code, body, created_by_kind)
           VALUES ($1, $2, $3, 'C1', 'x', 'user')`,
          [id, refs.accountId, specVersion.id],
        );
        return { id, account_id: refs.accountId };
      }
      case 'work_item_deps': {
        const otherWorkItem = randomUUID();
        await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance) VALUES ($1, $2, 'bug', 'internal')`, [
          otherWorkItem,
          refs.accountId,
        ]);
        await admin.query(
          `INSERT INTO work_item_deps (account_id, work_item_id, depends_on_id) VALUES ($1, $2, $3)`,
          [refs.accountId, refs.workItemId, otherWorkItem],
        );
        return { account_id: refs.accountId, work_item_id: refs.workItemId, depends_on_id: otherWorkItem };
      }
      default:
        throw new Error(`unknown table: ${table}`);
    }
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  // C3 item 1/2: the five tables erase_discussion_content actually
  // touches gain a SECOND policy, eraser_access, TO discussion_eraser
  // (FOR ALL, USING (true) WITH CHECK (true)) -- this is criterion 2's
  // literal shape, not a divergence from it: discussion_eraser is a
  // NOLOGIN role nobody can SET ROLE to, so the policy only ever applies
  // inside erase_discussion_content's own body. discussion_counters and
  // work_item_deps are untouched by erasure and keep the literal
  // one-policy shape. No policy anywhere names platform_ops (criterion
  // 16 -- platform_ops has no privilege on any of the 7 tables at all;
  // see discussions-privileges.test.ts for the live 42501 proof).
  const ERASER_ACCESS_TABLES = new Set([
    'discussions',
    'discussion_revisions',
    'discussion_comments',
    'spec_versions',
    'spec_corrections',
  ]);

  describe('RLS shape (criterion 2)', () => {
    for (const table of NEW_TABLES) {
      it(`${table} has RLS enabled and forced`, async () => {
        const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`,
          [table],
        );
        expect(rows[0]!.relrowsecurity).toBe(true);
        expect(rows[0]!.relforcerowsecurity).toBe(true);
      });

      it(`${table} has a tenant_isolation policy shaped exactly like work_items'`, async () => {
        const { rows } = await admin.query<{
          policyname: string;
          roles: string[];
          qual: string;
          with_check: string;
        }>(
          `SELECT policyname, roles::text[] AS roles, qual, with_check FROM pg_policies
           WHERE schemaname = 'public' AND tablename = $1 AND policyname = 'tenant_isolation'`,
          [table],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.roles).toEqual(['app_user']);

        const { rows: workItemsPolicy } = await admin.query<{ qual: string; with_check: string }>(
          `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'work_items' AND policyname = 'tenant_isolation'`,
        );
        expect(rows[0]!.qual).toBe(workItemsPolicy[0]!.qual);
        expect(rows[0]!.with_check).toBe(workItemsPolicy[0]!.with_check);
      });

      it(`${table}: policy count and role naming match the documented shape -- no policy names platform_ops or PUBLIC`, async () => {
        const { rows } = await admin.query<{ policyname: string; roles: string[]; qual: string; with_check: string }>(
          `SELECT policyname, roles::text[] AS roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
          [table],
        );
        for (const row of rows) {
          expect(row.roles).not.toContain('PUBLIC');
          expect(row.roles).not.toContain('platform_ops');
        }

        if (ERASER_ACCESS_TABLES.has(table)) {
          expect(rows).toHaveLength(2);
          const eraser = rows.find((r) => r.policyname === 'eraser_access');
          expect(eraser?.roles).toEqual(['discussion_eraser']);
          expect(eraser?.qual).toBe('true');
          expect(eraser?.with_check).toBe('true');
        } else {
          expect(rows).toHaveLength(1);
        }
      });
    }

    it('findRlsViolations returns [] on the migrated schema', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
    });
  });

  describe('tenant isolation (criterion 3)', () => {
    for (const table of NEW_TABLES) {
      it(`${table}: B's rows are invisible to A under withTenant, and UPDATE/DELETE of them affect 0 rows`, async () => {
        await seedRow(table, refsA);
        const bRow = await seedRow(table, refsB);

        await withTenant(appUserPool, refsA.accountId, async (client) => {
          const { rows } = await client.query<{ account_id: string }>(`SELECT account_id FROM ${table}`);
          expect(rows.length).toBeGreaterThan(0);
          for (const row of rows) expect(row.account_id).toBe(refsA.accountId);

          // Table-appropriate no-op mutation against B's own row: 0 rows affected under A's scope.
          if (table === 'discussion_comments') {
            const res = await client.query(`UPDATE discussion_comments SET body = 'x' WHERE id = $1`, [bRow.id]);
            expect(res.rowCount).toBe(0);
          } else if (table === 'discussion_counters') {
            const res = await client.query(`UPDATE discussion_counters SET next_number = 2 WHERE account_id = $1`, [
              bRow.account_id,
            ]);
            expect(res.rowCount).toBe(0);
          } else if (table === 'work_item_deps') {
            const res = await client.query(
              `DELETE FROM work_item_deps WHERE account_id = $1 AND work_item_id = $2 AND depends_on_id = $3`,
              [bRow.account_id, bRow.work_item_id, bRow.depends_on_id],
            );
            expect(res.rowCount).toBe(0);
          }
        });
      });
    }

    it("from withTenant(B), a SELECT of discussions by A's discussion id returns 0 rows", async () => {
      const a = await seedRow('discussions', refsA);
      await withTenant(appUserPool, refsB.accountId, async (client) => {
        const { rows } = await client.query('SELECT id FROM discussions WHERE id = $1', [a.id]);
        expect(rows).toHaveLength(0);
      });
    });

    it('under withTenant(A), an INSERT with account_id = B fails with 42501', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query(
            `INSERT INTO discussions (account_id, number, kind, title, root_work_item_id, provenance, created_by_kind)
             VALUES ($1, 999999, 'feature', 't', $2, 'internal', 'user')`,
            [refsB.accountId, refsB.workItemId],
          ),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('platform_ops has no privilege at all on the 7 tables (criterion 16)', () => {
    for (const table of NEW_TABLES) {
      it(`${table}: platform_ops SELECT fails with 42501 (no GUC, no policy, no grant)`, async () => {
        const client = await platformOpsPool.connect();
        try {
          await expect(client.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
            code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
          });
        } finally {
          client.release();
        }
      });
    }
  });
});
