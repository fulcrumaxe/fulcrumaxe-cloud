import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceItem, AdvanceRunStart, AdvanceRunOutcome, AdvanceRunRequest, AdvanceStartArgs, AdvanceStepResult, Worker } from "@fx/worker";
import type { IssueReadResult } from "@fx/github";

/**
 * D#483 P2: the advance workflow's panel, Spec and build phases over a fake worker. `sleep` only runs inside a real
 * workflow execution, so it is mocked (it counts the waits and returns at once), as in workItemAdvance.test.ts.
 */
const world = vi.hoisted(() => ({ sleeps: 0 }));
vi.mock("workflow", () => ({
  sleep: vi.fn(async () => {
    world.sleeps += 1;
  }),
}));
vi.mock("workflow/api", () => ({ resumeHook: vi.fn(), start: vi.fn() }));

import { setWorkerWiringForTests } from "../lib/worker";
import { setIssueReaderForTests } from "../lib/github/issueRead";
import { workItemAdvanceWorkflow } from "./workItemAdvance";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const ROOT = "66666666-6666-4666-8666-666666666666";
const ARGS: AdvanceStartArgs = { accountId: ACCOUNT, userId: "55555555-5555-4555-8555-555555555555", workItemId: ITEM, actionId: "44444444-4444-4444-8444-444444444444", haltEpoch: 0 };
const TRIAGED: AdvanceItem = { stage: "triaged", provenance: "internal", repoId: REPO, ghNumber: 7, ghOwner: "acme", ghName: "widgets", hasDiscussion: false, kind: null, hasSpec: false, specVersion: null, executorRunId: null, executionMode: "sandbox", recordedPr: null };
const AT_SPEC: AdvanceItem = { ...TRIAGED, stage: "spec_ready", hasDiscussion: true, kind: "feature", hasSpec: true, specVersion: 3 };
/** What the build tests see once the pull request is open and the review starts: the review stops at once, so these tests stay about the build (the review has its own file). */
const REVIEW_STOPS = { status: "failed", detail: "review_no_spec" };
const issue: IssueReadResult = { status: "found", title: "T", body: "B", login: "owner-1", state: "open", labels: [] };

interface SetupOptions {
  item?: AdvanceItem;
  triage?: Record<string, unknown>;
  panel?: AdvanceStepResult;
  spec?: AdvanceStepResult;
  build?: AdvanceStepResult;
  /** The executor run's statuses, read one per poll (the last repeats). */
  buildOutcomes?: AdvanceRunOutcome[];
  /** What the worker answers for a run other than the first one (a follow-up run, D#6 C22 section 7). */
  outcomeFor?: (runId: string) => AdvanceRunOutcome | undefined;
  /** The item's stage on each read after the load (the last repeats). */
  stages?: string[];
  /** What publishing the short Spec answers. */
  light?: { status: string; reason: string | null; version: number | null };
}

function setup(o: SetupOptions = {}) {
  const buildOutcomes = [...(o.buildOutcomes ?? [{ status: "succeeded", done: true, envelope: { summary: "I changed the footer." } }])];
  const stages = [...(o.stages ?? ["pr_opened"])];
  let loads = 0;
  const worker = {
    advanceLoadItem: vi.fn(async () => {
      const item = o.item ?? TRIAGED;
      loads += 1;
      // The first read is the workflow's load; the later ones are stage looks after the executor run ended.
      return loads > 1 ? { ...item, stage: stages.length > 1 ? stages.shift()! : stages[0]! } : item;
    }),
    advanceStartRun: vi.fn(async (_req: AdvanceRunRequest): Promise<AdvanceRunStart> => ({ ok: true as const, runId: "run-1" })),
    advanceRunOutcome: vi.fn(async (_account: string, runId: string) => {
      const other = o.outcomeFor?.(runId);
      if (other) return other;
      if (runId !== "run-b") return { status: "succeeded", done: true, envelope: { category: "feature" } };
      return buildOutcomes.length > 1 ? buildOutcomes.shift()! : buildOutcomes[0]!;
    }),
    advanceTriage: vi.fn(async () => o.triage ?? { status: "triaged", stage: "discussing", workItemId: ROOT }),
    advancePanel: vi.fn(async (): Promise<AdvanceStepResult> => o.panel ?? { status: "completed", complete: true, missingRoles: [], round2Ran: false }),
    advanceSpec: vi.fn(async (): Promise<AdvanceStepResult> => o.spec ?? { status: "published", stage: "spec_ready", version: 1 }),
    advanceBuild: vi.fn(async (): Promise<AdvanceStepResult> => o.build ?? { status: "started", runId: "run-b", branch: "fx/issue-7" }),
    advanceBuildFailed: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "recorded", stage: "needs_human" })),
    advanceCancel: vi.fn(async () => undefined),
    advanceRecordEvent: vi.fn(async () => ({ recorded: true })),
    advanceLoadReview: vi.fn(async () => ({ ok: false as const, reason: "no_spec" })),
    advanceLightSpec: vi.fn(async (_who: unknown, _run: string, _action: string) => o.light ?? { status: "published", reason: null, version: 1 }),
  };
  setWorkerWiringForTests({ provider: () => ({}) as never, createWorker: async () => worker as unknown as Worker });
  setIssueReaderForTests(async () => issue);
  return worker;
}

let logs: Array<Record<string, unknown>>;
beforeEach(() => {
  world.sleeps = 0;
  logs = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => void logs.push(JSON.parse(String(line))));
});
afterEach(() => {
  vi.restoreAllMocks();
  setWorkerWiringForTests();
  setIssueReaderForTests();
});
const events = () => logs.map((l) => l.event);

describe("the panel and the Spec after triage", () => {
  it("a critical, feature or project item that triage moved to Discussing gets the panel step and then the Spec step, on the pipeline's root item", async () => {
    const w = setup();
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "spec_ready" });
    expect(w.advancePanel).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: ARGS.userId, workItemId: ROOT, haltEpoch: 0 });
    // The approval names this attempt's PM run.
    expect(w.advanceSpec).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: ARGS.userId, workItemId: ROOT, haltEpoch: 0 }, ARGS.actionId);
    expect(w.advancePanel.mock.invocationCallOrder[0]!).toBeLessThan(w.advanceSpec.mock.invocationCallOrder[0]!);
    expect(events()).toEqual(["advance.classified", "advance.triaged", "advance.panelled", "advance.spec_ready"]);
    expect(logs[3]).toMatchObject({ work_item_id: ROOT, at: "spec", version: 1, stage: "spec_ready" });
  });

  it("small, bug, doc and question stay at Triaged: no panel, no Spec", async () => {
    const w = setup({ triage: { status: "triaged", stage: "triaged", workItemId: ROOT } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "triaged", detail: undefined });
    expect(w.advancePanel).not.toHaveBeenCalled();
    expect(w.advanceSpec).not.toHaveBeenCalled();
  });

  it("an unclassified item (junk category) never reaches the panel", async () => {
    const w = setup({ triage: { status: "unclassified", reason: "x" } });
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("unclassified");
    expect(w.advancePanel).not.toHaveBeenCalled();
  });

  it("a seat that did not post is the Spec's business, not a failure: the Spec step still runs, and the log counts the missing seats", async () => {
    const w = setup({ panel: { status: "completed", complete: false, missingRoles: ["security-expert", "cost-analyst"], round2Ran: false } });
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("spec_ready");
    expect(w.advanceSpec).toHaveBeenCalledTimes(1);
    expect(logs.find((l) => l.event === "advance.panelled")).toMatchObject({ complete: false, missing: 2 });
  });

  it("a refused panel (a project has no panel; a replay on a moved item) ends with the pipeline's reason and never reaches the PM", async () => {
    const w = setup({ panel: { status: "refused", reason: "no_panel" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "panel_refused:no_panel" });
    expect(w.advanceSpec).not.toHaveBeenCalled();
    expect(logs.at(-1)).toMatchObject({ event: "advance.failed", at: "panel", reason: "no_panel" });
  });

  it.each(["pm_failed", "pm_timed_out", "invalid_spec_output", "not_discussing"])("a Spec step the pipeline refuses with %s ends failed with that code", async (reason) => {
    setup({ spec: { status: "refused", reason } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: `spec_${reason}` });
    expect(logs.at(-1)).toMatchObject({ event: "advance.failed", at: "spec", reason });
  });

  it("a Spec too large to store is needs_owner_action, said so in the result and the log", async () => {
    setup({ spec: { status: "needs_owner_action", reason: "spec_too_large" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "needs_owner_action", detail: "spec_too_large" });
    expect(logs.at(-1)).toMatchObject({ event: "advance.stopped", at: "spec", status: "needs_owner_action", reason: "spec_too_large" });
  });

  it("an external item needs a human", async () => {
    setup({ spec: { status: "external_requires_human" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "external_requires_human", detail: undefined });
  });

  it("no result field other than the fixed ones reaches a log line", async () => {
    const hostile = { status: "published", stage: "spec_ready", version: 1, summary: "SECRET-MODEL-TEXT", comment: "SECRET-MODEL-TEXT" } as unknown as AdvanceStepResult;
    setup({ spec: hostile, panel: { status: "completed", complete: true, missingRoles: [], summary: "SECRET-MODEL-TEXT" } as unknown as AdvanceStepResult });
    await workItemAdvanceWorkflow(ARGS);
    expect(JSON.stringify(logs)).not.toContain("SECRET");
  });
});

describe("the build for an item at Spec ready", () => {
  it("starts the executor with the approval, waits durably for the run, and ends once the pull request has moved the item", async () => {
    const w = setup({
      item: AT_SPEC,
      buildOutcomes: [
        { status: "running", done: false, envelope: null },
        { status: "running", done: false, envelope: null },
        { status: "succeeded", done: true, envelope: { summary: "I changed the footer." } },
      ],
      stages: ["pr_opened"],
    });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual(REVIEW_STOPS);
    // The build is pinned to the Spec version read when the workflow started.
    expect(w.advanceBuild).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: ARGS.userId, workItemId: ITEM, haltEpoch: 0 }, ARGS.actionId, 3);
    expect(w.advanceLoadReview).toHaveBeenCalledTimes(1);
    expect(world.sleeps).toBe(2);
    expect(w.advanceBuildFailed).not.toHaveBeenCalled();
    // The build reads no issue, classifies nothing and triages nothing.
    expect(w.advanceStartRun).not.toHaveBeenCalled();
    expect(w.advanceTriage).not.toHaveBeenCalled();
    expect(events()).toEqual(["advance.build_started", "advance.build_ended", "advance.built", "advance.stopped"]);
    expect(logs[1]).toMatchObject({ run_id: "run-b", run_status: "succeeded", has_summary: true });
    expect(logs[2]).toMatchObject({ stage: "pr_opened" });
  });

  it("the log says when the executor left no summary, and never carries it when it did", async () => {
    setup({ item: AT_SPEC, buildOutcomes: [{ status: "succeeded", done: true, envelope: { verdict: "done" } }] });
    await workItemAdvanceWorkflow(ARGS);
    expect(logs.find((l) => l.event === "advance.build_ended")).toMatchObject({ has_summary: false });
    logs.length = 0;
    setup({ item: AT_SPEC, buildOutcomes: [{ status: "succeeded", done: true, envelope: { summary: "SECRET-MODEL-TEXT" } }] });
    await workItemAdvanceWorkflow(ARGS);
    expect(JSON.stringify(logs)).not.toContain("SECRET");
  });

  it("a refused build start (no model key, spend refused, another run live) changes nothing: the item stays at Spec ready, approvable again, and the log says why", async () => {
    const w = setup({ item: AT_SPEC, build: { status: "refused", reason: "start_no_model" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_refused:start_no_model" });
    expect(w.advanceRunOutcome).not.toHaveBeenCalled();
    expect(w.advanceBuildFailed).not.toHaveBeenCalled();
    expect(events()).toEqual(["advance.failed"]);
    expect(logs[0]).toMatchObject({ at: "build_start", reason: "start_no_model" });
    expect(world.sleeps).toBe(0);
  });

  it.each(["failed", "timed_out", "cancelled", "killed_spend", "refused_spend"])("an executor run that ends %s is recorded (Needs human) and the workflow ends failed with a fixed code", async (status) => {
    const w = setup({ item: AT_SPEC, buildOutcomes: [{ status, done: true, envelope: null }] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: `build_${status}` });
    expect(w.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, "run-b", `run_${status}`);
    expect(logs.at(-1)).toMatchObject({ event: "advance.failed", at: "build", reason: `run_${status}`, recorded: "recorded" });
    expect(w.advanceRecordEvent).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: ARGS.userId, workItemId: ITEM, haltEpoch: 0 }, { kind: "stopped", dedupeKey: "build:run-b", code: `build_run_${status}`, runId: "run-b" });
  });

  it("a run that succeeded but opened no pull request is recorded after the grace period", async () => {
    const w = setup({ item: AT_SPEC, stages: ["in_progress"] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_no_pull_request" });
    expect(world.sleeps).toBe(9); // nine 20 second looks at the item: three minutes
    expect(w.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, "run-b", "no_pull_request");
    // The run SUCCEEDED (the Spec said not buildable and the executor correctly made no pull request): the reason is its summary, found through the run this fact names.
    expect(w.advanceRecordEvent).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: ARGS.userId, workItemId: ITEM, haltEpoch: 0 }, { kind: "stopped", dedupeKey: "build:run-b", code: "build_no_pull_request", runId: "run-b" });
  });

  it("a pull request that arrives late (the webhook is a moment behind) is not a failure", async () => {
    const w = setup({ item: AT_SPEC, stages: ["in_progress", "in_progress", "pr_opened"] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual(REVIEW_STOPS);
    expect(world.sleeps).toBe(2);
    expect(w.advanceBuildFailed).not.toHaveBeenCalled();
  });

  it("an item a person moved on while the run was going (closed) is not touched", async () => {
    const w = setup({ item: AT_SPEC, stages: ["closed"] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "built", detail: "closed" });
    expect(w.advanceBuildFailed).not.toHaveBeenCalled();
  });

  it("a run that never ends is given up on after four hours and ten minutes, and recorded", async () => {
    const w = setup({ item: AT_SPEC, buildOutcomes: [{ status: "running", done: false, envelope: null }] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_wait_timeout" });
    expect(world.sleeps).toBe(250);
    expect(w.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, "run-b", "wait_timeout");
    // The run does not keep going behind a card that says Needs human: it is cancelled through the existing path.
    expect(w.advanceCancel).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: ARGS.userId, workItemId: ITEM, haltEpoch: 0 }, "run-b");
    expect(w.advanceCancel.mock.invocationCallOrder[0]!).toBeLessThan(w.advanceBuildFailed.mock.invocationCallOrder[0]!);
  });

  describe("D#6 C22 section 7: a runner run that was lost or hit a usage limit is followed to its follow-up run", () => {
    const FOLLOW_UP = "run-child";
    const chainOutcome = (over: Partial<AdvanceRunOutcome>): AdvanceRunOutcome => ({ status: "running", done: false, envelope: null, runtime: "runner", tailRunId: FOLLOW_UP, ...over });

    it("a first loss does not fail the item: the driver keeps waiting on the follow-up and goes on to the review when it succeeds", async () => {
      const w = setup({
        item: AT_SPEC,
        buildOutcomes: [chainOutcome({ status: "pending" }), chainOutcome({ status: "running" }), chainOutcome({ status: "succeeded", done: true, envelope: { summary: "I changed the footer." } })],
        stages: ["pr_opened"],
      });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual(REVIEW_STOPS);
      expect(w.advanceBuildFailed).not.toHaveBeenCalled();
      expect(w.advanceCancel).not.toHaveBeenCalled();
    });

    it("a wait that runs out cancels the END of the chain, and records the failure against it, not against the run that was lost", async () => {
      const w = setup({ item: AT_SPEC, buildOutcomes: [chainOutcome({ status: "running" })] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_wait_timeout" });
      expect(w.advanceCancel).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: ARGS.userId, workItemId: ITEM, haltEpoch: 0 }, FOLLOW_UP);
      expect(w.advanceCancel).not.toHaveBeenCalledWith(expect.anything(), "run-b");
      expect(w.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, FOLLOW_UP, "wait_timeout");
    });

    it.each([
      ["runner_lost", "runner_lost"],
      ["usage_limit", "runner_usage_limit"],
      ["internal_error", "run_failed"],
    ])("a chain that ended failed (%s) is recorded once, against the last run, under %s", async (failureReason, code) => {
      const end = chainOutcome({ status: "failed", done: true, failureReason });
      const w = setup({ item: AT_SPEC, buildOutcomes: [end], outcomeFor: (id) => (id === FOLLOW_UP ? end : undefined) });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_failed" });
      expect(w.advanceBuildFailed).toHaveBeenCalledTimes(1);
      expect(w.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, FOLLOW_UP, code);
    });
  });

  describe("D#6 C12 A3: time spent pending (a queued runner run) does not count against the four-hour wait", () => {
    const pending = { status: "pending", done: false, envelope: null, runtime: "runner" } as const;
    const running = { status: "running", done: false, envelope: null } as const;

    it("a build that waits six hours for a runner and then succeeds is not given up on", async () => {
      const w = setup({
        item: AT_SPEC,
        buildOutcomes: [...Array.from({ length: 360 }, () => pending), { status: "succeeded", done: true, envelope: { summary: "I changed the footer." } }],
        stages: ["pr_opened"],
      });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual(REVIEW_STOPS);
      expect(world.sleeps).toBe(360);
      expect(w.advanceBuildFailed).not.toHaveBeenCalled();
      expect(w.advanceCancel).not.toHaveBeenCalled();
    });

    it("once the run is running the full 250 minutes apply", async () => {
      const w = setup({ item: AT_SPEC, buildOutcomes: [...Array.from({ length: 300 }, () => pending), running] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_wait_timeout" });
      expect(world.sleeps).toBe(300 + 250);
      expect(w.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, "run-b", "wait_timeout");
    });
  });

  describe("D#6 C12 A3: the pending credit is capped, and only a runner run gets it", () => {
    const pending = { status: "pending", done: false, envelope: null, runtime: "runner" } as const;
    const running = { status: "running", done: false, envelope: null } as const;
    const CEILING_POLLS = (73 * 3600) / 60; // build polls are 60 seconds

    it("a build run held pending past the ceiling ends the wait like any wait timeout", async () => {
      const w = setup({ item: AT_SPEC, buildOutcomes: [pending] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_wait_timeout" });
      expect(world.sleeps).toBe(CEILING_POLLS);
      expect(w.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, "run-b", "wait_timeout");
    });

    it("a sandbox build run that stays pending ends at the normal 250 minutes", async () => {
      setup({ item: AT_SPEC, buildOutcomes: [{ ...pending, runtime: "production" }] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_wait_timeout" });
      expect(world.sleeps).toBe(250);
    });

    it("a runner build that goes pending, then running, then pending keeps its credit", async () => {
      const w = setup({
        item: AT_SPEC,
        buildOutcomes: [...Array.from({ length: 200 }, () => pending), ...Array.from({ length: 100 }, () => running), ...Array.from({ length: 200 }, () => pending), { status: "succeeded", done: true, envelope: { summary: "I changed the footer." } }],
        stages: ["pr_opened"],
      });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual(REVIEW_STOPS);
      expect(world.sleeps).toBe(500);
      expect(w.advanceBuildFailed).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["a project (its Spec is a plan)", { kind: "project" }, "not_advanceable"],
    ["an item with no Spec", { hasSpec: false }, "not_advanceable"],
    ["an external item", { provenance: "external" }, "external_requires_human"],
  ])("%s never starts a build", async (_n, over, reason) => {
    const w = setup({ item: { ...AT_SPEC, ...over } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: reason });
    expect(w.advanceBuild).not.toHaveBeenCalled();
  });
});


describe("the short Spec for a small, bug or doc item (no panel)", () => {
  const LIGHT = { status: "triaged", stage: "triaged", workItemId: ROOT, category: "bug" };

  it.each(["small", "bug", "doc"])("a %s item gets ONE project-manager run keyed to the approval, with the issue's text fenced, then the build on the published version", async (category) => {
    const w = setup({ triage: { ...LIGHT, category }, light: { status: "published", reason: null, version: 4 } });
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual(REVIEW_STOPS);
    const pm = w.advanceStartRun.mock.calls.map((c) => c[0]).filter((r) => r.role === "project-manager" && r.step.startsWith("light-spec:"));
    expect(pm).toHaveLength(1);
    expect(pm[0]).toMatchObject({ workItemId: ROOT, step: `light-spec:${ARGS.actionId}`, clone: true });
    expect(pm[0]!.prompt).toContain(`triaged as "${category}"`);
    expect(pm[0]!.prompt).toContain("<<UNTRUSTED EXTERNAL CONTENT>>");
    expect(w.advancePanel).not.toHaveBeenCalled();
    expect(w.advanceLightSpec).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: ARGS.userId, workItemId: ROOT, haltEpoch: 0 }, "run-1", ARGS.actionId);
    // The build is of the pipeline's card for the issue, pinned to the version just published.
    expect(w.advanceBuild).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: ARGS.userId, workItemId: ROOT, haltEpoch: 0 }, ARGS.actionId, 4);
  });

  it("a request the PM judges not feasible stops BEFORE anything is published or built; the PM's text is never logged or returned", async () => {
    const w = setup({ triage: LIGHT, light: { status: "not_feasible", reason: null, version: null } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "not_feasible" });
    expect(w.advanceBuild).not.toHaveBeenCalled();
    expect(logs.at(-1)).toMatchObject({ event: "advance.stopped", at: "light_spec", reason: "not_feasible" });
  });

  it.each(["failed", "timed_out", "cancelled"])("a PM run that ends %s stops with that status and publishes nothing", async (status) => {
    const w = setup({ triage: LIGHT });
    w.advanceRunOutcome.mockImplementation(async (_a: string, runId: string) => (w.advanceStartRun.mock.calls.some((c) => c[0].step.startsWith("light-spec:") && runId === "run-1") ? { status, done: true, envelope: null } : { status: "succeeded", done: true, envelope: { category: "bug" } }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "light_spec_failed", detail: `run_${status}` });
    expect(w.advanceLightSpec).not.toHaveBeenCalled();
    expect(w.advanceBuild).not.toHaveBeenCalled();
  });

  it("a refused publish (an invalid Spec, a stage that moved) is a stop with its fixed code, and nothing is built", async () => {
    const w = setup({ triage: LIGHT, light: { status: "refused", reason: "invalid_spec_output", version: null } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "light_spec_refused", detail: "invalid_spec_output" });
    expect(w.advanceBuild).not.toHaveBeenCalled();
  });

  it("a PM that is refused to start (no model, spend) is a stop with the reason", async () => {
    const w = setup({ triage: LIGHT });
    w.advanceStartRun.mockImplementation(async (req: AdvanceRunRequest) => (req.step.startsWith("light-spec:") ? { ok: false as const, reason: "no_model" } : { ok: true as const, runId: "run-1" }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "light_spec_refused:no_model" });
  });

  it("an item already triaged by the pipeline, re-approved after the issue was edited, runs a fresh PM on the issue as it reads now (keyed to the new approval)", async () => {
    const root = { ...TRIAGED, stage: "triaged", hasDiscussion: true, kind: "bug", hasSpec: false };
    const w = setup({ item: root });
    setIssueReaderForTests(async () => ({ ...issue, status: "found", title: "EDITED TITLE", body: "edited body" }) as IssueReadResult);
    const again = { ...ARGS, actionId: "99999999-9999-4999-8999-999999999999" };
    await workItemAdvanceWorkflow(again);
    const pm = w.advanceStartRun.mock.calls.map((c) => c[0]).find((r) => r.step.startsWith("light-spec:"))!;
    expect(pm.step).toBe(`light-spec:${again.actionId}`);
    expect(pm.workItemId).toBe(ITEM);
    expect(pm.prompt).toContain("EDITED TITLE");
    expect(w.advanceTriage).not.toHaveBeenCalled();
  });

  it("a question stays at Triaged with no PM run", async () => {
    const w = setup({ triage: { status: "triaged", stage: "triaged", workItemId: ROOT, category: "question" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "triaged", detail: undefined });
    expect(w.advanceStartRun.mock.calls.filter((c) => c[0].step.startsWith("light-spec:"))).toEqual([]);
  });

  it("a project is not specified: stopped, not failed, and a fact is recorded", async () => {
    const w = setup({ triage: { status: "triaged", stage: "discussing", workItemId: ROOT, category: "project" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "project_not_specified" });
    expect(w.advancePanel).not.toHaveBeenCalled();
    expect(logs.at(-1)).toMatchObject({ event: "advance.stopped", reason: "project_not_specified" });
    expect(logs.some((l) => l.event === "advance.failed")).toBe(false);
    expect(w.advanceRecordEvent).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: ARGS.userId, workItemId: ROOT, haltEpoch: 0 }, { kind: "stopped", dedupeKey: `project:${ARGS.actionId}`, code: "project_not_specified" });
  });
});

describe("a halt ends the workflow (DP-C6)", () => {
  const stopEvent = (w: ReturnType<typeof setup>) => (w.advanceRecordEvent.mock.calls as unknown as unknown[][]).map((c) => c[1]).find((e) => (e as { kind: string }).kind === "stopped");

  it("a build the database refused (item_halted) records one stopped event with code halted, waits for nothing and ends", async () => {
    const w = setup({ item: AT_SPEC, build: { status: "refused", reason: "item_halted" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "halted" });
    expect(stopEvent(w)).toMatchObject({ kind: "stopped", code: "halted" });
    expect(world.sleeps).toBe(0);
    expect(w.advanceBuildFailed).not.toHaveBeenCalled();
  });

  it("a panel refused halted_since_approval (the item was halted and resumed after this workflow started) ends the same way", async () => {
    const w = setup({ panel: { status: "refused", reason: "halted_since_approval" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "halted" });
    expect(stopEvent(w)).toMatchObject({ code: "halted" });
    expect(w.advanceSpec).not.toHaveBeenCalled();
  });

  it("the epoch the approval started under is on every start and step", async () => {
    const w = setup({ item: AT_SPEC });
    const args = { ...ARGS, haltEpoch: 4 };
    await workItemAdvanceWorkflow(args);
    expect((w.advanceBuild.mock.calls as unknown as unknown[][])[0]![0]).toMatchObject({ haltEpoch: 4 });
    const classify = setup();
    await workItemAdvanceWorkflow(args);
    expect(classify.advanceStartRun.mock.calls[0]![0]).toMatchObject({ haltEpoch: 4 });
    expect((classify.advancePanel.mock.calls as unknown as unknown[][])[0]![0]).toMatchObject({ haltEpoch: 4 });
  });

  it("a workflow that was already running when the marker shipped (no haltEpoch in its arguments) replays as epoch 0, not as undefined", async () => {
    const w = setup();
    const { haltEpoch: _gone, ...old } = ARGS;
    await workItemAdvanceWorkflow(old as AdvanceStartArgs);
    expect(w.advanceStartRun.mock.calls[0]![0]).toMatchObject({ haltEpoch: 0 });
    expect((w.advancePanel.mock.calls as unknown as unknown[][])[0]![0]).toMatchObject({ haltEpoch: 0 });
  });
});
