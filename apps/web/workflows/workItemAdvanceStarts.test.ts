import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceItem, AdvanceRunOutcome, AdvanceRunRequest, AdvanceStartArgs, AdvanceStepResult, Worker } from "@fx/worker";
import type { IssueReadResult } from "@fx/github";

/**
 * D#483 S5-k1c: the four starts before the build (classify, the Spec PM, the short Spec and the re-spec) under a spending limit, through the workflow body over
 * a fake worker. The worker's `advanceStartRun` answers the raw spend denial the real starter does; the web step turns it into the named pause. `sleep` only
 * runs inside a real workflow execution, so it is mocked (it counts the waits and returns at once), as in workItemAdvance.test.ts.
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
const ROOT = "66666666-6666-4666-8666-666666666666";
const ARGS: AdvanceStartArgs = { accountId: ACCOUNT, userId: "55555555-5555-4555-8555-555555555555", workItemId: ITEM, actionId: "44444444-4444-4444-8444-444444444444", haltEpoch: 0 };
const ITEM_OK: AdvanceItem = { stage: "triaged", provenance: "internal", repoId: REPO, ghNumber: 7, ghOwner: "acme", ghName: "widgets", hasDiscussion: false, kind: null, hasSpec: false, specVersion: null, executorRunId: null, executionMode: "sandbox", recordedPr: null };
const issue = (): IssueReadResult => ({ status: "found", title: "T", body: "B", login: "owner-1", state: "open", labels: [] });

const DENIED = { ok: false as const, reason: "model_budget_exceeded" };
const PAUSE = "account_budget_reached";
const A = ARGS.actionId;
const FOUR_HOURS_OF_ASKS = 49; // the first ask, then one every five minutes for four hours
const lightItem: AdvanceItem = { ...ITEM_OK, stage: "triaged", hasDiscussion: true, kind: "small", hasSpec: false };
const specItem: AdvanceItem = { ...ITEM_OK, stage: "discussing", hasDiscussion: true, kind: "feature", hasSpec: false };

interface Options {
  item?: AdvanceItem;
  outcomes?: AdvanceRunOutcome[];
  start?: { ok: true; runId: string } | { ok: false; reason: string };
  triage?: Record<string, unknown>;
  spec?: AdvanceStepResult;
}

function build(o: Options = {}) {
  const outcomes = [...(o.outcomes ?? [{ status: "succeeded", done: true, envelope: { category: "feature" } }])];
  const worker = {
    advanceLoadItem: vi.fn(async () => o.item ?? ITEM_OK),
    advanceStartRun: vi.fn(async (_req: AdvanceRunRequest) => o.start ?? { ok: true as const, runId: "run-1" }),
    advanceRunOutcome: vi.fn(async () => (outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!)),
    advanceTriage: vi.fn(async () => o.triage ?? { status: "triaged", stage: "triaged", workItemId: ROOT, category: "feature" }),
    advancePanel: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "completed", complete: true, missingRoles: [], round2Ran: false })),
    advanceSpec: vi.fn(async (..._args: unknown[]): Promise<AdvanceStepResult> => o.spec ?? { status: "published", stage: "spec_ready", version: 1 }),
    advanceBuild: vi.fn(async (..._args: unknown[]): Promise<AdvanceStepResult> => ({ status: "refused", reason: "no_model" })),
    advanceBuildFailed: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "recorded", stage: "needs_human" })),
    advanceRecordEvent: vi.fn(async (..._args: unknown[]) => ({ recorded: true })),
    advanceLoadSpecText: vi.fn(async () => ({ version: 4, body: "SPEC BODY" })),
    advanceCancel: vi.fn(async () => undefined),
    advanceLightSpec: vi.fn(async () => ({ status: "published", reason: null, version: 1 })),
    advanceRespec: vi.fn(async () => ({ status: "published", reason: null, version: 5 })),
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
const stepsOf = (w: W) => w.advanceStartRun.mock.calls.map((c) => c[0].step);
const recorded = (w: W) => w.advanceRecordEvent.mock.calls.map((c) => c[1] as Record<string, unknown>);
const factsOf = (w: W) => recorded(w).filter((e) => e.kind === "stage_waiting");
const expectedSteps = (base: string, count: number) => Array.from({ length: count }, (_, n) => (n === 0 ? base : `${base}:s${n}`));
const specAttempts = (w: W) => w.advanceSpec.mock.calls.map((c) => c[2]);

describe("S5k1c-3: after the four hours with the limit still denied, each site ends <stage>_paused:<pause>: no failure, nothing stamped", () => {
  it("classify", async () => {
    const w = build({ start: DENIED });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "paused", detail: `classify_paused:${PAUSE}` });
    expect(stepsOf(w)).toEqual(expectedSteps(`classify:${A}`, FOUR_HOURS_OF_ASKS));
    expect(clock.sleeps).toBe(48);
    expect(factsOf(w)).toHaveLength(FOUR_HOURS_OF_ASKS);
    expect(factsOf(w)[0]).toMatchObject({ kind: "stage_waiting", stage: "classify", code: PAUSE, attempt: 0 });
    expect(factsOf(w).at(-1)).toMatchObject({ stage: "classify", code: PAUSE, attempt: 48 });
    expect(w.advanceRunOutcome).not.toHaveBeenCalled();
    expect(w.advanceTriage).not.toHaveBeenCalled();
    expect(events()).toContain("advance.paused");
    expect(events()).not.toContain("advance.failed");
    expect(recorded(w).map((e) => e.kind)).not.toContain("stopped");
  });

  it("the short Spec (small, bug, doc) waits as the Spec", async () => {
    const w = build({ start: DENIED, item: lightItem });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "paused", detail: `spec_paused:${PAUSE}` });
    expect(stepsOf(w)).toEqual(expectedSteps(`light-spec:${A}`, FOUR_HOURS_OF_ASKS));
    expect(factsOf(w)).toHaveLength(FOUR_HOURS_OF_ASKS);
    expect(factsOf(w)[0]).toMatchObject({ stage: "spec", code: PAUSE, attempt: 0 });
    expect(w.advanceLightSpec).not.toHaveBeenCalled();
    expect(w.advanceBuild).not.toHaveBeenCalled();
    expect(events()).not.toContain("advance.failed");
  });

  it("the Spec PM: the Spec step answers the pause and is asked again with the attempt number; the first ask carries none", async () => {
    const w = build({ item: specItem, spec: { status: "refused", reason: PAUSE } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "paused", detail: `spec_paused:${PAUSE}` });
    expect(w.advanceSpec).toHaveBeenCalledTimes(FOUR_HOURS_OF_ASKS);
    expect(specAttempts(w)).toEqual([undefined, ...Array.from({ length: 48 }, (_, n) => n + 1)]);
    expect(w.advanceSpec.mock.calls[0]).toEqual([expect.objectContaining({ workItemId: ITEM }), A]);
    expect(factsOf(w)).toHaveLength(FOUR_HOURS_OF_ASKS);
    expect(factsOf(w)[0]).toMatchObject({ stage: "spec", code: PAUSE });
    expect(events()).not.toContain("advance.failed");
  });

  it("the re-spec", async () => {
    const w = build({ start: DENIED });
    expect(await workItemAdvanceWorkflow({ ...ARGS, respec: true, specVersion: 4 })).toEqual({ status: "paused", detail: `respec_paused:${PAUSE}` });
    expect(stepsOf(w)).toEqual(expectedSteps(`respec:${A}`, FOUR_HOURS_OF_ASKS));
    expect(factsOf(w)[0]).toMatchObject({ stage: "respec", code: PAUSE, attempt: 0 });
    expect(w.advanceCancel).not.toHaveBeenCalled();
    expect(events()).not.toContain("advance.failed");
  });

  it.each(["model_budget_exceeded", "compute_cap_exceeded", "work_item_cap_exceeded", "per_spawn_cap_exceeded", "envelope_exceeded"])("every denial the spend check can give (%s) parks the same way", async (denial) => {
    const w = build({ start: { ok: false, reason: denial } });
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out.status).toBe("paused");
    expect(out.detail).toMatch(/^classify_paused:(account_budget_reached|compute_cap_reached|item_cap_reached|run_limit_below_estimate|envelope_reached)$/);
    expect(factsOf(w)).toHaveLength(FOUR_HOURS_OF_ASKS);
  });
});

describe("S5k1c-2: clearing the denial lets the next ask start the run at a fresh key", () => {
  const denyTwice = (w: W) => {
    let calls = 0;
    w.advanceStartRun.mockImplementation(async () => (++calls <= 2 ? DENIED : { ok: true as const, runId: "run-1" }));
  };

  it("classify: asks again every five minutes, and the third ask (:s2) starts the run and goes on to triage", async () => {
    const w = build();
    denyTwice(w);
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("triaged");
    expect(stepsOf(w)).toEqual([`classify:${A}`, `classify:${A}:s1`, `classify:${A}:s2`]);
    expect(clock.sleeps).toBe(2);
    expect(factsOf(w).map((f) => f.attempt)).toEqual([0, 1]);
  });

  it("the short Spec: the third ask starts the run, and the Spec is published", async () => {
    const w = build({ item: lightItem, outcomes: [{ status: "succeeded", done: true, envelope: {} }] });
    denyTwice(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(stepsOf(w)).toEqual([`light-spec:${A}`, `light-spec:${A}:s1`, `light-spec:${A}:s2`]);
    expect(w.advanceLightSpec).toHaveBeenCalledTimes(1);
  });

  it("the Spec PM: the third ask publishes", async () => {
    const w = build({ item: specItem });
    let calls = 0;
    w.advanceSpec.mockImplementation(async () => (++calls <= 2 ? { status: "refused", reason: PAUSE } : { status: "published", stage: "spec_ready", version: 1 }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "spec_ready" });
    expect(specAttempts(w)).toEqual([undefined, 1, 2]);
  });

  it("the re-spec: the third ask starts the run and the next Spec version is published", async () => {
    const w = build({ outcomes: [{ status: "succeeded", done: true, envelope: {} }] });
    denyTwice(w);
    expect(await workItemAdvanceWorkflow({ ...ARGS, respec: true, specVersion: 4 })).toEqual({ status: "respec_published" });
    expect(stepsOf(w)).toEqual([`respec:${A}`, `respec:${A}:s1`, `respec:${A}:s2`]);
  });
});

describe("a restart by the parked-stage sweep begins at the attempt it was given", () => {
  it("classify: the first ask is :s5, and after classify the later start (the short Spec) uses its own bare key", async () => {
    const w = build({ triage: { status: "triaged", stage: "triaged", workItemId: ROOT, category: "small" } });
    await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 5 });
    expect(stepsOf(w)[0]).toBe(`classify:${A}:s5`);
    expect(stepsOf(w)[1]).toBe(`light-spec:${A}`);
  });

  it("the short Spec, the Spec PM and the re-spec begin at it too, and the build after the short Spec begins at its own first attempt", async () => {
    const light = build({ item: lightItem });
    await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 3 });
    expect(stepsOf(light)[0]).toBe(`light-spec:${A}:s3`);
    // The build's first ask carries no spend attempt (its own first key), not the short Spec's restart attempt.
    expect(light.advanceBuild.mock.calls[0]).toHaveLength(3); // who, approval, pinned version: no fourth argument (the spend attempt)
    const spec = build({ item: specItem });
    await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 3 });
    expect(spec.advanceSpec.mock.calls[0]).toEqual([expect.anything(), A, 3]);
    const respec = build();
    await workItemAdvanceWorkflow({ ...ARGS, respec: true, specVersion: 4, startAttempt: 2 });
    expect(stepsOf(respec)[0]).toBe(`respec:${A}:s2`);
  });
});

describe("S5k1c-6: a refusal that is not a pause ends as it does today, with its own result and no parking", () => {
  it("classify, the short Spec and the re-spec: the *_refused result, no wait, no waiting fact, no extra fact", async () => {
    const c = build({ start: { ok: false, reason: "account_not_active" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_refused:account_not_active" });
    expect(clock.sleeps).toBe(0);
    expect(c.advanceRecordEvent).not.toHaveBeenCalled();

    const l = build({ start: { ok: false, reason: "account_not_active" }, item: lightItem });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "light_spec_refused:account_not_active" });
    expect(l.advanceRecordEvent).not.toHaveBeenCalled();

    const r = build({ start: { ok: false, reason: "account_not_active" } });
    expect(await workItemAdvanceWorkflow({ ...ARGS, respec: true, specVersion: 4 })).toEqual({ status: "failed", detail: "respec_refused:account_not_active" });
    expect(r.advanceRecordEvent).not.toHaveBeenCalled();
    expect(clock.sleeps).toBe(0);
  });

  it("the Spec PM: any other refusal of the Spec step is its own failed result", async () => {
    const w = build({ item: specItem, spec: { status: "refused", reason: "pm_failed" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "spec_pm_failed" });
    expect(w.advanceSpec).toHaveBeenCalledTimes(1);
    expect(w.advanceRecordEvent).not.toHaveBeenCalled();
  });

  it("a restart by the sweep that meets such a refusal leaves one stop after the wait, so the sweep does not start it again every pass; a halt does not", async () => {
    const w = build({ start: { ok: false, reason: "no_model" } });
    expect(await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 2 })).toEqual({ status: "failed", detail: "classify_refused:no_model" });
    expect(recorded(w)).toEqual([{ kind: "stopped", dedupeKey: `refused:classify:${A}:2`, code: "classify_refused" }]);
    const halted = build({ start: { ok: false, reason: "item_halted" } });
    await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 2 });
    expect(recorded(halted).map((e) => e.code)).not.toContain("classify_refused");
  });

  it("a halt during the wait ends the wait at once", async () => {
    const w = build();
    let calls = 0;
    w.advanceStartRun.mockImplementation(async () => (++calls <= 1 ? DENIED : { ok: false as const, reason: "item_halted" }));
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out.status).not.toBe("paused");
    expect(stepsOf(w)).toEqual([`classify:${A}`, `classify:${A}:s1`]);
  });
});

describe("the wiring the workflow bundle cannot import", () => {
  it("the stage names the workflow waits as are the stages the driver-event store lists", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "workItemAdvance.ts"), "utf8");
    const m = /type EarlyWaitStage = ([^;]+);/.exec(src);
    expect(m).not.toBeNull();
    const names = [...m![1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    expect(names).toEqual(["classify", "spec", "respec"]);
    const core = readFileSync(join(here, "..", "..", "..", "packages", "core", "src", "work-items", "driverEvents.ts"), "utf8");
    for (const n of names) expect(core).toContain(`'${n}'`);
  });

  it("the wait is the build's: five minutes, four hours (one constant each, used by both)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "workItemAdvance.ts"), "utf8");
    expect(src).toContain("const BUILD_SPEND_POLL_MS = 300_000;");
    expect(src).toContain("const BUILD_SPEND_WAIT_MS = 4 * 3_600_000;");
    const helper = src.slice(src.indexOf("async function askUntilAllowed"), src.indexOf("async function pausedEnd"));
    expect(helper).toContain("BUILD_SPEND_POLL_MS");
    expect(helper).toContain("BUILD_SPEND_WAIT_MS");
  });
});
