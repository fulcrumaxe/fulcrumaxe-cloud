import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { ENGINE_EVENT_KINDS } from '../../runner-protocol/src/engineEvents.js';
import { ENGINE_NOTICE_PANELS } from '../../webhooks/src/payload.js';

/**
 * ON-23a: the kind to panel map behind the `engine.changed` notice (migration 1039).
 *
 * Three pins, each failing on its own when the map and what it describes drift apart:
 *  - completeness: the kinds the runner protocol sends, the kinds the 1027 body spec knows and the kinds the panel map knows are one set;
 *  - derivation: a panel's reader (packages/core/src/engine) is READ from its source, and every kind it reads maps to that panel, and no panel lists a
 *    kind its reader does not read. A new reader, table or kind therefore cannot drift past the map unnoticed;
 *  - closure: the union a batch names is always inside the closed set, in its order, and an unknown kind names every panel.
 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const MIGRATION_1027 = read('../migrations/1027_engine_bridge.sql');
const MIGRATION_1032 = read('../migrations/1032_engine_plan.sql');
const MIGRATION_1039 = read('../migrations/1039_engine_notice_panels.sql');

const ALL = [...ENGINE_NOTICE_PANELS];
const KINDS: readonly string[] = ENGINE_EVENT_KINDS;

/** The `WHEN '<kind>'` literals of one SQL function body. */
function whenKinds(sql: string, fn: string): string[] {
  const start = sql.indexOf(`FUNCTION ${fn}(`);
  expect(start, `${fn} found`).toBeGreaterThan(-1);
  const end = sql.indexOf('\n$$;', start);
  return [...sql.slice(start, end).matchAll(/WHEN '([a-z_]+)' THEN/g)].map((m) => m[1]!);
}

/** The projected tables each kind writes, read from the ingest's own branches in 1027, plus the plan tables the 1032 trigger fills. */
function tableWriters(): Map<string, Set<string>> {
  const body = MIGRATION_1027.slice(MIGRATION_1027.indexOf("IF kind = 'agent_started' THEN"), MIGRATION_1027.indexOf("IF kind IN ('engine_heartbeat'"));
  const writers = new Map<string, Set<string>>();
  const add = (table: string, kind: string): void => void writers.set(table, (writers.get(table) ?? new Set()).add(kind));
  const parts = body.split(/(?:IF|ELSIF) kind = '([a-z_]+)' THEN/);
  for (let i = 1; i < parts.length; i += 2) for (const m of parts[i + 1]!.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM) public\.(engine_[a-z_]+)/g)) add(m[1]!, parts[i]!);
  const usage = MIGRATION_1027.slice(MIGRATION_1027.indexOf("IF kind IN ('agent_stopped', 'tick_ended') AND b ? 'usage' THEN"));
  expect(usage.slice(0, 600)).toContain('engine_agent_usage');
  for (const k of ['agent_stopped', 'tick_ended']) add('engine_agent_usage', k);
  // The plan tables are written by a row trigger on engine_events, for this one kind.
  expect(MIGRATION_1032).toMatch(/CREATE TRIGGER engine_events_plan_assemble AFTER INSERT ON engine_events\s+FOR EACH ROW WHEN \(NEW\.kind = 'plan_snapshot'\)/);
  add('engine_plan_chunks', 'plan_snapshot');
  add('engine_plan_snapshots', 'plan_snapshot');
  return writers;
}

/** Tables a reader may touch that no event kind writes (settings, decisions, session bookkeeping that every batch moves). */
const NOT_KIND_WRITTEN = new Set(['engine_events', 'engine_sessions', 'engine_bridge_repos', 'engine_decisions', 'engine_decision_answers', 'engine_repo_controls', 'engine_bridge_settings']);

const SRC = { panels: read('../../core/src/engine/panels.ts'), read: read('../../core/src/engine/read.ts'), plan: read('../../core/src/engine/plan.ts') };
function fnSource(file: keyof typeof SRC, name: string): string {
  const src = SRC[file];
  const m = new RegExp(`export (?:async )?function ${name}\\(`).exec(src);
  expect(m, `${name} found in ${file}`).not.toBeNull();
  const next = src.indexOf('\nexport ', m!.index + 1);
  return src.slice(m!.index, next === -1 ? undefined : next);
}

/** The reader of each panel. `notRead` names a kind the table-level reading would add that the reader's own query cannot see, with the reason. */
const READERS: Record<string, { fns: Array<[keyof typeof SRC, string]>; notRead?: Record<string, string> }> = {
  agents: { fns: [['panels', 'readAgents']], notRead: { tick_ended: "its usage join is on subject_kind = 'agent'; a tick's usage row is not read" } },
  lanes: { fns: [['panels', 'readLanes']] },
  gates: { fns: [['panels', 'readGates']] }, // reads engine_gate_receipts and, for its lane filter, engine_lanes
  asks: { fns: [['panels', 'readAsks']] },
  log: { fns: [['panels', 'readLog']] },
  plan: { fns: [['plan', 'readEnginePlan']] },
  stats: { fns: [['panels', 'readRepoStats'], ['read', 'readEngineAgentStats']] },
  usage: { fns: [['read', 'readEngineUsage']], notRead: { agent_started: 'it lists agents that STOPPED with no usage row (stopped_at is set); a start has none' } },
  status: { fns: [['panels', 'readEngineRepos']] },
};
/** A kind the reader reads only when its body carries usage; the SQL kind map cannot see the body, so the ingest adds the panel (engine_panels_union's flag). */
const WHEN_USAGE_BEARING: Record<string, string> = { tick_ended: 'usage' };

/** What each reader reads, as kinds: the kinds it names itself plus every kind that writes a table it reads. */
function readKinds(panel: string): Set<string> {
  const def = READERS[panel]!;
  const writers = tableWriters();
  const kinds = new Set<string>();
  for (const [file, name] of def.fns) {
    const src = fnSource(file, name);
    for (const m of src.matchAll(/(?<![A-Za-z0-9_])kind = '([a-z_]+)'/g)) kinds.add(m[1]!);
    for (const t of new Set([...src.matchAll(/\b(engine_[a-z_]+)\b/g)].map((m) => m[1]!))) {
      if (writers.has(t)) for (const k of writers.get(t)!) kinds.add(k);
      else expect(NOT_KIND_WRITTEN, `${name} reads ${t}, which no event kind writes and is not declared as such`).toContain(t);
    }
  }
  for (const k of Object.keys(def.notRead ?? {})) kinds.delete(k);
  return kinds;
}

describe('engine notice panels: the kind map (migration 1039)', () => {
  let admin: Pool;
  let app: Pool;
  const panelsOf = async (kind: string): Promise<string[] | null> => (await admin.query<{ p: string[] | null }>(`SELECT engine_kind_panels($1) AS p`, [kind])).rows[0]!.p;
  const union = async (kinds: string[] | null, usage = false): Promise<string[]> =>
    (await admin.query<{ p: string[] }>(`SELECT engine_panels_union($1::text[], $2) AS p`, [kinds, usage])).rows[0]!.p;

  beforeAll(() => {
    admin = createPool(process.env.DATABASE_URL!);
    app = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    await admin.end();
    await app.end();
  });

  it('completeness: the runner protocol kinds, the 1027 body spec and the panel map are the same set, and the closed set is the one the SQL names', async () => {
    const sorted = (a: readonly string[]): string[] => [...a].sort();
    expect(sorted(whenKinds(MIGRATION_1027, 'engine_kind_spec'))).toEqual(sorted(KINDS));
    expect(sorted(whenKinds(MIGRATION_1039, 'engine_kind_panels'))).toEqual(sorted(KINDS));
    for (const kind of KINDS) {
      const p = await panelsOf(kind);
      expect(p, kind).not.toBeNull();
      expect(p!.length, kind).toBeGreaterThan(0);
      expect(p!.every((n) => ALL.includes(n as (typeof ALL)[number])), kind).toBe(true);
      expect((await admin.query(`SELECT engine_kind_spec($1) IS NOT NULL AS known`, [kind])).rows[0].known, kind).toBe(true);
    }
    expect(await panelsOf('not_a_kind')).toBeNull();
    expect(await panelsOf('')).toBeNull();
    expect(ALL).toEqual(['agents', 'lanes', 'gates', 'asks', 'log', 'plan', 'stats', 'usage', 'status']);
  });

  it('derivation: every kind a panel reader reads maps to that panel, and a panel lists no kind its reader does not read; a kind no reader reads maps to status', async () => {
    const readBy = new Map<string, Set<string>>(KINDS.map((k) => [k, new Set<string>()]));
    for (const panel of Object.keys(READERS)) for (const k of readKinds(panel)) {
      expect(KINDS, `${panel} reads ${k}`).toContain(k);
      readBy.get(k)!.add(panel);
    }
    const unreadAsStatus: string[] = [];
    for (const kind of KINDS) {
      const expected = new Set(readBy.get(kind)!);
      if (expected.size === 0) {
        expected.add('status');
        unreadAsStatus.push(kind);
      }
      // A kind the reader reads only when it carries usage is added by the ingest, not by the kind map.
      if (WHEN_USAGE_BEARING[kind] !== undefined) expected.delete(WHEN_USAGE_BEARING[kind]!);
      if (expected.size === 0) expected.add('status');
      expect(new Set(await panelsOf(kind)), kind).toEqual(expected);
    }
    // The kinds with no reader of their own, so the test fails if one gains a reader without moving off status.
    expect(unreadAsStatus.sort()).toEqual(['bridge_dropped', 'bridge_heartbeat', 'checkin_tick', 'compaction_detected', 'engine_heartbeat', 'host_heartbeat', 'host_started', 'host_stopped', 'loop_tick', 'spawn_blocked', 'tick_started'].sort());
    // The readers themselves: a reader nobody declared would leave its panel out of the closed set.
    expect(Object.keys(READERS).sort()).toEqual([...ALL].sort());
  });

  it('a usage-bearing tick or stop names usage; a tick without usage does not', async () => {
    expect(await union(['tick_ended'], false)).toEqual(['status']);
    expect(await union(['tick_ended'], true)).toEqual(['usage', 'status']);
    expect(await union(['agent_started'], true)).toEqual(['agents', 'stats', 'usage']);
  });

  it('closure: a union is inside the closed set, once each, in its order, for every subset of kinds tried', async () => {
    const pick = (n: number): string[] => KINDS.filter((_, i) => (n >> (i % 20)) % 3 === 1);
    for (let n = 1; n < 2000; n += 37) {
      const kinds = pick(n);
      if (kinds.length === 0) continue;
      const got = await union(kinds, n % 2 === 0);
      expect(new Set(got).size).toBe(got.length);
      expect(got.every((p) => ALL.includes(p as (typeof ALL)[number]))).toBe(true);
      expect(got).toEqual(ALL.filter((p) => got.includes(p)));
    }
    expect(await union(['merged', 'team_log_line', 'merge_lane'], false)).toEqual(['lanes', 'gates', 'log', 'stats']);
  });

  it('an unknown kind in the batch names every panel, and so does no list at all', async () => {
    expect(await union(['merged', 'not_a_kind'], false)).toEqual(ALL);
    expect(await union(['not_a_kind'], false)).toEqual(ALL);
    expect(await union([''], false)).toEqual(ALL);
    expect(await union(null, false)).toEqual(ALL);
  });

  it('the helpers and the re-carried ingest keep 1027 ownership and grants: definer-owned, no PUBLIC execute, ingest executable by app_user only', async () => {
    const fns = ['engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb)', 'engine_kind_panels(text)', 'engine_panels_union(text[], boolean)'];
    for (const fn of fns) {
      const r = (await admin.query(`SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                                           has_function_privilege('app_user', p.oid, 'EXECUTE') AS app, has_function_privilege('engine_bridge_definer', p.oid, 'EXECUTE') AS definer
                                      FROM pg_proc p WHERE p.oid = $1::regprocedure`, [fn])).rows[0];
      expect(r.owner, fn).toBe('engine_bridge_definer');
      expect(r.pub, fn).toBe(false);
      expect(r.definer, fn).toBe(true);
      expect(r.app, fn).toBe(fn.startsWith('engine_events_ingest'));
    }
    const ingest = (await admin.query(`SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = 'engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb)'::regprocedure`)).rows[0];
    expect(ingest.prosecdef).toBe(true);
    expect(ingest.provolatile).toBe('v');
    expect(ingest.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    for (const fn of fns.slice(1)) {
      const r = (await admin.query(`SELECT provolatile, proconfig FROM pg_proc WHERE oid = $1::regprocedure`, [fn])).rows[0];
      expect(r.provolatile, fn).toBe('i');
      expect(r.proconfig, fn).toEqual(['search_path=pg_catalog']);
    }
    await expect(app.query(`SELECT engine_kind_panels('merged')`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`SELECT engine_panels_union(ARRAY['merged'], false)`)).rejects.toThrow(/permission denied/);
    // The definer has no CREATE on the schema left over from the ownership transfer.
    expect((await admin.query(`SELECT has_schema_privilege('engine_bridge_definer', 'public', 'CREATE') AS c`)).rows[0].c).toBe(false);
  });
});
