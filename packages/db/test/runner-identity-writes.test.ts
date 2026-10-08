import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedF2, type F2Fixture } from './helpers/members.js';
import { insertRunner } from './helpers/runnerFixtures.js';

/** The write paths for runner identity (0712): register, rotate, revoke, and the revoke-on-demotion trigger. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

interface Jwk {
  kty: string;
  crv: string;
  x: string;
}
const newKey = (): Jwk => generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Jwk;
const thumbprint = (k: Jwk): string => createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${k.x}"}`).digest('base64url');
const hex = (): string => randomBytes(32).toString('hex');

describe('runner identity writes (0712)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  /** A fresh account with the F2 members, so a test that changes roles or counts never disturbs another. */
  const freshAccount = (): Promise<F2Fixture> => seedF2(admin);

  async function mintCode(f: F2Fixture, by: string, over: { expiresSql?: string; usedAt?: boolean; mode?: string; repos?: string[] } = {}): Promise<string> {
    const sha = hex();
    await admin.query(
      `INSERT INTO runner_registration_codes (account_id, registered_by, code_sha256, expires_at, used_at, credential_mode, allowed_repo_ids)
       VALUES ($1, $2, $3, ${over.expiresSql ?? "now() + interval '10 minutes'"}, ${over.usedAt ? 'now()' : 'NULL'}, $4, $5)`,
      [f.accountId, by, sha, over.mode ?? 'subscription', over.repos ?? []],
    );
    return sha;
  }

  /** register as the runner would be called: a tenant session with no user. */
  const register = (accountId: string, code: string, jwk: unknown, isolation: string | null = null, maxRunners: number | null = null): Promise<string> =>
    withTenant(appPool, accountId, async (c) => (await c.query<{ id: string }>('SELECT runner_register($1, $2::jsonb, $3, $4) AS id', [code, JSON.stringify(jwk), isolation, maxRunners])).rows[0]!.id);
  /** `as` is what the runner middleware would put in app.runner_id (default: the runner itself; null: unset). */
  const rotate = (accountId: string, runnerId: string, oldJkt: string, jwk: unknown, as: string | null = runnerId, userId?: string): Promise<string> => {
    const body = async (c: PoolClient): Promise<string> => {
      if (as !== null) await c.query(`SELECT set_config('app.runner_id', $1, true)`, [as]);
      return (await c.query<{ j: string }>('SELECT runner_rotate_key($1, $2, $3::jsonb) AS j', [runnerId, oldJkt, JSON.stringify(jwk)])).rows[0]!.j;
    };
    return userId ? withTenant(appPool, accountId, userId, body) : withTenant(appPool, accountId, body);
  };
  const selfRevoke = (accountId: string, as: string | null): Promise<unknown> =>
    withTenant(appPool, accountId, async (c) => {
      if (as !== null) await c.query(`SELECT set_config('app.runner_id', $1, true)`, [as]);
      return c.query('SELECT runner_self_revoke()');
    });
  const revoke = (accountId: string, userId: string, runnerId: string, reason = 'revoked'): Promise<unknown> =>
    withTenant(appPool, accountId, userId, (c) => c.query('SELECT runner_revoke($1, $2)', [runnerId, reason]));

  /** Everything a refusal must leave alone, for the given accounts. */
  async function snapshot(...accountIds: string[]): Promise<string> {
    const runners = await admin.query('SELECT * FROM runners WHERE account_id = ANY($1) ORDER BY id', [accountIds]);
    const codes = await admin.query('SELECT * FROM runner_registration_codes WHERE account_id = ANY($1) ORDER BY id', [accountIds]);
    const audit = await admin.query(`SELECT id FROM audit_log WHERE account_id = ANY($1) AND action LIKE 'runner.%' ORDER BY id`, [accountIds]);
    const members = await admin.query('SELECT account_id, user_id, role FROM account_members WHERE account_id = ANY($1) ORDER BY user_id', [accountIds]);
    return JSON.stringify([runners.rows, codes.rows, audit.rows, members.rows]);
  }
  /** Runs `act`, expects it to fail with `code`, and expects every row in `accounts` to be exactly as before. */
  async function refused(code: string, act: () => Promise<unknown>, ...accounts: string[]): Promise<void> {
    const before = await snapshot(...accounts);
    let failure: { code?: string; message?: string } | undefined;
    try {
      await act();
    } catch (error) {
      failure = error as { code?: string; message?: string };
    }
    expect(failure, 'the call was accepted').toBeDefined();
    expect(failure!.code, failure!.message).toBe(code);
    expect(await snapshot(...accounts)).toBe(before);
  }
  const runnerRow = async (id: string) => (await admin.query('SELECT * FROM runners WHERE id = $1', [id])).rows[0];
  const auditRows = async (accountId: string, action: string) => (await admin.query('SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2 ORDER BY created_at', [accountId, action])).rows;

  describe('runner_register', () => {
    it('registers from a valid code: the registrant, mode and repos come from the code, the thumbprint from the key', async () => {
      const f = await freshAccount();
      const repo = randomUUID();
      const code = await mintCode(f, f.a1, { mode: 'api_key', repos: [repo] });
      const key = newKey();
      const id = await register(f.accountId, code, key, 'microvm');
      const row = await runnerRow(id);
      expect(row).toMatchObject({ account_id: f.accountId, registered_by: f.a1, credential_mode: 'api_key', isolation: 'microvm', allowed_repo_ids: [repo], revoked_at: null, key_rotated_at: null });
      expect(row.jkt).toBe(thumbprint(key));
      expect(row.public_key_jwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: key.x });
      expect((await admin.query('SELECT used_at FROM runner_registration_codes WHERE code_sha256 = $1', [code])).rows[0].used_at).not.toBeNull();
      const audit = await auditRows(f.accountId, 'runner.registered');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor: `runner:${id}`, payload: { runner_id: id, registered_by: f.a1, credential_mode: 'api_key', jkt: row.jkt } });
    });

    it('a code is single use', async () => {
      const f = await freshAccount();
      const code = await mintCode(f, f.o1);
      await register(f.accountId, code, newKey());
      await refused('P0002', () => register(f.accountId, code, newKey()), f.accountId);
    });

    it("refuses another account's code, an expired code, a used code and an unknown code with one answer and no change", async () => {
      const f = await freshAccount();
      const g = await freshAccount();
      const others = await mintCode(g, g.o1);
      const expired = await mintCode(f, f.o1, { expiresSql: "now() - interval '1 second'" });
      const used = await mintCode(f, f.o1, { usedAt: true });
      for (const code of [others, expired, used, hex()]) await refused('P0002', () => register(f.accountId, code, newKey()), f.accountId, g.accountId);
    });

    it("refuses another account's code even when its minter is also an admin of the session account", async () => {
      const f = await freshAccount();
      const g = await freshAccount();
      await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [g.accountId, f.a1, 'admin']);
      const code = await mintCode(g, f.a1);
      await refused('P0002', () => register(f.accountId, code, newKey()), f.accountId, g.accountId);
    });

    it('refuses a code whose minter is no longer an owner or admin, and one minted by a plain member', async () => {
      const f = await freshAccount();
      const code = await mintCode(f, f.a1);
      await admin.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [f.accountId, f.a1]);
      await refused('P0002', () => register(f.accountId, code, newKey()), f.accountId);
      const byMember = await mintCode(f, f.m1);
      await refused('P0002', () => register(f.accountId, byMember, newKey()), f.accountId);
    });

    it('refuses with no tenant context', async () => {
      const f = await freshAccount();
      const code = await mintCode(f, f.o1);
      const client = await appPool.connect();
      try {
        await refused('42501', () => client.query('SELECT runner_register($1, $2::jsonb, NULL, NULL)', [code, JSON.stringify(newKey())]), f.accountId);
      } finally {
        client.release();
      }
    });

    it('refuses a malformed key, each way, and leaves the code unused', async () => {
      const f = await freshAccount();
      const good = newKey();
      const last = ALPHABET.indexOf(good.x[42]!);
      const nonCanonical = good.x.slice(0, 42) + ALPHABET[last | 1];
      const bad: Array<[string, unknown]> = [
        ['wrong kty', { ...good, kty: 'RSA' }],
        ['wrong crv', { ...good, crv: 'X25519' }],
        ['a private member', { ...good, d: randomBytes(32).toString('base64url') }],
        ['an extra member', { ...good, use: 'sig' }],
        ['no x', { kty: 'OKP', crv: 'Ed25519' }],
        ['x too short', { ...good, x: good.x.slice(1) }],
        ['x too long', { ...good, x: good.x + 'A' }],
        ['x not base64url', { ...good, x: '+'.repeat(43) }],
        ['x not a string', { ...good, x: 42 }],
        ['x padded', { ...good, x: good.x.slice(0, 42) + '=' }],
        ['x not canonical', { ...good, x: nonCanonical }],
        ['an array', [good]],
        ['a string', 'key'],
      ];
      for (const [label, key] of bad) {
        const code = await mintCode(f, f.o1);
        await refused('22023', () => register(f.accountId, code, key), f.accountId);
        expect((await admin.query('SELECT used_at FROM runner_registration_codes WHERE code_sha256 = $1', [code])).rows[0].used_at, label).toBeNull();
      }
      // The same code then works with a good key.
      const code = await mintCode(f, f.o1);
      await register(f.accountId, code, good);
    });

    it('refuses a malformed code hash and an unknown isolation tier', async () => {
      const f = await freshAccount();
      for (const hash of ['x', hex().toUpperCase(), hex().slice(1), `${hex()}0`]) await refused('22023', () => register(f.accountId, hash, newKey()), f.accountId);
      const code = await mintCode(f, f.o1);
      for (const tier of ['none', 'Container', '']) await refused('22023', () => register(f.accountId, code, newKey(), tier), f.accountId);
    });

    it('refuses a key that is already registered, and leaves the code unused', async () => {
      const f = await freshAccount();
      const g = await freshAccount();
      const key = newKey();
      await register(f.accountId, await mintCode(f, f.o1), key);
      const again = await mintCode(g, g.o1);
      await refused('23505', () => register(g.accountId, again, key), f.accountId, g.accountId);
    });

    // 0757 (D#6 R2b criterion 12): the caller passes the limit it read from the plan data; the function only enforces the number.
    it('refuses the registration that would pass the limit it is given; a revoked runner frees a slot', async () => {
      const f = await freshAccount();
      const first = await register(f.accountId, await mintCode(f, f.o1), newKey(), null, 2);
      await register(f.accountId, await mintCode(f, f.o1), newKey(), null, 2);
      const third = await mintCode(f, f.o1);
      await refused('53400', () => register(f.accountId, third, newKey(), null, 2), f.accountId);
      expect((await admin.query('SELECT used_at FROM runner_registration_codes WHERE code_sha256 = $1', [third])).rows[0].used_at).toBeNull();
      await revoke(f.accountId, f.o1, first);
      await register(f.accountId, third, newKey(), null, 2);
    });

    it('does not read accounts.plan any more: a plan of the string runner with no limit given is not limited, and a limit of 0 refuses the first', async () => {
      const f = await freshAccount();
      await admin.query(`UPDATE accounts SET plan = 'runner' WHERE id = $1`, [f.accountId]);
      for (let i = 0; i < 3; i++) await register(f.accountId, await mintCode(f, f.o1), newKey());
      expect((await admin.query('SELECT count(*)::int AS n FROM runners WHERE account_id = $1', [f.accountId])).rows[0].n).toBe(3);
      const g = await freshAccount();
      const code = await mintCode(g, g.o1);
      await refused('53400', () => register(g.accountId, code, newKey(), null, 0), g.accountId);
    });

    it('has no default for the limit: a three-argument call finds no function (42883) instead of registering without a cap', async () => {
      const f = await freshAccount();
      const code = await mintCode(f, f.o1);
      const call = (): Promise<unknown> =>
        withTenant(appPool, f.accountId, async (c) => c.query('SELECT runner_register($1, $2::jsonb, NULL) AS id', [code, JSON.stringify(newKey())]));
      await refused('42883', call, f.accountId);
      expect((await admin.query('SELECT used_at FROM runner_registration_codes WHERE code_sha256 = $1', [code])).rows[0].used_at).toBeNull();
      expect((await admin.query('SELECT count(*)::int AS n FROM runners WHERE account_id = $1', [f.accountId])).rows[0].n).toBe(0);
    });

    it('refuses a negative limit as an invalid argument and leaves the code unused', async () => {
      const f = await freshAccount();
      const code = await mintCode(f, f.o1);
      await refused('22023', () => register(f.accountId, code, newKey(), null, -1), f.accountId);
      expect((await admin.query('SELECT used_at FROM runner_registration_codes WHERE code_sha256 = $1', [code])).rows[0].used_at).toBeNull();
    });

    it('holds the limit when registrations race', async () => {
      const f = await freshAccount();
      const codes: string[] = [];
      for (let i = 0; i < 6; i++) codes.push(await mintCode(f, f.o1));
      const results = await Promise.allSettled(codes.map((code) => register(f.accountId, code, newKey(), null, 2)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['53400', '53400', '53400', '53400']);
      expect((await admin.query('SELECT count(*)::int AS n FROM runners WHERE account_id = $1', [f.accountId])).rows[0].n).toBe(2);
    });

    // 0732 (CWE-367): the minter's membership row is locked FOR SHARE, so a demotion cannot slip between the check and the insert.
    describe('against a demotion of its minter at the same moment (0732)', () => {
      const demote = (accountId: string, userId: string, role = 'member') => admin.query(`UPDATE account_members SET role = $3 WHERE account_id = $1 AND user_id = $2`, [accountId, userId, role]);
      /** Waits until some backend is blocked on a lock whose statement matches `like`. */
      async function waitForLockWait(like: string): Promise<void> {
        for (let i = 0; i < 200; i++) {
          if ((await admin.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`, [like])).rowCount) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`nothing blocked on a lock matching ${like}`);
      }

      it('a registration that has checked its minter holds the minter, so a demotion waits for it and then revokes the new runner', async () => {
        const f = await freshAccount();
        const code = await mintCode(f, f.a1);
        const reg = await appPool.connect();
        const other = await adminPool.connect();
        try {
          await reg.query('BEGIN');
          await reg.query(`SELECT set_config('app.account_id', $1, true)`, [f.accountId]);
          const id = (await reg.query<{ id: string }>('SELECT runner_register($1, $2::jsonb, NULL, NULL) AS id', [code, JSON.stringify(newKey())])).rows[0]!.id;
          // The registration is open and uncommitted. A demotion of the minter cannot proceed.
          await other.query(`SET lock_timeout = '400ms'`);
          let refusedByLock: { code?: string } | undefined;
          try {
            await other.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [f.accountId, f.a1]);
          } catch (error) {
            refusedByLock = error as { code?: string };
          }
          expect(refusedByLock?.code, 'the demotion should have waited on the registration').toBe('55P03');
          await other.query('RESET lock_timeout');
          await reg.query('COMMIT');
          // Now it goes through, and its trigger sees the runner the registration committed.
          await demote(f.accountId, f.a1);
          expect((await runnerRow(id)).revoked_reason).toBe('member_demoted');
        } finally {
          await reg.query('ROLLBACK').catch(() => undefined);
          reg.release();
          other.release();
        }
      });

      it('a demotion that is already under way is waited for, and the registration is then refused with no runner and an unused code', async () => {
        const f = await freshAccount();
        const code = await mintCode(f, f.a1);
        const demoting = await adminPool.connect();
        try {
          await demoting.query('BEGIN');
          await demoting.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [f.accountId, f.a1]);
          const attempt = register(f.accountId, code, newKey()).then(() => 'registered', (error: { code?: string }) => error.code);
          await waitForLockWait('%runner_register%');
          await demoting.query('COMMIT');
          expect(await attempt).toBe('P0002');
        } finally {
          await demoting.query('ROLLBACK').catch(() => undefined);
          demoting.release();
        }
        expect((await admin.query('SELECT count(*)::int AS n FROM runners WHERE account_id = $1', [f.accountId])).rows[0].n).toBe(0);
        expect((await admin.query('SELECT used_at FROM runner_registration_codes WHERE code_sha256 = $1', [code])).rows[0].used_at).toBeNull();
      });

      it('a demotion that is rolled back leaves the registration standing', async () => {
        const f = await freshAccount();
        const code = await mintCode(f, f.a1);
        const demoting = await adminPool.connect();
        let attempt: Promise<string>;
        try {
          await demoting.query('BEGIN');
          await demoting.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [f.accountId, f.a1]);
          attempt = register(f.accountId, code, newKey());
          await waitForLockWait('%runner_register%');
          await demoting.query('ROLLBACK');
        } finally {
          demoting.release();
        }
        const id = await attempt;
        expect((await runnerRow(id)).registered_by).toBe(f.a1);
      });
    });
  });

  describe('runner_rotate_key', () => {
    async function registered(f: F2Fixture): Promise<{ id: string; key: Jwk }> {
      const key = newKey();
      return { id: await register(f.accountId, await mintCode(f, f.o1), key), key };
    }

    it('replaces the key of an active runner, stamps key_rotated_at and writes one audit row', async () => {
      const f = await freshAccount();
      const { id, key } = await registered(f);
      const next = newKey();
      expect(await rotate(f.accountId, id, thumbprint(key), next)).toBe(thumbprint(next));
      const row = await runnerRow(id);
      expect(row.jkt).toBe(thumbprint(next));
      expect(row.public_key_jwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: next.x });
      expect(row.key_rotated_at).not.toBeNull();
      const audit = await auditRows(f.accountId, 'runner.key_rotated');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor: `runner:${id}`, payload: { runner_id: id, old_jkt: thumbprint(key), new_jkt: thumbprint(next) } });
      // The old key no longer matches, so the same call again is refused.
      await refused('42501', () => rotate(f.accountId, id, thumbprint(key), newKey()), f.accountId);
    });

    it("refuses another account's runner", async () => {
      const f = await freshAccount();
      const g = await freshAccount();
      const { id, key } = await registered(f);
      await refused('P0002', () => rotate(g.accountId, id, thumbprint(key), newKey()), f.accountId, g.accountId);
    });

    it('refuses a revoked runner', async () => {
      const f = await freshAccount();
      const { id, key } = await registered(f);
      await revoke(f.accountId, f.o1, id);
      await refused('55000', () => rotate(f.accountId, id, thumbprint(key), newKey()), f.accountId);
    });

    it('refuses a wrong current key, an unchanged key and a malformed key', async () => {
      const f = await freshAccount();
      const { id, key } = await registered(f);
      await refused('42501', () => rotate(f.accountId, id, thumbprint(newKey()), newKey()), f.accountId);
      await refused('22023', () => rotate(f.accountId, id, thumbprint(key), key), f.accountId);
      await refused('22023', () => rotate(f.accountId, id, thumbprint(key), { ...newKey(), d: 'x' }), f.accountId);
      await refused('22023', () => rotate(f.accountId, id, thumbprint(key), { kty: 'OKP', crv: 'Ed25519', x: 'short' }), f.accountId);
      await refused('22023', () => rotate(f.accountId, id, 'not-a-thumbprint', newKey()), f.accountId);
    });

    it('refuses a key another runner already has', async () => {
      const f = await freshAccount();
      const one = await registered(f);
      const two = await registered(f);
      await refused('23505', () => rotate(f.accountId, one.id, thumbprint(one.key), two.key), f.accountId);
    });

    it('refuses a member session that is not the runner: no app.runner_id, or another runner\'s id', async () => {
      const f = await freshAccount();
      const one = await registered(f);
      const two = await registered(f);
      await refused('42501', () => rotate(f.accountId, one.id, thumbprint(one.key), newKey(), null, f.m1), f.accountId);
      await refused('42501', () => rotate(f.accountId, one.id, thumbprint(one.key), newKey(), null, f.o1), f.accountId);
      await refused('42501', () => rotate(f.accountId, one.id, thumbprint(one.key), newKey(), two.id, f.m1), f.accountId);
      await refused('42501', () => rotate(f.accountId, one.id, thumbprint(one.key), newKey(), '', f.m1), f.accountId);
      await refused('42501', () => rotate(f.accountId, one.id, thumbprint(one.key), newKey(), 'not-a-uuid', f.m1), f.accountId);
      // The correct runner id succeeds, with or without a user in the session.
      await rotate(f.accountId, one.id, thumbprint(one.key), newKey(), one.id, f.m1);
    });

    it('refuses with no tenant context', async () => {
      const f = await freshAccount();
      const { id, key } = await registered(f);
      const client = await appPool.connect();
      try {
        await refused('42501', () => client.query('SELECT runner_rotate_key($1, $2, $3::jsonb)', [id, thumbprint(key), JSON.stringify(newKey())]), f.accountId);
      } finally {
        client.release();
      }
    });
  });

  describe('runner_self_revoke', () => {
    it('revokes the runner named by app.runner_id, stamps the reason and writes one audit row', async () => {
      const f = await freshAccount();
      const id = await insertRunner(admin, f.accountId, f.a1);
      await selfRevoke(f.accountId, id);
      expect(await runnerRow(id)).toMatchObject({ revoked_reason: 'runner_self' });
      expect((await runnerRow(id)).revoked_at).not.toBeNull();
      const audit = await auditRows(f.accountId, 'runner.revoked');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor: `runner:${id}`, payload: { runner_id: id, reason: 'runner_self', registered_by: f.a1 } });
    });

    it('refuses when app.runner_id is unset, empty or malformed', async () => {
      const f = await freshAccount();
      await insertRunner(admin, f.accountId, f.a1);
      for (const as of [null, '', 'nope']) await refused('42501', () => selfRevoke(f.accountId, as), f.accountId);
    });

    it("cannot revoke another account's runner, and refuses a runner that does not exist", async () => {
      const f = await freshAccount();
      const g = await freshAccount();
      const id = await insertRunner(admin, g.accountId, g.o1);
      await refused('P0002', () => selfRevoke(f.accountId, id), f.accountId, g.accountId);
      await refused('P0002', () => selfRevoke(f.accountId, randomUUID()), f.accountId, g.accountId);
      expect((await runnerRow(id)).revoked_at).toBeNull();
    });

    it('refuses an already revoked runner and keeps its original revocation', async () => {
      const f = await freshAccount();
      const id = await insertRunner(admin, f.accountId, f.a1);
      await revoke(f.accountId, f.o1, id, 'compromised');
      const before = await runnerRow(id);
      await refused('55000', () => selfRevoke(f.accountId, id), f.accountId);
      expect(await runnerRow(id)).toEqual(before);
    });

    it('refuses with no tenant context', async () => {
      const f = await freshAccount();
      const id = await insertRunner(admin, f.accountId, f.a1);
      const client = await appPool.connect();
      try {
        await client.query(`SELECT set_config('app.runner_id', $1, false)`, [id]);
        await refused('42501', () => client.query('SELECT runner_self_revoke()'), f.accountId);
        await client.query('RESET app.runner_id');
      } finally {
        client.release();
      }
    });
  });

  describe('runner_revoke', () => {
    it.each([
      ['an owner', (f: F2Fixture) => f.o2],
      ['an admin', (f: F2Fixture) => f.a2],
    ])('%s may revoke any runner of the account', async (_label, who) => {
      const f = await freshAccount();
      const id = await insertRunner(admin, f.accountId, f.a1);
      await revoke(f.accountId, who(f), id, 'compromised');
      expect(await runnerRow(id)).toMatchObject({ revoked_reason: 'compromised' });
      expect((await runnerRow(id)).revoked_at).not.toBeNull();
      const audit = await auditRows(f.accountId, 'runner.revoked');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor: who(f), payload: { runner_id: id, reason: 'compromised', registered_by: f.a1 } });
    });

    it('the registrant may revoke their own runner even when they are a plain member', async () => {
      const f = await freshAccount();
      const id = await insertRunner(admin, f.accountId, f.m1);
      await revoke(f.accountId, f.m1, id, 'revoke_all');
      expect(await runnerRow(id)).toMatchObject({ revoked_reason: 'revoke_all' });
    });

    it("a member who is not the registrant is refused, and so is a revoke of another registrant's runner", async () => {
      const f = await freshAccount();
      const id = await insertRunner(admin, f.accountId, f.a1);
      await refused('42501', () => revoke(f.accountId, f.m2, id), f.accountId);
      await refused('42501', () => revoke(f.accountId, f.m1, id), f.accountId);
    });

    it("another account's runner is not found, even for that account's owner", async () => {
      const f = await freshAccount();
      const g = await freshAccount();
      const id = await insertRunner(admin, g.accountId, g.o1);
      await refused('P0002', () => revoke(f.accountId, f.o1, id), f.accountId, g.accountId);
      // Naming a user of the other account does not help: the session user must be a member of the session account.
      await refused('42501', () => revoke(f.accountId, g.o1, id), f.accountId, g.accountId);
    });

    it('an already revoked runner is refused and keeps its original revocation', async () => {
      const f = await freshAccount();
      const id = await insertRunner(admin, f.accountId, f.a1);
      await revoke(f.accountId, f.o1, id, 'compromised');
      const before = await runnerRow(id);
      await refused('55000', () => revoke(f.accountId, f.o1, id, 'revoked'), f.accountId);
      expect(await runnerRow(id)).toEqual(before);
    });

    it('refuses a reason outside the list and a session with no user', async () => {
      const f = await freshAccount();
      const id = await insertRunner(admin, f.accountId, f.a1);
      for (const reason of ['', 'Revoked', 'member_demoted', 'x'.repeat(500)]) await refused('22023', () => revoke(f.accountId, f.o1, id, reason), f.accountId);
      await refused('42501', () => withTenant(appPool, f.accountId, (c) => c.query(`SELECT runner_revoke($1, 'revoked')`, [id])), f.accountId);
    });
  });

  describe('revoking a member below admin revokes their runners, in the same transaction', () => {
    const demote = (accountId: string, actor: string, target: string, role: string): Promise<unknown> =>
      withTenant(appPool, accountId, actor, (c) => c.query('UPDATE account_members SET role = $1 WHERE account_id = $2 AND user_id = $3', [role, accountId, target]));

    it('demoting a registrant to member revokes their runners, writes an audit row each, and leaves other runners alone', async () => {
      const f = await freshAccount();
      const mine1 = await insertRunner(admin, f.accountId, f.a1);
      const mine2 = await insertRunner(admin, f.accountId, f.a1);
      const theirs = await insertRunner(admin, f.accountId, f.a2);
      const earlier = await insertRunner(admin, f.accountId, f.a1);
      await revoke(f.accountId, f.o1, earlier, 'compromised');
      const earlierRow = await runnerRow(earlier);
      await demote(f.accountId, f.o1, f.a1, 'member');
      for (const id of [mine1, mine2]) expect(await runnerRow(id)).toMatchObject({ revoked_reason: 'member_demoted' });
      expect((await runnerRow(mine1)).revoked_at).not.toBeNull();
      expect((await runnerRow(theirs)).revoked_at).toBeNull();
      expect(await runnerRow(earlier)).toEqual(earlierRow);
      const audit = (await auditRows(f.accountId, 'runner.revoked')).filter((r) => r.payload.reason === 'member_demoted');
      expect(audit.map((r) => r.payload.runner_id).sort()).toEqual([mine1, mine2].sort());
      expect(audit.every((r) => r.actor === f.o1)).toBe(true);
    });

    it('removing a registrant revokes their runners', async () => {
      const f = await freshAccount();
      const id = await insertRunner(admin, f.accountId, f.a1);
      await withTenant(appPool, f.accountId, f.o1, (c) => c.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [f.accountId, f.a1]));
      expect(await runnerRow(id)).toMatchObject({ revoked_reason: 'member_demoted' });
      expect((await runnerRow(id)).revoked_at).not.toBeNull();
    });

    it('a rolled back demotion leaves the runner unrevoked, and the role as it was', async () => {
      const f = await freshAccount();
      const id = await insertRunner(admin, f.accountId, f.a1);
      await expect(
        withTenant(appPool, f.accountId, f.o1, async (c) => {
          await c.query('UPDATE account_members SET role = $1 WHERE account_id = $2 AND user_id = $3', ['member', f.accountId, f.a1]);
          // Inside the transaction the revocation is already visible, which is what "same transaction" means.
          expect((await c.query('SELECT revoked_at FROM runners WHERE id = $1', [id])).rows[0].revoked_at).not.toBeNull();
          throw new Error('abort the demotion');
        }),
      ).rejects.toThrow('abort the demotion');
      expect((await runnerRow(id)).revoked_at).toBeNull();
      expect((await runnerRow(id)).revoked_reason).toBeNull();
      expect((await admin.query('SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2', [f.accountId, f.a1])).rows[0].role).toBe('admin');
      expect(await auditRows(f.accountId, 'runner.revoked')).toEqual([]);
    });

    it('a change that keeps the member an owner or admin revokes nothing', async () => {
      const f = await freshAccount();
      const adminRunner = await insertRunner(admin, f.accountId, f.a1);
      const ownerRunner = await insertRunner(admin, f.accountId, f.o2);
      const memberRunner = await insertRunner(admin, f.accountId, f.m1);
      await demote(f.accountId, f.o1, f.o2, 'admin');
      await demote(f.accountId, f.o1, f.a1, 'owner');
      await demote(f.accountId, f.o1, f.m1, 'admin');
      for (const id of [adminRunner, ownerRunner, memberRunner]) expect((await runnerRow(id)).revoked_at).toBeNull();
    });

    it("a registrant's runners in another account are not touched", async () => {
      const f = await freshAccount();
      const g = await freshAccount();
      await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [g.accountId, f.a1, 'admin']);
      const there = await insertRunner(admin, g.accountId, f.a1);
      const here = await insertRunner(admin, f.accountId, f.a1);
      await demote(f.accountId, f.o1, f.a1, 'member');
      expect((await runnerRow(here)).revoked_at).not.toBeNull();
      expect((await runnerRow(there)).revoked_at).toBeNull();
    });
  });

  describe('privileges', () => {
    it('app_user still cannot INSERT, UPDATE or DELETE runners directly', async () => {
      const f = await freshAccount();
      const id = await insertRunner(admin, f.accountId, f.o1);
      const attempts: Array<[string, unknown[]]> = [
        [`INSERT INTO runners (account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, '{"kty":"OKP","crv":"Ed25519","x":"x"}', 'x', 'api_key')`, [f.accountId, f.o1]],
        ['UPDATE runners SET revoked_at = NULL WHERE id = $1', [id]],
        ['UPDATE runners SET jkt = $2 WHERE id = $1', [id, 'A'.repeat(43)]],
        ['DELETE FROM runners WHERE id = $1', [id]],
      ];
      for (const [sql, params] of attempts) {
        await expect(withTenant(appPool, f.accountId, f.o1, (c) => c.query(sql, params)), sql).rejects.toMatchObject({ code: '42501' });
      }
      await expect(withTenant(appPool, f.accountId, f.o1, (c) => c.query('UPDATE runner_registration_codes SET used_at = NULL'))).rejects.toMatchObject({ code: '42501' });
    });

    it('the definers are SECURITY DEFINER, owned by platform_ops, with a pinned search_path; EXECUTE is for app_user (three) and nobody else', async () => {
      const { rows } = await admin.query<{ name: string; secdef: boolean; owner: string; config: string[] | null; to_public: boolean; app_user: boolean; writer: boolean }>(
        `SELECT p.proname AS name, p.prosecdef AS secdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
                EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS to_public,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
                has_function_privilege('agent_run_writer', p.oid, 'EXECUTE') AS writer
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('runner_register', 'runner_rotate_key', 'runner_revoke', 'runner_self_revoke', 'runner_key_thumbprint', 'runner_revoke_on_member_change_apply')`,
      );
      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
      expect(Object.keys(byName).sort()).toEqual(['runner_key_thumbprint', 'runner_register', 'runner_revoke', 'runner_revoke_on_member_change_apply', 'runner_rotate_key', 'runner_self_revoke']);
      for (const r of rows) {
        // The trigger helper is owned by the NOLOGIN guard_definer (0720): platform_ops owning it could neuter it.
        expect(r.owner, r.name).toBe(r.name === 'runner_revoke_on_member_change_apply' ? 'guard_definer' : 'platform_ops');
        expect(r.to_public, r.name).toBe(false);
        expect(r.writer, r.name).toBe(false);
        expect(r.config?.some((c) => c.startsWith('search_path=pg_catalog')), r.name).toBe(true);
        if (r.name !== 'runner_key_thumbprint') expect(r.secdef, r.name).toBe(true);
      }
      for (const name of ['runner_register', 'runner_rotate_key', 'runner_revoke', 'runner_self_revoke']) expect(byName[name]!.app_user, name).toBe(true);
      expect(byName['runner_key_thumbprint']!.app_user).toBe(false);
      // The trigger helper is called by the invoker trigger function, so app_user (which writes account_members) needs EXECUTE (0720).
      expect(byName['runner_revoke_on_member_change_apply']!.app_user).toBe(true);
    });
  });
});
