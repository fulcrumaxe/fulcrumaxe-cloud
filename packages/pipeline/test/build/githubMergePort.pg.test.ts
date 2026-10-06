import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubMergeGatePort, type GitHubHttp, type GitHubHttpRequest } from "../../src/build/githubMergePort.js";
import { isCiGreen, runMergeGate } from "../../src/build/mergeGate.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#2 H14c-1: the production GitHub port (CI-1..3 collection, required
 * contexts, and the merge call bound to the head `sha`) against a fixture
 * GitHub that pages like the real one (per_page/page, total_count) and that
 * merges WHATEVER the head is when the `sha` parameter is absent, as the
 * real API does. Zero network, zero model tokens.
 */
const HEAD = "a".repeat(40);
const NEW = "c".repeat(40);
const PR = { repoId: "repo-1", prNumber: 7 };

interface FakeState {
  headSha: string;
  checks: { name: string; status: string; conclusion: string | null; head_sha?: string; id?: number; app?: { id: number } }[];
  statuses: { context: string; state: string }[];
  /** Classic protection response; undefined = 404 "Branch not protected". */
  protection?: { status: number; body: unknown };
  rules: unknown[];
  requests: GitHubHttpRequest[];
  merged: string[];
  /** Runs when the merge request arrives (a push racing the merge). */
  onMerge?: (s: FakeState) => void;
}

function page<T>(all: T[], q: Record<string, string | number> | undefined): T[] {
  const per = Number(q?.per_page ?? 30);
  const p = Number(q?.page ?? 1);
  return all.slice((p - 1) * per, p * per);
}

function fakeGitHub(over: Partial<FakeState> = {}): { http: GitHubHttp; state: FakeState } {
  const state: FakeState = { headSha: HEAD, checks: [], statuses: [], rules: [], requests: [], merged: [], ...over };
  const http: GitHubHttp = {
    async request(req) {
      state.requests.push(req);
      const path = req.path;
      if (req.method === "GET" && /\/pulls\/7$/.test(path)) {
        return { status: 200, body: { state: "open", merged: false, draft: false, head: { sha: state.headSha }, base: { ref: "release/main" } } };
      }
      if (req.method === "GET" && path.endsWith("/check-runs")) {
        const list = state.checks.map((c, i) => ({ head_sha: HEAD, id: i + 1, app: { id: 1 }, ...c }));
        return { status: 200, body: { total_count: list.length, check_runs: page(list, req.query) } };
      }
      if (req.method === "GET" && path.endsWith("/status")) {
        return { status: 200, body: { sha: HEAD, total_count: state.statuses.length, statuses: page(state.statuses, req.query) } };
      }
      if (req.method === "GET" && path.includes("/protection/required_status_checks")) {
        return state.protection ?? { status: 404, body: { message: "Branch not protected" } };
      }
      if (req.method === "GET" && path.includes("/rules/branches/release/main")) {
        return { status: 200, body: page(state.rules, req.query) };
      }
      if (req.method === "PUT" && path.endsWith("/pulls/7/merge")) {
        state.onMerge?.(state);
        const sha = (req.body as { sha?: string }).sha;
        // Real GitHub: a given `sha` that is not the head is a 409; an absent
        // one merges whatever the head is.
        if (sha !== undefined && sha !== state.headSha) return { status: 409, body: { message: "Head branch was modified" } };
        state.merged.push(state.headSha);
        return { status: 200, body: { merged: true, sha: "deadbeef" } };
      }
      return { status: 404, body: { message: "Not Found" } };
    },
  };
  return { http, state };
}

const ok = (name: string) => ({ name, status: "completed", conclusion: "success" });
const many = (n: number) => Array.from({ length: n }, (_, i) => ok(`job-${i}`));

function portOver(f: { http: GitHubHttp }) {
  const marks: unknown[] = [];
  const port = createGitHubMergeGatePort({
    http: f.http,
    resolveRepo: async () => ({ owner: "acme", name: "widgets" }),
    markReadyForHumanMerge: async (_pr, a) => void marks.push(a),
  });
  return { port, marks };
}

describe("H14c-1 GitHub merge port: CI collection", () => {
  it("CI-1: pages through every check run; a failing run only on page 2 is seen, not green", async () => {
    const f = fakeGitHub({ checks: [...many(100), { name: "e2e", status: "completed", conclusion: "failure" }] });
    const snap = await portOver(f).port.getCiSnapshot(PR, HEAD);
    expect(snap.checkRuns).toHaveLength(101);
    expect(snap.checkRunsTotalCount).toBe(101);
    expect(isCiGreen(snap, HEAD)).toBe(false);
  });

  it("CI-1: a green snapshot spanning two pages of check runs and two of statuses is complete and green", async () => {
    const statuses = Array.from({ length: 130 }, (_, i) => ({ context: `s-${i}`, state: "success" }));
    const f = fakeGitHub({ checks: many(150), statuses });
    const snap = await portOver(f).port.getCiSnapshot(PR, HEAD);
    expect([snap.checkRuns.length, snap.checkRunsTotalCount, snap.statuses.length, snap.statusesTotalCount]).toEqual([150, 150, 130, 130]);
    expect(isCiGreen(snap, HEAD)).toBe(true);
  });

  it("CI-1: a list that ends short of total_count (cut off) is not green", async () => {
    const f = fakeGitHub({ checks: many(3) });
    const port = portOver(f).port;
    const snap = await port.getCiSnapshot(PR, HEAD);
    expect(isCiGreen({ ...snap, checkRunsTotalCount: 4 }, HEAD)).toBe(false);
  });

  it("CI-2: required contexts come from branch protection AND rulesets of the PR's base branch", async () => {
    const f = fakeGitHub({
      checks: [ok("build")],
      protection: { status: 200, body: { contexts: ["legacy"], checks: [{ context: "build", app_id: 1 }] } },
      rules: [{ type: "deletion" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "slow-e2e" }] } }],
    });
    const snap = await portOver(f).port.getCiSnapshot(PR, HEAD);
    expect(snap.requiredContexts).toEqual(["build", "legacy", "slow-e2e"]);
    expect(f.state.requests.some((r) => r.path.includes("/branches/release/main/protection"))).toBe(true);
    expect(isCiGreen(snap, HEAD)).toBe(false); // legacy and slow-e2e are absent
  });

  it("CI-2: every required context present and successful is green", async () => {
    const f = fakeGitHub({ checks: [ok("build")], statuses: [{ context: "legacy", state: "success" }], protection: { status: 200, body: { contexts: ["legacy"], checks: [{ context: "build" }] } } });
    expect(isCiGreen(await portOver(f).port.getCiSnapshot(PR, HEAD), HEAD)).toBe(true);
  });

  it("CI-3: no required contexts configured -> the existing rule (one signal, all green)", async () => {
    const f = fakeGitHub({ checks: [ok("build")] });
    const snap = await portOver(f).port.getCiSnapshot(PR, HEAD);
    expect(snap.requiredContexts).toEqual([]);
    expect(isCiGreen(snap, HEAD)).toBe(true);
    expect(isCiGreen(await portOver(fakeGitHub()).port.getCiSnapshot(PR, HEAD), HEAD)).toBe(false); // no signal at all
  });

  it.each([
    ["403 on branch protection", { status: 403, body: { message: "Resource not accessible" } }],
    ["a 404 that is not GitHub's not-protected message", { status: 404, body: { message: "Not Found" } }],
  ])("D#6 R3b: %s reads as an unprotected base (the gate blocks with no_branch_protection), not as 'no required checks' and not as an error", async (_l, protection) => {
    const f = fakeGitHub({ checks: [ok("build")], protection });
    const snap = await portOver(f).port.getCiSnapshot(PR, HEAD);
    expect(snap.baseBranchProtected).toBe(false);
    expect(snap.requiredContexts).toEqual([]);
  });

  it.each([
    ["a 500", { status: 500, body: {} }],
    ["a 401", { status: 401, body: {} }],
  ])("fails closed: %s throws", async (_l, protection) => {
    const f = fakeGitHub({ checks: [ok("build")], protection });
    await expect(portOver(f).port.getCiSnapshot(PR, HEAD)).rejects.toThrow();
  });

  it("fails closed: a check run GitHub attributes to another commit makes the snapshot answer for that commit", async () => {
    const f = fakeGitHub({ checks: [{ ...ok("build"), head_sha: NEW }] });
    const snap = await portOver(f).port.getCiSnapshot(PR, HEAD);
    expect(isCiGreen(snap, HEAD)).toBe(false);
  });

  it("fails closed: a response without total_count throws instead of reading as complete", async () => {
    const f = fakeGitHub({ checks: [ok("build")] });
    const inner = f.http.request.bind(f.http);
    f.http.request = async (req) => {
      const res = await inner(req);
      if (req.path.endsWith("/check-runs")) delete (res.body as Record<string, unknown>).total_count;
      return res;
    };
    await expect(portOver(f).port.getCiSnapshot(PR, HEAD)).rejects.toThrow(/total_count/);
  });
});

describe("H14c-1b GitHub merge port: paging race and app-bound checks", () => {
  /** Wraps the fake so the check-runs list is re-read on every call: `list(n)` is the n-th read. */
  function shifting(list: (n: number) => Record<string, unknown>[]) {
    const f = fakeGitHub({ checks: [ok("x")] });
    const inner = f.http.request.bind(f.http);
    let n = 0;
    f.http.request = async (req) => {
      if (!req.path.endsWith("/check-runs")) return inner(req);
      const all = list(++n).map((c) => ({ head_sha: HEAD, app: { id: 1 }, ...c }));
      return { status: 200, body: { total_count: all.length, check_runs: page(all, req.query) } };
    };
    return f;
  }
  const run = (id: number, name = `job-${id}`, status = "completed") => ({ id, name, status, conclusion: status === "completed" ? "success" : null });

  it("CARRY-1: a run listed first between the pages (page 2 repeats a page-1 item) throws, never green", async () => {
    const base = Array.from({ length: 150 }, (_, i) => run(i + 1));
    const f = shifting((n) => (n === 1 ? base : [run(999, "late", "in_progress"), ...base]));
    await expect(portOver(f).port.getCiSnapshot(PR, HEAD)).rejects.toThrow(/changed between pages|repeated/);
  });

  it("CARRY-1: total_count differing on page 2 throws even when no item repeats", async () => {
    const base = Array.from({ length: 150 }, (_, i) => run(i + 1));
    const f = shifting((n) => (n === 1 ? base : [...base, run(999, "late", "in_progress")]));
    await expect(portOver(f).port.getCiSnapshot(PR, HEAD)).rejects.toThrow(/changed between pages/);
  });

  it("CARRY-1: the same check run id on two pages throws; a duplicate status context throws", async () => {
    const dup = Array.from({ length: 101 }, (_, i) => run(i === 100 ? 1 : i + 1));
    await expect(portOver(shifting(() => dup)).port.getCiSnapshot(PR, HEAD)).rejects.toThrow(/repeated/);
    const statuses = [...Array.from({ length: 100 }, (_, i) => ({ context: `s-${i}`, state: "success" })), { context: "s-0", state: "success" }];
    await expect(portOver(fakeGitHub({ checks: [ok("build")], statuses })).port.getCiSnapshot(PR, HEAD)).rejects.toThrow(/repeated/);
  });

  it("CARRY-1: a check run without an id throws", async () => {
    const f = shifting(() => [{ name: "a", status: "completed", conclusion: "success", id: undefined }]);
    await expect(portOver(f).port.getCiSnapshot(PR, HEAD)).rejects.toThrow(/check_run/);
  });

  const bound = (appId: number | null) => ({ status: 200, body: { contexts: [], checks: [{ context: "build", app_id: appId }] } });

  it("CARRY-2: a same-named check run from another app does not satisfy an app-bound required check", async () => {
    const f = fakeGitHub({ checks: [{ ...ok("build"), app: { id: 2 } }], protection: bound(1) });
    const snap = await portOver(f).port.getCiSnapshot(PR, HEAD);
    expect(snap.requiredAppChecks).toEqual([{ context: "build", appId: 1 }]);
    expect(isCiGreen(snap, HEAD)).toBe(false);
  });

  it("CARRY-2: the matching app, an unbound requirement, and a ruleset integration_id", async () => {
    expect(isCiGreen(await portOver(fakeGitHub({ checks: [ok("build")], protection: bound(1) })).port.getCiSnapshot(PR, HEAD), HEAD)).toBe(true);
    expect(isCiGreen(await portOver(fakeGitHub({ checks: [{ ...ok("build"), app: { id: 2 } }], protection: bound(null) })).port.getCiSnapshot(PR, HEAD), HEAD)).toBe(true);
    const rules = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "build", integration_id: 7 }] } }];
    const s = await portOver(fakeGitHub({ checks: [ok("build")], rules })).port.getCiSnapshot(PR, HEAD);
    expect(s.requiredAppChecks).toEqual([{ context: "build", appId: 7 }]);
    expect(isCiGreen(s, HEAD)).toBe(false);
  });

  it("CARRY-2: a status of that name, or a snapshot without the binding list, is not green", async () => {
    const f = fakeGitHub({ checks: [ok("other")], statuses: [{ context: "build", state: "success" }], protection: bound(1) });
    expect(isCiGreen(await portOver(f).port.getCiSnapshot(PR, HEAD), HEAD)).toBe(false);
    const good = await portOver(fakeGitHub({ checks: [ok("build")] })).port.getCiSnapshot(PR, HEAD);
    expect(isCiGreen({ ...good, requiredAppChecks: undefined as never }, HEAD)).toBe(false);
  });

  it("CARRY-2: a malformed app id in protection throws", async () => {
    const f = fakeGitHub({ checks: [ok("build")], protection: { status: 200, body: { checks: [{ context: "build", app_id: "1" }] } } });
    await expect(portOver(f).port.getCiSnapshot(PR, HEAD)).rejects.toThrow(/app_id/);
  });
});

describe("H14c-1 GitHub merge port: the merge call", () => {
  it("sends GitHub's sha parameter and squash; merged only on 200 with merged:true", async () => {
    const f = fakeGitHub();
    expect(await portOver(f).port.mergePullRequest(PR, { sha: HEAD })).toEqual({ merged: true });
    const put = f.state.requests.find((r) => r.method === "PUT")!;
    expect(put.path).toBe("/repos/acme/widgets/pulls/7/merge");
    expect(put.body).toEqual({ sha: HEAD, merge_method: "squash" });
  });

  it("a moved head is GitHub's 409, surfaced as a refusal and nothing merged", async () => {
    const f = fakeGitHub({ onMerge: (s) => void (s.headSha = NEW) });
    expect(await portOver(f).port.mergePullRequest(PR, { sha: HEAD })).toEqual({ merged: false, httpStatus: 409 });
    expect(f.state.merged).toEqual([]);
  });

  it.each([405, 422, 500])("status %i is a refusal", async (status) => {
    const http: GitHubHttp = { request: async () => ({ status, body: { message: "no" } }) };
    expect(await portOver({ http }).port.mergePullRequest(PR, { sha: HEAD })).toEqual({ merged: false, httpStatus: status });
  });

  it("a 200 that does not say merged:true is not a merge", async () => {
    const http: GitHubHttp = { request: async () => ({ status: 200, body: { merged: false } }) };
    expect(await portOver({ http }).port.mergePullRequest(PR, { sha: HEAD })).toEqual({ merged: false, httpStatus: 200 });
  });

  it.each(["", "HEAD", "A".repeat(40), "a".repeat(39)])("refuses to call the merge endpoint with sha %j", async (sha) => {
    const f = fakeGitHub();
    await expect(portOver(f).port.mergePullRequest(PR, { sha })).rejects.toThrow();
    expect(f.state.requests).toEqual([]);
  });
});

describe("H14c-1 runMergeGate over the real port [pg]", () => {
  const db = pgHarness();

  async function run(f: ReturnType<typeof fakeGitHub>) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await db.admin.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number) VALUES ($1, $2, $3, 'feature', 'running', 'internal', 7)`,
      [workItemId, accountId, repoId],
    );
    for (const role of ["code-reviewer", "acceptance-tester"]) {
      await db.admin.query(
        `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, 'production', 'succeeded', '{"verdict":"pass"}', $4)`,
        [accountId, workItemId, role, HEAD],
      );
    }
    const requested: string[] = [];
    const marks: unknown[] = [];
    const port = createGitHubMergeGatePort({
      http: f.http,
      resolveRepo: async () => ({ owner: "acme", name: "widgets" }),
      markReadyForHumanMerge: async (_pr, a) => void marks.push(a),
    });
    const result = await runMergeGate(
      { pool: db.runWriterPool, github: port, isAutoMergeAllowed: async () => true, requestReviews: async (_pr, sha) => void requested.push(sha) },
      { accountId, workItemId, pr: { repoId, prNumber: 7 }, tier: "small", securityDiffTriggerFired: false, debaterEnabled: false },
    );
    return { result, requested, marks };
  }

  it("all green: exactly one merge, bound to the reviewed head", async () => {
    const f = fakeGitHub({ checks: [ok("build")] });
    const { result } = await run(f);
    expect(result).toEqual({ outcome: "merged", headSha: HEAD });
    expect(f.state.merged).toEqual([HEAD]);
  });

  it("a push lands between the gate's reads and the merge call: GitHub refuses the stale sha, nothing merges, the new head gets reviews", async () => {
    const f = fakeGitHub({ checks: [ok("build")], onMerge: (s) => void (s.headSha = NEW) });
    const { result, requested } = await run(f);
    expect(result).toEqual({ outcome: "head_moved", staleHeadSha: HEAD, newHeadSha: NEW });
    expect(f.state.merged).toEqual([]);
    expect(requested).toEqual([NEW]);
  });

  it("CI page 2 failing: no merge call reaches GitHub", async () => {
    const f = fakeGitHub({ checks: [...many(100), { name: "e2e", status: "completed", conclusion: "failure" }] });
    const { result } = await run(f);
    expect(result.outcome).toBe("ready_human_merges");
    expect(f.state.requests.some((r) => r.method === "PUT")).toBe(false);
  });
});
