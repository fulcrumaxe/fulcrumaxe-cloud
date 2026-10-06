import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceItem, AdvanceRunOutcome, AdvanceRunRequest, AdvanceStartArgs, AdvanceStepResult, Worker } from "@fx/worker";
import type { IssueReadResult } from "@fx/github";

/**
 * D#483 P1: the advance workflow body over a fake worker and a fake issue reader. `sleep` only runs inside a real
 * workflow execution, so it is mocked here (vitest is 2.x, below @workflow/vitest's peer): it counts the polls and
 * returns at once. The directives are plain strings outside the Workflow builder, so the steps run as ordinary async
 * functions over the real lib/worker.ts wiring.
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
const ARGS: AdvanceStartArgs = { accountId: ACCOUNT, userId: "55555555-5555-4555-8555-555555555555", workItemId: ITEM, actionId: "44444444-4444-4444-8444-444444444444" };
const ITEM_OK: AdvanceItem = { stage: "triaged", provenance: "internal", repoId: REPO, ghNumber: 7, ghOwner: "acme", ghName: "widgets", hasDiscussion: false, kind: null, hasSpec: false, specVersion: null, executorRunId: null };
const issue = (over: Partial<Extract<IssueReadResult, { status: "found" }>> = {}): IssueReadResult => ({ status: "found", title: "T", body: "B", login: "owner-1", state: "open", labels: [], ...over });
const maint = (name: string) => ({ name, actorLogin: "maint", actorPermission: "maintain" as const });

interface SetupOptions {
  item?: AdvanceItem | null;
  issue?: IssueReadResult | Error;
  outcomes?: AdvanceRunOutcome[];
  start?: { ok: true; runId: string } | { ok: false; reason: string };
  triage?: Record<string, unknown>;
  panel?: AdvanceStepResult;
  spec?: AdvanceStepResult;
  build?: AdvanceStepResult;
  /** The executor run's statuses, read one per poll (the last repeats). */
  buildOutcomes?: AdvanceRunOutcome[];
  /** The item's stage as read after the executor run ended, one per read (the last repeats). */
  stages?: string[];
}

function setup(o: SetupOptions = {}) {
  const outcomes = [...(o.outcomes ?? [{ status: "succeeded", done: true, envelope: { category: "feature" } }])];
  const buildOutcomes = [...(o.buildOutcomes ?? [{ status: "succeeded", done: true, envelope: { summary: "I changed the footer." } }])];
  let loads = 0;
  const worker = {
    advanceLoadItem: vi.fn(async () => {
      if (o.item === null) return null;
      const item = o.item ?? ITEM_OK;
      // The first read is the workflow's load. Later reads are stage probes after the build run ended: the scripted stages.
      loads += 1;
      return loads > 1 && o.stages ? { ...item, stage: (o.stages.length > 1 ? (o.stages.shift() as string) : o.stages[0]) as string } : item;
    }),
    advanceStartRun: vi.fn(async (_req: AdvanceRunRequest) => o.start ?? { ok: true as const, runId: "run-1" }),
    advanceRunOutcome: vi.fn(async (_a: string, runId: string) => {
      const list = runId === "run-b" ? buildOutcomes : outcomes;
      return list.length > 1 ? list.shift()! : list[0]!;
    }),
    advanceTriage: vi.fn(async () => o.triage ?? { status: "triaged", stage: "triaged", workItemId: ROOT }),
    advancePanel: vi.fn(async (): Promise<AdvanceStepResult> => o.panel ?? { status: "completed", complete: true, missingRoles: [], round2Ran: false }),
    advanceSpec: vi.fn(async (): Promise<AdvanceStepResult> => o.spec ?? { status: "published", stage: "spec_ready", version: 1 }),
    advanceBuild: vi.fn(async (): Promise<AdvanceStepResult> => o.build ?? { status: "started", runId: "run-b", branch: "fx/issue-7" }),
    advanceBuildFailed: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "recorded", stage: "needs_human" })),
  };
  setWorkerWiringForTests({ provider: () => ({}) as never, createWorker: async () => worker as unknown as Worker });
  setIssueReaderForTests(async () => {
    const r = o.issue ?? issue();
    if (r instanceof Error) throw r;
    return r;
  });
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

describe("workItemAdvanceWorkflow: classify then triage", () => {
  it("one classify run on the PM card, then triage with the category the run chose", async () => {
    const w = setup({ outcomes: [{ status: "running", done: false, envelope: null }, { status: "running", done: false, envelope: null }, { status: "succeeded", done: true, envelope: { category: "bug" } }] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "triaged", detail: undefined });
    expect(w.advanceStartRun).toHaveBeenCalledTimes(1);
    expect(w.advanceStartRun.mock.calls[0]![0]).toMatchObject({ role: "project-manager", step: `classify:${ARGS.actionId}`, workItemId: ITEM });
    expect(world.sleeps).toBe(2);
    expect(w.advanceTriage).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ workItemId: ITEM, category: "bug", sourceEventId: `gh-issue:${REPO}:7`, number: 7, login: "owner-1" }));
    expect(events()).toEqual(["advance.classified", "advance.triaged"]);
  });

  it("a trusted decisive label skips the classify run entirely and says so in the log", async () => {
    const w = setup({ issue: issue({ labels: [maint("bug")] }) });
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("triaged");
    expect(w.advanceStartRun).not.toHaveBeenCalled();
    expect(w.advanceRunOutcome).not.toHaveBeenCalled();
    expect(w.advanceTriage).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ category: "bug" }));
    expect(events()).toEqual(["advance.label_decided", "advance.triaged"]);
    expect(logs[0]).toMatchObject({ category: "bug" });
  });

  it("a hint label still runs the classifier, and the prompt carries it", async () => {
    const w = setup({ issue: issue({ labels: [maint("enhancement")] }) });
    await workItemAdvanceWorkflow(ARGS);
    expect(w.advanceStartRun).toHaveBeenCalledTimes(1);
    expect(w.advanceStartRun.mock.calls[0]![0].prompt).toContain("enhancement");
  });

  it("an untrusted actor's decisive label is ignored: the classifier runs and its prompt does not carry the label", async () => {
    const w = setup({ issue: issue({ labels: [{ name: "documentation", actorLogin: "stranger", actorPermission: "none" }] }) });
    await workItemAdvanceWorkflow(ARGS);
    expect(w.advanceStartRun).toHaveBeenCalledTimes(1);
    expect(w.advanceStartRun.mock.calls[0]![0].prompt).not.toContain("LABELS");
  });

  it("conflicting decisive labels go to the classifier with both as hints", async () => {
    const w = setup({ issue: issue({ labels: [maint("bug"), maint("documentation")] }) });
    await workItemAdvanceWorkflow(ARGS);
    const prompt = w.advanceStartRun.mock.calls[0]![0].prompt;
    expect(prompt).toContain("bug");
    expect(prompt).toContain("documentation");
  });

  it.each(["failed", "timed_out", "cancelled", "killed_spend", "refused_spend"])("a classify run that ends %s stops with a fixed code and never triages", async (status) => {
    const w = setup({ outcomes: [{ status, done: true, envelope: null }] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: `classify_${status}` });
    expect(w.advanceTriage).not.toHaveBeenCalled();
    expect(events()).toEqual(["advance.classified", "advance.failed"]);
    expect(logs[1]).toMatchObject({ at: "classify", reason: `run_${status}` });
  });

  it("a run that succeeded with no category, or a non-string one, stops and never triages", async () => {
    for (const envelope of [null, {}, { category: 3 }]) {
      const w = setup({ outcomes: [{ status: "succeeded", done: true, envelope }] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_no_category" });
      expect(w.advanceTriage).not.toHaveBeenCalled();
    }
  });

  it("junk that is a string reaches triage, whose own parser refuses it: nothing is written and the outcome is unclassified", async () => {
    const w = setup({ outcomes: [{ status: "succeeded", done: true, envelope: { category: "urgent!!" } }], triage: { status: "unclassified", reason: "classifier output names a category outside the fixed set" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "unclassified", detail: "classifier output names a category outside the fixed set" });
    expect(w.advanceTriage).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ category: "urgent!!" }));
    expect(events()).toEqual(["advance.classified", "advance.stopped"]);
  });

  it("a run that never finishes ends at the wait limit with a fixed code", async () => {
    const w = setup({ outcomes: [{ status: "running", done: false, envelope: null }] });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_wait_timeout" });
    expect(world.sleeps).toBe(45); // 15 minutes of 20 second polls
    expect(w.advanceTriage).not.toHaveBeenCalled();
  });

  describe("D#6 C12 A3: time spent pending (a queued runner run) does not count against the wait", () => {
    const pending = { status: "pending", done: false, envelope: null, runtime: "runner" } as const;
    const running = { status: "running", done: false, envelope: null } as const;

    it("a run that waits an hour for a runner and then succeeds is not given up on at the 15 minute limit", async () => {
      // 200 polls at 20 seconds is about 67 minutes pending: more than four times the classify budget.
      const w = setup({ outcomes: [...Array.from({ length: 200 }, () => pending), { status: "succeeded", done: true, envelope: { category: "bug" } }] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "triaged", detail: undefined });
      expect(world.sleeps).toBe(200);
      expect(w.advanceTriage).toHaveBeenCalledTimes(1);
    });

    it("the budget starts counting when the run does: pending polls, then the full 45 polls of running", async () => {
      setup({ outcomes: [...Array.from({ length: 100 }, () => pending), running] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_wait_timeout" });
      expect(world.sleeps).toBe(100 + 45);
    });

    it("a run that is only ever running still ends at the same limit as before", async () => {
      setup({ outcomes: [running] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_wait_timeout" });
      expect(world.sleeps).toBe(45);
    });

    // The ceiling is the runner queue TTL (72 hours) plus a one hour margin, in 20 second polls.
    const CEILING_POLLS = (73 * 3600) / 20;

    it("a runner run held pending past the ceiling ends the wait with the normal timeout reason", async () => {
      setup({ outcomes: [pending] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_wait_timeout" });
      expect(world.sleeps).toBe(CEILING_POLLS);
    });

    it("a sandbox run that stays pending ends at the normal cap, not the ceiling", async () => {
      setup({ outcomes: [{ ...pending, runtime: "production" }] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_wait_timeout" });
      expect(world.sleeps).toBe(45);
    });

    it("a pending run with no runtime is not credited either", async () => {
      setup({ outcomes: [{ status: "pending", done: false, envelope: null }] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_wait_timeout" });
      expect(world.sleeps).toBe(45);
    });

    it("a runner run that goes pending, then running, then pending again still gets its credit", async () => {
      // 100 pending polls, 20 running, 100 pending, then success: only the 20 running polls count against the 45.
      const w = setup({ outcomes: [...Array.from({ length: 100 }, () => pending), ...Array.from({ length: 20 }, () => running), ...Array.from({ length: 100 }, () => pending), { status: "succeeded", done: true, envelope: { category: "bug" } }] });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "triaged", detail: undefined });
      expect(world.sleeps).toBe(220);
      expect(w.advanceTriage).toHaveBeenCalledTimes(1);
    });

    it("the workflow's ceiling is the pipeline's: the 72 hour queue TTL plus the margin", async () => {
      const { RUNNER_PENDING_CEILING_MS } = await import("@fx/pipeline");
      expect(RUNNER_PENDING_CEILING_MS).toBe(73 * 3_600_000);
      expect(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "workItemAdvance.ts"), "utf8")).toContain("const RUNNER_PENDING_CEILING_MS = 73 * 3_600_000;");
    });
  });

  it("a refused classify start (no model key, spend refused, no card) stops with the reason", async () => {
    const w = setup({ start: { ok: false, reason: "no_model" } });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "classify_refused:no_model" });
    expect(w.advanceRunOutcome).not.toHaveBeenCalled();
    expect(w.advanceTriage).not.toHaveBeenCalled();
  });
});

describe("the workflow body obeys the Workflow builder's rule", () => {
  it("calls no imported function itself: every I/O helper and every prompt builder is used inside a 'use step' function only", () => {
    // A value import used in the workflow body is bundled into the workflow bundle with its whole graph (node:crypto,
    // node:net, ...) and `next build` refuses. The unit tests cannot see that, so the rule is pinned on the source.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "workItemAdvance.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function workItemAdvanceWorkflow"));
    for (const name of ["getWorker", "getIssueReader", "loadBody", "runOutcomeBody", "startClassifyBody", "triageBody", "categoryOf", "buildClassifyRunPrompt", "decideFromLabels", "panelBody", "specBody", "buildBody", "buildOutcomeBody", "stageBody", "buildFailedBody", "buildExecutorPrompt", "runSpecForItem", "cancelRunBody", "startLightSpecBody", "publishLightSpecBody", "buildLightSpecPrompt", "openInstallationHttp", "reviewLoadBody", "findPrBody", "reviewPlanBody", "startReviewerBody", "reviewerOutcomeBody", "recordRoundBody", "startFixBody", "mergeGateBody", "eventBody", "buildReviewPrompt", "buildFixPrompt", "securityTriggers", "readVerdict"]) {
      expect(body, name).not.toContain(name);
    }
    const imports = [...src.matchAll(/^import (?!type)[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual(["workflow", "../lib/worker", "../lib/github/issueRead", "../lib/github/installationHttp", "../lib/advanceLightSteps", "../lib/advanceSteps", "../lib/advanceStageSteps", "../lib/advanceReviewSteps"]);
  });
});

describe("workItemAdvanceWorkflow: the load refusals end before any spend", () => {
  it.each([
    ["the issue fetch fails", { issue: new Error("issueReader: issue_failed (503)") }, "fetch_failed"],
    ["the issue is gone", { issue: { status: "missing" } as IssueReadResult }, "issue_missing"],
    ["the issue is closed", { issue: issue({ state: "closed" }) }, "issue_closed"],
    ["the item is external", { item: { ...ITEM_OK, provenance: "external" } }, "external_requires_human"],
    ["the item is gone", { item: null }, "not_found"],
    ["the item has no repo", { item: { ...ITEM_OK, repoId: null } }, "no_issue_link"],
    ["the item already moved on", { item: { ...ITEM_OK, stage: "discussing" } }, "not_advanceable"],
  ])("%s -> failed %s", async (_n, o, reason) => {
    const w = setup(o as never);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: reason });
    expect(w.advanceStartRun).not.toHaveBeenCalled();
    expect(w.advanceTriage).not.toHaveBeenCalled();
    expect(events()).toEqual(["advance.failed"]);
    expect(logs[0]).toMatchObject({ at: "load", reason });
  });

  it("no worker configured is a fixed failure, not a throw", async () => {
    setWorkerWiringForTests({ provider: () => null });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "worker_unavailable" });
  });

  it("no log line ever carries the issue's text, a label or a login", async () => {
    setup({ issue: issue({ title: "SECRET-TITLE", body: "SECRET-BODY", labels: [maint("SECRET-LABEL")] }) });
    await workItemAdvanceWorkflow(ARGS);
    expect(JSON.stringify(logs)).not.toMatch(/SECRET|owner-1|maint/);
  });
});
