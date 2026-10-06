import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { connect } from '../src/connect.js';
import { remove } from '../src/remove.js';
import { test as testConnection } from '../src/validate.js';
import { markBroken, createConnectionStatusPort } from '../src/markBroken.js';
import { getStatus } from '../src/summary.js';
import { NotFoundError } from '../src/errors.js';
import { fakeHttpClient } from './helpers/fakeHttpClient.js';
import { fakeKekSource } from './helpers/fakeKek.js';
import { seedAccountWithMember } from './helpers/seed.js';
import { ctxFactory } from './helpers/ctx.js';

describe('tenant scope (criterion 7) and markBroken (criterion 5)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let ctx: ReturnType<typeof ctxFactory>;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    ctx = ctxFactory(appUserPool, platformOpsPool);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  describe('criterion 7: tenant scope', () => {
    it('a key is decryptable only inside withTenant for its own account -- a cross-tenant WHERE clause returns nothing', async () => {
      const tenantA = await seedAccountWithMember(admin, 'owner');
      const tenantB = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(tenantB, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
        provider: 'ai_gateway',
        key: 'sk-fake-tenant-b',
      });

      // Same query test()'s key read uses, as tenant A but naming tenant
      // B's account_id in the WHERE clause -- RLS filters by
      // app.account_id, not the literal value, so this returns nothing.
      const row = await withTenant(appUserPool, tenantA.accountId, async (client) => {
        const { rows } = await client.query(
          'SELECT key_ciphertext, key_nonce, wrapped_dek, kek_version FROM model_connections WHERE account_id = $1',
          [tenantB.accountId],
        );
        return rows[0];
      });
      expect(row).toBeUndefined();
    });

    it("test() for an account with no connection of its own returns NotFoundError, never another tenant's row", async () => {
      const tenantA = await seedAccountWithMember(admin, 'owner');
      const tenantB = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(tenantB, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
        provider: 'ai_gateway',
        key: 'sk-fake-tenant-b-2',
      });

      await expect(testConnection(ctx(tenantA, fakeHttpClient({ kind: 'ok' }), fakeKekSource()))).rejects.toThrow(
        NotFoundError,
      );
    });

    it("getStatus() for an account with no connection returns null, not another tenant's status", async () => {
      const tenantA = await seedAccountWithMember(admin, 'owner');
      const tenantB = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(tenantB, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
        provider: 'ai_gateway',
        key: 'sk-fake-tenant-b-3',
      });

      const status = await getStatus(ctx(tenantA, fakeHttpClient({ kind: 'ok' }), fakeKekSource()));
      expect(status).toBeNull();
    });
  });

  describe('security review finding 3: getStatus() requires active membership', () => {
    it('an owner of a DIFFERENT account gets NotFoundError, never the victim account status', async () => {
      const victim = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(victim, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
        provider: 'ai_gateway',
        key: 'sk-fake-victim-1',
      });
      const outsider = await seedAccountWithMember(admin, 'owner');

      await expect(
        getStatus(ctx({ accountId: victim.accountId, userId: outsider.userId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource())),
      ).rejects.toThrow(NotFoundError);
    });

    it('a made-up user id with no users/account_members row gets NotFoundError', async () => {
      const victim = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(victim, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
        provider: 'ai_gateway',
        key: 'sk-fake-victim-2',
      });

      await expect(
        getStatus(ctx({ accountId: victim.accountId, userId: randomUUID() }, fakeHttpClient({ kind: 'ok' }), fakeKekSource())),
      ).rejects.toThrow(NotFoundError);
    });

    it('a member removed from the account gets NotFoundError, even though they used to have access', async () => {
      const victim = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(victim, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
        provider: 'ai_gateway',
        key: 'sk-fake-victim-3',
      });

      const exMemberId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [exMemberId, `${exMemberId}@example.test`]);
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')", [
        victim.accountId,
        exMemberId,
      ]);
      // Confirm access existed before removal (a real member could read status).
      const before = await getStatus(ctx({ accountId: victim.accountId, userId: exMemberId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource()));
      expect(before).not.toBeNull();

      await admin.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [
        victim.accountId,
        exMemberId,
      ]);

      await expect(
        getStatus(ctx({ accountId: victim.accountId, userId: exMemberId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource())),
      ).rejects.toThrow(NotFoundError);

      // The row itself is untouched -- this is an authorization fix, not a data change.
      const still = await admin.query('SELECT count(*)::int AS n FROM model_connections WHERE account_id = $1', [
        victim.accountId,
      ]);
      expect(still.rows[0].n).toBe(1);
    });

    it('getStatus keeps parity with the other three functions: all four now refuse a non-member the same way', async () => {
      const victim = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(victim, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
        provider: 'ai_gateway',
        key: 'sk-fake-victim-4',
      });
      const outsider = await seedAccountWithMember(admin, 'owner');
      const crossCtx = ctx({ accountId: victim.accountId, userId: outsider.userId }, fakeHttpClient({ kind: 'ok' }), fakeKekSource());

      await expect(getStatus(crossCtx)).rejects.toThrow(NotFoundError);
      await expect(testConnection(crossCtx)).rejects.toThrow(NotFoundError);
      await expect(remove(crossCtx)).rejects.toThrow();
      await expect(connect(crossCtx, { provider: 'ai_gateway', key: 'sk-fake-cross' })).rejects.toThrow();

      // Still exactly the victim's own row, untouched.
      const rows = await admin.query('SELECT count(*)::int AS n FROM model_connections WHERE account_id = $1', [
        victim.accountId,
      ]);
      expect(rows.rows[0].n).toBe(1);
    });
  });

  describe('criterion 5: markBroken', () => {
    it('markBroken(accountId, code) sets model_connections.status=broken and accounts.status=model_key_broken', async () => {
      const principal = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(principal, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
        provider: 'ai_gateway',
        key: 'sk-fake-broken',
      });

      await markBroken(platformOpsPool, principal.accountId, 403);

      const conn = await admin.query('SELECT status, last_error_code FROM model_connections WHERE account_id = $1', [
        principal.accountId,
      ]);
      expect(conn.rows[0]).toMatchObject({ status: 'broken', last_error_code: '403' });

      const account = await admin.query('SELECT status FROM accounts WHERE id = $1', [principal.accountId]);
      expect(account.rows[0].status).toBe('model_key_broken');
    });

    it('createConnectionStatusPort(pool).markBroken(accountId, code) -- the ConnectionStatusPort shape (H09a PR #50) -- does the same thing', async () => {
      const principal = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(principal, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
        provider: 'ai_gateway',
        key: 'sk-fake-broken-2',
      });

      await createConnectionStatusPort(platformOpsPool).markBroken(principal.accountId, 401);

      const conn = await admin.query('SELECT status, last_error_code FROM model_connections WHERE account_id = $1', [
        principal.accountId,
      ]);
      expect(conn.rows[0]).toMatchObject({ status: 'broken', last_error_code: '401' });
    });

    it('reconnecting with a key that validates restores accounts.status to active', async () => {
      const principal = await seedAccountWithMember(admin, 'owner');
      await connect(ctx(principal, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
        provider: 'ai_gateway',
        key: 'sk-fake-recover',
      });
      await markBroken(platformOpsPool, principal.accountId, 403);
      const broken = await admin.query('SELECT status FROM accounts WHERE id = $1', [principal.accountId]);
      expect(broken.rows[0].status).toBe('model_key_broken');

      const status = await connect(ctx(principal, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
        provider: 'ai_gateway',
        key: 'sk-fake-recover-new',
      });
      expect(status.status).toBe('ok');

      const restored = await admin.query('SELECT status FROM accounts WHERE id = $1', [principal.accountId]);
      expect(restored.rows[0].status).toBe('active');
    });

    it('a test() that gets rejected (401/403) also pauses the account, same as markBroken', async () => {
      const principal = await seedAccountWithMember(admin, 'owner');
      // One KEK across both calls -- test() decrypts what connect() just
      // encrypted, so a fresh fakeKekSource() per call would fail closed
      // before ever reaching the HTTP client's outcome.
      const sharedKek = fakeKekSource();
      await connect(ctx(principal, fakeHttpClient({ kind: 'ok' }), sharedKek), {
        provider: 'ai_gateway',
        key: 'sk-fake-will-be-rejected',
      });

      const rejectingClient = fakeHttpClient({ kind: 'rejected', code: '401', message: 'key rejected' });
      const outcome = await testConnection(ctx(principal, rejectingClient, sharedKek));
      expect(outcome.kind).toBe('rejected');

      const conn = await admin.query('SELECT status FROM model_connections WHERE account_id = $1', [
        principal.accountId,
      ]);
      expect(conn.rows[0].status).toBe('broken');
      const account = await admin.query('SELECT status FROM accounts WHERE id = $1', [principal.accountId]);
      expect(account.rows[0].status).toBe('model_key_broken');
    });

    describe('security review finding 2: markBroken must never lift a billing pause', () => {
      it.each([
        // Security review fix round 2 (MUST-fix 1, CWE-841/863): the
        // 'past_due' case's MID status is now 'model_key_broken', not
        // 'past_due' -- key_broken_at now outranks past_due_since in the
        // derivation (migration 0606), the same reorder that stops a
        // signed payment failure from re-enabling a broken-key account.
        // That's not markBroken "lifting" anything: reserve() still
        // denies either way, and the FINAL status (after key_broken_at is
        // cleared by a good reconnect) is unaffected by the reorder,
        // since only past_due_since is left to derive from at that point.
        { billingStatus: 'past_due', midStatus: 'model_key_broken' },
        { billingStatus: 'paused', midStatus: 'paused' },
      ] as const)(
        'a $billingStatus account is protected from markBroken (mid: $midStatus), and a good reconnect afterward does NOT restore it to active',
        async ({ billingStatus, midStatus }) => {
          const principal = await seedAccountWithMember(admin, 'owner');
          await connect(ctx(principal, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
            provider: 'ai_gateway',
            key: `sk-fake-${billingStatus}-1`,
          });
          // D#69 (migration 0606): status is derived -- a direct literal
          // write is rejected unless it already matches derivation, so
          // this drives the SAME billing markers accountLifecycle.ts now
          // writes instead of the old raw `SET status = ...`.
          const marker = billingStatus === 'past_due' ? 'past_due_since' : 'owner_paused_at';
          await admin.query(`UPDATE accounts SET ${marker} = now() WHERE id = $1`, [principal.accountId]);

          await markBroken(platformOpsPool, principal.accountId, 401);

          // model_connections is still marked broken (markBroken's own job) --
          // only the accounts-level pause must be protected.
          const conn = await admin.query('SELECT status FROM model_connections WHERE account_id = $1', [
            principal.accountId,
          ]);
          expect(conn.rows[0].status).toBe('broken');

          const midAccount = await admin.query('SELECT status FROM accounts WHERE id = $1', [principal.accountId]);
          expect(midAccount.rows[0].status).toBe(midStatus);

          // A subsequent good reconnect must not lift the billing pause --
          // before the fix, markBroken had already overwritten it to
          // model_key_broken, so this reconnect's "restore from
          // model_key_broken" clause fired and set it to active.
          const status = await connect(ctx(principal, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
            provider: 'ai_gateway',
            key: `sk-fake-${billingStatus}-2`,
          });
          expect(status.status).toBe('ok');

          const finalAccount = await admin.query('SELECT status FROM accounts WHERE id = $1', [principal.accountId]);
          expect(finalAccount.rows[0].status).toBe(billingStatus);
        },
      );

      it('control: an active account still gets paused by markBroken and restored by a good reconnect', async () => {
        const principal = await seedAccountWithMember(admin, 'owner');
        await connect(ctx(principal, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
          provider: 'ai_gateway',
          key: 'sk-fake-active-control-1',
        });

        await markBroken(platformOpsPool, principal.accountId, 401);
        const mid = await admin.query('SELECT status FROM accounts WHERE id = $1', [principal.accountId]);
        expect(mid.rows[0].status).toBe('model_key_broken');

        await connect(ctx(principal, fakeHttpClient({ kind: 'ok' }), fakeKekSource()), {
          provider: 'ai_gateway',
          key: 'sk-fake-active-control-2',
        });
        const final = await admin.query('SELECT status FROM accounts WHERE id = $1', [principal.accountId]);
        expect(final.rows[0].status).toBe('active');
      });
    });
  });
});
