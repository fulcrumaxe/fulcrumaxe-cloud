import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceFixRequest, AdvanceItem, AdvanceRoundInput, AdvanceRunOutcome, AdvanceRunRequest, AdvanceStartArgs, DecisionStepCode, Worker } from "@fx/worker";
import type { InstallationHttp, InstallationHttpRequest } from "@fx/github";
import { decideRound, maxFixRounds, reviewStep } from "@fx/pipeline";

/**
 * D#483 P3: the advance workflow's review phase over a fake worker and a fake GitHub that answers like the real one
 * (the pulls list filtered by head, the files list paged at 100). `sleep` only runs inside a real workflow execution, so
 * it is mocked: it counts the waits and returns at once.
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
const WHO = { accountId: ACCOUNT, userId: ARGS.userId, workItemId: ITEM, haltEpoch: 0 };
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const H3 = "c".repeat(40);
const AT_PR: AdvanceItem = { stage: "pr_opened", provenance: "internal", repoId: REPO, ghNumber: 7, ghOwner: "acme", ghName: "widgets", hasDiscussion: true, kind: "feature", hasSpec: true, specVersion: 3, executorRunId: null, executionMode: "sandbox", recordedPr: null };

interface PrFile {
  filename: string;
  patch?: string;
  changes?: number;
}

interface World {
  /** The head GitHub reports for the PR now; `heads` is consumed one per read after the first. */
  head: string;
  /** Files of the pull request. */
  files: PrFile[];
  /** The pull request lookups that answer nothing. */
  noPr?: boolean;
  /** What the worker's run listing reports as STORED no-verdict ends, per role (the re-run bound's count; absent: none). */
  storedNoVerdict?: Record<string, number>;
  /** GitHub answers the pull request lookup with a server error. */
  githubDown?: boolean;
  tier: string;
  debaterEnabled: boolean;
  /** (role) -> the verdict the reviewer run ends with. A function of the head the run is for. */
  verdict: (role: string, head: string, step: string) => { status?: string; envelope?: Record<string, unknown> | null; done?: boolean; failureReason?: string };
  /** The decision the worker's round returns, per call. */
  rounds: Array<{ decision: string; round?: number; nextRound?: number | null }>;
  /** The fix start. */
  fix: { ok: boolean; reason?: string };
  /** What the fix run does to the head when it ends. */
  fixPushes: string | null;
  fixOutcome: AdvanceRunOutcome;
  gates: Array<{ outcome: string; reasons?: string[]; status?: string }>;
  /** D#6 PUBLIC-MERGE PR2b: where the item's merge order stands at each look (the last one repeats). Absent: no order. */
  orders?: Array<{ state: string; code: string | null; gateRecorded?: boolean }>;
  refuseStart: Set<string>;
  /** The worker's reason for a refused reviewer start; "no_model" when absent. */
  refuseReason?: string;
  pinned: number;
  loadReview: { ok: boolean; reason?: string; specVersion?: number };
  /** `runner_local`: the repository's agents run on a runner; `recorded` is what its run's `done` recorded (null: nothing). */
  mode?: "runner_local" | "runner_verified" | "sandbox";
  recorded?: { number: number; branch: string } | null;
  /** D#598 P7c: the worker's answer to "is this head only a merge of the base branch?", per call (the last one repeats). Default: a full review. */
  mergeOnly?: Array<{ decision: string; reason?: string }>;
  /** D#6 R5b-2a: the worker's answer to "may the reviewers start?", per call (1-based). It may change the world (a push, a mode change) as the real check's wait would. */
  /** What the decision step answers after a succeeded fix round (D#7 DP4b-2); `none` when absent. */
  decision?: DecisionStepCode;
  verifiedGate?: (call: number, input: { prNumber: number; headSha: string; seenHead: string | null }) => { state: string; waitMs?: number; executionMode?: string; reason?: string };
  /** The worker lists the reviewer runs of a head as the real one does (newest per role, the highest attempt per role); absent: it has no listing. */
  listRuns?: boolean;
  /** The round is decided by the real rule (decideRound), not scripted. */
  realDecide?: boolean;
  /** A person's Request changes waits for its fix round (the review load says so), and the fix rounds already started. */
  personRequest?: boolean;
  fixRoundsStarted?: number;
}

function fresh(over: Partial<World> = {}): World {
  return {
    head: H1,
    files: [{ filename: "src/ui/button.tsx", patch: "@@ -1 +1 @@\n+export const x = 1;", changes: 1 }],
    tier: "feature",
    debaterEnabled: false,
    verdict: () => ({ status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "fine" } }),
    rounds: [{ decision: "all_passed", round: 0 }],
    fix: { ok: true },
    fixPushes: H2,
    fixOutcome: { status: "succeeded", done: true, envelope: { summary: "fixed" } },
    gates: [{ outcome: "merged", reasons: [], status: "posted" }],
    refuseStart: new Set(),
    pinned: 3,
    loadReview: { ok: true },
    ...over,
  };
}

function setup(w: World, item: AdvanceItem = AT_PR) {
  const runs = new Map<string, { role: string; head: string; step: string }>();
  const started: AdvanceRunRequest[] = [];
  const keyed: Array<{ step: string; runId: string }> = [];
  const rounds = [...w.rounds];
  const gates = [...w.gates];
  const orders = [...(w.orders ?? [{ state: "none", code: null }])];
  let n = 0;
  let gateCalls = 0;
  const worker = {
    advanceLoadItem: vi.fn(async () => item),
    advanceLoadReview: vi.fn(async () =>
      w.loadReview.ok
        ? { ok: true as const, ctx: { workItemId: ITEM, stage: "pr_opened", repoId: REPO, owner: "acme", name: "widgets", issue: 7, tier: w.tier, specVersion: w.loadReview.specVersion ?? w.pinned, debaterEnabled: w.debaterEnabled, executionMode: w.mode ?? "sandbox", recordedPr: w.recorded ?? null, fixRoundsStarted: w.fixRoundsStarted ?? 0, ...(w.personRequest ? { personRequestPending: true } : {}) } }
        : { ok: false as const, reason: w.loadReview.reason ?? "no_spec" },
    ),
    advanceLoadSpecText: vi.fn(async (_who: unknown, v: number) => (v === w.pinned ? { version: v, body: "SPEC BODY: the footer shows the year." } : null)),
    advanceStartRun: vi.fn(async (req: AdvanceRunRequest) => {
      started.push(req);
      if (w.refuseStart.has(req.role)) return { ok: false as const, reason: w.refuseReason ?? "no_model" };
      const id = `run-${++n}-${req.role}`;
      runs.set(id, { role: req.role, head: req.headSha ?? "", step: req.step });
      keyed.push({ step: req.step, runId: id });
      return { ok: true as const, runId: id };
    }),
    advanceRunOutcome: vi.fn(async (_acct: string, runId: string): Promise<AdvanceRunOutcome> => {
      if (runId.startsWith("fix-")) return w.fixOutcome;
      const r = runs.get(runId);
      if (!r) return { status: "missing", done: true, envelope: null };
      const v = w.verdict(r.role, r.head, r.step);
      return { status: v.status ?? "succeeded", done: v.done ?? true, envelope: v.envelope === undefined ? { verdict: "pass", findings: [], summary: "fine" } : v.envelope, ...(v.failureReason ? { failureReason: v.failureReason } : {}) };
    }),
    advanceRecordRound: vi.fn(async (_who: unknown, input: Omit<AdvanceRoundInput, "accountId" | "workItemId">) => {
      const r = w.realDecide ? { decision: decideRound({ requiredRoles: input.requiredRoles as never, verdicts: input.verdicts as never, fixRoundsStarted: 0 }) as string } : rounds.length > 1 ? rounds.shift()! : rounds[0]!;
      return { decision: r.decision, round: r.round ?? 0, ...(r.nextRound !== null ? { nextRound: r.nextRound ?? (r.round ?? 0) + 1 } : {}), recorded: input.verdicts.map((v) => ({ role: v.role, runId: v.runId, verdict: v.verdict, outcome: "passed" })) };
    }),
    advanceRecordMergeOnly: vi.fn(async (_who: unknown, _input: { headSha: string; prNumber: number; baseRef: string; requiredRoles: string[] }) => {
      const list = w.mergeOnly ?? [{ decision: "full_review", reason: "no_prior_review" }];
      return list.length > 1 ? list.shift()! : list[0]!;
    }),
    advanceStartFix: vi.fn(async (_who: unknown, req: AdvanceFixRequest) => {
      if (!w.fix.ok) return { ok: false as const, reason: w.fix.reason ?? "already_running" };
      if (w.fixPushes) w.head = w.fixPushes;
      return { ok: true as const, runId: `fix-${req.round}` };
    }),
    advanceMergeGate: vi.fn(async () => (gates.length > 1 ? gates.shift()! : gates[0]!)),
    advanceMergeOrder: vi.fn(async () => (orders.length > 1 ? orders.shift()! : orders[0]!)),
    advanceRecordEvent: vi.fn(async (_who: unknown, _e: { kind: string; code?: string; reasons?: string[]; headSha?: string; prNumber?: number; runId?: string }) => ({ recorded: true })),
    advanceStartGate: vi.fn(async (..._args: unknown[]) => ({ proceed: true as const, how: "person_receipt" })),
    advanceCancel: vi.fn(async () => undefined),
    advanceVerifiedReviewGate: vi.fn(async (_who: unknown, input: { prNumber: number; headSha: string; seenHead: string | null }) => (w.verifiedGate ? w.verifiedGate(++gateCalls, input) : { state: "dispatch" })),
    advanceBuild: vi.fn(),
    advanceBuildFailed: vi.fn(async () => ({ status: "recorded", stage: "needs_human" })),
    advanceDecision: vi.fn(async (): Promise<DecisionStepCode> => w.decision ?? "none"),
    advancePrFound: vi.fn(async () => ({ status: "recorded", stage: "pr_opened" })),
    ...(w.listRuns
      ? {
          advanceReviewRuns: vi.fn(async (_who: unknown, req: { headSha: string; rereview: number }) => {
            const newest = new Map<string, { role: string; runId: string; attempt: number; noVerdictEnds: number }>();
            for (const k of [...keyed].reverse()) {
              const m = /^review:([0-9a-f]{40}):([a-z-]+)(?::rr(\d+))?(?::s(\d+))?$/.exec(k.step);
              if (!m || m[1] !== req.headSha || Number(m[3] ?? 0) !== req.rereview) continue;
              const prev = newest.get(m[2]!);
              newest.set(m[2]!, { role: m[2]!, runId: prev?.runId ?? k.runId, attempt: Math.max(prev?.attempt ?? 0, Number(m[4] ?? 0)), noVerdictEnds: w.storedNoVerdict?.[m[2]!] ?? 0 });
            }
            return [...newest.values()];
          }),
        }
      : {}),
  };
  setWorkerWiringForTests({ provider: () => ({}) as never, createWorker: async () => worker as unknown as Worker });

  const requests: InstallationHttpRequest[] = [];
  const http: InstallationHttp = {
    async request(req) {
      requests.push(req);
      const base = `/repos/acme/widgets`;
      if (req.method === "GET" && req.path === `${base}/pulls`) {
        if (w.githubDown) return { status: 502, body: { message: "Bad Gateway" } };
        if (w.noPr) return { status: 200, body: [] };
        // The branch asked for: `fx/issue-7` for a sandbox build, the recorded run branch for a runner run (the list call, A3).
        const asked = String(req.query?.head ?? "acme:fx/issue-7").split(":")[1]!;
        return { status: 200, body: [{ number: 41, state: "open", head: { sha: w.head, ref: asked, repo: { full_name: "acme/widgets" } }, base: { ref: "main" } }] };
      }
      // A runner repo's changed files come from the fixed PullRequestFiles document: paths and change types, never a patch.
      if (req.method === "POST" && req.path === "/graphql") {
        const nodes = w.files.map((f) => ({ path: f.filename, changeType: "MODIFIED" }));
        return { status: 200, body: { data: { repository: { pullRequest: { files: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } } };
      }
      // A runner run's pull request is read by its recorded number; its head is the recorded run branch.
      if (req.method === "GET" && req.path === `${base}/pulls/41`) {
        if (w.githubDown) return { status: 502, body: { message: "Bad Gateway" } };
        if (w.noPr) return { status: 404, body: { message: "Not Found" } };
        return { status: 200, body: { number: 41, state: "open", head: { sha: w.head, ref: w.recorded?.branch ?? "fx/issue-7", repo: { full_name: "acme/widgets" } }, base: { ref: "main" } } };
      }
      if (req.method === "GET" && req.path === `${base}/pulls/41/files`) {
        const per = Number(req.query?.per_page ?? 30);
        const page = Number(req.query?.page ?? 1);
        return { status: 200, body: w.files.slice((page - 1) * per, page * per) };
      }
      return { status: 404, body: { message: "Not Found" } };
    },
  };
  setInstallationHttpForTests(async () => http);
  // The review reads no issue; a reader is set only so the load step does not build the production one.
  setIssueReaderForTests(async () => ({ status: "missing" }));
  return { worker, started, requests };
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
  setInstallationHttpForTests();
  setIssueReaderForTests();
});
const events = () => logs.map((l) => l.event);
const rolesOf = (started: AdvanceRunRequest[]) => started.map((s) => s.role);

describe("reviews on the pull request's exact head", () => {
  it("starts code review and acceptance test on the head, each keyed by head and role, with the Spec in the prompt and the envelope last", async () => {
    const w = fresh();
    const t = setup(w);
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "merged", detail: undefined });
    expect(rolesOf(t.started).sort()).toEqual(["acceptance-tester", "code-reviewer"]);
    for (const req of t.started) {
      expect(req.step).toBe(`review:${H1}:${req.role}`);
      expect(req.headSha).toBe(H1);
      expect(req.clone).toBe(true);
      expect(req.prompt).toContain("SPEC BODY: the footer shows the year.");
      expect(req.prompt).toContain(`review exactly commit ${H1}`);
      expect(req.prompt.trimEnd().endsWith("<!-- /AGENT_OUTPUT -->")).toBe(true);
    }
    // Every verdict of the head went to the worker in ONE record call.
    expect(t.worker.advanceRecordRound).toHaveBeenCalledTimes(1);
    const input = t.worker.advanceRecordRound.mock.calls[0]![1];
    expect(input.headSha).toBe(H1);
    expect(input.prNumber).toBe(41);
    expect(input.requiredRoles.sort()).toEqual(["acceptance-tester", "code-reviewer"]);
    expect(input.verdicts.map((v) => v.verdict)).toEqual(["pass", "pass"]);
    expect(t.worker.advanceMergeGate).toHaveBeenCalledWith(WHO, 41);
    expect(events()).toContain("advance.reviewed");
  });

  it("finds the open pull request for fx/issue-<n> by head and reads its files, with a read-only client", async () => {
    const t = setup(fresh());
    await workItemAdvanceWorkflow(ARGS);
    const list = t.requests.find((r) => r.path === "/repos/acme/widgets/pulls")!;
    expect(list.query).toMatchObject({ state: "open", head: "acme:fx/issue-7" });
    expect(t.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("a replay or a second press reuses the reviewer runs: the same keys are asked for again, never new ones", async () => {
    const t = setup(fresh());
    await workItemAdvanceWorkflow(ARGS);
    const first = t.started.map((s) => s.step);
    await workItemAdvanceWorkflow(ARGS);
    expect(t.started.slice(first.length).map((s) => s.step)).toEqual(first);
  });

  // D#599 PL-2 (AC4): a reviewer run queued on a side the item has left ends cancelled placement_changed; the same review step starts again and its verdict comes from the new run.
  it("a reviewer run cancelled because its item moved to the other side is started again (same step), and the verdict is the new run's", async () => {
    let t: ReturnType<typeof setup> | null = null;
    const w = fresh({
      verdict: (role) =>
        role === "code-reviewer" && t!.started.filter((r) => r.role === "code-reviewer").length < 2
          ? { status: "cancelled", envelope: null, failureReason: "placement_changed" }
          : { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "fine" } },
    });
    t = setup(w);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged", detail: undefined });
    const code = t.started.filter((r) => r.role === "code-reviewer");
    expect(code).toHaveLength(2);
    expect(code[1]!.step).toBe(code[0]!.step);
    expect(events()).toContain("advance.review_restarted");
    expect(t.started.filter((r) => r.role === "acceptance-tester")).toHaveLength(1);
  });

  it("waits durably for a reviewer that is still going", async () => {
    let polls = 0;
    const w = fresh({ verdict: (role) => (role === "code-reviewer" && polls++ < 3 ? { status: "running", done: false, envelope: null } : { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "" } }) });
    setup(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(world.sleeps).toBe(3);
  });

  it("a reviewer that never ends is cancelled after 45 minutes and has no verdict: never a pass, and never a reviewer_fail either", async () => {
    const w = fresh({ verdict: (role) => (role === "code-reviewer" ? { status: "running", done: false, envelope: null } : { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "" } }), realDecide: true });
    const t = setup(w);
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(world.sleeps).toBe(90);
    expect(t.worker.advanceCancel).toHaveBeenCalledWith(WHO, expect.stringContaining("code-reviewer"));
    const input = t.worker.advanceRecordRound.mock.calls[0]![1];
    expect(input.verdicts.find((v) => v.role === "code-reviewer")).toMatchObject({ verdict: "fail", noVerdict: true, endCode: "wait_timeout" });
    // This worker lists no runs, so no safe re-run key is known: the round goes straight to a person.
    expect(out).toEqual({ status: "needs_human", detail: "reviewer_no_verdict" });
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
  });

  // D#598 P7d: a reviewer that could not run the tests says so with the JSON boolean true; the item stops for a person, no fix round starts.
  it("a reviewer that could not run the tests is sent as an environment failure, and the item stops with no fix round and no merge", async () => {
    const w = fresh({
      verdict: (role) => ({ status: "succeeded", envelope: { verdict: role === "acceptance-tester" ? "fail" : "needs-fix", findings: [], summary: "pnpm: command not found", ...(role === "acceptance-tester" ? { environment_failure: true } : {}) } }),
      rounds: [{ decision: "environment_failure" }],
    });
    const t = setup(w);
    const out = await workItemAdvanceWorkflow(ARGS);
    const byRole = Object.fromEntries(t.worker.advanceRecordRound.mock.calls[0]![1].verdicts.map((v) => [v.role, v.environmentFailure]));
    expect(byRole).toEqual({ "code-reviewer": undefined, "acceptance-tester": true });
    expect(out).toEqual({ status: "needs_human", detail: "reviewer_environment" });
    expect(t.worker.advanceStartFix).not.toHaveBeenCalled();
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
  });

  // A reviewer that could not verify criteria where it ran says so with its own verdict word and a list: the item stops for a person, no fix round starts.
  const UNVERIFIABLE_LIST = [{ criterion: "AC4: the sandbox check refuses a missing binary", reason: "nested bwrap cannot create namespaces here, so the test is skipped" }];
  it("a reviewer that could not verify criteria is sent as unverifiable, and the item stops for a person with NO fix round and no merge", async () => {
    const w = fresh({
      verdict: (role) => (role === "acceptance-tester" ? { status: "succeeded", envelope: { verdict: "unverifiable", findings: [], summary: "4 of 5 verified", unverifiable: UNVERIFIABLE_LIST } } : { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "" } }),
      rounds: [{ decision: "unverifiable" }],
    });
    const t = setup(w);
    const out = await workItemAdvanceWorkflow(ARGS);
    const sent = t.worker.advanceRecordRound.mock.calls[0]![1].verdicts;
    expect(sent.find((v) => v.role === "acceptance-tester")).toMatchObject({ verdict: "fail", unverifiable: true });
    expect(sent.find((v) => v.role === "code-reviewer")!.unverifiable).toBeUndefined();
    expect(out).toEqual({ status: "needs_human", detail: "reviewer_unverifiable" });
    expect(t.worker.advanceStartFix).not.toHaveBeenCalled();
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
  });

  it("an unverifiable acceptance tester beside a needs-fix: the fix round goes ahead and carries only the reviewer that asked for changes", async () => {
    const w = fresh({
      verdict: (role) => (role === "acceptance-tester" ? { status: "succeeded", envelope: { verdict: "unverifiable", findings: [], summary: "", unverifiable: UNVERIFIABLE_LIST } } : { status: "succeeded", envelope: { verdict: "needs-fix", findings: ["a.ts:1 - wrong"], summary: "" } }),
      rounds: [{ decision: "fix", nextRound: 1 }],
    });
    const t = setup(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceStartFix).toHaveBeenCalled();
    const req = t.worker.advanceStartFix.mock.calls[0]![1];
    expect(req.failingRunId).toMatch(/code-reviewer/);
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].verdicts.find((v) => v.role === "acceptance-tester")).toMatchObject({ unverifiable: true });
  });

  it.each([["the word without a list", { verdict: "unverifiable", findings: [], summary: "" }], ["a list under another word", { verdict: "needs-fix", findings: [], summary: "", unverifiable: UNVERIFIABLE_LIST }], ["a wrong-case word", { verdict: "Unverifiable", unverifiable: UNVERIFIABLE_LIST }]])("%s is not sent as unverifiable", async (_n, envelope) => {
    const w = fresh({ verdict: () => ({ status: "succeeded", envelope }), rounds: [{ decision: "reviewer_fail" }] });
    const t = setup(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].verdicts.every((v) => v.unverifiable === undefined)).toBe(true);
  });

  it.each(["true", 1, "yes", { a: 1 }])("an environment_failure that is not the JSON boolean true (%j) is not sent", async (flag) => {
    const w = fresh({ verdict: () => ({ status: "succeeded", envelope: { verdict: "fail", findings: [], summary: "", environment_failure: flag } }), rounds: [{ decision: "reviewer_fail" }] });
    const t = setup(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].verdicts.every((v) => v.environmentFailure === undefined)).toBe(true);
  });
});

describe("D#6 R5b-2a: a cloud-verified pull request is reviewed after its quiet period, on the customer's key", () => {
  const RUN_BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
  const recorded = { number: 41, branch: RUN_BRANCH };
  const verified = (over: Partial<World> = {}) => fresh({ mode: "runner_verified", recorded, ...over });

  it("waits out the quiet period, reads the head again, and reviews the head it finds then, in the sandbox's prompt (not the runner's)", async () => {
    const asked: Array<{ headSha: string; seenHead: string | null }> = [];
    const w = verified({
      verifiedGate: (call, input) => {
        asked.push({ headSha: input.headSha, seenHead: input.seenHead });
        if (call === 1) return { state: "wait", waitMs: 600_000 };
        if (call === 2) {
          // A person pushed while the driver slept: the next read finds a new head, and the period starts over.
          w.head = H2;
          return { state: "wait", waitMs: 600_000 };
        }
        return { state: "dispatch" };
      },
    });
    const t = setup(w);
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "merged", detail: undefined });
    expect(world.sleeps).toBe(2);
    // The check sees the head it read and the one it saw before; the third check is for the new head, and the reviewers start on it.
    expect(asked).toEqual([{ headSha: H1, seenHead: null }, { headSha: H1, seenHead: H1 }, { headSha: H2, seenHead: H1 }]);
    expect(t.started.length).toBeGreaterThan(0);
    for (const req of t.started) {
      expect(req.headSha).toBe(H2);
      expect(req.step).toBe(`review:${H2}:${req.role}`);
      expect(req.expectedExecutionMode).toBe("runner_verified");
      expect(req.prompt).not.toContain("detached HEAD");
    }
    expect(t.worker.advanceMergeGate).toHaveBeenCalledWith(WHO, 41);
  });

  it("no usable key: nothing is started, the gate records review_key_missing against the head, and the merge gate is never asked", async () => {
    const t = setup(verified({ verifiedGate: () => ({ state: "key_missing" }) }));
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "needs_human", detail: "review_key_missing" });
    expect(t.started).toEqual([]);
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "review_key_missing", headSha: H1, prNumber: 41 }));
  });

  it.each([["round_cap", "review_round_cap"], ["compute_cap", "review_compute_cap"]] as const)("%s: nothing is started, the gate outcome is ready_human_merges with %s, and the merge gate is never asked", async (state, code) => {
    const t = setup(verified({ verifiedGate: () => ({ state }) }));
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "ready_human_merges", detail: code });
    expect(t.started).toEqual([]);
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "merge_gate", code: "ready_human_merges", reasons: [code], headSha: H1, prNumber: 41 }));
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code, headSha: H1, prNumber: 41 }));
  });

  it("a repository that left the mode during the wait is reviewed the way its new mode is: the context is loaded again and the runner's reviewers are started", async () => {
    const w = verified({
      verifiedGate: (call) => {
        if (call === 1) return { state: "wait", waitMs: 60_000 };
        w.mode = "runner_local";
        return { state: "not_verified", executionMode: "runner_local" };
      },
    });
    const t = setup(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceLoadReview).toHaveBeenCalledTimes(2);
    expect(t.worker.advanceVerifiedReviewGate).toHaveBeenCalledTimes(2);
    expect(t.started.length).toBeGreaterThan(0);
    for (const req of t.started) {
      expect(req.expectedExecutionMode).toBe("runner_local");
      expect(req.prompt).toContain("detached HEAD");
    }
  });

  it.each(["sandbox", "runner_local"] as const)("a %s repository is never asked: it is reviewed at once, as before", async (mode) => {
    const t = setup(fresh({ mode, recorded: mode === "runner_local" ? recorded : null, verifiedGate: () => ({ state: "wait", waitMs: 600_000 }) }));
    await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceVerifiedReviewGate).not.toHaveBeenCalled();
    expect(world.sleeps).toBe(0);
    expect(t.started.length).toBeGreaterThan(0);
  });

  it("pushes that never stop end the wait after a bound, with one recorded stop and no review", async () => {
    const t = setup(verified({ verifiedGate: () => ({ state: "wait", waitMs: 600_000 }) }));
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "needs_human", detail: "review_quiet_period_unsettled" });
    expect(world.sleeps).toBe(36);
    expect(t.started).toEqual([]);
  });

  it("a halt during the wait ends the workflow with the one halted stop; any other refusal is recorded with its fixed reason", async () => {
    const halted = setup(verified({ verifiedGate: () => ({ state: "refused", reason: "item_halted" }) }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "halted" });
    expect(halted.started).toEqual([]);

    const other = setup(verified({ verifiedGate: () => ({ state: "refused", reason: "target_not_found" }) }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "needs_human", detail: "target_not_found" });
    expect(other.started).toEqual([]);
  });
});

describe("D#598 P7c: a head that is only a merge of the base branch gets the delta re-check", () => {
  it("is asked once per head with the plan's roles and the base branch; a full-review answer runs the reviewers as before", async () => {
    const t = setup(fresh());
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged", detail: undefined });
    expect(t.worker.advanceRecordMergeOnly).toHaveBeenCalledTimes(1);
    const input = t.worker.advanceRecordMergeOnly.mock.calls[0]![1];
    expect(input).toMatchObject({ headSha: H1, prNumber: 41, baseRef: "main" });
    expect([...input.requiredRoles].sort()).toEqual(["acceptance-tester", "code-reviewer"]);
    expect(rolesOf(t.started).sort()).toEqual(["acceptance-tester", "code-reviewer"]);
    expect(t.worker.advanceRecordRound).toHaveBeenCalledTimes(1);
  });

  it("a merge-only head: no reviewer is started, no round is recorded, and the merge gate follows", async () => {
    const t = setup(fresh({ mergeOnly: [{ decision: "all_passed" }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged", detail: undefined });
    expect(t.started).toEqual([]);
    expect(t.worker.advanceRecordRound).not.toHaveBeenCalled();
    expect(t.worker.advanceMergeGate).toHaveBeenCalledWith(WHO, 41);
    expect(logs.find((l) => l.event === "advance.reviewed")).toMatchObject({ decision: "merge_only", head: H1.slice(0, 12) });
  });

  it("waits for CI like a full review does (same minute cadence), then carries the head; CI that never settles stops for a person", async () => {
    const t = setup(fresh({ mergeOnly: [{ decision: "ci_pending" }, { decision: "ci_pending" }, { decision: "all_passed" }] }));
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
    expect(world.sleeps).toBe(2);
    expect(t.started).toEqual([]);

    world.sleeps = 0;
    const never = setup(fresh({ mergeOnly: [{ decision: "ci_pending" }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "needs_human", detail: "ci_wait_timeout" });
    expect(never.worker.advanceMergeGate).not.toHaveBeenCalled();
    expect(never.started).toEqual([]);
    expect(events()).toContain("advance.ci_wait_timeout");
  });

  it("a head that moved under the gate is looked at again, and the new head gets its own re-check", async () => {
    const w = fresh({ mergeOnly: [{ decision: "all_passed" }, { decision: "full_review", reason: "code_changed" }] });
    const t = setup(w);
    t.worker.advanceMergeGate.mockImplementationOnce(async () => {
      w.head = H2;
      return { outcome: "head_moved", reasons: [] };
    });
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
    expect(t.worker.advanceRecordMergeOnly.mock.calls.map((c) => c[1].headSha)).toEqual([H1, H2]);
    // The second head had code changes: the full review ran on it, and only on it.
    expect(t.started.map((s) => s.headSha)).toEqual([H2, H2]);
  });

  it("a head that moved while the re-check waited is looked at again, with nothing recorded for the stale one", async () => {
    const w = fresh({ mergeOnly: [{ decision: "head_moved" }, { decision: "all_passed" }] });
    const t = setup(w);
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
    expect(t.worker.advanceRecordMergeOnly).toHaveBeenCalledTimes(2);
    expect(t.started).toEqual([]);
    expect(t.worker.advanceMergeGate).toHaveBeenCalledTimes(1);
  });

  it("a halt during the re-check ends the workflow with the halted stop", async () => {
    const t = setup(fresh({ mergeOnly: [{ decision: "halted", reason: "item_halted" }] }));
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out.status).not.toBe("merged");
    expect(t.started).toEqual([]);
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
  });
});

describe("verdicts: anything but the exact words is a fail", () => {
  it.each([
    ["Pass", { verdict: "Pass" }],
    ["PASS", { verdict: "PASS" }],
    [" pass", { verdict: " pass" }],
    ["passed", { verdict: "passed" }],
    ["true", { verdict: true }],
    ["1", { verdict: 1 }],
    ["an object", { verdict: { v: "pass" } }],
    ["no verdict", { findings: [] }],
    ["a nested verdict", { result: { verdict: "pass" } }],
  ])("%s is recorded as fail", async (_n, envelope) => {
    const w = fresh({ verdict: () => ({ status: "succeeded", envelope }), rounds: [{ decision: "reviewer_fail" }] });
    const t = setup(w);
    await workItemAdvanceWorkflow(ARGS);
    const input = t.worker.advanceRecordRound.mock.calls[0]![1];
    expect(input.verdicts.map((v) => v.verdict)).toEqual(["fail", "fail"]);
  });

  it.each(["failed", "timed_out", "cancelled", "killed_spend", "refused_spend"])("a reviewer run that ended %s has no verdict even when its envelope says pass (never a pass)", async (status) => {
    const w = fresh({ verdict: () => ({ status, envelope: { verdict: "pass" } }), rounds: [{ decision: "reviewer_no_verdict" }] });
    const t = setup(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].verdicts.map((v) => [v.verdict, v.noVerdict, v.endCode])).toEqual([["fail", true, status], ["fail", true, status]]);
  });

  it("the exact words pass, needs-fix and fail are kept as they are", async () => {
    const w = fresh({ verdict: (role) => ({ status: "succeeded", envelope: { verdict: role === "code-reviewer" ? "needs-fix" : "fail" } }), rounds: [{ decision: "reviewer_fail" }] });
    const t = setup(w);
    await workItemAdvanceWorkflow(ARGS);
    const byRole = Object.fromEntries(t.worker.advanceRecordRound.mock.calls[0]![1].verdicts.map((v) => [v.role, v.verdict]));
    expect(byRole).toEqual({ "code-reviewer": "needs-fix", "acceptance-tester": "fail" });
  });
});

describe("who reviews: the security reviewer", () => {
  it("is not started for an ordinary change", async () => {
    const t = setup(fresh());
    await workItemAdvanceWorkflow(ARGS);
    expect(rolesOf(t.started)).not.toContain("security-reviewer");
  });

  it("is started when the item is critical", async () => {
    const t = setup(fresh({ tier: "critical" }));
    await workItemAdvanceWorkflow(ARGS);
    expect(rolesOf(t.started).sort()).toEqual(["acceptance-tester", "code-reviewer", "security-reviewer"]);
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].requiredRoles).toContain("security-reviewer");
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "security_review_required", reasons: ["item_critical"] }));
  });

  it("is started when the diff touches a security surface, and the reason is recorded as codes", async () => {
    const t = setup(fresh({ files: [{ filename: "src/auth/session.ts", patch: "@@\n+const x = 1;", changes: 1 }, { filename: "package.json", patch: "@@\n+\"dep\": \"1\"", changes: 1 }] }));
    await workItemAdvanceWorkflow(ARGS);
    expect(rolesOf(t.started)).toContain("security-reviewer");
    const ev = t.worker.advanceRecordEvent.mock.calls.map((c) => c[1]).find((e) => e.kind === "security_review_required")!;
    expect(ev.reasons).toEqual(["diff_trigger", "auth_sessions_tokens", "dependency_manifest"]);
    expect(ev.headSha).toBe(H1);
  });

  it("is started when the code reviewer's envelope sets the flag, on the same head", async () => {
    const w = fresh({ verdict: (role) => ({ status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "", ...(role === "code-reviewer" ? { security_review_needed: true } : {}) } }) });
    const t = setup(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(rolesOf(t.started)).toEqual(["code-reviewer", "acceptance-tester", "security-reviewer"]);
    expect(t.started[2]!.step).toBe(`review:${H1}:security-reviewer`);
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].requiredRoles).toContain("security-reviewer");
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "security_review_required", reasons: ["reviewer_flag"] }));
  });

  it.each(["true", 1, "yes", { a: 1 }])("a flag that is not the JSON boolean true (%j) starts nothing", async (flag) => {
    const w = fresh({ verdict: () => ({ status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "", security_review_needed: flag } }) });
    const t = setup(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(rolesOf(t.started)).not.toContain("security-reviewer");
  });
});

describe("who reviews: the debater", () => {
  it("is off by default: it is never started", async () => {
    const t = setup(fresh({ tier: "critical" }));
    await workItemAdvanceWorkflow(ARGS);
    expect(rolesOf(t.started)).not.toContain("debater");
  });

  it("when the repo's setting allows it, it runs after the others have passed, sees what they said, and is required by the record", async () => {
    const t = setup(fresh({ debaterEnabled: true }));
    await workItemAdvanceWorkflow(ARGS);
    expect(rolesOf(t.started)).toEqual(["code-reviewer", "acceptance-tester", "debater"]);
    expect(t.started[2]!.prompt).toContain("WHAT THE REVIEWERS SAID");
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].requiredRoles.at(-1)).toBe("debater");
  });

  it("does not run when a reviewer asked for changes (it only tries to refute a pass)", async () => {
    const w = fresh({ debaterEnabled: true, verdict: (role) => ({ status: "succeeded", envelope: { verdict: role === "code-reviewer" ? "needs-fix" : "pass", findings: ["x"], summary: "" } }), rounds: [{ decision: "reviewer_fail" }] });
    const t = setup(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(rolesOf(t.started)).not.toContain("debater");
  });
});

describe("the debater, enabled, does not hide a needs-fix", () => {
  /** The worker's round decision, made by the pipeline's real rule over what the workflow sends. */
  function realDecisions(t: ReturnType<typeof setup>) {
    t.worker.advanceRecordRound.mockImplementation(async (_who: unknown, input: Omit<AdvanceRoundInput, "accountId" | "workItemId">) => {
      const decision = decideRound({ requiredRoles: input.requiredRoles as never, verdicts: input.verdicts as never, fixRoundsStarted: 0 });
      return { decision, round: 0, nextRound: 1, recorded: input.verdicts.map((v) => ({ role: v.role, runId: v.runId, verdict: v.verdict, outcome: "passed" })) };
    });
  }
  const pass = { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "" } };
  const needsFix = { status: "succeeded", envelope: { verdict: "needs-fix", findings: ["a.ts:1 - x"], summary: "s" } };

  it("code-reviewer needs-fix with the debater on: the round asks only for the roles that ran, a fix round starts, and the debater is not started for that head", async () => {
    const t = setup(fresh({ debaterEnabled: true, verdict: (role, head) => (head === H1 && role === "code-reviewer" ? needsFix : pass) }));
    realDecisions(t);
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].requiredRoles).toEqual(["code-reviewer", "acceptance-tester"]);
    expect(t.worker.advanceStartFix).toHaveBeenCalledTimes(1);
    expect(t.started.filter((s) => s.headSha === H1).map((s) => s.role)).not.toContain("debater");
    // After the fix the new head is reviewed, everyone passes, the debater runs, and the gate is reached.
    expect(t.started.filter((s) => s.headSha === H2).map((s) => s.role)).toEqual(["code-reviewer", "acceptance-tester", "debater"]);
    expect(out.status).toBe("merged");
  });

  it("acceptance-tester needs-fix with the debater on starts a fix round too", async () => {
    const t = setup(fresh({ debaterEnabled: true, verdict: (role, head) => (head === H1 && role === "acceptance-tester" ? needsFix : pass) }));
    realDecisions(t);
    await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceStartFix).toHaveBeenCalledTimes(1);
  });

  it("everyone passing with the debater on: the debater runs, its verdict counts, and the gate follows", async () => {
    const t = setup(fresh({ debaterEnabled: true }));
    realDecisions(t);
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(t.started.map((s) => s.role)).toEqual(["code-reviewer", "acceptance-tester", "debater"]);
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].requiredRoles).toEqual(["code-reviewer", "acceptance-tester", "debater"]);
    expect(t.worker.advanceMergeGate).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("merged");
  });

  it("the debater's needs-fix starts a fix round, and the gate is reached only after the fixed head passed everything", async () => {
    const t = setup(fresh({ debaterEnabled: true, verdict: (role, head) => (head === H1 && role === "debater" ? needsFix : pass) }));
    realDecisions(t);
    await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceStartFix).toHaveBeenCalledTimes(1);
    expect(t.worker.advanceStartFix.mock.calls[0]![1].reviewer).toBe("code");
    expect(t.worker.advanceMergeGate).toHaveBeenCalledTimes(1);
  });

  it("a debater that cannot be started after the others passed leaves the round incomplete: nothing merges", async () => {
    const t = setup(fresh({ debaterEnabled: true, refuseStart: new Set(["debater"]) }));
    realDecisions(t);
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "needs_human", detail: "reviewer_not_started:debater" });
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
  });
});

describe("what happens after the verdicts are recorded", () => {
  it("all passed -> the merge gate, and its outcome is the workflow's", async () => {
    const t = setup(fresh({ gates: [{ outcome: "ready_human_merges", reasons: ["auto_merge_not_allowed"], status: "posted" }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "ready_human_merges", detail: "auto_merge_not_allowed" });
    expect(t.worker.advanceMergeGate).toHaveBeenCalledTimes(1);
    expect(logs.find((l) => l.event === "advance.merge_gate")).toMatchObject({ outcome: "ready_human_merges", reasons: "auto_merge_not_allowed", status: "posted" });
  });

  it("a gate that could not read GitHub is recorded as a stop, not retried here", async () => {
    const t = setup(fresh({ gates: [{ outcome: "error", reasons: ["github_unavailable"] }] }));
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("error");
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "github_unavailable" }));
  });

  it("a head that moved under the gate is reviewed again on the new head", async () => {
    const w = fresh({ gates: [{ outcome: "head_moved" }, { outcome: "merged", reasons: [], status: "posted" }] });
    const t = setup(w);
    const moved = vi.spyOn(w, "head", "get");
    moved.mockReturnValueOnce(H1).mockReturnValue(H2);
    expect(await workItemAdvanceWorkflow(ARGS)).toMatchObject({ status: "merged" });
    expect(t.started.map((s) => s.headSha)).toEqual([H1, H1, H2, H2]);
    expect(t.worker.advanceMergeGate).toHaveBeenCalledTimes(2);
  });

  it("incomplete (a required reviewer could not start) stops with a recorded reason and merges nothing", async () => {
    const t = setup(fresh({ refuseStart: new Set(["acceptance-tester"]), rounds: [{ decision: "incomplete" }] }));
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "needs_human", detail: "reviewer_not_started:acceptance-tester" });
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "not_started_no_model" }));
  });

  // Live 2026-10-25 (cloud#673): the security reviewer was refused for the runner's daily limit, the round ended incomplete and the item sat at pull request open with
  // nothing running. The stop names the cause, not only the role, so the card and the Needs you row can say what happened.
  it("a reviewer refused for the runner's daily limit stops with that reason in its code, and nothing merges", async () => {
    const t = setup(fresh({ refuseStart: new Set(["acceptance-tester"]), refuseReason: "runner_daily_limit", rounds: [{ decision: "incomplete" }] }));
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "needs_human", detail: "reviewer_not_started:acceptance-tester" });
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "not_started_runner_daily_limit" }));
  });

  // D#598 P7b: the recording step answers `ci_pending` (and records nothing) while the head's CI or a repo-wide guard runs; the workflow asks again every minute.
  it("CI still running: the round is asked again after each minute, the reviewers are not started twice, and the gate waits for the settled answer", async () => {
    const t = setup(fresh({ rounds: [{ decision: "ci_pending" }, { decision: "ci_pending" }, { decision: "ci_pending" }, { decision: "all_passed", round: 0 }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toMatchObject({ status: "merged" });
    expect(world.sleeps).toBe(3);
    expect(t.worker.advanceRecordRound).toHaveBeenCalledTimes(4);
    // Every ask carries the same head and the same gathered verdicts (the runs are not repeated).
    const asks = t.worker.advanceRecordRound.mock.calls.map((c) => c[1]);
    expect(new Set(asks.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(rolesOf(t.started)).toEqual(["code-reviewer", "acceptance-tester"]);
    expect(t.worker.advanceMergeGate).toHaveBeenCalledTimes(1);
  });

  it("CI that never settles: after two hours the driver stops for a person (ci_wait_timeout), records the stop, and never asks the merge gate", async () => {
    const t = setup(fresh({ rounds: [{ decision: "ci_pending" }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "needs_human", detail: "ci_wait_timeout" });
    // One-minute asks for the first ten minutes, two-minute asks after that, up to the two-hour cap.
    expect(world.sleeps).toBe(10 + (120 - 10) / 2);
    expect(t.worker.advanceRecordRound).toHaveBeenCalledTimes(10 + (120 - 10) / 2 + 1);
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
    expect(t.worker.advanceStartFix).not.toHaveBeenCalled();
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "ci_wait_timeout" }));
    expect(events()).toContain("advance.ci_wait_timeout");
  });

  // Fix round 1 on #325: on a runner_local repo the CI read follows the PR's last commit, so a push during the review answers head_moved.
  it("the head moved while the round waited for CI: nothing is waited for, no timeout, and the new head is reviewed (one re-review)", async () => {
    const w = fresh({ rounds: [{ decision: "ci_pending" }, { decision: "head_moved" }, { decision: "all_passed", round: 0 }] });
    const t = setup(w);
    const moved = vi.spyOn(w, "head", "get");
    moved.mockReturnValueOnce(H1).mockReturnValue(H2);
    expect(await workItemAdvanceWorkflow(ARGS)).toMatchObject({ status: "merged" });
    // The old head was reviewed once, the new head once; the wait was one minute, not two hours.
    expect(t.started.map((s) => s.headSha)).toEqual([H1, H1, H2, H2]);
    expect(world.sleeps).toBe(1);
    expect(t.worker.advanceRecordRound).toHaveBeenCalledTimes(3);
    expect(t.worker.advanceMergeGate).toHaveBeenCalledTimes(1);
    expect(t.worker.advanceStartFix).not.toHaveBeenCalled();
    expect(events()).not.toContain("advance.ci_wait_timeout");
  });

  it("a reviewer's fail stops the driver: no fix round, no gate", async () => {
    const t = setup(fresh({ rounds: [{ decision: "reviewer_fail" }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "needs_human", detail: "reviewer_fail" });
    expect(t.worker.advanceStartFix).not.toHaveBeenCalled();
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
  });

  it("the fix rounds used up (escalated) stops the driver", async () => {
    const t = setup(fresh({ rounds: [{ decision: "escalated", round: maxFixRounds() }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "escalated", detail: "max_fix_rounds" });
    expect(t.worker.advanceStartFix).not.toHaveBeenCalled();
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
  });

  it("no open pull request stops with the reason", async () => {
    const t = setup(fresh({ noPr: true }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "no_pr", detail: "no_open_pr" });
    expect(t.started).toEqual([]);
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "no_open_pr" }));
  });

  it("a Spec that changed since the approval stops before anything starts", async () => {
    const t = setup(fresh({ loadReview: { ok: true, specVersion: 4 } }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "review_spec_changed" });
    expect(t.started).toEqual([]);
  });

  it("the Spec version the approval carried wins over the one read later: a newer Spec stops the review, the same one lets it go on", async () => {
    const stale = setup(fresh());
    expect(await workItemAdvanceWorkflow({ ...ARGS, specVersion: 2 })).toEqual({ status: "failed", detail: "review_spec_changed" });
    expect(stale.started).toEqual([]);
    const same = setup(fresh());
    expect((await workItemAdvanceWorkflow({ ...ARGS, specVersion: 3 })).status).toBe("merged");
    expect(same.started.length).toBeGreaterThan(0);
  });

  it("an item the review cannot load (no tier, no Spec) stops with that reason", async () => {
    const t = setup(fresh({ loadReview: { ok: false, reason: "tier_unknown" } }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "review_tier_unknown" });
    expect(t.started).toEqual([]);
  });
});

describe("fix rounds", () => {
  const needsFix = (role: string, head: string) =>
    head === H1 && role === "code-reviewer"
      ? { status: "succeeded", envelope: { verdict: "needs-fix", findings: ["src/a.ts:3 - off by one - use <="], summary: "one problem" } }
      : { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "fine" } };

  it("a needs-fix starts a fix round from ALL the findings with the issue number (never the PR's), then reviews the new head, then the gate", async () => {
    const w = fresh({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "all_passed", round: 1 }] });
    const t = setup(w);
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out.status).toBe("merged");
    expect(t.worker.advanceStartFix).toHaveBeenCalledTimes(1);
    const [who, req] = t.worker.advanceStartFix.mock.calls[0]!;
    expect(who).toEqual(WHO);
    expect(req.issue).toBe(7);
    expect(req.issue).not.toBe(41);
    expect(req.headSha).toBe(H1);
    expect(req.round).toBe(1);
    expect(req.actionId).toBe(ARGS.actionId);
    expect(req.reviewer).toBe("code");
    expect(req.prompt).toContain("src/a.ts:3 - off by one - use <=");
    expect(req.prompt).toContain("SPEC BODY");
    expect(req.prompt).toContain("Do not clone it again");
    expect(req.prompt.trimEnd().endsWith("<!-- /AGENT_OUTPUT -->")).toBe(true);
    // The second review is of the NEW head.
    expect(t.started.filter((s) => s.headSha === H2).map((s) => s.role).sort()).toEqual(["acceptance-tester", "code-reviewer"]);
    expect(t.worker.advanceRecordRound).toHaveBeenCalledTimes(2);
    expect(t.worker.advanceMergeGate).toHaveBeenCalledTimes(1);
    expect(events()).toContain("advance.fixed");
  });

  describe("D#6 C44-7: a fix that proves no change is needed re-runs the reviewers that asked for it", () => {
    const noChangeSandbox: AdvanceRunOutcome = { status: "succeeded", done: true, envelope: { summary: "tests pass, no change" } };
    const noChangeRunner: AdvanceRunOutcome = { status: "failed", done: true, envelope: null, runtime: "runner", failureReason: "no_commit" };
    const asksFirst = (role: string, head: string, step: string) => (head === H1 && role === "code-reviewer" && !step.includes(":rr") ? needsFix(role, head) : needsFix("none", head));
    const stepsOf = (started: AdvanceRunRequest[]) => started.map((s) => s.step);

    it.each([
      ["sandbox: the run succeeded and the head did not move", noChangeSandbox, "sandbox"],
      ["runner_local: the run ended failed no_commit and the head did not move", noChangeRunner, "runner_local"],
    ] as const)("%s: only the failing role looks again, on the same head, and the gate follows", async (_n, fixOutcome, mode) => {
      const w = fresh({
        verdict: asksFirst,
        rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "all_passed", round: 1 }],
        fixPushes: null,
        fixOutcome,
        mode,
        recorded: mode === "runner_local" ? { number: 41, branch: "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1" } : null,
      });
      const t = setup(w, { ...AT_PR, executionMode: mode });
      const out = await workItemAdvanceWorkflow(ARGS);
      expect(out.status).toBe("merged");
      // Round one: both roles. Then ONE more run: the code reviewer, same head, a step of its own.
      const roundOne = stepsOf(t.started).slice(0, -1).sort();
      expect(roundOne).toEqual(expect.arrayContaining([`review:${H1}:code-reviewer`, `review:${H1}:acceptance-tester`]));
      expect(stepsOf(t.started).at(-1)).toBe(`review:${H1}:code-reviewer:rr1`);
      expect(stepsOf(t.started).filter((x) => x.includes(":rr"))).toHaveLength(1);
      expect(t.started.every((s) => s.headSha === H1)).toBe(true);
      expect(t.worker.advanceStartFix).toHaveBeenCalledTimes(1);
      // The second record carries only what was re-run; the first round's pass is not recorded twice.
      const second = t.worker.advanceRecordRound.mock.calls[1]![1];
      expect(second.headSha).toBe(H1);
      expect(second.requiredRoles).toEqual(["code-reviewer"]);
      expect(second.verdicts.map((v: { role: string }) => v.role)).toEqual(["code-reviewer"]);
      expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "fix_pushed_nothing", code: "rereview", headSha: H1, runId: "fix-1" }));
      expect(t.worker.advanceMergeGate).toHaveBeenCalledTimes(1);
      expect(events()).toContain("advance.fix_no_change");
    });

    it("replay safety: running the same workflow again over the same facts starts exactly the same keyed runs, so a replayed step finds the runs it already started", async () => {
      const make = () => setup(fresh({ verdict: (role, head) => needsFix(role, head), rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "fix", round: 1, nextRound: 2 }], fixPushes: null, fixOutcome: noChangeSandbox }));
      const one = make();
      await workItemAdvanceWorkflow(ARGS);
      const two = make();
      await workItemAdvanceWorkflow(ARGS);
      expect(stepsOf(two.started)).toEqual(stepsOf(one.started));
      expect(two.worker.advanceStartFix.mock.calls.map((c) => [c[1].round, c[1].retry, c[1].headSha, c[1].actionId])).toEqual(one.worker.advanceStartFix.mock.calls.map((c) => [c[1].round, c[1].retry, c[1].headSha, c[1].actionId]));
      expect(new Set(stepsOf(one.started)).size).toBe(stepsOf(one.started).length);
    });

    it("a fix run that failed for any other reason is still a failed fix, even with the head unmoved", async () => {
      const t = setup(fresh({ verdict: asksFirst, rounds: [{ decision: "fix", round: 0, nextRound: 1 }], fixPushes: null, fixOutcome: { status: "failed", done: true, envelope: null, runtime: "runner", failureReason: "internal_error" } }));
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "fix_failed", detail: "failed" });
      expect(t.started).toHaveLength(2);
    });

    it("the re-review still asking for changes starts a further fix on the same head as its own run; a second no change on that head goes to a person with a fixed code", async () => {
      const t = setup(fresh({ verdict: (role, head) => needsFix(role, head), rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "fix", round: 1, nextRound: 2 }], fixPushes: null, fixOutcome: noChangeSandbox }));
      const out = await workItemAdvanceWorkflow(ARGS);
      expect(out).toEqual({ status: "needs_human", detail: "fix_no_change_repeated" });
      expect(t.worker.advanceStartFix).toHaveBeenCalledTimes(2);
      expect(t.worker.advanceStartFix.mock.calls[0]![1].retry).toBeUndefined();
      expect(t.worker.advanceStartFix.mock.calls[1]![1].retry).toBe(1);
      expect(t.worker.advanceStartFix.mock.calls[1]![1].round).toBe(2);
      // One re-review only: the first round's two, then the one, never a second re-review.
      expect(stepsOf(t.started).filter((x) => x.includes(":rr"))).toEqual([`review:${H1}:code-reviewer:rr1`]);
      expect(stepsOf(t.started)).toHaveLength(3);
      expect(t.worker.advanceRecordRound).toHaveBeenCalledTimes(2);
      expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
      expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "escalated", code: "fix_no_change_repeated", headSha: H1 }));
      expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "fix_pushed_nothing", code: "fix_no_change_repeated" }));
    });

    it("the fix-round cap still bounds it: a re-review the round decision escalates stops there, with no further fix", async () => {
      const t = setup(fresh({ verdict: (role, head) => needsFix(role, head), rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "escalated", round: maxFixRounds() }], fixPushes: null, fixOutcome: noChangeSandbox }));
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "escalated", detail: "max_fix_rounds" });
      expect(t.worker.advanceStartFix).toHaveBeenCalledTimes(1);
    });

    it("a real fix commit after a re-review still gets the full review of the new head", async () => {
      const w = fresh({ verdict: (role, head) => needsFix(role, head), rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "fix", round: 1, nextRound: 2 }, { decision: "all_passed", round: 2 }], fixPushes: null, fixOutcome: noChangeSandbox });
      const t = setup(w);
      t.worker.advanceStartFix.mockImplementation(async (_who: unknown, req: AdvanceFixRequest) => {
        if (req.retry === 1) w.head = H2;
        return { ok: true as const, runId: `fix-${req.round}` };
      });
      expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
      expect(stepsOf(t.started).filter((s) => s.includes(H2)).sort()).toEqual([`review:${H2}:acceptance-tester`, `review:${H2}:code-reviewer`]);
      expect(t.worker.advanceRecordRound.mock.calls[2]![1].requiredRoles.sort()).toEqual(["acceptance-tester", "code-reviewer"]);
    });

    it("a push that lands between the no-change fix and its re-review makes it a new head: the full review, not the narrow one", async () => {
      const w = fresh({ verdict: asksFirst, rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "all_passed", round: 1 }], fixPushes: null, fixOutcome: noChangeSandbox });
      const t = setup(w);
      t.worker.advanceRecordEvent.mockImplementation(async (_who: unknown, e: { kind: string }) => {
        if (e.kind === "fix_pushed_nothing") w.head = H3;
        return { recorded: true };
      });
      expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
      expect(stepsOf(t.started).filter((s) => s.includes(H3)).sort()).toEqual([`review:${H3}:acceptance-tester`, `review:${H3}:code-reviewer`]);
      expect(stepsOf(t.started).some((s) => s.includes(":rr"))).toBe(false);
    });
  });

  it("a fix round the worker refuses (a second concurrent resume, no session, a spend limit) stops and says why", async () => {
    const t = setup(fresh({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }], fix: { ok: false, reason: "already_running" } }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "fix_refused", detail: "already_running" });
    expect(t.worker.advanceRecordRound).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "timed_out", "cancelled", "killed_spend"])("a fix run that ends %s is recorded and stops the driver", async (status) => {
    const t = setup(fresh({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }], fixOutcome: { status, done: true, envelope: null } }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "fix_failed", detail: status });
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "fix_round_failed", code: `run_${status}` }));
  });

  describe("D#2 H14c-3-3b-2: a fix round that ended at a limit is continued before it is recorded as failed", () => {
    const CHILD = "99999999-9999-4999-8999-000000000001";
    const withContinue = (t: ReturnType<typeof setup>, answer: unknown) => {
      const original = t.worker.advanceRunOutcome.getMockImplementation()!;
      t.worker.advanceRunOutcome.mockImplementation(async (account: string, id: string) => (id === CHILD ? { status: "succeeded", done: true, envelope: { summary: "fixed" } } : original(account, id)));
      const step = vi.fn(async () => answer);
      (t.worker as unknown as Record<string, unknown>).advanceContinue = step;
      return step;
    };

    it.each(["timed_out", "killed_spend"])("a fix run that ends %s is continued, the child is followed, and the review goes on to the gate", async (status) => {
      const t = setup(fresh({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "all_passed", round: 1 }], fixOutcome: { status, done: true, envelope: null } }));
      const step = withContinue(t, { code: "continued", runId: CHILD, parkedAs: null });
      expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
      expect(step).toHaveBeenCalledWith(WHO, "fix-1");
      expect(t.worker.advanceRecordEvent).not.toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "fix_round_failed" }));
    });

    it("a fix round parked by a run limit ends the workflow with the park and records no failed round", async () => {
      const t = setup(fresh({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }], fixOutcome: { status: "timed_out", done: true, envelope: null } }));
      withContinue(t, { code: "parked", runId: null, parkedAs: "max_resumes" });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_parked:max_resumes" });
      expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "run_limit_parked", reasons: ["max_resumes"] }));
      expect(t.worker.advanceRecordEvent).not.toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "fix_round_failed" }));
    });

    it("a worker with no continue step (or one that answers today) leaves the fix round failing exactly as before", async () => {
      const t = setup(fresh({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }], fixOutcome: { status: "timed_out", done: true, envelope: null } }));
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "fix_failed", detail: "timed_out" });
      const u = setup(fresh({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }], fixOutcome: { status: "timed_out", done: true, envelope: null } }));
      withContinue(u, { code: "today", runId: null, parkedAs: null });
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "fix_failed", detail: "timed_out" });
    });
  });

  it("a fix run that never ends is cancelled and recorded", async () => {
    const t = setup(fresh({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }], fixOutcome: { status: "running", done: false, envelope: null } }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "fix_failed", detail: "wait_timeout" });
    expect(t.worker.advanceCancel).toHaveBeenCalledWith(WHO, "fix-1");
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "fix_round_failed", code: "wait_timeout" }));
  });

  describe("D#6 C12 A3: time spent pending (a queued runner run) does not count against the review or fix wait", () => {
    const pending = { status: "pending", done: false, envelope: null, runtime: "runner" } as const;

    it("a fix run that waits for a runner for six hours and then succeeds is not cancelled", async () => {
      const t = setup(fresh({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }] }));
      const real = t.worker.advanceRunOutcome.getMockImplementation()!;
      let polls = 0;
      t.worker.advanceRunOutcome.mockImplementation(async (acct: string, runId: string) => (runId.startsWith("fix-") && polls++ < 360 ? pending : real(acct, runId)));
      const out = await workItemAdvanceWorkflow(ARGS);
      expect(out).not.toEqual({ status: "fix_failed", detail: "wait_timeout" });
      expect(t.worker.advanceCancel).not.toHaveBeenCalled();
      expect(polls).toBeGreaterThanOrEqual(360);
    });

    it("a fix run held pending on a runner past the ceiling is cancelled as a wait timeout; a sandbox fix run is cancelled at the normal cap", async () => {
      const run = async (runtime: string) => {
        const t = setup(fresh({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }] }));
        const real = t.worker.advanceRunOutcome.getMockImplementation()!;
        let polls = 0;
        t.worker.advanceRunOutcome.mockImplementation(async (acct: string, runId: string) => (runId.startsWith("fix-") ? (polls++, { ...pending, runtime }) : real(acct, runId)));
        const out = await workItemAdvanceWorkflow(ARGS);
        return { out, polls, t };
      };
      const runner = await run("runner");
      expect(runner.out).toEqual({ status: "fix_failed", detail: "wait_timeout" });
      expect(runner.t.worker.advanceCancel).toHaveBeenCalledWith(WHO, "fix-1");
      expect(runner.polls).toBe(1 + (73 * 3600) / 60);
      const sandbox = await run("production");
      expect(sandbox.out).toEqual({ status: "fix_failed", detail: "wait_timeout" });
      expect(sandbox.polls).toBe(1 + 250);
    });

    it("a reviewer that waits for a runner past the 45 minute review limit is not counted as a fail", async () => {
      // 120 polls at 30 seconds is an hour pending; then the reviewer passes.
      const w = fresh({});
      const t = setup(w);
      const real = t.worker.advanceRunOutcome.getMockImplementation()!;
      let polls = 0;
      t.worker.advanceRunOutcome.mockImplementation(async (acct: string, runId: string) => (!runId.startsWith("fix-") && polls++ < 240 ? pending : real(acct, runId)));
      await workItemAdvanceWorkflow(ARGS);
      const input = t.worker.advanceRecordRound.mock.calls[0]![1];
      expect(input.verdicts.map((v) => v.verdict)).toEqual(["pass", "pass"]);
      expect(t.worker.advanceCancel).not.toHaveBeenCalled();
    });
  });

  it("every round reviews a different head, and the loop is bounded", async () => {
    // Each fix pushes a new head and the next round asks for a fix again, forever: the workflow still ends.
    let k = 0;
    const heads = [H1, H2, H3];
    const w = fresh({ verdict: () => ({ status: "succeeded", envelope: { verdict: "needs-fix", findings: ["x"], summary: "" } }), rounds: [{ decision: "fix", round: 0, nextRound: 1 }] });
    Object.defineProperty(w, "fixPushes", { get: () => `${(k++).toString(16).padStart(2, "0")}${"d".repeat(38)}`, configurable: true });
    void heads;
    const t = setup(w);
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "needs_human", detail: "review_rounds_used" });
    expect(t.worker.advanceStartFix.mock.calls.length).toBeGreaterThanOrEqual(maxFixRounds());
  });
});

describe("D#7 DP4b-2: the decision read after a succeeded fix round", () => {
  const needsFix = (role: string, head: string) =>
    head === H1 && role === "code-reviewer"
      ? { status: "succeeded", envelope: { verdict: "needs-fix", findings: ["src/a.ts:3 - off by one - use <="], summary: "one problem" } }
      : { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "fine" } };
  const fixing = (over: Partial<World> = {}) => fresh({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "all_passed", round: 1 }], ...over });

  it("is asked exactly once, with the fix run's id, before the next review round", async () => {
    const t = setup(fixing());
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
    expect(t.worker.advanceDecision).toHaveBeenCalledTimes(1);
    expect(t.worker.advanceDecision).toHaveBeenCalledWith(ACCOUNT, ARGS.userId, ITEM, 0, "fix-1");
    const asked = t.worker.advanceDecision.mock.invocationCallOrder[0]!;
    expect(t.worker.advanceStartFix.mock.invocationCallOrder[0]!).toBeLessThan(asked);
    // Every reviewer of the new head started after the decision read.
    const secondRound = t.worker.advanceStartRun.mock.invocationCallOrder.filter((_o, i) => t.worker.advanceStartRun.mock.calls[i]![0].headSha === H2);
    expect(secondRound.length).toBeGreaterThan(0);
    for (const o of secondRound) expect(o).toBeGreaterThan(asked);
  });

  it("is never asked for the reviewers' runs, nor for a fix round that did not succeed", async () => {
    const clean = setup(fresh());
    await workItemAdvanceWorkflow(ARGS);
    expect(clean.worker.advanceDecision).not.toHaveBeenCalled();
    for (const status of ["failed", "timed_out", "cancelled"]) {
      const t = setup(fixing({ fixOutcome: { status, done: true, envelope: null } }));
      await workItemAdvanceWorkflow(ARGS);
      expect(t.worker.advanceDecision, status).not.toHaveBeenCalled();
    }
  });

  it("parked: one stopped fact against the fix run, the workflow ends before another review starts, and no failed build is recorded", async () => {
    const t = setup(fixing({ decision: "parked" }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "waiting_on_answer" });
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, { kind: "stopped", dedupeKey: "decision:fix-1", code: "waiting_on_answer", runId: "fix-1" });
    expect(t.started.filter((s) => s.headSha === H2)).toEqual([]);
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
    expect(t.worker.advanceBuildFailed).not.toHaveBeenCalled();
  });

  it.each<DecisionStepCode>(["item_halted", "halted_since_approval"])("%s ends the halted way", async (decision) => {
    const t = setup(fixing({ decision }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "halted" });
    expect(t.started.filter((s) => s.headSha === H2)).toEqual([]);
  });

  it.each<DecisionStepCode>(["none", "resolved", "refused"])("%s carries on to the next review", async (decision) => {
    const t = setup(fixing({ decision }));
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
  });
});

describe("the loop guard", () => {
  it("allows at least the maximum number of fix rounds, one more review, and a re-review after a moved head", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "workItemAdvance.ts"), "utf8");
    const guard = Number(/const MAX_REVIEW_ROUNDS = (\d+);/.exec(src)![1]);
    expect(guard).toBeGreaterThanOrEqual(maxFixRounds() + 2);
  });
});

describe("the log carries fixed codes, ids and counts only", () => {
  it("no finding, summary or Spec text reaches a log line", async () => {
    const w = fresh({
      verdict: (role, head) => (head === H1 && role === "code-reviewer" ? { status: "succeeded", envelope: { verdict: "needs-fix", findings: ["SECRET-FINDING"], summary: "SECRET-SUMMARY" } } : { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "SECRET-OTHER" } }),
      rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "all_passed", round: 1 }],
    });
    setup(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(JSON.stringify(logs)).not.toMatch(/SECRET|SPEC BODY/);
  });
});

describe('"Check the build": an item at In progress with nothing running', () => {
  const EXEC_RUN = "66666666-6666-4666-8666-666666666666";
  const AT_BUILD: AdvanceItem = { ...AT_PR, stage: "in_progress", executorRunId: EXEC_RUN };

  it("a pull request is found: the item is moved to PR opened (the webhook never did) and the review follows in the same workflow", async () => {
    const t = setup(fresh(), AT_BUILD);
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advancePrFound).toHaveBeenCalledWith(WHO, 41);
    expect(rolesOf(t.started).sort()).toEqual(["acceptance-tester", "code-reviewer"]);
    expect(t.worker.advanceMergeGate).toHaveBeenCalledWith(WHO, 41);
    expect(t.worker.advanceBuildFailed).not.toHaveBeenCalled();
    expect(out).toEqual({ status: "merged", detail: undefined });
    expect(logs.find((l) => l.event === "advance.build_checked")).toMatchObject({ found: true, pr: 41 });
  });

  it("no open pull request: the item goes to Needs human against the executor's newest run, the stop is a recorded fact, and no reviewer starts", async () => {
    const t = setup(fresh({ noPr: true }), AT_BUILD);
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "failed", detail: "build_no_pull_request" });
    expect(t.worker.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, EXEC_RUN, "no_pull_request", ARGS.actionId);
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "build_no_pull_request", runId: EXEC_RUN }));
    expect(t.worker.advancePrFound).not.toHaveBeenCalled();
    expect(t.started).toEqual([]);
  });

  it("a lookup that failed decides nothing: the item is not sent to Needs human, and the stop says why", async () => {
    const t = setup(fresh({ githubDown: true }), AT_BUILD);
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "no_pr", detail: "github_unavailable" });
    expect(t.worker.advanceBuildFailed).not.toHaveBeenCalled();
    // The stop is recorded under the fixed code the card turns into "Couldn't check the build right now".
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "check_build_unavailable" }));
    expect(t.started).toEqual([]);
  });

  it("more than one open pull request on the branch is its own recorded stop, and decides nothing", async () => {
    const t = setup(fresh(), AT_BUILD);
    // Two pull requests from the same branch.
    setInstallationHttpForTests(async () => ({
      async request(req) {
        if (req.path === "/repos/acme/widgets/pulls") {
          const pr = (n: number) => ({ number: n, head: { sha: H1, ref: "fx/issue-7", repo: { full_name: "acme/widgets" } }, base: { ref: "main" } });
          return { status: 200, body: [pr(41), pr(42)] };
        }
        return { status: 404, body: {} };
      },
    }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "no_pr", detail: "ambiguous_pr" });
    expect(t.worker.advanceBuildFailed).not.toHaveBeenCalled();
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "check_build_ambiguous" }));
  });

  it("a review context that cannot load (the Spec changed) is also a visible, undecided stop", async () => {
    const t = setup(fresh({ loadReview: { ok: false, reason: "no_spec" } }), AT_BUILD);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "check_build_no_spec" });
    expect(t.worker.advanceBuildFailed).not.toHaveBeenCalled();
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "check_build_unavailable" }));
  });

  it("an item with no executor run at all still goes to Needs human (recorded with no run), as live did", async () => {
    const t = setup(fresh({ noPr: true }), { ...AT_BUILD, executorRunId: null });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_no_pull_request" });
    expect(t.worker.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, null, "no_pull_request", ARGS.actionId);
    const stop = t.worker.advanceRecordEvent.mock.calls.map((c) => c[1]).find((e) => e.kind === "stopped")!;
    expect(stop).toMatchObject({ code: "build_no_pull_request" });
    expect(stop.runId).toBeUndefined();
  });

  it("a pull request found for an item that is no longer in a pull-request stage (closed meanwhile) is not reviewed", async () => {
    const t = setup(fresh(), AT_BUILD);
    t.worker.advancePrFound.mockResolvedValue({ status: "unchanged", stage: "closed" });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "unchanged", detail: "closed" });
    expect(t.started).toEqual([]);
  });
});

describe("Build again: an item at Needs a person that still has its Spec", () => {
  const STUCK: AdvanceItem = { ...AT_PR, stage: "needs_human", executorRunId: "66666666-6666-4666-8666-666666666666" };
  const BUILD_RUN = "77777777-7777-4777-8777-777777777777";

  function build(w: World) {
    const t = setup(w, STUCK);
    t.worker.advanceBuild.mockResolvedValue({ status: "started", runId: BUILD_RUN, branch: "fx/issue-7" });
    const outcome = t.worker.advanceRunOutcome.getMockImplementation()!;
    t.worker.advanceRunOutcome.mockImplementation(async (a: string, runId: string) => (runId === BUILD_RUN ? { status: "succeeded", done: true, envelope: { summary: "rebuilt" } } : outcome(a, runId)));
    return t;
  }

  it("a pull request still open for the issue's branch: nothing is started, the stop is a recorded fact naming the pull request, and the item stays where it is", async () => {
    const t = build(fresh());
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "rebuild_pr_open" });
    expect(t.worker.advanceBuild).not.toHaveBeenCalled();
    expect(t.worker.advanceBuildFailed).not.toHaveBeenCalled();
    expect(t.started).toEqual([]);
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "rebuild_pr_open", prNumber: 41 }));
  });

  it("no pull request open: the build starts as for Spec ready, pinned to the Spec version, after the lookup", async () => {
    const t = build(fresh({ noPr: true }));
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceBuild).toHaveBeenCalledWith(WHO, ARGS.actionId, 3);
    expect(t.requests.some((r) => r.method === "GET" && r.path === "/repos/acme/widgets/pulls")).toBe(true);
    expect(out.status).toBe("built");
    expect(t.worker.advanceRecordEvent).not.toHaveBeenCalledWith(WHO, expect.objectContaining({ code: "rebuild_pr_open" }));
  });

  it("the Spec version the approval carried is what the rebuild is pinned to", async () => {
    const t = build(fresh({ noPr: true }));
    await workItemAdvanceWorkflow({ ...ARGS, specVersion: 2 });
    expect(t.worker.advanceBuild).toHaveBeenCalledWith(WHO, ARGS.actionId, 2);
  });

  it("a lookup that failed decides nothing: no build is started on a guess, and the stop says the check was unavailable", async () => {
    const t = build(fresh({ githubDown: true }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "rebuild_check_unavailable" });
    expect(t.worker.advanceBuild).not.toHaveBeenCalled();
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "rebuild_check_unavailable" }));
  });

  it("more than one open pull request on the branch is the same undecided stop", async () => {
    const t = build(fresh());
    setInstallationHttpForTests(async () => ({
      async request(req) {
        if (req.path === "/repos/acme/widgets/pulls") {
          const pr = (n: number) => ({ number: n, head: { sha: H1, ref: "fx/issue-7", repo: { full_name: "acme/widgets" } }, base: { ref: "main" } });
          return { status: 200, body: [pr(41), pr(42)] };
        }
        return { status: 404, body: {} };
      },
    }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "rebuild_check_unavailable" });
    expect(t.worker.advanceBuild).not.toHaveBeenCalled();
  });

  it("a build the worker refuses (no model key) leaves the item at Needs a person, as a spec_ready build leaves it at Spec ready", async () => {
    const t = build(fresh({ noPr: true }));
    t.worker.advanceBuild.mockResolvedValue({ status: "refused", reason: "start_no_model" });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_refused:start_no_model" });
    expect(t.worker.advanceBuildFailed).not.toHaveBeenCalled();
  });
});

describe("a runner run's pull request is the one its done recorded (D#6 C25 section 1.2)", () => {
  const RUN_BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g2";
  const recorded = { number: 41, branch: RUN_BRANCH };
  const runner = (over: Partial<World> = {}) => fresh({ mode: "runner_local", recorded, ...over });
  const RUNNER_PR: AdvanceItem = { ...AT_PR, executionMode: "runner_local", recordedPr: recorded };
  const listCalls = (reqs: InstallationHttpRequest[]) => reqs.filter((r) => r.path === "/repos/acme/widgets/pulls");

  it("a recorded branch that is not fx/issue-<n> is found and reviewed: the reviewers are told that branch and GitHub is never asked for the issue's", async () => {
    const t = setup(runner());
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "merged", detail: undefined });
    // R3c: a runner repo's file list has paths and no patches, so the security reviewer is required as well.
    expect(rolesOf(t.started).sort()).toEqual(["acceptance-tester", "code-reviewer", "security-reviewer"]);
    for (const req of t.started) {
      expect(req.prompt).toContain(`Its branch is ${RUN_BRANCH};`);
      // D#6 R4d-4a (C33): a runner repo's reviewers are told the workspace is already at the head (detached), with no fetch or checkout.
      expect(req.prompt).toContain(`already checked out at commit ${H1}, with a detached HEAD`);
      expect(req.prompt).toContain("git diff origin/main...HEAD");
      for (const banned of ["git fetch", "git checkout", "git push", "api.github.com", "/pulls", "--force"]) expect(req.prompt, banned).not.toContain(banned);
      expect(req.expectedExecutionMode).toBe("runner_local");
      expect(req.prompt).not.toContain("fx/issue-7");
    }
    // The pull request is found with the list call (A3) for the recorded branch, and the issue's branch is never asked for.
    expect(listCalls(t.requests).map((r) => r.query)).toEqual([{ state: "open", head: `acme:${RUN_BRANCH}`, per_page: 5 }]);
    expect(t.requests.some((r) => r.path === "/repos/acme/widgets/pulls/41")).toBe(false);
    expect(JSON.stringify(t.requests)).not.toContain("fx/issue-7");
    // The files came from the fixed GraphQL document, not from the REST file list (which carries patches).
    expect(t.requests.some((r) => r.path.endsWith("/files"))).toBe(false);
    expect(t.requests.some((r) => r.method === "POST" && r.path === "/graphql")).toBe(true);
    expect(t.worker.advanceMergeGate).toHaveBeenCalledWith(WHO, 41);
  });

  it("D#6 R4d-1: the fix round of a runner repo is the runner variant (stay on the checked-out branch, commit, no push, no GitHub call) and names the mode it was built for; a sandbox repo's keeps the push", async () => {
    const needsFix = (role: string, head: string) =>
      head === H1 && role === "code-reviewer" ? { status: "succeeded", envelope: { verdict: "needs-fix", findings: ["src/a.ts:3 - off by one"], summary: "one problem" } } : { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "fine" } };
    const rounds = [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "all_passed", round: 1 }];
    const t = setup(runner({ verdict: needsFix, rounds }));
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
    const req = t.worker.advanceStartFix.mock.calls[0]![1];
    expect(req.expectedExecutionMode).toBe("runner_local");
    for (const banned of ["git push", "git checkout", "git reset", "git fetch", "checkout -b", "api.github.com", "/pulls", "--force"]) expect(req.prompt, banned).not.toContain(banned);
    expect(req.prompt).toContain("Do not push");
    expect(req.prompt).toContain("src/a.ts:3 - off by one");

    const s = setup(fresh({ verdict: needsFix, rounds }));
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
    const sandboxReq = s.worker.advanceStartFix.mock.calls[0]![1];
    expect(sandboxReq.expectedExecutionMode).toBe("sandbox");
    expect(sandboxReq.prompt).toContain("git push origin fx/issue-7");
  });

  it("the fix round of a runner repo never names the issue's branch (it works on the checked-out one)", async () => {
    const needsFix = (role: string, head: string) =>
      head === H1 && role === "code-reviewer" ? { status: "succeeded", envelope: { verdict: "needs-fix", findings: ["src/a.ts:3 - off by one"], summary: "one problem" } } : { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "fine" } };
    const t = setup(runner({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "all_passed", round: 1 }] }));
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
    const req = t.worker.advanceStartFix.mock.calls[0]![1];
    expect(req.prompt).not.toContain("fx/issue-7");
    expect(req.prompt).not.toContain(RUN_BRANCH);
  });

  it("no record: the review fails closed as no_open_pr, starts no reviewer and never looks up the issue's branch", async () => {
    const t = setup(runner({ recorded: null }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "no_pr", detail: "no_open_pr" });
    expect(t.started).toEqual([]);
    expect(t.requests).toEqual([]);
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
  });

  it("no record and 'Check the build': the item goes to Needs human and no reviewer starts", async () => {
    const t = setup(runner({ recorded: null }), { ...RUNNER_PR, recordedPr: null, stage: "in_progress", executorRunId: "66666666-6666-4666-8666-666666666666" });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_no_pull_request" });
    expect(t.started).toEqual([]);
    expect(t.requests).toEqual([]);
  });

  it("a recorded pull request that GitHub no longer has open ends the same way, and a GitHub error decides nothing", async () => {
    const gone = setup(runner({ noPr: true }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "no_pr", detail: "no_open_pr" });
    expect(gone.started).toEqual([]);
    const down = setup(runner({ githubDown: true }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "no_pr", detail: "github_unavailable" });
    expect(down.started).toEqual([]);
  });

  it("Build again for a runner repository looks at the recorded pull request, not the issue's branch: an open one stops it, none lets the build start", async () => {
    const STUCK: AdvanceItem = { ...RUNNER_PR, stage: "needs_human", executorRunId: "66666666-6666-4666-8666-666666666666" };
    const open = setup(runner(), STUCK);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "rebuild_pr_open" });
    expect(open.worker.advanceBuild).not.toHaveBeenCalled();
    expect(JSON.stringify(open.requests)).not.toContain("fx/issue-7");
    const none = setup(runner({ recorded: null }), { ...STUCK, recordedPr: null });
    none.worker.advanceBuild.mockResolvedValue({ status: "refused", reason: "start_no_model" });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_refused:start_no_model" });
    expect(none.worker.advanceBuild).toHaveBeenCalledTimes(1);
    expect(none.requests).toEqual([]);
  });

  it("a sandbox repository is unchanged: found by fx/issue-<n>, prompts name it, and a stray recorded pull request is not used", async () => {
    const t = setup(fresh({ recorded }));
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
    expect(listCalls(t.requests)).toHaveLength(1);
    expect(t.requests.some((r) => r.path === "/repos/acme/widgets/pulls/41")).toBe(false);
    for (const req of t.started) expect(req.prompt).toContain("Its branch is fx/issue-7;");
    // D#6 R4d-4a (C33): the reviewers' prompt is the sandbox variant, with its fetch and checkout, and says which mode it was built for.
    for (const req of t.started) {
      expect(req.prompt).toContain(`git fetch origin fx/issue-7 && git checkout ${H1}`);
      expect(req.prompt).not.toContain("detached HEAD");
      expect(req.expectedExecutionMode).toBe("sandbox");
    }
  });
});

/**
 * D#6 C29 section 3.1: the build waits for the webhook to move the item, and a runner's pull request body carries no issue
 * reference, so the webhook never does. After the grace polls the build runs the same lookup "Check the build" uses.
 */
describe("the build finds the pull request itself when the webhook did not move the item (D#6 C29 section 3.1)", () => {
  const RUN_BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
  const recorded = { number: 41, branch: RUN_BRANCH };
  const SPEC_READY: AdvanceItem = { ...AT_PR, stage: "spec_ready", kind: "bug", executionMode: "runner_local", recordedPr: null };
  const PR_GRACE_POLLS = 9;

  /** The item reads Spec ready at the load and In progress ever after (the webhook never moved it); the executor run ended `succeeded`. */
  function built(w: World, item: AdvanceItem = SPEC_READY) {
    const t = setup(w, item);
    let loads = 0;
    t.worker.advanceLoadItem.mockImplementation(async () => (++loads === 1 ? item : { ...item, stage: "in_progress" }));
    t.worker.advanceBuild.mockResolvedValue({ status: "started", runId: "run-b", branch: RUN_BRANCH });
    const reviewers = t.worker.advanceRunOutcome.getMockImplementation()!;
    t.worker.advanceRunOutcome.mockImplementation(async (account: string, runId: string) => (runId === "run-b" ? { status: "succeeded", done: true, envelope: { summary: "I opened the pull request." } } : reviewers(account, runId)));
    return t;
  }

  it("a runner's pull request without 'Closes #N' is found through what its done recorded: the item moves to PR opened and the review follows", async () => {
    const t = built(fresh({ mode: "runner_local", recorded }));
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out).toEqual({ status: "merged", detail: undefined });
    // The webhook was given its whole grace period first.
    expect(world.sleeps).toBeGreaterThanOrEqual(PR_GRACE_POLLS);
    expect(t.worker.advancePrFound).toHaveBeenCalledWith(WHO, 41);
    expect(t.worker.advanceBuildFailed).not.toHaveBeenCalled();
    expect(rolesOf(t.started).sort()).toEqual(["acceptance-tester", "code-reviewer", "security-reviewer"]);
    // It was found through the recorded branch (the list call), never searched for by the issue's branch.
    expect(t.requests.some((r) => r.path === "/repos/acme/widgets/pulls/41")).toBe(false);
    expect(t.requests.filter((r) => r.path === "/repos/acme/widgets/pulls").every((r) => r.query?.head === `acme:${RUN_BRANCH}`)).toBe(true);
  });

  it("none recorded and none open ends at Needs human as no_pull_request, as before", async () => {
    const t = built(fresh({ mode: "runner_local", recorded: null }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_no_pull_request" });
    expect(t.worker.advanceBuildFailed).toHaveBeenCalledWith(ACCOUNT, ITEM, "run-b", "no_pull_request");
    expect(t.worker.advancePrFound).not.toHaveBeenCalled();
    expect(t.started).toEqual([]);
  });

  it("a recorded pull request that GitHub no longer has open is the same end", async () => {
    const t = built(fresh({ mode: "runner_local", recorded, noPr: true }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "build_no_pull_request" });
    expect(t.worker.advancePrFound).not.toHaveBeenCalled();
  });

  it("a lookup that failed decides nothing: the existing 'could not check' stop, and the item is not sent to Needs human", async () => {
    const t = built(fresh({ mode: "runner_local", recorded, githubDown: true }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "no_pr", detail: "github_unavailable" });
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "check_build_unavailable" }));
    expect(t.worker.advanceBuildFailed).not.toHaveBeenCalled();
    expect(t.worker.advancePrFound).not.toHaveBeenCalled();
  });

  it("a review context that cannot be loaded stops the same way", async () => {
    const t = built(fresh({ mode: "runner_local", recorded, loadReview: { ok: false, reason: "spec_changed" } }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "failed", detail: "check_build_spec_changed" });
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "check_build_unavailable" }));
    expect(t.worker.advanceBuildFailed).not.toHaveBeenCalled();
  });

  it("every mode: a sandbox build whose webhook was lost is picked up by fx/issue-<n>", async () => {
    const t = built(fresh(), { ...SPEC_READY, executionMode: "sandbox" });
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
    expect(t.worker.advancePrFound).toHaveBeenCalledWith(WHO, 41);
    expect(t.requests.find((r) => r.path === "/repos/acme/widgets/pulls")!.query).toMatchObject({ head: "acme:fx/issue-7" });
  });

  it("when the webhook already moved the item, no lookup is made", async () => {
    const t = built(fresh({ mode: "runner_local", recorded }));
    let loads = 0;
    t.worker.advanceLoadItem.mockImplementation(async () => (++loads === 1 ? SPEC_READY : { ...SPEC_READY, stage: "pr_opened" }));
    await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advancePrFound).not.toHaveBeenCalled();
    expect(t.worker.advanceBuildFailed).not.toHaveBeenCalled();
  });
});

// A reviewer run that ended without a verdict (killed at a memory limit, a lost runner, cancelled) is never used as one: it is run again on the same head.
describe("reviewers that end without a verdict", () => {
  const PASS = { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "fine" } };
  const OOM = { status: "failed", envelope: null, failureReason: "resource_limit" };
  const stepsOf = (started: AdvanceRunRequest[], role: string) => started.filter((s) => s.role === role).map((s) => s.step);

  it("an earlier round's failed and cancelled reviewers are run again on the same head; the genuine pass on that head is reused, and the item merges", async () => {
    // The live case: security passed, the code reviewer was killed at its memory limit, the acceptance tester was cancelled; then Approve again.
    const first = new Set([reviewStep(H1, "code-reviewer"), reviewStep(H1, "acceptance-tester")]);
    const w = fresh({
      tier: "critical",
      listRuns: true,
      realDecide: true,
      verdict: (role, _head, step) => (!first.has(step) ? PASS : role === "code-reviewer" ? OOM : { status: "cancelled", envelope: null }),
    });
    const t = setup(w);
    for (const role of ["code-reviewer", "acceptance-tester", "security-reviewer"]) await t.worker.advanceStartRun({ step: reviewStep(H1, role), role, headSha: H1 } as AdvanceRunRequest);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged", detail: undefined });
    // Each re-run is a NEW key on the same head (the next attempt), so it can never land on the run that ended without a verdict.
    expect(stepsOf(t.started, "code-reviewer")).toEqual([reviewStep(H1, "code-reviewer"), reviewStep(H1, "code-reviewer", 0, 1)]);
    expect(stepsOf(t.started, "acceptance-tester")).toEqual([reviewStep(H1, "acceptance-tester"), reviewStep(H1, "acceptance-tester", 0, 1)]);
    expect(stepsOf(t.started, "security-reviewer")).toEqual([reviewStep(H1, "security-reviewer")]);
    const input = t.worker.advanceRecordRound.mock.calls[0]![1];
    expect(input.verdicts.map((v) => [v.role, v.verdict, v.noVerdict ?? false])).toEqual([["code-reviewer", "pass", false], ["acceptance-tester", "pass", false], ["security-reviewer", "pass", false]]);
    expect(input.verdicts.find((v) => v.role === "security-reviewer")!.runId).toBe("run-3-security-reviewer");
    expect(logs.filter((l) => l.event === "advance.review_rerun").map((l) => [l.role, l.reason])).toEqual([["code-reviewer", "resource_limit"], ["acceptance-tester", "cancelled"]]);
    // The activity shows each re-run as its own start.
    const startedKeys = t.worker.advanceRecordEvent.mock.calls.map((c) => c[1]).filter((e) => e.kind === "review_started").map((e) => (e as { dedupeKey?: string }).dedupeKey);
    expect(startedKeys).toEqual(expect.arrayContaining([`review:${H1}:code-reviewer:s1`, `review:${H1}:acceptance-tester:s1`]));
  });

  it("a succeeded run that left no verdict is run again too", async () => {
    let calls = 0;
    const w = fresh({ listRuns: true, realDecide: true, verdict: (role) => (role === "code-reviewer" && calls++ === 0 ? { status: "succeeded", envelope: { summary: "no verdict here" } } : PASS) });
    const t = setup(w);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged", detail: undefined });
    expect(stepsOf(t.started, "code-reviewer")).toHaveLength(2);
  });

  it("a genuine fail is not run again and stops at reviewer_fail", async () => {
    const t = setup(fresh({ listRuns: true, realDecide: true, verdict: (role) => (role === "code-reviewer" ? { status: "succeeded", envelope: { verdict: "fail" } } : PASS) }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "needs_human", detail: "reviewer_fail" });
    expect(stepsOf(t.started, "code-reviewer")).toHaveLength(1);
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].verdicts.every((v) => v.noVerdict === undefined)).toBe(true);
  });

  it("a genuine needs-fix still starts a fix round, and is not run again on its head", async () => {
    const t = setup(fresh({ listRuns: true, realDecide: true, verdict: (role, head) => (role === "code-reviewer" && head === H1 ? { status: "succeeded", envelope: { verdict: "needs-fix", findings: ["x"] } } : PASS) }));
    await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceStartFix).toHaveBeenCalledTimes(1);
    expect(stepsOf(t.started, "code-reviewer").filter((s) => s.startsWith(`review:${H1}:`))).toEqual([reviewStep(H1, "code-reviewer")]);
  });

  it("a reviewer that keeps ending without a verdict is run maxFixRounds() times on the head, then the item goes to a person, named, with how it ended", async () => {
    const t = setup(fresh({ listRuns: true, realDecide: true, verdict: (role) => (role === "code-reviewer" ? OOM : PASS) }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "needs_human", detail: "reviewer_no_verdict" });
    expect(stepsOf(t.started, "code-reviewer")).toEqual(Array.from({ length: maxFixRounds() }, (_, i) => reviewStep(H1, "code-reviewer", 0, i)));
    expect(t.worker.advanceStartFix).not.toHaveBeenCalled();
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].verdicts.find((x) => x.role === "code-reviewer")).toMatchObject({ verdict: "fail", noVerdict: true, endCode: "resource_limit" });
    expect(logs.find((l) => l.event === "advance.stopped")).toMatchObject({ reason: "reviewer_no_verdict", roles: "code-reviewer", ends: "resource_limit" });
  });

  it("a spending limit that denies a re-run is a pause, not a missing verdict", async () => {
    const t = setup(fresh({ listRuns: true, realDecide: true, verdict: (role) => (role === "code-reviewer" ? OOM : PASS) }));
    const real = t.worker.advanceStartRun.getMockImplementation()!;
    t.worker.advanceStartRun.mockImplementation(async (req: AdvanceRunRequest) => (req.step.endsWith(":s1") ? ({ ok: false, reason: "account_budget_reached" } as never) : real(req)));
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out.detail ?? "").toContain("account_budget_reached");
    expect(t.worker.advanceRecordRound).not.toHaveBeenCalled();
  });
});

// Approve at Needs a person after a reviewer kept ending without a verdict: the open pull request is reviewed again (the table's `no_verdict_hold`).
describe("Approve after a reviewer gave up (Needs a person, reviewer_no_verdict)", () => {
  const HELD: AdvanceItem = { ...AT_PR, stage: "needs_human", reviewHold: true, executorRunId: "66666666-6666-4666-8666-666666666666" };
  const PASS = { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "fine" } };
  const OOM = { status: "failed", envelope: null, failureReason: "resource_limit" };
  const reviewerSteps = (started: AdvanceRunRequest[], role: string) => started.filter((s) => s.role === role).map((s) => s.step);

  it("the pull request is still open: the reviewers check its latest commit, nothing is built, and the item can merge", async () => {
    const t = setup(fresh({ listRuns: true, realDecide: true, verdict: () => PASS }), HELD);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged", detail: undefined });
    expect(t.worker.advanceBuild).not.toHaveBeenCalled();
    expect(reviewerSteps(t.started, "code-reviewer")).toEqual([reviewStep(H1, "code-reviewer")]);
    expect(t.worker.advanceRecordEvent).not.toHaveBeenCalledWith(WHO, expect.objectContaining({ code: "rebuild_pr_open" }));
  });

  it("no pull request is open: the lookup falls back to Build again, as before", async () => {
    const t = setup(fresh({ noPr: true }), HELD);
    t.worker.advanceBuild.mockResolvedValue({ status: "started", runId: "77777777-7777-4777-8777-777777777777", branch: "fx/issue-7" });
    await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceBuild).toHaveBeenCalled();
    expect(t.started).toEqual([]);
  });

  it("any other cause (no hold): an open pull request still stops the rebuild, nothing started", async () => {
    const t = setup(fresh(), { ...HELD, reviewHold: false });
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "stopped", detail: "rebuild_pr_open" });
    expect(t.started).toEqual([]);
    expect(t.worker.advanceBuild).not.toHaveBeenCalled();
  });

  it("a reviewer that gives up again goes back to a person, bounded by the STORED count: stored ends at the bound mean the one end in this workflow is not re-run (a workflow restarted by a spending-limit pause starts its own count at 1)", async () => {
    const t = setup(fresh({ listRuns: true, realDecide: true, storedNoVerdict: { "code-reviewer": maxFixRounds() }, verdict: (role) => (role === "code-reviewer" ? OOM : PASS) }), HELD);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "needs_human", detail: "reviewer_no_verdict" });
    expect(reviewerSteps(t.started, "code-reviewer")).toEqual([reviewStep(H1, "code-reviewer")]);
  });

  it("with fewer stored ends than the bound the reviewer is run again (the stored count is a floor under the workflow's own, never a replacement)", async () => {
    const t = setup(fresh({ listRuns: true, realDecide: true, storedNoVerdict: { "code-reviewer": 1 }, verdict: (role, _h, step) => (role === "code-reviewer" && step === reviewStep(H1, "code-reviewer") ? OOM : PASS) }), HELD);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged", detail: undefined });
    expect(reviewerSteps(t.started, "code-reviewer")).toEqual([reviewStep(H1, "code-reviewer"), reviewStep(H1, "code-reviewer", 0, 1)]);
  });
});

// Request changes: a person's note waits for its fix round, which the driver starts before any review (the reviewers had passed).
describe("Request changes: a person's fix round comes first", () => {
  const AT_CHANGES: AdvanceItem = { ...AT_PR, stage: "changes_requested" };
  const PASS = { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "fine" } };

  it("the fix round starts on the pull request's current head, marked as the person's, numbered after the rounds already used; then the reviewers check the NEW head and the merge is checked", async () => {
    const t = setup(fresh({ personRequest: true, fixRoundsStarted: 1, listRuns: true, realDecide: true, verdict: () => PASS }), AT_CHANGES);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged", detail: undefined });
    expect(t.worker.advanceStartFix).toHaveBeenCalledTimes(1);
    const [who, req] = t.worker.advanceStartFix.mock.calls[0]!;
    expect(who).toEqual(WHO);
    expect(req).toMatchObject({ issue: 7, headSha: H1, round: 2, person: true, actionId: ARGS.actionId, reviewer: "acceptance" });
    expect(req.failingRunId).toBeUndefined();
    expect(req.prompt.startsWith("You are the executor. A person who owns this work asked for changes on pull request #41")).toBe(true);
    expect(req.prompt).not.toContain("REVIEWER FINDINGS:");
    // No reviewer ran on the head the person asked about; both ran on the head the fix pushed.
    expect(t.started.filter((s) => s.headSha === H1)).toEqual([]);
    expect(t.started.filter((s) => s.headSha === H2).map((s) => s.role).sort()).toEqual(["acceptance-tester", "code-reviewer"]);
    expect(t.worker.advanceMergeGate).toHaveBeenCalledTimes(1);
  });

  it("a reviewer that asked for changes on that same head has its findings passed alongside the note", async () => {
    const asks = (role: string, head: string) => (role === "code-reviewer" && head === H1 ? { status: "succeeded", envelope: { verdict: "needs-fix", findings: ["src/a.ts:3 - wrong word"], summary: "one" } } : PASS);
    const w = fresh({ listRuns: true, realDecide: true, verdict: asks, fixPushes: null });
    const t = setup(w, AT_CHANGES);
    // A first review of H1 leaves the code reviewer's needs-fix keyed on that head; its fix is refused, so the item waits for a person.
    w.fix = { ok: false, reason: "resume_failed" };
    await workItemAdvanceWorkflow(ARGS);
    w.fix = { ok: true };
    w.fixPushes = H2;
    w.personRequest = true;
    t.worker.advanceStartFix.mockClear();
    expect((await workItemAdvanceWorkflow({ ...ARGS, actionId: "66666666-6666-4666-8666-666666666666" })).status).toBe("merged");
    const req = t.worker.advanceStartFix.mock.calls[0]![1];
    expect(req.person).toBe(true);
    expect(req.reviewer).toBe("code");
    expect(req.prompt).toContain("REVIEWER FINDINGS:");
    expect(req.prompt).toContain("src/a.ts:3 - wrong word");
  });

  it("a fix that pushes nothing stops for a person: nothing is reviewed or merged", async () => {
    const t = setup(fresh({ personRequest: true, fixPushes: null }), AT_CHANGES);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "needs_human", detail: "person_fix_pushed_nothing" });
    expect(t.started).toEqual([]);
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "fix_pushed_nothing", code: "person_request" }));
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "person_fix_pushed_nothing" }));
  });

  it("a spending limit makes it wait like any fix round, and asks again as a new attempt; nothing is reviewed meanwhile", async () => {
    const w = fresh({ personRequest: true });
    const t = setup(w, AT_CHANGES);
    let asks = 0;
    t.worker.advanceStartFix.mockImplementation(async (_who: unknown, req: AdvanceFixRequest) => {
      asks += 1;
      if (asks === 1) return { ok: false as const, reason: "account_budget_reached" };
      w.head = H2;
      return { ok: true as const, runId: `fix-${req.round}` };
    });
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
    const calls = t.worker.advanceStartFix.mock.calls.map((c) => c[1]);
    expect(calls.map((r) => r.spendAttempt)).toEqual([undefined, 1]);
    expect(calls.every((r) => r.person === true)).toBe(true);
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stage_waiting", stage: "fix_round", code: "account_budget_reached" }));
  });

  it("a refused start (the fix-round limit, among others) ends with the refusal recorded and nothing reviewed", async () => {
    const t = setup(fresh({ personRequest: true, fix: { ok: false, reason: "max_fix_rounds" } }), AT_CHANGES);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "fix_refused", detail: "max_fix_rounds" });
    expect(t.started).toEqual([]);
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "max_fix_rounds" }));
  });

  it("with no request pending, Continue the review runs the reviewers first, as before", async () => {
    const t = setup(fresh(), AT_CHANGES);
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
    expect(t.worker.advanceStartFix).not.toHaveBeenCalled();
    expect(t.started.filter((s) => s.headSha === H1).length).toBeGreaterThan(0);
  });
});


describe("a merge handed to the customer's runner (merge_delegated): the workflow waits for the order, and only the order's end decides", () => {
  const delegated = { outcome: "merge_delegated", reasons: [] as string[], status: "posted" };
  const open = { state: "open", code: null };

  it("waits (a durable sleep, then one read of the order) until GitHub, read by the cloud, says merged: the workflow ends merged", async () => {
    const t = setup(fresh({ gates: [delegated], orders: [open, open, { state: "merged", code: "merged" }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged" });
    expect(t.worker.advanceMergeGate).toHaveBeenCalledTimes(1);
    expect(t.worker.advanceMergeOrder).toHaveBeenCalledTimes(3);
    expect(t.worker.advanceMergeOrder).toHaveBeenCalledWith(WHO);
    expect(world.sleeps).toBe(2);
    expect(logs.find((l) => l.event === "advance.merge_order")).toMatchObject({ state: "merged" });
  });

  it("the merge-only re-check path waits the same way", async () => {
    const t = setup(fresh({ mergeOnly: [{ decision: "all_passed" }], gates: [delegated], orders: [open, { state: "merged", code: "merged" }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "merged" });
    expect(t.worker.advanceMergeOrder).toHaveBeenCalledTimes(2);
    expect(t.worker.advanceRecordRound).not.toHaveBeenCalled();
  });

  it("a head that moved (the order ended head_moved or was superseded) goes back to the review loop: the gate is asked again on the new head", async () => {
    const t = setup(fresh({ head: H1, gates: [delegated, { outcome: "merged", reasons: [], status: "posted" }], orders: [open, { state: "head_moved", code: "public_head_moved" }], rounds: [{ decision: "all_passed", round: 0 }] }));
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(out.status).toBe("merged");
    expect(t.worker.advanceMergeGate).toHaveBeenCalledTimes(2);
  });

  it("a block the go phase found (the gate already recorded its reasons) ends ready_human_merges with the order's code and writes no second event", async () => {
    const t = setup(fresh({ gates: [delegated], orders: [open, { state: "blocked", code: "ci_not_green", gateRecorded: true }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "ready_human_merges", detail: "ci_not_green" });
    expect(t.worker.advanceRecordEvent).not.toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "merge_gate" }));
  });

  it("a stop the gate never saw is recorded as the gate's own fact, so the card says why: a claim-time takeover or pairing change, a go phase that was refused or found the pull request closed, a failed order, a timeout", async () => {
    const cases = [
      ["blocked", "public_branch_person_managed"],
      ["blocked", "pairing_changed"],
      ["blocked", "public_pr_not_open"],
      ["blocked", "no_pull_request"],
      ["blocked", "go_not_applicable"],
      ["failed", "runner_merge_failed"],
      ["failed", "runner_merge_timeout"],
      ["failed", "runner_report_mismatch"],
    ] as const;
    for (const [state, code] of cases) {
      const t = setup(fresh({ gates: [delegated], orders: [open, { state, code, gateRecorded: false }] }));
      expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "ready_human_merges", detail: code });
      expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "merge_gate", code: "ready_human_merges", reasons: [code], headSha: H1, prNumber: 41 }));
    }
  });

  it("an order that does not exist is a stop, not a wait; a refused step is needs_human", async () => {
    const none = setup(fresh({ gates: [delegated], orders: [{ state: "none", code: null }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "ready_human_merges", detail: "runner_merge_failed" });
    expect(none.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ reasons: ["runner_merge_failed"] }));
    setup(fresh({ gates: [delegated], orders: [{ state: "refused", code: "item_halted" }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toMatchObject({ status: "needs_human", detail: "item_halted" });
  });

  it("the wait is bounded: an order that never ends stops the workflow with runner_merge_timeout after the poll limit, and the polling stops there", async () => {
    const t = setup(fresh({ gates: [delegated], orders: [open] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "ready_human_merges", detail: "runner_merge_timeout" });
    expect(t.worker.advanceMergeOrder).toHaveBeenCalledTimes(130);
    expect(world.sleeps).toBe(130);
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ reasons: ["runner_merge_timeout"] }));
  });

  it("no order is looked at unless the gate delegated: every other outcome ends exactly as before", async () => {
    const t = setup(fresh({ gates: [{ outcome: "ready_human_merges", reasons: ["ci_not_green"], status: "posted" }] }));
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "ready_human_merges", detail: "ci_not_green" });
    expect(t.worker.advanceMergeOrder).not.toHaveBeenCalled();
  });
});
