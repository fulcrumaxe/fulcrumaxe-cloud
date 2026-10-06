import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#31 API-3f: database-level hardening from PR #152's security review
 * (S1, S2, S3, S4, S7 -- S4 promoted to a MUST by the Team Lead), plus
 * PR #155's own fix round (M1-M5 in the PR 155 review comment).
 * Each test attacks the DB layer directly, as raw app_user SQL through
 * withTenant (or a raw checked-out client, where withTenant's own
 * try/catch would mask the assertion under test -- see the M5 note
 * below), deliberately bypassing packages/api and packages/core entirely
 * -- the whole point of this PR is that these properties hold even if
 * the application layer's own checks are buggy or removed (mirrors D#71
 * C3 criterion 14's failing-first style for column grants).
 */
describe('api_tokens hardening (D#31 API-3f)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  async function insertToken(
    accountId: string,
    createdBy: string,
    opts: { revoked?: boolean } = {},
  ): Promise<{ id: string; tokenHash: string }> {
    const tokenHash = randomUUID();
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at, revoked_at, revoked_reason)
       VALUES ($1, $2, $3, $4, '{read}', now() + interval '90 days', $5, $6)
       RETURNING id`,
      [
        accountId,
        createdBy,
        tokenHash,
        'fxat_...test',
        opts.revoked ? new Date() : null,
        opts.revoked ? 'user_requested' : null,
      ],
    );
    return { id: rows[0]!.id, tokenHash };
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  describe('S4 (MUST): column-scoped UPDATE grant', () => {
    it("app_user's UPDATE grant on api_tokens is exactly {revoked_at, revoked_reason}", async () => {
      const { rows } = await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
         WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = 'api_tokens'
           AND privilege_type = 'UPDATE'
         ORDER BY column_name`,
      );
      expect(rows.map((r) => r.column_name)).toEqual(['revoked_at', 'revoked_reason']);
    });

    // PR #155 review, M5: the original version of this test wrapped each
    // case's assertion in `withTenant(...).catch(() => {})`. withTenant
    // itself ROLLBACKs and re-throws on ANY error from its callback --
    // including the error `expect(...).rejects.toMatchObject(...)` itself
    // throws when the UPDATE does NOT reject (i.e. exactly the bug this
    // test exists to catch). The outer `.catch(() => {})` swallowed BOTH
    // that assertion failure and the expected-rejection path identically,
    // so the test could never fail no matter what app_user was allowed to
    // do. Confirmed live: restoring the pre-#152 table-wide
    // `GRANT UPDATE ON api_tokens TO app_user` still left this test green.
    // Fixed by managing the transaction directly on a checked-out client,
    // with no enclosing catch -- a wrongly-succeeding UPDATE now fails the
    // `expect(...).rejects...` assertion and that failure propagates
    // straight out of the test, same as any other vitest assertion.
    it('raw app_user cannot change any column except revoked_at/revoked_reason -- one failing-first case per column, plus DELETE', async () => {
      const { id: tokenId } = await insertToken(refsA.accountId, refsA.userId);
      const columnCases: [string, unknown][] = [
        ['scopes', ['audit:read']],
        ['expires_at', new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000)],
        ['token_hash', randomUUID()],
        ['created_by', refsB.userId],
        ['account_id', refsB.accountId],
        ['id', randomUUID()],
        ['display_hint', 'fxat_...evil'],
        ['created_at', new Date('2000-01-01T00:00:00Z')],
        ['last_used_at', new Date()],
      ];
      // Each case gets its OWN transaction on its own checked-out client:
      // a failed UPDATE aborts the current Postgres transaction, so a
      // second statement in the SAME one would raise 25P02 ("transaction
      // is aborted"), masking the 42501 this test is actually checking.
      for (const [column, value] of columnCases) {
        const client = await appUserPool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT set_config($1, $2, true)', ['app.account_id', refsA.accountId]);
          await client.query('SELECT set_config($1, $2, true)', ['app.user_id', refsA.userId]);
          await expect(
            client.query(`UPDATE api_tokens SET ${column} = $1 WHERE id = $2`, [value, tokenId]),
          ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        } finally {
          await client.query('ROLLBACK').catch(() => {
            // Best-effort: the transaction may already be aborted by the
            // rejected UPDATE above, which is the expected case.
          });
          client.release();
        }
      }

      // No DELETE grant exists at all (0616), independent of S4's column
      // narrowing -- same "one failing-first case" shape as the columns.
      const client = await appUserPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1, $2, true)', ['app.account_id', refsA.accountId]);
        await client.query('SELECT set_config($1, $2, true)', ['app.user_id', refsA.userId]);
        await expect(client.query(`DELETE FROM api_tokens WHERE id = $1`, [tokenId])).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }

      const { rows: unchanged } = await admin.query('SELECT * FROM api_tokens WHERE id = $1', [tokenId]);
      expect(unchanged).toHaveLength(1);
    });

    it('raw app_user cannot un-revoke: revoked_at cannot go from non-null back to NULL', async () => {
      const { id: tokenId } = await insertToken(refsA.accountId, refsA.userId, { revoked: true });
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await expect(
          client.query(`UPDATE api_tokens SET revoked_at = NULL WHERE id = $1`, [tokenId]),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });
    });

    // PR #155 review, M2: the original trigger only rejected non-null ->
    // NULL. A revoked token acting on its own row (RLS deliberately
    // admits this, R1) could still rewrite revoked_at to a DIFFERENT
    // timestamp, or rewrite revoked_reason, after the fact. Reproduced
    // live against d0ad375 before this fix: both UPDATEs below returned
    // `UPDATE 1`.
    it('raw app_user cannot change revoked_at to a different timestamp once set (no backdating/forward-dating)', async () => {
      const { id: tokenId } = await insertToken(refsA.accountId, refsA.userId, { revoked: true });
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await expect(
          client.query(`UPDATE api_tokens SET revoked_at = '2099-01-01T00:00:00Z' WHERE id = $1`, [tokenId]),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });
    });

    it('raw app_user cannot change revoked_reason once revoked_at is set', async () => {
      const { id: tokenId } = await insertToken(refsA.accountId, refsA.userId, { revoked: true });
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await expect(
          client.query(`UPDATE api_tokens SET revoked_reason = 'rewritten' WHERE id = $1`, [tokenId]),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });
    });

    it('a REVOKED token principal acting on its own (revoked) row cannot rewrite revoked_at or revoked_reason either', async () => {
      const { id: tokenId } = await insertToken(refsA.accountId, refsA.userId, { revoked: true });
      // RLS admits a token principal acting on its own row regardless of
      // revoked_at (R1) -- app.token_id = the revoked token's own id.
      await withTenant(appUserPool, refsA.accountId, refsA.userId, tokenId, async (client) => {
        await expect(
          client.query(`UPDATE api_tokens SET revoked_at = now() WHERE id = $1`, [tokenId]),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });
      await withTenant(appUserPool, refsA.accountId, refsA.userId, tokenId, async (client) => {
        await expect(
          client.query(`UPDATE api_tokens SET revoked_reason = 'rewritten' WHERE id = $1`, [tokenId]),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });
    });

    it('revoked_reason cannot be set while revoked_at stays NULL', async () => {
      const { id: tokenId } = await insertToken(refsA.accountId, refsA.userId);
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await expect(
          client.query(`UPDATE api_tokens SET revoked_reason = 'user_requested' WHERE id = $1`, [tokenId]),
        ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      });
    });

    it('the app-shaped revoke (revoked_at, revoked_reason together, in one UPDATE) still works for app_user', async () => {
      const { id: tokenId } = await insertToken(refsA.accountId, refsA.userId);
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `UPDATE api_tokens SET revoked_at = now(), revoked_reason = 'user_requested' WHERE id = $1 RETURNING id`,
          [tokenId],
        );
        expect(rows).toHaveLength(1);
      });
    });
  });

  describe('S1/S2: a token principal is confined to its own row at the RLS layer, independent of the handler', () => {
    it('mutation B, reproduced directly in SQL: a token cannot SELECT a sibling token, even one it created', async () => {
      const { id: own } = await insertToken(refsA.accountId, refsA.userId);
      const { id: sibling } = await insertToken(refsA.accountId, refsA.userId);
      await withTenant(appUserPool, refsA.accountId, refsA.userId, own, async (client) => {
        const { rows } = await client.query('SELECT id FROM api_tokens WHERE id = $1', [sibling]);
        expect(rows).toHaveLength(0);
        const self = await client.query('SELECT id FROM api_tokens WHERE id = $1', [own]);
        expect(self.rows).toHaveLength(1);
      });
    });

    it('mutation B, reproduced directly in SQL: a token cannot UPDATE (revoke) a sibling token', async () => {
      const { id: own } = await insertToken(refsA.accountId, refsA.userId);
      const { id: sibling } = await insertToken(refsA.accountId, refsA.userId);
      await withTenant(appUserPool, refsA.accountId, refsA.userId, own, async (client) => {
        const { rows } = await client.query(
          `UPDATE api_tokens SET revoked_at = now(), revoked_reason = 'user_requested' WHERE id = $1 RETURNING id`,
          [sibling],
        );
        expect(rows).toHaveLength(0);
      });
      const { rows: stillLive } = await admin.query('SELECT revoked_at FROM api_tokens WHERE id = $1', [sibling]);
      expect(stillLive[0]!.revoked_at).toBeNull();
    });

    it("S2: app.token_id naming a real token does not admit it when app.user_id doesn't match that token's creator", async () => {
      const otherMemberId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [otherMemberId, `${otherMemberId}@x.test`]);
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [
        refsA.accountId,
        otherMemberId,
      ]);
      const { id: creatorsToken } = await insertToken(refsA.accountId, refsA.userId);
      // otherMemberId is a REAL, live member of the account, but did not
      // create creatorsToken -- app.token_id naming it must not be enough.
      await withTenant(appUserPool, refsA.accountId, otherMemberId, creatorsToken, async (client) => {
        const { rows } = await client.query('SELECT id FROM api_tokens WHERE id = $1', [creatorsToken]);
        expect(rows).toHaveLength(0);
      });
    });

    it('a token still sees and can revoke itself (the fix is not overbroad)', async () => {
      const { id: own } = await insertToken(refsA.accountId, refsA.userId);
      await withTenant(appUserPool, refsA.accountId, refsA.userId, own, async (client) => {
        const { rows } = await client.query(
          `UPDATE api_tokens SET revoked_at = now(), revoked_reason = 'user_requested' WHERE id = $1 RETURNING id`,
          [own],
        );
        expect(rows).toHaveLength(1);
      });
    });
  });

  describe('S3: audit_write_api_tokens verifies the token actor before trusting it', () => {
    it('a malformed (non-uuid) app.token_id raises rather than being written as free text', async () => {
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await client.query("SELECT set_config('app.token_id', 'not-a-uuid; drop table x', true)");
        await expect(
          client.query("SELECT audit_write_api_tokens('api_token.revoked', '{}'::jsonb)"),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      });
    });

    it("a well-formed but foreign app.token_id (another account's token) is rejected, not stamped as the actor", async () => {
      const { id: foreignToken } = await insertToken(refsB.accountId, refsB.userId);
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await client.query('SELECT set_config($1, $2, true)', ['app.token_id', foreignToken]);
        await expect(
          client.query("SELECT audit_write_api_tokens('api_token.revoked', '{}'::jsonb)"),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      });
    });

    it('a genuine token_id, created by the live caller, is accepted and stamps token:<id>', async () => {
      const { id: own } = await insertToken(refsA.accountId, refsA.userId);
      await withTenant(appUserPool, refsA.accountId, refsA.userId, own, async (client) => {
        await client.query("SELECT audit_write_api_tokens('api_token.revoked', '{}'::jsonb)");
      });
      const { rows } = await admin.query<{ actor: string }>(
        `SELECT actor FROM audit_log WHERE account_id = $1 AND action = 'api_token.revoked' ORDER BY created_at DESC LIMIT 1`,
        [refsA.accountId],
      );
      expect(rows[0]!.actor).toBe(`token:${own}`);
    });

    // R1: the actor check does not require the token to be unrevoked --
    // a self-revoke's own UPDATE and its audit_write_api_tokens call run
    // in the SAME transaction, after revoked_at is already set. Pins that
    // ruled behaviour so a future change to the actor check can't
    // silently break self-revoke's audit trail.
    it('a token that just revoked itself, in the same transaction, is still accepted as the audit actor', async () => {
      const { id: own } = await insertToken(refsA.accountId, refsA.userId);
      await withTenant(appUserPool, refsA.accountId, refsA.userId, own, async (client) => {
        const { rows } = await client.query(
          `UPDATE api_tokens SET revoked_at = now(), revoked_reason = 'user_requested' WHERE id = $1 RETURNING id`,
          [own],
        );
        expect(rows).toHaveLength(1);
        await client.query("SELECT audit_write_api_tokens('api_token.revoked', '{}'::jsonb)");
      });
      const { rows } = await admin.query<{ actor: string }>(
        `SELECT actor FROM audit_log WHERE account_id = $1 AND action = 'api_token.revoked' ORDER BY created_at DESC LIMIT 1`,
        [refsA.accountId],
      );
      expect(rows[0]!.actor).toBe(`token:${own}`);
    });

    // PR #155 review, M3: payload.token_id (the OBJECT the audit row
    // describes) went into audit_log completely unverified. Reproduced
    // live against d0ad375: a tenant-A actor calling
    // audit_write_api_tokens('api_token.revoked', jsonb_build_object(
    // 'token_id', <tenant-B token>)) wrote a row naming the tenant-B
    // token as the object acted on.
    it("a payload.token_id naming another tenant's token raises and writes no row", async () => {
      const { id: foreignToken } = await insertToken(refsB.accountId, refsB.userId);
      const { rows: before } = await admin.query<{ count: string }>(
        `SELECT count(*)::text FROM audit_log WHERE account_id = $1`,
        [refsA.accountId],
      );
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await expect(
          client.query("SELECT audit_write_api_tokens('api_token.revoked', $1::jsonb)", [
            JSON.stringify({ token_id: foreignToken }),
          ]),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      });
      const { rows: after } = await admin.query<{ count: string }>(
        `SELECT count(*)::text FROM audit_log WHERE account_id = $1`,
        [refsA.accountId],
      );
      expect(after[0]!.count).toBe(before[0]!.count);
    });

    it('a malformed (non-uuid) payload.token_id raises and writes no row', async () => {
      const { rows: before } = await admin.query<{ count: string }>(
        `SELECT count(*)::text FROM audit_log WHERE account_id = $1`,
        [refsA.accountId],
      );
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await expect(
          client.query("SELECT audit_write_api_tokens('api_token.revoked', $1::jsonb)", [
            JSON.stringify({ token_id: 'not-a-uuid; drop table x' }),
          ]),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      });
      const { rows: after } = await admin.query<{ count: string }>(
        `SELECT count(*)::text FROM audit_log WHERE account_id = $1`,
        [refsA.accountId],
      );
      expect(after[0]!.count).toBe(before[0]!.count);
    });

    it("a payload.token_id naming one of the caller's OWN account's tokens is accepted (the real call shape service.ts uses)", async () => {
      const { id: own } = await insertToken(refsA.accountId, refsA.userId);
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await client.query("SELECT audit_write_api_tokens('api_token.created', $1::jsonb)", [
          JSON.stringify({ token_id: own }),
        ]);
      });
      const { rows } = await admin.query<{ payload: { token_id: string } }>(
        `SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'api_token.created' ORDER BY created_at DESC LIMIT 1`,
        [refsA.accountId],
      );
      expect(rows[0]!.payload.token_id).toBe(own);
    });
  });

  describe('S7: touch_api_token_last_used is tenant-scoped by re-keying on the token hash', () => {
    // PR #155 review, M4/R2: the original two-argument form
    // (p_token_id, p_account_id) still trusted whatever account id it was
    // handed -- reproduced live: under tenant A's app.account_id,
    // `SELECT touch_api_token_last_used(<tenant-B token>, <tenant-B
    // account>)` committed a new last_used_at on the tenant-B row.
    // Re-keyed on the hash instead: there is no second, independently
    // supplied identifier left to mismatch. Touching by a token's own
    // hash updates exactly that row and no other.
    it('touching by a hash updates only the row with that hash -- a sibling token stays untouched', async () => {
      const { id: own, tokenHash: ownHash } = await insertToken(refsA.accountId, refsA.userId);
      const { id: sibling } = await insertToken(refsA.accountId, refsA.userId);
      const { id: foreign } = await insertToken(refsB.accountId, refsB.userId);

      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await client.query('SELECT touch_api_token_last_used($1)', [ownHash]);
      });

      const { rows } = await admin.query<{ id: string; last_used_at: Date | null }>(
        'SELECT id, last_used_at FROM api_tokens WHERE id = ANY($1) ORDER BY id',
        [[own, sibling, foreign]],
      );
      const byId = new Map(rows.map((r) => [r.id, r.last_used_at]));
      expect(byId.get(own)).not.toBeNull();
      expect(byId.get(sibling)).toBeNull();
      expect(byId.get(foreign)).toBeNull();
    });

    it('a hash matching no row at all is a silent no-op', async () => {
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await client.query('SELECT touch_api_token_last_used($1)', [randomUUID()]);
      });
      // Nothing to assert against a specific row -- this just proves the
      // call does not raise for an unknown hash (same shape as the
      // function's own throttle no-op).
    });

    it("the old id+account_id overload is gone -- calling with two arguments raises 'function does not exist'", async () => {
      const { id: own } = await insertToken(refsA.accountId, refsA.userId);
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await expect(
          client.query('SELECT touch_api_token_last_used($1, $2)', [own, refsA.accountId]),
        ).rejects.toMatchObject({ code: '42883' });
      });
    });

    it('touching its own token, by its own hash, still works', async () => {
      const { id: own, tokenHash } = await insertToken(refsA.accountId, refsA.userId);
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await client.query('SELECT touch_api_token_last_used($1)', [tokenHash]);
      });
      const { rows } = await admin.query<{ last_used_at: Date | null }>(
        'SELECT last_used_at FROM api_tokens WHERE id = $1',
        [own],
      );
      expect(rows[0]!.last_used_at).not.toBeNull();
    });
  });

  describe('API-15: the scopes CHECK admits exactly the five mintable scopes', () => {
    async function insertWithScopes(scopes: string[]): Promise<void> {
      await admin.query(
        `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at)
         VALUES ($1, $2, $3, 'fxat_...test', $4, now() + interval '90 days')`,
        [refsA.accountId, refsA.userId, randomUUID(), scopes],
      );
    }

    it.each(['work_items:write', 'discussions:write'])('%s inserts, alone and beside read', async (scope) => {
      await expect(insertWithScopes([scope])).resolves.toBeUndefined();
      await expect(insertWithScopes(['read', scope])).resolves.toBeUndefined();
    });

    it('an unknown scope and an empty array still fail the CHECK', async () => {
      await expect(insertWithScopes(['read', 'runs:start'])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insertWithScopes(['settings:write'])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(insertWithScopes([])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('exactly one CHECK on scopes remains after the migration', async () => {
      const { rows } = await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_constraint
          WHERE conrelid = 'public.api_tokens'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%cardinality(scopes)%'`,
      );
      expect(Number(rows[0]!.n)).toBe(1);
    });
  });
});
