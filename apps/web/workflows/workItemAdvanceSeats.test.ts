import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceContinueOut, AdvanceItem, AdvanceRunOutcome, AdvanceRunRequest, AdvanceStartArgs, Worker } from "@fx/worker";
import type { IssueReadResult } from "@fx/github";
import { MAX_CONTINUATIONS_PER_WORK_ITEM } from "@fx/core/src/run-limits/limits.js";

/**
 * D#2 H14c-3-3b-3 (C89): the classify, short Spec and re-spec waits continue a run that ended at a limit at their own fixed site, follow the child, and publish
 * from the child's run. The worker is a fake that answers the continue step; the step itself is tested over Postgres in packages/worker.
 */
const world = vi.hoisted(() => ({ sleeps: 0 }));
vi.mock("workflow", () => ({ sleep: vi.fn(async () => void (world.sleeps += 1)) }));
vi.mock("workflow/api", () => ({ resumeHook: vi.fn(), start: vi.fn() }));

import { setWorkerWiringForTests } from "../lib/worker";
import { setIssueReaderForTests } from "../lib/github/issueRead";
import { workItemAdvanceWorkflow } from "./workItemAdvance";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const USER = "55555555-5555-4555-8555-555555555555";
const ARGS: AdvanceStartArgs = { accountId: ACCOUNT, userId: USER, workItemId: ITEM, actionId: "44444444-4444-4444-8444-444444444444", haltEpoch: 0 };
const WHO = { accountId: ACCOUNT, userId: USER, workItemId: ITEM, haltEpoch: 0 };
const AT_TRIAGED: AdvanceItem = { stage: "triaged", provenance: "internal", repoId: REPO, ghNumber: 7, branch: "fx/issue-7", ghOwner: "acme", ghName: "widgets", hasDiscussion: false, kind: null, hasSpec: false, specVersion: null, executorRunId: null, executionMode: "sandbox", recordedPr: null };
const issue: IssueReadResult = { status: "found", title: "T", body: "B", login: "owner-1", state: "open", labels: [] };
const FIRST = "run-1";
const CHILD = "99999999-9999-4999-8999-000000000003";
const ENDED = (status: string): AdvanceRunOutcome => ({ status, done: true, envelope: null, tailRunId: FIRST });
const CHILD_OK = (envelope: Record<string, unknown>): AdvanceRunOutcome => ({ status: "succeeded", done: true, envelope });
const continued: AdvanceContinueOut = { code: "continued", runId: CHILD, parkedAs: null };
const answer = (code: AdvanceContinueOut["code"], parkedAs: string | null = null): AdvanceContinueOut => ({ code, runId: null, parkedAs });

function setup(o: { first: AdvanceRunOutcome; child?: AdvanceRunOutcome; step?: AdvanceContinueOut | "throw"; item?: AdvanceItem }) {
  const worker = {
    advanceLoadItem: vi.fn(async () => o.item ?? AT_TRIAGED),
    advanceStartRun: vi.fn(async (_r: AdvanceRunRequest) => ({ ok: true as const, runId: FIRST })),
    advanceRunOutcome: vi.fn(async (_a: string, id: string): Promise<AdvanceRunOutcome> => (id === CHILD ? o.child! : o.first)),
    advanceTriage: vi.fn(async () => ({ status: "triaged", stage: "triaged", workItemId: ITEM, category: "feature" })),
    advanceLoadSpecText: vi.fn(async () => ({ version: 4, body: "SPEC" })),
    advanceRespec: vi.fn(async () => ({ status: "published", reason: null, version: 5 })),
    advanceStartGate: vi.fn(async () => ({ proceed: true, how: "x" })),
    advanceCancel: vi.fn(async () => undefined),
    advanceRecordEvent: vi.fn(async () => ({ recorded: true })),
    advanceContinue: vi.fn(async (): Promise<unknown> => {
      if (o.step === "throw") throw new RangeError("private text");
      return o.step ?? answer("today");
    }),
  };
  setWorkerWiringForTests({ provider: () => ({}) as never, createWorker: async () => worker as unknown as Worker });
  setIssueReaderForTests(async () => issue);
  return worker;
}

beforeEach(() => {
  world.sleeps = 0;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setWorkerWiringForTests();
  setIssueReaderForTests();
});

describe("classify", () => {
  it.each(["timed_out", "killed_spend"])("a classify run that ended %s is continued at the classify site, the child is followed, and its category is triaged", async (status) => {
    const w = setup({ first: ENDED(status), child: CHILD_OK({ category: "feature" }), step: continued });
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("triaged");
    expect(w.advanceContinue).toHaveBeenCalledWith(WHO, FIRST, "classify");
    expect(w.advanceTriage).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ category: "feature" }));
  });

  it.each([
    ["today", answer("today"), "classify_timed_out"],
    ["a throw", "throw" as const, "classify_timed_out"],
    ["parked", answer("parked", "max_resumes"), "classify_parked:max_resumes"],
    ["closed", answer("work_item_closed"), "classify_item_closed"],
  ])("%s: the classify seat ends with its own code and triage never runs", async (_name, step, detail) => {
    const w = setup({ first: ENDED("timed_out"), step });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail });
    expect(w.advanceTriage).not.toHaveBeenCalled();
  });

  it("a run that ended any other way is never offered for continuation", async () => {
    const w = setup({ first: ENDED("failed"), step: continued });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_failed" });
    expect(w.advanceContinue).not.toHaveBeenCalled();
  });

  it("a child that ends at a limit again is continued again, at most the per-item ceiling of times", async () => {
    const w = setup({ first: ENDED("timed_out") });
    w.advanceRunOutcome.mockImplementation(async () => ({ status: "timed_out", done: true, envelope: null }));
    let n = 0;
    w.advanceContinue.mockImplementation(async () => ({ code: "continued", runId: `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`, parkedAs: null }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_timed_out" });
    expect(w.advanceContinue).toHaveBeenCalledTimes(MAX_CONTINUATIONS_PER_WORK_ITEM);
  });
});

describe("short Spec", () => {
  it("a short-Spec run that ended at a limit is continued at the light_spec site and the Spec is published from the child's run", async () => {
    const w = setup({ first: ENDED("timed_out"), child: CHILD_OK({ feasible: false }), step: continued, item: { ...AT_TRIAGED, hasDiscussion: true, kind: "bug" } });
    const publish = vi.fn(async () => ({ status: "not_feasible", reason: null, version: null }));
    (w as unknown as Record<string, unknown>).advanceLightSpec = publish;
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "not_feasible" });
    expect(w.advanceContinue).toHaveBeenCalledWith(WHO, FIRST, "light_spec");
    expect(publish).toHaveBeenCalledWith(expect.anything(), CHILD, ARGS.actionId);
    // The start gate (#510) runs once, at stage entry, before the seat starts; the continuation never goes back through it.
    expect(w.advanceStartGate).toHaveBeenCalledTimes(1);
    expect(w.advanceStartGate.mock.invocationCallOrder[0]!).toBeLessThan(w.advanceStartRun.mock.invocationCallOrder[0]!);
    expect(w.advanceStartGate.mock.invocationCallOrder[0]!).toBeLessThan(w.advanceContinue.mock.invocationCallOrder[0]!);
  });
});

describe("guards on the file", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "workItemAdvance.ts"), "utf8");
  const body = (name: string): string => {
    const start = src.indexOf(`async function ${name}`);
    expect(start).toBeGreaterThan(-1);
    const rest = src.slice(start + 10);
    return src.slice(start, start + 10 + (rest.search(/\n(export )?async function |\ninterface /) === -1 ? rest.length : rest.search(/\n(export )?async function |\ninterface /)));
  };

  it("no seat continuation passes through the start gate: the continue helpers and the reviewer wait never name it", () => {
    for (const name of ["continueSeat", "followSeat", "waitForReviewer", "continueLimitEnds"]) {
      expect(body(name)).not.toMatch(/startGate|StartGate/);
    }
  });
});

describe("re-spec", () => {
  const RESPEC: AdvanceStartArgs = { ...ARGS, respec: true, specVersion: 4 };

  it("a re-spec run that ended at a limit is continued at the respec site and the Spec is published from the child's run", async () => {
    const w = setup({ first: ENDED("timed_out"), child: CHILD_OK({ acceptance_files: ["src/a.ts"] }), step: continued });
    expect(await workItemAdvanceWorkflow(RESPEC)).toEqual({ status: "respec_published" });
    expect(w.advanceContinue).toHaveBeenCalledWith(WHO, FIRST, "respec");
    expect(w.advanceRespec).toHaveBeenCalledWith(expect.objectContaining({ workItemId: ITEM }), CHILD, ARGS.actionId, 4);
  });

  it("a refused continuation publishes nothing, as before", async () => {
    const w = setup({ first: ENDED("timed_out"), step: answer("today") });
    expect(await workItemAdvanceWorkflow(RESPEC)).toEqual({ status: "respec_failed", detail: "run_timed_out" });
    expect(w.advanceRespec).not.toHaveBeenCalled();
  });
});
