import { describe, expect, it, vi } from "vitest";
import type { AdvanceItem, AdvanceStepResult } from "@fx/worker";
import { buildBody, buildFailedBody, buildOutcomeBody, cancelRunBody, panelBody, specBody, stageBody } from "./advanceStageSteps";
import type { AdvanceWorker } from "./advanceSteps";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const USER = "55555555-5555-4555-8555-555555555555";
const ITEM = "22222222-2222-4222-8222-222222222222";
const ACTION = "44444444-4444-4444-8444-444444444444";
const WHO = { accountId: ACCOUNT, userId: USER, workItemId: ITEM, haltEpoch: 0 };

function worker(over: Partial<AdvanceWorker> = {}) {
  const base = {
    advanceLoadItem: vi.fn(async (): Promise<AdvanceItem | null> => ({ stage: "in_progress", provenance: "internal", repoId: "r", ghNumber: 7, ghOwner: "o", ghName: "n", hasDiscussion: true, kind: "feature", hasSpec: true, specVersion: 2, executorRunId: null })),
    advanceStartRun: vi.fn(),
    advanceRunOutcome: vi.fn(async () => ({ status: "running", done: false, envelope: null as Record<string, unknown> | null })),
    advanceTriage: vi.fn(),
    advancePanel: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "completed", complete: false, missingRoles: ["security-expert"], round2Ran: true })),
    advanceSpec: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "published", stage: "spec_ready", version: 2, replayed: false })),
    advanceBuild: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "started", runId: "run-b", branch: "fx/issue-7" })),
    advanceBuildFailed: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "recorded", stage: "needs_human" })),
  };
  return { ...base, ...over } as typeof base;
}

describe("the panel and Spec steps hand the workflow fixed words and numbers only", () => {
  it("panel: the pipeline's own outcome, with a count of the seats that did not post and never their names or text", async () => {
    const w = worker();
    expect(await panelBody(w, WHO)).toEqual({ status: "completed", reason: null, stage: null, version: null, complete: false, missing: 1, runId: null });
    expect(w.advancePanel).toHaveBeenCalledWith(WHO);
  });
  it("spec: published carries the stage and version", async () => {
    expect(await specBody(worker(), WHO)).toEqual({ status: "published", reason: null, stage: "spec_ready", version: 2, complete: null, missing: null, runId: null });
  });
  it.each([
    ["a refusal", { status: "refused", reason: "pm_failed" }],
    ["a Spec that is too large", { status: "needs_owner_action", reason: "spec_too_large" }],
    ["an external item", { status: "external_requires_human" }],
  ])("spec: %s passes through as data", async (_n, out) => {
    const got = await specBody(worker({ advanceSpec: async () => out as AdvanceStepResult }), WHO);
    expect(got).toMatchObject({ status: out.status, reason: (out as { reason?: string }).reason ?? null });
  });
  it("a text a model wrote in a result field cannot travel: only the listed fields are copied", async () => {
    const hostile = { status: "published", stage: "spec_ready", version: 1, summary: "model text", comment: "model text" } as unknown as AdvanceStepResult;
    expect(JSON.stringify(await specBody(worker({ advanceSpec: async () => hostile }), WHO))).not.toContain("model text");
  });
  it("no worker is a refusal with a fixed code, never a throw", async () => {
    for (const out of [await panelBody(null, WHO), await specBody(null, WHO), await buildBody(null, WHO, ACTION), await buildFailedBody(null, ACCOUNT, ITEM, "r", "failed")]) {
      expect(out).toMatchObject({ status: "refused", reason: "worker_unavailable" });
    }
  });
});

describe("specBody", () => {
  it("passes the approval to the worker so this attempt's PM run is its own", async () => {
    const w = worker();
    await specBody(w, WHO, ACTION);
    expect(w.advanceSpec).toHaveBeenCalledWith(WHO, ACTION);
  });
});

describe("cancelRunBody", () => {
  it("cancels through the worker as the approver, and does nothing without a worker", async () => {
    const cancel = vi.fn(async () => undefined);
    await cancelRunBody({ advanceCancel: cancel }, WHO, "run-x");
    expect(cancel).toHaveBeenCalledWith(WHO, "run-x");
    await expect(cancelRunBody(null, WHO, "run-x")).resolves.toBeUndefined();
  });
});

describe("buildBody", () => {
  it("asks the worker to build with the approval's action, and returns the run id", async () => {
    const w = worker();
    expect(await buildBody(w, WHO, ACTION)).toMatchObject({ status: "started", runId: "run-b" });
    expect(w.advanceBuild).toHaveBeenCalledWith(WHO, ACTION, undefined);
  });
  it("hands the worker the Spec version the person approved, so a newer one refuses the build", async () => {
    const w = worker();
    await buildBody(w, WHO, ACTION, 4);
    expect(w.advanceBuild).toHaveBeenCalledWith(WHO, ACTION, 4);
    const refusing = worker({ advanceBuild: async () => ({ status: "refused", reason: "spec_changed" }) });
    expect(await buildBody(refusing, WHO, ACTION, 4)).toMatchObject({ status: "refused", reason: "spec_changed", runId: null });
  });
  it("a refused start keeps its reason", async () => {
    const w = worker({ advanceBuild: async () => ({ status: "refused", reason: "start_no_model" }) });
    expect(await buildBody(w, WHO, ACTION)).toMatchObject({ status: "refused", reason: "start_no_model", runId: null });
  });
});

describe("buildOutcomeBody: the summary stays in the run", () => {
  it("says whether the envelope has a plain-text summary and never returns it", async () => {
    const withSummary = worker({ advanceRunOutcome: async () => ({ status: "succeeded", done: true, envelope: { summary: "I changed the footer." } }) });
    const out = await buildOutcomeBody(withSummary, ACCOUNT, "r");
    expect(out).toEqual({ status: "succeeded", done: true, hasSummary: true, queuedOnRunner: false });
    expect(JSON.stringify(out)).not.toContain("footer");
  });
  it.each([null, {}, { summary: "" }, { summary: "   " }, { summary: 3 }, { summary: { a: 1 } }])("%j is no summary", async (envelope) => {
    const w = worker({ advanceRunOutcome: async () => ({ status: "succeeded", done: true, envelope: envelope as Record<string, unknown> | null }) });
    expect((await buildOutcomeBody(w, ACCOUNT, "r")).hasSummary).toBe(false);
  });
  it("no worker is a finished 'missing' run", async () => {
    expect(await buildOutcomeBody(null, ACCOUNT, "r")).toEqual({ status: "missing", done: true, hasSummary: false, queuedOnRunner: false });
  });
});

describe("stageBody and buildFailedBody", () => {
  it("reads the stage, or null for a gone item", async () => {
    expect(await stageBody(worker(), ACCOUNT, ITEM)).toBe("in_progress");
    expect(await stageBody(worker({ advanceLoadItem: async () => null }), ACCOUNT, ITEM)).toBeNull();
    expect(await stageBody(null, ACCOUNT, ITEM)).toBeNull();
  });
  it.each([
    ["failed", "run_failed"],
    ["timed_out", "run_timed_out"],
    ["cancelled", "run_cancelled"],
    ["killed_spend", "run_killed_spend"],
    ["refused_spend", "run_refused_spend"],
    ["missing", "run_missing"],
    ["no_pull_request", "no_pull_request"],
    ["wait_timeout", "wait_timeout"],
  ])("%s is recorded under the fixed code %s", async (reason, code) => {
    const w = worker();
    expect(await buildFailedBody(w, ACCOUNT, ITEM, "run-b", reason)).toMatchObject({ status: "recorded", stage: "needs_human" });
    expect(w.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, "run-b", code);
  });
});
