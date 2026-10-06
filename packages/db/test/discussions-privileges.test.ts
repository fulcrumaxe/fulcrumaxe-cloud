import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#71 DS-1 criteria 5, 6, 13, 14, 15 and 16: append-only grants,
 * discussion_comments' and discussions' column-scoped grants,
 * discussion_counters' monotonic trigger, erasure (C3), and platform_ops'
 * total absence of privilege on the 7 tables.
 */
describe('discussions privileges (D#71 DS-1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

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

  async function seedDiscussion(refs: SeedRefs, overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
    const id = randomUUID();
    const p = {
      id,
      account_id: refs.accountId,
      number: Math.floor(Math.random() * 1_000_000_000) + 1,
      kind: 'feature',
      title: 't',
      root_work_item_id: refs.workItemId,
      provenance: 'internal',
      created_by_kind: 'user',
      ...overrides,
    };
    await admin.query(
      `INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [p.id, p.account_id, p.number, p.kind, p.title, p.root_work_item_id, p.provenance, p.created_by_kind],
    );
    return id;
  }

  async function seedComment(refs: SeedRefs, discussionId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO discussion_comments (id, account_id, discussion_id, author_kind, body, provenance, origin)
       VALUES ($1, $2, $3, 'user', 'original', 'internal', 'fx')`,
      [id, refs.accountId, discussionId],
    );
    return id;
  }

  async function seedSpecVersion(refs: SeedRefs, body = 'spec body'): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, created_by_kind)
       VALUES ($1, $2, $3, $4, $5, $6, 'user')`,
      [
        id,
        refs.accountId,
        refs.workItemId,
        Math.floor(Math.random() * 1_000_000_000) + 1,
        body,
        createHash('sha256').update(body, 'utf8').digest('hex'),
      ],
    );
    return id;
  }

  describe('app_user table-wide privilege sets (design decisions, not append-only)', () => {
    const EXPECTED: Record<string, string[]> = {
      // discussion_counters and discussions each additionally hold a
      // column-scoped UPDATE (criteria 14/15, tested in their own blocks
      // below) -- information_schema.role_table_grants only reports
      // table-wide privileges, so a column-only UPDATE does not appear
      // here (this is itself part of what those blocks prove).
      discussion_counters: ['SELECT', 'INSERT'],
      discussions: ['SELECT', 'INSERT'],
      work_item_deps: ['SELECT', 'INSERT', 'DELETE'],
    };

    for (const [table, expected] of Object.entries(EXPECTED)) {
      it(`${table}: app_user holds exactly ${expected.join(', ')} table-wide`, async () => {
        const { rows } = await admin.query<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants
           WHERE table_schema = 'public' AND table_name = $1 AND grantee = 'app_user'`,
          [table],
        );
        expect(new Set(rows.map((r) => r.privilege_type))).toEqual(new Set(expected));
      });
    }

    it('as app_user: work_item_deps DELETE (deps.remove) succeeds on an own-tenant row', async () => {
      const otherWorkItem = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance) VALUES ($1, $2, 'bug', 'internal')`, [
        otherWorkItem,
        refsA.accountId,
      ]);
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        await client.query('INSERT INTO work_item_deps (account_id, work_item_id, depends_on_id) VALUES ($1, $2, $3)', [
          refsA.accountId,
          refsA.workItemId,
          otherWorkItem,
        ]);
        const res = await client.query(
          'DELETE FROM work_item_deps WHERE account_id = $1 AND work_item_id = $2 AND depends_on_id = $3',
          [refsA.accountId, refsA.workItemId, otherWorkItem],
        );
        expect(res.rowCount).toBe(1);
      });
    });
  });

  describe('append-only grants (criterion 5)', () => {
    const APPEND_ONLY_TABLES = ['discussion_revisions', 'spec_versions', 'spec_corrections', 'work_item_transitions'];

    for (const table of APPEND_ONLY_TABLES) {
      it(`${table}: app_user holds no UPDATE or DELETE grant at all`, async () => {
        const { rows } = await admin.query<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants
           WHERE table_schema = 'public' AND table_name = $1 AND grantee = 'app_user'`,
          [table],
        );
        const privileges = new Set(rows.map((r) => r.privilege_type));
        expect(privileges.has('UPDATE')).toBe(false);
        expect(privileges.has('DELETE')).toBe(false);
      });
    }

    it('as app_user: UPDATE and DELETE on discussion_revisions fail with 42501', async () => {
      const discussionId = await seedDiscussion(refsA);
      await admin.query(
        `INSERT INTO discussion_revisions (account_id, discussion_id, rev, body, author_kind) VALUES ($1, $2, 1, 'x', 'user')`,
        [refsA.accountId, discussionId],
      );
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query('UPDATE discussion_revisions SET body = $1 WHERE discussion_id = $2', ['y', discussionId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query('DELETE FROM discussion_revisions WHERE discussion_id = $1', [discussionId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('as app_user: UPDATE and DELETE on spec_versions fail with 42501', async () => {
      const specVersionId = await seedSpecVersion(refsA);
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query('UPDATE spec_versions SET source_path = $1 WHERE id = $2', ['x', specVersionId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query('DELETE FROM spec_versions WHERE id = $1', [specVersionId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('as app_user: UPDATE and DELETE on spec_corrections fail with 42501', async () => {
      const specVersionId = await seedSpecVersion(refsA);
      const correctionId = randomUUID();
      await admin.query(
        `INSERT INTO spec_corrections (id, account_id, spec_version_id, code, body, created_by_kind)
         VALUES ($1, $2, $3, 'C1', 'x', 'user')`,
        [correctionId, refsA.accountId, specVersionId],
      );
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query('UPDATE spec_corrections SET body = $1 WHERE id = $2', ['y', correctionId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query('DELETE FROM spec_corrections WHERE id = $1', [correctionId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe("discussion_comments' column grant (criterion 6)", () => {
    it('UPDATE of body, edited_at or deleted_at succeeds on an own-tenant row', async () => {
      const discussionId = await seedDiscussion(refsA);
      const commentId = await seedComment(refsA, discussionId);
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        await client.query('UPDATE discussion_comments SET body = $1 WHERE id = $2', ['edited', commentId]);
        await client.query('UPDATE discussion_comments SET edited_at = now() WHERE id = $1', [commentId]);
        await client.query('UPDATE discussion_comments SET deleted_at = now() WHERE id = $1', [commentId]);
      });
    });

    it('UPDATE of any other column (e.g. erased_at, author_kind) fails with 42501', async () => {
      const discussionId = await seedDiscussion(refsA);
      const commentId = await seedComment(refsA, discussionId);
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query('UPDATE discussion_comments SET erased_at = now() WHERE id = $1', [commentId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query("UPDATE discussion_comments SET author_kind = 'system' WHERE id = $1", [commentId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('DELETE fails with 42501', async () => {
      const discussionId = await seedDiscussion(refsA);
      const commentId = await seedComment(refsA, discussionId);
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query('DELETE FROM discussion_comments WHERE id = $1', [commentId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('discussions column-scoped UPDATE (criterion 14, C3 S2)', () => {
    it('UPDATE of title, kind, visibility, security, closed_at or deleted_at succeeds on an own-tenant row', async () => {
      const id = await seedDiscussion(refsA);
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        await client.query(`UPDATE discussions SET title = 'renamed' WHERE id = $1`, [id]);
        await client.query(`UPDATE discussions SET kind = 'bug' WHERE id = $1`, [id]);
        await client.query(`UPDATE discussions SET visibility = 'repo' WHERE id = $1`, [id]);
        await client.query(`UPDATE discussions SET security = false WHERE id = $1`, [id]);
        await client.query(`UPDATE discussions SET closed_at = now() WHERE id = $1`, [id]);
        await client.query(`UPDATE discussions SET deleted_at = now() WHERE id = $1`, [id]);
      });
    });

    it('UPDATE of provenance, account_id, root_work_item_id, created_by_kind, created_by_user_id, number, repo_id, id or created_at fails with 42501', async () => {
      const id = await seedDiscussion(refsA);
      const otherWorkItem = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance) VALUES ($1, $2, 'bug', 'internal')`, [
        otherWorkItem,
        refsA.accountId,
      ]);
      const FORBIDDEN: Array<[string, unknown]> = [
        ['provenance', 'internal'],
        ['account_id', refsA.accountId],
        ['root_work_item_id', otherWorkItem],
        ['created_by_kind', 'system'],
        ['created_by_user_id', null],
        ['number', 999999],
        ['repo_id', null],
        ['id', randomUUID()],
        ['created_at', new Date()],
      ];
      for (const [column, value] of FORBIDDEN) {
        await expect(
          withTenant(appUserPool, refsA.accountId, (client) =>
            client.query(`UPDATE discussions SET ${column} = $1 WHERE id = $2`, [value, id]),
          ),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it("a discussion created 'external' cannot be flipped to 'internal' by app_user -- it still reads 'external' afterwards", async () => {
      const id = await seedDiscussion(refsA, { provenance: 'external' });
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query(`UPDATE discussions SET provenance = 'internal' WHERE id = $1`, [id]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const { rows } = await admin.query<{ provenance: string }>('SELECT provenance FROM discussions WHERE id = $1', [id]);
      expect(rows[0]!.provenance).toBe('external');
    });

    it('DELETE on discussions fails with 42501', async () => {
      const id = await seedDiscussion(refsA);
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) => client.query('DELETE FROM discussions WHERE id = $1', [id])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user column UPDATE grants on discussions are exactly title, kind, visibility, security, closed_at, deleted_at', async () => {
      const { rows } = await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.role_column_grants
         WHERE table_schema = 'public' AND table_name = 'discussions' AND grantee = 'app_user' AND privilege_type = 'UPDATE'`,
      );
      expect(new Set(rows.map((r) => r.column_name))).toEqual(
        new Set(['title', 'kind', 'visibility', 'security', 'closed_at', 'deleted_at']),
      );
    });
  });

  describe('discussion_counters cannot be lowered by the tenant (criterion 15, C3 S3)', () => {
    it('UPDATE is column-scoped to next_number and bytes_used; account_id fails 42501, DELETE fails 42501', async () => {
      await admin.query('INSERT INTO discussion_counters (account_id) VALUES ($1)', [refsA.accountId]);
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        await client.query('UPDATE discussion_counters SET next_number = 2 WHERE account_id = $1', [refsA.accountId]);
        await client.query('UPDATE discussion_counters SET bytes_used = 10 WHERE account_id = $1', [refsA.accountId]);
      });
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query('UPDATE discussion_counters SET account_id = $1 WHERE account_id = $1', [refsA.accountId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          client.query('DELETE FROM discussion_counters WHERE account_id = $1', [refsA.accountId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('a BEFORE UPDATE trigger rejects bytes_used or next_number decreasing; the row is unchanged', async () => {
      // The insert-defaults trigger branch requires next_number=1,
      // bytes_used=0 on INSERT -- raise both via an UPDATE first (an
      // always-legal increase), then attempt to lower them.
      await admin.query('INSERT INTO discussion_counters (account_id) VALUES ($1)', [refsB.accountId]);
      await admin.query('UPDATE discussion_counters SET next_number = 5, bytes_used = 100 WHERE account_id = $1', [
        refsB.accountId,
      ]);
      await expect(
        admin.query('UPDATE discussion_counters SET bytes_used = 0 WHERE account_id = $1', [refsB.accountId]),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(
        admin.query('UPDATE discussion_counters SET next_number = 1 WHERE account_id = $1', [refsB.accountId]),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      const { rows } = await admin.query<{ next_number: string; bytes_used: string }>(
        'SELECT next_number, bytes_used FROM discussion_counters WHERE account_id = $1',
        [refsB.accountId],
      );
      expect(rows[0]!.next_number).toBe('5');
      expect(rows[0]!.bytes_used).toBe('100');
    });

    it('an INSERT with bytes_used <> 0 or next_number <> 1 fails; raising either value on UPDATE succeeds', async () => {
      const otherRefs = await seedAccount(admin, randomUUID());
      const otherAccount = otherRefs.accountId;
      await expect(
        admin.query('INSERT INTO discussion_counters (account_id, bytes_used) VALUES ($1, 5)', [otherAccount]),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(
        admin.query('INSERT INTO discussion_counters (account_id, next_number) VALUES ($1, 2)', [otherAccount]),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });

      await admin.query('INSERT INTO discussion_counters (account_id) VALUES ($1)', [otherAccount]);
      await admin.query('UPDATE discussion_counters SET next_number = 10, bytes_used = 500 WHERE account_id = $1', [
        otherAccount,
      ]);
      const { rows } = await admin.query<{ next_number: string; bytes_used: string }>(
        'SELECT next_number, bytes_used FROM discussion_counters WHERE account_id = $1',
        [otherAccount],
      );
      expect(rows[0]!.next_number).toBe('10');
      expect(rows[0]!.bytes_used).toBe('500');
    });
  });

  describe('erasure (criterion 13, C3)', () => {
    it('app_user has no EXECUTE on erase_discussion_content: a call fails with 42501', async () => {
      const client = await appUserPool.connect();
      try {
        await expect(client.query('SELECT erase_discussion_content($1, $2)', [randomUUID(), 'x'])).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      } finally {
        client.release();
      }
    });

    it('pg_proc shows prosecdef = true, owner discussion_eraser, and a pinned search_path', async () => {
      const { rows } = await admin.query<{ prosecdef: boolean; proconfig: string[] | null; owner: string }>(
        `SELECT prosecdef, proconfig, pg_get_userbyid(proowner) AS owner
         FROM pg_proc WHERE proname = 'erase_discussion_content'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.prosecdef).toBe(true);
      expect(rows[0]!.owner).toBe('discussion_eraser');
      expect(rows[0]!.proconfig?.some((c) => c === 'search_path=pg_catalog, public, pg_temp')).toBe(true);
    });

    it('EXECUTE is granted to platform_ops and no other role except the owner (proacl)', async () => {
      const { rows } = await admin.query<{ grantees: string | null }>(
        `SELECT string_agg(DISTINCT COALESCE(pg_get_userbyid(a.grantee), 'PUBLIC'), ', ') AS grantees
         FROM pg_proc p, aclexplode(COALESCE(p.proacl, '{}'::aclitem[])) a
         WHERE p.proname = 'erase_discussion_content'
           AND a.grantee NOT IN (p.proowner, 'platform_ops'::regrole::oid)`,
      );
      expect(rows[0]!.grantees).toBeNull();

      const { rows: platformOpsGrant } = await admin.query<{ has_grant: boolean }>(
        `SELECT has_function_privilege('platform_ops', 'erase_discussion_content(uuid, text)', 'EXECUTE') AS has_grant`,
      );
      expect(platformOpsGrant[0]!.has_grant).toBe(true);
    });

    it('pg_roles shows discussion_eraser NOLOGIN, unprivileged, and NOBYPASSRLS', async () => {
      const { rows } = await admin.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = 'discussion_eraser'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.rolcanlogin).toBe(false);
      expect(rows[0]!.rolsuper).toBe(false);
      expect(rows[0]!.rolcreatedb).toBe(false);
      expect(rows[0]!.rolcreaterole).toBe(false);
      expect(rows[0]!.rolreplication).toBe(false);
      expect(rows[0]!.rolbypassrls).toBe(false);
    });

    it('discussion_eraser holds exactly the column grants C3 item 1 lists, and nothing else', async () => {
      const { rows } = await admin.query<{ table_name: string; privilege_type: string; column_name: string }>(
        `SELECT table_name, privilege_type, column_name FROM information_schema.role_column_grants
         WHERE table_schema = 'public' AND grantee = 'discussion_eraser'`,
      );
      const grouped = new Map<string, Set<string>>();
      for (const row of rows) {
        const key = `${row.table_name}.${row.privilege_type}`;
        if (!grouped.has(key)) grouped.set(key, new Set());
        grouped.get(key)!.add(row.column_name);
      }
      const actual: Record<string, string[]> = {};
      for (const [key, cols] of grouped) actual[key] = [...cols].sort();

      // Independently listed, matching C3 item 1 exactly -- not derived
      // from the migration's own GRANT statements.
      const expected: Record<string, string[]> = {
        'discussions.SELECT': ['account_id', 'id', 'root_work_item_id'],
        'discussion_revisions.SELECT': ['account_id', 'discussion_id'],
        'discussion_revisions.UPDATE': ['body', 'erased_at'],
        'discussion_comments.SELECT': ['account_id', 'discussion_id'],
        'discussion_comments.UPDATE': ['body', 'erased_at'],
        'spec_versions.SELECT': ['account_id', 'id', 'work_item_id'],
        'spec_versions.UPDATE': ['body', 'body_sha256', 'erased_at'],
        'spec_corrections.SELECT': ['account_id', 'spec_version_id'],
        'spec_corrections.UPDATE': ['body', 'erased_at'],
        'audit_log.INSERT': ['account_id', 'action', 'actor', 'payload'],
      };
      for (const key of Object.keys(actual)) actual[key] = actual[key]!.sort();
      expect(actual).toEqual(expected);
    });

    // Fix round 2 SF2: information_schema.role_column_grants only shows
    // column-scoped privileges, so a table-level DELETE, TRUNCATE or
    // TRIGGER grant -- never expressed as a column privilege -- would pass
    // the test above undetected. aclexplode over relacl and nspacl
    // enumerates every ACL entry directly, closing that gap.
    it('discussion_eraser holds no table-level or schema-level grant on any relation (aclexplode over relacl and nspacl)', async () => {
      // aclexplode() rejects an explicit '{}'::aclitem[] with "ACL arrays
      // must be one-dimensional" (an empty array literal has ndim = 0), so
      // relacl/nspacl are passed through unwrapped -- aclexplode(NULL) is
      // simply empty, which is exactly "no ACL entries" for a relation
      // that has never had an explicit GRANT.
      const { rows: tableGrants } = await admin.query<{ relname: string; privilege_type: string }>(
        `SELECT c.relname, a.privilege_type
         FROM pg_class c, aclexplode(c.relacl) a
         WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'discussion_eraser'::regrole::oid`,
      );
      expect(tableGrants).toEqual([]);

      const { rows: schemaGrants } = await admin.query<{ privilege_type: string }>(
        `SELECT a.privilege_type
         FROM pg_namespace n, aclexplode(n.nspacl) a
         WHERE n.nspname = 'public' AND a.grantee = 'discussion_eraser'::regrole::oid`,
      );
      expect(schemaGrants).toEqual([]);
    });

    it('SET ROLE discussion_eraser is unreachable: not a member for platform_ops, app_user, partner_user or exposure_writer', async () => {
      const { rows } = await admin.query<{ role: string; is_member: boolean }>(
        `SELECT role, pg_has_role(role, 'discussion_eraser', 'MEMBER') AS is_member
         FROM unnest(ARRAY['platform_ops', 'app_user', 'partner_user', 'exposure_writer']) AS role`,
      );
      for (const row of rows) expect(row.is_member).toBe(false);

      const platformOpsClient = await platformOpsPool.connect();
      try {
        await expect(platformOpsClient.query('SET ROLE discussion_eraser')).rejects.toBeTruthy();
      } finally {
        platformOpsClient.release();
      }
      const appUserClient = await appUserPool.connect();
      try {
        await expect(appUserClient.query('SET ROLE discussion_eraser')).rejects.toBeTruthy();
      } finally {
        appUserClient.release();
      }
    });

    it('calling with a NULL, empty or whitespace-only reason raises an error; no row changes, no audit row', async () => {
      const discussionId = await seedDiscussion(refsA);
      await admin.query(
        `INSERT INTO discussion_revisions (account_id, discussion_id, rev, body, author_kind) VALUES ($1, $2, 1, 'untouched', 'user')`,
        [refsA.accountId, discussionId],
      );
      const { rows: before } = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log WHERE action = 'discussion.erase' AND account_id = $1`,
        [refsA.accountId],
      );
      // Fix round 2 MF1: btrim() only strips the space character, so a
      // tab-only, newline-only, or mixed-whitespace reason previously slid
      // past the check -- these three cases fail on b17b457.
      for (const badReason of [null, '', '   ', '\t', '\n', ' \t\r\n ']) {
        const client = await platformOpsPool.connect();
        try {
          await expect(
            client.query('SELECT erase_discussion_content($1, $2)', [discussionId, badReason]),
          ).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
        } finally {
          client.release();
        }
      }
      const { rows: revisions } = await admin.query<{ body: string }>(
        'SELECT body FROM discussion_revisions WHERE discussion_id = $1',
        [discussionId],
      );
      expect(revisions[0]!.body).toBe('untouched');
      const { rows: after } = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log WHERE action = 'discussion.erase' AND account_id = $1`,
        [refsA.accountId],
      );
      expect(after[0]!.n).toBe(before[0]!.n);
    });

    it("called by platform_ops: erases the discussion's revisions/comments and its root work item's Spec versions/corrections, stamps erased_at, keeps body_sha256 correct, and writes exactly one audit_log row whose actor is the calling login role", async () => {
      const discussionId = await seedDiscussion(refsA);
      await admin.query(
        `INSERT INTO discussion_revisions (account_id, discussion_id, rev, body, author_kind) VALUES ($1, $2, 1, 'secret revision', 'user')`,
        [refsA.accountId, discussionId],
      );
      const commentId = await seedComment(refsA, discussionId);
      const specVersionId = await seedSpecVersion(refsA, 'secret spec body');
      const correctionId = randomUUID();
      await admin.query(
        `INSERT INTO spec_corrections (id, account_id, spec_version_id, code, body, created_by_kind)
         VALUES ($1, $2, $3, 'C1', 'secret correction', 'user')`,
        [correctionId, refsA.accountId, specVersionId],
      );

      const { rows: beforeAudit } = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log WHERE action = 'discussion.erase' AND account_id = $1`,
        [refsA.accountId],
      );

      // Fix round 2 MF2: connecting AS platform_ops itself makes
      // session_user literally 'platform_ops', which cannot distinguish
      // the correct `actor = session_user` from a mutation that hardcodes
      // the literal 'platform_ops' -- both would produce the same value.
      // A distinct LOGIN role that only inherits platform_ops' grants
      // closes that gap: the expected actor is the role's own name.
      const opsTestRole = `ops_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await admin.query(`CREATE ROLE ${opsTestRole} LOGIN IN ROLE platform_ops`);
      const opsTestUrl = new URL(process.env.DATABASE_URL_PLATFORM_OPS!);
      opsTestUrl.username = opsTestRole;
      const opsTestPool = createPool(opsTestUrl.toString());
      const expectedActor = opsTestRole;
      try {
        const client = await opsTestPool.connect();
        try {
          await client.query('SELECT erase_discussion_content($1, $2)', [discussionId, 'gdpr request']);
        } finally {
          client.release();
        }
      } finally {
        await opsTestPool.end();
        await admin.query(`DROP ROLE ${opsTestRole}`);
      }

      const { rows: revisions } = await admin.query<{ body: string; erased_at: Date | null }>(
        'SELECT body, erased_at FROM discussion_revisions WHERE discussion_id = $1',
        [discussionId],
      );
      expect(revisions[0]!.body).toBe('[erased]');
      expect(revisions[0]!.erased_at).not.toBeNull();

      const { rows: comments } = await admin.query<{ body: string; erased_at: Date | null }>(
        'SELECT body, erased_at FROM discussion_comments WHERE id = $1',
        [commentId],
      );
      expect(comments[0]!.body).toBe('[erased]');
      expect(comments[0]!.erased_at).not.toBeNull();

      const { rows: specVersions } = await admin.query<{ body: string; body_sha256: string; erased_at: Date | null }>(
        'SELECT body, body_sha256, erased_at FROM spec_versions WHERE id = $1',
        [specVersionId],
      );
      expect(specVersions[0]!.body).toBe('[erased]');
      expect(specVersions[0]!.body_sha256).toBe(createHash('sha256').update('[erased]', 'utf8').digest('hex'));
      expect(specVersions[0]!.erased_at).not.toBeNull();

      const { rows: corrections } = await admin.query<{ body: string; erased_at: Date | null }>(
        'SELECT body, erased_at FROM spec_corrections WHERE id = $1',
        [correctionId],
      );
      expect(corrections[0]!.body).toBe('[erased]');
      expect(corrections[0]!.erased_at).not.toBeNull();

      const { rows: afterAudit } = await admin.query<{
        account_id: string;
        actor: string;
        action: string;
        payload: { reason: string };
      }>(
        `SELECT account_id, actor, action, payload FROM audit_log WHERE action = 'discussion.erase' AND account_id = $1 ORDER BY created_at`,
        [refsA.accountId],
      );
      expect(afterAudit).toHaveLength(Number(beforeAudit[0]!.n) + 1);
      const newest = afterAudit[afterAudit.length - 1]!;
      expect(newest.payload.reason).toBe('gdpr request');
      expect(newest.actor).toBe(expectedActor);
    });

    it("cross-tenant: erasing A's discussion never touches B's revisions, comments or spec content", async () => {
      const discussionA = await seedDiscussion(refsA);
      await admin.query(
        `INSERT INTO discussion_revisions (account_id, discussion_id, rev, body, author_kind) VALUES ($1, $2, 1, 'a body', 'user')`,
        [refsA.accountId, discussionA],
      );
      const commentB_discussion = await seedDiscussion(refsB);
      const commentB = await seedComment(refsB, commentB_discussion);
      await admin.query(
        `INSERT INTO discussion_revisions (account_id, discussion_id, rev, body, author_kind) VALUES ($1, $2, 1, 'b body', 'user')`,
        [refsB.accountId, commentB_discussion],
      );
      const specVersionB = await seedSpecVersion(refsB, 'b spec body');

      const client = await platformOpsPool.connect();
      try {
        await client.query('SELECT erase_discussion_content($1, $2)', [discussionA, 'test']);
      } finally {
        client.release();
      }

      const { rows: bComment } = await admin.query<{ body: string; erased_at: Date | null }>(
        'SELECT body, erased_at FROM discussion_comments WHERE id = $1',
        [commentB],
      );
      expect(bComment[0]!.body).toBe('original');
      expect(bComment[0]!.erased_at).toBeNull();

      const { rows: bRevision } = await admin.query<{ body: string; erased_at: Date | null }>(
        'SELECT body, erased_at FROM discussion_revisions WHERE discussion_id = $1',
        [commentB_discussion],
      );
      expect(bRevision[0]!.body).toBe('b body');
      expect(bRevision[0]!.erased_at).toBeNull();

      const { rows: bSpec } = await admin.query<{ body: string; erased_at: Date | null }>(
        'SELECT body, erased_at FROM spec_versions WHERE id = $1',
        [specVersionB],
      );
      expect(bSpec[0]!.body).toBe('b spec body');
      expect(bSpec[0]!.erased_at).toBeNull();
    });
  });

  describe('platform_ops has no privilege on the 7 tables in any state (criterion 16, C3 S4)', () => {
    const TABLES = [
      'discussion_counters',
      'discussions',
      'discussion_revisions',
      'discussion_comments',
      'spec_versions',
      'spec_corrections',
      'work_item_deps',
    ];

    // Any error inside a transaction aborts it (25P02) until ROLLBACK, so
    // asserting 42501 on a SECOND query in the same open transaction would
    // otherwise just observe the abort, not the real cause. SAVEPOINT
    // around each check keeps the outer transaction alive across all 7
    // tables. Used for states (b)/(d)/(f), which deliberately probe from
    // inside one open transaction; (a)/(c)/(e) run outside any explicit
    // transaction (autocommit), so each query is independent already.
    async function expectAllDenied(client: PoolClient) {
      for (const table of TABLES) {
        await expect(client.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      }
    }

    async function expectAllDeniedInTransaction(client: PoolClient) {
      for (const table of TABLES) {
        await client.query('SAVEPOINT probe');
        await expect(client.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
        await client.query('ROLLBACK TO SAVEPOINT probe');
      }
    }

    it('(a) no GUC set', async () => {
      const client = await platformOpsPool.connect();
      try {
        await expectAllDenied(client);
      } finally {
        client.release();
      }
    });

    it("(b) after SET LOCAL app.discussion_erasure_active = 'true' inside a transaction", async () => {
      const client = await platformOpsPool.connect();
      try {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL app.discussion_erasure_active = 'true'`);
          await expectAllDeniedInTransaction(client);
        } finally {
          await client.query('ROLLBACK');
        }
      } finally {
        client.release();
      }
    });

    it("(c) after session-level SET app.discussion_erasure_active = 'true'", async () => {
      const client = await platformOpsPool.connect();
      try {
        await client.query(`SET app.discussion_erasure_active = 'true'`);
        await expectAllDenied(client);
      } finally {
        client.release();
      }
    });

    it("(d) after set_config('app.discussion_erasure_active', 'true', true)", async () => {
      const client = await platformOpsPool.connect();
      try {
        await client.query('BEGIN');
        try {
          await client.query(`SELECT set_config('app.discussion_erasure_active', 'true', true)`);
          await expectAllDeniedInTransaction(client);
        } finally {
          await client.query('ROLLBACK');
        }
      } finally {
        client.release();
      }
    });

    it("(e) connected with PGOPTIONS='-c app.discussion_erasure_active=true'", async () => {
      const optionsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!, {
        options: '-c app.discussion_erasure_active=true',
      });
      try {
        const client = await optionsPool.connect();
        try {
          await expectAllDenied(client);
        } finally {
          client.release();
        }
      } finally {
        await optionsPool.end();
      }
    });

    it('(f) in the same transaction, right after a successful erase_discussion_content call', async () => {
      const discussionId = await seedDiscussion(refsA);
      const client = await platformOpsPool.connect();
      try {
        await client.query('BEGIN');
        try {
          await client.query('SELECT erase_discussion_content($1, $2)', [discussionId, 'post-erase probe']);
          await expectAllDeniedInTransaction(client);
        } finally {
          await client.query('ROLLBACK');
        }
      } finally {
        client.release();
      }
    });

    it('UPDATE discussion_comments SET body = tampered as platform_ops fails with 42501', async () => {
      const discussionId = await seedDiscussion(refsA);
      const commentId = await seedComment(refsA, discussionId);
      const client = await platformOpsPool.connect();
      try {
        await expect(
          client.query(`UPDATE discussion_comments SET body = 'tampered' WHERE id = $1`, [commentId]),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      } finally {
        client.release();
      }
    });
  });
});
