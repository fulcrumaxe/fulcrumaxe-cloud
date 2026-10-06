import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';

interface ColumnRow {
  column_name: string;
  data_type: string;
}

describe('model_connections schema', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('has no text/varchar column that could hold a plaintext key', async () => {
    const { rows } = await pool.query<ColumnRow>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'model_connections'
      ORDER BY column_name
    `);

    const byName = new Map(rows.map((r) => [r.column_name, r.data_type]));
    expect(byName.get('id')).toBe('uuid');
    expect(byName.get('account_id')).toBe('uuid');
    expect(byName.get('provider')).toBe('text');
    expect(byName.get('key_ciphertext')).toBe('bytea');
    expect(byName.get('key_nonce')).toBe('bytea');
    expect(byName.get('wrapped_dek')).toBe('bytea');
    expect(byName.get('kek_version')).toBe('integer');
    expect(byName.get('key_fingerprint')).toBe('text');
    expect(byName.get('status')).toBe('text');
    expect(byName.get('last_validated_at')).toBe('timestamp with time zone');
    expect(byName.get('last_error_code')).toBe('text');
    expect(byName.get('created_at')).toBe('timestamp with time zone');
    expect(byName.get('updated_at')).toBe('timestamp with time zone');
    expect(rows).toHaveLength(13);

    // The only columns permitted to be free-form text are provably NOT the
    // raw key: an enum-like status/provider, a one-way fingerprint, and an
    // error code. Any OTHER text/varchar column would be a plaintext-key
    // smell -- this fails if one is ever added.
    const allowedTextColumns = new Set(['provider', 'key_fingerprint', 'status', 'last_error_code']);
    for (const row of rows) {
      if (row.data_type === 'text' || row.data_type === 'character varying') {
        expect(allowedTextColumns.has(row.column_name)).toBe(true);
      }
    }
  });
});
