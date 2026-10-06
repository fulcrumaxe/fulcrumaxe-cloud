import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { checkOwnerShape } from '../src/ownerShape.js';
import { createPool } from '../src/pool.js';

/**
 * The staging build's owner-role check, run against real catalog rows: a
 * Neon-shaped role passes, and each wrong attribute is named. (The same check
 * guards the build script; apps/web/test/migrate-on-build.test.ts covers that.)
 */
const SHAPES: Array<{ role: string; attrs: string; owns: boolean; expected: string[] }> = [
  { role: 'fx_shape_ok', attrs: 'LOGIN CREATEROLE BYPASSRLS', owns: true, expected: [] },
  // What Neon's neon_superuser membership gives the real owner: it is accepted.
  { role: 'fx_shape_neon', attrs: 'LOGIN CREATEROLE BYPASSRLS CREATEDB REPLICATION', owns: true, expected: [] },
  { role: 'fx_shape_createdb', attrs: 'LOGIN CREATEROLE BYPASSRLS CREATEDB', owns: true, expected: [] },
  { role: 'fx_shape_repl', attrs: 'LOGIN CREATEROLE BYPASSRLS REPLICATION', owns: true, expected: [] },
  { role: 'fx_shape_neon_nocreaterole', attrs: 'LOGIN BYPASSRLS CREATEDB REPLICATION', owns: true, expected: ['no_createrole'] },
  { role: 'fx_shape_neon_nobypass', attrs: 'LOGIN CREATEROLE CREATEDB REPLICATION', owns: true, expected: ['no_bypassrls'] },
  { role: 'fx_shape_neon_notowner', attrs: 'LOGIN CREATEROLE BYPASSRLS CREATEDB REPLICATION', owns: false, expected: ['not_database_owner'] },
  { role: 'fx_shape_nocreaterole', attrs: 'LOGIN BYPASSRLS', owns: true, expected: ['no_createrole'] },
  { role: 'fx_shape_nobypass', attrs: 'LOGIN CREATEROLE', owns: true, expected: ['no_bypassrls'] },
  { role: 'fx_shape_notowner', attrs: 'LOGIN CREATEROLE BYPASSRLS', owns: false, expected: ['not_database_owner'] },
];

function urlFor(base: string, role: string, database: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = '';
  url.pathname = `/${database}`;
  return url.toString();
}

describe('checkOwnerShape against real roles', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = createPool(process.env.DATABASE_URL!);
    for (const s of SHAPES) {
      await admin.query(`CREATE ROLE ${s.role} ${s.attrs}`);
      await admin.query(`CREATE DATABASE ${s.role}_db ${s.owns ? `OWNER ${s.role}` : ''}`);
    }
  });

  afterAll(async () => {
    for (const s of SHAPES) {
      await admin.query(`DROP DATABASE IF EXISTS ${s.role}_db`);
      await admin.query(`DROP ROLE IF EXISTS ${s.role}`);
    }
    await admin.end();
  });

  it('a superuser connection is refused', async () => {
    expect(await checkOwnerShape(admin)).toContain('is_superuser');
  });

  for (const s of SHAPES) {
    it(`${s.role}: ${s.expected.length ? s.expected.join(', ') : 'passes'}`, async () => {
      const pool = createPool(urlFor(process.env.DATABASE_URL!, s.role, `${s.role}_db`));
      try {
        expect(await checkOwnerShape(pool)).toEqual(s.expected);
      } finally {
        await pool.end();
      }
    });
  }
});
