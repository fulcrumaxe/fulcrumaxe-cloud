import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { getCurrentDialSetting, listDialHistory } from '../src/decisions.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
}

describe('decision_settings / decision_receipts schema (DP2 items 1, 3, 7)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  it('decision_settings has exactly the column shape from DP2 item 1', async () => {
    const { rows } = await admin.query<ColumnRow>(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'decision_settings'
      ORDER BY column_name
    `);
    const byName = new Map(rows.map((r) => [r.column_name, r]));
    expect(byName.get('id')?.data_type).toBe('uuid');
    expect(byName.get('account_id')?.data_type).toBe('uuid');
    expect(byName.get('repo_id')?.data_type).toBe('uuid');
    expect(byName.get('decision_type')?.data_type).toBe('text');
    expect(byName.get('disposition')?.data_type).toBe('text');
    expect(byName.get('preset')?.data_type).toBe('text');
    expect(byName.get('preset')?.is_nullable).toBe('YES');
    expect(byName.get('version')?.data_type).toBe('integer');
    expect(byName.get('changed_by')?.data_type).toBe('uuid');
    expect(byName.get('created_at')?.data_type).toBe('timestamp with time zone');
    expect(rows.map((r) => r.column_name).sort()).toEqual(
      [
        'account_id',
        'changed_by',
        'created_at',
        'decision_type',
        'disposition',
        'id',
        'preset',
        'repo_id',
        'version',
      ].sort(),
    );
  });

  it('decision_receipts has exactly the column shape from DP2 item 3, and run_id is nullable', async () => {
    const { rows } = await admin.query<ColumnRow>(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'decision_receipts'
      ORDER BY column_name
    `);
    const byName = new Map(rows.map((r) => [r.column_name, r]));
    expect(byName.get('id')?.data_type).toBe('uuid');
    expect(byName.get('account_id')?.data_type).toBe('uuid');
    expect(byName.get('run_id')?.data_type).toBe('uuid');
    expect(byName.get('run_id')?.is_nullable).toBe('YES');
    expect(byName.get('work_item_id')?.data_type).toBe('uuid');
    expect(byName.get('decision_type')?.data_type).toBe('text');
    expect(byName.get('class')?.data_type).toBe('text');
    expect(byName.get('chosen')?.data_type).toBe('text');
    expect(byName.get('rejected_alternative')?.data_type).toBe('text');
    expect(byName.get('dial_version')?.data_type).toBe('integer');
    expect(byName.get('input_trust_classes')?.data_type).toBe('jsonb');
    expect(byName.get('actor')?.data_type).toBe('text');
    expect(byName.get('reversal_state')?.data_type).toBe('text');
    expect(byName.get('created_at')?.data_type).toBe('timestamp with time zone');
    expect(rows.map((r) => r.column_name).sort()).toEqual(
      [
        'account_id',
        'actor',
        'catalogue_version',
        'chosen',
        'class',
        'created_at',
        'decision_type',
        'dial_version',
        'id',
        'input_trust_classes',
        'rejected_alternative',
        'reversal_state',
        'run_id',
        'work_item_id',
      ].sort(),
    );
  });

  it('class rejects a value outside the DP-OD2 taxonomy', async () => {
    await expect(
      admin.query(
        `INSERT INTO decision_receipts (account_id, decision_type, class) VALUES ($1, 'merge.fast-path', 'not_a_real_class')`,
        [refs.accountId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  /**
   * Fix round 3 (D#7 DP2, security review needs-fix on PR #54, SUGGESTION
   * item 7): disposition and decision_type used to be unconstrained text,
   * so the resolver had to fail closed on unknown values entirely on its
   * own. disposition now has a DP-C1 CHECK
   * (discussioncomment-18500837: ask | announce | act), and decision_type
   * on both tables now rejects the empty string.
   */
  describe('disposition and decision_type CHECKs (fix round 3, SUGGESTION item 7)', () => {
    it('decision_settings.disposition rejects a value outside ask/announce/act', async () => {
      await expect(
        admin.query(
          `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by)
           VALUES ($1, $2, 'merge.fast-path', 'yolo', 1, $3)`,
          [refs.accountId, refs.repoId, refs.userId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it.each(['ask', 'announce', 'act'])('decision_settings.disposition accepts %s', async (disposition) => {
      const decisionType = `check-accept-${disposition}`;
      await expect(
        admin.query(
          `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by)
           VALUES ($1, $2, $3, $4, 1, $5)`,
          [refs.accountId, refs.repoId, decisionType, disposition, refs.userId],
        ),
      ).resolves.toBeDefined();
    });

    it('decision_settings.decision_type rejects the empty string', async () => {
      await expect(
        admin.query(
          `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by)
           VALUES ($1, $2, '', 'ask', 1, $3)`,
          [refs.accountId, refs.repoId, refs.userId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('decision_receipts.decision_type rejects the empty string', async () => {
      await expect(
        admin.query(
          `INSERT INTO decision_receipts (account_id, decision_type, class) VALUES ($1, '', 'human_in_the_loop')`,
          [refs.accountId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });

  it('rows are history, not state: a second version does not replace the first (DP2 item 1)', async () => {
    await admin.query(
      `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by)
       VALUES ($1, $2, 'merge.fast-path', 'ask', 1, $3)`,
      [refs.accountId, refs.repoId, refs.userId],
    );
    await admin.query(
      `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by)
       VALUES ($1, $2, 'merge.fast-path', 'act', 2, $3)`,
      [refs.accountId, refs.repoId, refs.userId],
    );

    const history = await listDialHistory(admin, refs.repoId, 'merge.fast-path');
    expect(history.map((h) => h.version)).toEqual([1, 2]);
    expect(history.map((h) => h.disposition)).toEqual(['ask', 'act']);

    const current = await getCurrentDialSetting(admin, refs.repoId, 'merge.fast-path');
    expect(current?.version).toBe(2);
    expect(current?.disposition).toBe('act');
  });

  it('deleting the referenced agent_runs row leaves the receipt present, with run_id set to null (DP2 item 3, C5)', async () => {
    await admin.query(
      `INSERT INTO decision_receipts (account_id, run_id, work_item_id, decision_type, class)
       VALUES ($1, $2, $3, 'merge.fast-path', 'human_over_the_loop')`,
      [refs.accountId, refs.runId, refs.workItemId],
    );

    await admin.query(`DELETE FROM agent_runs WHERE id = $1`, [refs.runId]);

    const { rows } = await admin.query<{ run_id: string | null; account_id: string }>(
      `SELECT run_id, account_id FROM decision_receipts WHERE account_id = $1 AND work_item_id = $2`,
      [refs.accountId, refs.workItemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].run_id).toBeNull();
    expect(rows[0].account_id).toBe(refs.accountId);
  });

  it('migration is additive only: earlier migrations are byte-for-byte unmodified (DP2 item 7)', () => {
    // Hashes computed from this branch's copy of each file, before this
    // PR's only change (adding 0400_decisions.sql) was made -- confirms
    // this migration never touched them. The Spec's own shorthand
    // ("0001-0003", "D#4's 02xx", "D#5's 03xx") doesn't match this repo's
    // real filenames: D#4 shipped as 0100_sitekit.sql and D#5 as
    // 0200_partners.sql (both hashed below, per the executor brief's
    // instruction to assert the files that actually exist and say so in
    // the PR). 0004_account_members_platform_ops_grant.sql also predates
    // this migration and is included for the same reason. No 03xx-prefixed
    // migration exists in this repo yet.
    // D#81 decision 5 (Correction C1): 0001_core.sql/0200_partners.sql hashes below are the post-fix values, a scoped exception to this same check for those two files only.
    // D#81 fix round (security review MUST-FIX): 0200_partners.sql's hash
    // below is updated again -- the REVOKE CREATE ON SCHEMA public FROM
    // platform_ops fix (see that file's own comment for why it sits after
    // the LAST OWNER TO platform_ops statement, not next to the INHERIT
    // downgrade) is one more in-place edit to this same already-applied
    // file, under the same scoped exception.
    // D#81 fix round 3 (code re-review MUST-FIX): 0200_partners.sql's hash
    // below is updated once more -- its one cross-reference to the
    // migration renamed 0012 -> 0601 (D#94 R1) had to move with it, one
    // more in-place edit under the same scoped exception.
    const expected: Record<string, string> = {
      '0001_core.sql': 'adce1250d847b82e9b21114444426568eb8c05fa6791f16c6484af1acc182384',
      '0002_spend_fns.sql': '9a1cd916976042c396340f79164e84207bfac53c698d0e573ac1442b8c86cce6',
      '0003_spend_security_fixes.sql':
        '5276dd736dbc0d5b52e15c752960b6874ad6f42b996ba510ea56a601073da346',
      '0004_account_members_platform_ops_grant.sql':
        '0beb9acd549b709977b3dfb5e851370d278f0ddf0d26c6ac2a6a6d85432803d3',
      '0100_sitekit.sql': '4d2a69f06e030d9ba0456cad4a31b44f30b8e1c45081572d205d79a643e11e56',
      '0200_partners.sql': 'e09d9eb26387e15d6a04370ff68b7bf38f1ba707fa83d900c63cfe04762290d9',
    };

    for (const [filename, expectedHash] of Object.entries(expected)) {
      const bytes = readFileSync(path.join(MIGRATIONS_DIR, filename));
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      expect(actualHash, `${filename} must be byte-for-byte unmodified`).toBe(expectedHash);
    }

    const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles).toContain('0400_decisions.sql');
    expect(sqlFiles.some((f) => /^03\d\d_/.test(f))).toBe(false);
  });
});
