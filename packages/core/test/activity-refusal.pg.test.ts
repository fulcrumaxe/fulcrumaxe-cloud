import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { getWorkItemActivity } from '../src/work-items/activity.js';

/** The item activity carries a refused run's reason code, and only that: not on any other status, and not when the stored word is not a plain code. */
describe('activity: the refusal reason on a refused run', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  async function run(status: string, reason: string | null): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'researcher', 'local', $4)`, [id, a.accountId, a.workItemId, status]);
    if (reason !== null) {
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`, [a.accountId, id, JSON.stringify({ failureReason: reason })]);
    }
    return id;
  }

  it('a refused run shows its code; a failed run with a code, a refused run with a non-code word, and one with none show nothing', async () => {
    const refused = await run('refused_spend', 'role_not_runner_eligible');
    const failed = await run('failed', 'sandbox_error');
    const upper = await run('refused_spend', 'Role Not Eligible!');
    const lead = await run('refused_spend', '9starts_with_digit');
    const none = await run('refused_spend', null);
    const act = await getWorkItemActivity({ pool: adminPool, principal: { accountId: a.accountId, userId: a.userId } }, a.workItemId);
    const by = (id: string) => act.runs.find((r) => r.id === id)!;
    expect(by(refused).failure_reason).toBe('role_not_runner_eligible');
    for (const id of [failed, upper, lead, none]) expect('failure_reason' in by(id)).toBe(false);
  });
});
