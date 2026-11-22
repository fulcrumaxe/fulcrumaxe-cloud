import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { insertRunner, sha256Hex } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const allowlistOf = (file: string): string[] => {
  const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  const start = sql.indexOf('p_action = ANY (ARRAY[');
  return [...sql.slice(start, sql.indexOf('])', start)).matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!);
};
const NEW_ACTIONS = [
  'onboarding.track_chosen', 'runner.device_approved', 'runner.device_denied', 'project.setup_started', 'project.plan_approved', 'project.install_merged',
  'project.moved', 'project.removed', 'engine_session.started', 'engine_session.stopped', 'machine_credential.added', 'machine_credential.removed',
  'server.create_confirmed', 'server.deleted', 'server.orphan_kept', 'server.unsealed', 'machine.login_started', 'machine.linked_notified',
];
const TABLES = ['machine_provider_credentials', 'managed_servers', 'project_placements', 'machine_login_requests', 'machine_usage_daily'] as const;
const SEALED: Array<[string, string]> = [['machine_provider_credentials', 'ciphertext'], ['machine_provider_credentials', 'nonce'], ['machine_provider_credentials', 'wrapped_dek'], ['machine_login_requests', 'auth_url_ct'], ['machine_login_requests', 'code_ct']];

/** MC-1a (migration 1035): the machine tables, their row security, the sealed columns, the credential reader, the prunes and the audit allowlist. */
describe('machine tables [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let repoA2: string;
  let runnerA1: string;
  let runnerA2: string;
  let runnerB: string;
  let credA: string;
  let credARemoved: string;
  let credB: string;
  let tokenA: string;
  const sealed = { ciphertext: randomBytes(40), nonce: randomBytes(12), dek: randomBytes(60) };

  const asA = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, a.accountId, a.userId, fn);
  const asB = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, b.accountId, b.userId, fn);
  const token = async (r: SeedRefs): Promise<string> =>
    (await admin.query(`INSERT INTO runner_provisioning_tokens (account_id, created_by, token_sha256, credential_mode, expires_at) VALUES ($1, $2, $3, 'subscription', now() + interval '1 hour') RETURNING id`, [r.accountId, r.userId, sha256Hex()])).rows[0].id;
  const credential = async (r: SeedRefs, removed: boolean): Promise<string> =>
    (await admin.query(
      removed
        ? `INSERT INTO machine_provider_credentials (account_id, provider, kek_version, token_hint, created_by, removed_at, removed_by) VALUES ($1, 'hetzner_cloud', 1, 'a1b2', $2, now(), $2) RETURNING id`
        : `INSERT INTO machine_provider_credentials (account_id, provider, ciphertext, nonce, wrapped_dek, kek_version, token_hint, created_by) VALUES ($1, 'hetzner_cloud', $3, $4, $5, 1, 'a1b2', $2) RETURNING id`,
      removed ? [r.accountId, r.userId] : [r.accountId, r.userId, sealed.ciphertext, sealed.nonce, sealed.dek],
    )).rows[0].id;
  const server = (r: SeedRefs, cred: string, tok: string, extra = ''): Promise<unknown> =>
    admin.query(`INSERT INTO managed_servers (account_id, kind, credential_id, name, provisioning_token_id, created_by ${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1, 'hetzner_cloud', $2, 'box', $3, $4 ${extra ? ', ' + extra.split('=')[1] : ''})`, [r.accountId, cred, tok, r.userId]);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    repoA2 = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 2, 'team')`, [repoA2, a.accountId, a.installationId]);
    runnerA1 = await insertRunner(admin, a.accountId, a.userId);
    runnerA2 = await insertRunner(admin, a.accountId, a.userId);
    runnerB = await insertRunner(admin, b.accountId, b.userId);
    credARemoved = await credential(a, true);
    credA = await credential(a, false);
    credB = await credential(b, false);
    tokenA = await token(a);
    await server(a, credA, tokenA);
    await server(b, credB, await token(b));
    await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto'), ($4, $5, $6, 'person')`, [a.repoId, a.accountId, runnerA1, b.repoId, b.accountId, runnerB]);
    await admin.query(`INSERT INTO machine_login_requests (account_id, runner_id, auth_url_ct, expires_at, created_by) VALUES ($1, $2, $3, now() + interval '5 minutes', $4), ($5, $6, $3, now() + interval '5 minutes', $7)`, [a.accountId, runnerA1, randomBytes(30), a.userId, b.accountId, runnerB, b.userId]);
    await admin.query(`INSERT INTO machine_usage_daily (account_id, runner_id, day, source, model_tier) VALUES ($1, $2, current_date, 'run', 'sonnet'), ($3, $4, current_date, 'run', 'sonnet')`, [a.accountId, runnerA1, b.accountId, runnerB]);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, opsPool]) await p.end();
  });

  describe('row security', () => {
    it.each(TABLES)('%s: an account reads only its own rows, with an explicit account predicate, and a foreign id reads 0', async (t) => {
      const own = await asA((c) => c.query(`SELECT count(*)::int AS n FROM ${t} WHERE account_id = $1`, [a.accountId]));
      expect(own.rows[0].n).toBeGreaterThan(0);
      const foreign = await asA((c) => c.query(`SELECT count(*)::int AS n FROM ${t} WHERE account_id = $1`, [b.accountId]));
      expect(foreign.rows[0].n).toBe(0);
      const unfiltered = await asA((c) => c.query(`SELECT DISTINCT account_id FROM ${t}`));
      expect(unfiltered.rows).toEqual([{ account_id: a.accountId }]);
    });

    it('the same account\'s second machine and second repo are separate rows: neither shows the other\'s placement', async () => {
      await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [repoA2, a.accountId, runnerA2]);
      const rows = await asA((c) => c.query(`SELECT repo_id FROM project_placements WHERE account_id = $1 AND runner_id = $2`, [a.accountId, runnerA2]));
      expect(rows.rows).toEqual([{ repo_id: repoA2 }]);
    });

    it('a write into another account is refused', async () => {
      await expect(asB((c) => c.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')`, [randomUUID(), a.accountId, runnerA1]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('CHECKs and indexes', () => {
    it('one engine per machine: a second placement on one runner fails at the database, a second runner of the same account takes it', async () => {
      const r3 = await insertRunner(admin, a.accountId, a.userId);
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 3, 'team')`, [randomUUID(), a.accountId, a.installationId]);
      const repo3 = (await admin.query(`SELECT id FROM repos WHERE account_id = $1 AND gh_repo_id = 3`, [a.accountId])).rows[0].id;
      await expect(admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')`, [repo3, a.accountId, runnerA1])).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')`, [repo3, a.accountId, r3]);
    });

    it('naming another account\'s placed runner is a foreign key failure, not a unique one, so the index tells a session nothing about another account', async () => {
      expect((await admin.query(`SELECT 1 FROM project_placements WHERE runner_id = $1`, [runnerB])).rows).toHaveLength(1);
      const repo = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 41, 'team')`, [repo, a.accountId, a.installationId]);
      await expect(asA((c) => c.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')`, [repo, a.accountId, runnerB]))).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('naming another account\'s placed repo is a foreign key failure, not a unique one, so the primary key tells a session nothing about another account', async () => {
      expect((await admin.query(`SELECT 1 FROM project_placements WHERE repo_id = $1`, [b.repoId])).rows).toHaveLength(1);
      const runner = await insertRunner(admin, a.accountId, a.userId);
      await expect(asA((c) => c.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')`, [b.repoId, a.accountId, runner]))).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('inside one account the keys still hold: a second placement on one runner, and a second placement of one repo, are unique violations', async () => {
      const runner = await insertRunner(admin, a.accountId, a.userId);
      const fresh = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 42, 'team')`, [fresh, a.accountId, a.installationId]);
      await expect(asA((c) => c.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')`, [fresh, a.accountId, runnerA1]))).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION, constraint: 'project_placements_one_per_runner' });
      await expect(asA((c) => c.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')`, [a.repoId, a.accountId, runner]))).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION, constraint: 'project_placements_pkey' });
    });

    it('a server kind other than hetzner_cloud is refused, and the rented-server price column is gone', async () => {
      for (const kind of ['rented', 'other']) {
        await expect(admin.query(`INSERT INTO managed_servers (account_id, kind, credential_id, name, provisioning_token_id, created_by) VALUES ($1, $5, $2, 'x', $3, $4)`, [a.accountId, credA, tokenA, a.userId, kind])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'managed_servers' AND column_name = 'person_monthly_price'`);
      expect(rows[0].n).toBe(0);
    });

    it('a server cannot name another account\'s credential, and a status or deleted stamp must agree', async () => {
      await expect(server(a, credB, await token(a))).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      await expect(server(a, credA, await token(a), `status='deleted'`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(server(a, credA, await token(a), `status='nope'`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('a credential: one active per account and provider, sealed columns present exactly while live', async () => {
      await expect(credential(a, false)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await expect(admin.query(`UPDATE machine_provider_credentials SET ciphertext = NULL WHERE id = $1`, [credA])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(admin.query(`UPDATE machine_provider_credentials SET provider = 'aws' WHERE id = $1`, [credA])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('a login request lives at most 10 minutes and a finished one holds nothing sealed', async () => {
      await expect(admin.query(`INSERT INTO machine_login_requests (account_id, runner_id, expires_at, created_by) VALUES ($1, $2, now() + interval '11 minutes', $3)`, [a.accountId, runnerA1, a.userId])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(admin.query(`INSERT INTO machine_login_requests (account_id, runner_id, status, code_ct, expires_at, created_by) VALUES ($1, $2, 'done', $4, now() + interval '5 minutes', $3)`, [a.accountId, runnerA1, a.userId, randomBytes(8)])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('a usage row is unique per machine, repo (or none), day, source and tier', async () => {
      await expect(admin.query(`INSERT INTO machine_usage_daily (account_id, runner_id, day, source, model_tier) VALUES ($1, $2, current_date, 'run', 'sonnet')`, [a.accountId, runnerA1])).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });
  });

  describe('sealed columns', () => {
    it.each(SEALED)('app_user cannot select %s.%s, by name or through *', async (t, col) => {
      await expect(asA((c) => c.query(`SELECT ${col} FROM ${t} WHERE account_id = $1`, [a.accountId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asA((c) => c.query(`SELECT * FROM ${t} WHERE account_id = $1`, [a.accountId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('the other columns read normally, and the sealed ones can be written (the seal is made in the app)', async () => {
      const { rows } = await asA((c) => c.query(`SELECT token_hint, kek_version, status FROM machine_provider_credentials WHERE id = $1 AND account_id = $2`, [credA, a.accountId]));
      expect(rows).toEqual([{ token_hint: 'a1b2', kek_version: 1, status: 'ok' }]);
      await asA((c) => c.query(`UPDATE machine_provider_credentials SET last_checked_at = now(), ciphertext = $3 WHERE id = $1 AND account_id = $2`, [credA, a.accountId, sealed.ciphertext]));
    });

    it('machine_credential_use returns the sealed bytes of the session\'s own live credential', async () => {
      const { rows } = await asA((c) => c.query(`SELECT * FROM machine_credential_use($1)`, [credA]));
      expect(rows).toHaveLength(1);
      expect(rows[0].o_id).toBe(credA);
      expect(Buffer.compare(rows[0].o_ciphertext, sealed.ciphertext)).toBe(0);
      expect(Buffer.compare(rows[0].o_nonce, sealed.nonce)).toBe(0);
      expect(Buffer.compare(rows[0].o_wrapped_dek, sealed.dek)).toBe(0);
      expect(rows[0].o_kek_version).toBe(1);
    });

    it('it returns nothing for a removed credential of the same account, nothing for another account\'s, and refuses a session with no account', async () => {
      expect((await asA((c) => c.query(`SELECT * FROM machine_credential_use($1)`, [credARemoved]))).rows).toEqual([]);
      expect((await asA((c) => c.query(`SELECT * FROM machine_credential_use($1)`, [credB]))).rows).toEqual([]);
      expect((await asB((c) => c.query(`SELECT * FROM machine_credential_use($1)`, [credA]))).rows).toEqual([]);
      await expect(appPool.query(`SELECT * FROM machine_credential_use($1)`, [credA])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('through the RLS-bypassing admin client with a foreign account id, it reads 0 rows, and with the right one it reads the row', async () => {
      await admin.query(`SELECT set_config('app.account_id', $1, false)`, [b.accountId]);
      expect((await admin.query(`SELECT * FROM machine_credential_use($1)`, [credA])).rows).toEqual([]);
      await admin.query(`SELECT set_config('app.account_id', $1, false)`, [a.accountId]);
      expect((await admin.query(`SELECT * FROM machine_credential_use($1)`, [credA])).rows).toHaveLength(1);
      await admin.query(`SELECT set_config('app.account_id', '', false)`);
    });

    /** Runs fn inside an admin transaction that is always rolled back, so a policy can be relaxed to pin one layer alone. */
    const rolledBack = async (fn: () => Promise<void>) => {
      await admin.query('BEGIN');
      try {
        await fn();
      } finally {
        await admin.query('ROLLBACK');
      }
    };
    const setTenant = (id: string) => admin.query(`SELECT set_config('app.account_id', $1, true)`, [id]);

    it('the function\'s own account predicate holds with the policy relaxed to true: a foreign session reads 0 rows, the right one reads 1', async () => {
      await rolledBack(async () => {
        await admin.query(`ALTER POLICY machine_ops_use ON machine_provider_credentials USING (true)`);
        await setTenant(b.accountId);
        expect((await admin.query(`SELECT * FROM machine_credential_use($1)`, [credA])).rows).toEqual([]);
        await setTenant(a.accountId);
        expect((await admin.query(`SELECT * FROM machine_credential_use($1)`, [credA])).rows).toHaveLength(1);
      });
    });

    it('the machine_ops policies hold alone: a foreign session as machine_ops counts 0 credentials and 0 account rows, its own counts 1, and no session counts 0', async () => {
      await rolledBack(async () => {
        await admin.query(`SET LOCAL ROLE machine_ops`);
        const counts = async () =>
          (await admin.query(`SELECT (SELECT count(*)::int FROM machine_provider_credentials WHERE id = $1) AS creds, (SELECT count(*)::int FROM accounts WHERE id = $2) AS accts`, [credA, a.accountId])).rows[0];
        await setTenant(b.accountId);
        expect(await counts()).toEqual({ creds: 0, accts: 0 });
        await setTenant(a.accountId);
        expect(await counts()).toEqual({ creds: 1, accts: 1 });
        await setTenant('');
        expect(await counts()).toEqual({ creds: 0, accts: 0 });
      });
    });

    it('a deleted account\'s credential cannot be unsealed, and a live account\'s still can', async () => {
      const c = await seedAccount(admin, randomUUID());
      const credC = await credential(c, false);
      await rolledBack(async () => {
        await setTenant(c.accountId);
        expect((await admin.query(`SELECT * FROM machine_credential_use($1)`, [credC])).rows).toHaveLength(1);
        await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [c.accountId]);
        expect((await admin.query(`SELECT * FROM machine_credential_use($1)`, [credC])).rows).toEqual([]);
      });
    });

    it('only app_user may execute it', async () => {
      await expect(opsPool.query(`SELECT * FROM machine_credential_use($1)`, [credA])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('prunes', () => {
    const prune = (fn: string, n = 100) => opsPool.query(`SELECT ${fn}($1::int) AS n`, [n]).then((r) => Number(r.rows[0].n));

    it('login requests: an expired request loses its sealed values and is marked expired, a live one is untouched, an old one is deleted', async () => {
      const mk = async (status: string, ageMin: number) =>
        (await admin.query(
          `INSERT INTO machine_login_requests (account_id, runner_id, status, auth_url_ct, code_ct, created_at, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $4, now() - ($5 || ' minutes')::interval - interval '5 minutes', now() - ($5 || ' minutes')::interval, $6) RETURNING id`,
          [a.accountId, runnerA1, status, randomBytes(9), String(ageMin), a.userId],
        )).rows[0].id as string;
      const fresh = await mk('code_ready', -2);
      const expired = await mk('code_ready', 3);
      const old = await mk('awaiting_code', 60 * 24 * 8);
      const nearlySeven = await mk('awaiting_code', 60 * 24 * 7 - 60);
      expect(await prune('machine_login_requests_prune')).toBeGreaterThanOrEqual(3);
      const row = async (id: string) => (await admin.query(`SELECT status, auth_url_ct IS NULL AS u, code_ct IS NULL AS c FROM machine_login_requests WHERE id = $1`, [id])).rows[0];
      expect(await row(fresh)).toEqual({ status: 'code_ready', u: false, c: false });
      expect(await row(expired)).toEqual({ status: 'expired', u: true, c: true });
      expect(await row(old)).toBeUndefined();
      expect(await row(nearlySeven)).toEqual({ status: 'expired', u: true, c: true });
    });

    it('usage: rows older than 400 days go, the 400th day stays', async () => {
      for (const [d, tier] of [[401, 'old'], [400, 'edge'], [399, 'new']] as const) {
        await admin.query(`INSERT INTO machine_usage_daily (account_id, runner_id, day, source, model_tier) VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - $3::int, 'run', $4)`, [a.accountId, runnerA1, d, tier]);
      }
      expect(await prune('machine_usage_prune')).toBe(1);
      const { rows } = await admin.query(`SELECT model_tier FROM machine_usage_daily WHERE account_id = $1 AND model_tier IN ('old', 'edge', 'new') ORDER BY model_tier`, [a.accountId]);
      expect(rows.map((r) => r.model_tier)).toEqual(['edge', 'new']);
    });

    it('servers: only a server deleted over 400 days ago goes (one 400 days 1 hour old goes, one 399 days 23 hours old stays)', async () => {
      const cred = await credential(b, true);
      const mk = async (days: string) => (await admin.query(`INSERT INTO managed_servers (account_id, kind, credential_id, name, provisioning_token_id, created_by, status, deleted_at, deleted_by) VALUES ($1, 'hetzner_cloud', $2, 'gone', $3, $4, 'deleted', now() - $5::interval, $4) RETURNING id`, [b.accountId, cred, await token(b), b.userId, days])).rows[0].id as string;
      const oldId = await mk('400 days 1 hour');
      const keptId = await mk('399 days 23 hours');
      expect(await prune('machine_servers_prune')).toBe(1);
      const { rows } = await admin.query(`SELECT id FROM managed_servers WHERE id = ANY($1)`, [[oldId, keptId]]);
      expect(rows).toEqual([{ id: keptId }]);
    });

    it('takes a batch size in range and nothing else, and is not callable by app_user', async () => {
      for (const fn of ['machine_login_requests_prune', 'machine_usage_prune', 'machine_servers_prune']) {
        await expect(prune(fn, 0)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
        await expect(appPool.query(`SELECT ${fn}(10)`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('a session with a tenant set prunes nothing from any of the three tables (each policy needs no tenant), and with none each acts', async () => {
      await admin.query(`INSERT INTO machine_usage_daily (account_id, runner_id, day, source, model_tier) VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - 500, 'run', 'ancient')`, [a.accountId, runnerA1]);
      const login = (await admin.query(
        `INSERT INTO machine_login_requests (account_id, runner_id, status, auth_url_ct, code_ct, created_at, expires_at, created_by)
         VALUES ($1, $2, 'code_ready', $3, $3, now() - interval '10 minutes', now() - interval '5 minutes', $4) RETURNING id`,
        [a.accountId, runnerA1, randomBytes(9), a.userId],
      )).rows[0].id as string;
      const srv = (await admin.query(`INSERT INTO managed_servers (account_id, kind, credential_id, name, provisioning_token_id, created_by, status, deleted_at, deleted_by) VALUES ($1, 'hetzner_cloud', $2, 'gone', $3, $4, 'deleted', now() - interval '401 days', $4) RETURNING id`, [a.accountId, credARemoved, await token(a), a.userId])).rows[0].id as string;
      const state = async () => (await admin.query(
        `SELECT (SELECT count(*)::int FROM machine_usage_daily WHERE model_tier = 'ancient') AS usage,
                (SELECT status || ':' || (auth_url_ct IS NULL)::text FROM machine_login_requests WHERE id = $1) AS login,
                (SELECT count(*)::int FROM managed_servers WHERE id = $2) AS servers`, [login, srv])).rows[0];
      await admin.query(`SELECT set_config('app.account_id', $1, false)`, [a.accountId]);
      try {
        for (const fn of ['machine_usage_prune', 'machine_login_requests_prune', 'machine_servers_prune']) {
          expect((await admin.query(`SELECT ${fn}(10) AS n`)).rows[0].n, fn).toBe(0);
        }
        expect(await state()).toEqual({ usage: 1, login: 'code_ready:false', servers: 1 });
      } finally {
        await admin.query(`SELECT set_config('app.account_id', '', false)`);
      }
      for (const fn of ['machine_usage_prune', 'machine_login_requests_prune', 'machine_servers_prune']) {
        expect(Number((await admin.query(`SELECT ${fn}(10) AS n`)).rows[0].n), fn).toBeGreaterThanOrEqual(1);
      }
      expect(await state()).toEqual({ usage: 0, login: 'expired:true', servers: 0 });
    });

    // The policy and the function each state the retention edge; relaxing the policy (rolled back) leaves the function's own edge to be seen.
    it('the usage prune keeps day 400 and drops day 401 by its own edge, with the policy relaxed', async () => {
      await admin.query('BEGIN');
      try {
        await admin.query(`ALTER POLICY machine_ops_prune ON machine_usage_daily USING (NULLIF(current_setting('app.account_id', true), '') IS NULL)`);
        for (const [d, tier] of [[401, 'edge401'], [400, 'edge400']] as const) {
          await admin.query(`INSERT INTO machine_usage_daily (account_id, runner_id, day, source, model_tier) VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - $3::int, 'run', $4)`, [a.accountId, runnerA1, d, tier]);
        }
        await admin.query(`SELECT machine_usage_prune(100)`);
        const { rows } = await admin.query(`SELECT model_tier FROM machine_usage_daily WHERE model_tier IN ('edge401', 'edge400')`);
        expect(rows).toEqual([{ model_tier: 'edge400' }]);
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('the servers prune keeps one deleted 399 days 23 hours ago and drops one deleted 400 days 1 hour ago by its own edge, with the policy relaxed', async () => {
      const cred = await credential(b, true);
      await admin.query('BEGIN');
      try {
        await admin.query(`ALTER POLICY machine_ops_prune ON managed_servers USING (NULLIF(current_setting('app.account_id', true), '') IS NULL)`);
        const mk = async (interval: string) => (await admin.query(`INSERT INTO managed_servers (account_id, kind, credential_id, name, provisioning_token_id, created_by, status, deleted_at, deleted_by) VALUES ($1, 'hetzner_cloud', $2, 'gone', $3, $4, 'deleted', now() - $5::interval, $4) RETURNING id`, [b.accountId, cred, await token(b), b.userId, interval])).rows[0].id as string;
        const kept = await mk('399 days 23 hours');
        const dropped = await mk('400 days 1 hour');
        await admin.query(`SELECT machine_servers_prune(100)`);
        expect((await admin.query(`SELECT id FROM managed_servers WHERE id = ANY($1)`, [[kept, dropped]])).rows).toEqual([{ id: kept }]);
      } finally {
        await admin.query('ROLLBACK');
      }
    });
  });

  describe('what app_user can change after create', () => {
    let serverA: string;
    beforeAll(async () => {
      serverA = (await admin.query(`SELECT id FROM managed_servers WHERE account_id = $1 ORDER BY created_at LIMIT 1`, [a.accountId])).rows[0].id;
    });

    it('a server\'s life columns update', async () => {
      await asA((c) => c.query(`UPDATE managed_servers SET name = 'renamed', status = 'booting', status_at = now(), failure_code = NULL, provider_server_id = '123', public_ipv4 = '203.0.113.7' WHERE id = $1 AND account_id = $2`, [serverA, a.accountId]));
      const { rows } = await asA((c) => c.query(`SELECT name, status FROM managed_servers WHERE id = $1 AND account_id = $2`, [serverA, a.accountId]));
      expect(rows).toEqual([{ name: 'renamed', status: 'booting' }]);
    });

    it.each([
      ['price_hourly_gross', '1'], ['price_monthly_gross', '1'], ['ipv4_monthly_gross', '1'], ['currency', `'USD'`], ['kind', `'hetzner_cloud'`],
      ['credential_id', 'credential_id'], ['provisioning_token_id', 'provisioning_token_id'], ['created_by', 'created_by'], ['created_at', 'created_at'], ['account_id', 'account_id'], ['id', 'id'],
    ])('managed_servers.%s cannot be updated by app_user, even to its own value', async (col, val) => {
      await expect(asA((c) => c.query(`UPDATE managed_servers SET ${col} = ${val} WHERE id = $1 AND account_id = $2`, [serverA, a.accountId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it.each([['provider', `'hetzner_cloud'`], ['created_by', 'created_by'], ['created_at', 'created_at'], ['account_id', 'account_id'], ['id', 'id']])(
      'machine_provider_credentials.%s cannot be updated by app_user, even to its own value',
      async (col, val) => {
        await expect(asA((c) => c.query(`UPDATE machine_provider_credentials SET ${col} = ${val} WHERE id = $1 AND account_id = $2`, [credA, a.accountId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      },
    );
  });

  describe('audit_write', () => {
    const call = (action: string | null) => asA((c) => c.query(`SELECT audit_write($1::text, '{"repo_id":"x"}'::jsonb) AS id`, [action]));

    it('1035 lists exactly 1026\'s actions plus the eighteen new ones, and none of the withdrawn ones', () => {
      const before = allowlistOf('1026_engine_audit_actions.sql');
      expect(before.length).toBeGreaterThan(30);
      expect(allowlistOf('1035_machine_tables.sql')).toEqual([...before, ...NEW_ACTIONS]);
      expect(allowlistOf('1035_machine_tables.sql')).not.toContain('server.bootstrap_issued');
      expect(allowlistOf('1035_machine_tables.sql')).not.toContain('project.github_identity_changed');
    });

    it('accepts every new action and every earlier one', async () => {
      for (const action of [...NEW_ACTIONS, ...allowlistOf('1026_engine_audit_actions.sql')]) {
        await call(action);
        const { rows } = await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action = $2`, [a.accountId, action]);
        expect(rows[0].n, action).toBe(1);
      }
    });

    it('still refuses an unknown action, a withdrawn one and NULL', async () => {
      for (const action of ['server.bootstrap_issued', 'project.github_identity_changed', 'server.deleted ', null]) await expect(call(action)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });
  });
});
