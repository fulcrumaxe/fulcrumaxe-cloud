import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#71 DS-1 criteria 1, 4, 7, 8, 9, 10, 11, 12: the 7 new tables' columns,
 * CHECK constraints, composite FKs and UNIQUE constraints, plus the new
 * work_items/agent_runs columns.
 */
describe('discussions schema (D#71 DS-1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let refsA: SeedRefs;
  let refsB: SeedRefs;
  let discussionA: string;
  let specVersionA: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
    discussionA = await seedDiscussion(refsA);
    specVersionA = await seedSpecVersion(refsA);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  async function seedDiscussion(refs: SeedRefs, overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
    const id = randomUUID();
    const p = {
      id,
      account_id: refs.accountId,
      number: Math.floor(Math.random() * 1_000_000_000) + 1,
      kind: 'feature',
      title: 'a discussion',
      visibility: 'private',
      security: false,
      root_work_item_id: refs.workItemId,
      provenance: 'internal',
      created_by_kind: 'user',
      ...overrides,
    };
    await admin.query(
      `INSERT INTO discussions
         (id, account_id, number, kind, title, visibility, security, root_work_item_id, provenance, created_by_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [p.id, p.account_id, p.number, p.kind, p.title, p.visibility, p.security, p.root_work_item_id, p.provenance, p.created_by_kind],
    );
    return id;
  }

  async function seedSpecVersion(refs: SeedRefs, overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
    const id = randomUUID();
    const body = (overrides.body as string) ?? 'spec body';
    const p = {
      account_id: refs.accountId,
      work_item_id: refs.workItemId,
      version: 1,
      body,
      body_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      created_by_kind: 'user',
      ...overrides,
      id,
    };
    await admin.query(
      `INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, created_by_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [p.id, p.account_id, p.work_item_id, p.version, p.body, p.body_sha256, p.created_by_kind],
    );
    return id;
  }

  describe('table shapes (criterion 1)', () => {
    const EXPECTED_COLUMNS: Record<string, string[]> = {
      discussion_counters: ['account_id', 'next_number', 'bytes_used'],
      discussions: [
        'id', 'account_id', 'number', 'repo_id', 'kind', 'title', 'visibility', 'security',
        'root_work_item_id', 'provenance', 'created_by_kind', 'created_by_user_id', 'created_at',
        'closed_at', 'deleted_at', 'source_event_id',
      ],
      discussion_revisions: [
        'account_id', 'discussion_id', 'rev', 'body', 'author_kind', 'author_user_id',
        'agent_run_id', 'erased_at', 'created_at',
      ],
      discussion_comments: [
        'id', 'account_id', 'discussion_id', 'reply_to_id', 'author_kind', 'author_user_id',
        'author_gh_login', 'role', 'agent_run_id', 'body', 'provenance', 'origin', 'mirror',
        'created_at', 'edited_at', 'deleted_at', 'erased_at', 'system_signed',
      ],
      spec_versions: [
        'id', 'account_id', 'work_item_id', 'version', 'body', 'body_sha256', 'frontmatter',
        'source_path', 'source_sha', 'created_by_kind', 'created_by_user_id', 'erased_at', 'created_at',
      ],
      spec_corrections: [
        'id', 'account_id', 'spec_version_id', 'code', 'body', 'applies_to', 'created_by_kind',
        'created_by_user_id', 'erased_at', 'created_at',
      ],
      work_item_deps: ['account_id', 'work_item_id', 'depends_on_id', 'created_at'],
    };

    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      it(`${table} has exactly the Spec columns`, async () => {
        const { rows } = await admin.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
          [table],
        );
        expect(new Set(rows.map((r) => r.column_name))).toEqual(new Set(columns));
      });
    }

    it('work_items gains discussion_id, parent_id, title', async () => {
      const { rows } = await admin.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'work_items'
           AND column_name IN ('discussion_id', 'parent_id', 'title')`,
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row.is_nullable).toBe('YES');
    });

    it('agent_runs gains spec_version_id', async () => {
      const { rows } = await admin.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'agent_runs' AND column_name = 'spec_version_id'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.is_nullable).toBe('YES');
    });
  });

  // Code-review must-fix (PR #148 head e0d9791): "every new table with an
  // id column has UNIQUE (account_id, id)" was a stated Spec rule that no
  // test caught missing on spec_corrections -- the "table shapes" test
  // above only diffs column names via information_schema.columns, never
  // constraints. This block checks pg_constraint directly, independent of
  // the migration's own UNIQUE index naming, so a future table that adds
  // an id column without this constraint fails here too.
  describe('UNIQUE (account_id, id) on every table with an id column (code review must-fix)', () => {
    const TABLES_WITH_ID = ['discussions', 'discussion_comments', 'spec_versions', 'spec_corrections'];

    for (const table of TABLES_WITH_ID) {
      it(`${table} has a UNIQUE constraint on exactly (account_id, id)`, async () => {
        const { rows } = await admin.query<{ conname: string; cols: string[] }>(
          `SELECT c.conname, array_agg(a.attname::text ORDER BY u.ord) AS cols
           FROM pg_constraint c
           JOIN unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
           WHERE c.conrelid = $1::regclass AND c.contype = 'u'
           GROUP BY c.conname
           HAVING array_agg(a.attname::text ORDER BY u.ord) = ARRAY['account_id', 'id']`,
          [table],
        );
        expect(rows).toHaveLength(1);
      });
    }

    // Fix round 2 (suggestion folded into should-fix): a duplicate-insert
    // test using the same `id` twice can never isolate this constraint --
    // `id` is already a primary key on its own, so that insert always hits
    // 23505 via the PK first, with or without UNIQUE (account_id, id). The
    // catalog test above, which reads pg_constraint directly, is the real
    // guard; a same-id duplicate-insert test proves nothing beyond it.
  });

  describe('CHECK constraints', () => {
    it('criterion 7: spec_versions.body_sha256 must equal sha256(body); a mismatch fails, a match succeeds', async () => {
      await expect(
        admin.query(
          `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind)
           VALUES ($1, $2, 2, 'x', 'not-the-real-hash', 'user')`,
          [refsA.accountId, refsA.workItemId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      const id = await seedSpecVersion(refsA, { version: 3, body: 'matching body' });
      const { rows } = await admin.query('SELECT id FROM spec_versions WHERE id = $1', [id]);
      expect(rows).toHaveLength(1);
    });

    it('criterion 8: discussions security=true with visibility<>private fails; security=true with private succeeds', async () => {
      await expect(seedDiscussion(refsA, { security: true, visibility: 'public' })).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });
      const id = await seedDiscussion(refsA, { security: true, visibility: 'private' });
      const { rows } = await admin.query('SELECT id FROM discussions WHERE id = $1', [id]);
      expect(rows).toHaveLength(1);
    });

    it('criterion 9: provenance vocabulary is exactly internal/external on discussions and discussion_comments', async () => {
      await expect(seedDiscussion(refsA, { provenance: 'trusted' })).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });
      for (const value of ['internal', 'external']) {
        const id = await seedDiscussion(refsA, { provenance: value });
        const { rows } = await admin.query('SELECT id FROM discussions WHERE id = $1', [id]);
        expect(rows).toHaveLength(1);
      }
      await expect(
        admin.query(
          `INSERT INTO discussion_comments (account_id, discussion_id, author_kind, body, provenance, origin)
           VALUES ($1, $2, 'user', 'x', 'trusted', 'fx')`,
          [refsA.accountId, discussionA],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      for (const value of ['internal', 'external']) {
        await admin.query(
          `INSERT INTO discussion_comments (account_id, discussion_id, author_kind, body, provenance, origin)
           VALUES ($1, $2, 'user', 'x', $3, 'fx')`,
          [refsA.accountId, discussionA, value],
        );
      }
    });

    it('criterion 11: work_item_deps rejects work_item_id = depends_on_id', async () => {
      await expect(
        admin.query('INSERT INTO work_item_deps (account_id, work_item_id, depends_on_id) VALUES ($1, $2, $2)', [
          refsA.accountId,
          refsA.workItemId,
        ]),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('criterion 12: spec_corrections.code accepts C1/C17, rejects C0/c7/X1/C; a duplicate (spec_version_id, code) fails unique', async () => {
      for (const bad of ['C0', 'c7', 'X1', 'C']) {
        await expect(
          admin.query(
            `INSERT INTO spec_corrections (account_id, spec_version_id, code, body, created_by_kind)
             VALUES ($1, $2, $3, 'x', 'user')`,
            [refsA.accountId, specVersionA, bad],
          ),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      for (const good of ['C1', 'C17']) {
        await admin.query(
          `INSERT INTO spec_corrections (account_id, spec_version_id, code, body, created_by_kind)
           VALUES ($1, $2, $3, 'x', 'user')`,
          [refsA.accountId, specVersionA, good],
        );
      }
      await expect(
        admin.query(
          `INSERT INTO spec_corrections (account_id, spec_version_id, code, body, created_by_kind)
           VALUES ($1, $2, 'C1', 'dup', 'user')`,
          [refsA.accountId, specVersionA],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });

    it('criterion 10: two accounts can each hold discussion number 1; a second number-1 in the same account fails', async () => {
      const a = await seedDiscussion(refsA, { number: 1 });
      const b = await seedDiscussion(refsB, { number: 1 });
      const { rows } = await admin.query('SELECT id FROM discussions WHERE id IN ($1, $2)', [a, b]);
      expect(rows).toHaveLength(2);
      await expect(seedDiscussion(refsA, { number: 1 })).rejects.toMatchObject({
        code: PG_ERROR.UNIQUE_VIOLATION,
      });
    });
  });

  describe('composite FK cross-tenant rejection (criterion 4)', () => {
    it("discussion_comments naming A's discussion from B's account fails 23503", async () => {
      await expect(
        admin.query(
          `INSERT INTO discussion_comments (account_id, discussion_id, author_kind, body, provenance, origin)
           VALUES ($1, $2, 'user', 'x', 'internal', 'fx')`,
          [refsB.accountId, discussionA],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it("spec_versions naming A's work item from B's account fails 23503", async () => {
      await expect(
        admin.query(
          `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind)
           VALUES ($1, $2, 1, 'x', $3, 'user')`,
          [refsB.accountId, refsA.workItemId, createHash('sha256').update('x', 'utf8').digest('hex')],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it("work_item_deps naming A's work item from B's account fails 23503", async () => {
      await expect(
        admin.query('INSERT INTO work_item_deps (account_id, work_item_id, depends_on_id) VALUES ($1, $2, $3)', [
          refsB.accountId,
          refsA.workItemId,
          refsB.workItemId,
        ]),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it("work_items.parent_id naming A's work item from B's account fails 23503", async () => {
      await expect(
        admin.query('UPDATE work_items SET parent_id = $1 WHERE id = $2', [refsA.workItemId, refsB.workItemId]),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it("agent_runs.spec_version_id naming A's Spec version from B's account fails 23503", async () => {
      // Set at INSERT: 0642 froze spec_version_id after insert for every role,
      // so the old UPDATE form of this probe is now refused earlier (42501).
      await expect(
        admin.query(
          `INSERT INTO agent_runs (account_id, role, runtime, status, spec_version_id)
           VALUES ($1, 'code-reviewer', 'local', 'pending', $2)`,
          [refsB.accountId, specVersionA],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });
  });
});
