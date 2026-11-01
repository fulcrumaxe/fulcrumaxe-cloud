import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceFixRequest, AdvanceItem, AdvanceRunOutcome, AdvanceRunRequest, AdvanceStartArgs, Worker } from "@fx/worker";
import type { InstallationHttp } from "@fx/github";

/**
 * D#483 S5-k1d: the reviewers' starts and the fix round's start under a spending limit, through the workflow body over a fake worker and a fake GitHub. The worker's
 * `advanceStartRun` and `advanceStartFix` answer the raw spend denial the real ones do; the web step turns it into the named pause. `sleep` only runs inside a real
 * workflow execution, so it is mocked (it counts the waits and returns at once), as in workItemAdvanceReview.test.ts.
 */
const world = vi.hoisted(() => ({ sleeps: 0 }));
vi.mock("workflow", () => ({
  sleep: vi.fn(async () => {
    world.sleeps += 1;
  }),
}));
vi.mock("workflow/api", () => ({ resumeHook: vi.fn(), start: vi.fn() }));

import { setWorkerWiringForTests } from "../lib/worker";
import { setInstallationHttpForTests } from "../lib/github/installationHttp";
import { setIssueReaderForTests } from "../lib/github/issueRead";
import { workItemAdvanceWorkflow } from "./workItemAdvance";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const ARGS: AdvanceStartArgs = { accountId: ACCOUNT, userId: "55555555-5555-4555-8555-555555555555", workItemId: ITEM, actionId: "44444444-4444-4444-8444-444444444444", haltEpoch: 0 };
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const AT_PR: AdvanceItem = { stage: "pr_opened", provenance: "internal", repoId: REPO, ghNumber: 7, branch: "fx/issue-7", ghOwner: "acme", ghName: "widgets", hasDiscussion: true, kind: "feature", hasSpec: true, specVersion: 3, executorRunId: null, executionMode: "sandbox", recordedPr: null };

const DENIAL = "model_budget_exceeded";
const PAUSE = "account_budget_reached";
const FOUR_HOURS_OF_ASKS = 49; // the first ask, then one every five minutes for four hours

interface Script {
  /** The denial each ask meets: by step (the key), `true` = denied with DENIAL. Absent/false = started. */
  denyStart?: (role: string, step: string, call: number) => string | null;
  denyFix?: (spendAttempt: number | undefined, call: number) => string | null;
  /** The reviewer runs the worker says already started for the head and round. */
  known?: Array<{ role: string; runId: string }>;
  rounds?: Array<{ decision: string; round?: number; nextRound?: number | null }>;
  /** The build step's answer (default: started). */
  build?: () => { status: string; reason?: string; runId?: string; branch?: string };
  /** The head after the fix run. */
  fixPushes?: string;
  /** The item the workflow loads first (Spec ready: the build comes first, then the review on the pull request it opened). */
  item?: AdvanceItem;
}

function setup(script: Script = {}) {
  const started: AdvanceRunRequest[] = [];
  const fixes: AdvanceFixRequest[] = [];
  const asks = new Map<string, number>();
  const runs = new Map<string, string>();
  let head = H1;
  let n = 0;
  let fixCalls = 0;
  const rounds = [...(script.rounds ?? [{ decision: "all_passed", round: 0 }])];
  let loads = 0;
  const worker = {
    // The first read is the workflow's load; later ones are the stage looks after the executor run ended (the pull request is open by then).
    advanceLoadItem: vi.fn(async () => (++loads === 1 ? (script.item ?? AT_PR) : AT_PR)),
    advanceBuild: vi.fn(async (..._args: unknown[]) => script.build?.() ?? { status: "started", runId: "run-b", branch: "fx/issue-7" }),
    advanceLoadReview: vi.fn(async () => ({ ok: true as const, ctx: { workItemId: ITEM, stage: "pr_opened", repoId: REPO, owner: "acme", name: "widgets", issue: 7, branch: "fx/issue-7", tier: "feature", specVersion: 3, debaterEnabled: false, executionMode: "sandbox", recordedPr: null } })),
    advanceLoadSpecText: vi.fn(async (_who: unknown, v: number) => (v === 3 ? { version: 3, body: "SPEC BODY" } : null)),
    advanceReviewRuns: vi.fn(async (_who: unknown, _req: { headSha: string; rereview: number }) => script.known ?? []),
    advanceRecordMergeOnly: vi.fn(async () => ({ decision: "full_review", reason: "no_prior_review" })),
    advanceStartRun: vi.fn(async (req: AdvanceRunRequest) => {
      started.push(req);
      const call = (asks.get(req.role) ?? 0) + 1;
      asks.set(req.role, call);
      const denied = script.denyStart?.(req.role, req.step, call) ?? null;
      if (denied !== null) return { ok: false as const, reason: denied };
      const id = `run-${++n}-${req.role}`;
      runs.set(id, req.role);
      return { ok: true as const, runId: id };
    }),
    advanceRunOutcome: vi.fn(async (_acct: string, runId: string): Promise<AdvanceRunOutcome> => (runId.startsWith("fix-") ? { status: "succeeded", done: true, envelope: { summary: "fixed" } } : { status: "succeeded", done: true, envelope: { verdict: runs.get(runId) === "code-reviewer" && rounds[0]?.decision === "fix" ? "needs-fix" : "pass", findings: [], summary: "x" } })),
    advanceRecordRound: vi.fn(async (_who: unknown, input: { verdicts: Array<{ role: string; runId: string; verdict: string }> }) => {
      const r = rounds.length > 1 ? rounds.shift()! : rounds[0]!;
      return { decision: r.decision, round: r.round ?? 0, ...(r.nextRound !== null ? { nextRound: r.nextRound ?? (r.round ?? 0) + 1 } : {}), recorded: input.verdicts.map((v) => ({ role: v.role, runId: v.runId, verdict: v.verdict, outcome: "passed" })) };
    }),
    advanceFixGate: vi.fn(async (..._args: unknown[]) => ({ proceed: true as const, how: "not_gated", announce: false })),
    advanceStartFix: vi.fn(async (_who: unknown, req: AdvanceFixRequest) => {
      fixes.push(req);
      fixCalls += 1;
      const denied = script.denyFix?.(req.spendAttempt, fixCalls) ?? null;
      if (denied !== null) return { ok: false as const, reason: denied };
      if (script.fixPushes) head = script.fixPushes;
      return { ok: true as const, runId: `fix-${req.round}` };
    }),
    advanceMergeGate: vi.fn(async () => ({ outcome: "merged", reasons: [], status: "posted" })),
    advanceRecordEvent: vi.fn(async (_who: unknown, _e: Record<string, unknown>) => ({ recorded: true })),
    advanceStartGate: vi.fn(async (..._args: unknown[]) => ({ proceed: true as const, how: "person_receipt" })),
    advanceCancel: vi.fn(async () => undefined),
    advanceVerifiedReviewGate: vi.fn(async () => ({ state: "dispatch" })),
    advanceBuildFailed: vi.fn(async () => ({ status: "recorded", stage: "needs_human" })),
    advanceDecision: vi.fn(async () => "none"),
    advancePrFound: vi.fn(async () => ({ status: "recorded", stage: "pr_opened" })),
  };
  setWorkerWiringForTests({ provider: () => ({}) as never, createWorker: async () => worker as unknown as Worker });
  const http: InstallationHttp = {
    async request(req) {
      const base = "/repos/acme/widgets";
      if (req.method === "GET" && req.path === `${base}/pulls`) return { status: 200, body: [{ number: 41, state: "open", head: { sha: head, ref: "fx/issue-7", repo: { full_name: "acme/widgets" } }, base: { ref: "main" } }] };
      if (req.method === "GET" && req.path === `${base}/pulls/41/files`) return { status: 200, body: [{ filename: "src/ui/button.tsx", patch: "@@ -1 +1 @@\n+x", changes: 1 }] };
      return { status: 404, body: { message: "Not Found" } };
    },
  };
  setInstallationHttpForTests(async () => http);
  setIssueReaderForTests(async () => ({ status: "missing" }));
  return { worker, started, fixes };
}
type T = ReturnType<typeof setup>;

let logs: Array<Record<string, unknown>>;
beforeEach(() => {
  world.sleeps = 0;
  logs = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => void logs.push(JSON.parse(String(line))));
});
afterEach(() => {
  vi.restoreAllMocks();
  setWorkerWiringForTests();
  setInstallationHttpForTests();
  setIssueReaderForTests();
});
const events = () => logs.map((l) => l.event);
const recorded = (t: T) => t.worker.advanceRecordEvent.mock.calls.map((c) => c[1] as Record<string, unknown>);
const facts = (t: T, stage: string) => recorded(t).filter((e) => e.kind === "stage_waiting" && e.stage === stage);
const stepsOf = (t: T, role: string) => t.started.filter((r) => r.role === role).map((r) => r.step);
const keyed = (role: string, count: number, rr = "") => Array.from({ length: count }, (_, n) => `review:${H1}:${role}${rr}${n === 0 ? "" : `:s${n}`}`);
const denyAll = () => DENIAL;

describe("S5k1d-3: the reviewers' start with the limit still denied after four hours ends review_paused:<pause>: no failure, nothing stamped", () => {
  it("every reviewer denied: each is asked 49 times with its own keys, the wait leaves a fact on the head each ask, and nothing is recorded or stopped", async () => {
    const t = setup({ denyStart: denyAll });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "paused", detail: `review_paused:${PAUSE}` });
    for (const role of ["code-reviewer", "acceptance-tester"]) expect(stepsOf(t, role)).toEqual(keyed(role, FOUR_HOURS_OF_ASKS));
    expect(world.sleeps).toBe(48);
    expect(facts(t, "review")).toHaveLength(FOUR_HOURS_OF_ASKS);
    expect(facts(t, "review")[0]).toMatchObject({ kind: "stage_waiting", stage: "review", code: PAUSE, attempt: 0, headSha: H1, prNumber: 41, round: 0 });
    expect(facts(t, "review").at(-1)).toMatchObject({ code: PAUSE, attempt: 48, headSha: H1 });
    expect(t.worker.advanceRunOutcome).not.toHaveBeenCalled();
    expect(t.worker.advanceRecordRound).not.toHaveBeenCalled();
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
    expect(events()).toContain("advance.paused");
    expect(events()).not.toContain("advance.failed");
    expect(recorded(t).map((e) => e.kind)).not.toContain("stopped");
  });

  it("every approved pause reason is the answer the end names", async () => {
    for (const [denial, pause] of [["model_budget_exceeded", "account_budget_reached"], ["compute_cap_exceeded", "compute_cap_reached"], ["work_item_cap_exceeded", "item_cap_reached"], ["per_spawn_cap_exceeded", "run_limit_below_estimate"]] as const) {
      world.sleeps = 0;
      setup({ denyStart: () => denial });
      expect(await workItemAdvanceWorkflow(ARGS), denial).toEqual({ status: "paused", detail: `review_paused:${pause}` });
    }
  });

  it("one reviewer started and another stayed denied: the started one is asked once, the denied one for four hours, and the end is the pause (its verdict is not recorded yet)", async () => {
    const t = setup({ denyStart: (role) => (role === "acceptance-tester" ? DENIAL : null) });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "paused", detail: `review_paused:${PAUSE}` });
    expect(stepsOf(t, "code-reviewer")).toEqual([`review:${H1}:code-reviewer`]);
    expect(stepsOf(t, "acceptance-tester")).toEqual(keyed("acceptance-tester", FOUR_HOURS_OF_ASKS));
    expect(t.worker.advanceRecordRound).not.toHaveBeenCalled();
    expect(t.worker.advanceCancel).not.toHaveBeenCalled(); // a run in flight is never stopped
  });
});

describe("S5k1d-2: clearing the denial lets the next ask start the run at a fresh key", () => {
  it("denied three times, then allowed: the reviewer starts at :s3 and the review goes on to merge; the denied keys were not asked again", async () => {
    const t = setup({ denyStart: (_role, _step, call) => (call <= 3 ? DENIAL : null) });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged", detail: undefined });
    for (const role of ["code-reviewer", "acceptance-tester"]) expect(stepsOf(t, role)).toEqual(keyed(role, 4));
    expect(world.sleeps).toBe(3);
    expect(t.worker.advanceRecordRound).toHaveBeenCalledTimes(1);
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].verdicts.map((v) => v.verdict)).toEqual(["pass", "pass"]);
  });

  it("only the denied reviewer is asked again; the one that started is not started a second time", async () => {
    const t = setup({ denyStart: (role, _step, call) => (role === "acceptance-tester" && call <= 2 ? DENIAL : null) });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged", detail: undefined });
    expect(stepsOf(t, "code-reviewer")).toEqual([`review:${H1}:code-reviewer`]);
    expect(stepsOf(t, "acceptance-tester")).toEqual(keyed("acceptance-tester", 3));
    const input = t.worker.advanceRecordRound.mock.calls[0]![1];
    expect(input.verdicts.map((v) => v.role).sort()).toEqual(["acceptance-tester", "code-reviewer"]);
  });

  it("a re-review round has its own keys: while attempt 2 is pending the round-1 ask is `:rr1` and does not take the attempt's number", async () => {
    const t = setup({ denyStart: (_role, _step, call) => (call <= 2 ? DENIAL : null) });
    expect(await workItemAdvanceWorkflow({ ...ARGS, startRereview: 1 })).toEqual({ status: "merged", detail: undefined });
    expect(stepsOf(t, "code-reviewer")).toEqual([`review:${H1}:code-reviewer:rr1`, `review:${H1}:code-reviewer:rr1:s1`, `review:${H1}:code-reviewer:rr1:s2`]);
    expect(t.worker.advanceReviewRuns.mock.calls[0]![1]).toEqual({ headSha: H1, rereview: 1 });
  });
});

describe("a restart by the sweep", () => {
  it("begins at the attempt it is given, uses the reviewer runs that already started, and asks only for the roles that have none", async () => {
    const t = setup({ known: [{ role: "code-reviewer", runId: "run-old-code" }] });
    expect(await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 5 })).toEqual({ status: "merged", detail: undefined });
    expect(stepsOf(t, "code-reviewer")).toEqual([]);
    expect(stepsOf(t, "acceptance-tester")).toEqual([`review:${H1}:acceptance-tester:s5`]);
    // The known run is waited for like any other: its verdict is gathered.
    expect(t.worker.advanceRunOutcome.mock.calls.map((c) => c[1])).toContain("run-old-code");
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].verdicts.map((v) => v.role).sort()).toEqual(["acceptance-tester", "code-reviewer"]);
  });

  it("still denied: the wait goes on from its own attempt number, not from zero", async () => {
    const t = setup({ denyStart: (_role, _step, call) => (call <= 1 ? DENIAL : null) });
    expect(await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 7 })).toEqual({ status: "merged", detail: undefined });
    expect(stepsOf(t, "code-reviewer")).toEqual([`review:${H1}:code-reviewer:s7`, `review:${H1}:code-reviewer:s8`]);
    expect(facts(t, "review")[0]).toMatchObject({ attempt: 7 });
  });
});

describe("the build's restart attempt is not the reviewers'", () => {
  it("a build restarted by the sweep at attempt 6 asks its reviewers from their own first attempt: the bare keys, not `:s6`", async () => {
    const t = setup({ item: { ...AT_PR, stage: "spec_ready" } });
    expect(await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 6, startRereview: 2 })).toEqual({ status: "merged", detail: undefined });
    expect(t.worker.advanceBuild.mock.calls[0]![3]).toBe(6);
    expect(stepsOf(t, "code-reviewer")).toEqual([`review:${H1}:code-reviewer`]);
    expect(stepsOf(t, "acceptance-tester")).toEqual([`review:${H1}:acceptance-tester`]);
  });
});

describe("S5k1d-6: a refusal that is not a pause ends as it ends today", () => {
  it("a reviewer that cannot start for another reason is not waited for: no sleep, no fact, and the round stops with the reviewer not started", async () => {
    const t = setup({ denyStart: (role) => (role === "acceptance-tester" ? "no_model" : null), rounds: [{ decision: "incomplete" }] });
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "needs_human", detail: "reviewer_not_started:acceptance-tester" });
    expect(world.sleeps).toBe(0);
    expect(facts(t, "review")).toEqual([]);
    expect(recorded(t).find((e) => e.kind === "stopped")).toMatchObject({ code: "not_started_no_model" });
  });

  it("a halted item is a halt, not a pause", async () => {
    const t = setup({ denyStart: () => "item_halted", rounds: [{ decision: "incomplete" }] });
    await workItemAdvanceWorkflow(ARGS);
    expect(world.sleeps).toBe(0);
    expect(facts(t, "review")).toEqual([]);
  });
});

describe("the fix round's start", () => {
  const fixRound = { rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "all_passed", round: 1 }], fixPushes: H2 };

  it("S5k1d-3: still denied after four hours it ends fix_round_paused:<pause>: no failure, no refusal fact, and a wait fact on the head each ask", async () => {
    const t = setup({ ...fixRound, denyFix: () => DENIAL });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "paused", detail: `fix_round_paused:${PAUSE}` });
    expect(t.fixes).toHaveLength(FOUR_HOURS_OF_ASKS);
    expect(t.fixes.map((f) => f.spendAttempt)).toEqual([undefined, ...Array.from({ length: 48 }, (_, n) => n + 1)]);
    expect(world.sleeps).toBe(48);
    expect(facts(t, "fix_round")).toHaveLength(FOUR_HOURS_OF_ASKS);
    expect(facts(t, "fix_round")[0]).toMatchObject({ stage: "fix_round", code: PAUSE, attempt: 0, headSha: H1, prNumber: 41, round: 0 });
    expect(events()).toContain("advance.paused");
    expect(events()).not.toContain("advance.stopped");
    expect(recorded(t).map((e) => e.kind)).not.toContain("stopped");
    // The reviewers' verdicts were recorded before the fix was asked for: the restart finds them by their keys.
    expect(t.worker.advanceRecordRound).toHaveBeenCalledTimes(1);
  });

  it("S5k1d-2: cleared on the third ask, the fix starts at attempt 2 and the review goes on to the new head and merges", async () => {
    const t = setup({ ...fixRound, denyFix: (_a, call) => (call <= 2 ? DENIAL : null) });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged", detail: undefined });
    expect(t.fixes.map((f) => f.spendAttempt)).toEqual([undefined, 1, 2]);
    expect(world.sleeps).toBe(2);
    expect(t.fixes[2]).toMatchObject({ headSha: H1, round: 1, actionId: ARGS.actionId });
    expect(t.started.some((r) => r.headSha === H2)).toBe(true);
  });

  it("a restart by the sweep asks from its attempt, and the re-review retry and the attempt are separate fields", async () => {
    const t = setup({ ...fixRound });
    expect(await workItemAdvanceWorkflow({ ...ARGS, startAttempt: 4, startRereview: 1 })).toEqual({ status: "merged", detail: undefined });
    expect(t.fixes[0]).toMatchObject({ spendAttempt: 4, retry: 1 });
  });

  it("S5k1d-6: a refusal that is not a pause ends as it ends today: fix_refused with its own code, no wait", async () => {
    const t = setup({ ...fixRound, denyFix: () => "already_running" });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "fix_refused", detail: "already_running" });
    expect(world.sleeps).toBe(0);
    expect(facts(t, "fix_round")).toEqual([]);
    expect(t.fixes).toHaveLength(1);
  });

  it("the first ask carries no attempt number, so the call is exactly what it was before", async () => {
    const t = setup({ ...fixRound });
    await workItemAdvanceWorkflow(ARGS);
    expect(t.fixes[0]).not.toHaveProperty("spendAttempt");
  });
});

describe("C23-3: a start answering waiting_for_capacity waits by the minute, keeps its attempt and ends <stage>_paused:waiting_for_capacity", () => {
  const CAP = "waiting_for_capacity";
  const CAP_ASKS = 241;

  it("reviewers: every one asked 241 times at its bare key, a fresh fact on the head each ask, nothing recorded", async () => {
    const t = setup({ denyStart: () => CAP });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "paused", detail: `review_paused:${CAP}` });
    for (const role of ["code-reviewer", "acceptance-tester"]) expect(stepsOf(t, role)).toEqual(Array.from({ length: CAP_ASKS }, () => `review:${H1}:${role}`));
    expect(world.sleeps).toBe(240);
    expect(facts(t, "review")).toHaveLength(CAP_ASKS);
    expect(facts(t, "review").every((e) => e.code === CAP && e.attempt === 0 && e.headSha === H1)).toBe(true);
    expect(new Set(facts(t, "review").map((e) => e.dedupeKey)).size).toBe(CAP_ASKS);
    expect(t.worker.advanceRecordRound).not.toHaveBeenCalled();
    expect(events()).not.toContain("advance.failed");
    expect(recorded(t).map((e) => e.kind).filter((k) => k !== "stage_waiting")).toEqual([]);
  });

  it("the fix round: 241 asks with no attempt number, a fresh fact each, no refusal fact", async () => {
    const t = setup({ rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "all_passed", round: 1 }], fixPushes: H2, denyFix: () => CAP });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "paused", detail: `fix_round_paused:${CAP}` });
    expect(t.fixes).toHaveLength(CAP_ASKS);
    expect(t.fixes.every((f) => f.spendAttempt === undefined)).toBe(true);
    expect(world.sleeps).toBe(240);
    expect(facts(t, "fix_round")).toHaveLength(CAP_ASKS);
    expect(new Set(facts(t, "fix_round").map((e) => e.dedupeKey)).size).toBe(CAP_ASKS);
    expect(recorded(t).map((e) => e.kind)).not.toContain("stopped");
    expect(events()).not.toContain("advance.failed");
  });

  it("the build: asked again every minute at the same attempt, ends build_paused:waiting_for_capacity, no failure and no build_refused", async () => {
    const t = setup({ item: { ...AT_PR, stage: "spec_ready" }, build: () => ({ status: "refused", reason: CAP }) });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "paused", detail: `build_paused:${CAP}` });
    expect(t.worker.advanceBuild).toHaveBeenCalledTimes(CAP_ASKS);
    expect(new Set(t.worker.advanceBuild.mock.calls.map((c) => c[6]))).toEqual(new Set([undefined]));
    expect(world.sleeps).toBe(240);
    expect(events()).toContain("advance.paused");
    expect(events()).not.toContain("advance.failed");
  });
});
