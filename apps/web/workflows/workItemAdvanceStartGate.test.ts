import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceItem, AdvanceRunOutcome, AdvanceRunRequest, AdvanceStartArgs, AdvanceStepResult, StartGateStepInput, StartGateStepOut, Worker } from "@fx/worker";
import type { IssueReadResult } from "@fx/github";

/**
 * D#7 start gate (b): where the stage driver asks `advanceStartGate`, what it passes, and what a stop does, through the workflow body over a fake worker.
 * The decision itself (receipts, asks, the dial, the click) is tested against a real database in packages/core/test/start-decide.pg.test.ts; this file pins the
 * wiring: the call sites, the inputs, that a stop starts nothing, that the parked-stage sweep's restart is no click, and that the answered ask's advance
 * re-enters past the gate.
 */
vi.mock("workflow", () => ({ sleep: vi.fn(async () => undefined) }));
vi.mock("workflow/api", () => ({ resumeHook: vi.fn(), start: vi.fn() }));

import { setWorkerWiringForTests } from "../lib/worker";
import { setIssueReaderForTests } from "../lib/github/issueRead";
import { workItemAdvanceWorkflow } from "./workItemAdvance";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const ROOT = "66666666-6666-4666-8666-666666666666";
const ARGS: AdvanceStartArgs = { accountId: ACCOUNT, userId: "55555555-5555-4555-8555-555555555555", workItemId: ITEM, actionId: "44444444-4444-4444-8444-444444444444", haltEpoch: 0, personFiled: true };
/** A restart nobody clicked: the parked-stage sweep or the slot wake (no `personFiled`), at a later attempt. */
const { personFiled: _p, ...NOT_FILED } = ARGS;
const RESTART: AdvanceStartArgs = { ...NOT_FILED, startAttempt: 1 };
const ITEM_OK: AdvanceItem = { stage: "triaged", provenance: "internal", repoId: REPO, ghNumber: 7, branch: "fx/issue-7", ghOwner: "acme", ghName: "widgets", hasDiscussion: false, kind: null, hasSpec: false, specVersion: null, executorRunId: null, executionMode: "sandbox", recordedPr: null };
const lightItem: AdvanceItem = { ...ITEM_OK, hasDiscussion: true, kind: "small" };
const specItem: AdvanceItem = { ...ITEM_OK, stage: "discussing", hasDiscussion: true, kind: "feature" };
const buildItem: AdvanceItem = { ...ITEM_OK, stage: "spec_ready", hasDiscussion: true, kind: "feature", hasSpec: true, specVersion: 4 };
const GO: StartGateStepOut = { proceed: true, how: "person_receipt" };

type Labels = Extract<IssueReadResult, { status: "found" }>["labels"];
const issue = (labels: Labels = []): IssueReadResult => ({ status: "found", title: "T", body: "B", login: "owner-1", state: "open", labels });

interface Options {
  item?: AdvanceItem;
  category?: string;
  triage?: Record<string, unknown>;
  gate?: (input: StartGateStepInput) => StartGateStepOut;
  labels?: Labels;
}

function build(o: Options = {}) {
  const outcome: AdvanceRunOutcome = { status: "succeeded", done: true, envelope: { category: o.category ?? "small" } };
  const worker = {
    advanceLoadItem: vi.fn(async () => o.item ?? ITEM_OK),
    advanceStartRun: vi.fn(async (_req: AdvanceRunRequest) => ({ ok: true as const, runId: "run-1" })),
    advanceRunOutcome: vi.fn(async () => outcome),
    advanceTriage: vi.fn(async () => o.triage ?? { status: "triaged", stage: "triaged", workItemId: ROOT, category: o.category ?? "small" }),
    advancePanel: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "completed", complete: true, missingRoles: [], round2Ran: false })),
    advanceSpec: vi.fn(async (..._args: unknown[]): Promise<AdvanceStepResult> => ({ status: "published", stage: "spec_ready", version: 1 })),
    advanceBuild: vi.fn(async (..._args: unknown[]): Promise<AdvanceStepResult> => ({ status: "refused", reason: "no_model" })),
    advanceBuildFailed: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "recorded", stage: "needs_human" })),
    advanceRecordEvent: vi.fn(async (..._args: unknown[]) => ({ recorded: true })),
    advanceStartGate: vi.fn(async (_who: unknown, input: StartGateStepInput): Promise<StartGateStepOut> => (o.gate ? o.gate(input) : GO)),
    advanceLoadSpecText: vi.fn(async () => ({ version: 4, body: "SPEC BODY" })),
    advanceCancel: vi.fn(async () => undefined),
    advanceLightSpec: vi.fn(async () => ({ status: "published", reason: null, version: 1 })),
  };
  setWorkerWiringForTests({ provider: () => ({}) as never, createWorker: async () => worker as unknown as Worker });
  setIssueReaderForTests(async () => issue(o.labels));
  return worker;
}
type W = ReturnType<typeof build>;

let logs: Array<Record<string, unknown>>;
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => void logs.push(JSON.parse(String(line))));
});
afterEach(() => {
  vi.restoreAllMocks();
  setWorkerWiringForTests();
  setIssueReaderForTests();
});
const gateInputs = (w: W) => w.advanceStartGate.mock.calls.map((c) => c[1]);
const WHO = (item: string) => ({ accountId: ACCOUNT, userId: ARGS.userId, workItemId: item, haltEpoch: 0 });

describe("the end of triage, for a small, bug or doc item", () => {
  it("asks the gate with the category triage produced, as the root item, and goes on to the short Spec when it says go", async () => {
    const w = build({ category: "small" });
    await workItemAdvanceWorkflow(ARGS);
    expect(gateInputs(w)).toEqual([{ mode: "triage_end", category: "small", cameInAs: null, origin: "person_click" }]);
    expect(w.advanceStartGate).toHaveBeenCalledWith(WHO(ROOT), expect.anything());
    // The classify run, then the short Spec's PM run: the gate sits between them.
    expect(w.advanceStartRun.mock.calls.map((c) => c[0].step)).toEqual([expect.stringMatching(/^classify:/), expect.stringMatching(/^light-spec:/)]);
    expect(w.advanceStartGate.mock.invocationCallOrder[0]!).toBeGreaterThan(w.advanceTriage.mock.invocationCallOrder[0]!);
    expect(w.advanceStartGate.mock.invocationCallOrder[0]!).toBeLessThan(w.advanceStartRun.mock.invocationCallOrder[1]!);
  });

  it.each(["bug", "doc"])("%s goes through the same gate", async (category) => {
    const w = build({ category });
    await workItemAdvanceWorkflow(ARGS);
    expect(gateInputs(w)).toEqual([{ mode: "triage_end", category, cameInAs: null, origin: "person_click" }]);
  });

  it("a question or a project never reaches the gate", async () => {
    const w = build({ category: "question", triage: { status: "triaged", stage: "triaged", workItemId: ROOT, category: "question" } });
    await workItemAdvanceWorkflow(ARGS);
    expect(w.advanceStartGate).not.toHaveBeenCalled();
  });

  it("a gate that opened an ask parks the workflow: waiting, and no short Spec is started", async () => {
    const w = build({ gate: () => ({ proceed: false, reason: "asked", blockedBy: null }) });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "waiting", detail: "start_ask_open" });
    expect(w.advanceStartRun).toHaveBeenCalledTimes(1); // the classify run only
    expect(w.advanceLightSpec).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({ event: "advance.start_gate_stopped", at: "triage_end", reason: "asked" }));
  });

  it("a hold stops the item quietly, and a refusal says why; neither starts anything", async () => {
    const held = build({ gate: () => ({ proceed: false, reason: "held", blockedBy: null }) });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "start_held" });
    expect(held.advanceStartRun).toHaveBeenCalledTimes(1);
    const blocked = build({ gate: () => ({ proceed: false, reason: "blocked", blockedBy: "untrusted_work_creation" }) });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "start_blocked:untrusted_work_creation" });
    expect(blocked.advanceStartRun).toHaveBeenCalledTimes(1);
  });

  it("the restart by the parked-stage sweep is no click: the gate is asked, as unattended", async () => {
    const w = build({ category: "small" });
    await workItemAdvanceWorkflow(RESTART);
    expect(gateInputs(w)).toEqual([{ mode: "triage_end", category: "small", cameInAs: null, origin: "unattended" }]);
  });

  it("a restart is unattended whatever its attempt number, and a person's own start is a click at attempt 0 only because it says so", async () => {
    const attemptZero = build({ category: "small" });
    await workItemAdvanceWorkflow(NOT_FILED);
    expect(gateInputs(attemptZero).map((i) => i.origin)).toEqual(["unattended"]);
    const filed = build({ category: "small" });
    await workItemAdvanceWorkflow(ARGS);
    expect(gateInputs(filed).map((i) => i.origin)).toEqual(["person_click"]);
  });

  it("a restart whose gate asks parks the item: no short Spec runs", async () => {
    const w = build({ category: "small", gate: () => ({ proceed: false, reason: "asked", blockedBy: null }) });
    expect(await workItemAdvanceWorkflow(RESTART)).toEqual({ status: "waiting", detail: "start_ask_open" });
    expect(w.advanceLightSpec).not.toHaveBeenCalled();
  });

  it("a restart of a declined pair stays held", async () => {
    const w = build({ category: "small", gate: () => ({ proceed: false, reason: "held", blockedBy: null }) });
    expect(await workItemAdvanceWorkflow(RESTART)).toEqual({ status: "stopped", detail: "start_held" });
    expect(w.advanceLightSpec).not.toHaveBeenCalled();
  });

  it("a restart of a started pair goes on", async () => {
    const w = build({ category: "small", gate: () => ({ proceed: true, how: "already_started" }) });
    await workItemAdvanceWorkflow(RESTART);
    expect(w.advanceStartRun.mock.calls.map((c) => c[0].step)).toEqual([expect.stringMatching(/^classify:/), expect.stringMatching(/^light-spec:/)]);
  });

});

describe("an item that came in small and that triage found larger", () => {
  const labels = [{ name: "small", actorLogin: "owner-1", actorPermission: null }];
  const larger = { status: "triaged", stage: "discussing", workItemId: ROOT, category: "feature" };

  it("is put to the gate with what it came in as, before the panel runs", async () => {
    const w = build({ category: "feature", triage: larger, labels });
    await workItemAdvanceWorkflow(ARGS);
    expect(gateInputs(w)).toEqual([{ mode: "triage_end", category: "feature", cameInAs: "small", origin: "person_click" }]);
    expect(w.advanceStartGate.mock.invocationCallOrder[0]!).toBeLessThan(w.advancePanel.mock.invocationCallOrder[0]!);
  });

  it("stops before the panel while the ask is open; an answered ask lets it through", async () => {
    const parked = build({ category: "feature", triage: larger, labels, gate: () => ({ proceed: false, reason: "asked", blockedBy: null }) });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "waiting", detail: "start_ask_open" });
    expect(parked.advancePanel).not.toHaveBeenCalled();
    const go = build({ category: "feature", triage: larger, labels });
    await workItemAdvanceWorkflow(ARGS);
    expect(go.advancePanel).toHaveBeenCalledTimes(1);
  });

  it("a restart parked at classify (an item that came in small, triaged as a feature) asks the gate as unattended and the panel does not run while the ask is open", async () => {
    // The gate stands for the real one: unattended, a reclassify pair is always asked (class 3), never started by a restart.
    const w = build({ category: "feature", triage: larger, labels, gate: (input) => (input.origin === "unattended" ? { proceed: false, reason: "asked", blockedBy: null } : GO) });
    expect(await workItemAdvanceWorkflow(RESTART)).toEqual({ status: "waiting", detail: "start_ask_open" });
    expect(gateInputs(w)).toEqual([{ mode: "triage_end", category: "feature", cameInAs: "small", origin: "unattended" }]);
    expect(w.advancePanel).not.toHaveBeenCalled();
  });

  it("a restart of a declined reclassify pair stays held: no panel", async () => {
    const w = build({ category: "feature", triage: larger, labels, gate: () => ({ proceed: false, reason: "held", blockedBy: null }) });
    expect(await workItemAdvanceWorkflow(RESTART)).toEqual({ status: "stopped", detail: "start_held" });
    expect(w.advancePanel).not.toHaveBeenCalled();
  });

  it("a restart of a started reclassify pair goes on to the panel", async () => {
    const w = build({ category: "feature", triage: larger, labels, gate: () => ({ proceed: true, how: "already_started" }) });
    await workItemAdvanceWorkflow(RESTART);
    expect(w.advancePanel).toHaveBeenCalledTimes(1);
  });

  it("a feature that did not come in small is not asked at triage (its start is the Spec's build click)", async () => {
    const w = build({ category: "feature", triage: larger });
    await workItemAdvanceWorkflow(ARGS);
    expect(w.advanceStartGate).not.toHaveBeenCalled();
    expect(w.advancePanel).toHaveBeenCalledTimes(1);
  });

  it("a label that asks for urgency is not a smaller job: no reclassification", async () => {
    const w = build({ category: "critical", triage: { ...larger, category: "critical" }, labels: [...labels, { name: "urgent", actorLogin: "owner-1", actorPermission: null }] });
    await workItemAdvanceWorkflow(ARGS);
    expect(w.advanceStartGate).not.toHaveBeenCalled();
  });
});

describe("the other entries: the short Spec, the spec step and the build", () => {
  it("the short Spec's entry is a click on a small item: the gate with its kind", async () => {
    const w = build({ item: lightItem });
    await workItemAdvanceWorkflow(ARGS);
    expect(gateInputs(w)).toEqual([{ mode: "light", category: "small", cameInAs: null, origin: "person_click" }]);
    expect(w.advanceStartGate).toHaveBeenCalledWith(WHO(ITEM), expect.anything());
    expect(w.advanceStartRun.mock.calls.map((c) => c[0].step)).toEqual([expect.stringMatching(/^light-spec:/)]);
  });

  it("the resumed advance after an answered small start re-enters at the short Spec and the gate finds the pair started (no second ask)", async () => {
    const w = build({ item: lightItem, gate: () => ({ proceed: true, how: "already_started" }) });
    await workItemAdvanceWorkflow(ARGS);
    expect(w.advanceStartGate).toHaveBeenCalledTimes(1);
    expect(w.advanceStartRun).toHaveBeenCalledTimes(1);
  });

  it("the spec step's entry settles a reclassify pair left open or held", async () => {
    const w = build({ item: specItem });
    await workItemAdvanceWorkflow(ARGS);
    expect(gateInputs(w)).toEqual([{ mode: "spec", category: null, cameInAs: null, origin: "person_click" }]);
    expect(w.advancePanel).toHaveBeenCalledTimes(1);
  });

  it("the build click ('Approve the Spec and build') asks the gate with no category (the item's own kind is read there) and builds when it goes", async () => {
    const w = build({ item: buildItem });
    await workItemAdvanceWorkflow({ ...ARGS, specVersion: 4 });
    expect(gateInputs(w)).toEqual([{ mode: "build", category: null, cameInAs: null, origin: "person_click" }]);
    expect(w.advanceBuild).toHaveBeenCalledTimes(1);
    expect(w.advanceStartGate.mock.invocationCallOrder[0]!).toBeLessThan(w.advanceBuild.mock.invocationCallOrder[0]!);
  });

  it("the slot wake's restart of a build (attempt 0, no person's start) is unattended, not a click", async () => {
    const w = build({ item: buildItem });
    await workItemAdvanceWorkflow({ ...NOT_FILED, specVersion: 4 });
    expect(gateInputs(w)).toEqual([{ mode: "build", category: null, cameInAs: null, origin: "unattended" }]);
  });

  it("a build restart whose pair is not started is parked by the gate: nothing is built", async () => {
    const w = build({ item: buildItem, gate: () => ({ proceed: false, reason: "asked", blockedBy: null }) });
    expect(await workItemAdvanceWorkflow({ ...RESTART, specVersion: 4 })).toEqual({ status: "waiting", detail: "start_ask_open" });
    expect(w.advanceBuild).not.toHaveBeenCalled();
  });

  it("the spec step's restart is unattended too", async () => {
    const w = build({ item: specItem });
    await workItemAdvanceWorkflow(RESTART);
    expect(gateInputs(w)).toEqual([{ mode: "spec", category: null, cameInAs: null, origin: "unattended" }]);
  });

  it("a build the gate refuses is never started", async () => {
    const w = build({ item: buildItem, gate: () => ({ proceed: false, reason: "blocked", blockedBy: "start_forbidden" }) });
    expect(await workItemAdvanceWorkflow({ ...ARGS, specVersion: 4 })).toEqual({ status: "stopped", detail: "start_blocked:start_forbidden" });
    expect(w.advanceBuild).not.toHaveBeenCalled();
  });

  it("Build again (a stalled item) is recovery, not a start: the gate is not asked", async () => {
    const w = build({ item: { ...buildItem, stage: "needs_human" } });
    await workItemAdvanceWorkflow({ ...ARGS, specVersion: 4 }).catch(() => undefined);
    expect(w.advanceStartGate).not.toHaveBeenCalled();
  });
});
