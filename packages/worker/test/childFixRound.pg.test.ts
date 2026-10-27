import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { addSpec, plannedFixture, reapprove, row, TABLE, type PlannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import { assembleFixPrompt } from "@fx/pipeline";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceReviewDeps } from "../src/advance.js";
import type { FixRoundHeadPorts } from "../src/fixRoundHeads.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * [pg] D#483 S5-b2c-3, acceptance 5 (the round on the child's branch, nothing on the parent's) and 16 (a fix round's start refusals): a planned PR child's review fix round is started by
 * the real fix start. The GitHub ports are strict stand-ins that fail the test on any branch but the child's. The resume is the pipeline's as a stand-in that writes the keyed run row.
 * Not faked faithfully: GitHub itself; the branch sync and head reads are contract-tested over TLS in fixRoundHeads.pg.test.ts.
 */
describe("a planned PR child's review fix round [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  const SEAT: SeatResult = {
    ok: true,
    seat: {
      repoId: "unused", product: "team", roleCard: "card", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
      limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 }, timeoutMs: 40 * 60_000, maxExtensions: 3,
    } as never,
  };
  const ASKED = "a".repeat(40);
  const BASE = "f".repeat(40);
  const PR = 9;
  const PARENT_NUMBER = 41;
  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;

  /** Strict GitHub ports: only the child's branch is ever asked about. */
  const asked: string[] = [];
  const heads: FixRoundHeadPorts = {
    publicHead: async () => "d".repeat(40),
    privateHead: async ({ branch }) => (asked.push(`head ${branch}`), branch === "fx/41-api" ? ASKED : (() => { throw new Error(`unexpected read of ${branch}`); })()),
    syncBase: async ({ branch, prNumber }) => {
      asked.push(`sync ${branch}#${prNumber}`);
      if (branch !== "fx/41-api" || prNumber !== PR) throw new Error(`unexpected sync of ${branch}`);
      return { kind: "up_to_date", baseSha: BASE, baseRef: "main", stacked: false };
    },
  };

  function harness() {
    const resumed: StartAgentRunInput[] = [];
    const resume = vi.fn(async (_pool: Pool, _registry: ExecutionTargetRegistry, input: StartAgentRunInput) => {
      resumed.push(input);
      const { id } = await insertAgentRun(writerPool, {
        id: randomUUID(), accountId: input.accountId, workItemId: input.workItemId, parentRunId: input.parentRunId, specParentRunId: input.parentRunId ?? null, role: "executor", runtime: "production",
        executionMode: "sandbox", dispatchRepoId: input.repoId, dispatchPrNumber: input.pr ?? null, idempotency: input.idempotency, inCreateTransaction: input.inCreateTransaction,
      });
      await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
      return { id, status: "running" };
    });
    const review: AdvanceReviewDeps = { load: vi.fn(), recordRound: vi.fn(), resume, mergeGate: vi.fn() } as never;
    const starter: RunStarter = { async start() { throw new Error("a same-side round never starts a fresh session"); } };
    const deps: AdvanceModuleDeps = { starter, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, registry, review, fixHeads: heads };
    return { module: createAdvanceModule(writerPool, deps), resume, resumed };
  }

  /** A child at `pr_opened` whose sandbox build (pinned to the parent's Spec version) ended and recorded its branch. */
  async function child(): Promise<{ f: PlannedFixture; id: string; build: string }> {
    const f = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'sandbox' WHERE id = $1", [f.t.repoId]);
    await admin.query("UPDATE work_items SET gh_number = $2 WHERE id = $1", [f.parent, PARENT_NUMBER]);
    await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE account_id = $1 AND status IN ('pending', 'running')", [f.t.accountId]);
    const id = f.kids.api!;
    await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [id]);
    const { id: build } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: f.t.accountId, workItemId: id, specVersionId: f.specV1, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: f.t.repoId, dispatchPrNumber: PARENT_NUMBER });
    await writeRunStatus(writerPool, { accountId: f.t.accountId, runId: build, from: "pending", to: "running" });
    await writeRunStatus(writerPool, { accountId: f.t.accountId, runId: build, from: "running", to: "succeeded", result: { sessionId: "cc-session-1", envelope: { summary: "built" } } });
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 900, 'child.binding', $3::jsonb)`, [f.t.accountId, build, JSON.stringify({ branch: "fx/41-api" })]);
    return { f, id, build };
  }
  const who = (c: { f: PlannedFixture; id: string }) => ({ accountId: c.f.t.accountId, userId: c.f.t.userId, workItemId: c.id, haltEpoch: 0 });
  const req = (over: Record<string, unknown> = {}) => ({
    issue: PARENT_NUMBER, headSha: ASKED, prompt: "fix it", round: 1, actionId: randomUUID(), reviewer: "code" as const, failingRunId: randomUUID(), pr: { number: PR, branch: "fx/41-api" }, ...over,
  });
  const runCount = async (f: PlannedFixture) => Number((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1", [f.t.accountId])).rows[0].n);
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]!.stage;

  it("S5b2c3-5: the round is on fx/<parent#>-<key>: the head read, the base sync and the run all name the child's branch and the parent's issue number, never fx/issue-<parent#>", async () => {
    const c = await child();
    asked.length = 0;
    const h = harness();
    const out = await h.module.advanceStartFix(who(c), req());
    expect(out.ok).toBe(true);
    expect(asked).toEqual(["head fx/41-api", "sync fx/41-api#9"]);
    expect(asked.join(" ")).not.toContain("fx/issue-41");
    expect(h.resumed).toHaveLength(1);
    expect(h.resumed[0]).toMatchObject({ workItemId: c.id, pr: PARENT_NUMBER, parentRunId: c.build });
    // the round is the child's own fact, bound to the child's pull request, and the parent has none
    const facts = (await admin.query<{ work_item_id: string; kind: string; pr_number: number | null }>("SELECT work_item_id, kind, pr_number FROM work_item_driver_events WHERE account_id = $1 AND kind = 'fix_round_started'", [c.f.t.accountId])).rows;
    expect(facts).toEqual([{ work_item_id: c.id, kind: "fix_round_started", pr_number: PR }]);
    // the run it continued is pinned to the parent's Spec version
    expect((await admin.query("SELECT spec_version_id FROM agent_runs WHERE id = $1", [c.build])).rows[0].spec_version_id).toBe(c.f.specV1);
    // a replay finds the run it started
    const again = await h.module.advanceStartFix(who(c), { ...req(), actionId: h.resumed[0]!.idempotency!.key.split(":").at(-1)! });
    expect(again.ok).toBe(true);
  });

  it("S5b2c3-5: a round on any other branch (the parent's fx/issue-<n>) is not the child's pair and is refused", async () => {
    const c = await child();
    asked.length = 0;
    const h = harness();
    const out = await h.module.advanceStartFix(who(c), req({ pr: { number: PR, branch: "fx/issue-41" } }));
    expect(out.ok).toBe(false);
    expect(asked.join(" ")).not.toContain("fx/issue-41");
    expect(h.resumed).toEqual([]);
  });

  it("S5b2c3-5: the fix prompt names the child's branch and Refs #<parent#>, and holds no closing keyword", () => {
    const text = assembleFixPrompt({
      owner: "acme", name: "widgets", issue: PARENT_NUMBER, branch: "fx/41-api", child: true, pr: PR, headSha: ASKED, version: 1, spec: "Do the thing.",
      findings: [{ role: "code-reviewer", verdict: "needs-fix", findings: ["src/a.ts:3 - off by one"], summary: "one problem" }],
    }).prompt;
    expect(text).toContain("fx/41-api");
    expect(text).toContain("Refs #41");
    expect(text).not.toContain("fx/issue-41");
    expect(text).not.toMatch(/\b(?:Closes|Fixes|Resolves) #/i);
    const top = assembleFixPrompt({ owner: "acme", name: "widgets", issue: 7, branch: "fx/issue-7", pr: PR, headSha: ASKED, version: 1, spec: "S", findings: [] }).prompt;
    expect(top).not.toContain("Refs #");
  });

  it("S5b2c3-9: the child's own limit stops its round past the plan's limit, whatever the parent's and the siblings' counts are", async () => {
    const c = await child();
    asked.length = 0;
    const h = harness();
    const out = await h.module.advanceStartFix(who(c), req({ round: 21 }));
    expect(out).toEqual({ ok: false, reason: "invalid_input" });
    const over = await h.module.advanceStartFix(who(c), req({ round: 20 }));
    expect(over).toEqual({ ok: false, reason: "max_fix_rounds" });
    expect(h.resumed).toEqual([]);
  });

  for (const [code, arrange] of [
    ["child_orphaned", async (c: { f: PlannedFixture }) => void (await admin.query("DELETE FROM work_items WHERE id = $1", [c.f.parent]))],
    ["parent_closed", async (c: { f: PlannedFixture }) => void (await admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [c.f.parent]))],
    ["respec_needs_approval", async (c: { f: PlannedFixture }) => void (await addSpec(admin, c.f.t, c.f.parent, 2, TABLE))],
    ["key_not_in_approved_spec", async (c: { f: PlannedFixture }) => { await addSpec(admin, c.f.t, c.f.parent, 2, [row("docs"), row("other")]); await reapprove(appPool, c.f); }],
  ] as const) {
    it(`S5b2c3-16: ${code} refuses the fix round with that code; no run, the stage unchanged, GitHub not asked`, async () => {
      const c = await child();
      await arrange(c);
      asked.length = 0;
      const before = await runCount(c.f);
      const stage = await stageOf(c.id);
      const h = harness();
      expect(await h.module.advanceStartFix(who(c), req())).toEqual({ ok: false, reason: code });
      expect(h.resumed).toEqual([]);
      expect(asked).toEqual([]);
      expect(await runCount(c.f)).toBe(before);
      expect(await stageOf(c.id)).toBe(stage);
    });
  }

  it("R11: a started child whose key is still in a newer approved version goes on, and its round is pinned to the version it was built from", async () => {
    const c = await child();
    await addSpec(admin, c.f.t, c.f.parent, 2, [row("api", "The API"), row("other", "Other")]);
    await reapprove(appPool, c.f);
    asked.length = 0;
    const h = harness();
    expect((await h.module.advanceStartFix(who(c), req())).ok).toBe(true);
    expect((await admin.query("SELECT spec_version_id FROM agent_runs WHERE id = $1", [c.build])).rows[0].spec_version_id).toBe(c.f.specV1);
  });
});
