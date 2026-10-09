import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceItem, AdvanceStepResult, Worker } from "@fx/worker";
import type { IssueReadResult } from "@fx/github";

/**
 * D#6 C29 (R3c-2): the advance workflow's panel and Spec phase when a step hands control back (`waiting`, `queued_on_runner`).
 * The workflow sleeps and calls the same step again; the time counts toward the pending ceiling and never toward a work budget.
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
import { setInstallationHttpForTests } from "../lib/github/installationHttp";
import { workItemAdvanceWorkflow } from "./workItemAdvance";
import { RUNNER_PENDING_CEILING_MS, STEP_YIELD_MS, QUEUED_ON_RUNNER } from "@fx/pipeline";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const ROOT = "66666666-6666-4666-8666-666666666666";
const ARGS = { accountId: ACCOUNT, userId: "55555555-5555-4555-8555-555555555555", workItemId: ITEM, actionId: "44444444-4444-4444-8444-444444444444", haltEpoch: 0 };
const TRIAGED: AdvanceItem = { stage: "triaged", provenance: "internal", repoId: REPO, ghNumber: 7, ghOwner: "acme", ghName: "widgets", hasDiscussion: false, kind: null, hasSpec: false, specVersion: null, executorRunId: null, executionMode: "runner_local", recordedPr: null };
const issue: IssueReadResult = { status: "found", title: "T", body: "B", login: "owner-1", state: "open", labels: [] };

const WAITING: AdvanceStepResult = { status: "waiting", reason: "queued_on_runner" };
const COMPLETED: AdvanceStepResult = { status: "completed", complete: true, missingRoles: [], round2Ran: false };
const PUBLISHED: AdvanceStepResult = { status: "published", stage: "spec_ready", version: 1 };

function setup(panel: AdvanceStepResult[], spec: AdvanceStepResult[]) {
  const panelSeq = [...panel];
  const specSeq = [...spec];
  const worker = {
    advanceLoadItem: vi.fn(async () => TRIAGED),
    advanceStartRun: vi.fn(async () => ({ ok: true as const, runId: "run-1" })),
    advanceRunOutcome: vi.fn(async () => ({ status: "succeeded", done: true, envelope: { category: "feature" } })),
    advanceTriage: vi.fn(async () => ({ status: "triaged", stage: "discussing", workItemId: ROOT })),
    advancePanel: vi.fn(async (): Promise<AdvanceStepResult> => (panelSeq.length > 1 ? panelSeq.shift()! : panelSeq[0]!)),
    advanceSpec: vi.fn(async (): Promise<AdvanceStepResult> => (specSeq.length > 1 ? specSeq.shift()! : specSeq[0]!)),
    advanceCancel: vi.fn(async () => undefined),
    advanceRecordEvent: vi.fn(async () => ({ recorded: true })),
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
  setInstallationHttpForTests();
});

describe("the panel and Spec phase over steps that hand control back", () => {
  it("a panel that answers waiting four times and then completes is called five times; one sleep per hand-back, then the Spec", async () => {
    const w = setup([WAITING, WAITING, WAITING, WAITING, COMPLETED], [PUBLISHED]);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "spec_ready" });
    expect(w.advancePanel).toHaveBeenCalledTimes(5);
    expect(world.sleeps).toBe(4);
    expect(w.advanceSpec).toHaveBeenCalledTimes(1);
    // Every call is the same step for the same item: nothing about it changes between re-entries.
    for (const call of w.advancePanel.mock.calls as unknown[][]) expect(call).toEqual([{ accountId: ACCOUNT, userId: ARGS.userId, workItemId: ROOT, haltEpoch: 0 }]);
    // No failure or stop was recorded on the way; the wait is not a stage of its own.
    expect(logs.map((l) => l.event)).toEqual(["advance.classified", "advance.triaged", "advance.panelled", "advance.spec_ready"]);
    expect(w.advanceCancel).not.toHaveBeenCalled();
  });

  it("the Spec step is called again the same way, with the same attempt", async () => {
    const w = setup([COMPLETED], [WAITING, WAITING, PUBLISHED]);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "spec_ready" });
    expect(w.advanceSpec).toHaveBeenCalledTimes(3);
    expect(world.sleeps).toBe(2);
    for (const call of w.advanceSpec.mock.calls as unknown[][]) expect(call).toEqual([{ accountId: ACCOUNT, userId: ARGS.userId, workItemId: ROOT, haltEpoch: 0 }, ARGS.actionId]);
  });

  it("the waits share one ceiling, and it counts time spent, not sleeps alone: a step that never stops yielding ends the phase", async () => {
    const w = setup([WAITING], [PUBLISHED]);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "panel_wait_timeout" });
    // Each hand-back is the sleep (20 s) plus the step's own yield time.
    expect(world.sleeps).toBe(Math.ceil(RUNNER_PENDING_CEILING_MS / (20_000 + STEP_YIELD_MS)));
    expect(w.advanceSpec).not.toHaveBeenCalled();
    expect(w.advanceCancel).not.toHaveBeenCalled();
  });

  it("a Spec step that never stops yielding ends with the same kind of timeout", async () => {
    setup([COMPLETED], [WAITING]);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "spec_wait_timeout" });
    expect(world.sleeps).toBe(Math.ceil(RUNNER_PENDING_CEILING_MS / (20_000 + STEP_YIELD_MS)));
  });

  it("a waiting answer with any other reason is not a hand-back: it ends the phase as the pipeline's own status", async () => {
    const w = setup([{ status: "waiting", reason: "something_else" }], [PUBLISHED]);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "panel_waiting:something_else" });
    expect(w.advancePanel).toHaveBeenCalledTimes(1);
    expect(world.sleeps).toBe(0);
  });

  it("a step that completes at once sleeps never (a sandbox repository's path is the one it always was)", async () => {
    const w = setup([COMPLETED], [PUBLISHED]);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "spec_ready" });
    expect(world.sleeps).toBe(0);
    expect(w.advancePanel).toHaveBeenCalledTimes(1);
  });

  it("the workflow's copies of the pipeline's words and numbers are the pipeline's", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "workItemAdvance.ts"), "utf8");
    expect(source).toContain(`const QUEUED_ON_RUNNER = "${QUEUED_ON_RUNNER}";`);
    expect(STEP_YIELD_MS).toBe(180_000);
    expect(source).toContain("const STEP_YIELD_MS = 180_000;");
  });
});
