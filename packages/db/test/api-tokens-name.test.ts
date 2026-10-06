import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#31 API-3g (C20 criteria 1 and 2): `api_tokens.name` is nullable, backstopped by a
 * CHECK (1-64 characters, no C0 control, no DEL), and immutable for app_user (0621's
 * column-level UPDATE grant is untouched). Raw app_user SQL, bypassing the route.
 */
describe('api_tokens.name (D#31 API-3g)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  /** One app_user INSERT in its own rolled-back transaction, so a failed statement cannot poison the next case. */
  async function appUserInsert(name: string | null): Promise<void> {
    const client = await appUserPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.account_id', refs.accountId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', refs.userId]);
      await client.query(
        `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at, name)
         VALUES ($1, $2, $3, 'fxat_...test', '{read}', now() + interval '90 days', $4)`,
        [refs.accountId, refs.userId, randomUUID(), name],
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  it('the column is nullable text with no default: a row inserted without a name has name IS NULL', async () => {
    const { rows: col } = await admin.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'api_tokens' AND column_name = 'name'`,
    );
    expect(col).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
    const { rows } = await admin.query<{ name: string | null }>(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at)
       VALUES ($1, $2, $3, 'fxat_...test', '{read}', now() + interval '90 days') RETURNING name`,
      [refs.accountId, refs.userId, randomUUID()],
    );
    expect(rows[0]!.name).toBeNull();
    const { rows: nonNull } = await admin.query('SELECT 1 FROM api_tokens WHERE name IS NOT NULL AND account_id = $1', [refs.accountId]);
    expect(nonNull).toHaveLength(0);
  });

  it('an app_user INSERT with a 65-code-point name fails the CHECK; 64 code points (astral included) is accepted', async () => {
    await expect(appUserInsert('a'.repeat(65))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(appUserInsert('😀'.repeat(65))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(appUserInsert('a'.repeat(64))).resolves.toBeUndefined();
    await expect(appUserInsert('😀'.repeat(64))).resolves.toBeUndefined();
  });

  it('an app_user INSERT of the empty string, a TAB, a newline, ESC or DEL fails the CHECK', async () => {
    for (const bad of ['', 'a\u0009b', 'a\nb', 'a\u001bb', 'a\u007fb']) {
      await expect(appUserInsert(bad)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    }
  });

  it('an app_user INSERT of NULL and of an ordinary printable name is accepted', async () => {
    await expect(appUserInsert(null)).resolves.toBeUndefined();
    await expect(appUserInsert('CI bot é 漢字 😀')).resolves.toBeUndefined();
  });

  it('name is immutable: an app_user UPDATE of name fails with a permission error (0621 grant untouched)', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at, name)
       VALUES ($1, $2, $3, 'fxat_...test', '{read}', now() + interval '90 days', 'original') RETURNING id`,
      [refs.accountId, refs.userId, randomUUID()],
    );
    const tokenId = rows[0]!.id;
    const client = await appUserPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.account_id', refs.accountId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', refs.userId]);
      await expect(client.query('UPDATE api_tokens SET name = $1 WHERE id = $2', ['renamed', tokenId])).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    const { rows: after } = await admin.query<{ name: string }>('SELECT name FROM api_tokens WHERE id = $1', [tokenId]);
    expect(after[0]!.name).toBe('original');
    const { rows: grants } = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = 'api_tokens' AND privilege_type = 'UPDATE'
        ORDER BY column_name`,
    );
    expect(grants.map((g) => g.column_name)).toEqual(['revoked_at', 'revoked_reason']);
  });
});
