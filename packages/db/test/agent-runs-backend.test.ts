import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#221 R1b (0735): `agent_runs.backend` is a safe name, defaults to claude-code, and never changes. */
const CREATE_SQL = `SELECT agent_run_create($1::uuid, $2::uuid, NULL, NULL, 'code-reviewer', 'production', NULL, NULL, NULL, NULL, NULL,
                                            jsonb_build_object('accountId', $2::uuid::text), repeat('a', 64))`;

describe('agent_runs.backend (0735)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await writerPool.end();
  });

  const backendOf = async (id: string): Promise<string> =>
    (await admin.query(`SELECT backend FROM agent_runs WHERE id = $1`, [id])).rows[0].backend;

  async function create(): Promise<string> {
    const id = randomUUID();
    await withTenant(writerPool, refs.accountId, (c) => c.query(CREATE_SQL, [id, refs.accountId]));
    return id;
  }

  it('a run created through agent_run_create is a claude-code run', async () => {
    expect(await backendOf(await create())).toBe('claude-code');
  });

  it('the column is NOT NULL with a default, so an old row or a writer that omits it still has a backend', async () => {
    const { rows } = await admin.query(
      `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'agent_runs' AND column_name = 'backend'`,
    );
    expect(rows).toEqual([{ is_nullable: 'NO', column_default: "'claude-code'::text" }]);
  });

  it('refuses a name that is not a safe backend name', async () => {
    // Even the table owner (the admin login) is bound by the CHECK.
    for (const bad of ['', 'Claude', '1codex', 'a b', 'x;y', '../x', 'a'.repeat(33)]) {
      await expect(
        admin.query(`INSERT INTO agent_runs (account_id, role, runtime, status, backend) VALUES ($1, 'code-reviewer', 'production', 'pending', $2)`, [refs.accountId, bad]),
        bad,
      ).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });
    }
  });

  it('refuses to change the backend of an existing run, even for a valid name and even for the owner', async () => {
    const id = await create();
    await expect(admin.query(`UPDATE agent_runs SET backend = 'codex' WHERE id = $1`, [id])).rejects.toMatchObject({
      code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
    });
    expect(await backendOf(id)).toBe('claude-code');
    // Writing the same value is not a change.
    await admin.query(`UPDATE agent_runs SET backend = 'claude-code' WHERE id = $1`, [id]);
  });

  it('the writer login holds no UPDATE on the column', async () => {
    const id = await create();
    await expect(
      withTenant(writerPool, refs.accountId, (c) => c.query(`UPDATE agent_runs SET backend = 'codex' WHERE id = $1`, [id])),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });
});
