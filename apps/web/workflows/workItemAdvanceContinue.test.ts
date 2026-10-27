import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceContinueOut, AdvanceItem, AdvanceRunOutcome, AdvanceRunRequest, AdvanceRunStart, AdvanceStartArgs, AdvanceStepResult, Worker } from "@fx/worker";
import { MAX_CONTINUATIONS_PER_WORK_ITEM } from "@fx/core/src/run-limits/limits.js";
import { REFUSED_BY_CODES } from "@fx/pipeline";
import { SWEEP_NAMES } from "@fx/core/src/pendingWork.js";
import { RUN_LIMIT_PARK_SENTENCE } from "@fx/core/src/work-items/continuationStops.js";
import type { IssueReadResult } from "@fx/github";

/**
 * D#2 H14c-3-3b-2 (C88 R1, section 3): the advance workflow continues an executor run that ended at a limit. The worker is a fake that answers
 * the continue step with each of the fixed codes; the step itself is tested over Postgres in packages/worker (advanceContinue.pg.test.ts).
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

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const ARGS: AdvanceStartArgs = { accountId: ACCOUNT, userId: "55555555-5555-4555-8555-555555555555", workItemId: ITEM, actionId: "44444444-4444-4444-8444-444444444444", haltEpoch: 0 };
const WHO = { accountId: ACCOUNT, userId: ARGS.userId, workItemId: ITEM, haltEpoch: 0 };
const AT_SPEC: AdvanceItem = { stage: "spec_ready", provenance: "internal", repoId: REPO, ghNumber: 7, branch: "fx/issue-7", ghOwner: "acme", ghName: "widgets", hasDiscussion: true, kind: "feature", hasSpec: true, specVersion: 3, executorRunId: null, executionMode: "sandbox", recordedPr: null };
const REVIEW_STOPS = { status: "failed", detail: "review_no_spec" };
const issue: IssueReadResult = { status: "found", title: "T", body: "B", login: "owner-1", state: "open", labels: [] };
const CHILD = (n: number) => `99999999-9999-4999-8999-${String(n).padStart(12, "0")}`;
const ENDED_AT_LIMIT = (status: string, tail = "run-b"): AdvanceRunOutcome => ({ status, done: true, envelope: null, tailRunId: tail });
const SUCCEEDED: AdvanceRunOutcome = { status: "succeeded", done: true, envelope: { summary: "Done." } };
const continued = (n: number): AdvanceContinueOut => ({ code: "continued", runId: CHILD(n), parkedAs: null });
const answer = (code: AdvanceContinueOut["code"], extra: Partial<AdvanceContinueOut> = {}): AdvanceContinueOut => ({ code, runId: null, parkedAs: null, ...extra });

interface Opts {
  /** The build run's outcome (`run-b`). */
  first?: AdvanceRunOutcome;
  /** Outcome of any other run, by id. */
  other?: (id: string) => AdvanceRunOutcome | undefined;
  /** What the continue step answers, one per call (the last repeats); absent: the worker has no such method. */
  steps?: Array<AdvanceContinueOut | "throw" | unknown>;
  checkFix?: AdvanceRunStart[];
}

function setup(o: Opts = {}) {
  const steps = o.steps ? [...o.steps] : null;
  let fixCalls = 0;
  let loads = 0;
  const worker: Record<string, unknown> = {
    advanceStartGate: vi.fn(async (..._args: unknown[]) => ({ proceed: true as const, how: "person_receipt" })),
    advanceFixGate: vi.fn(async (..._args: unknown[]) => ({ proceed: true as const, how: "not_gated", announce: false })),
    advanceLoadItem: vi.fn(async () => (loads++ === 0 ? AT_SPEC : { ...AT_SPEC, stage: "pr_opened" })),
    advanceStartRun: vi.fn(async (_r: AdvanceRunRequest): Promise<AdvanceRunStart> => ({ ok: true as const, runId: "run-1" })),
    advanceRunOutcome: vi.fn(async (_a: string, id: string): Promise<AdvanceRunOutcome> => {
      const other = o.other?.(id);
      if (other) return other;
      if (id === "run-b") return o.first ?? ENDED_AT_LIMIT("timed_out");
      return SUCCEEDED;
    }),
    advanceBuild: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "started", runId: "run-b", branch: "fx/issue-7" })),
    advanceBuildFailed: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "recorded", stage: "needs_human" })),
    advanceStartCheckFix: vi.fn(async (): Promise<AdvanceRunStart> => {
      fixCalls += 1;
      return o.checkFix ? (o.checkFix[fixCalls - 1] ?? o.checkFix.at(-1)!) : { ok: true as const, runId: `run-fix-${fixCalls}` };
    }),
    advanceDecision: vi.fn(async () => "none"),
    advanceCancel: vi.fn(async () => undefined),
    advanceRecordEvent: vi.fn(async () => ({ recorded: true })),
    advanceLoadReview: vi.fn(async () => ({ ok: false, reason: "no_spec" })),
  };
  if (steps) {
    worker.advanceContinue = vi.fn(async (): Promise<unknown> => {
      const next = steps.length > 1 ? steps.shift()! : steps[0]!;
      if (next === "throw") throw new RangeError("private text");
      return next;
    });
  }
  setWorkerWiringForTests({ provider: () => ({}) as never, createWorker: async () => worker as unknown as Worker });
  setIssueReaderForTests(async () => issue);
  return worker as Record<string, ReturnType<typeof vi.fn>>;
}

let logs: Array<Record<string, unknown>>;
beforeEach(() => {
  world.sleeps = 0;
  logs = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => void logs.push(JSON.parse(String(line))));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setWorkerWiringForTests();
  setIssueReaderForTests();
  setInstallationHttpForTests();
});
const events = () => logs.map((l) => l.event);
const stoppedFact = (w: Record<string, ReturnType<typeof vi.fn>>) => w.advanceRecordEvent!.mock.calls.map((c) => c[1] as Record<string, unknown>).find((e) => e.kind === "stopped");

describe("the build", () => {
  it("a timed_out build is continued, the child is followed, and when it succeeds the build carries on to the pull request as it always did", async () => {
    const w = setup({ steps: [continued(1)] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual(REVIEW_STOPS);
    expect(w.advanceContinue).toHaveBeenCalledTimes(1);
    expect(w.advanceContinue).toHaveBeenCalledWith(WHO, "run-b");
    expect(w.advanceBuildFailed).not.toHaveBeenCalled();
    // The start gate ran once, at entry, before the build started; the continuation did not ask it again.
    expect(w.advanceStartGate).toHaveBeenCalledTimes(1);
    expect(w.advanceStartGate!.mock.invocationCallOrder[0]!).toBeLessThan(w.advanceBuild!.mock.invocationCallOrder[0]!);
    expect(w.advanceBuild!.mock.invocationCallOrder[0]!).toBeLessThan(w.advanceContinue!.mock.invocationCallOrder[0]!);
    expect(logs.find((l) => l.event === "advance.continued")).toMatchObject({ from_run_id: "run-b", run_id: CHILD(1) });
    expect(logs.find((l) => l.event === "advance.built")).toMatchObject({ run_id: CHILD(1) });
  });

  it("a killed_spend build is continued the same way", async () => {
    const w = setup({ first: ENDED_AT_LIMIT("killed_spend"), steps: [continued(1)] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual(REVIEW_STOPS);
    expect(w.advanceContinue).toHaveBeenCalledTimes(1);
  });

  it("a child that also ends at a limit is continued again, each time from the run that just ended; the build waits for the newest child", async () => {
    const w = setup({ steps: [continued(1), continued(2)], other: (id) => (id === CHILD(1) ? ENDED_AT_LIMIT("timed_out", CHILD(1)) : undefined) });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual(REVIEW_STOPS);
    expect(w.advanceContinue!.mock.calls.map((c) => c[1])).toEqual(["run-b", CHILD(1)]);
    expect(logs.find((l) => l.event === "advance.built")).toMatchObject({ run_id: CHILD(2) });
  });

  it("a run that succeeded, failed or was cancelled never asks the step", async () => {
    for (const first of [SUCCEEDED, { status: "failed", done: true, envelope: null, tailRunId: "run-b" }, { status: "cancelled", done: true, envelope: null, tailRunId: "run-b" }, { status: "running", done: false, envelope: null, tailRunId: "run-b" }] as AdvanceRunOutcome[]) {
      const w = setup({ first, steps: [continued(1)] });
      await workItemAdvanceWorkflow(ARGS);
      expect(w.advanceContinue).not.toHaveBeenCalled();
    }
  });

  describe("every outcome of the step (C88 section 3)", () => {
    it.each([...REFUSED_BY_CODES])("parked %s: ends failed build_parked:%s, no failure transition of its own, and the stop fact carries the code and the reason", async (refusedBy) => {
      const w = setup({ steps: [answer("parked", { parkedAs: refusedBy })] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: `build_parked:${refusedBy}` });
      expect(w.advanceBuildFailed).not.toHaveBeenCalled();
      expect(stoppedFact(w)).toEqual({ kind: "stopped", dedupeKey: "build:run-b", code: "run_limit_parked", reasons: [refusedBy], runId: "run-b" });
      expect(Object.keys(RUN_LIMIT_PARK_SENTENCE)).toContain(refusedBy);
    });

    it("parked monthly_budget_reached: its own stop code", async () => {
      const w = setup({ first: ENDED_AT_LIMIT("killed_spend"), steps: [answer("parked", { parkedAs: "monthly_budget_reached" })] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_parked:monthly_budget_reached" });
      expect(w.advanceBuildFailed).not.toHaveBeenCalled();
      expect(stoppedFact(w)).toEqual({ kind: "stopped", dedupeKey: "build:run-b", code: "monthly_budget_parked", runId: "run-b" });
    });

    it("work_item_closed: ends build_item_closed; nothing parked or recorded", async () => {
      const w = setup({ steps: [answer("work_item_closed")] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_item_closed" });
      expect(w.advanceBuildFailed).not.toHaveBeenCalled();
      expect(w.advanceRecordEvent).not.toHaveBeenCalled();
    });

    it("waiting_on_answer: the workflow ends through waitingOnAnswer on the ended run", async () => {
      const w = setup({ steps: [answer("waiting_on_answer")] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "waiting_on_answer" });
      expect(w.advanceBuildFailed).not.toHaveBeenCalled();
      expect(stoppedFact(w)).toMatchObject({ code: "waiting_on_answer", runId: "run-b" });
    });

    it("halted: haltedEnd, today's halt, nothing else", async () => {
      const w = setup({ steps: [answer("halted")] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "halted" });
      expect(w.advanceBuildFailed).not.toHaveBeenCalled();
      expect(stoppedFact(w)).toMatchObject({ code: "halted" });
    });

    it("duplicate: follows the child the first pass started", async () => {
      const w = setup({ steps: [{ code: "duplicate", runId: CHILD(1), parkedAs: null }] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual(REVIEW_STOPS);
      expect(logs.find((l) => l.event === "advance.continued")).toMatchObject({ run_id: CHILD(1), replay: true });
      expect(w.advanceBuildFailed).not.toHaveBeenCalled();
    });

    it("today: the failure is recorded exactly as before continuation existed (run_timed_out / run_killed_spend)", async () => {
      for (const [status, detail] of [["timed_out", "build_timed_out"], ["killed_spend", "build_killed_spend"]] as const) {
        const w = setup({ first: ENDED_AT_LIMIT(status), steps: [answer("today")] });
        expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail });
        expect(w.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, "run-b", `run_${status}`);
        expect(stoppedFact(w)).toMatchObject({ code: `build_run_${status}` });
      }
    });

    it("busy three times, then a child found: slept 30 s each time, then the child is followed", async () => {
      const w = setup({ steps: [answer("busy"), answer("busy"), answer("busy"), continued(1)] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual(REVIEW_STOPS);
      expect(w.advanceContinue).toHaveBeenCalledTimes(4);
      expect(world.sleeps).toBe(3);
    });

    it("busy past the third sleep with no child: today's path", async () => {
      const w = setup({ steps: [answer("busy")] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_timed_out" });
      expect(w.advanceContinue).toHaveBeenCalledTimes(4);
      expect(world.sleeps).toBe(3);
      expect(w.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, "run-b", "run_timed_out");
    });
  });

  describe("fails closed on anything the step cannot be trusted for", () => {
    it.each([
      ["a worker with no such method", undefined],
      ["a step that throws", "throw"],
      ["an unknown code", { code: "start_it_anyway", runId: CHILD(1), parkedAs: null }],
      ["a continuation with no run id", { code: "continued", runId: null, parkedAs: null }],
      ["a continuation with a run id that is not an id", { code: "continued", runId: "run-1; DROP", parkedAs: null }],
      ["a park with no reason", { code: "parked", runId: null, parkedAs: null }],
      ["a park with a reason that is not a plain code", { code: "parked", runId: null, parkedAs: "Platform Budget!" }],
      ["nothing at all", null],
      ["a continuation of the run it was asked about", { code: "continued", runId: "run-b", parkedAs: null }],
    ])("%s is today's path: the failure is recorded and nothing is followed", async (_name, step) => {
      const w = setup({ steps: step === undefined ? undefined : [step] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_timed_out" });
      expect(w.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, "run-b", "run_timed_out");
    });
  });

  describe("bounded", () => {
    it(`a step that keeps answering continued stops after ${MAX_CONTINUATIONS_PER_WORK_ITEM + 1} looks and records the failure as before`, async () => {
      let n = 0;
      const w = setup({ steps: [continued(1)], other: (id) => (id.startsWith("99999999") ? ENDED_AT_LIMIT("timed_out", id) : undefined) });
      w.advanceContinue!.mockImplementation(async () => continued(++n));
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_timed_out" });
      expect(w.advanceContinue).toHaveBeenCalledTimes(MAX_CONTINUATIONS_PER_WORK_ITEM + 1);
      expect(w.advanceBuildFailed).toHaveBeenCalledTimes(1);
    });

    it("the workflow's copy of the ceiling is the shared constant, and the busy waits are 30 s three times", () => {
      const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "workItemAdvance.ts"), "utf8");
      expect(src).toContain(`const MAX_CONTINUATIONS_PER_WORK_ITEM = ${MAX_CONTINUATIONS_PER_WORK_ITEM};`);
      expect(src).toContain("const CONTINUE_BUSY_SLEEP_MS = 30_000;");
      expect(src).toContain("const CONTINUE_BUSY_RETRIES = 3;");
    });

    it("a child whose wait runs out ends like any run whose wait ran out: cancelled and recorded wait_timeout", async () => {
      const w = setup({ steps: [continued(1)], other: (id) => (id === CHILD(1) ? { status: "running", done: false, envelope: null, tailRunId: CHILD(1) } : undefined) });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_wait_timeout" });
      expect(world.sleeps).toBe(250);
      expect(w.advanceCancel).toHaveBeenCalledWith(expect.objectContaining({ workItemId: ITEM }), CHILD(1));
    });
  });

  describe("runs the continuation step does not decide for", () => {
    it("a runner wall-clock or watchdog end (timed_out, no checkpoint) is the step's `today`, and the card keeps today's code", async () => {
      const w = setup({ steps: [answer("today")] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_timed_out" });
      expect(stoppedFact(w)).toMatchObject({ code: "build_run_timed_out" });
    });
  });
});

describe("a check fix round", () => {
  const checkFailed: AdvanceRunOutcome = { status: "failed", done: true, envelope: null, runtime: "runner", tailRunId: "run-b", failureReason: "check_failed" };

  it("a fix round that ended at a limit is continued, and when the child succeeds the build goes on to the review", async () => {
    const w = setup({ first: checkFailed, steps: [continued(1)], other: (id) => (id === "run-fix-1" ? ENDED_AT_LIMIT("timed_out", "run-fix-1") : undefined) });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual(REVIEW_STOPS);
    expect(w.advanceContinue).toHaveBeenCalledWith(WHO, "run-fix-1");
    expect(w.advanceBuildFailed).not.toHaveBeenCalled();
    expect(logs.find((l) => l.event === "advance.built")).toMatchObject({ run_id: CHILD(1) });
    // D#483 S5-b2a part 3: the gate was asked for the failed run once; the continuation of the round it started is not a new round and passes no gate.
    expect(w.advanceFixGate!.mock.calls.map((c) => c[1])).toEqual([{ personFiled: false, checkFailedRunId: "run-b" }]);
    expect(w.advanceStartCheckFix).toHaveBeenCalledTimes(1);
  });

  it("a fix round parked by a run limit ends build_parked, with no failure transition", async () => {
    const w = setup({ first: checkFailed, steps: [answer("parked", { parkedAs: "max_resumes" })], other: (id) => (id === "run-fix-1" ? ENDED_AT_LIMIT("killed_spend", "run-fix-1") : undefined) });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_parked:max_resumes" });
    expect(w.advanceBuildFailed).not.toHaveBeenCalled();
  });
});

describe("guards on the file", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "workItemAdvance.ts"), "utf8");
  const body = (name: string): string => {
    const start = src.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("\nasync function ", start + 10);
    const exp = src.indexOf("\nexport async function ", start + 10);
    return src.slice(start, Math.min(...[next, exp].filter((i) => i > -1)));
  };

  it("no other loop reads an executor run's outcome without going through the continue helper: the readers are fixed, and the executor ones call it", () => {
    const readers = [...src.matchAll(/\nasync function (\w+)\([\s\S]*?(?=\nasync function |\nexport async function |$)/g)]
      .filter((m) => m[0].includes("advanceBuildOutcomeStep("))
      .map((m) => m[1]);
    // light spec and re-spec wait on a project-manager run, waitForExecutorRun is the helper's own wait.
    expect(readers.sort()).toEqual(["buildPhase", "followFix", "lightPhase", "respecPhase", "waitForExecutorRun"]);
    expect(body("buildPhase").match(/continueLimitEnds\(/g)).toHaveLength(2);
    expect(body("followFix")).toContain("continueLimitEnds(");
    expect(body("lightPhase")).not.toContain("continueLimitEnds");
    expect(body("respecPhase")).not.toContain("continueLimitEnds");
  });

  it("the helper asks the step before any failure is recorded, and the step is never retried by the platform (a refusal is data)", () => {
    const helper = body("continueLimitEnds");
    expect(helper).not.toContain("advanceBuildFailedStep");
    expect(helper.indexOf("advanceContinueStep(")).toBeGreaterThan(-1);
  });

  it("the start gate runs at stage entry only: a continuation never passes through it (or re-triggers it)", () => {
    for (const fn of ["continueLimitEnds", "waitForExecutorRun", "buildPhase", "followFix"]) {
      expect(body(fn), fn).not.toMatch(/startGate/i);
    }
    // every gate call sits in the entry points that run before any run starts
    expect(body("continueLimitEnds")).toContain("advanceContinueStep(");
    expect(src.match(/startGatePhase\(/g)!.length).toBeGreaterThan(0);
  });

  it("no new trigger: the cron list and the sweep names are the frozen lists (R1, push not poll)", () => {
    const vercel = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../vercel.json"), "utf8")) as { crons?: Array<{ path: string }> };
    expect((vercel.crons ?? []).map((c) => c.path).sort()).toEqual(FROZEN_CRON_PATHS);
    expect([...SWEEP_NAMES]).toEqual(FROZEN_SWEEP_NAMES);
  });

  it("agentRunFollow.ts and the runner done route do not mention continuation", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(readFileSync(join(here, "agentRunFollow.ts"), "utf8")).not.toMatch(/continueAfterLimit|advanceContinue/);
    expect(readFileSync(join(here, "../app/api/runner/runs/[id]/done/handler.ts"), "utf8")).not.toMatch(/continueAfterLimit|advanceContinue/);
  });
});

/** The cron list and sweep names: this part adds no entry (R1, push not poll). D#519 MQ3-b added `merge-queue-sweep`, which is behind its own pending-work marker. */
const FROZEN_CRON_PATHS = ["/api/cron/api-sweep", "/api/cron/branch-cleanup", "/api/cron/compute-settle-sweep", "/api/cron/handoff-sweep", "/api/cron/invariant-sweep", "/api/cron/merge-queue-sweep", "/api/cron/proposal-verify-sweep", "/api/cron/reconcile", "/api/cron/run-action-sweep", "/api/cron/runner-sweeper", "/api/cron/setup-request-check", "/api/cron/stage-resume-sweep"];
const FROZEN_SWEEP_NAMES = ["api-sweep", "run-action-sweep", "compute-settle-sweep", "reconcile", "runner-sweeper", "invariant-sweep", "handoff-sweep", "stage-resume-sweep", "setup-request-check", "branch-cleanup", "proposal-verify-sweep", "merge-queue-sweep"];
