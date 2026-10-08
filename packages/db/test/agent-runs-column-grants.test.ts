import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#575 (migration 0756): app_user reads agent_runs through an explicit column
 * list. The list is AGENT_RUN_COLUMNS in packages/core/src/tenancy/
 * scopedAccess.ts -- the one list the routes, the grant and the source scan
 * (scripts/check-agent-run-columns.sh) all follow. @fx/db cannot import @fx/core
 * (core depends on db), so this test reads that file's source for the array.
 *
 * Two columns the outside-meter work adds (the report tag and the key
 * reference) are the reason for the grant. Until that migration is on main they
 * do not exist, so the "database refuses them" assertions add them as probe
 * columns INSIDE a transaction that is always rolled back: the privilege rule
 * under test (a column that is not listed is ungranted, whoever added it) is
 * exercised today, and once the real columns exist the same assertions run
 * against them.
 */
const SECRET_COLUMNS = ['gateway_report_tag', 'om_key_ref'] as const;

const SCOPED_ACCESS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'core',
  'src',
  'tenancy',
  'scopedAccess.ts',
);

function readAgentRunColumns(): string[] {
  const src = readFileSync(SCOPED_ACCESS, 'utf8');
  const m = /export const AGENT_RUN_COLUMNS\s*=\s*`([^`]*)`/.exec(src);
  if (!m) throw new Error(`AGENT_RUN_COLUMNS (a template string of column names) not found in ${SCOPED_ACCESS}`);
  return m[1]!
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

describe('agent_runs: app_user SELECT is the AGENT_RUN_COLUMNS list (D#575)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  const listed = readAgentRunColumns();

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

  /**
   * Runs `sql` as app_user inside a transaction that adds the two secret columns
   * when they are not there yet and is ALWAYS rolled back. Resolves to the
   * SQLSTATE of the failure, or 'ok'.
   */
  async function asAppUserWithSecretColumns(sql: string): Promise<string> {
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      for (const col of SECRET_COLUMNS) {
        await c.query(`ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS ${col} text`);
      }
      await c.query('SET LOCAL ROLE app_user');
      try {
        await c.query(sql);
        return 'ok';
      } catch (e) {
        return (e as { code?: string }).code ?? 'no-code';
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('criterion 1: each secret column and a star select fail with 42501', async () => {
    for (const col of SECRET_COLUMNS) {
      expect(await asAppUserWithSecretColumns(`SELECT ${col} FROM agent_runs LIMIT 1`), col).toBe(
        PG_ERROR.INSUFFICIENT_PRIVILEGE,
      );
    }
    expect(await asAppUserWithSecretColumns('SELECT * FROM agent_runs /* agent-run-columns: allow expected to fail */')).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(await asAppUserWithSecretColumns('SELECT r.* FROM agent_runs r /* agent-run-columns: allow expected to fail */')).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
    expect(
      await asAppUserWithSecretColumns('SELECT w.id, r.* FROM work_items w JOIN agent_runs r ON r.work_item_id = w.id /* agent-run-columns: allow expected to fail */'),
    ).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
  });

  it('criterion 1: when the real secret columns exist they are ungranted to app_user', async () => {
    const { rows } = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agent_runs' AND column_name = ANY($1)`,
      [SECRET_COLUMNS],
    );
    for (const { column_name } of rows) {
      const { rows: priv } = await admin.query<{ ok: boolean }>(
        `SELECT has_column_privilege('app_user', 'public.agent_runs', $1, 'SELECT') AS ok`,
        [column_name],
      );
      expect(priv[0]!.ok, column_name).toBe(false);
    }
  });

  it('criterion 2: every listed column is selectable and RLS still scopes rows to the account', async () => {
    const rows = await withTenant(appUserPool, a.accountId, async (client) => {
      const r = await client.query<{ id: string; account_id: string }>(
        `SELECT ${listed.join(', ')} FROM agent_runs`,
      );
      return r.rows;
    });
    expect(rows.map((r) => r.id)).toContain(a.runId);
    expect(rows.map((r) => r.id)).not.toContain(b.runId);
    expect(new Set(rows.map((r) => r.account_id))).toEqual(new Set([a.accountId]));
  });

  it('criterion 2: UPDATE of a metering column with a WHERE and RETURNING still works for app_user', async () => {
    const rows = await withTenant(appUserPool, a.accountId, async (client) => {
      const r = await client.query<{ id: string; tokens_in: string }>(
        `UPDATE agent_runs SET tokens_in = 7 WHERE id = $1 RETURNING id, tokens_in`,
        [a.runId],
      );
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.tokens_in)).toBe(7);
  });

  it('criterion 3: the columns app_user may SELECT are exactly AGENT_RUN_COLUMNS', async () => {
    const { rows } = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agent_runs'`,
    );
    const tableColumns = rows.map((r) => r.column_name);
    const { rows: granted } = await admin.query<{ column_name: string }>(
      `SELECT DISTINCT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'agent_runs'
          AND grantee = 'app_user' AND privilege_type = 'SELECT'`,
    );
    const grantedSet = new Set(granted.map((r) => r.column_name));
    // The effective privilege (covers PUBLIC and role membership too).
    const effective = new Set<string>();
    for (const col of tableColumns) {
      const { rows: p } = await admin.query<{ ok: boolean }>(
        `SELECT has_column_privilege('app_user', 'public.agent_runs', $1, 'SELECT') AS ok`,
        [col],
      );
      if (p[0]!.ok) effective.add(col);
    }
    // No table-level SELECT at all: it would cover every column added later.
    const { rows: tablePriv } = await admin.query<{ ok: boolean }>(
      `SELECT has_table_privilege('app_user', 'public.agent_runs', 'SELECT') AS ok`,
    );
    expect(tablePriv[0]!.ok, 'app_user must hold no table-wide SELECT on agent_runs').toBe(false);
    const listedSet = new Set(listed);
    const drift = {
      granted_but_not_listed: [...grantedSet].filter((c) => !listedSet.has(c)).sort(),
      effective_but_not_listed: [...effective].filter((c) => !listedSet.has(c)).sort(),
      listed_but_not_granted: listed.filter((c) => !grantedSet.has(c)).sort(),
      listed_but_not_a_column: listed.filter((c) => !tableColumns.includes(c)).sort(),
    };
    expect(drift).toEqual({
      granted_but_not_listed: [],
      effective_but_not_listed: [],
      listed_but_not_granted: [],
      listed_but_not_a_column: [],
    });
    // A table column that is not listed is simply ungranted; name it so a
    // reader adding a column sees what to do (add it to the list AND grant it).
    const unlisted = tableColumns.filter((c) => !listedSet.has(c)).sort();
    for (const col of unlisted) {
      expect(effective.has(col), `agent_runs.${col} is not in AGENT_RUN_COLUMNS, so it must stay ungranted`).toBe(false);
    }
  });

  it('criterion 3: a column added to the table without a grant starts ungranted', async () => {
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE agent_runs ADD COLUMN tam_drift_probe text');
      const { rows } = await c.query<{ ok: boolean }>(
        `SELECT has_column_privilege('app_user', 'public.agent_runs', 'tam_drift_probe', 'SELECT') AS ok`,
      );
      expect(rows[0]!.ok).toBe(false);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
