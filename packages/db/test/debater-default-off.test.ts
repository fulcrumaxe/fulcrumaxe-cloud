import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { seedAccount } from './helpers/seed.js';

/** D#483 P3 (owner ruling), migration 0710: the debater is off by default; rows a person changed are left alone. */
const SQL = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0710_debater_default_off.sql'), 'utf8');

describe('0710: seeded debater rows go to off, changed ones stay', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = createPool(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await pool.end();
  });

  async function repoWithDebater(mode: string, touched: boolean): Promise<string> {
    const c = await pool.connect();
    try {
      const refs = await seedAccount(c, randomUUID());
      await c.query(`DELETE FROM role_settings WHERE repo_id = $1 AND role = 'debater'`, [refs.repoId]);
      await c.query(`INSERT INTO role_settings (account_id, repo_id, role, mode) VALUES ($1, $2, 'debater', $3)`, [refs.accountId, refs.repoId, mode]);
      // A person's write goes through the service: ON CONFLICT ... updated_at = now(), in a later transaction.
      if (touched) await c.query(`UPDATE role_settings SET mode = $3, updated_at = now() + interval '1 second' WHERE repo_id = $1 AND role = $2`, [refs.repoId, 'debater', mode]);
      return refs.repoId;
    } finally {
      c.release();
    }
  }
  const modeOf = async (repoId: string) => (await pool.query<{ mode: string }>(`SELECT mode FROM role_settings WHERE repo_id = $1 AND role = 'debater'`, [repoId])).rows[0]!.mode;

  it('a row still exactly as seeded (feature_critical, updated_at = created_at) becomes off', async () => {
    const r = await repoWithDebater('feature_critical', false);
    await pool.query(SQL);
    expect(await modeOf(r)).toBe('off');
  });

  it('a row a person wrote (updated_at moved), even to feature_critical, is untouched', async () => {
    const r = await repoWithDebater('feature_critical', true);
    await pool.query(SQL);
    expect(await modeOf(r)).toBe('feature_critical');
  });

  it('always and off rows are untouched, and no other role is touched', async () => {
    const always = await repoWithDebater('always', false);
    const off = await repoWithDebater('off', false);
    const c = await pool.connect();
    const other = await seedAccount(c, randomUUID());
    c.release();
    await pool.query(`INSERT INTO role_settings (account_id, repo_id, role, mode) VALUES ($1, $2, 'runbook-writer', 'feature_critical') ON CONFLICT (repo_id, role) DO UPDATE SET mode = 'feature_critical'`, [other.accountId, other.repoId]);
    await pool.query(SQL);
    expect(await modeOf(always)).toBe('always');
    expect(await modeOf(off)).toBe('off');
    const rb = await pool.query(`SELECT mode FROM role_settings WHERE repo_id = $1 AND role = 'runbook-writer'`, [other.repoId]);
    expect(rb.rows[0].mode).toBe('feature_critical');
  });

  it('a second run changes nothing', async () => {
    const r = await repoWithDebater('feature_critical', false);
    await pool.query(SQL);
    const first = await modeOf(r);
    await pool.query(SQL);
    expect(await modeOf(r)).toBe(first);
  });
});
