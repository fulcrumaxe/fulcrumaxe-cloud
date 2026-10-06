import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
// Relative on purpose: @fx/model-router must not depend on @fx/core (the
// package graph is model-router -> spend -> core), and this test is the one
// place the three copies of the model list are compared.
import { ROLE_MODEL_IDS } from '../../core/src/role-settings/types.js';
import { ROLE_FLOORS, meetsFloor } from '../src/floors.js';
import { MODEL_TIER_ORDER, type ModelId } from '../src/types.js';

/**
 * D#31 API-8b: the H22 floor is enforced in three places -- the API route
 * (applyCustomerOverride, this package), core (ROLE_MODEL_IDS) and the
 * database (migration 0645's CHECKs on role_settings.model). This fails if a
 * floored role or a model id is added in one place and not the others.
 */
describe('[pg] role_settings.model: route floor, core ids and database CHECK agree', () => {
  let pool: Pool;
  let accountId: string;
  let repoId: string;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    accountId = randomUUID();
    await pool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [
      accountId,
      `cus_test_${accountId}`,
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO repos (account_id, gh_repo_id, product) VALUES ($1, $2, 'web') RETURNING id`,
      [accountId, Math.floor(Math.random() * 1e9)],
    );
    repoId = rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM accounts WHERE id = $1', [accountId]);
    await pool.end();
  });

  async function checkDefinitions(): Promise<string[]> {
    const { rows } = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'role_settings'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%model%'`,
    );
    return rows.map((r) => r.def);
  }

  function quoted(def: string): string[] {
    return [...def.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  }

  it("core's ROLE_MODEL_IDS, the router's MODEL_TIER_ORDER and the CHECK's model list are the same set", async () => {
    expect([...ROLE_MODEL_IDS].sort()).toEqual([...MODEL_TIER_ORDER].sort());
    const known = (await checkDefinitions()).find((d) => !d.includes('security-'));
    expect(known).toBeDefined();
    expect(quoted(known!).sort()).toEqual([...MODEL_TIER_ORDER].sort());
  });

  it("the floor CHECK names exactly ROLE_FLOORS' roles", async () => {
    const floor = (await checkDefinitions()).find((d) => d.includes('security-'));
    expect(floor).toBeDefined();
    const roles = quoted(floor!).filter((q) => !(MODEL_TIER_ORDER as readonly string[]).includes(q));
    expect(roles.sort()).toEqual(Object.keys(ROLE_FLOORS).sort());
  });

  it('for every floored role and every model, the CHECK accepts exactly when meetsFloor is true', async () => {
    for (const role of [...Object.keys(ROLE_FLOORS), 'executor']) {
      for (const model of MODEL_TIER_ORDER as readonly ModelId[]) {
        await pool.query('DELETE FROM role_settings WHERE repo_id = $1', [repoId]);
        const insert = pool.query(
          `INSERT INTO role_settings (account_id, repo_id, role, mode, model) VALUES ($1, $2, $3, 'off', $4)`,
          [accountId, repoId, role, model],
        );
        if (meetsFloor(role, model)) {
          await expect(insert, `${role} on ${model}`).resolves.toBeDefined();
        } else {
          await expect(insert, `${role} on ${model}`).rejects.toMatchObject({ code: '23514' });
        }
      }
    }
  });

  it('a model outside the list is refused for a floored and a non-floored role', async () => {
    for (const role of ['security-reviewer', 'executor']) {
      await expect(
        pool.query(`INSERT INTO role_settings (account_id, repo_id, role, mode, model) VALUES ($1, $2, $3, 'off', 'gpt-5')`, [
          accountId,
          repoId,
          role,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });
});
