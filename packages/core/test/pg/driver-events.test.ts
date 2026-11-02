import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import { DRIVER_EVENT_KINDS, WAITING_STAGES, assertDriverEvent, listDriverEvents, recordDriverEvent, toCode } from '../../src/work-items/driverEvents.js';

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
    // The constraint by name: a migration that restates this list can hold other CHECKs on other tables (0860 widens run_action_requests_kind_check too).
    const list = /work_item_driver_events_kind_check\s+CHECK \(kind IN \(([^)]*)\)\)/.exec(sql)![1]!;
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

  it('D#483 S5-k1b: a stage_waiting fact names its stage and wait reason; no other kind carries a stage or an attempt; the attempt is bounded', () => {
    const w = { workItemId: refs.workItemId, kind: 'stage_waiting' as const, dedupeKey: 'k', code: 'item_cap_reached', stage: 'build' as const, attempt: 3 };
    expect(() => assertDriverEvent(w)).not.toThrow();
    for (const stage of WAITING_STAGES) expect(() => assertDriverEvent({ ...w, stage })).not.toThrow();
    expect(() => assertDriverEvent({ ...w, stage: undefined })).toThrow();
    expect(() => assertDriverEvent({ ...w, stage: 'nope' as 'build' })).toThrow();
    expect(() => assertDriverEvent({ ...w, code: undefined })).toThrow();
    expect(() => assertDriverEvent({ ...w, attempt: -1 })).toThrow();
    expect(() => assertDriverEvent({ ...w, attempt: 100_001 })).toThrow();
    expect(() => assertDriverEvent({ ...w, attempt: 1.5 })).toThrow();
    expect(() => assertDriverEvent({ ...w, kind: 'stopped' })).toThrow();
    expect(() => assertDriverEvent({ workItemId: refs.workItemId, kind: 'stopped', dedupeKey: 'k', attempt: 1 })).toThrow();
  });

  it('D#483 S5-k1b: the stages in code are exactly the stages the table accepts', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
    const file = readdirSync(dir).find((f) => f.startsWith('0845_'))!;
    const m = /work_item_driver_events_stage_check CHECK \(stage IN \(([^)]*)\)\)/.exec(readFileSync(path.join(dir, file), 'utf8'))!;
    expect([...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toEqual([...WAITING_STAGES]);
  });

  it('D#483 S5-k1b: a stage_waiting fact is recorded with its stage and attempt, and a repeat of its key writes nothing', async () => {
    const out = await withTenant(appUserPool, refs.accountId, async (c) => {
      const a = await recordDriverEvent(c, refs.accountId, { workItemId: refs.workItemId, kind: 'stage_waiting', stage: 'panel', attempt: 2, code: 'compute_cap_reached', dedupeKey: 'sw1' });
      const again = await recordDriverEvent(c, refs.accountId, { workItemId: refs.workItemId, kind: 'stage_waiting', stage: 'panel', attempt: 2, code: 'compute_cap_reached', dedupeKey: 'sw1' });
      const row = await c.query("SELECT stage, attempt, code FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'stage_waiting'", [refs.workItemId]);
      return { a, again, row: row.rows };
    });
    expect(out.a.recorded).toBe(true);
    expect(out.again.recorded).toBe(false);
    expect(out.row).toEqual([{ stage: 'panel', attempt: 2, code: 'compute_cap_reached' }]);
  });

  it('D#694 B5 (migration 0938): each queue kind is recorded with its queue entry id and read back from a real table; a replay writes nothing', async () => {
    const head = 'd'.repeat(40);
    const out = await withTenant(appUserPool, refs.accountId, async (c) => {
      const written: boolean[] = [];
      for (const kind of ['merge_enqueued', 'merge_dequeued', 'merged_via_queue'] as const) {
        written.push((await recordDriverEvent(c, refs.accountId, { workItemId: refs.workItemId, kind, dedupeKey: `q:${kind}`, code: 'queue', headSha: head, prNumber: 12, queueEntryId: 'MQE_kwDOabc-123=' })).recorded);
      }
      const again = await recordDriverEvent(c, refs.accountId, { workItemId: refs.workItemId, kind: 'merge_enqueued', dedupeKey: 'q:merge_enqueued', queueEntryId: 'MQE_kwDOabc-123=' });
      const none = await recordDriverEvent(c, refs.accountId, { workItemId: refs.workItemId, kind: 'merge_enqueued', dedupeKey: 'q:none', code: 'auto_merge', headSha: head });
      const rows = await c.query("SELECT kind, code, head_sha, pr_number, queue_entry_id FROM work_item_driver_events WHERE work_item_id = $1 AND dedupe_key LIKE 'q:%' ORDER BY seq", [refs.workItemId]);
      return { written, again, none, rows: rows.rows };
    });
    expect(out.written).toEqual([true, true, true]);
    expect(out.again.recorded).toBe(false);
    expect(out.none.recorded).toBe(true);
    expect(out.rows.map((r) => [r.kind, r.queue_entry_id])).toEqual([
      ['merge_enqueued', 'MQE_kwDOabc-123='],
      ['merge_dequeued', 'MQE_kwDOabc-123='],
      ['merged_via_queue', 'MQE_kwDOabc-123='],
      ['merge_enqueued', null],
    ]);
    expect(out.rows[0]).toMatchObject({ code: 'queue', head_sha: head, pr_number: 12 });
  });

  it('D#694 B5: a queue entry id is refused on any other kind and when malformed, by the function and (for a malformed id) by the column CHECK; a fourth unknown kind is refused by both', async () => {
    const base = { workItemId: refs.workItemId, dedupeKey: 'qk' };
    expect(() => assertDriverEvent({ ...base, kind: 'merge_gate', queueEntryId: 'MQE_ok' })).toThrow('only a queue fact');
    for (const bad of ['', 'has space', 'MQE/slash', 'x'.repeat(101), 'MQE;DROP']) {
      expect(() => assertDriverEvent({ ...base, kind: 'merge_enqueued', queueEntryId: bad })).toThrow();
    }
    expect(() => assertDriverEvent({ ...base, kind: 'merge_enqueued', queueEntryId: 'x'.repeat(100) })).not.toThrow();
    expect(() => assertDriverEvent({ ...base, kind: 'merge_requeued' as 'merge_enqueued' })).toThrow('unknown kind');
    const insert = (kind: string, entry: string | null) =>
      admin.query(
        `INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key, queue_entry_id) VALUES ($1, $2, $3, $4, $5)`,
        [refs.accountId, refs.workItemId, kind, `raw:${kind}:${entry}`, entry],
      );
    await expect(insert('merge_requeued', null)).rejects.toThrow(/work_item_driver_events_kind_check/);
    await expect(insert('merge_enqueued', 'has space')).rejects.toThrow(/work_item_driver_events_queue_entry_check/);
    await expect(insert('merge_enqueued', '')).rejects.toThrow(/work_item_driver_events_queue_entry_check/);
    await insert('merge_enqueued', 'MQE_raw_ok');
  });

  it('D#694 B5: the table stays append-only for the app role, new column included', async () => {
    await expect(withTenant(appUserPool, refs.accountId, (c) => c.query("UPDATE work_item_driver_events SET queue_entry_id = 'MQE_x' WHERE work_item_id = $1", [refs.workItemId]))).rejects.toThrow(/permission denied/);
  });

  it("D#519 MQ4-d-0: a stop's detail is written with its event, once, and every bad path or ref is refused by the table", async () => {
    const head = 'c'.repeat(40);
    const base = { workItemId: refs.workItemId, kind: 'stopped' as const, code: 'merge_conflict', headSha: head, prNumber: 4 };
    const rows = async (key: string) => (await admin.query(`SELECT d.conflict_files, d.base_ref FROM work_item_driver_event_details d JOIN work_item_driver_events e ON e.id = d.driver_event_id WHERE e.dedupe_key = $1`, [key])).rows;
    await withTenant(appUserPool, refs.accountId, (c) => recordDriverEvent(c, refs.accountId, { ...base, dedupeKey: 'd1', detail: { conflictFiles: ['src/a.ts', 'b/c.md'], baseRef: 'release/1.x' } }));
    expect(await rows('d1')).toEqual([{ conflict_files: ['src/a.ts', 'b/c.md'], base_ref: 'release/1.x' }]);
    // A replay writes neither the event nor a second detail; an event with no detail writes none.
    await withTenant(appUserPool, refs.accountId, (c) => recordDriverEvent(c, refs.accountId, { ...base, dedupeKey: 'd1', detail: { conflictFiles: ['x.ts'], baseRef: 'other' } }));
    expect(await rows('d1')).toHaveLength(1);
    await withTenant(appUserPool, refs.accountId, (c) => recordDriverEvent(c, refs.accountId, { ...base, dedupeKey: 'd2', detail: { conflictFiles: [], baseRef: null } }));
    expect(await rows('d2')).toEqual([]);
    const write = (key: string, files: string[], ref: string | null) => withTenant(appUserPool, refs.accountId, (c) => recordDriverEvent(c, refs.accountId, { ...base, dedupeKey: key, detail: { conflictFiles: files, baseRef: ref } }));
    let n = 0;
    for (const bad of ['/abs/path.ts', 'a/../b', '../x', 'a\\b', 'a\u0000b', 'a\nb', '', 'x'.repeat(513), './a']) await expect(write(`bp${n++}`, [bad], null)).rejects.toThrow(/driver_event_details_files_check|invalid byte|null/);
    await expect(write('bp100', Array.from({ length: 101 }, (_, i) => `f${i}.ts`), null)).rejects.toThrow(/driver_event_details_files_check/);
    for (const bad of ['a..b', '-x', 'a b', 'a\tb', 'a\u0000b', 'x~', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a^b', 'r'.repeat(256)]) await expect(write(`br${n++}`, [], bad)).rejects.toThrow(/driver_event_details_ref_check|invalid byte|null/);
    await write('ok-ref', [], 'feature/ok-1.2_x');
    await expect(withTenant(appUserPool, refs.accountId, (c) => c.query(`UPDATE work_item_driver_event_details SET base_ref = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(withTenant(appUserPool, refs.accountId, (c) => c.query(`DELETE FROM work_item_driver_event_details`))).rejects.toThrow(/permission denied/);
  });

  it('toCode turns a role or verdict word into a plain code', () => {
    expect(toCode('code-reviewer')).toBe('code_reviewer');
    expect(toCode('needs-fix')).toBe('needs_fix');
    expect(toCode('9lives')).toBe('x9lives');
    expect(toCode('  Weird -- Text! ')).toBe('weird_text');
  });
});
