import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { fakeKey, insertRunner, sha256Hex } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** The runner tables and the columns and CHECKs the runner work adds to agent_runs and repos. */
describe('runner schema (0711)', () => {
  let pool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    admin = await pool.connect();
    refs = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await pool.end();
  });

  const columns = async (table: string): Promise<string[]> =>
    (await admin.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table])).rows.map((r) => r.column_name).sort();

  /** Runs `sql` expecting a constraint failure (the connection is in autocommit, so a failed statement leaves nothing behind). */
  async function rejects(sql: string, params: unknown[], code: '23514' | '23505' | '23503' | '42501'): Promise<void> {
    let failure: { code?: string; message?: string } | undefined;
    try {
      await admin.query(sql, params);
    } catch (error) {
      failure = error as { code?: string; message?: string };
    }
    expect(failure, 'the statement was accepted').toBeDefined();
    expect(failure!.code, failure!.message).toBe(code);
  }

  it('runners has exactly the Spec columns, plus isolation', async () => {
    expect(await columns('runners')).toEqual(
      ['id', 'account_id', 'registered_by', 'public_key_jwk', 'jkt', 'credential_mode', 'isolation', 'allowed_repo_ids', 'allowed_roles', 'created_at', 'key_rotated_at', 'last_seen_at', 'protocol_version', 'binary_version', 'revoked_at', 'revoked_reason'].sort(),
    );
  });

  it('runner_registration_codes stores a hash and has no plaintext column', async () => {
    const cols = await columns('runner_registration_codes');
    expect(cols).toEqual(['id', 'account_id', 'registered_by', 'code_sha256', 'expires_at', 'used_at', 'credential_mode', 'allowed_repo_ids', 'created_at'].sort());
    expect(cols.filter((c) => /code/.test(c))).toEqual(['code_sha256']);
  });

  it('runner_request_nonces is keyed by (runner_id, nonce)', async () => {
    expect(await columns('runner_request_nonces')).toEqual(['account_id', 'nonce', 'runner_id', 'seen_at']);
    const runner = await insertRunner(admin, refs.accountId, refs.userId);
    const nonce = 'bm9uY2Utbm9uY2Utbm9uY2U';
    const insert = `INSERT INTO runner_request_nonces (account_id, runner_id, nonce) VALUES ($1, $2, $3)`;
    await admin.query(insert, [refs.accountId, runner, nonce]);
    await rejects(insert, [refs.accountId, runner, nonce], '23505');
    await rejects(insert, [refs.accountId, runner, 'short'], '23514');
  });

  it('runners.credential_mode allows only subscription and api_key; so do registration codes', async () => {
    for (const mode of ['subscription', 'api_key']) await insertRunner(admin, refs.accountId, refs.userId, { credentialMode: mode });
    for (const bad of ['', 'none', 'API_KEY', 'oauth']) {
      await rejects(
        `INSERT INTO runners (account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [refs.accountId, refs.userId, JSON.stringify(fakeKey().jwk), fakeKey().jkt, bad],
        '23514',
      );
    }
  });

  it('runners.isolation allows the four tiers and null', async () => {
    for (const tier of ['microvm', 'vm_container', 'container', 'host_sandbox', null]) await insertRunner(admin, refs.accountId, refs.userId, { isolation: tier });
    const insert = `INSERT INTO runners (account_id, registered_by, public_key_jwk, jkt, credential_mode, isolation) VALUES ($1, $2, $3::jsonb, $4, 'api_key', 'none')`;
    await rejects(insert, [refs.accountId, refs.userId, JSON.stringify(fakeKey().jwk), fakeKey().jkt], '23514');
  });

  it('refuses a public key that carries a private member, another curve or extra members', async () => {
    const good = fakeKey();
    const insert = `INSERT INTO runners (account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3::jsonb, $4, 'api_key')`;
    for (const jwk of [
      { ...good.jwk, d: 'private-half' },
      { ...good.jwk, crv: 'P-256' },
      { ...good.jwk, kty: 'RSA' },
      { ...good.jwk, use: 'sig' },
      { kty: 'OKP', crv: 'Ed25519' },
    ]) {
      await rejects(insert, [refs.accountId, refs.userId, JSON.stringify(jwk), fakeKey().jkt], '23514');
    }
  });

  it('jkt is a 43-character thumbprint and unique across accounts', async () => {
    const key = fakeKey();
    await insertRunner(admin, refs.accountId, refs.userId, { jwk: key.jwk, jkt: key.jkt });
    const other = await seedAccount(admin, randomUUID());
    const insert = `INSERT INTO runners (account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3::jsonb, $4, 'api_key')`;
    await rejects(insert, [other.accountId, other.userId, JSON.stringify(key.jwk), key.jkt], '23505');
    await rejects(insert, [refs.accountId, refs.userId, JSON.stringify(key.jwk), 'too-short'], '23514');
    await rejects(insert, [refs.accountId, randomUUID(), JSON.stringify(fakeKey().jwk), fakeKey().jkt], '23503');
  });

  it('a registration code is stored only as 64 hex characters, and is unique', async () => {
    const hash = sha256Hex();
    const insert = `INSERT INTO runner_registration_codes (account_id, registered_by, code_sha256, expires_at, credential_mode)
                    VALUES ($1, $2, $3, now() + interval '10 minutes', $4)`;
    await admin.query(insert, [refs.accountId, refs.userId, hash, 'subscription']);
    await rejects(insert, [refs.accountId, refs.userId, hash, 'subscription'], '23505');
    await rejects(insert, [refs.accountId, refs.userId, `fxrr_${'A'.repeat(40)}`, 'subscription'], '23514');
    await rejects(insert, [refs.accountId, refs.userId, hash.toUpperCase(), 'subscription'], '23514');
    await rejects(insert, [refs.accountId, refs.userId, sha256Hex(), 'free text'], '23514');
  });

  it("agent_runs.runtime allows 'runner' beside local and production, and nothing else", async () => {
    const insert = `INSERT INTO agent_runs (account_id, role, runtime, status) VALUES ($1, 'executor', $2, 'pending')`;
    for (const runtime of ['local', 'production', 'runner']) await admin.query(insert, [refs.accountId, runtime]);
    await rejects(insert, [refs.accountId, 'cloud'], '23514');
  });

  it('agent_runs gains the lease and people columns with safe defaults', async () => {
    const cols = await columns('agent_runs');
    for (const c of ['runner_id', 'lease_generation', 'lease_expires_at', 'initiated_by', 'approved_by', 'job_signed']) expect(cols).toContain(c);
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'runner', 'pending')`, [id, refs.accountId]);
    const { rows } = await admin.query(`SELECT runner_id, lease_generation, lease_expires_at, initiated_by, approved_by, job_signed FROM agent_runs WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ runner_id: null, lease_generation: 0, lease_expires_at: null, initiated_by: null, approved_by: null, job_signed: null });
    await rejects(`UPDATE agent_runs SET lease_generation = -1 WHERE id = $1`, [id], '23514');
  });

  it("repos.execution_mode allows 'sandbox' and 'runner_local' only", async () => {
    await admin.query(`UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1`, [refs.repoId]);
    await admin.query(`UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1`, [refs.repoId]);
    for (const bad of ['runner_verified', 'local', '']) await rejects(`UPDATE repos SET execution_mode = $2 WHERE id = $1`, [refs.repoId, bad], '23514');
  });

  it("agent_runs_execution_mode_check allows 'runner_local' since 0714 (C8 section 5 moved the widening to R3) and never 'runner_verified'; accounts.plan stays unconstrained", async () => {
    const { rows } = await admin.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'agent_runs_execution_mode_check'`);
    expect(rows[0]!.def).toContain("'sandbox'");
    expect(rows[0]!.def).toContain("'runner_local'");
    expect(rows[0]!.def).not.toContain('runner_verified');
    const plan = await admin.query(`SELECT 1 FROM pg_constraint WHERE conrelid = 'accounts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%plan%'`);
    expect(plan.rowCount).toBe(0);
  });
});
