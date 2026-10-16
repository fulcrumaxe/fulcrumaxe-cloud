import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import {
  AapError, canonicalJson, cancelRequest, closeInstance, consumeRequest, createInstance, createRequest, decideRequest, envArgumentsKek,
  getRequest, issueCredential, openArguments, reportOutcome, sealArguments, sha256Hex, type ApprovalStatus, type ArgumentsKek,
} from '../src/aap.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#7 AAP-d1: migration 0837 (storage, definers, state machine) and src/aap.ts on real Postgres with real roles. "As the invoker" runs on a
 * LOGIN that is a member of app_user AND aap_invoker, the stand-in for the production login (ops grants the membership).
 */
const INVOKER_LOGIN = 'fx_aap_invoker_test';
const KEY1 = randomBytes(32).toString('base64');
const KEY2 = randomBytes(32).toString('base64');
const kekOf = (env: Record<string, string | undefined>): ArgumentsKek => envArgumentsKek(env);
const KEK = kekOf({ FX_KEK_V1: KEY1 });
const DAY = 86_400_000;

describe('AAP storage (0837)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let invokerPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let owner: string;
  let adminUser: string;
  let member: string;
  let ownerB: string;

  async function addUser(accountId: string, role: 'owner' | 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }
  const asUser = <T>(accountId: string, userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(invokerPool, accountId, userId, fn);
  const rejectsWith = async (p: Promise<unknown>, code: string): Promise<void> => {
    await expect(p).rejects.toBeInstanceOf(AapError);
    await expect(p).rejects.toMatchObject({ code });
  };
  /** A fresh instance of `t` made by that account's owner, plus its credential. */
  async function instance(t: SeedRefs = a, who = owner): Promise<{ id: string; secret: string }> {
    const i = await asUser(t.accountId, who, (c) => createInstance(c, {}, 'Test adapter'));
    return { id: i.id, secret: i.secret };
  }
  const deadline = (ms = 3_600_000): Date => new Date(Date.now() + ms);
  const input = (over: Record<string, unknown> = {}) => ({ tool: 'shell.run', server: 'builder', arguments: { cmd: 'ls', flags: ['-l'] }, deadlineAt: deadline(), ...over });

  /** Inserts a row as the table owner (bypassing the definers) in a given status that satisfies every CHECK, for state-machine and boundary cases. */
  async function insertRow(inst: string, status: ApprovalStatus, over: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    const decided = status !== 'pending';
    const cols: Record<string, unknown> = {
      id, account_id: a.accountId, instance_id: inst, tool: 't', server: 's', arguments_sealed: Buffer.alloc(30), arguments_kek_version: 1,
      arguments_sha256: 'a'.repeat(64), arguments_bytes: 2, deadline_at: new Date(Date.now() + DAY), status,
      decided_by_kind: status === 'approved' || status === 'denied' ? 'person' : null, decided_by: status === 'approved' || status === 'denied' ? 'someone' : null,
      decided_at: decided ? new Date() : null, expires_at: status === 'approved' ? new Date(Date.now() + DAY) : null, ...over,
    };
    const keys = Object.keys(cols);
    await admin.query(`INSERT INTO action_approvals (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => cols[k]));
    return id;
  }
  const row = async (id: string) => (await admin.query(`SELECT * FROM action_approvals WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN
          CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, aap_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = '';
    invokerPool = createPool(u.toString());
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    owner = await addUser(a.accountId, 'owner');
    adminUser = await addUser(a.accountId, 'admin');
    member = await addUser(a.accountId, 'member');
    ownerB = await addUser(b.accountId, 'owner');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), invokerPool.end()]);
  });

  describe('1. who can write, and who can read what', () => {
    const FUNCTIONS = [
      'aap_instance_authenticate', 'aap_instance_create', 'aap_instance_close', 'aap_request_create', 'aap_request_get', 'aap_request_consume',
      'aap_request_outcome', 'aap_approval_decide',
    ];
    it('every definer is owned by aap_definer, pinned, and executable by aap_invoker alone; the helper is reachable by no one', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
                (SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END)
                   FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS grantees
           FROM pg_proc p WHERE p.proname LIKE 'aap\\_%' AND p.pronamespace = 'public'::regnamespace ORDER BY p.proname`,
      );
      expect(rows.map((r) => r.proname).sort()).toEqual([...FUNCTIONS, 'aap_manager_account', 'aap_view'].sort());
      for (const r of rows) {
        expect(r.owner).toBe('aap_definer');
        expect(r.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
        if (r.proname === 'aap_manager_account' || r.proname === 'aap_view') expect(r.grantees).toBeNull();
        else expect([r.proname, r.prosecdef, r.grantees]).toEqual([r.proname, true, ['aap_invoker']]);
      }
    });

    it('plain app_user can call none of them and cannot write any of the four tables', async () => {
      await expect(appUserPool.query(`SELECT aap_instance_authenticate('x')`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const { rows } = await admin.query<{ t: string; priv: string; ok: boolean }>(
        `SELECT t, priv, has_table_privilege('app_user', t, priv) AS ok
           FROM unnest(ARRAY['aap_instances','action_approvals']) t, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) priv`,
      );
      expect(rows.filter((r) => r.ok)).toEqual([]);
    });

    it('app_user reads no credential hash; the two roles hold no privilege they should not', async () => {
      const { rows } = await admin.query<{ c: string; ok: boolean }>(
        `SELECT c, has_column_privilege('app_user', t, c, 'SELECT') AS ok FROM (VALUES ('aap_instances','credential_sha256')) v(t, c)`,
      );
      expect(rows).toEqual([{ c: 'credential_sha256', ok: false }]);
      expect((await admin.query(`SELECT count(*)::int AS n FROM pg_proc p, aclexplode(p.proacl) x WHERE x.grantee = 'aap_invoker'::regrole AND p.proname NOT LIKE 'aap\\_%'`)).rows[0].n).toBe(0);
      expect((await admin.query(`SELECT pg_has_role('app_user', 'aap_definer', 'USAGE') AS ok`)).rows[0].ok).toBe(false);
    });

    it('row security is forced everywhere, and another account sees none of the rows', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
      const mine = await instance(a);
      const req = await createRequest(invokerPool, KEK, mine.secret, input());
      const asB = await withTenant(appUserPool, b.accountId, (c) => c.query(`SELECT id FROM aap_instances WHERE id = $1 UNION ALL SELECT id FROM action_approvals WHERE id = $2`, [mine.id, req.id]));
      expect(asB.rows).toEqual([]);
      const asA = await withTenant(appUserPool, a.accountId, (c) => c.query(`SELECT id, name, credential_hint FROM aap_instances WHERE id = $1`, [mine.id]));
      expect(asA.rows).toHaveLength(1);
    });
  });

  describe('2. credentials are 32 random bytes, shown once, stored as sha256 and a hint', () => {
    it('issueCredential makes 32 bytes, and no column of any row holds the plaintext', async () => {
      const c = issueCredential('instance');
      expect(Buffer.from(c.secret.slice('aapi_'.length), 'base64url')).toHaveLength(32);
      expect(c.hint).toBe(c.secret.slice(-4));
      const inst = await instance(a);
      const { rows } = await admin.query(`SELECT to_jsonb(i)::text AS t FROM aap_instances i WHERE id = $1`, [inst.id]);
      expect(rows[0].t).not.toContain(inst.secret);
      expect(rows[0].t).not.toContain(inst.secret.slice('aapi_'.length));
      expect(rows[0].t).toContain(sha256Hex(inst.secret));
      const req = await createRequest(invokerPool, KEK, inst.secret, input());
      const dump = (await admin.query(`SELECT string_agg(to_jsonb(y)::text, ' ') AS r FROM action_approvals y WHERE id = $1`, [req.id])).rows[0];
      expect(dump.r).not.toContain(inst.secret);
    });
  });

  describe('3. size limits', () => {
    it('refuses over-size arguments, reasoning and context, in the client and in the table', async () => {
      const { secret } = await instance(a);
      await rejectsWith(createRequest(invokerPool, KEK, secret, input({ arguments: { x: 'a'.repeat(65_536) } })), 'invalid_request');
      await rejectsWith(createRequest(invokerPool, KEK, secret, input({ agentReasoning: 'é'.repeat(4097) })), 'invalid_request');
      await rejectsWith(createRequest(invokerPool, KEK, secret, input({ context: { x: 'a'.repeat(8192) } })), 'invalid_request');
      const ok = await createRequest(invokerPool, KEK, secret, input({ arguments: { x: 'a'.repeat(65_536 - 8) }, agentReasoning: 'a'.repeat(8192) }));
      expect(ok.status).toBe('pending');
      const inst = (await instance(a)).id;
      const tooBig = (over: Record<string, unknown>) => insertRow(inst, 'pending', over);
      await expect(tooBig({ agent_reasoning: 'a'.repeat(8193) })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(tooBig({ context: JSON.stringify({ x: 'a'.repeat(8190) }) })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(tooBig({ arguments_bytes: 65_537, arguments_sealed: Buffer.alloc(65_537 + 28) })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });

  describe('4. sealing', () => {
    it('decrypts with the current key, survives a rotation, and refuses another row, another account and a tampered blob', async () => {
      const { secret, id } = await instance(a);
      const req = await createRequest(invokerPool, KEK, secret, input());
      const open = async (k: ArgumentsKek, id: string) => {
        const r = (await admin.query(`SELECT account_id, arguments_sealed, arguments_kek_version, arguments_sha256 FROM action_approvals WHERE id = $1`, [id])).rows[0];
        return { text: openArguments(k, { accountId: r.account_id, approvalId: id }, r.arguments_sealed, r.arguments_kek_version), sha: r.arguments_sha256 };
      };
      expect(await open(KEK, req.id)).toEqual({ text: canonicalJson({ cmd: 'ls', flags: ['-l'] }), sha: sha256Hex(canonicalJson({ cmd: 'ls', flags: ['-l'] })) });
      const rotated = kekOf({ FX_KEK_V1: KEY1, FX_KEK_V2: KEY2, FX_KEK_CURRENT_VERSION: '2' });
      expect((await open(rotated, req.id)).text).toContain('"cmd":"ls"');
      const fresh = await createRequest(invokerPool, rotated, secret, input());
      expect((await row(fresh.id)).arguments_kek_version).toBe(2);
      expect((await row(req.id)).arguments_kek_version).toBe(1);
      const onlyV2 = kekOf({ FX_KEK_V2: KEY2, FX_KEK_CURRENT_VERSION: '2' });
      expect((await open(onlyV2, fresh.id)).text).toContain('"cmd":"ls"');
      await expect(open(kekOf({ FX_KEK_V1: KEY1 }), fresh.id)).rejects.toThrow();
      const stored = await row(req.id);
      expect(() => openArguments(KEK, { accountId: a.accountId, approvalId: randomUUID() }, stored.arguments_sealed, 1)).toThrow();
      expect(() => openArguments(KEK, { accountId: b.accountId, approvalId: req.id }, stored.arguments_sealed, 1)).toThrow();
      const flipped = Buffer.from(stored.arguments_sealed);
      flipped[20] ^= 1;
      expect(() => openArguments(KEK, { accountId: a.accountId, approvalId: req.id }, flipped, 1)).toThrow();
      expect(stored.arguments_sealed.length).toBe(stored.arguments_bytes + 28);
      expect(() => sealArguments(kekOf({}), { accountId: a.accountId, approvalId: id }, '{}')).toThrow();
    });

    it('two seals of the same plaintext use different nonces, and two stored requests have different blobs', async () => {
      const ids = { accountId: a.accountId, approvalId: randomUUID() };
      const x = sealArguments(KEK, ids, '{"a":1}');
      const y = sealArguments(KEK, ids, '{"a":1}');
      expect(x.sealed.subarray(0, 12).equals(y.sealed.subarray(0, 12))).toBe(false);
      expect(x.sealed.equals(y.sealed)).toBe(false);
      const { secret } = await instance(a);
      const one = await createRequest(invokerPool, KEK, secret, input());
      const two = await createRequest(invokerPool, KEK, secret, input());
      const [s1, s2] = [(await row(one.id)).arguments_sealed as Buffer, (await row(two.id)).arguments_sealed as Buffer];
      expect(s1.subarray(0, 12).equals(s2.subarray(0, 12))).toBe(false);
      expect(s1.equals(s2)).toBe(false);
    });

    it('a blob shorter than a nonce and a tag is refused by name', () => {
      expect(() => openArguments(KEK, { accountId: a.accountId, approvalId: randomUUID() }, Buffer.alloc(27), 1)).toThrow(/shorter than a nonce and a tag/);
    });

    it('without a usable key a request is refused as sealing_unavailable and nothing is stored', async () => {
      const { secret, id } = await instance(a);
      for (const env of [{}, { FX_KEK_V1: 'AAAA' }]) {
        await rejectsWith(createRequest(invokerPool, kekOf(env), secret, input()), 'sealing_unavailable');
      }
      expect((await admin.query(`SELECT count(*)::int AS n FROM action_approvals WHERE instance_id = $1`, [id])).rows[0].n).toBe(0);
    });
  });

  describe('5. the state machine', () => {
    const STATES: ApprovalStatus[] = ['pending', 'approved', 'denied', 'expired', 'cancelled'];
    /** The update that moves a row of `from` to `to` with every CHECK satisfied, so only the trigger can refuse it. */
    const moveSql = (to: ApprovalStatus): string => {
      const decision = to === 'approved' || to === 'denied' ? `, decided_by_kind = 'person', decided_by = 'x'` : `, decided_by_kind = NULL, decided_by = NULL`;
      return `UPDATE action_approvals SET status = '${to}', decided_at = ${to === 'pending' ? 'NULL' : 'now()'}, expires_at = ${to === 'approved' ? `now() + interval '1 day'` : 'NULL'}${decision} WHERE id = $1`;
    };
    for (const from of STATES) {
      for (const to of STATES.filter((s) => s !== from)) {
        const legal = from === 'pending';
        it(`${from} -> ${to} is ${legal ? 'allowed' : 'refused'}`, async () => {
          const inst = (await instance(a)).id;
          const id = await insertRow(inst, from);
          const move = admin.query(moveSql(to), [id]);
          if (legal) {
            await move;
            expect((await row(id)).status).toBe(to);
          } else {
            await expect(move).rejects.toThrow(/state move is not allowed|decision is final/);
            expect((await row(id)).status).toBe(from);
          }
        });
      }
    }

    it('a terminal decision, the request and the sealed blob cannot be rewritten; consume and outcome happen once', async () => {
      const inst = (await instance(a)).id;
      const done = await insertRow(inst, 'approved', { consumed_at: new Date(), outcome: 'succeeded', outcome_at: new Date() });
      for (const set of [`note = 'x'`, `decided_by = 'y'`, `expires_at = now()`, `tool = 'other'`, `arguments_sha256 = '${'b'.repeat(64)}'`, `deadline_at = now()`, `consumed_at = NULL`, `outcome = 'failed'`, `outcome_note = 'n'`, `arguments_sealed = '\\x00'::bytea`]) {
        await expect(admin.query(`UPDATE action_approvals SET ${set} WHERE id = $1`, [done])).rejects.toThrow();
      }
      const denied = await insertRow(inst, 'denied');
      await expect(admin.query(`UPDATE action_approvals SET consumed_at = now() WHERE id = $1`, [denied])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      const pending = await insertRow(inst, 'pending');
      await expect(admin.query(`UPDATE action_approvals SET arguments_sealed = NULL, arguments_kek_version = NULL WHERE id = $1`, [pending])).rejects.toThrow(/only ever purged/);
      await expect(admin.query(`UPDATE action_approvals SET outcome = 'failed', outcome_at = now() WHERE id = $1`, [pending])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });

  describe('5b. edges the table cannot refuse by itself', () => {
    it('a status-only move between terminal states is refused by the edge check, not by a CHECK or the decision-final check', async () => {
      const inst = (await instance(a)).id;
      for (const [from, to] of [['expired', 'cancelled'], ['cancelled', 'expired']] as const) {
        const id = await insertRow(inst, from);
        await expect(admin.query(`UPDATE action_approvals SET status = $2 WHERE id = $1`, [id, to])).rejects.toThrow(/state move is not allowed/);
        const r = await row(id);
        expect([r.status, r.decided_by_kind, r.expires_at]).toEqual([from, null, null]);
      }
      const pendingToExpired = await insertRow(inst, 'pending');
      await admin.query(`UPDATE action_approvals SET status = 'expired', decided_at = now() WHERE id = $1`, [pendingToExpired]);
      expect((await row(pendingToExpired)).status).toBe('expired');
    });

    it('a person cannot approve or deny a request whose deadline has passed but which the sweep has not expired yet; a NULL answer is no decision', async () => {
      const inst = (await instance(a)).id;
      const late = await insertRow(inst, 'pending', { deadline_at: new Date(Date.now() - 1000) });
      await rejectsWith(asUser(a.accountId, owner, (c) => decideRequest(c, late, true, null, 600)), 'already_decided');
      await rejectsWith(asUser(a.accountId, owner, (c) => decideRequest(c, late, false, null, null)), 'already_decided');
      expect((await row(late)).status).toBe('pending');
      const open = await insertRow(inst, 'pending');
      await rejectsWith(asUser(a.accountId, owner, (c) => decideRequest(c, open, null as unknown as boolean, null, 600)), 'invalid_request');
      expect((await row(open)).status).toBe('pending');
    });
  });

  describe('6. consume is one conditional update', () => {
    it('answers already_consumed, not_approved and approval_expired by name, and a stranger gets not_found', async () => {
      const { secret, id: inst } = await instance(a);
      const other = await instance(a);
      const req = await createRequest(invokerPool, KEK, secret, input());
      await rejectsWith(consumeRequest(invokerPool, secret, req.id), 'not_approved');
      await asUser(a.accountId, adminUser, (c) => decideRequest(c, req.id, true, 'ok', 600));
      const used = await consumeRequest(invokerPool, secret, req.id);
      expect(used.consumedAt).not.toBeNull();
      await rejectsWith(consumeRequest(invokerPool, secret, req.id), 'already_consumed');
      const denied = await createRequest(invokerPool, KEK, secret, input());
      await asUser(a.accountId, owner, (c) => decideRequest(c, denied.id, false, null, null));
      await rejectsWith(consumeRequest(invokerPool, secret, denied.id), 'not_approved');
      const stale = await insertRow(inst, 'approved', { expires_at: new Date(Date.now() - 1000) });
      await rejectsWith(consumeRequest(invokerPool, secret, stale), 'approval_expired');
      await rejectsWith(consumeRequest(invokerPool, other.secret, req.id), 'not_found');
      await rejectsWith(consumeRequest(invokerPool, secret, randomUUID()), 'not_found');
    });

    it('under two concurrent consumes on two connections exactly one wins', async () => {
      const { secret, id: inst } = await instance(a);
      const id = await insertRow(inst, 'approved');
      const c1 = await invokerPool.connect();
      const c2 = await invokerPool.connect();
      try {
        await c1.query('BEGIN');
        await consumeRequest(c1, secret, id);
        const second = consumeRequest(c2, secret, id).then(() => 'won', (e: AapError) => e.code);
        await new Promise((r) => setTimeout(r, 150));
        await c1.query('COMMIT');
        expect(await second).toBe('already_consumed');
      } finally {
        c1.release();
        c2.release();
      }
      const race = await insertRow(inst, 'approved');
      const results = await Promise.all([1, 2, 3, 4].map(() => consumeRequest(invokerPool, secret, race).then(() => 'won', (e: AapError) => e.code)));
      expect(results.filter((r) => r === 'won')).toHaveLength(1);
      expect(results.filter((r) => r === 'already_consumed')).toHaveLength(3);
    });
  });

  describe('7. outcome', () => {
    it('is accepted once, only after consume, with a short note, and never changes the decision', async () => {
      const { secret } = await instance(a);
      const req = await createRequest(invokerPool, KEK, secret, input());
      await asUser(a.accountId, owner, (c) => decideRequest(c, req.id, true, 'go', 600));
      await rejectsWith(reportOutcome(invokerPool, secret, req.id, 'succeeded'), 'not_consumed');
      await consumeRequest(invokerPool, secret, req.id);
      const before = await row(req.id);
      await rejectsWith(reportOutcome(invokerPool, secret, req.id, 'failed', 'x'.repeat(1001)), 'invalid_request');
      await reportOutcome(invokerPool, secret, req.id, 'failed', 'x'.repeat(1000));
      await rejectsWith(reportOutcome(invokerPool, secret, req.id, 'succeeded'), 'outcome_already_recorded');
      const after = await row(req.id);
      expect(after).toMatchObject({ status: 'approved', outcome: 'failed', decided_by: before.decided_by, note: 'go' });
      expect(after.decided_at).toEqual(before.decided_at);
      expect(after.expires_at).toEqual(before.expires_at);
      expect(after.consumed_at).toEqual(before.consumed_at);
      await expect(admin.query(`UPDATE action_approvals SET outcome = 'succeeded' WHERE id = $1`, [req.id])).rejects.toThrow();
    });
  });

  describe('10. revoke and delete', () => {
    it('revoking stops the credential at once and cancels pending approvals in the same transaction; a new credential is a new instance', async () => {
      const { secret, id } = await instance(a);
      const pending = await createRequest(invokerPool, KEK, secret, input());
      const approved = await createRequest(invokerPool, KEK, secret, input());
      await asUser(a.accountId, owner, (c) => decideRequest(c, approved.id, true, null, 600));
      await asUser(a.accountId, owner, async (c) => {
        await closeInstance(c, {}, id, false);
        expect((await c.query(`SELECT status FROM action_approvals WHERE id = $1`, [pending.id])).rows[0].status).toBe('cancelled');
      });
      expect((await row(pending.id)).status).toBe('cancelled');
      expect((await row(approved.id)).status).toBe('approved');
      await rejectsWith(getRequest(invokerPool, secret, pending.id), 'unauthenticated');
      await rejectsWith(createRequest(invokerPool, KEK, secret, input()), 'unauthenticated');
      await rejectsWith(consumeRequest(invokerPool, secret, approved.id), 'unauthenticated');
      const fresh = await instance(a);
      expect(fresh.id).not.toBe(id);
      await asUser(a.accountId, owner, (c) => closeInstance(c, {}, id, false));
    });

    it('a create racing a revoke never leaves a pending request on the revoked instance', async () => {
      for (let round = 0; round < 3; round++) {
        const { secret, id } = await instance(a);
        const closer = await invokerPool.connect();
        try {
          await closer.query('BEGIN');
          await closer.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [a.accountId, owner]);
          await closeInstance(closer, {}, id, false); // holds the instance lock, not yet committed
          const create = createRequest(invokerPool, KEK, secret, input()).then(() => 'created', (e: AapError) => e.code);
          await new Promise((r) => setTimeout(r, 200)); // the create has authenticated and is waiting on the lock
          await closer.query('COMMIT');
          expect(await create).toBe('unauthenticated');
        } finally {
          closer.release();
        }
        expect((await admin.query(`SELECT count(*)::int AS n FROM action_approvals WHERE instance_id = $1 AND status = 'pending'`, [id])).rows[0].n).toBe(0);
      }
      // the other order: a create that holds the lock first is cancelled by the close that waits for it
      const { secret, id } = await instance(a);
      const creator = await invokerPool.connect();
      try {
        await creator.query('BEGIN');
        const made = await createRequest(creator, KEK, secret, input());
        const closing = asUser(a.accountId, owner, (c) => closeInstance(c, {}, id, false));
        await new Promise((r) => setTimeout(r, 200));
        await creator.query('COMMIT');
        await closing;
        expect((await row(made.id)).status).toBe('cancelled');
      } finally {
        creator.release();
      }
    });

    it('cancel moves a pending request once and leaves a decided one alone', async () => {
      const { secret } = await instance(a);
      const req = await createRequest(invokerPool, KEK, secret, input());
      expect((await cancelRequest(invokerPool, secret, req.id)).status).toBe('cancelled');
      expect((await cancelRequest(invokerPool, secret, req.id)).status).toBe('cancelled');
      const ok = await createRequest(invokerPool, KEK, secret, input());
      await asUser(a.accountId, owner, (c) => decideRequest(c, ok.id, true, null, 600));
      expect((await cancelRequest(invokerPool, secret, ok.id)).status).toBe('approved');
      await asUser(a.accountId, owner, (c) => expect(decideRequest(c, ok.id, false, null, null)).rejects.toMatchObject({ code: 'already_decided' }));
    });
  });

  describe('11. who may manage and who may decide', () => {
    it('a member, an API token principal and a bare tenant are refused; an owner and an admin succeed', async () => {
      await rejectsWith(asUser(a.accountId, member, (c) => createInstance(c, {}, 'x')), 'forbidden');
      await rejectsWith(withTenant(invokerPool, a.accountId, owner, randomUUID(), (c) => createInstance(c, {}, 'x')), 'session_required');
      await rejectsWith(withTenant(invokerPool, a.accountId, (c) => createInstance(c, {}, 'x')), 'session_required');
      await rejectsWith(asUser(a.accountId, ownerB, (c) => createInstance(c, {}, 'x')), 'session_required');
      await asUser(a.accountId, adminUser, (c) => createInstance(c, {}, 'by admin'));
      const { secret } = await instance(a);
      const req = await createRequest(invokerPool, KEK, secret, input());
      await rejectsWith(asUser(a.accountId, member, (c) => decideRequest(c, req.id, true, null, 600)), 'forbidden');
      await rejectsWith(asUser(b.accountId, ownerB, (c) => decideRequest(c, req.id, true, null, 600)), 'not_found');
      await rejectsWith(asUser(a.accountId, owner, (c) => decideRequest(c, req.id, true, null, 30)), 'invalid_request');
      expect((await row(req.id)).status).toBe('pending');
    });

    it('a provisioner token is refused until 0839, and an instance credential is not a token', async () => {
      const made = await instance(a);
      await rejectsWith(createInstance(invokerPool, { tokenSha256: sha256Hex('anything') }, 'x'), 'unauthenticated');
      await rejectsWith(createInstance(invokerPool, { tokenSha256: made.id }, 'x'), 'unauthenticated');
      await rejectsWith(closeInstance(invokerPool, { tokenSha256: sha256Hex(made.secret) }, made.id, true), 'unauthenticated');
    });

    it('another account\'s request id is the same not-found as a missing one', async () => {
      const mine = await instance(a);
      const theirs = await instance(b, ownerB);
      const req = await createRequest(invokerPool, KEK, theirs.secret, input());
      const cross = await getRequest(invokerPool, mine.secret, req.id).then(() => 'ok', (e: AapError) => e.message);
      const missing = await getRequest(invokerPool, mine.secret, randomUUID()).then(() => 'ok', (e: AapError) => e.message);
      expect(cross).toBe('not_found');
      expect(cross).toBe(missing);
      await rejectsWith(cancelRequest(invokerPool, mine.secret, req.id), 'not_found');
      expect((await row(req.id)).status).toBe('pending');
    });

    it('rejects deadlines in the past or beyond 14 days', async () => {
      const { secret } = await instance(a);
      await rejectsWith(createRequest(invokerPool, KEK, secret, input({ deadlineAt: new Date(Date.now() - 1000) })), 'invalid_request');
      await rejectsWith(createRequest(invokerPool, KEK, secret, input({ deadlineAt: new Date(Date.now() + 15 * DAY) })), 'invalid_request');
    });
  });
});
