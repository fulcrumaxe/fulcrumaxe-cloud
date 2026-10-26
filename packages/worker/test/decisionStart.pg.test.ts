import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { decisionsBlock } from "@fx/pipeline";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceReviewDeps } from "../src/advance.js";
import { decisionOfferForItem, decisionStartFor } from "../src/decisionStart.js";
import { DECISION_SNAPSHOT_KIND, buildDecisionSnapshot, writeDecisionSnapshot, type DecisionSnapshot } from "../src/decisionSnapshot.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * [pg] D#7 DP4b-3b: a review fix round gets its own decision snapshot, from the dials now, with the matching block in the prompt it reads.
 * Real Postgres and the real run insert with its create transaction (the stand-in for the pipeline's resume does what the real one does with the hook:
 * runs it inside `insertAgentRun`). The one fake is that resume. What it cannot show is a sandbox or a runner actually launching the round.
 * The executor card declares, in this order, REFACTOR (d1) and TESTS (d2).
 */
const REFACTOR = "nonbreaking_refactor_approach";
const TESTS = "test_strategy_choice";
const HEAD = "a".repeat(40);
const BLOCK_HEAD = "DECISIONS YOU MAY MEET IN THIS WORK";

describe("decision snapshot for a fix round [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  const SEAT: SeatResult = {
    ok: true,
    seat: {
      repoId: "unused",
      product: "team",
      roleCard: "card",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
      limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
      timeoutMs: 40 * 60_000,
      maxExtensions: 3,
    } as never,
  };
  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;
  let nextNumber = 9400;
  let nextDiscussion = 940;

  /** The pipeline's resume as it behaves for the hook: the run row is made by the real insert, with the caller's hook inside its create transaction. */
  function resumeWith(opts: { failAfterHook?: boolean } = {}) {
    const inputs: StartAgentRunInput[] = [];
    const fn = vi.fn(async (_pool: Pool, _registry: ExecutionTargetRegistry, input: StartAgentRunInput) => {
      inputs.push(input);
      const { id } = await insertAgentRun(writerPool, {
        id: randomUUID(),
        accountId: input.accountId,
        workItemId: input.workItemId,
        parentRunId: input.parentRunId,
        role: "executor",
        runtime: "production",
        executionMode: "sandbox",
        dispatchRepoId: input.repoId,
        dispatchPrNumber: input.pr ?? null,
        idempotency: input.idempotency,
        inCreateTransaction: async (client, runId) => {
          await input.inCreateTransaction?.(client, runId);
          if (opts.failAfterHook) throw new Error("forced failure after the snapshot write");
        },
      });
      await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
      return { id, status: "running" };
    });
    return { fn, inputs };
  }
  function module(resume: ReturnType<typeof resumeWith>["fn"], pool: Pool = writerPool) {
    const review: AdvanceReviewDeps = {
      load: vi.fn(async () => ({ ok: true as const, ctx: { workItemId: "x", stage: "pr_opened", repoId: "r", owner: "acme", name: "widgets", issue: 7, tier: "feature", specVersion: 1, debaterEnabled: false } })),
      recordRound: vi.fn(async (_p, _r, input) => ({ decision: "all_passed", round: 0, recorded: input.verdicts.map((v: { role: string; runId: string; verdict: string }) => ({ ...v, outcome: "passed" })) })),
      resume,
      mergeGate: vi.fn(async () => ({ outcome: "merged", headSha: HEAD, reasons: [], status: "posted" })),
    };
    const starter: RunStarter = { async start() { return { runId: randomUUID() }; } };
    const deps: AdvanceModuleDeps = { starter, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, registry, review, fixHeads: { privateHead: async () => HEAD, syncBase: async () => ({ kind: "up_to_date", baseSha: "f".repeat(40), baseRef: "main", stacked: false }) } };
    return createAdvanceModule(pool, deps);
  }

  /** An item with a finished build, whose own run carries the snapshot a build writes (the dials as they were then). */
  async function item(a: SeedRefs, parentPrompt = "BUILD PROMPT") {
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'changes_requested', $4)", [id, a.accountId, a.repoId, nextNumber++]);
    const discussion = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [discussion, a.accountId, nextDiscussion++, id]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [discussion, id]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, id]);
    const spec = (await admin.query<{ id: string }>("SELECT id FROM spec_versions WHERE work_item_id = $1", [id])).rows[0]!.id;
    const { id: buildId } = await insertAgentRun(writerPool, {
      id: randomUUID(),
      accountId: a.accountId,
      workItemId: id,
      specVersionId: spec,
      role: "executor",
      runtime: "production",
      executionMode: "sandbox",
      dispatchRepoId: a.repoId,
      dispatchPrNumber: nextNumber - 1,
      startPrompt: parentPrompt,
      inCreateTransaction: (client, runId) => writeDecisionSnapshot(client, runId, buildDecisionSnapshot({ role: "executor", dials: new Map() })),
    });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: buildId, from: "pending", to: "running" });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: buildId, from: "running", to: "succeeded", result: { sessionId: "cc-session-1", envelope: { verdict: "done" } } });
    return { id, buildId };
  }
  const who = (a: SeedRefs, workItemId: string) => ({ accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 });
  const numberOf = async (id: string) => Number((await admin.query<{ gh_number: string }>("SELECT gh_number FROM work_items WHERE id = $1", [id])).rows[0]!.gh_number);
  const fixRequest = async (w: string, over: Record<string, unknown> = {}) => {
    const issue = await numberOf(w);
    return { issue, headSha: HEAD, prompt: "FIX PROMPT", round: 1, actionId: randomUUID(), reviewer: "code" as const, failingRunId: randomUUID(), pr: { number: 41, branch: `fx/issue-${issue}` }, ...over };
  };
  const dial = (a: SeedRefs, type: string, version: number, disposition: string) =>
    admin.query("INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, $3, $4, NULL, $5, $6)", [a.accountId, a.repoId, type, disposition, version, a.userId]);
  const snapshots = async (runId: string): Promise<DecisionSnapshot[]> => (await admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = $2 ORDER BY seq`, [runId, DECISION_SNAPSHOT_KIND])).rows.map((r) => r.payload);
  const blocks = (prompt: string): string[] => prompt.split(BLOCK_HEAD).slice(1).map((b) => BLOCK_HEAD + b);
  const instructionsOf = (prompt: string): Record<string, string> =>
    Object.fromEntries([...prompt.matchAll(/^- (d\d+): ".*" -> (.*)$/gm)].map((m) => [m[1]!, m[2]!]));

  it("the round's run has one snapshot row of its own, and the prompt it reads offers exactly its keys with the instruction its disposition reads as", async () => {
    const a = await seedAccount(admin, randomUUID());
    const { id: w } = await item(a);
    const resume = resumeWith();
    const out = await module(resume.fn).advanceStartFix(who(a, w), await fixRequest(w));
    expect(out.ok).toBe(true);
    const runId = (out as { runId: string }).runId;
    const [snap, ...more] = await snapshots(runId);
    expect(more).toEqual([]);
    expect(snap!.entries.map((e) => [e.key, e.decision_type, e.dial_version])).toEqual([["d1", REFACTOR, 0], ["d2", TESTS, 0]]);
    const prompt = resume.inputs[0]!.prompt;
    expect(prompt.startsWith("FIX PROMPT")).toBe(true);
    expect(blocks(prompt)).toHaveLength(1);
    const read = instructionsOf(prompt);
    expect(Object.keys(read)).toEqual(snap!.entries.map((e) => e.key));
    for (const e of snap!.entries) expect(read[e.key]).toBe(e.disposition === "ask" ? "stop and ask" : "decide yourself and report it");
    // The run's ledger gets the section, before the output section when there is one.
    expect(prompt).not.toMatch(/nonbreaking_refactor_approach|test_strategy_choice|human_in_the_loop|Balanced|Cautious|Autonomous/);
  });

  it("what is true at THIS run's create: a dial changed after the build applies, the build's own snapshot is left alone, and the stale block the parent carried is not repeated", async () => {
    const a = await seedAccount(admin, randomUUID());
    // The parent was told to decide d1 itself; its prompt (kept on the run) still says so.
    const stale = decisionsBlock([{ key: "d1", label: "How to restructure code without changing what it does", instruction: "decide" }])!;
    const { id: w, buildId } = await item(a, `BUILD PROMPT\n\n${stale}`);
    const parentBefore = await snapshots(buildId);
    await dial(a, REFACTOR, 1, "ask");
    const resume = resumeWith();
    // The fix prompt of a resumed round can carry the older block (a retained prompt): the new one replaces it.
    const out = await module(resume.fn).advanceStartFix(who(a, w), await fixRequest(w, { prompt: `FIX PROMPT\n\n${stale}` }));
    expect(out.ok).toBe(true);
    const runId = (out as { runId: string }).runId;
    const [snap] = await snapshots(runId);
    expect(snap!.entries[0]).toEqual({ key: "d1", decision_type: REFACTOR, disposition: "ask", dial_version: 1 });
    expect(snap!.entries[1]!.dial_version).toBe(0);
    expect(await snapshots(buildId)).toEqual(parentBefore);
    expect(parentBefore[0]!.entries[0]).toMatchObject({ decision_type: REFACTOR, dial_version: 0 });
    const prompt = resume.inputs[0]!.prompt;
    expect(blocks(prompt)).toHaveLength(1);
    expect(instructionsOf(prompt).d1).toBe("stop and ask");
    expect(prompt).not.toContain("-> decide yourself and report it\n- d2: \"How to test a change\" -> stop");
  });

  it("the snapshot is written in the run's create transaction: a failure after the write leaves no run, no key and no snapshot", async () => {
    const a = await seedAccount(admin, randomUUID());
    const { id: w } = await item(a);
    const resume = resumeWith({ failAfterHook: true });
    const out = await module(resume.fn).advanceStartFix(who(a, w), await fixRequest(w));
    expect(out.ok).toBe(false);
    const runs = (await admin.query("SELECT id FROM agent_runs WHERE work_item_id = $1 AND parent_run_id IS NOT NULL", [w])).rows;
    expect(runs).toEqual([]);
    expect((await admin.query("SELECT count(*)::int AS n FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key LIKE $2", [a.accountId, `advance:${w}:fix:%`])).rows[0].n).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS n FROM run_events WHERE account_id = $1 AND kind = $2 AND run_id NOT IN (SELECT id FROM agent_runs WHERE work_item_id = $3 AND parent_run_id IS NULL) AND run_id IN (SELECT id FROM agent_runs WHERE work_item_id = $3)", [a.accountId, DECISION_SNAPSHOT_KIND, w])).rows[0].n).toBe(0);
  });

  it("a replay of the same approval starts nothing and writes no second snapshot", async () => {
    const a = await seedAccount(admin, randomUUID());
    const { id: w } = await item(a);
    const resume = resumeWith();
    const m = module(resume.fn);
    const req = await fixRequest(w);
    const first = await m.advanceStartFix(who(a, w), req);
    const again = await m.advanceStartFix(who(a, w), req);
    expect(again).toEqual(first);
    expect(resume.fn).toHaveBeenCalledTimes(1);
    expect(await snapshots((first as { runId: string }).runId)).toHaveLength(1);
  });

  describe("fails closed", () => {
    it("an item the account cannot see (or that has no repository) is offered nothing: an empty snapshot and no block, never the declared list", async () => {
      const a = await seedAccount(admin, randomUUID());
      const start = await decisionStartFor(writerPool, a.accountId, randomUUID());
      expect(start.offer.items).toEqual([]);
      expect(start.offer.snapshot.entries).toEqual([]);
      expect(start.prompt("FIX PROMPT")).toBe("FIX PROMPT");
      expect(start.sections([{ code: "spec", bytes: 1, sha256: "c".repeat(64), trimmed_bytes: 0 }])).toHaveLength(1);
      // An empty offer also removes a block the retained prompt carried: the run is not left reading keys its own row does not hold.
      const stale = decisionsBlock([{ key: "d1", label: "How to test a change", instruction: "decide" }])!;
      expect(start.prompt(`FIX PROMPT\n\n${stale}`)).toBe("FIX PROMPT");
    });

    it("a dial that cannot be read fails the round: no run is made, and the prompt is never sent with a block its row cannot back", async () => {
      const a = await seedAccount(admin, randomUUID());
      const { id: w } = await item(a);
      // The same pool, except that a read of the dials fails.
      const failing = new Proxy(writerPool, {
        get(target, prop, receiver) {
          if (prop !== "connect") return Reflect.get(target, prop, receiver);
          return async () => {
            const client = (await target.connect()) as PoolClient;
            const original = client.query;
            const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
            const release = client.release.bind(client);
            // The pool hands this client out again: put it back as it was.
            (client as unknown as { release: unknown }).release = (...args: unknown[]) => {
              (client as unknown as { query: unknown }).query = original;
              (client as unknown as { release: unknown }).release = release;
              return (release as (...a: unknown[]) => void)(...args);
            };
            (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
              const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
              if (text.includes("decision_settings")) return Promise.reject(new Error("dial store unavailable"));
              return query(...args);
            };
            return client;
          };
        },
      });
      const resume = resumeWith();
      await expect(module(resume.fn, failing as Pool).advanceStartFix(who(a, w), await fixRequest(w))).rejects.toThrow();
      expect(resume.fn).not.toHaveBeenCalled();
      expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1 AND parent_run_id IS NOT NULL", [w])).rows[0].n).toBe(0);
    });
  });

  describe("tenancy", () => {
    it("another account's dials and items are never used: an item that is not this account's is offered nothing, and each account's round reads only its own repository's dials", async () => {
      const a = await seedAccount(admin, randomUUID());
      const b = await seedAccount(admin, randomUUID());
      const { id: wa } = await item(a);
      const { id: wb } = await item(b);
      await dial(b, REFACTOR, 1, "ask");
      await dial(b, TESTS, 1, "ask");
      // A's item reads A's repository: no row, so version 0; B's reads B's rows.
      const forA = await decisionOfferForItem(writerPool, a.accountId, wa);
      const forB = await decisionOfferForItem(writerPool, b.accountId, wb);
      expect(forA.snapshot.entries.map((e) => e.dial_version)).toEqual([0, 0]);
      expect(forB.snapshot.entries.map((e) => [e.disposition, e.dial_version])).toEqual([["ask", 1], ["ask", 1]]);
      // Naming B's item under A's account finds nothing (the row is not visible to A): offered nothing, not B's dials and not A's.
      const cross = await decisionOfferForItem(writerPool, a.accountId, wb);
      expect(cross.items).toEqual([]);
      expect(cross.snapshot.entries).toEqual([]);
      // A round on A's item writes its snapshot under A's account only.
      const resume = resumeWith();
      const out = await module(resume.fn).advanceStartFix(who(a, wa), await fixRequest(wa));
      expect(out.ok).toBe(true);
      const owner = (await admin.query<{ account_id: string }>("SELECT account_id FROM run_events WHERE run_id = $1 AND kind = $2", [(out as { runId: string }).runId, DECISION_SNAPSHOT_KIND])).rows;
      expect(owner).toEqual([{ account_id: a.accountId }]);
      expect((await snapshots((out as { runId: string }).runId))[0]!.entries.every((e) => e.dial_version === 0)).toBe(true);
    });

    it("a step cannot name another item's run or repository: the offer comes from the item's own row, whatever the caller sends", async () => {
      const a = await seedAccount(admin, randomUUID());
      const b = await seedAccount(admin, randomUUID());
      const { id: wa } = await item(a);
      await item(b);
      await dial(b, REFACTOR, 1, "ask");
      const resume = resumeWith();
      const out = await module(resume.fn).advanceStartFix(who(a, wa), await fixRequest(wa, { failingRunId: randomUUID() }));
      expect(out.ok).toBe(true);
      expect(instructionsOf(resume.inputs[0]!.prompt).d1).not.toBeUndefined();
      expect((await snapshots((out as { runId: string }).runId))[0]!.entries[0]!.dial_version).toBe(0);
    });
  });
});
