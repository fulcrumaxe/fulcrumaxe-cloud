import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceItem, AdvanceRunOutcome, AdvanceRunRequest, AdvanceStartArgs, AdvanceStepResult, Worker } from "@fx/worker";
import type { IssueReadResult } from "@fx/github";

/**
 * D#6 WAITCANCEL: every wait that runs out stops the run it was waiting on, and the END of that run's follow-up chain (a run lost on a runner is followed by a
 * child, and the child is the run still live). A queued run nobody has claimed is stopped too, so a runner that claims it later is refused. The fake worker answers
 * the way the real one does: `advanceRunOutcome` names the chain's tail in `tailRunId`, and `advanceCancel` / `advanceCancelStepRuns` are the only stops.
 * `sleep` only runs inside a real workflow execution, so it is mocked (it counts the waits and returns at once).
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
const USER = "55555555-5555-4555-8555-555555555555";
const ARGS: AdvanceStartArgs = { accountId: ACCOUNT, userId: USER, workItemId: ITEM, actionId: "44444444-4444-4444-8444-444444444444", haltEpoch: 0 };
const ITEM_OK: AdvanceItem = { stage: "triaged", provenance: "internal", repoId: REPO, ghNumber: 7, ghOwner: "acme", ghName: "widgets", hasDiscussion: false, kind: null, hasSpec: false, specVersion: null, executorRunId: null, executionMode: "runner_local", recordedPr: null };
const issue: IssueReadResult = { status: "found", title: "T", body: "B", login: "owner-1", state: "open", labels: [] };
const WHO = { accountId: ACCOUNT, userId: USER, workItemId: ITEM, haltEpoch: 0 };
const WHO_ROOT = { ...WHO, workItemId: ROOT };
const HEAD = "run-head";
const CHILD = "run-child";

// A chain whose head was lost and whose follow-up child is still going (or still queued, unclaimed).
const chain = (status: "running" | "pending"): AdvanceRunOutcome => ({ status, done: false, envelope: null, runtime: "runner", tailRunId: CHILD });
// The same run one poll earlier: nothing lost yet.
const headOnly: AdvanceRunOutcome = { status: "running", done: false, envelope: null, runtime: "runner", tailRunId: HEAD };

interface Options {
  item?: AdvanceItem;
  /** What `advanceRunOutcome` answers for any run; the last repeats. */
  outcomes: AdvanceRunOutcome[];
  panel?: AdvanceStepResult;
  spec?: AdvanceStepResult;
  triage?: Record<string, unknown>;
}

function setup(o: Options) {
  const outcomes = [...o.outcomes];
  const worker = {
    advanceLoadItem: vi.fn(async () => o.item ?? ITEM_OK),
    advanceStartRun: vi.fn(async (_req: AdvanceRunRequest) => ({ ok: true as const, runId: HEAD })),
    advanceRunOutcome: vi.fn(async () => (outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!)),
    advanceTriage: vi.fn(async () => o.triage ?? { status: "triaged", stage: "discussing", workItemId: ROOT, category: "feature" }),
    advancePanel: vi.fn(async (): Promise<AdvanceStepResult> => o.panel ?? { status: "completed", complete: true, missingRoles: [], round2Ran: false }),
    advanceSpec: vi.fn(async (): Promise<AdvanceStepResult> => o.spec ?? { status: "published", stage: "spec_ready", version: 1 }),
    advanceCancel: vi.fn(async (..._args: unknown[]) => undefined),
    advanceCancelStepRuns: vi.fn(async (..._args: unknown[]) => undefined),
    advanceRecordEvent: vi.fn(async () => ({ recorded: true })),
    advanceStartGate: vi.fn(async (..._args: unknown[]) => ({ proceed: true as const, how: "person_receipt" })),
    advanceLoadSpecText: vi.fn(async () => ({ version: 4, body: "SPEC BODY" })),
  };
  setWorkerWiringForTests({ provider: () => ({}) as never, createWorker: async () => worker as unknown as Worker });
  setIssueReaderForTests(async () => issue);
  return worker;
}

beforeEach(() => {
  world.sleeps = 0;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setWorkerWiringForTests();
  setIssueReaderForTests();
});

// The classify answer first, so the item gets through to the stage under test.
const CLASSIFIED = (category: string): AdvanceRunOutcome => ({ status: "succeeded", done: true, envelope: { category }, tailRunId: HEAD });

describe("classify", () => {
  it("a wait that runs out cancels the end of the chain, not the head that was lost", async () => {
    const w = setup({ outcomes: [headOnly, chain("running")] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_wait_timeout" });
    expect(w.advanceCancel).toHaveBeenCalledTimes(1);
    expect(w.advanceCancel).toHaveBeenCalledWith(WHO, CHILD);
  });

  it("an outcome recorded before tailRunId existed (a workflow replayed across a deploy) falls back to the run it started", async () => {
    const legacy: AdvanceRunOutcome = { status: "running", done: false, envelope: null, runtime: "runner" };
    const w = setup({ outcomes: [legacy] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_wait_timeout" });
    expect(w.advanceCancel).toHaveBeenCalledTimes(1);
    expect(w.advanceCancel).toHaveBeenCalledWith(WHO, HEAD);
  });

  it("a follow-up that is queued and unclaimed when the ceiling is reached is cancelled too (a runner that claims it later is refused)", async () => {
    const w = setup({ outcomes: [chain("pending")] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_wait_timeout" });
    expect(w.advanceCancel).toHaveBeenCalledWith(WHO, CHILD);
    expect(w.advanceTriage).not.toHaveBeenCalled();
  });

  it("lost run, then follow-up, then the wait runs out: one cancel, of the follow-up", async () => {
    // The head is read running a few times, is lost, and its follow-up never finishes.
    const w = setup({ outcomes: [headOnly, headOnly, chain("pending"), chain("running")] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_wait_timeout" });
    expect(w.advanceCancel.mock.calls.map((c) => c[1])).toEqual([CHILD]);
  });
});

describe("the short Spec and the re-spec", () => {
  const lightItem: AdvanceItem = { ...ITEM_OK, stage: "triaged", hasDiscussion: true, kind: "small" };

  it("the short Spec: a wait that runs out cancels the end of the chain", async () => {
    const w = setup({ item: lightItem, outcomes: [chain("running")], triage: { status: "triaged", stage: "triaged", workItemId: ROOT, category: "small" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "light_spec_failed", detail: "wait_timeout" });
    expect(w.advanceCancel).toHaveBeenCalledWith(WHO, CHILD);
  });

  it("the short Spec: a queued, unclaimed follow-up at the ceiling is cancelled", async () => {
    const w = setup({ item: lightItem, outcomes: [chain("pending")], triage: { status: "triaged", stage: "triaged", workItemId: ROOT, category: "small" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "light_spec_failed", detail: "wait_timeout" });
    expect(w.advanceCancel).toHaveBeenCalledWith(WHO, CHILD);
  });

  it("the re-spec: a wait that runs out cancels the end of the chain", async () => {
    const w = setup({ outcomes: [chain("running")] });
    expect(await workItemAdvanceWorkflow({ ...ARGS, respec: true, specVersion: 4 })).toEqual({ status: "respec_failed", detail: "wait_timeout" });
    expect(w.advanceCancel).toHaveBeenCalledWith(WHO, CHILD);
  });

  it("the re-spec: a queued, unclaimed run at the ceiling is cancelled", async () => {
    const w = setup({ outcomes: [{ status: "pending", done: false, envelope: null, runtime: "runner", tailRunId: HEAD }] });
    expect(await workItemAdvanceWorkflow({ ...ARGS, respec: true, specVersion: 4 })).toEqual({ status: "respec_failed", detail: "wait_timeout" });
    expect(w.advanceCancel).toHaveBeenCalledWith(WHO, HEAD);
  });
});

describe("the panel and the Spec", () => {
  const WAITING: AdvanceStepResult = { status: "waiting", reason: "queued_on_runner" };
  const COMPLETED: AdvanceStepResult = { status: "completed", complete: true, missingRoles: [], round2Ran: false };

  it("a panel still queued at the ceiling stops the panel's runs of the item", async () => {
    const w = setup({ outcomes: [CLASSIFIED("feature")], panel: WAITING });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "panel_wait_timeout" });
    expect(w.advanceCancelStepRuns).toHaveBeenCalledTimes(1);
    expect(w.advanceCancelStepRuns).toHaveBeenCalledWith(WHO_ROOT, "panel", ARGS.actionId);
  });

  it("a panel that completes cancels nothing", async () => {
    const w = setup({ outcomes: [CLASSIFIED("feature")], panel: COMPLETED });
    await workItemAdvanceWorkflow(ARGS);
    expect(w.advanceCancelStepRuns).not.toHaveBeenCalled();
  });

  it("a Spec still queued at the ceiling stops the Spec's run and the panel seats it re-entered", async () => {
    const w = setup({ outcomes: [CLASSIFIED("feature")], spec: WAITING });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "spec_wait_timeout" });
    expect(w.advanceCancelStepRuns.mock.calls.map((c) => c[1]).sort()).toEqual(["panel", "spec"]);
    for (const call of w.advanceCancelStepRuns.mock.calls) {
      expect(call[0]).toEqual(WHO_ROOT);
      // The timed-out workflow's own approval, so another approval's run of the same item is not named.
      expect(call[2]).toBe(ARGS.actionId);
    }
  });
});
