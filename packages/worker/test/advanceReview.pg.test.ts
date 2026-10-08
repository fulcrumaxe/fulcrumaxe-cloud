import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PREVIEW_WORKDIR, insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { DuplicateExecutorRunError } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createRunActionFacade } from "../src/runActions.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceReviewDeps, type AdvanceRoundInput } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * D#483 P3 [pg]: the worker side of the review stage. The approval's new stages and its cost-free pre-flight; the fix
 * round (a RESUME of the build's sandbox and session, keyed, never concurrent, with the issue's number); the recorded
 * facts; the round record; and the guards every step re-asserts.
 */
describe("advance: reviews, fix rounds and the merge gate [pg]", { timeout: 60_000 }, () => {
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
  const HEAD = "a".repeat(40);
  let nextNumber = 7000;
  let nextDiscussion = 500;

  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;

  /** A resume that behaves like the pipeline's: a real keyed run row, parent and PR recorded, the one-live-executor index enforced. */
  function realResume(over: { status?: string; throws?: Error } = {}) {
    const inputs: StartAgentRunInput[] = [];
    const fn = vi.fn(async (_pool: Pool, _registry: ExecutionTargetRegistry, input: StartAgentRunInput) => {
      inputs.push(input);
      if (over.throws) throw over.throws;
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
      });
      if (over.status === "refused_spend") {
        await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "refused_spend" });
        return { id, status: "refused_spend" };
      }
      await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
      return { id, status: "running" };
    });
    return { fn, inputs };
  }

  function review(over: Partial<AdvanceReviewDeps> = {}): AdvanceReviewDeps {
    return {
      load: vi.fn(async () => ({ ok: true as const, ctx: { workItemId: "x", stage: "pr_opened", repoId: "r", owner: "acme", name: "widgets", issue: 7, tier: "feature", specVersion: 1, debaterEnabled: false } })),
      recordRound: vi.fn(async (_p, _r, input: AdvanceRoundInput) => ({ decision: "all_passed", round: 0, recorded: input.verdicts.map((v) => ({ ...v, outcome: "passed" })) })),
      resume: realResume().fn,
      mergeGate: vi.fn(async () => ({ outcome: "merged", headSha: HEAD, reasons: [], status: "posted" })),
      ...over,
    };
  }

  function build(over: Partial<AdvanceModuleDeps> = {}, reviewDeps: AdvanceReviewDeps | null = review()) {
    const inputs: StartAgentRunInput[] = [];
    const starter: RunStarter = {
      async start(input) {
        inputs.push(input);
        return { runId: randomUUID() };
      },
    };
    const deps: AdvanceModuleDeps = {
      starter,
      resolveRunSeat: vi.fn(async () => SEAT),
      startAdvance: async () => undefined,
      triage: null,
      registry,
      review: reviewDeps,
      ...over,
    };
    return { module: createAdvanceModule(writerPool, deps), inputs, deps };
  }

  /** A work item at `stage` with a discussion (kind) and, for stages that need one, a Spec; its repo has an owner and a name. */
  async function item(a: SeedRefs, o: { stage?: string; provenance?: string; kind?: string | null; spec?: boolean; role?: string } = {}) {
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    if (o.role) await admin.query("UPDATE account_members SET role = $3 WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId, o.role]);
    const id = randomUUID();
    const stage = o.stage ?? "pr_opened";
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', $4, $5, $6)", [id, a.accountId, a.repoId, o.provenance ?? "internal", stage, nextNumber++]);
    const discussion = randomUUID();
    await admin.query(
      "INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, $4, 't', $5, 'internal', 'user')",
      [discussion, a.accountId, nextDiscussion++, o.kind === undefined ? "feature" : o.kind, id],
    );
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [discussion, id]);
    if (o.spec !== false) {
      await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, id]);
    }
    return id;
  }
  const numberOf = async (id: string) => Number((await admin.query<{ gh_number: string }>("SELECT gh_number FROM work_items WHERE id = $1", [id])).rows[0]!.gh_number);

  async function action(a: SeedRefs, workItemId: string): Promise<string> {
    const row = await withTenant(appPool, a.accountId, a.userId, undefined, async (c) => (await c.query("SELECT * FROM run_action_request('advance_work_item', $1, NULL, $2)", [workItemId, "h".repeat(64)])).rows[0]);
    expect(await createRunActionFacade(writerPool, {} as never).claimRunAction(row.action_id, 600)).not.toBeNull();
    return row.action_id;
  }
  const who = (a: SeedRefs, workItemId: string) => ({ accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 });
  /** The executor run the build left behind, with its session. */
  async function buildRun(a: SeedRefs, workItemId: string, status: "succeeded" | "running" = "succeeded"): Promise<string> {
    const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId, dispatchPrNumber: await numberOf(workItemId) });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "pending", to: "running" });
    if (status === "succeeded") await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "running", to: "succeeded", result: { sessionId: "cc-session-1", envelope: { verdict: "done" } } });
    else await admin.query("UPDATE agent_runs SET cc_session_id = 'cc-session-1' WHERE id = $1", [id]);
    return id;
  }
  async function reviewerRun(a: SeedRefs, workItemId: string, role: string): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, $4, 'production', 'succeeded', '{\"verdict\":\"needs-fix\"}'::jsonb, $5)", [id, a.accountId, workItemId, role, HEAD]);
    return id;
  }
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]!.stage;
  const events = async (id: string) => (await admin.query<{ kind: string; code: string | null; round: number | null; run_id: string | null; head_sha: string | null }>("SELECT kind, code, round, run_id, head_sha FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq", [id])).rows;
  const fixRequest = (_a: SeedRefs, over: Partial<Parameters<ReturnType<typeof build>["module"]["advanceStartFix"]>[1]> = {}) => ({
    issue: 7,
    headSha: HEAD,
    prompt: "fix it",
    round: 1,
    actionId: randomUUID(),
    reviewer: "code" as const,
    failingRunId: randomUUID(),
    ...over,
  });

  // ---- the approval at the new stages and its pre-flight ------------------------------------------------------

  describe("performAdvanceWorkItem at the new stages", () => {
    it.each(["pr_opened", "changes_requested", "review_passed"])("an owner's approval of an item at %s (with a Spec) starts the workflow", async (stage) => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage });
      const started: unknown[] = [];
      const t = build({ startAdvance: async (args) => void started.push(args) });
      expect(await t.module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "done", outcome: { work_item_id: w, advance: "started" } });
      expect(started).toHaveLength(1);
    });

    it("the approval carries the Spec version it was performed against, so the build and the review are pinned to it", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "pr_opened" });
      await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 2, 'v2', encode(sha256(convert_to('v2', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
      const started: Array<{ specVersion?: number | null }> = [];
      const t = build({ startAdvance: async (args) => void started.push(args) });
      await t.module.performAdvanceWorkItem(await action(a, w));
      expect(started[0]!.specVersion).toBe(2);
      const none = await item(a, { stage: "triaged", spec: false });
      await admin.query("UPDATE work_items SET discussion_id = NULL WHERE id = $1", [none]);
      await t.module.performAdvanceWorkItem(await action(a, none));
      expect(started[1]!.specVersion).toBeNull();
    });

    it("an item at pr_opened with no published Spec cannot be reviewed", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "pr_opened", spec: false });
      const t = build();
      expect(await t.module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "refused", errorCode: "not_advanceable" });
    });

    it.each([
      ["a feature with no Spec", { stage: "discussing", kind: "feature", spec: false }, true],
      ["a critical with no Spec", { stage: "discussing", kind: "critical", spec: false }, true],
      ["a project (it has no panel)", { stage: "discussing", kind: "project", spec: false }, false],
      ["a feature that already has a Spec (sent back to the panel: a new Spec supersedes it)", { stage: "discussing", kind: "feature", spec: true }, true],
    ] as const)("an item at discussing: %s", async (_n, o, ok) => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, o);
      const t = build();
      const out = await t.module.performAdvanceWorkItem(await action(a, w));
      expect(out.result).toBe(ok ? "done" : "refused");
    });

    it("Check the build: an item at in_progress with a Spec and nothing running starts the workflow; with no Spec it is not advanced", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "in_progress" });
      await buildRun(a, w, "succeeded");
      const started: unknown[] = [];
      const t = build({ startAdvance: async (args) => void started.push(args) });
      expect(await t.module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "done", outcome: { work_item_id: w, advance: "started" } });
      expect(started).toHaveLength(1);
      const none = await item(a, { stage: "in_progress", spec: false });
      expect(await t.module.performAdvanceWorkItem(await action(a, none))).toEqual({ result: "refused", errorCode: "not_advanceable" });
    });

    it("Check the build asks for no model seat up front: the no-PR path runs no model, so a missing reviewer seat does not refuse it", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "in_progress" });
      const started: unknown[] = [];
      const resolveRunSeat = vi.fn(async (_r: unknown) => ({ ok: false as const, reason: "no_model" }) as never);
      const t = build({ startAdvance: async (args) => void started.push(args), resolveRunSeat });
      expect(await t.module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "done", outcome: { work_item_id: w, advance: "started" } });
      expect(resolveRunSeat).not.toHaveBeenCalled();
      expect(started).toHaveLength(1);
    });

    it("Check the build is refused already_running while a run of the item is live", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "in_progress" });
      await buildRun(a, w, "running");
      const started: unknown[] = [];
      const t = build({ startAdvance: async (args) => void started.push(args) });
      expect(await t.module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "refused", errorCode: "already_running" });
      expect(started).toEqual([]);
    });

    it.each(["merged", "closed_unmerged"])("an item at %s is not advanced", async (stage) => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage });
      expect(await build().module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "refused", errorCode: "not_advanceable" });
    });

    // Build again: the Needs-a-person row of the one table.
    it("an item at needs_human with its Spec is advanced (Build again): the workflow starts once with the Spec version pinned", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "needs_human" });
      const started: unknown[] = [];
      const t = build({ startAdvance: async (args) => void started.push(args) });
      expect(await t.module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "done", outcome: { work_item_id: w, advance: "started" } });
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ workItemId: w, specVersion: 1 });
    });

    it.each([
      ["no published Spec", { spec: false }],
      ["a project", { kind: "project" }],
      ["a question", { kind: "question" }],
    ])("an item at needs_human with %s is refused not_advanceable and starts nothing", async (_n, over) => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "needs_human", ...over });
      const started: unknown[] = [];
      expect(await build({ startAdvance: async (args) => void started.push(args) }).module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "refused", errorCode: "not_advanceable" });
      expect(started).toEqual([]);
    });

    it("Build again asks for the EXECUTOR's seat first, and a refused seat is the action's error and a recorded build_refused fact; a run live on the item refuses it", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "needs_human" });
      const resolveRunSeat = vi.fn(async () => ({ ok: false as const, reason: "no_model" as const }));
      const started: unknown[] = [];
      const t = build({ startAdvance: async (args) => void started.push(args), resolveRunSeat });
      expect(await t.module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "refused", errorCode: "no_model" });
      expect(resolveRunSeat).toHaveBeenCalledWith({ accountId: a.accountId, role: "executor", workItemId: w });
      expect(await events(w)).toEqual([expect.objectContaining({ kind: "build_refused", code: "no_model" })]);
      expect(started).toEqual([]);
      const b = await seedAccount(admin, randomUUID());
      const live = await item(b, { stage: "needs_human" });
      await buildRun(b, live, "running");
      expect(await build({ startAdvance: async (args) => void started.push(args) }).module.performAdvanceWorkItem(await action(b, live))).toEqual({ result: "refused", errorCode: "already_running" });
      expect(started).toEqual([]);
    });
  });

  describe("the cost-free pre-flight: a refusal reaches the Approve sentence, before anything starts", () => {
    it.each([
      ["no_model", "spec_ready", "executor"],
      ["model_budget_unset", "spec_ready", "executor"],
      ["no_card", "pr_opened", "code-reviewer"],
      ["no_installation", "pr_opened", "code-reviewer"],
      ["no_model", "triaged", "project-manager"],
      ["model_budget_unset", "discussing", "project-manager"],
    ] as const)("a seat refused with %s for an item at %s is the action's error code, asked for the first role the action starts (%s)", async (reason, stage, role) => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage, spec: stage !== "discussing" && stage !== "triaged" });
      if (stage === "triaged") await admin.query("UPDATE work_items SET discussion_id = NULL WHERE id = $1", [w]);
      const started: unknown[] = [];
      const resolveRunSeat = vi.fn(async () => ({ ok: false as const, reason }));
      const t = build({ startAdvance: async (args) => void started.push(args), resolveRunSeat });
      expect(await t.module.performAdvanceWorkItem(await action(a, w))).toEqual({ result: "refused", errorCode: reason });
      expect(resolveRunSeat).toHaveBeenCalledWith({ accountId: a.accountId, role, workItemId: w });
      expect(started).toEqual([]);
      expect(t.inputs).toEqual([]);
    });

    it("a refused BUILD start is also a recorded fact of the item (build_refused with the reason), once per approval", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "spec_ready" });
      const t = build({ resolveRunSeat: async () => ({ ok: false as const, reason: "no_model" }) });
      const id = await action(a, w);
      await t.module.performAdvanceWorkItem(id);
      await t.module.performAdvanceWorkItem(id);
      expect(await events(w)).toEqual([expect.objectContaining({ kind: "build_refused", code: "no_model" })]);
    });

    it("other refusals record no build_refused fact", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "pr_opened" });
      await build({ resolveRunSeat: async () => ({ ok: false as const, reason: "no_model" }) }).module.performAdvanceWorkItem(await action(a, w));
      expect(await events(w)).toEqual([]);
    });
  });

  // ---- the plain facade methods -----------------------------------------------------------------------------

  describe("Check the build: the executor run to record against, and the PR-found record", () => {
    it("advanceLoadItem names the item's newest executor run (any status), or null when it has none", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "in_progress" });
      const m = build().module;
      expect((await m.advanceLoadItem(a.accountId, w))!.executorRunId).toBeNull();
      await buildRun(a, w, "succeeded");
      const newest = await buildRun(a, w, "succeeded");
      await reviewerRun(a, w, "code-reviewer");
      expect((await m.advanceLoadItem(a.accountId, w))!.executorRunId).toBe(newest);
    });

    it("advancePrFound records in_progress -> pr_opened once, and leaves an item at any other stage alone", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "in_progress" });
      const m = build().module;
      expect(await m.advancePrFound(who(a, w), 61)).toEqual({ status: "recorded", stage: "pr_opened" });
      expect(await stageOf(w)).toBe("pr_opened");
      expect(await m.advancePrFound(who(a, w), 61)).toEqual({ status: "unchanged", stage: "pr_opened" });
      const other = await item(a, { stage: "needs_human" });
      expect(await m.advancePrFound(who(a, other), 61)).toEqual({ status: "unchanged", stage: "needs_human" });
      expect(await stageOf(other)).toBe("needs_human");
    });

    it("advancePrFound answers the stage as it stands AFTER the attempt: two checks at once both say pr_opened", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "in_progress" });
      const m = build().module;
      const [x, y] = await Promise.all([m.advancePrFound(who(a, w), 61), m.advancePrFound(who(a, w), 61)]);
      expect([x.status, y.status].sort()).toEqual(["recorded", "unchanged"]);
      expect(x.stage).toBe("pr_opened");
      expect(y.stage).toBe("pr_opened");
    });

    it("advancePrFound refuses bad input and an external item", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "in_progress" });
      const m = build().module;
      for (const pr of [0, -1, 1.5, Number.NaN]) expect(await m.advancePrFound(who(a, w), pr)).toMatchObject({ status: "refused", reason: "invalid_input" });
      expect(await m.advancePrFound({ ...who(a, w), workItemId: "x" }, 5)).toMatchObject({ status: "refused" });
      const ext = await item(a, { stage: "in_progress", provenance: "external" });
      expect(await m.advancePrFound(who(a, ext), 61)).toMatchObject({ status: "refused" });
      expect(await stageOf(ext)).toBe("in_progress");
      expect(await stageOf(w)).toBe("in_progress");
    });
  });

  describe("advanceLoadItem and advanceStartRun", () => {
    it("loadItem reports the newest published Spec's version (the approval pins it)", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "spec_ready" });
      await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 2, 'v2', encode(sha256(convert_to('v2', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
      expect((await build().module.advanceLoadItem(a.accountId, w))!.specVersion).toBe(2);
      await admin.query("UPDATE spec_versions SET erased_at = now() WHERE work_item_id = $1 AND version = 2", [w]);
      expect((await build().module.advanceLoadItem(a.accountId, w))!.specVersion).toBe(1);
      const none = await item(a, { stage: "triaged", spec: false });
      expect((await build().module.advanceLoadItem(a.accountId, none))!.specVersion).toBeNull();
    });

    it("a reviewer run is started with the head it is for (it lands on the run, which is what the gate reads)", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const t = build();
      await t.module.advanceStartRun({ accountId: a.accountId, workItemId: w, haltEpoch: 0, step: `review:${HEAD}:code-reviewer`, role: "code-reviewer", prompt: "p", clone: true, headSha: HEAD });
      expect(t.inputs[0]).toMatchObject({ headSha: HEAD, role: "code-reviewer", cloneRepo: { owner: "acme", name: "widgets" }, idempotency: { key: `advance:${w}:review:${HEAD}:code-reviewer` } });
    });

    it("two starts racing for one executor lose to the database's one-live-executor index: the loser is told already_running, nothing is left behind", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "spec_ready" });
      const t = build({
        starter: {
          async start() {
            throw new DuplicateExecutorRunError();
          },
        },
      });
      expect(await t.module.advanceStartRun({ accountId: a.accountId, workItemId: w, haltEpoch: 0, step: "build:v1:x", role: "executor", prompt: "p", clone: true, pr: 7 })).toEqual({ ok: false, reason: "already_running" });
    });
  });

  describe("advanceBuild and advanceSpec pass the pins through", () => {
    it("the Spec version the person approved goes to the build; a refused start is recorded as a fact once", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "spec_ready" });
      const calls: unknown[][] = [];
      const t = build({
        build: (async (...args: unknown[]) => (calls.push(args.slice(2)), { status: "refused", reason: "spec_changed" })) as never,
      });
      const approval = randomUUID();
      const out = await t.module.advanceBuild(who(a, w), approval, 4);
      expect(out).toEqual({ status: "refused", reason: "spec_changed" });
      expect(calls[0]!.slice(0, 2)).toEqual([w, approval]);
      expect(calls[0]![3]).toEqual({ expectedVersion: 4 });
      await t.module.advanceBuild(who(a, w), approval, 4);
      expect((await events(w)).filter((e) => e.kind === "build_refused")).toEqual([expect.objectContaining({ code: "spec_changed" })]);
    });

    it("a started build records nothing; an invalid pin is refused before the pipeline is asked", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "spec_ready" });
      const build1 = vi.fn(async () => ({ status: "started", runId: "r" }));
      const t = build({ build: build1 as never });
      await t.module.advanceBuild(who(a, w), randomUUID(), 2);
      expect(await events(w)).toEqual([]);
      expect(await t.module.advanceBuild(who(a, w), randomUUID(), 0)).toEqual({ status: "refused", reason: "invalid_input" });
      expect(await t.module.advanceBuild(who(a, w), randomUUID(), 1.5)).toEqual({ status: "refused", reason: "invalid_input" });
      expect(build1).toHaveBeenCalledTimes(1);
    });

    it("the approval names the Spec attempt; a value that is not an id is refused", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "discussing", spec: false });
      const spec = vi.fn(async (..._args: unknown[]) => ({ status: "published" }));
      const t = build({ spec: spec as never });
      const attempt = randomUUID();
      await t.module.advanceSpec(who(a, w), attempt);
      expect(spec.mock.calls[0]![4]).toEqual({ attempt });
      expect(await t.module.advanceSpec(who(a, w), "not-an-id")).toEqual({ status: "refused", reason: "invalid_input" });
      expect(spec).toHaveBeenCalledTimes(1);
    });
  });

  // ---- the fix round -----------------------------------------------------------------------------------------------

  describe("advanceStartFix: a RESUME of the build's session", () => {
    it("continues the build's session in the build's checkout: the ISSUE's number as pr, the workdir, no clone, the build run as parent, a key naming the head and the approval", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const parent = await buildRun(a, w);
      const resume = realResume();
      const t = build({}, review({ resume: resume.fn }));
      const req = fixRequest(a, { issue: await numberOf(w), prompt: "FIX PROMPT", round: 2 });
      const out = await t.module.advanceStartFix(who(a, w), req);
      expect(out.ok).toBe(true);
      const input = resume.inputs[0]!;
      expect(input).toMatchObject({
        accountId: a.accountId,
        workItemId: w,
        role: "executor",
        product: "team",
        pr: req.issue,
        parentRunId: parent,
        prompt: "FIX PROMPT",
        workdir: PREVIEW_WORKDIR,
        repoId: a.repoId,
      });
      expect(input.cloneRepo).toBeUndefined();
      expect(input.idempotency!.key).toBe(`advance:${w}:fix:${HEAD}:${req.actionId}`);
      // The run row names its parent and the PR.
      const row = (await admin.query("SELECT parent_run_id, dispatch_pr_number::int AS pr FROM agent_runs WHERE id = $1", [(out as { runId: string }).runId])).rows[0];
      expect(row).toEqual({ parent_run_id: parent, pr: req.issue });
    });

    it("moves the card to Changes requested whatever an earlier record said, and records the fix round started", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "review_passed" });
      await buildRun(a, w);
      const failing = await reviewerRun(a, w, "acceptance-tester");
      const t = build({}, review({ resume: realResume().fn }));
      const out = await t.module.advanceStartFix(who(a, w), fixRequest(a, { reviewer: "acceptance", failingRunId: failing, round: 1 }));
      expect(out.ok).toBe(true);
      expect(await stageOf(w)).toBe("changes_requested");
      const tr = await admin.query("SELECT to_stage, reviewer, source_ref FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'changes_requested'", [w]);
      expect(tr.rows).toEqual([{ to_stage: "changes_requested", reviewer: "acceptance", source_ref: `fix-round:${failing}` }]);
      expect(await events(w)).toEqual([expect.objectContaining({ kind: "fix_round_started", round: 1, head_sha: HEAD, run_id: (out as { runId: string }).runId })]);
    });

    it("an item already at changes_requested is not moved again", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "changes_requested" });
      await buildRun(a, w);
      await build({}, review({ resume: realResume().fn })).module.advanceStartFix(who(a, w), fixRequest(a));
      expect((await admin.query("SELECT 1 FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'changes_requested'", [w])).rowCount).toBe(0);
    });

    it("a replay of the same approval on the same head returns the run it started, resumes nothing a second time, and records one fact", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      await buildRun(a, w);
      const resume = realResume();
      const t = build({}, review({ resume: resume.fn }));
      const req = fixRequest(a);
      const first = await t.module.advanceStartFix(who(a, w), req);
      // The fix run ends; the replay must not start another.
      await writeRunStatus(writerPool, { accountId: a.accountId, runId: (first as { runId: string }).runId, from: "running", to: "succeeded", result: { sessionId: "cc-session-2", envelope: { verdict: "done" } } });
      const again = await t.module.advanceStartFix(who(a, w), req);
      expect(again).toEqual(first);
      expect(resume.fn).toHaveBeenCalledTimes(1);
      expect((await events(w)).filter((e) => e.kind === "fix_round_started")).toHaveLength(1);
    });

    it("a step that died after the resume but before the event write: the replay finds the claimed run and still writes fix_round_started (deduped), so rounds are not undercounted", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      await buildRun(a, w);
      const req = fixRequest(a, { round: 2 });
      // The resume ran (the run row and its key exist) and the process died before the event was written.
      const { id } = await insertAgentRun(writerPool, {
        id: randomUUID(), accountId: a.accountId, workItemId: w, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId,
        idempotency: { key: `advance:${w}:fix:${HEAD}:${req.actionId}`, requestHash: "0".repeat(64) },
      });
      await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "pending", to: "running" });
      await writeRunStatus(writerPool, { accountId: a.accountId, runId: id, from: "running", to: "succeeded", result: { sessionId: "cc-2", envelope: { verdict: "done" } } });
      expect(await events(w)).toEqual([]);
      const resume = realResume();
      const t = build({}, review({ resume: resume.fn }));
      expect(await t.module.advanceStartFix(who(a, w), req)).toEqual({ ok: true, runId: id });
      expect(resume.fn).not.toHaveBeenCalled();
      expect(await events(w)).toEqual([expect.objectContaining({ kind: "fix_round_started", round: 2, head_sha: HEAD, run_id: id })]);
      await t.module.advanceStartFix(who(a, w), req);
      expect((await events(w)).filter((e) => e.kind === "fix_round_started")).toHaveLength(1);
    });

    it("the race where the key is taken between the check and the resume also writes the fact", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      await buildRun(a, w);
      const req = fixRequest(a);
      const key = `advance:${w}:fix:${HEAD}:${req.actionId}`;
      let won = "";
      const losing = vi.fn(async (_p: Pool, _r: ExecutionTargetRegistry, input: StartAgentRunInput) => {
        // another caller wins the key first, then this one's insert collides with it
        const first = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId: w, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: a.repoId, idempotency: { key, requestHash: "0".repeat(64) } });
        won = first.id;
        await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId: w, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: input.repoId, idempotency: input.idempotency });
        return { id: "unreachable", status: "running" };
      });
      const out = await build({}, review({ resume: losing })).module.advanceStartFix(who(a, w), req);
      expect(out).toEqual({ ok: true, runId: won });
      expect((await events(w)).filter((e) => e.kind === "fix_round_started")).toEqual([expect.objectContaining({ run_id: won })]);
    });

    it("D#6 R3a: a fix round the target queued for a runner is cancelled and recorded as a failure, never logged as resumed or reported as started", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      await buildRun(a, w);
      const queued = vi.fn(async (_p: Pool, _r: ExecutionTargetRegistry, input: StartAgentRunInput) => {
        const { id } = await insertAgentRun(writerPool, {
          id: randomUUID(), accountId: input.accountId, workItemId: input.workItemId, parentRunId: input.parentRunId, role: "executor",
          runtime: "runner", executionMode: "runner_local", dispatchRepoId: input.repoId, idempotency: input.idempotency,
        });
        return { id, status: "pending", queued: true } as { id: string; status: string };
      });
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const out = await build({}, review({ resume: queued })).module.advanceStartFix(who(a, w), fixRequest(a));
        expect(out).toEqual({ ok: false, reason: "resume_failed" });
        expect(info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("advance.resumed"))).toEqual([]);
      } finally {
        vi.restoreAllMocks();
      }
      expect((await admin.query("SELECT status FROM agent_runs WHERE account_id = $1 AND runtime = 'runner'", [a.accountId])).rows).toEqual([{ status: "cancelled" }]);
      expect((await events(w)).filter((e) => e.kind === "fix_round_started")).toEqual([]);
    });

    it("a second concurrent resume is refused (already_running) and recorded; nothing is started", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      await buildRun(a, w, "running"); // an executor run of the item is still live
      const resume = realResume();
      const t = build({}, review({ resume: resume.fn }));
      expect(await t.module.advanceStartFix(who(a, w), fixRequest(a))).toEqual({ ok: false, reason: "already_running" });
      expect(resume.fn).not.toHaveBeenCalled();
      expect(await events(w)).toEqual([expect.objectContaining({ kind: "fix_round_refused", code: "already_running" })]);
    });

    it("two fix rounds racing (two approvals) lose to the database: one runs, the other is told already_running", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      await buildRun(a, w);
      const t = build({}, review({ resume: realResume().fn }));
      const [x, y] = await Promise.all([t.module.advanceStartFix(who(a, w), fixRequest(a)), t.module.advanceStartFix(who(a, w), fixRequest(a))]);
      const outs = [x, y];
      expect(outs.filter((o) => o.ok)).toHaveLength(1);
      expect(outs.filter((o) => !o.ok)).toEqual([{ ok: false, reason: "already_running" }]);
    });

    it("an item whose build left no session cannot be resumed: no_session, nothing started", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const resume = realResume();
      expect(await build({}, review({ resume: resume.fn })).module.advanceStartFix(who(a, w), fixRequest(a))).toEqual({ ok: false, reason: "no_session" });
      expect(resume.fn).not.toHaveBeenCalled();
    });

    it.each(["needs_human", "merged", "closed_unmerged", "closed", "in_progress", "spec_ready"])("an item at %s gets no fix round, and keeps its stage", async (stage) => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage });
      await buildRun(a, w);
      const resume = realResume();
      const out = await build({}, review({ resume: resume.fn })).module.advanceStartFix(who(a, w), fixRequest(a));
      expect(out).toEqual({ ok: false, reason: `stage_${stage}` });
      expect(resume.fn).not.toHaveBeenCalled();
      expect(await stageOf(w)).toBe(stage);
    });

    it("a seat that is refused (no model, spend) is the reason, recorded, and the card is not moved", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "review_passed" });
      await buildRun(a, w);
      const t = build({ resolveRunSeat: async () => ({ ok: false as const, reason: "model_budget_unset" }) }, review({ resume: realResume().fn }));
      expect(await t.module.advanceStartFix(who(a, w), fixRequest(a))).toEqual({ ok: false, reason: "model_budget_unset" });
      expect(await stageOf(w)).toBe("review_passed");
      expect(await events(w)).toEqual([expect.objectContaining({ kind: "fix_round_refused", code: "model_budget_unset" })]);
    });

    it("a spend refusal at admit is refused_spend, recorded; a resume that throws is resume_failed, recorded with a fixed code and none of its text", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w1 = await item(a);
      await buildRun(a, w1);
      expect(await build({}, review({ resume: realResume({ status: "refused_spend" }).fn })).module.advanceStartFix(who(a, w1), fixRequest(a))).toEqual({ ok: false, reason: "refused_spend" });
      const w2 = await item(a);
      await buildRun(a, w2);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const out = await build({}, review({ resume: realResume({ throws: new Error("boom SECRET-TOKEN ghp_x") }).fn })).module.advanceStartFix(who(a, w2), fixRequest(a));
      expect(out).toEqual({ ok: false, reason: "resume_failed" });
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET|ghp_/);
      warn.mockRestore();
      expect((await events(w2)).at(-1)).toMatchObject({ kind: "fix_round_refused", code: "resume_failed" });
    });

    it("an external item is refused before anything else", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { provenance: "external" });
      await buildRun(a, w);
      expect(await build({}, review({ resume: realResume().fn })).module.advanceStartFix(who(a, w), fixRequest(a))).toEqual({ ok: false, reason: "external_requires_human" });
    });

    it.each([
      ["issue 0", { issue: 0 }],
      ["a head that is not a commit id", { headSha: "main" }],
      ["an empty prompt", { prompt: "" }],
      ["an enormous prompt", { prompt: "x".repeat(200_000) }],
      ["round 0", { round: 0 }],
      ["round 99", { round: 99 }],
      ["an unknown reviewer", { reviewer: "debater" as never }],
      ["an action id that is not an id", { actionId: "nope" }],
      ["a failing run id that is not an id", { failingRunId: "nope" }],
    ])("%s is invalid input, before the database is read", async (_n, over) => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const resume = realResume();
      expect(await build({}, review({ resume: resume.fn })).module.advanceStartFix(who(a, w), fixRequest(a, over))).toEqual({ ok: false, reason: "invalid_input" });
      expect(resume.fn).not.toHaveBeenCalled();
    });

    it("is unavailable without the review dependencies", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      expect(await build({}, null).module.advanceStartFix(who(a, w), fixRequest(a))).toEqual({ ok: false, reason: "resume_unavailable" });
    });
  });

  // ---- the round record, the gate, the events, the cancel ----------------------------------------------------------

  describe("advanceRecordRound", () => {
    const run1 = randomUUID();
    const run2 = randomUUID();
    const input = (over: Record<string, unknown> = {}) => ({
      headSha: HEAD,
      prNumber: 41,
      requiredRoles: ["code-reviewer", "acceptance-tester"],
      verdicts: [
        { role: "code-reviewer", runId: run1, verdict: "needs-fix" },
        { role: "acceptance-tester", runId: run2, verdict: "pass" },
      ],
      ...over,
    });

    it("hands the pipeline every verdict of the head in one call, bound to the item", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const rd = review();
      const out = await build({}, rd).module.advanceRecordRound(who(a, w), input());
      expect(out).toMatchObject({ decision: "all_passed" });
      expect(rd.recordRound).toHaveBeenCalledTimes(1);
      expect((rd.recordRound as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatchObject({ accountId: a.accountId, workItemId: w, headSha: HEAD, prNumber: 41 });
    });

    it.each([
      ["a head that is not a commit id", { headSha: "x" }],
      ["a PR number of zero", { prNumber: 0 }],
      ["a role that is not a reviewer", { requiredRoles: ["executor"] }],
      ["no required roles", { requiredRoles: [] }],
      ["a verdict word of 'Pass'", { verdicts: [{ role: "code-reviewer", runId: run1, verdict: "Pass" }] }],
      ["a run that is not an id", { verdicts: [{ role: "code-reviewer", runId: "x", verdict: "pass" }] }],
      ["a debated role that is not a reviewer", { verdicts: [{ role: "debater", runId: run1, verdict: "pass", debatedRole: "executor" }] }],
      ["five verdicts", { verdicts: Array.from({ length: 5 }, () => ({ role: "code-reviewer", runId: run1, verdict: "pass" })) }],
      ["a round outside 0..20", { round: 21 }],
    ])("%s is refused before the pipeline is asked", async (_n, over) => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const rd = review();
      expect(await build({}, rd).module.advanceRecordRound(who(a, w), input(over))).toEqual({ decision: "refused", reason: "invalid_input" });
      expect(rd.recordRound).not.toHaveBeenCalled();
    });

    it("an external item is refused; without the dependencies it is unavailable", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { provenance: "external" });
      expect(await build({}, review()).module.advanceRecordRound(who(a, w), input())).toEqual({ decision: "refused", reason: "external_requires_human" });
      expect(await build({}, null).module.advanceRecordRound(who(a, w), input())).toEqual({ decision: "refused", reason: "review_unavailable" });
    });
  });

  describe("advanceMergeGate, advanceLoadReview and advanceLoadSpecText", () => {
    it("runs the gate for the item on the pull request, after the external guard", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const rd = review();
      expect(await build({}, rd).module.advanceMergeGate(who(a, w), 41)).toMatchObject({ outcome: "merged" });
      expect(rd.mergeGate).toHaveBeenCalledWith(writerPool, { accountId: a.accountId, workItemId: w, prNumber: 41 });
      const ext = await item(a, { provenance: "external" });
      expect(await build({}, rd).module.advanceMergeGate(who(a, ext), 41)).toEqual({ outcome: "refused", reason: "external_requires_human" });
      expect(await build({}, rd).module.advanceMergeGate(who(a, w), 0)).toEqual({ outcome: "refused", reason: "invalid_input" });
      expect(await build({}, null).module.advanceMergeGate(who(a, w), 41)).toEqual({ outcome: "refused", reason: "review_unavailable" });
    });

    it("the review context is the pipeline's, behind the same guard", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const out = await build({}, review()).module.advanceLoadReview(who(a, w));
      expect(out).toMatchObject({ ok: true, ctx: { owner: "acme" } });
      const ext = await item(a, { provenance: "external" });
      expect(await build({}, review()).module.advanceLoadReview(who(a, ext))).toEqual({ ok: false, reason: "external_requires_human" });
      expect(await build({}, null).module.advanceLoadReview(who(a, w))).toEqual({ ok: false, reason: "review_unavailable" });
    });

    it("the Spec text is returned for the approved version only", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const t = build();
      expect(await t.module.advanceLoadSpecText(who(a, w), 1)).toEqual({ version: 1, body: "spec" });
      expect(await t.module.advanceLoadSpecText(who(a, w), 2)).toBeNull();
      expect(await t.module.advanceLoadSpecText(who(a, w), 0)).toBeNull();
      expect(await t.module.advanceLoadSpecText({ ...who(a, w), workItemId: "nope" }, 1)).toBeNull();
      const other = await seedAccount(admin, randomUUID());
      expect(await t.module.advanceLoadSpecText({ accountId: other.accountId, userId: other.userId, workItemId: w, haltEpoch: 0 }, 1)).toBeNull();
    });
  });

  describe("a runner repository's pull request is the one its run recorded at done (D#6 C25 section 1.2)", () => {
    const branchOf = (runId: string, generation = 1) => `fx/${runId}-g${generation}`;
    /** An executor run that finished through the runner's `done`, recording `prNumber` and `branch` the way the writer does. */
    async function doneRun(a: SeedRefs, workItemId: string, o: { prNumber: number | null; branch?: (id: string) => string | undefined; role?: string; status?: "succeeded" | "failed" }): Promise<string> {
      const id = randomUUID();
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, $4, 'production', 'running')", [id, a.accountId, workItemId, o.role ?? "executor"]);
      const branch = o.branch ? o.branch(id) : branchOf(id);
      const to = o.status ?? "succeeded";
      await writeRunStatus(writerPool, {
        accountId: a.accountId,
        runId: id,
        from: "running",
        to,
        ...(to === "failed" ? { failureReason: "scope_violation" } : {}),
        runnerDone: { prNumber: o.prNumber, ...(branch === undefined ? {} : { branch }) },
      });
      return id;
    }
    const mode = (a: SeedRefs, executionMode: string) => admin.query("UPDATE repos SET execution_mode = $2 WHERE id = $1", [a.repoId, executionMode]);
    const recordedOf = async (a: SeedRefs, w: string) => {
      const fromReview = await build({}, review()).module.advanceLoadReview(who(a, w));
      const fromItem = await build().module.advanceLoadItem(a.accountId, w);
      expect(fromReview.ok).toBe(true);
      const ctx = (fromReview as { ctx: { executionMode: string; recordedPr: unknown } }).ctx;
      // The two loads (the review's and "Check the build" and "Build again"'s) answer the same.
      expect({ executionMode: fromItem!.executionMode, recordedPr: fromItem!.recordedPr }).toEqual({ executionMode: ctx.executionMode, recordedPr: ctx.recordedPr });
      return ctx;
    };

    it("a runner_local repository answers the recorded number and branch, and the branch is not fx/issue-<n>", async () => {
      const a = await seedAccount(admin, randomUUID());
      await mode(a, "runner_local");
      const w = await item(a);
      const run = await doneRun(a, w, { prNumber: 41 });
      const ctx = await recordedOf(a, w);
      expect(ctx).toMatchObject({ executionMode: "runner_local", recordedPr: { number: 41, branch: branchOf(run) } });
      expect((ctx.recordedPr as { branch: string }).branch).not.toBe(`fx/issue-${await numberOf(w)}`);
    });

    it("no record is null: a run with no pull request, a run that has not finished, and an item with no run", async () => {
      const a = await seedAccount(admin, randomUUID());
      await mode(a, "runner_local");
      const w = await item(a);
      expect(await recordedOf(a, w)).toMatchObject({ executionMode: "runner_local", recordedPr: null });
      await doneRun(a, w, { prNumber: null, branch: () => undefined });
      expect(await recordedOf(a, w)).toMatchObject({ recordedPr: null });
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')", [randomUUID(), a.accountId, w]);
      expect(await recordedOf(a, w)).toMatchObject({ recordedPr: null });
    });

    it("the newest succeeded recording wins (a fix round's done); a failed run's newer record is ignored, and with only a failed record there is none", async () => {
      const a = await seedAccount(admin, randomUUID());
      await mode(a, "runner_local");
      const w = await item(a);
      await doneRun(a, w, { prNumber: 41 });
      const fix = await doneRun(a, w, { prNumber: 41 });
      expect(await recordedOf(a, w)).toMatchObject({ recordedPr: { number: 41, branch: branchOf(fix) } });
      // A newer run that failed (its pull request was closed for scope_violation) is not the review target, even though it is the newest record.
      await doneRun(a, w, { prNumber: 52, status: "failed" });
      expect(await recordedOf(a, w)).toMatchObject({ recordedPr: { number: 41, branch: branchOf(fix) } });
      // With only a failed record the item has no recorded pull request, so the lookup answers no_open_pr without asking GitHub.
      const b = await seedAccount(admin, randomUUID());
      await mode(b, "runner_local");
      const wb = await item(b);
      await doneRun(b, wb, { prNumber: 52, status: "failed" });
      expect(await recordedOf(b, wb)).toMatchObject({ executionMode: "runner_local", recordedPr: null });
    });

    it("only an executor run of THIS item counts, and only a run branch and a positive number", async () => {
      const a = await seedAccount(admin, randomUUID());
      await mode(a, "runner_local");
      const w = await item(a);
      const other = await item(a);
      await doneRun(a, other, { prNumber: 90 });
      await doneRun(a, w, { prNumber: 41, role: "code-reviewer" });
      expect(await recordedOf(a, w)).toMatchObject({ recordedPr: null });
      const bad = await doneRun(a, w, { prNumber: 41 });
      for (const branch of [`fx/issue-${await numberOf(w)}`, "main", `fx/${bad}-g0`, `fx/${bad}-g1/x`]) {
        await admin.query("UPDATE run_events SET payload = jsonb_set(payload, '{branch}', to_jsonb($2::text)) WHERE run_id = $1 AND kind = 'run.status_changed'", [bad, branch]);
        expect(await recordedOf(a, w), branch).toMatchObject({ recordedPr: null });
      }
      await admin.query("UPDATE run_events SET payload = jsonb_set(payload, '{branch}', to_jsonb($2::text)) WHERE run_id = $1 AND kind = 'run.status_changed'", [bad, branchOf(bad)]);
      for (const pr of [0, -3]) {
        await admin.query("UPDATE run_events SET payload = jsonb_set(payload, '{prNumber}', to_jsonb($2::int)) WHERE run_id = $1 AND kind = 'run.status_changed'", [bad, pr]);
        expect(await recordedOf(a, w), String(pr)).toMatchObject({ recordedPr: null });
      }
    });

    it("a sandbox repository carries no record, even when a run of the item has one", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      await doneRun(a, w, { prNumber: 41 });
      expect(await recordedOf(a, w)).toMatchObject({ executionMode: "sandbox", recordedPr: null });
    });

    it("another account's item answers nothing", async () => {
      const a = await seedAccount(admin, randomUUID());
      await mode(a, "runner_local");
      const w = await item(a);
      await doneRun(a, w, { prNumber: 41 });
      const other = await seedAccount(admin, randomUUID());
      expect(await build().module.advanceLoadItem(other.accountId, w)).toBeNull();
    });
  });

  describe("advanceLightSpec: the short Spec of a small, bug or doc item", () => {
    async function pmRun(a: SeedRefs, w: string, envelope: unknown, status = "succeeded", role = "project-manager"): Promise<string> {
      const id = randomUUID();
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope) VALUES ($1, $2, $3, $4, 'production', $5, $6::jsonb)", [id, a.accountId, w, role, status, JSON.stringify(envelope)]);
      return id;
    }
    const lightDeps = (out: { status: string; reason?: string; version?: number }) => {
      const lightSpec = vi.fn(async (_p: Pool, _a: string, _w: string, _o: unknown) => out);
      return { lightSpec, deps: { lightSpec } as Partial<AdvanceModuleDeps> };
    };
    const action = randomUUID();

    it("publishes from the finished PM run's OWN result (read by the worker, never passed in), and moves nothing itself", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "triaged", kind: "bug", spec: false });
      const run = await pmRun(a, w, { feasible: true, spec: "1. x", summary: "s" });
      const l = lightDeps({ status: "published", version: 1 });
      const out = await build(l.deps).module.advanceLightSpec(who(a, w), run, action);
      expect(out).toEqual({ status: "published", reason: null, version: 1 });
      expect(l.lightSpec.mock.calls[0]!.slice(1)).toEqual([a.accountId, w, { feasible: true, spec: "1. x", summary: "s" }]);
      expect(await events(w)).toEqual([]);
    });

    it("not feasible: nothing is returned of the PM's text, and the stop is a recorded fact naming the run (whose summary is the reason)", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "triaged", kind: "doc", spec: false });
      const run = await pmRun(a, w, { feasible: false, reason: "SECRET-REASON", summary: "SECRET-REASON" });
      const l = lightDeps({ status: "not_feasible", reason: "SECRET-REASON" });
      const m = build(l.deps).module;
      const out = await m.advanceLightSpec(who(a, w), run, action);
      expect(out).toEqual({ status: "not_feasible", reason: null, version: null });
      expect(JSON.stringify(out)).not.toContain("SECRET");
      expect(await events(w)).toEqual([expect.objectContaining({ kind: "stopped", code: "not_feasible", run_id: run })]);
      await m.advanceLightSpec(who(a, w), run, action);
      expect((await events(w)).filter((e) => e.kind === "stopped")).toHaveLength(1);
    });

    it("a refusal carries its plain code only, recorded", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "triaged", kind: "bug", spec: false });
      const run = await pmRun(a, w, {});
      const out = await build(lightDeps({ status: "refused", reason: "invalid_spec_output" }).deps).module.advanceLightSpec(who(a, w), run, action);
      expect(out).toEqual({ status: "refused", reason: "invalid_spec_output", version: null });
      expect(await events(w)).toEqual([expect.objectContaining({ kind: "stopped", code: "invalid_spec_output" })]);
    });

    it("a replay after the Spec was published publishes nothing more (a second publish would add a version)", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "spec_ready", kind: "bug", spec: true });
      const run = await pmRun(a, w, { feasible: true, spec: "1. x" });
      const l = lightDeps({ status: "published", version: 9 });
      expect(await build(l.deps).module.advanceLightSpec(who(a, w), run, action)).toEqual({ status: "published", reason: null, version: 1 });
      expect(l.lightSpec).not.toHaveBeenCalled();
    });

    it.each([
      ["a run that is not the project manager's", async (a: SeedRefs, w: string) => pmRun(a, w, {}, "succeeded", "executor")],
      ["a run that did not succeed", async (a: SeedRefs, w: string) => pmRun(a, w, {}, "failed")],
      ["a run of another item", async (a: SeedRefs) => pmRun(a, await item(a, { stage: "triaged", kind: "bug", spec: false }), {})],
      ["a run that does not exist", async () => randomUUID()],
    ])("%s is not usable: nothing is published", async (_n, make) => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "triaged", kind: "bug", spec: false });
      const l = lightDeps({ status: "published", version: 1 });
      expect(await build(l.deps).module.advanceLightSpec(who(a, w), await make(a, w), action)).toEqual({ status: "refused", reason: "run_not_usable", version: null });
      expect(l.lightSpec).not.toHaveBeenCalled();
    });

    it("an item that moved on (closed) is refused with its stage; an external item and bad ids are refused first; unwired it is unavailable", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a, { stage: "closed", kind: "bug", spec: false });
      const run = await pmRun(a, w, {});
      const l = lightDeps({ status: "published", version: 1 });
      expect(await build(l.deps).module.advanceLightSpec(who(a, w), run, action)).toEqual({ status: "refused", reason: "stage_closed", version: null });
      const ext = await item(a, { stage: "triaged", kind: "bug", spec: false, provenance: "external" });
      expect((await build(l.deps).module.advanceLightSpec(who(a, ext), await pmRun(a, ext, {}), action)).reason).toBe("external_requires_human");
      expect((await build(l.deps).module.advanceLightSpec(who(a, w), "nope", action)).reason).toBe("invalid_input");
      expect((await build(l.deps).module.advanceLightSpec(who(a, w), run, "nope")).reason).toBe("invalid_input");
      expect((await build().module.advanceLightSpec(who(a, w), run, action)).reason).toBe("light_spec_unavailable");
      expect(l.lightSpec).not.toHaveBeenCalled();
    });
  });

  describe("advanceRecordEvent and advanceCancel", () => {
    it("records a fact in the fixed vocabulary, once per key; a value the store would refuse is dropped, not thrown", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const t = build();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(await t.module.advanceRecordEvent(who(a, w), { kind: "fix_pushed_nothing", dedupeKey: "k", headSha: HEAD, prNumber: 41 })).toEqual({ recorded: true });
      expect(await t.module.advanceRecordEvent(who(a, w), { kind: "fix_pushed_nothing", dedupeKey: "k", headSha: HEAD, prNumber: 41 })).toEqual({ recorded: false });
      expect(await t.module.advanceRecordEvent(who(a, w), { kind: "stopped", dedupeKey: "bad", code: "Not a code" })).toEqual({ recorded: false });
      expect(await t.module.advanceRecordEvent(who(a, w), { kind: "nope" as never, dedupeKey: "bad2" })).toEqual({ recorded: false });
      warn.mockRestore();
      expect((await events(w)).map((e) => e.kind)).toEqual(["fix_pushed_nothing"]);
      expect(await t.module.advanceRecordEvent({ ...who(a, w), workItemId: "nope" }, { kind: "stopped", dedupeKey: "x" })).toEqual({ recorded: false });
    });

    it("another tenant's item cannot be written to", async () => {
      const a = await seedAccount(admin, randomUUID());
      const b = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const t = build();
      await expect(t.module.advanceRecordEvent({ accountId: b.accountId, userId: b.userId, workItemId: w, haltEpoch: 0 }, { kind: "stopped", dedupeKey: "x" })).rejects.toThrow();
      expect(await events(w)).toEqual([]);
    });

    it("cancels a live run of the item through the runner's cancel path, as the approver", async () => {
      const a = await seedAccount(admin, randomUUID());
      const w = await item(a);
      const cancelled: string[] = [];
      const reg = { sandbox: { cancel: async (run: ExecutionRun) => (cancelled.push(run.id), { settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;
      const t = build({ registry: reg });
      const live = await buildRun(a, w, "running");
      await t.module.advanceCancel(who(a, w), live);
      expect(cancelled).toEqual([live]);
      // a finished run, and a run of another item, are left alone
      const done = await buildRun(a, w, "succeeded");
      const w2 = await item(a);
      const other = await buildRun(a, w2, "running");
      await t.module.advanceCancel(who(a, w), done);
      await t.module.advanceCancel(who(a, w), other);
      expect(cancelled).toEqual([live]);
    });
  });

  it("the Spec used in a prompt is hashed by the store: sanity check of the helper used above", () => {
    expect(createHash("sha256").update("spec").digest("hex")).toHaveLength(64);
  });
});
