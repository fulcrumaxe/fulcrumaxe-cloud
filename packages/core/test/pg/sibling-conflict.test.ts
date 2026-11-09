import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import { recordDriverEvent } from '../../src/work-items/driverEvents.js';
import { readSiblingConflict } from '../../src/work-items/mergeReadiness.js';

/** The activity response's `sibling_conflict`, read from real driver events through the app role. Derived on each read, never stored. */
describe('readSiblingConflict', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });
  beforeEach(async () => {
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });

  const read = (r: SeedRefs, asAccount = r.accountId) => withTenant(appUserPool, asAccount, (c) => readSiblingConflict(c, asAccount, r.workItemId));
  // The shape the worker's sibling wake records: a review waiting fact with code sibling_merged and the merged number as one reason.
  const wait = (r: SeedRefs, code: string, reasons: string[], key: string) =>
    withTenant(appUserPool, r.accountId, (c) => recordDriverEvent(c, r.accountId, { workItemId: r.workItemId, kind: 'stage_waiting', stage: 'review', code, attempt: 0, reasons, dedupeKey: key, prNumber: 7 }));
  const sibling = (r: SeedRefs, merged: number) => wait(r, 'sibling_merged', [`after_pr_${merged}`], `sibling:o/r#${merged}`);
  const fact = (r: SeedRefs, kind: 'stopped' | 'escalated', code: string, key: string) =>
    withTenant(appUserPool, r.accountId, (c) => recordDriverEvent(c, r.accountId, { workItemId: r.workItemId, kind, code, reasons: [], dedupeKey: key, prNumber: 7 }));

  it('says nothing for an item with no waiting fact', async () => {
    expect(await read(a)).toBeNull();
  });

  it('names the merged pull request while the sibling wake is the newest waiting fact', async () => {
    await sibling(a, 41);
    expect(await read(a)).toEqual({ after_pr: 41 });
  });

  it('a later waiting fact with another code ends it, and a newer sibling wake replaces the number', async () => {
    await sibling(a, 41);
    await wait(a, 'runner_daily_limit', [], 'limit:1');
    expect(await read(a)).toBeNull();
    await sibling(a, 52);
    expect(await read(a)).toEqual({ after_pr: 52 });
  });

  it('only a waiting fact decides: a later stop or escalation of another kind leaves the line', async () => {
    await sibling(a, 41);
    await fact(a, 'stopped', 'merge_conflict', 'stop:1');
    expect(await read(a)).toEqual({ after_pr: 41 });
  });

  it('a wake whose reasons carry no readable merged number says nothing (no zero, no sign, no text)', async () => {
    for (const [i, reason] of ['after_pr_0', 'after_pr_', 'after_pr_12x', 'after_pr_9999999999', 'merged_41'].entries()) {
      await wait(a, 'sibling_merged', [reason], `bad:${i}`);
      expect(await read(a), reason).toBeNull();
    }
    await wait(a, 'sibling_merged', ['one_more', 'after_pr_18'], 'bad:mixed');
    expect(await read(a)).toEqual({ after_pr: 18 });
  });

  it("is the item's own fact: another item's wake does not show, and another account reads nothing", async () => {
    await sibling(b, 99);
    expect(await read(a)).toBeNull();
    await sibling(a, 41);
    expect(await read(a, b.accountId)).toBeNull();
    expect(await read(b)).toEqual({ after_pr: 99 });
  });
});
