import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const hex = (): string => randomBytes(32).toString('hex');
const x43 = (): string => randomBytes(32).toString('base64url');
const FACTS = { os: 'linux', arch: 'x64', kvm: true, hostname: 'build-box-1', ip_country: 'DE' };

interface Started {
  device: string;
  user: string;
  jkt: string;
  x: string;
}

/** ON-2 (migration 1037): the device-flow definers, their limits, and what an app session can and cannot reach. */
describe('device registration definers [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let adminA: string;
  let memberA: string;
  let adminB: string;

  const as = <T>(account: string, user: string, fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, account, user, fn);
  const person = (acct: SeedRefs, user = acct.userId) => <T>(fn: (c: PoolClient) => Promise<T>) => as(acct.accountId, user, fn);
  const start = async (o: { ip?: string; ipLimit?: number; globalLimit?: number; facts?: unknown; x?: string } = {}): Promise<Started> => {
    const s: Started = { device: hex(), user: hex(), jkt: x43(), x: o.x ?? x43() };
    await appPool.query('SELECT runner_device_start($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8)', [
      s.device, s.user, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: s.x }), s.jkt, JSON.stringify(o.facts ?? FACTS), o.ip ?? hex(), o.ipLimit ?? 10, o.globalLimit ?? 100000,
    ]);
    return s;
  };
  const lookup = async (acct: SeedRefs, hash: string, user = acct.userId) => (await person(acct, user)((c) => c.query('SELECT outcome, facts, expires_at FROM runner_device_lookup($1)', [hash]))).rows[0];
  const approve = async (acct: SeedRefs, hash: string, o: { max?: number; name?: string | null; user?: string } = {}) =>
    (await person(acct, o.user)((c) => c.query('SELECT outcome, runner_id FROM runner_device_approve($1, $2, $3)', [hash, o.name ?? null, o.max ?? 1000]))).rows[0];
  const deny = async (acct: SeedRefs, hash: string) => (await person(acct)((c) => c.query('SELECT runner_device_deny($1) AS outcome', [hash]))).rows[0].outcome as string;
  const poll = async (s: Started, jkt = s.jkt, interval = 5) => (await appPool.query('SELECT outcome, runner_id, account_id, credential_mode FROM runner_device_poll($1, $2, $3)', [s.device, jkt, interval])).rows[0];
  const codeRow = async (s: Started) => (await admin.query('SELECT * FROM runner_device_codes WHERE user_code_hash = $1', [s.user])).rows[0];
  const addUser = async (acct: SeedRefs, role: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [acct.accountId, id, role]);
    return id;
  };
  const wrongAttempts = async (acct: SeedRefs, n: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push((await lookup(acct, hex())).outcome);
    return out;
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    adminA = await addUser(a, 'admin');
    memberA = await addUser(a, 'member');
    adminB = await addUser(b, 'admin');
  });
  // Wrong-code attempts are state a test sets up for itself; none carries over to the next.
  beforeEach(async () => {
    await admin.query('DELETE FROM runner_device_attempts WHERE account_id IN ($1, $2)', [a.accountId, b.accountId]);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool]) await p.end();
  });

  describe('start', () => {
    it('stores a pending code with no account, the key, the closed facts and a 10 minute life', async () => {
      const s = await start();
      const r = await codeRow(s);
      expect(r).toMatchObject({ status: 'pending', account_id: null, approved_by: null, runner_id: null, jkt: s.jkt, facts: FACTS });
      expect(r.public_key_jwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: s.x });
      expect(r.expires_at.getTime() - r.created_at.getTime()).toBe(600_000);
      expect(r.device_code_hash).toBe(s.device);
    });

    it('a unique violation on either hash is 23505 (the caller draws again) and stores nothing', async () => {
      const s = await start();
      for (const [device, user] of [[s.device, hex()], [hex(), s.user]]) {
        await expect(appPool.query('SELECT runner_device_start($1, $2, $3::jsonb, $4, $5::jsonb, $6, 10, 1000)', [device, user, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: x43() }), x43(), JSON.stringify(FACTS), hex()])).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      }
    });

    it('refuses a fact the closed shape does not name, and a plaintext-looking hash', async () => {
      await expect(start({ facts: { ...FACTS, extra: 'x' } })).rejects.toMatchObject({ code: '23514' });
      await expect(appPool.query('SELECT runner_device_start($1, $2, $3::jsonb, $4, $5::jsonb, $6, 10, 1000)', ['BCDF-GHJK', hex(), '{}', x43(), JSON.stringify(FACTS), hex()])).rejects.toMatchObject({ code: '22023' });
    });

    it('limits one address to 10 starts an hour, refuses the 11th and stores nothing, and leaves another address alone', async () => {
      const ip = hex();
      for (let i = 0; i < 10; i++) await start({ ip });
      const before = (await admin.query('SELECT count(*)::int AS n FROM runner_device_codes WHERE start_ip_hash = $1', [ip])).rows[0].n;
      await expect(start({ ip })).rejects.toMatchObject({ code: '53400' });
      expect((await admin.query('SELECT count(*)::int AS n FROM runner_device_codes WHERE start_ip_hash = $1', [ip])).rows[0].n).toBe(before);
      await expect(start({ ip: hex() })).resolves.toBeTruthy();
    });

    it('an address\'s count is of the last hour only: a start 61 minutes old does not count', async () => {
      const ip = hex();
      for (let i = 0; i < 10; i++) await start({ ip });
      await admin.query(`UPDATE runner_device_codes SET created_at = now() - interval '61 minutes', expires_at = now() - interval '51 minutes' WHERE start_ip_hash = $1`, [ip]);
      await expect(start({ ip })).resolves.toBeTruthy();
    });

    it('limits all addresses together to the figure passed in, counted on stored rows over the last hour', async () => {
      const total = (await admin.query(`SELECT count(*)::int AS n FROM runner_device_codes WHERE created_at > now() - interval '1 hour'`)).rows[0].n;
      await expect(start({ globalLimit: total })).rejects.toMatchObject({ code: '53400' });
      await expect(start({ globalLimit: total + 1 })).resolves.toBeTruthy();
    });
  });

  describe('lookup, approve, deny: only an owner or admin of an active account', () => {
    it('a member, a stranger with no session and a suspended account get 42501', async () => {
      const s = await start();
      await expect(lookup(a, s.user, memberA)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(approve(a, s.user, { user: memberA })).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(person(a, memberA)((c) => c.query('SELECT runner_device_deny($1)', [s.user]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      // A user who is an admin of B only, acting in A's tenant context: not a member of A.
      await expect(lookup(a, s.user, adminB)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(appPool.query('SELECT * FROM runner_device_lookup($1)', [s.user])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(appPool.query('SELECT * FROM runner_device_approve($1, NULL, 10)', [s.user])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await codeRow(s)).status).toBe('pending');
    });

    it('an admin looks a pending code up and gets its facts and expiry; the code stays pending and unowned', async () => {
      const s = await start();
      const r = await lookup(a, s.user, adminA);
      expect(r.outcome).toBe('ok');
      expect(r.facts).toEqual(FACTS);
      expect(r.expires_at.getTime()).toBeGreaterThan(Date.now());
      expect(await codeRow(s)).toMatchObject({ status: 'pending', account_id: null });
    });

    it('an expired code and a denied code are gone, not counted as wrong attempts', async () => {
      const expired = await start();
      await admin.query(`UPDATE runner_device_codes SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE user_code_hash = $1`, [expired.user]);
      const denied = await start();
      expect(await deny(a, denied.user)).toBe('ok');
      const before = (await admin.query('SELECT count(*)::int AS n FROM runner_device_attempts WHERE account_id = $1', [a.accountId])).rows[0].n;
      expect((await lookup(a, expired.user)).outcome).toBe('gone');
      expect((await lookup(a, denied.user)).outcome).toBe('gone');
      expect((await approve(a, expired.user)).outcome).toBe('gone');
      expect((await approve(a, denied.user)).outcome).toBe('gone');
      expect((await admin.query('SELECT count(*)::int AS n FROM runner_device_attempts WHERE account_id = $1', [a.accountId])).rows[0].n).toBe(before);
    });

    it('the sixth wrong code in 15 minutes is limited, and so is a right code after it; another account is untouched', async () => {
      const ownerB = { ...b };
      const good = await start();
      expect(await wrongAttempts(a, 6)).toEqual(['not_found', 'not_found', 'not_found', 'not_found', 'not_found', 'limited']);
      expect((await lookup(a, good.user)).outcome).toBe('limited');
      expect((await approve(a, good.user)).outcome).toBe('limited');
      expect(await deny(a, good.user)).toBe('limited');
      expect((await codeRow(good)).status).toBe('pending');
      // Account B has made none: its first wrong code is an ordinary not_found, and its lookup of the same code works.
      expect((await lookup(ownerB, hex())).outcome).toBe('not_found');
      expect((await lookup(ownerB, good.user)).outcome).toBe('ok');
      // Attempts older than 15 minutes stop counting.
      await admin.query(`UPDATE runner_device_attempts SET created_at = now() - interval '16 minutes' WHERE account_id = $1`, [a.accountId]);
      expect((await lookup(a, good.user)).outcome).toBe('ok');
    });

    it('B\'s wrong codes never count against A, in B\'s own row set (a second account with attempts of its own)', async () => {
      await admin.query('DELETE FROM runner_device_attempts WHERE account_id IN ($1, $2)', [a.accountId, b.accountId]);
      expect(await wrongAttempts(b, 6)).toContain('limited');
      expect(await wrongAttempts(a, 5)).toEqual(Array(5).fill('not_found'));
      expect((await admin.query('SELECT count(*)::int AS n FROM runner_device_attempts WHERE account_id = $1', [a.accountId])).rows[0].n).toBe(5);
      await admin.query('DELETE FROM runner_device_attempts WHERE account_id IN ($1, $2)', [a.accountId, b.accountId]);
    });
  });

  /**
   * The policies on runner_device_attempts and account_members apply the same account filter as the definers, so a missing predicate in a
   * definer would leave every other test green. Each test relaxes the policy inside a rolled-back admin transaction (the pattern of
   * machine-tables.pg.test.ts) so the function's own predicate is the only thing standing.
   */
  describe('the definers\' own account predicates, with the policies relaxed', () => {
    const rolledBack = async (fn: () => Promise<void>) => {
      await admin.query('BEGIN');
      try {
        await fn();
      } finally {
        await admin.query('ROLLBACK');
      }
    };
    const session = (account: string, user: string) =>
      admin.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [account, user]);
    const callAll = (hash: string) =>
      [
        async () => (await admin.query('SELECT outcome FROM runner_device_lookup($1)', [hash])).rows[0].outcome as string,
        async () => (await admin.query('SELECT outcome FROM runner_device_approve($1, NULL, 1000)', [hash])).rows[0].outcome as string,
        async () => (await admin.query('SELECT runner_device_deny($1) AS outcome', [hash])).rows[0].outcome as string,
      ] as const;

    it('another account\'s six wrong attempts are not counted: lookup, approve and deny each answer not_found, not limited', async () => {
      await rolledBack(async () => {
        await admin.query(`ALTER POLICY onboarding_ops_device ON runner_device_attempts USING (true) WITH CHECK (true)`);
        for (let i = 0; i < 6; i++) await admin.query('INSERT INTO runner_device_attempts (account_id) VALUES ($1)', [b.accountId]);
        await session(a.accountId, adminA);
        for (const call of callAll(hex())) expect(await call()).toBe('not_found');
        // A's own attempts are still the ones that count: three were just made, B's six are invisible to it.
        expect((await admin.query('SELECT count(*)::int AS n FROM runner_device_attempts WHERE account_id = $1', [a.accountId])).rows[0].n).toBe(3);
      });
    });

    it('a user who is admin of another account only is refused by lookup, approve and deny in this account\'s context: 42501', async () => {
      const s = await start();
      await rolledBack(async () => {
        await admin.query(`ALTER POLICY onboarding_ops_device_select ON account_members USING (true)`);
        await admin.query(`ALTER POLICY onboarding_ops_device_lock ON account_members USING (true) WITH CHECK (false)`);
        await session(a.accountId, adminB);
        for (const call of callAll(s.user)) {
          await admin.query('SAVEPOINT one');
          await expect(call()).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
          await admin.query('ROLLBACK TO SAVEPOINT one');
        }
      });
      expect((await codeRow(s)).status).toBe('pending');
    });
  });

  describe('concurrent wrong codes', () => {
    it('40 wrong lookups at once from one account make 6 searches at most: 5 not_found and 6 attempt rows, every other call limited', async () => {
      const outcomes = await Promise.all(Array.from({ length: 40 }, () => lookup(a, hex()).then((r) => r.outcome as string)));
      expect(outcomes.filter((o) => o === 'not_found')).toHaveLength(5);
      expect(outcomes.filter((o) => o === 'limited')).toHaveLength(35);
      expect((await admin.query('SELECT count(*)::int AS n FROM runner_device_attempts WHERE account_id = $1', [a.accountId])).rows[0].n).toBe(6);
    });

    it('the same holds when lookup, approve and deny are mixed', async () => {
      const calls = Array.from({ length: 40 }, (_, i) =>
        i % 3 === 0 ? lookup(a, hex()).then((r) => r.outcome as string) : i % 3 === 1 ? approve(a, hex()).then((r) => r.outcome as string) : deny(a, hex()),
      );
      const outcomes = await Promise.all(calls);
      expect(outcomes.filter((o) => o === 'not_found')).toHaveLength(5);
      expect(outcomes.filter((o) => o === 'limited')).toHaveLength(35);
      expect((await admin.query('SELECT count(*)::int AS n FROM runner_device_attempts WHERE account_id = $1', [a.accountId])).rows[0].n).toBe(6);
    });
  });

  describe('approve', () => {
    it('creates the runner with no repositories, in the approver\'s account, bound to the key; audits it; the code is approved and owned', async () => {
      await admin.query('DELETE FROM runner_device_attempts WHERE account_id = $1', [a.accountId]);
      const s = await start();
      const r = await approve(a, s.user, { name: 'Build box', user: adminA });
      expect(r.outcome).toBe('ok');
      const runner = (await admin.query('SELECT * FROM runners WHERE id = $1', [r.runner_id])).rows[0];
      expect(runner).toMatchObject({ account_id: a.accountId, registered_by: adminA, jkt: s.jkt, credential_mode: 'subscription', allowed_repo_ids: [] });
      expect(runner.public_key_jwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: s.x });
      expect((await admin.query('SELECT name FROM runner_settings WHERE runner_id = $1 AND account_id = $2', [r.runner_id, a.accountId])).rows).toEqual([{ name: 'Build box' }]);
      expect(await codeRow(s)).toMatchObject({ status: 'approved', account_id: a.accountId, approved_by: adminA, runner_id: r.runner_id });
      const audit = (await admin.query(`SELECT action, payload FROM audit_log WHERE account_id = $1 AND payload->>'runner_id' = $2 ORDER BY action`, [a.accountId, r.runner_id])).rows;
      expect(audit.map((x) => x.action)).toEqual(['runner.device_approved', 'runner.registered']);
      expect(JSON.stringify(audit)).not.toContain(s.user);
      expect(JSON.stringify(audit)).not.toContain(s.device);
    });

    it('is single use: a second approval of the same code is gone, and makes no second runner', async () => {
      const s = await start();
      const first = await approve(a, s.user);
      const runners = (await admin.query('SELECT count(*)::int AS n FROM runners WHERE account_id = $1', [a.accountId])).rows[0].n;
      expect((await approve(a, s.user)).outcome).toBe('gone');
      expect((await approve(b, s.user)).outcome).toBe('not_found');
      expect((await admin.query('SELECT count(*)::int AS n FROM runners WHERE account_id = $1', [a.accountId])).rows[0].n).toBe(runners);
      expect((await codeRow(s)).runner_id).toBe(first.runner_id);
    });

    it('another account cannot see, look up or deny a code account A approved or denied (an explicit account predicate on the code)', async () => {
      const s = await start();
      await approve(a, s.user);
      const t = await start();
      expect(await deny(a, t.user)).toBe('ok');
      for (const code of [s, t]) {
        await admin.query('DELETE FROM runner_device_attempts WHERE account_id = $1', [b.accountId]);
        expect((await lookup(b, code.user)).outcome).toBe('not_found');
        expect(await deny(b, code.user)).toBe('not_found');
        expect((await approve(b, code.user)).outcome).toBe('not_found');
      }
      expect((await admin.query('SELECT 1 FROM runner_device_codes WHERE account_id = $1 AND user_code_hash = $2', [b.accountId, s.user])).rows).toHaveLength(0);
      expect((await admin.query('SELECT 1 FROM runner_device_codes WHERE account_id = $1 AND user_code_hash = $2', [a.accountId, s.user])).rows).toHaveLength(1);
      await admin.query('DELETE FROM runner_device_attempts WHERE account_id = $1', [b.accountId]);
    });

    it('approving one code leaves a second pending code of the same account, and the account\'s other runner, as they were', async () => {
      const keep = await start();
      const other = await insertRunner(admin, a.accountId, a.userId);
      const s = await start();
      await approve(a, s.user);
      expect(await codeRow(keep)).toMatchObject({ status: 'pending', account_id: null, runner_id: null });
      expect((await admin.query('SELECT revoked_at FROM runners WHERE id = $1', [other])).rows[0].revoked_at).toBeNull();
    });

    it('answers runner_limit when the plan has no room, counting only this account\'s live runners, and leaves the code pending', async () => {
      const own = (await admin.query('SELECT count(*)::int AS n FROM runners WHERE account_id = $1 AND revoked_at IS NULL', [a.accountId])).rows[0].n;
      // B has a device-made runner of its own; it must not count against A.
      const sb = await start();
      await approve(b, sb.user);
      const s = await start();
      expect((await approve(a, s.user, { max: own })).outcome).toBe('runner_limit');
      expect((await codeRow(s)).status).toBe('pending');
      expect((await approve(a, s.user, { max: own + 1 })).outcome).toBe('ok');
    });

    it('answers key_registered when a runner already holds that key, and leaves the code pending', async () => {
      const first = await start();
      const second = await start({ x: first.x });
      await admin.query('UPDATE runner_device_codes SET jkt = $2 WHERE user_code_hash = $1', [second.user, first.jkt]);
      await approve(a, first.user);
      expect((await approve(a, second.user)).outcome).toBe('key_registered');
      expect((await codeRow(second)).status).toBe('pending');
    });
  });

  describe('deny', () => {
    it('makes the code denied, owned by the account, and audits it; the machine\'s poll is then denied', async () => {
      const s = await start();
      expect(await deny(a, s.user)).toBe('ok');
      expect(await codeRow(s)).toMatchObject({ status: 'denied', account_id: a.accountId, approved_by: null });
      expect((await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action = 'runner.device_denied' AND payload->>'device_code_id' = $2`, [a.accountId, (await codeRow(s)).id])).rows[0].n).toBe(1);
      expect((await poll(s)).outcome).toBe('denied');
      expect(await deny(a, s.user)).toBe('gone');
    });
  });

  describe('poll', () => {
    it('runner_device_key gives the key and nothing about the state', async () => {
      const s = await start();
      expect((await appPool.query('SELECT * FROM runner_device_key($1)', [s.device])).rows).toEqual([{ jkt: s.jkt, public_key_jwk: { kty: 'OKP', crv: 'Ed25519', x: s.x } }]);
      expect((await appPool.query('SELECT * FROM runner_device_key($1)', [hex()])).rows).toEqual([]);
    });

    it('pending, then slow_down inside the interval, then pending again once it has passed', async () => {
      const s = await start();
      expect((await poll(s)).outcome).toBe('pending');
      expect((await poll(s)).outcome).toBe('slow_down');
      expect((await poll(s)).outcome).toBe('slow_down');
      expect((await codeRow(s)).attempts).toBe(2);
      await admin.query(`UPDATE runner_device_codes SET last_polled_at = now() - interval '6 seconds' WHERE user_code_hash = $1`, [s.user]);
      expect((await poll(s)).outcome).toBe('pending');
    });

    it('hands the registration out once: approved with the stored row\'s ids, then consumed for every later poll', async () => {
      const s = await start();
      await poll(s);
      const approved = await approve(a, s.user);
      await admin.query(`UPDATE runner_device_codes SET last_polled_at = now() - interval '6 seconds' WHERE user_code_hash = $1`, [s.user]);
      expect(await poll(s)).toMatchObject({ outcome: 'approved', runner_id: approved.runner_id, account_id: a.accountId, credential_mode: 'subscription' });
      expect((await codeRow(s)).status).toBe('consumed');
      await admin.query(`UPDATE runner_device_codes SET last_polled_at = now() - interval '6 seconds' WHERE user_code_hash = $1`, [s.user]);
      expect((await poll(s)).outcome).toBe('consumed');
      expect((await poll(s)).outcome).toBe('consumed');
    });

    it('a poll with another key gets nothing and does not consume an approved code', async () => {
      const s = await start();
      await approve(a, s.user);
      expect((await poll(s, x43())).outcome).toBe('unknown');
      expect((await appPool.query('SELECT outcome FROM runner_device_poll($1, $2, 5)', [hex(), s.jkt])).rows[0].outcome).toBe('unknown');
      expect((await codeRow(s)).status).toBe('approved');
      expect((await poll(s)).outcome).toBe('approved');
    });

    it('an expired code is expired for the machine, and the row says so', async () => {
      const s = await start();
      await admin.query(`UPDATE runner_device_codes SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE user_code_hash = $1`, [s.user]);
      expect((await poll(s)).outcome).toBe('expired');
      expect((await codeRow(s)).status).toBe('expired');
      expect((await poll(s)).outcome).toBe('expired');
    });

    it('a runner revoked before the poll gets no registration, and the code is consumed', async () => {
      const s = await start();
      const r = await approve(a, s.user);
      await admin.query(`UPDATE runners SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1`, [r.runner_id]);
      expect((await poll(s)).outcome).toBe('denied');
      expect((await codeRow(s)).status).toBe('consumed');
    });

    it('reads the runner of its own code only: a second approved code of the same account and B\'s runner are never returned', async () => {
      const s1 = await start();
      const s2 = await start();
      const r1 = await approve(a, s1.user);
      const r2 = await approve(a, s2.user);
      const sb = await start();
      await approve(b, sb.user);
      expect((await poll(s1)).runner_id).toBe(r1.runner_id);
      expect((await poll(s2)).runner_id).toBe(r2.runner_id);
      expect((await poll(sb)).account_id).toBe(b.accountId);
    });
  });

  describe('what an app session can reach', () => {
    it('lists no pending code, whichever account it is, and cannot read a hash or the key even from its own code', async () => {
      const pending = await start();
      const mine = await start();
      await approve(a, mine.user);
      const seenByA = await as(a.accountId, a.userId, (c) => c.query('SELECT id, status FROM runner_device_codes'));
      expect(seenByA.rows.every((r) => r.status !== 'pending')).toBe(true);
      expect(seenByA.rows.map((r) => r.id)).toContain((await codeRow(mine)).id);
      expect(seenByA.rows.map((r) => r.id)).not.toContain((await codeRow(pending)).id);
      const seenByB = await as(b.accountId, b.userId, (c) => c.query('SELECT id FROM runner_device_codes'));
      expect(seenByB.rows.map((r) => r.id)).not.toContain((await codeRow(mine)).id);
      for (const col of ['user_code_hash', 'device_code_hash', 'jkt', 'public_key_jwk', 'start_ip_hash']) {
        await expect(as(a.accountId, a.userId, (c) => c.query(`SELECT ${col} FROM runner_device_codes`))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('cannot claim, change, add or remove a code, or touch the attempts table', async () => {
      const s = await start();
      const id = (await codeRow(s)).id;
      for (const sql of [
        `UPDATE runner_device_codes SET status = 'approved', account_id = '${a.accountId}', approved_by = '${a.userId}', approved_at = now() WHERE id = '${id}'`,
        `DELETE FROM runner_device_codes WHERE id = '${id}'`,
        `INSERT INTO runner_device_codes (device_code_hash, user_code_hash, jkt, public_key_jwk, facts, expires_at) VALUES ('${hex()}', '${hex()}', '${x43()}', '{}', '${JSON.stringify(FACTS)}', now() + interval '1 minute')`,
        'SELECT count(*) FROM runner_device_attempts',
        `INSERT INTO runner_device_attempts (account_id) VALUES ('${a.accountId}')`,
      ]) {
        await expect(as(a.accountId, a.userId, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      expect((await codeRow(s)).status).toBe('pending');
    });

    it('PUBLIC can execute none of the six definers; app_user can, and they run as onboarding_ops with a pinned search path', async () => {
      const r = await admin.query(`
        SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig::text AS cfg,
               has_function_privilege('app_user', p.oid, 'EXECUTE') AS app, has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
               EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public_exec
          FROM pg_proc p WHERE p.proname LIKE 'runner_device\\_%' AND p.proname NOT LIKE '%prune' AND p.proname <> 'runner_device_facts_valid' ORDER BY p.proname`);
      expect(r.rows.map((x) => x.proname)).toEqual(['runner_device_approve', 'runner_device_deny', 'runner_device_key', 'runner_device_lookup', 'runner_device_poll', 'runner_device_start']);
      for (const f of r.rows) expect(f).toMatchObject({ owner: 'onboarding_ops', prosecdef: true, app: true, ops: false, public_exec: false, cfg: '{"search_path=pg_catalog, public, pg_temp"}' });
    });
  });
});
