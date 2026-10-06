import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#71 DS-2d (C8) criterion 1: the migration's catalog shape. Two new
 * columns with their CHECKs, two partial unique indexes with exactly the
 * specified predicates, and no change to grants or RLS policies.
 */
describe('discussions signed comments and source event key (D#71 DS-2d)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;
  let discussionId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
    discussionId = await seedDiscussion();
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  async function seedDiscussion(sourceEventId: string | null = null, accountRefs: SeedRefs = refs): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind, source_event_id)
       VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'system', $5)`,
      [id, accountRefs.accountId, Math.floor(Math.random() * 1_000_000_000) + 1, accountRefs.workItemId, sourceEventId],
    );
    return id;
  }

  function insertComment(fields: { authorKind: string; signed: boolean; runId?: string | null; role?: string | null }) {
    return admin.query(
      `INSERT INTO discussion_comments
         (account_id, discussion_id, author_kind, role, agent_run_id, body, provenance, origin, system_signed)
       VALUES ($1, $2, $3, $4, $5, 'b', 'internal', 'fx', $6)`,
      [refs.accountId, discussionId, fields.authorKind, fields.role ?? null, fields.runId ?? null, fields.signed],
    );
  }

  async function seedRun(): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status)
       VALUES ($1, $2, $3, 'executor', 'production', 'running')`,
      [id, refs.accountId, refs.workItemId],
    );
    return id;
  }

  it('system_signed is boolean NOT NULL DEFAULT false; source_event_id is nullable text', async () => {
    const { rows } = await admin.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'discussion_comments' AND column_name = 'system_signed')
            OR (table_name = 'discussions' AND column_name = 'source_event_id'))
        ORDER BY table_name`,
    );
    expect(rows).toEqual([
      { table_name: 'discussion_comments', column_name: 'system_signed', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' },
      { table_name: 'discussions', column_name: 'source_event_id', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
  });

  it('the two partial unique indexes carry exactly the specified predicates', async () => {
    const { rows } = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN ('discussion_comments_signed_once', 'discussions_source_event_once')
        ORDER BY indexname`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.indexdef).toMatch(/CREATE UNIQUE INDEX discussion_comments_signed_once ON public\.discussion_comments .*\(discussion_id, agent_run_id\) WHERE system_signed$/);
    expect(rows[1]!.indexdef).toMatch(/CREATE UNIQUE INDEX discussions_source_event_once ON public\.discussions .*\(account_id, source_event_id\) WHERE \(source_event_id IS NOT NULL\)$/);
  });

  it('a system_signed row with author_kind system fails the CHECK; with agent it passes', async () => {
    await expect(insertComment({ authorKind: 'system', signed: true })).rejects.toMatchObject({
      code: PG_ERROR.CHECK_VIOLATION,
    });
    await expect(insertComment({ authorKind: 'user', signed: true })).rejects.toMatchObject({
      code: PG_ERROR.CHECK_VIOLATION,
    });
    await insertComment({ authorKind: 'agent', signed: true, runId: await seedRun(), role: 'executor' });
  });

  it('a second signed row for the same (discussion, run) is a unique violation; unsigned agent rows repeat freely', async () => {
    const runId = await seedRun();
    await insertComment({ authorKind: 'agent', signed: true, runId, role: 'executor' });
    await expect(insertComment({ authorKind: 'agent', signed: true, runId, role: 'executor' })).rejects.toMatchObject({
      code: PG_ERROR.UNIQUE_VIOLATION,
    });
    await insertComment({ authorKind: 'agent', signed: false, runId, role: 'executor' });
    await insertComment({ authorKind: 'agent', signed: false, runId, role: 'executor' });
  });

  it('source_event_id: length CHECK, one per account, NULLs repeat, the same key in another account is fine', async () => {
    for (const bad of ['', 'x'.repeat(201)]) {
      await expect(seedDiscussion(bad)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    }
    await seedDiscussion('k-1');
    await expect(seedDiscussion('k-1')).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    await seedDiscussion(null);
    await seedDiscussion(null);
    const other = await seedAccount(admin, randomUUID());
    await seedDiscussion('k-1', other);
  });

  it('app_user cannot UPDATE system_signed or source_event_id', async () => {
    await withTenant(appUserPool, refs.accountId, async (client) => {
      await client.query('SAVEPOINT a');
      await expect(client.query('UPDATE discussion_comments SET system_signed = true')).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
      await client.query('ROLLBACK TO SAVEPOINT a');
      await expect(client.query("UPDATE discussions SET source_event_id = 'z'")).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
    });
  });

  it('grants and RLS policies are unchanged: no column grant for the new columns, one tenant_isolation policy each', async () => {
    const { rows: colGrants } = await admin.query(
      `SELECT table_name, column_name, grantee, privilege_type FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND column_name IN ('system_signed', 'source_event_id')
          AND grantee NOT IN ('postgres') AND grantee = ANY($1)`,
      [['app_user', 'platform_ops', 'partner_user', 'discussion_eraser', 'PUBLIC']],
    );
    // Only the table-level SELECT/INSERT app_user already held shows up here (column_privileges expands table grants);
    // UPDATE, REFERENCES and anything for the other roles must be absent.
    expect(colGrants.filter((r) => r.privilege_type === 'UPDATE')).toEqual([]);
    expect(colGrants.filter((r) => r.grantee !== 'app_user')).toEqual([]);

    const { rows: policies } = await admin.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename IN ('discussions', 'discussion_comments')
        ORDER BY tablename, policyname`,
    );
    expect(policies).toEqual([
      { tablename: 'discussion_comments', policyname: 'eraser_access' },
      { tablename: 'discussion_comments', policyname: 'tenant_isolation' },
      { tablename: 'discussions', policyname: 'eraser_access' },
      { tablename: 'discussions', policyname: 'tenant_isolation' },
    ]);
  });
});
