import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import { DRIVER_EVENT_KINDS, assertDriverEvent, listDriverEvents, recordDriverEvent, toCode } from '../../src/work-items/driverEvents.js';

/** D#483 P3: the driver's recorded decisions, against a real Postgres. */
describe('work item driver events', () => {
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

  it('the kinds in code are exactly the kinds the table accepts', () => {
    // The newest migration that states the list wins (0709 made it; each later one that adds a kind restates it whole).
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
    const latest = readdirSync(dir).filter((f) => f.endsWith('.sql') && /work_item_driver_events_kind_check/.test(readFileSync(path.join(dir, f), 'utf8'))).sort().pop()!;
    const sql = readFileSync(path.join(dir, latest), 'utf8');
    const list = /CHECK \(kind IN \(([^)]*)\)\)/.exec(sql)![1]!;
    expect([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...DRIVER_EVENT_KINDS]);
  });

  it('records an event, reads it back oldest first, and a replay of the same key writes nothing', async () => {
    const head = 'b'.repeat(40);
    const out = await withTenant(appUserPool, refs.accountId, async (c) => {
      const a = await recordDriverEvent(c, refs.accountId, { workItemId: refs.workItemId, kind: 'merge_gate', dedupeKey: `${head}:gate`, code: 'ready_human_merges', reasons: ['ci_not_green'], headSha: head, prNumber: 9 });
      const again = await recordDriverEvent(c, refs.accountId, { workItemId: refs.workItemId, kind: 'merge_gate', dedupeKey: `${head}:gate`, code: 'merged', headSha: head });
      await recordDriverEvent(c, refs.accountId, { workItemId: refs.workItemId, kind: 'fix_round_started', dedupeKey: 'r1', round: 1 });
      return { a, again, rows: await listDriverEvents(c, refs.workItemId) };
    });
    expect(out.a.recorded).toBe(true);
    expect(out.again.recorded).toBe(false);
    expect(out.rows.map((r) => r.kind)).toEqual(['merge_gate', 'fix_round_started']);
    expect(out.rows[0]).toMatchObject({ code: 'ready_human_merges', reasons: ['ci_not_green'], head_sha: head, pr_number: 9, round: null });
  });

  it('refuses what the table would refuse, before it reaches the table', () => {
    const base = { workItemId: refs.workItemId, kind: 'stopped' as const, dedupeKey: 'k' };
    expect(() => assertDriverEvent({ ...base, code: 'has space' })).toThrow();
    expect(() => assertDriverEvent({ ...base, reasons: ['ok', 'Not Ok'] })).toThrow();
    expect(() => assertDriverEvent({ ...base, reasons: Array.from({ length: 21 }, (_v, i) => `r${i}`) })).toThrow();
    expect(() => assertDriverEvent({ ...base, headSha: 'nothex' })).toThrow();
    expect(() => assertDriverEvent({ ...base, prNumber: 0 })).toThrow();
    expect(() => assertDriverEvent({ ...base, round: 99 })).toThrow();
    expect(() => assertDriverEvent({ ...base, dedupeKey: '' })).toThrow();
    expect(() => assertDriverEvent({ ...base, kind: 'nope' as 'stopped' })).toThrow();
    expect(() => assertDriverEvent({ ...base, code: 'ok_code', reasons: ['a', 'b_c'], headSha: 'c'.repeat(40), prNumber: 1, round: 2 })).not.toThrow();
  });

  it('toCode turns a role or verdict word into a plain code', () => {
    expect(toCode('code-reviewer')).toBe('code_reviewer');
    expect(toCode('needs-fix')).toBe('needs_fix');
    expect(toCode('9lives')).toBe('x9lives');
    expect(toCode('  Weird -- Text! ')).toBe('weird_text');
  });
});
