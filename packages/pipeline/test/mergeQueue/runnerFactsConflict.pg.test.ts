import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import {
  CONFLICT_FILES_MAX,
  MAX_CONFLICT_ROUNDS,
  decideFromRunnerFacts,
  listConflictRounds,
  startEntrylessFromRunnerFacts,
  type ConflictSubject,
  type RoundStart,
  type RoundStartPorts,
  type RunnerConflictFacts,
} from "../../src/mergeQueue/index.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#519 MQ4-e2-b: the round of a `runner_local` item decided from the runner's stored facts, over real Postgres (a plain `app_user` pool, row security in force). The ports hold NO
 * GitHub client at all (the type has none), so the decision cannot read a repository; the run start is a stub that answers like the worker's (no model is called).
 * What it cannot fake: that the worker's `advanceStartFix` resolves the runner target for a `runner_local` repository (apps/web/lib/mergeQueueConflict.test.ts holds that pairing).
 */
const PR = 7;
const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);
const facts = (over: Partial<RunnerConflictFacts> = {}): RunnerConflictFacts => ({ verdict: "conflict_platform", baseSha: BASE, baseRef: "main", files: ["src/a.ts", "src/b.ts"], ...over });

describe("decideFromRunnerFacts", () => {
  it("a platform verdict goes, with the runner's own files, base and ref, unchanged", () => {
    expect(decideFromRunnerFacts(facts(), 0)).toEqual({ go: true, files: ["src/a.ts", "src/b.ts"], baseSha: BASE, baseRef: "main" });
  });
  it("a foreign verdict is the foreign_commits stop with the stored files", () => {
    expect(decideFromRunnerFacts(facts({ verdict: "conflict_foreign" }), 0)).toEqual({ go: false, code: "foreign_commits", files: ["src/a.ts", "src/b.ts"], baseRef: "main" });
  });
  it("the round bound is the item's rounds against MAX_CONFLICT_ROUNDS, for either verdict", () => {
    expect(decideFromRunnerFacts(facts(), MAX_CONFLICT_ROUNDS - 1)).toMatchObject({ go: true });
    for (const verdict of ["conflict_platform", "conflict_foreign"] as const) {
      expect(decideFromRunnerFacts(facts({ verdict }), MAX_CONFLICT_ROUNDS)).toMatchObject({ go: false, code: "rounds_exhausted" });
    }
  });
  it("a value outside the detail table's rules fails closed as unreadable, with nothing carried", () => {
    const many = Array.from({ length: CONFLICT_FILES_MAX + 1 }, (_, i) => `f${i}.ts`);
    for (const bad of [{ baseSha: "nope" }, { baseRef: "a b" }, { baseRef: "x..y" }, { files: [] }, { files: many }, { files: ["../x"] }, { files: ["/abs"] }, { files: ["a\u0000b"] }]) {
      expect(decideFromRunnerFacts(facts(bad), 0), JSON.stringify(bad).slice(0, 40)).toEqual({ go: false, code: "unreadable", files: [] });
    }
  });
});

describe("D#519 MQ4-e2-b the round from the runner's facts [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn);

  async function setup(answer: (round: number) => RoundStart = () => ({ ok: true, runId: randomUUID() })) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: PR });
    const starts: Array<{ round: number; entryId: string | null; from: string; base: string; ref: string; files: readonly string[] }> = [];
    const ports: RoundStartPorts = {
      inTenant: tenant,
      async startConflictRound({ round }) {
        starts.push({ round: round.round, entryId: round.entryId, from: round.fromSha, base: round.baseSha, ref: round.baseRef, files: round.conflictFiles });
        const out = answer(round.round);
        if (out.ok) await db.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, $3, 'executor', 'production', 'running', $4)`, [out.runId, accountId, workItemId, round.fromSha]);
        return out;
      },
    };
    const subject = (over: Partial<ConflictSubject> = {}): ConflictSubject => ({ id: workItemId, accountId, repoId, workItemId, prNumber: PR, headSha: HEAD, entryId: null, roundsUsed: 0, ...over });
    const rounds = () => tenant(accountId, (c) => listConflictRounds(c, accountId, workItemId));
    const events = async () => (await db.admin.query(`SELECT kind, code, reasons FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq`, [workItemId])).rows as Array<{ kind: string; code: string; reasons: string[] }>;
    const details = async () => (await db.admin.query(`SELECT e.reasons, d.base_ref, d.conflict_files FROM work_item_driver_event_details d JOIN work_item_driver_events e ON e.id = d.driver_event_id WHERE e.work_item_id = $1 ORDER BY e.seq`, [workItemId])).rows;
    return { starts, ports, subject, rounds, events, details, start: (f = facts(), over: Partial<ConflictSubject> = {}) => startEntrylessFromRunnerFacts(ports, subject(over), f) };
  }

  it("C15-20: a platform verdict starts one round (entry_id NULL) from the item's head, with the runner's base, ref and files, and one run start", async () => {
    const s = await setup();
    expect(await s.start()).toEqual({ outcome: "started" });
    expect(s.starts).toEqual([{ round: 1, entryId: null, from: HEAD, base: BASE, ref: "main", files: ["src/a.ts", "src/b.ts"] }]);
    const [round] = await s.rounds();
    expect(round).toMatchObject({ entryId: null, fromSha: HEAD, baseSha: BASE, baseRef: "main", conflictFiles: ["src/a.ts", "src/b.ts"] });
    expect(round!.runId).toEqual(expect.any(String));
  });

  it("C15-22: a replay while the round is open starts nothing (one round, one run)", async () => {
    const s = await setup();
    await s.start();
    expect(await s.start()).toEqual({ outcome: "running" });
    expect(await s.start()).toEqual({ outcome: "running" });
    expect(s.starts).toHaveLength(1);
    expect(await s.rounds()).toHaveLength(1);
  });

  it("C15-21: a foreign verdict stops merge_conflict with foreign_commits and the stored files; no round, no run", async () => {
    const s = await setup();
    expect(await s.start(facts({ verdict: "conflict_foreign", files: ["src/z.ts", "src/a.ts"] }))).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(s.starts).toEqual([]);
    expect(await s.rounds()).toEqual([]);
    expect(await s.events()).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["foreign_commits"] }]);
    expect(await s.details()).toEqual([{ reasons: ["foreign_commits"], base_ref: "main", conflict_files: ["src/z.ts", "src/a.ts"] }]);
  });

  it("C15-22: the bound counts the item's round rows; at MAX_CONFLICT_ROUNDS no round starts and the stop is rounds_exhausted", async () => {
    const s = await setup();
    for (let i = 0; i < MAX_CONFLICT_ROUNDS; i += 1) {
      expect(await s.start(facts(), { roundsUsed: i })).toEqual({ outcome: "started" });
      await db.admin.query(`UPDATE merge_conflict_rounds SET outcome = 'cancelled', ended_at = now() WHERE account_id = $1 AND work_item_id = $2 AND outcome IS NULL`, [s.subject().accountId, s.subject().workItemId]);
    }
    expect(await s.start(facts(), { roundsUsed: MAX_CONFLICT_ROUNDS })).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(await s.rounds()).toHaveLength(MAX_CONFLICT_ROUNDS);
    expect((await s.events()).at(-1)).toEqual({ kind: "stopped", code: "merge_conflict", reasons: ["rounds_exhausted"] });
  });

  it("C15-22: a spend refusal is a stop with no round and no retry; a wait for capacity leaves no round and is asked again", async () => {
    const spend = await setup(() => ({ ok: false, reason: "refused_spend" }));
    expect(await spend.start()).toEqual({ outcome: "stopped", reason: "refused_spend" });
    expect(await spend.rounds()).toEqual([]);
    const wait = await setup(() => ({ ok: false, reason: "waiting_for_capacity" }));
    expect(await wait.start()).toEqual({ outcome: "waiting" });
    expect(await wait.rounds()).toEqual([]);
    const other = await setup(() => ({ ok: false, reason: "invalid_input" }));
    expect(await other.start()).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(await other.events()).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["round_not_started"] }]);
    expect(await other.rounds()).toEqual([]);
  });

  it("an unreadable fact (a ref the table refuses) stops unreadable and starts nothing", async () => {
    const s = await setup();
    expect(await s.start(facts({ baseRef: "a b" }))).toEqual({ outcome: "stopped", reason: "merge_conflict" });
    expect(s.starts).toEqual([]);
    expect(await s.events()).toEqual([{ kind: "stopped", code: "merge_conflict", reasons: ["unreadable"] }]);
  });
});
