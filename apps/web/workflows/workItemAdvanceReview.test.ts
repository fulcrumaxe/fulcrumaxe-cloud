import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceFixRequest, AdvanceItem, AdvanceRoundInput, AdvanceRunOutcome, AdvanceRunRequest, AdvanceStartArgs, Worker } from "@fx/worker";
import type { InstallationHttp, InstallationHttpRequest } from "@fx/github";
import { decideRound, maxFixRounds } from "@fx/pipeline";

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
  /** GitHub answers the pull request lookup with a server error. */
  githubDown?: boolean;
  tier: string;
  debaterEnabled: boolean;
  /** (role) -> the verdict the reviewer run ends with. A function of the head the run is for. */
  verdict: (role: string, head: string) => { status?: string; envelope?: Record<string, unknown> | null; done?: boolean };
  /** The decision the worker's round returns, per call. */
  rounds: Array<{ decision: string; round?: number; nextRound?: number | null }>;
  /** The fix start. */
  fix: { ok: boolean; reason?: string };
  /** What the fix run does to the head when it ends. */
  fixPushes: string | null;
  fixOutcome: AdvanceRunOutcome;
  gates: Array<{ outcome: string; reasons?: string[]; status?: string }>;
  refuseStart: Set<string>;
  pinned: number;
  loadReview: { ok: boolean; reason?: string; specVersion?: number };
  /** `runner_local`: the repository's agents run on a runner; `recorded` is what its run's `done` recorded (null: nothing). */
  mode?: "runner_local";
  recorded?: { number: number; branch: string } | null;
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
  const runs = new Map<string, { role: string; head: string }>();
  const started: AdvanceRunRequest[] = [];
  const rounds = [...w.rounds];
  const gates = [...w.gates];
  let n = 0;
  const worker = {
    advanceLoadItem: vi.fn(async () => item),
    advanceLoadReview: vi.fn(async () =>
      w.loadReview.ok
        ? { ok: true as const, ctx: { workItemId: ITEM, stage: "pr_opened", repoId: REPO, owner: "acme", name: "widgets", issue: 7, tier: w.tier, specVersion: w.loadReview.specVersion ?? w.pinned, debaterEnabled: w.debaterEnabled, executionMode: w.mode ?? "sandbox", recordedPr: w.recorded ?? null } }
        : { ok: false as const, reason: w.loadReview.reason ?? "no_spec" },
    ),
    advanceLoadSpecText: vi.fn(async (_who: unknown, v: number) => (v === w.pinned ? { version: v, body: "SPEC BODY: the footer shows the year." } : null)),
    advanceStartRun: vi.fn(async (req: AdvanceRunRequest) => {
      started.push(req);
      if (w.refuseStart.has(req.role)) return { ok: false as const, reason: "no_model" };
      const id = `run-${++n}-${req.role}`;
      runs.set(id, { role: req.role, head: req.headSha ?? "" });
      return { ok: true as const, runId: id };
    }),
    advanceRunOutcome: vi.fn(async (_acct: string, runId: string): Promise<AdvanceRunOutcome> => {
      if (runId.startsWith("fix-")) return w.fixOutcome;
      const r = runs.get(runId);
      if (!r) return { status: "missing", done: true, envelope: null };
      const v = w.verdict(r.role, r.head);
      return { status: v.status ?? "succeeded", done: v.done ?? true, envelope: v.envelope === undefined ? { verdict: "pass", findings: [], summary: "fine" } : v.envelope };
    }),
    advanceRecordRound: vi.fn(async (_who: unknown, input: Omit<AdvanceRoundInput, "accountId" | "workItemId">) => {
      const r = rounds.length > 1 ? rounds.shift()! : rounds[0]!;
      return { decision: r.decision, round: r.round ?? 0, ...(r.nextRound !== null ? { nextRound: r.nextRound ?? (r.round ?? 0) + 1 } : {}), recorded: input.verdicts.map((v) => ({ role: v.role, runId: v.runId, verdict: v.verdict, outcome: "passed" })) };
    }),
    advanceStartFix: vi.fn(async (_who: unknown, req: AdvanceFixRequest) => {
      if (!w.fix.ok) return { ok: false as const, reason: w.fix.reason ?? "already_running" };
      if (w.fixPushes) w.head = w.fixPushes;
      return { ok: true as const, runId: `fix-${req.round}` };
    }),
    advanceMergeGate: vi.fn(async () => (gates.length > 1 ? gates.shift()! : gates[0]!)),
    advanceRecordEvent: vi.fn(async (_who: unknown, _e: { kind: string; code?: string; reasons?: string[]; headSha?: string; prNumber?: number; runId?: string }) => ({ recorded: true })),
    advanceCancel: vi.fn(async () => undefined),
    advanceBuild: vi.fn(),
    advanceBuildFailed: vi.fn(async () => ({ status: "recorded", stage: "needs_human" })),
    advancePrFound: vi.fn(async () => ({ status: "recorded", stage: "pr_opened" })),
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
        return { status: 200, body: [{ number: 41, head: { sha: w.head, ref: "fx/issue-7", repo: { full_name: "acme/widgets" } }, base: { ref: "main" } }] };
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

  it("waits durably for a reviewer that is still going", async () => {
    let polls = 0;
    const w = fresh({ verdict: (role) => (role === "code-reviewer" && polls++ < 3 ? { status: "running", done: false, envelope: null } : { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "" } }) });
    setup(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(world.sleeps).toBe(3);
  });

  it("a reviewer that never ends is cancelled after 45 minutes and counts as a fail, not a pass", async () => {
    const w = fresh({ verdict: (role) => (role === "code-reviewer" ? { status: "running", done: false, envelope: null } : { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "" } }), rounds: [{ decision: "reviewer_fail" }] });
    const t = setup(w);
    const out = await workItemAdvanceWorkflow(ARGS);
    expect(world.sleeps).toBe(90);
    expect(t.worker.advanceCancel).toHaveBeenCalledWith(WHO, expect.stringContaining("code-reviewer"));
    const input = t.worker.advanceRecordRound.mock.calls[0]![1];
    expect(input.verdicts.find((v) => v.role === "code-reviewer")!.verdict).toBe("fail");
    expect(out).toEqual({ status: "needs_human", detail: "reviewer_fail" });
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

  it.each(["failed", "timed_out", "cancelled", "killed_spend", "refused_spend"])("a reviewer run that ended %s is a fail even when its envelope says pass", async (status) => {
    const w = fresh({ verdict: () => ({ status, envelope: { verdict: "pass" } }), rounds: [{ decision: "reviewer_fail" }] });
    const t = setup(w);
    await workItemAdvanceWorkflow(ARGS);
    expect(t.worker.advanceRecordRound.mock.calls[0]![1].verdicts.map((v) => v.verdict)).toEqual(["fail", "fail"]);
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
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "stopped", code: "not_started_acceptance_tester" }));
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

  it("a fix that left the head unchanged pushed nothing: it stops, records that, and never reviews the same commit again", async () => {
    const w = fresh({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }], fixPushes: null });
    const t = setup(w);
    expect(await workItemAdvanceWorkflow(ARGS)).toEqual({ status: "fix_pushed_nothing" });
    expect(t.started).toHaveLength(2);
    expect(t.worker.advanceRecordRound).toHaveBeenCalledTimes(1);
    expect(t.worker.advanceMergeGate).not.toHaveBeenCalled();
    expect(t.worker.advanceRecordEvent).toHaveBeenCalledWith(WHO, expect.objectContaining({ kind: "fix_pushed_nothing", headSha: H1, prNumber: 41, runId: "fix-1" }));
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
    expect(rolesOf(t.started).sort()).toEqual(["acceptance-tester", "code-reviewer"]);
    for (const req of t.started) {
      expect(req.prompt).toContain(`Its branch is ${RUN_BRANCH};`);
      expect(req.prompt).toContain(`git fetch origin ${RUN_BRANCH} && git checkout ${H1}`);
      expect(req.prompt).not.toContain("fx/issue-7");
    }
    expect(listCalls(t.requests)).toEqual([]);
    expect(t.requests.some((r) => r.path === "/repos/acme/widgets/pulls/41")).toBe(true);
    expect(t.worker.advanceMergeGate).toHaveBeenCalledWith(WHO, 41);
  });

  it("the fix round's prompt carries the recorded branch", async () => {
    const needsFix = (role: string, head: string) =>
      head === H1 && role === "code-reviewer" ? { status: "succeeded", envelope: { verdict: "needs-fix", findings: ["src/a.ts:3 - off by one"], summary: "one problem" } } : { status: "succeeded", envelope: { verdict: "pass", findings: [], summary: "fine" } };
    const t = setup(runner({ verdict: needsFix, rounds: [{ decision: "fix", round: 0, nextRound: 1 }, { decision: "all_passed", round: 1 }] }));
    expect((await workItemAdvanceWorkflow(ARGS)).status).toBe("merged");
    const req = t.worker.advanceStartFix.mock.calls[0]![1];
    expect(req.prompt).toContain(`git fetch origin ${RUN_BRANCH} && git checkout ${RUN_BRANCH} && git reset --hard origin/${RUN_BRANCH}`);
    expect(req.prompt).toContain(`git push origin ${RUN_BRANCH}`);
    expect(req.prompt).not.toContain("fx/issue-7");
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
    expect(listCalls(open.requests)).toEqual([]);
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
    expect(rolesOf(t.started).sort()).toEqual(["acceptance-tester", "code-reviewer"]);
    // It was read by number, never searched for by the issue's branch.
    expect(t.requests.some((r) => r.path === "/repos/acme/widgets/pulls/41")).toBe(true);
    expect(t.requests.some((r) => r.path === "/repos/acme/widgets/pulls")).toBe(false);
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
