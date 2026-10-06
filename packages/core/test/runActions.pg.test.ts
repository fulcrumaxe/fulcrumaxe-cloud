import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { createRecordingRunActionSignal, requestRunAction } from '../src/runActions/index.js';

/** D#31 API-6a-1 criterion 5 against the real definer. */
describe('requestRunAction (pg)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  const rows = async () => (await admin.query('SELECT id FROM run_action_requests WHERE account_id = $1', [a.accountId])).rows;
  const ctx = () => ({ pool: appPool, principal: { accountId: a.accountId, userId: a.userId } });

  it('a new request inserts one row and signals once; a replay adds nothing and signals nothing', async () => {
    const signal = createRecordingRunActionSignal();
    const input = { kind: 'cancel_run' as const, targetId: a.runId, idempotencyKey: 'svc-1', requestHash: 'h1' };
    const first = await requestRunAction(ctx(), input, { signal });
    expect(first).toMatchObject({ state: 'accepted', replayed: false });
    expect(signal.sent).toEqual([{ actionId: first.actionId, accountId: a.accountId, kind: 'cancel_run' }]);
    const again = await requestRunAction(ctx(), input, { signal });
    expect(again).toEqual({ ...first, replayed: true });
    expect(signal.sent).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it('a failure after the insert leaves no row and sends no signal', async () => {
    const signal = createRecordingRunActionSignal();
    await admin.query(`CREATE FUNCTION fx_svc_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$`);
    await admin.query(`CREATE TRIGGER fx_svc_fail BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = 'run_action.requested') EXECUTE FUNCTION fx_svc_fail()`);
    try {
      const before = (await rows()).length;
      await expect(requestRunAction(ctx(), { kind: 'cancel_work_item', targetId: a.workItemId, requestHash: 'h2' }, { signal })).rejects.toThrow('audit down');
      expect(await rows()).toHaveLength(before);
      expect(signal.sent).toEqual([]);
    } finally {
      await admin.query('DROP TRIGGER fx_svc_fail ON audit_log; DROP FUNCTION fx_svc_fail()');
    }
  });

  it('a missing target surfaces the definer error (P0002) and sends no signal', async () => {
    const signal = createRecordingRunActionSignal();
    await expect(requestRunAction(ctx(), { kind: 'cancel_run', targetId: randomUUID(), requestHash: 'h3' }, { signal })).rejects.toMatchObject({ code: 'P0002' });
    expect(signal.sent).toEqual([]);
  });
});
