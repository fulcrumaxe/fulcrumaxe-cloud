import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * Migration 1025 (D#6 CHECKFIX-PROTOCOL-AT-CLAIM): agent_runs.runner_protocol_version, the protocol the cloud held for the claiming runner when it claimed the run.
 * The privileges follow the neighbouring column of 0805: app_user reads, only the claim's role writes, platform_ops holds nothing. Real Postgres.
 */
describe('migration 1025: agent_runs.runner_protocol_version', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

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

  const hasPrivilege = async (role: string, privilege: 'SELECT' | 'UPDATE' | 'INSERT'): Promise<boolean> =>
    (await admin.query<{ ok: boolean }>('SELECT has_column_privilege($1, $2, $3, $4) AS ok', [role, 'public.agent_runs', 'runner_protocol_version', privilege])).rows[0]!.ok;

  it('is NULL on every run that exists, and is a positive number or NULL', async () => {
    const id = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode) VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local')", [id, a.accountId]);
    expect((await admin.query('SELECT runner_protocol_version AS v FROM agent_runs WHERE id = $1', [id])).rows[0]!.v).toBeNull();
    // The guard trigger answers first for a write, so the closed range is read from the catalog.
    const check = await admin.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'agent_runs_runner_protocol_version_check' AND conrelid = 'public.agent_runs'::regclass");
    expect(check.rows[0]!.def).toMatch(/runner_protocol_version >= 1/);
  });

  it('app_user reads it (only inside its own account), and holds no write on it', async () => {
    expect(await hasPrivilege('app_user', 'SELECT')).toBe(true);
    expect(await hasPrivilege('app_user', 'UPDATE')).toBe(false);
    const own = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode) VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local')", [own, a.accountId]);
    const seen = await withTenant(appUserPool, a.accountId, (client) => client.query('SELECT runner_protocol_version FROM agent_runs WHERE id = $1', [own]));
    expect(seen.rows).toHaveLength(1);
    const other = await withTenant(appUserPool, b.accountId, (client) => client.query('SELECT runner_protocol_version FROM agent_runs WHERE id = $1', [own]));
    expect(other.rows).toHaveLength(0);
    await expect(withTenant(appUserPool, a.accountId, (client) => client.query('UPDATE agent_runs SET runner_protocol_version = 19 WHERE id = $1', [own]))).rejects.toMatchObject({ code: '42501' });
  });

  it('only the claim role writes it, and platform_ops holds nothing on it', async () => {
    expect(await hasPrivilege('runner_lease_definer', 'UPDATE')).toBe(true);
    expect(await hasPrivilege('runner_lease_definer', 'INSERT')).toBe(false);
    for (const privilege of ['SELECT', 'UPDATE', 'INSERT'] as const) expect(await hasPrivilege('platform_ops', privilege), `platform_ops ${privilege}`).toBe(false);
  });

  it('is on the column list the scoped reads and the app_user grant follow', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'src', 'tenancy', 'scopedAccess.ts'), 'utf8');
    const list = /export const AGENT_RUN_COLUMNS\s*=\s*`([^`]*)`/.exec(src)![1]!.split(',').map((c) => c.trim());
    expect(list).toContain('runner_protocol_version');
  });
});
