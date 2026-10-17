import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceItem, AdvanceStartArgs, AdvanceStepResult, Worker } from "@fx/worker";
import type { IssueReadResult } from "@fx/github";
import { PANEL_WHOLE_CODE } from "@fx/pipeline";

/**
 * D#483 S5-k1e: the panel under a spending limit, through the workflow body over a fake worker. The panel step answers a seat's (or a whole round's) spend denial as
 * a refusal that names the pause; the workflow waits, asks again every five minutes for four hours, and then ends `panel_paused:<pause>`. `sleep` only runs inside a
 * real workflow execution, so it is mocked (it counts the waits and returns at once), as in workItemAdvanceStarts.test.ts.
 */
const clock = vi.hoisted(() => ({ sleeps: 0 }));
vi.mock("workflow", () => ({
  sleep: vi.fn(async () => {
    clock.sleeps += 1;
  }),
}));
vi.mock("workflow/api", () => ({ resumeHook: vi.fn(), start: vi.fn() }));

import { setWorkerWiringForTests } from "../lib/worker";
import { setIssueReaderForTests } from "../lib/github/issueRead";
import { workItemAdvanceWorkflow } from "./workItemAdvance";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const ARGS: AdvanceStartArgs = { accountId: ACCOUNT, userId: "55555555-5555-4555-8555-555555555555", workItemId: ITEM, actionId: "44444444-4444-4444-8444-444444444444", haltEpoch: 0 };
const specItem: AdvanceItem = { stage: "discussing", provenance: "internal", repoId: REPO, ghNumber: 7, ghOwner: "acme", ghName: "widgets", hasDiscussion: true, kind: "feature", hasSpec: false, specVersion: null, executorRunId: null, executionMode: "sandbox", recordedPr: null };
const issue = (): IssueReadResult => ({ status: "found", title: "T", body: "B", login: "owner-1", state: "open", labels: [] });

const PAUSES = ["account_budget_reached", "compute_cap_reached", "item_cap_reached", "run_limit_below_estimate", "envelope_reached"];
const FOUR_HOURS_OF_ASKS = 49; // the first ask, then one every five minutes for four hours
const COMPLETED: AdvanceStepResult = { status: "completed", complete: true, missingRoles: [], round2Ran: false };
const PUBLISHED: AdvanceStepResult = { status: "published", stage: "spec_ready", version: 1 };

function build(panel: (call: number) => AdvanceStepResult) {
  let calls = 0;
  const worker = {
    advanceLoadItem: vi.fn(async () => specItem),
    advancePanel: vi.fn(async (..._args: unknown[]): Promise<AdvanceStepResult> => panel(calls++)),
    advanceSpec: vi.fn(async (..._args: unknown[]): Promise<AdvanceStepResult> => PUBLISHED),
    advanceRecordEvent: vi.fn(async (..._args: unknown[]) => ({ recorded: true })),
    advanceStartRun: vi.fn(),
    advanceCancel: vi.fn(async () => undefined),
  };
  setWorkerWiringForTests({ provider: () => ({}) as never, createWorker: async () => worker as unknown as Worker });
  setIssueReaderForTests(async () => issue());
  return worker;
}
type W = ReturnType<typeof build>;

let logs: Array<Record<string, unknown>>;
beforeEach(() => {
  clock.sleeps = 0;
  logs = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => void logs.push(JSON.parse(String(line))));
});
afterEach(() => {
  vi.restoreAllMocks();
  setWorkerWiringForTests();
  setIssueReaderForTests();
});
const events = () => logs.map((l) => l.event);
const recorded = (w: W) => w.advanceRecordEvent.mock.calls.map((c) => c[1] as Record<string, unknown>);
const factsOf = (w: W) => recorded(w).filter((e) => e.kind === "stage_waiting");

describe("S5k1e-4: after the four hours with the limit still denied, the panel ends panel_paused:<pause>: no failure, nothing stamped", () => {
  it.each(PAUSES)("%s", async (pause) => {
    const w = build(() => ({ status: "refused", reason: pause }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "paused", detail: `panel_paused:${pause}` });
    expect(w.advancePanel).toHaveBeenCalledTimes(FOUR_HOURS_OF_ASKS);
    expect(clock.sleeps).toBe(48);
    // One waiting fact per ask, for the panel, with the pause and the attempt; the Spec step is never reached.
    expect(factsOf(w)).toHaveLength(FOUR_HOURS_OF_ASKS);
    expect(factsOf(w)[0]).toMatchObject({ kind: "stage_waiting", stage: "panel", code: pause, attempt: 0 });
    expect(factsOf(w).at(-1)).toMatchObject({ stage: "panel", code: pause, attempt: 48 });
    expect(new Set(factsOf(w).map((e) => e.dedupeKey)).size).toBe(FOUR_HOURS_OF_ASKS);
    expect(w.advanceSpec).not.toHaveBeenCalled();
    expect(events()).toContain("advance.paused");
    expect(events()).not.toContain("advance.failed");
    // Not a failure and nothing stamped: no stop fact, no halt.
    expect(recorded(w).map((e) => e.kind)).not.toContain("stopped");
    expect(logs.find((l) => l.event === "advance.paused")).toMatchObject({ at: "panel_start", reason: pause });
  });
});

describe("S5k1e-2: a pause that clears inside the wait", () => {
  it("the next ask completes the panel and the workflow goes on to the Spec, with no person action and no failure", async () => {
    const w = build((call) => (call < 3 ? { status: "refused", reason: "account_budget_reached" } : COMPLETED));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "spec_ready" });
    expect(w.advancePanel).toHaveBeenCalledTimes(4);
    expect(clock.sleeps).toBe(3);
    expect(factsOf(w)).toHaveLength(3);
    expect(w.advanceSpec).toHaveBeenCalledTimes(1);
    expect(events()).not.toContain("advance.failed");
    expect(events()).toContain("advance.panelled");
  });

  it("a seat that did not post for a real reason is still the Spec's DID NOT POST, not a pause: the workflow goes on", async () => {
    const w = build(() => ({ status: "completed", complete: false, missingRoles: ["performance-expert"], round2Ran: false }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "spec_ready" });
    expect(w.advancePanel).toHaveBeenCalledTimes(1);
    expect(factsOf(w)).toEqual([]);
    expect(clock.sleeps).toBe(0);
    expect(logs.find((l) => l.event === "advance.panelled")).toMatchObject({ complete: false, missing: 1 });
  });
});

describe("S5k1e: a refusal that is not a limit ends as it always did", () => {
  it("not_discussing (and every other refusal) is a failed run with its own detail, no wait and no pause", async () => {
    const w = build(() => ({ status: "refused", reason: "not_discussing" }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "panel_refused:not_discussing" });
    expect(w.advancePanel).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toBe(0);
    expect(factsOf(w)).toEqual([]);
    expect(recorded(w).map((e) => e.kind)).not.toContain("stopped");
    expect(w.advanceSpec).not.toHaveBeenCalled();
  });

  it("a restart by the sweep that meets such a refusal leaves a stop after the wait, so the sweep does not start it again every pass", async () => {
    const w = build(() => ({ status: "refused", reason: "no_panel" }));
    expect(await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 5 })).toEqual({ status: "failed", detail: "panel_refused:no_panel" });
    expect(recorded(w)).toContainEqual(expect.objectContaining({ kind: "stopped", code: "panel_refused" }));
  });

  it("a halt ends the wait and is not a pause", async () => {
    const w = build((call) => (call === 0 ? { status: "refused", reason: "account_budget_reached" } : { status: "refused", reason: "item_halted" }));
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out.status).not.toBe("paused");
    expect(w.advancePanel).toHaveBeenCalledTimes(2);
    expect(w.advanceSpec).not.toHaveBeenCalled();
  });
});

describe("S5k1e-4: a restart by the sweep", () => {
  it("begins its asks at the attempt the sweep gave, so its waiting facts are new rows and not ones the earlier workflow wrote", async () => {
    const w = build(() => ({ status: "refused", reason: "compute_cap_reached" }));
    expect(await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 60 })).toEqual({ status: "paused", detail: "panel_paused:compute_cap_reached" });
    expect(factsOf(w)[0]).toMatchObject({ stage: "panel", attempt: 60 });
    expect(factsOf(w).at(-1)).toMatchObject({ attempt: 108 });
  });

  it("the panel step carries no attempt number: which seats to ask again is read from their own runs, so a replay of the step is safe", async () => {
    const w = build(() => COMPLETED);
    await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 7 });
    expect(w.advancePanel.mock.calls[0]).toEqual([expect.objectContaining({ workItemId: ITEM, haltEpoch: 0 })]);
  });
});

describe("S5k1e: the Spec step still waits as the Spec", () => {
  it("a pause on the Spec step's own re-entry of the panel is the Spec stage's wait, ending spec_paused", async () => {
    const w = build(() => COMPLETED);
    w.advanceSpec.mockImplementation(async () => ({ status: "refused", reason: "item_cap_reached" }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "paused", detail: "spec_paused:item_cap_reached" });
    expect(factsOf(w)[0]).toMatchObject({ stage: "spec", code: "item_cap_reached" });
  });
});

describe("S5k1e: a panel that had waited on a limit and is whole again leaves a fact after its last wait", () => {
  const whole = (w: W) => recorded(w).filter((e) => e.kind === "stopped" && e.code === PANEL_WHOLE_CODE);

  it("a restart by the sweep whose panel completes writes the fact even though the Spec then ends needs_owner_action (the card's wait is over, the sweep must not restart the panel)", async () => {
    const w = build(() => COMPLETED);
    w.advanceSpec.mockImplementation(async () => ({ status: "needs_owner_action", reason: "spec_too_large" }));
    await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 3 });
    expect(whole(w)).toEqual([expect.objectContaining({ dedupeKey: `panel_whole:${ARGS.actionId}:3` })]);
    // Written before the Spec step is asked, so it follows every wait the panel wrote.
    expect(w.advancePanel.mock.invocationCallOrder[0]).toBeLessThan(w.advanceRecordEvent.mock.invocationCallOrder[recorded(w).findIndex((e) => e.code === PANEL_WHOLE_CODE)]!);
  });

  it("a run that waited itself and then got through writes it at the attempt that got through; a run that never waited writes none", async () => {
    const w = build((call) => (call < 2 ? { status: "refused", reason: "account_budget_reached" } : COMPLETED));
    await workItemAdvanceWorkflow(ARGS);
    expect(whole(w)).toEqual([expect.objectContaining({ dedupeKey: `panel_whole:${ARGS.actionId}:2` })]);
    const w2 = build(() => COMPLETED);
    await workItemAdvanceWorkflow(ARGS);
    expect(whole(w2)).toEqual([]);
  });

  it("a restart that is paused again writes none (the sweep keeps the claim)", async () => {
    const w = build(() => ({ status: "refused", reason: "item_cap_reached" }));
    await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 3 });
    expect(whole(w)).toEqual([]);
  });
});
