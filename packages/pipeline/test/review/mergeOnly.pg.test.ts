import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { listDriverEvents } from "@fx/core/src/work-items/driverEvents.js";
import type { GitHubHttpRequest } from "../../src/build/githubMergePort.js";
import { gateReviewerReasons, loadRunsOnSha } from "../../src/build/mergeGate.js";
import { enqueueEntry } from "../../src/mergeQueue/store.js";
import { createCiGate } from "../../src/review/ciWait.js";
import { reviewerFlaggedSecurity } from "../../src/review/mergeGateRun.js";
import { MERGE_ONLY_CODE, recordMergeOnlyRecheck } from "../../src/review/mergeOnly.js";
import { recordRound } from "../../src/review/roundDecision.js";
import { discussingItem } from "../plan/helpers/panelFixtures.js";
import { createFakeExecutionTarget } from "../build/helpers/fakeExecutionTarget.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { fakeGitHubRest, freshRepo, type FakeRepoState } from "./helpers/fakeGitHubRest.js";
import { commit, sha40, withGitGraph, type FakeGraph } from "./helpers/fakeGitGraph.js";

/**
 * D#598 P7c [pg]: a new head that is only a merge of the base branch gets a delta re-check, not a full review.
 *
 * Real Postgres (work items, reviewer runs, driver events, the merge queue's tables), and GitHub's commit and compare reads over a small
 * git history that answers like the real API (fakeGitGraph.ts). Every scenario is a fixture customer repository: another owner and name
 * than ours, a single plane, no pairing, no setting of any kind (D#598 C1 section 2 item 3).
 *
 * Not faked faithfully (said in the PR): renames and binary files in the compare list, how long GitHub takes to compute a compare, rate limits.
 */
const h = pgHarness();
const registry = { sandbox: createFakeExecutionTarget().target };
const PR = 41;
const REQUIRED = ["code-reviewer", "acceptance-tester"] as const;
type Role = (typeof REQUIRED)[number];

interface World {
  accountId: string;
  repoId: string;
  workItemId: string;
  gh: FakeRepoState;
  g: FakeGraph;
  seen: GitHubHttpRequest[];
  /** The reviewed head, and main's tip after it moved on. */
  P: string;
  M1: string;
}

async function world(over: { owner?: string; name?: string } = {}): Promise<World> {
  const accountId = randomUUID();
  const repoId = randomUUID();
  const owner = over.owner ?? "customer-co";
  const name = over.name ?? "storefront";
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = $2, gh_name = $3 WHERE id = $1", [repoId, owner, name]);
  const { workItemId } = await discussingItem(h.runWriterPool, accountId, { title: "Add a footer", body: "Show the year in the footer.", category: "feature", repoId });
  await h.admin.query("UPDATE work_items SET gh_number = 7, repo_id = $2, stage = 'pr_opened', provenance = 'internal' WHERE id = $1", [workItemId, repoId]);
  const body = "1. The footer shows the year.";
  await h.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
  // History: B0 is main's first commit. The branch added src/footer.ts (P, reviewed). Main moved on and changed README (M1).
  const g: FakeGraph = { commits: new Map(), branches: {} };
  const B0 = commit(g, "B0", [], { README: "r1", "src/app.ts": "a1" });
  const P = commit(g, "P", [B0], { README: "r1", "src/app.ts": "a1", "src/footer.ts": "f1" });
  const M1 = commit(g, "M1", [B0], { README: "r2", "src/app.ts": "a1" });
  g.branches.main = M1;
  const gh = freshRepo({ owner, name, prNumber: PR, headSha: P, checks: { [P]: [] } });
  return { accountId, repoId, workItemId, gh, g, seen: [], P, M1 };
}

const httpOf = (w: World) => withGitGraph(fakeGitHubRest(w.gh), { owner: w.gh.owner, name: w.gh.name }, w.g, w.seen);
const gateOf = (w: World) => createCiGate({ pool: h.runWriterPool, openHttp: async () => httpOf(w) });

async function insertRuns(w: World, head: string, spec: Array<[Role, "pass" | "needs-fix"]>, envelopeExtra: Record<string, unknown> = {}) {
  const out = [];
  for (const [role, verdict] of spec) {
    const id = randomUUID();
    const envelope = { verdict, ...(role === "code-reviewer" ? envelopeExtra : {}) };
    await h.admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, $4, 'production', 'succeeded', $5::jsonb, $6)", [id, w.accountId, w.workItemId, role, JSON.stringify(envelope), head]);
    out.push({ role, verdict, runId: id });
  }
  return out;
}

/** A full review round on `head`, recorded the way the driver records it. */
async function reviewedFully(w: World, head: string, spec: Array<[Role, "pass" | "needs-fix"]> = [["code-reviewer", "pass"], ["acceptance-tester", "pass"]], envelopeExtra: Record<string, unknown> = {}) {
  w.gh.headSha = head;
  w.gh.checks[head] ??= [];
  const verdicts = await insertRuns(w, head, spec, envelopeExtra);
  await recordRound(h.runWriterPool, registry, { accountId: w.accountId, workItemId: w.workItemId, headSha: head, prNumber: PR, requiredRoles: REQUIRED, verdicts }, gateOf(w));
}

const recheck = (w: World, head: string, requiredRoles: readonly Role[] = REQUIRED) =>
  recordMergeOnlyRecheck(h.runWriterPool, { accountId: w.accountId, workItemId: w.workItemId, headSha: head, prNumber: PR, baseRef: "main", requiredRoles }, { http: httpOf(w), ci: gateOf(w) });
const events = async (w: World) => (await withTenant(h.runWriterPool, w.accountId, (c) => listDriverEvents(c, w.workItemId))).filter((e) => e.kind === "review_verdicts");
const runCount = async (w: World) => Number((await h.admin.query<{ n: string }>("SELECT count(*)::text AS n FROM agent_runs WHERE work_item_id = $1", [w.workItemId])).rows[0]!.n);
const stageOf = async (w: World) => (await h.admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [w.workItemId])).rows[0]!.stage;

/** N: the branch with main merged in, the pull request's own files untouched. */
function mergeOfMain(w: World, label = "N", tree: Record<string, string> = { README: "r2", "src/app.ts": "a1", "src/footer.ts": "f1" }, parents = [w.P, w.M1]) {
  const N = commit(w.g, label, parents, tree);
  w.gh.checks[N] = [{ name: "build", status: "completed", conclusion: "success" }];
  return N;
}

describe("a merge-only head gets a delta re-check, not a full review", () => {
  it("is recorded as a re-check with no reviewer run, and the reviewed head's passes stand for it at the merge gate", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    expect(await stageOf(w)).toBe("review_passed");
    const N = mergeOfMain(w);
    const runsBefore = await runCount(w);

    expect(await recheck(w, N)).toEqual({ decision: "all_passed", from: w.P });

    // No second review row: not one agent run was created, and the item stays where the first review left it.
    expect(await runCount(w)).toBe(runsBefore);
    expect(await stageOf(w)).toBe("review_passed");
    const row = (await events(w)).find((e) => e.head_sha === N)!;
    expect(row).toMatchObject({ code: MERGE_ONLY_CODE, pr_number: PR, reasons: [`from_${w.P}`, `rows_${w.P}`] });
    // The gate reads runs per head: the new head is cleared by the passes of the reviewed one, and no other head is.
    const rows = await loadRunsOnSha(h.runWriterPool, w.accountId, w.workItemId, N);
    expect(gateReviewerReasons(REQUIRED, rows, "cloud")).toEqual([]);
    const other = await loadRunsOnSha(h.runWriterPool, w.accountId, w.workItemId, sha40("somewhere-else"));
    expect(gateReviewerReasons(REQUIRED, other, "cloud")).toEqual(["missing_run_code_reviewer", "missing_run_acceptance_tester"]);
    // The reads went to the customer's own repository, and only the reads a re-check needs.
    expect(w.seen.every((r) => r.method === "GET" && r.path.startsWith(`/repos/customer-co/storefront/`))).toBe(true);
  });

  it("a replayed step finds its own record: the same answer, one event", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    const N = mergeOfMain(w);
    expect((await recheck(w, N)).decision).toBe("all_passed");
    expect((await recheck(w, N)).decision).toBe("all_passed");
    expect((await events(w)).filter((e) => e.head_sha === N)).toHaveLength(1);
  });

  it("a second merge of main on top of a carried head is carried too, from the head that holds the runs", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    const N1 = mergeOfMain(w, "N1");
    expect((await recheck(w, N1)).decision).toBe("all_passed");
    const M2 = commit(w.g, "M2", [w.M1], { README: "r3", "src/app.ts": "a1" });
    w.g.branches.main = M2;
    const N2 = commit(w.g, "N2", [N1, M2], { README: "r3", "src/app.ts": "a1", "src/footer.ts": "f1" });
    w.gh.checks[N2] = [];
    expect(await recheck(w, N2)).toEqual({ decision: "all_passed", from: N1 });
    expect((await events(w)).find((e) => e.head_sha === N2)!.reasons).toEqual([`from_${N1}`, `rows_${w.P}`]);
    expect(gateReviewerReasons(REQUIRED, await loadRunsOnSha(h.runWriterPool, w.accountId, w.workItemId, N2), "cloud")).toEqual([]);
  });

  it("keeps a security flag the reviewed head's code reviewer set: the security reviewer stays required on the carried head", async () => {
    const w = await world();
    await reviewedFully(w, w.P, [["code-reviewer", "pass"], ["acceptance-tester", "pass"]], { security_review_needed: true });
    const N = mergeOfMain(w);
    // The flagged head needs a security pass the reviewed head never got: it is a full review, not a carry.
    expect(await recheck(w, N)).toEqual({ decision: "full_review", reason: "prior_not_passed" });
    expect(await reviewerFlaggedSecurity(h.runWriterPool, w.accountId, w.workItemId, w.P, false)).toBe(true);
    expect(await events(w).then((e) => e.filter((x) => x.head_sha === N))).toEqual([]);
  });
});

describe("a head with code changes gets a full review", () => {
  it("a commit that is not a merge", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    const N = mergeOfMain(w, "N", { README: "r1", "src/app.ts": "a1", "src/footer.ts": "f1", "src/extra.ts": "x1" }, [w.P]);
    expect(await recheck(w, N)).toEqual({ decision: "full_review", reason: "not_a_merge_of_the_reviewed_head" });
    expect((await events(w)).filter((e) => e.head_sha === N)).toEqual([]);
  });

  it("a merge commit that was edited by hand in a file the pull request owns", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    const N = mergeOfMain(w, "N", { README: "r2", "src/app.ts": "a1", "src/footer.ts": "f2" });
    expect(await recheck(w, N)).toEqual({ decision: "full_review", reason: "code_changed" });
  });

  it("a merge commit with an extra file in it", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    const N = mergeOfMain(w, "N", { README: "r2", "src/app.ts": "a1", "src/footer.ts": "f1", "src/sneaked.ts": "s1" });
    expect(await recheck(w, N)).toEqual({ decision: "full_review", reason: "code_changed" });
  });

  it("main changed a file the pull request also changes: the merged file is not the reviewed one", async () => {
    const w = await world();
    // The branch changes src/app.ts (a2); main changes it too (a3); the merge settles on a4.
    const B0 = [...w.g.commits.keys()][0]!;
    const P2 = commit(w.g, "P2", [B0], { README: "r1", "src/app.ts": "a2" });
    const M2 = commit(w.g, "M2b", [B0], { README: "r1", "src/app.ts": "a3" });
    w.g.branches.main = M2;
    await reviewedFully(w, P2);
    const N = commit(w.g, "N2b", [P2, M2], { README: "r1", "src/app.ts": "a4" });
    w.gh.checks[N] = [];
    expect(await recheck(w, N)).toEqual({ decision: "full_review", reason: "code_changed" });
  });

  it("the second parent is not part of the base branch: something other than main was merged", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    const X = commit(w.g, "X", [[...w.g.commits.keys()][0]!], { README: "r1", "src/app.ts": "a1", "src/other.ts": "o1" });
    const N = mergeOfMain(w, "N", { README: "r1", "src/app.ts": "a1", "src/footer.ts": "f1", "src/other.ts": "o1" }, [w.P, X]);
    expect(await recheck(w, N)).toEqual({ decision: "full_review", reason: "merged_something_other_than_base" });
  });

  it("several commits since the reviewed head (its first parent is not the reviewed head)", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    const mid = commit(w.g, "mid", [w.P], { README: "r1", "src/app.ts": "a1", "src/footer.ts": "f1" });
    const N = mergeOfMain(w, "N", { README: "r2", "src/app.ts": "a1", "src/footer.ts": "f1" }, [mid, w.M1]);
    expect((await recheck(w, N)).decision).toBe("full_review");
  });

  it("a head that was never reviewed before, or whose review did not pass", async () => {
    const fresh = await world();
    expect(await recheck(fresh, mergeOfMain(fresh))).toEqual({ decision: "full_review", reason: "no_prior_review" });
    const failed = await world();
    await reviewedFully(failed, failed.P, [["code-reviewer", "needs-fix"], ["acceptance-tester", "pass"]]);
    expect(await recheck(failed, mergeOfMain(failed))).toEqual({ decision: "full_review", reason: "prior_not_passed" });
  });

  it("GitHub cannot be read: a throw is not a carry", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    const N = mergeOfMain(w);
    const broken = { request: async (req: GitHubHttpRequest) => (req.path.includes("/git/commits/") ? { status: 500, body: { message: "Server Error" } } : httpOf(w).request(req)) };
    expect(await recordMergeOnlyRecheck(h.runWriterPool, { accountId: w.accountId, workItemId: w.workItemId, headSha: N, prNumber: PR, baseRef: "main", requiredRoles: REQUIRED }, { http: broken, ci: gateOf(w) })).toEqual({ decision: "full_review", reason: "github_unavailable" });
    expect((await events(w)).filter((e) => e.head_sha === N)).toEqual([]);
  });

  it("a runner_local repo is always a full review", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    await h.admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [w.repoId]);
    expect(await recheck(w, mergeOfMain(w))).toEqual({ decision: "full_review", reason: "runner_local" });
  });
});

describe("CI is waited for before the re-check is recorded (D#598 P7b)", () => {
  it("pending CI: ci_pending, nothing recorded; once it finishes, recorded", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    const N = mergeOfMain(w);
    w.gh.checks[N] = [{ name: "build", status: "in_progress", conclusion: null }];
    expect(await recheck(w, N)).toMatchObject({ decision: "ci_pending", ciReasons: ["check_running"] });
    expect((await events(w)).filter((e) => e.head_sha === N)).toEqual([]);
    w.gh.checks[N] = [{ name: "build", status: "completed", conclusion: "success" }];
    expect((await recheck(w, N)).decision).toBe("all_passed");
  });

  it("a head that is not a merge does not wait for CI: the answer is a full review at once", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    const N = mergeOfMain(w, "N", { README: "r1", "src/app.ts": "a1", "src/footer.ts": "f2" }, [w.P]);
    w.gh.checks[N] = [{ name: "build", status: "in_progress", conclusion: null }];
    expect((await recheck(w, N)).decision).toBe("full_review");
  });
});

describe("the boundary with D#519: a verified platform refresh is the merge queue's carry-forward", () => {
  it("a head recorded in head_refreshes is left alone here (no record, no carry), while the same shape made by a person is carried", async () => {
    const w = await world();
    await reviewedFully(w, w.P);
    const refreshed = mergeOfMain(w, "refreshed");
    const byPerson = mergeOfMain(w, "by-person");
    // The queue's own record of its update-branch merge: entry, then the refresh row, written the way MQ3 writes it.
    const { entry } = await withTenant(h.runWriterPool, w.accountId, (c) => enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId: w.workItemId, prNumber: PR, headSha: w.P, approvedAt: new Date() }));
    await h.admin.query("INSERT INTO head_refreshes (account_id, repo_id, work_item_id, entry_id, from_sha, to_sha, base_sha) VALUES ($1, $2, $3, $4, $5, $6, $7)", [w.accountId, w.repoId, w.workItemId, entry.id, w.P, refreshed, w.M1]);

    expect(await recheck(w, refreshed)).toEqual({ decision: "full_review", reason: "platform_refresh_left_to_queue" });
    expect((await events(w)).filter((e) => e.head_sha === refreshed)).toEqual([]);
    // This module only reads head_refreshes: the queue's row is untouched.
    expect(Number((await h.admin.query<{ n: string }>("SELECT count(*)::text AS n FROM head_refreshes WHERE work_item_id = $1", [w.workItemId])).rows[0]!.n)).toBe(1);
    // A merge of main that a person made is this module's.
    expect((await recheck(w, byPerson)).decision).toBe("all_passed");
  });
});
