import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner, sha256Hex } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const NEW_TABLES = ['runners', 'runner_registration_codes', 'runner_request_nonces'] as const;

describe('runner tables: row level security and tenant isolation (0711)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;
  let runnerA: string;
  let runnerB: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    runnerA = await insertRunner(admin, a.accountId, a.userId);
    runnerB = await insertRunner(admin, b.accountId, b.userId);
    for (const [refs, runner] of [[a, runnerA], [b, runnerB]] as const) {
      await admin.query(`INSERT INTO runner_registration_codes (account_id, registered_by, code_sha256, expires_at, credential_mode) VALUES ($1, $2, $3, now() + interval '10 minutes', 'api_key')`, [refs.accountId, refs.userId, sha256Hex()]);
      await admin.query(`INSERT INTO runner_request_nonces (account_id, runner_id, nonce) VALUES ($1, $2, $3)`, [refs.accountId, runner, `nonce-${randomUUID()}`]);
    }
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  it('findRlsViolations reports none of the three new tables, and nothing else', async () => {
    const violations = await findRlsViolations(admin);
    for (const table of NEW_TABLES) expect(violations).not.toContain(table);
    expect(violations).toEqual([]);
  });

  it('RLS is enabled and forced on each, with an app_user policy and a platform_ops policy', async () => {
    for (const table of NEW_TABLES) {
      const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [table]);
      expect(rows[0], table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await admin.query<{ roles: string[] }>(`SELECT roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`, [table]);
      // guard_definer (0720), runner_lease_definer (0754) runner_approval_definer (0757), runner_sandbox_status_definer (0763), runner_git_definer (0765), runner_consent_definer and runner_auto_approve_definer (0767) and runner_usage_definer (0768) runner_capacity_definer (0777), runner_facts_definer and runner_settings_definer (0783) have their own narrow policies on runners; the
      // first is checked in guard-trigger-functions-platform-ops.pg.test.ts, the others in runner-lease-definer.pg.test.ts and
      // runner-approval-definer.pg.test.ts.
      const roles = policies.rows.flatMap((r) => r.roles).filter((r) => r !== 'guard_definer' && r !== 'runner_lease_definer' && r !== 'runner_approval_definer' && r !== 'runner_sandbox_status_definer' && r !== 'runner_git_definer' && r !== 'runner_consent_definer' && r !== 'runner_auto_approve_definer' && r !== 'runner_usage_definer' && r !== 'runner_capacity_definer' && r !== 'runner_facts_definer' && r !== 'runner_settings_definer').sort();
      expect(roles, table).toEqual(['app_user', 'platform_ops']);
    }
  });

  it("a tenant sees its own runners and registration codes and never another account's", async () => {
    for (const [self, other, selfRunner, otherRunner] of [[a, b, runnerA, runnerB], [b, a, runnerB, runnerA]] as const) {
      const runners = await withTenant(appPool, self.accountId, (c) => c.query<{ id: string }>('SELECT id FROM runners'));
      expect(runners.rows.map((r) => r.id)).toEqual([selfRunner]);
      expect(runners.rows.map((r) => r.id)).not.toContain(otherRunner);
      const codes = await withTenant(appPool, self.accountId, (c) => c.query<{ account_id: string }>('SELECT account_id FROM runner_registration_codes'));
      expect(codes.rows.map((r) => r.account_id)).toEqual([self.accountId]);
      const asOther = await withTenant(appPool, self.accountId, (c) => c.query('SELECT 1 FROM runners WHERE account_id = $1', [other.accountId]));
      expect(asOther.rowCount).toBe(0);
    }
  });

  it('a suspended (soft-deleted) account reads none of its runners, codes or nonces', async () => {
    // D#6 R2a follow-up 5: the account_is_active clause in each policy is the only thing that does this.
    const c = await seedAccount(admin, randomUUID());
    const runner = await insertRunner(admin, c.accountId, c.userId);
    await admin.query(`INSERT INTO runner_registration_codes (account_id, registered_by, code_sha256, expires_at, credential_mode) VALUES ($1, $2, $3, now() + interval '10 minutes', 'api_key')`, [c.accountId, c.userId, sha256Hex()]);
    const count = (table: string) => withTenant(appPool, c.accountId, async (cl) => (await cl.query(`SELECT 1 FROM ${table}`)).rowCount);
    expect(await count('runners')).toBe(1);
    expect(await count('runner_registration_codes')).toBe(1);
    await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [c.accountId]);
    expect(await count('runners')).toBe(0);
    expect(await count('runner_registration_codes')).toBe(0);
    expect(runner).toBeTruthy();
  });

  it('with no tenant set, app_user sees nothing', async () => {
    const client = await appPool.connect();
    try {
      for (const table of ['runners', 'runner_registration_codes']) expect((await client.query(`SELECT 1 FROM ${table}`)).rowCount, table).toBe(0);
    } finally {
      client.release();
    }
  });

  it('app_user cannot write the runner tables, or read the nonces', async () => {
    const attempts: Array<[string, string]> = [
      ['INSERT INTO runners (account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, \'{}\', \'x\', \'api_key\')', 'insert runners'],
      ['UPDATE runners SET revoked_at = now()', 'update runners'],
      ['DELETE FROM runners', 'delete runners'],
      ['DELETE FROM runner_registration_codes', 'delete codes'],
      ['SELECT * FROM runner_request_nonces', 'read nonces'],
    ];
    for (const [sql, label] of attempts) {
      const params = sql.includes('$1') ? [a.accountId, a.userId] : [];
      await expect(withTenant(appPool, a.accountId, (c) => c.query(sql, params)), label).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('platform_ops reads every account, for the lookup by key that happens before a tenant is known', async () => {
    const client = await opsPool.connect();
    try {
      const { rows } = await client.query<{ id: string }>('SELECT id FROM runners WHERE id = ANY($1)', [[runnerA, runnerB]]);
      expect(rows.map((r) => r.id).sort()).toEqual([runnerA, runnerB].sort());
    } finally {
      client.release();
    }
  });

  it("a runner row from account B cannot be referenced by an agent_runs row in account A (composite FK)", async () => {
    await expect(
      admin.query(`INSERT INTO agent_runs (account_id, role, runtime, status, runner_id) VALUES ($1, 'executor', 'runner', 'pending', $2)`, [a.accountId, runnerB]),
    ).rejects.toMatchObject({ code: '23503' });
    // The same row naming its own account's runner is accepted.
    await admin.query(`INSERT INTO agent_runs (account_id, role, runtime, status, runner_id) VALUES ($1, 'executor', 'runner', 'pending', $2)`, [a.accountId, runnerA]);
  });

  it("a nonce row cannot name another account's runner either", async () => {
    await expect(admin.query(`INSERT INTO runner_request_nonces (account_id, runner_id, nonce) VALUES ($1, $2, $3)`, [a.accountId, runnerB, `nonce-${randomUUID()}`])).rejects.toMatchObject({ code: '23503' });
  });

  it('deleting a runner leaves its runs, with runner_id cleared and the account kept', async () => {
    const runner = await insertRunner(admin, a.accountId, a.userId);
    const run = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, runner_id) VALUES ($1, $2, 'executor', 'runner', 'running', $3)`, [run, a.accountId, runner]);
    await admin.query('DELETE FROM runners WHERE id = $1', [runner]);
    const { rows } = await admin.query('SELECT account_id, runner_id FROM agent_runs WHERE id = $1', [run]);
    expect(rows).toEqual([{ account_id: a.accountId, runner_id: null }]);
  });
});
