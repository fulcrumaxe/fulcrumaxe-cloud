import { beforeEach, describe, expect, it, vi } from "vitest";
import { RESERVATION_PAUSE_REASONS, type mergeQueue } from "@fx/pipeline";

/**
 * D#519 MQ3-b-2b (required by the 2a review): the web binding of the delta-review ports. The reviewer start, the review load and the pull request
 * lookup are the real ones' contract as the binding uses them (fakes below); the plan rule is the REAL `reviewPlanFor`, so a drift in the mapping
 * from tier, debater setting, security surface and flag to roles fails here.
 */
const h = vi.hoisted(() => ({
  facts: { halt_epoch: 4, u: "user-1" } as { halt_epoch?: number; u?: string },
  ctx: { ok: true, tier: "feature", debaterEnabled: false, repoId: "r", owner: "acme", name: "widgets", issue: 7, branch: "fx/issue-7", specVersion: 3, executionMode: "sandbox" } as Record<string, unknown>,
  pr: { ok: true, number: 41, headSha: "f".repeat(40), baseRef: "main", branch: "fx/issue-7", securityCodes: [] as string[] } as Record<string, unknown>,
  start: { runId: "run-1", reason: null } as { runId: string | null; reason: string | null },
  starts: [] as unknown[][],
  loads: 0,
}));

vi.mock("@fx/core/src/tenancy/withTenant.js", () => ({
  withTenant: async (_pool: unknown, _account: string, fn: (c: unknown) => unknown) =>
    fn({ query: async (sql: string) => ({ rows: sql.includes("halt_epoch") ? [{ halt_epoch: h.facts.halt_epoch }] : h.facts.u === undefined ? [] : [{ u: h.facts.u }] }) }),
}));
vi.mock("./advanceReviewSteps", () => ({
  reviewLoadBody: async () => (h.loads++, h.ctx),
  findPrBody: async () => h.pr,
  startReviewerBody: async (...args: unknown[]) => (h.starts.push(args), h.start),
  reviewerOutcomeBody: async (_w: unknown, _a: string, runId: string) => ({ done: runId === "done", verdict: "pass", securityNeeded: true, noVerdict: false }),
}));

import { deltaReviewPorts } from "./mergeQueueDeltaReview";

const entry = { id: "e1", accountId: "acct", workItemId: "item", headSha: "a".repeat(40), prNumber: 41 } as mergeQueue.MergeQueueEntry;
const DELTA = { mergeCommitSha: "b".repeat(40), parents: ["a".repeat(40), "c".repeat(40)], parentRoles: ["pr_side", "main_side"], changedFiles: ["src/a.ts"], trigger: "refresh_overlap" } as const;

function ports(over: { worker?: Record<string, unknown> | null } = {}) {
  const worker = over.worker === undefined ? { advanceCancel: vi.fn(async () => undefined), advanceRecordEvent: vi.fn(async () => ({ recorded: true })), advanceDeltaRuns: vi.fn(async () => [{ role: "code-reviewer", runId: "r1", attempt: 0, reusable: true }]) } : over.worker;
  return { worker, p: deltaReviewPorts({ pool: {} as never, worker: worker as never, open: (async () => ({})) as never, github: {} as never }) };
}

beforeEach(() => {
  h.facts = { halt_epoch: 4, u: "user-1" };
  h.ctx = { ok: true, tier: "feature", debaterEnabled: false, repoId: "r", owner: "acme", name: "widgets", issue: 7, branch: "fx/issue-7", specVersion: 3, executionMode: "sandbox" };
  h.pr = { ok: true, number: 41, headSha: "f".repeat(40), baseRef: "main", branch: "fx/issue-7", securityCodes: [] };
  h.start = { runId: "run-1", reason: null };
  h.starts = [];
  h.loads = 0;
});

describe("plan: the roles come from reviewPlanFor over the tier, the debater setting, the security surface and the flag", () => {
  const roles = async (o: { tier?: string; debater?: boolean; codes?: string[]; flagged?: boolean }) => {
    h.ctx = { ...h.ctx, tier: o.tier ?? "feature", debaterEnabled: o.debater ?? false };
    h.pr = { ...h.pr, securityCodes: o.codes ?? [] };
    const out = await ports().p.plan({ entry, headSha: "b".repeat(40), ...(o.flagged ? { flagged: true } : {}) });
    return out.ok ? [...out.roles].sort() : out;
  };
  it("a feature with no security surface: code reviewer and acceptance tester", async () => {
    expect(await roles({})).toEqual(["acceptance-tester", "code-reviewer"]);
  });
  it("a critical item adds the security reviewer by tier", async () => {
    expect(await roles({ tier: "critical" })).toContain("security-reviewer");
  });
  it("a security surface in the PR's diff adds it; the merge commit's own files do not matter", async () => {
    expect(await roles({ codes: ["auth_path"] })).toContain("security-reviewer");
  });
  it("the delta code reviewer's flag adds it, and not before", async () => {
    expect(await roles({})).not.toContain("security-reviewer");
    expect(await roles({ flagged: true })).toContain("security-reviewer");
  });
  it("the debater is in the plan only where the repo enables it", async () => {
    expect(await roles({ debater: true })).toContain("debater");
    expect(await roles({ debater: false })).not.toContain("debater");
  });
  it("a worker that is not there, or an item with no approver on record, is a fixed reason and not a throw", async () => {
    expect(await ports({ worker: null }).p.plan({ entry, headSha: "b".repeat(40) })).toEqual({ ok: false, reason: "worker_unavailable" });
    h.facts.u = undefined;
    expect(await ports().p.plan({ entry, headSha: "b".repeat(40) })).toEqual({ ok: false, reason: "invalid_input" });
  });
});

describe("startRole: the metered start and its refusals", () => {
  const start = (attempt = 0) => ports().p.startRole({ entry, role: "code-reviewer", delta: DELTA as never, attempt });
  it("starts the reviewer on the MERGE COMMIT in delta mode, with no re-review round and no earlier reviewers, under the attempt it is given", async () => {
    expect(await start(2)).toEqual({ ok: true, runId: "run-1" });
    const [, , , pr, role, prior, rereview, attempt, delta] = h.starts[0]!;
    expect(pr).toMatchObject({ number: 41, headSha: DELTA.mergeCommitSha });
    expect([role, prior, rereview, attempt, delta]).toEqual(["code-reviewer", [], 0, 2, DELTA]);
  });
  it.each(["refused_spend", ...RESERVATION_PAUSE_REASONS])("a spend refusal (%s) is refused_spend, whatever its wording", async (reason) => {
    h.start = { runId: null, reason };
    expect(await start()).toEqual({ ok: false, reason: "refused_spend" });
  });
  it("a refusal that is not spend keeps its own code, and a missing one is invalid_input", async () => {
    h.start = { runId: null, reason: "spec_changed" };
    expect(await start()).toEqual({ ok: false, reason: "spec_changed" });
    h.start = { runId: null, reason: null };
    expect(await start()).toEqual({ ok: false, reason: "invalid_input" });
  });
  it("the item's lookups are made once per entry and head, however many roles start", async () => {
    const { p } = ports();
    await p.startRole({ entry, role: "code-reviewer", delta: DELTA as never, attempt: 0 });
    await p.startRole({ entry, role: "acceptance-tester", delta: DELTA as never, attempt: 0 });
    await p.plan({ entry, headSha: DELTA.mergeCommitSha });
    expect(h.loads).toBe(1);
  });
});

describe("cancelRun, recordEvent, runs, outcome", () => {
  it("cancelRun stops the run through the worker's own cancel, as the approver, with the item's halt epoch", async () => {
    const { p, worker } = ports();
    await p.cancelRun(entry, "run-9");
    expect((worker as { advanceCancel: ReturnType<typeof vi.fn> }).advanceCancel).toHaveBeenCalledWith({ accountId: "acct", userId: "user-1", workItemId: "item", haltEpoch: 4 }, "run-9");
  });
  it("cancelRun with no item context cancels nothing and does not throw", async () => {
    h.facts.u = undefined;
    const { p, worker } = ports();
    await p.cancelRun(entry, "run-9");
    expect((worker as { advanceCancel: ReturnType<typeof vi.fn> }).advanceCancel).not.toHaveBeenCalled();
  });
  it("recordEvent writes a head_refresh fact with a fixed code, keyed by the merge commit and the code so a replay writes nothing more", async () => {
    const { p, worker } = ports();
    await p.recordEvent({ entry, toSha: DELTA.mergeCommitSha, code: "main_side_only" });
    expect((worker as { advanceRecordEvent: ReturnType<typeof vi.fn> }).advanceRecordEvent).toHaveBeenCalledWith(expect.anything(), { kind: "head_refresh", dedupeKey: `refresh:${DELTA.mergeCommitSha}:main_side_only`, code: "main_side_only", headSha: DELTA.mergeCommitSha, prNumber: 41 });
  });
  it("runs lists the delta runs of the merge commit through the worker, and none without the listing", async () => {
    expect(await ports().p.runs(entry, DELTA.mergeCommitSha)).toEqual([{ role: "code-reviewer", runId: "r1", attempt: 0, reusable: true }]);
    expect(await ports({ worker: { advanceCancel: vi.fn() } }).p.runs(entry, DELTA.mergeCommitSha)).toEqual([]);
  });
  it("outcome carries the verdict word, the security flag and whether the run said nothing", async () => {
    expect(await ports().p.outcome(entry, "done")).toEqual({ done: true, verdict: "pass", securityNeeded: true, noVerdict: false });
  });
});
