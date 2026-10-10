import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunsOnSha } from "../../src/build/mergeGate.js";
import { runMergeGateForItem, type LocalReviewOptInPort } from "../../src/review/mergeGateRun.js";
import { LOCAL_REVIEW_DESCRIPTION, REVIEW_STATUS_CONTEXT } from "../../src/review/githubReads.js";
import { discussingItem } from "../plan/helpers/panelFixtures.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { fakeGitHubRest, freshRepo, type FakeRepoState } from "./helpers/fakeGitHubRest.js";

/**
 * D#6 R5b-2b-ii [pg] (C38 R5b.7, acceptance 3 and mutation (b); TL ruling C40): the merge gate for a `runner_verified` repo.
 * Reviews of a verified pull request run in our sandbox on the customer's key, so only `runtime = 'production'` verdicts count,
 * exactly as for a sandbox repo. A verdict from the customer's runner on a verified repo is advisory. Every merge-or-not decision is
 * read from the fake GitHub's merge log (`gh.merges`, a counting merge port), not from the gate's own answer.
 *
 * Mutation (b): widening `RUNNER_ADMIN_OK_SQL` to admit `runner_verified` turns the "runner_admin_ok is false" tests red. The
 * end-to-end tests alone could not see it, because the gate ignores `runner_admin_ok` outside `runner_local_on` (reviewMode "cloud");
 * the SQL-level test is what pins the definition itself.
 */
const h = pgHarness();
const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
const greenCheck = { name: "ci", status: "completed", conclusion: "success" };
const ENV = "FX_HUMAN_MERGE_ONLY_REPO_IDS";
const saved = process.env[ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});
let nextKey = 0;

interface World {
  accountId: string;
  workItemId: string;
  repoId: string;
  ghRepoId: number;
  gh: FakeRepoState;
  adminRunner: string;
}

async function user(accountId: string, role: "owner" | "admin" | "member"): Promise<string> {
  const id = randomUUID();
  await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@fixture.test`]);
  await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, id, role]);
  return id;
}

async function runner(accountId: string, registeredBy: string): Promise<string> {
  const id = randomUUID();
  const k = String(++nextKey).padStart(43, "v");
  await h.admin.query("INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription')", [id, accountId, registeredBy, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: k }), k]);
  return id;
}

/** A runner_verified repo whose executor ran on an admin's runner and opened a pull request, with CI green and the base protected. */
async function world(): Promise<World> {
  const accountId = randomUUID();
  const repoId = randomUUID();
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'runner_verified', settings = '{\"autoMerge\":true}'::jsonb WHERE id = $1", [repoId]);
  const ghRepoId = Number((await h.admin.query("SELECT gh_repo_id FROM repos WHERE id = $1", [repoId])).rows[0].gh_repo_id);
  const { workItemId } = await discussingItem(h.runWriterPool, accountId, { title: "Add a footer", body: "Show the year in the footer.", category: "feature", repoId });
  await h.admin.query("UPDATE work_items SET gh_number = 7, repo_id = $2, stage = 'pr_opened', provenance = 'internal' WHERE id = $1", [workItemId, repoId]);
  const body = "1. The footer shows the year.";
  await h.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
  const adminRunner = await runner(accountId, await user(accountId, "admin"));
  const gh = freshRepo({ headSha: HEAD, checks: { [HEAD]: [greenCheck] }, protectedWithoutChecks: true, runBranch: BRANCH });
  // What the runner's `done` recorded for the work item: the pull request and the run branch the review must be about.
  const executor = randomUUID();
  await h.admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, runner_id) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded', 'runner_verified', $4)", [executor, accountId, workItemId, adminRunner]);
  await h.admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)", [accountId, executor, JSON.stringify({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: gh.prNumber, branch: BRANCH })]);
  return { accountId, workItemId, repoId, ghRepoId, gh, adminRunner };
}

/** A succeeded reviewer run. `sandbox` is what our own dispatch writes for a verified PR (production runtime, our sandbox, no runner); `runner` is the customer's runner. */
async function review(w: World, role: string, verdict: string, as: "sandbox" | "runner_verified" | "runner_local", head = HEAD, runnerId: string | null | undefined = undefined): Promise<void> {
  const production = as === "sandbox";
  await h.admin.query(
    `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode, runner_id)
     VALUES ($1, $2, $3, $4, 'succeeded', $5::jsonb, $6, $7, $8)`,
    [w.accountId, w.workItemId, role, production ? "production" : "runner", JSON.stringify({ verdict }), head, production ? "runner_verified" : as, production ? null : runnerId === undefined ? w.adminRunner : runnerId],
  );
}
const passBoth = async (w: World, as: Parameters<typeof review>[3], head = HEAD) => {
  await review(w, "code-reviewer", "pass", as, head);
  await review(w, "acceptance-tester", "pass", as, head);
};

/** A port that records every question and always says yes: a verified repo must never even be asked. */
const asked: unknown[] = [];
const optIn: LocalReviewOptInPort = { enabled: async (i) => (asked.push(i), true) };
const gate = (w: World) => runMergeGateForItem({ pool: h.runWriterPool, http: fakeGitHubRest(w.gh), localReviewOptIn: optIn }, { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.gh.prNumber });
const reasonsOf = (out: Awaited<ReturnType<typeof gate>>) => (out.outcome === "ready_human_merges" ? out.reasons : []);

describe("a runner_verified repo: the gate counts our sandbox's verdicts", () => {
  it("every sandbox verdict passes on the head, CI is green, the base is protected: one merge call on the head SHA, and the status is the cloud one, not 'Local review'", async () => {
    asked.length = 0;
    const w = await world();
    await passBoth(w, "sandbox");
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "merged", headSha: HEAD, status: "posted" });
    expect(w.gh.merges).toEqual([{ sha: HEAD, method: "squash" }]);
    expect(w.gh.posts).toHaveLength(1);
    expect(w.gh.posts[0]).toMatchObject({ sha: HEAD, body: { state: "success", context: REVIEW_STATUS_CONTEXT } });
    expect(w.gh.posts[0]!.body.description).not.toBe(LOCAL_REVIEW_DESCRIPTION);
    expect(String(w.gh.posts[0]!.body.description)).not.toMatch(/local/i);
    // The local-review opt-in belongs to runner_local alone: the gate never asks about a verified repo.
    expect(asked).toEqual([]);
  });

  it("runner verdicts only (the customer's runner, either mode label) are advisory: zero merge calls, no status, and the reasons say the run was not a production one", async () => {
    for (const as of ["runner_verified", "runner_local"] as const) {
      const w = await world();
      await passBoth(w, as);
      const out = await gate(w);
      expect(out.outcome, as).toBe("ready_human_merges");
      expect(reasonsOf(out), as).toEqual(expect.arrayContaining(["run_not_production_code_reviewer", "run_not_production_acceptance_tester"]));
      expect(w.gh.merges, as).toEqual([]);
      expect(w.gh.posts, as).toEqual([]);
    }
  });

  it("a runner pass cannot stand in for one missing sandbox verdict: one role from the sandbox and one from the runner makes no merge", async () => {
    const w = await world();
    await review(w, "code-reviewer", "pass", "sandbox");
    await review(w, "acceptance-tester", "pass", "runner_verified");
    expect(reasonsOf(await gate(w))).toContain("run_not_production_acceptance_tester");
    expect(w.gh.merges).toEqual([]);
  });

  it("an even-handed veto: a runner's rejection does not unblock, and a sandbox rejection blocks a runner pass", async () => {
    const w = await world();
    await review(w, "code-reviewer", "pass", "sandbox");
    await review(w, "acceptance-tester", "needs-fix", "sandbox");
    await review(w, "acceptance-tester", "pass", "runner_verified");
    const out = await gate(w);
    expect(out.outcome).toBe("ready_human_merges");
    expect(w.gh.merges).toEqual([]);
  });

  it("only the exact head counts: sandbox passes on an older commit make no merge", async () => {
    const w = await world();
    await passBoth(w, "sandbox", OLD_HEAD);
    expect(reasonsOf(await gate(w))).toEqual(expect.arrayContaining(["missing_run_code_reviewer", "missing_run_acceptance_tester"]));
    expect(w.gh.merges).toEqual([]);
  });

  it("the operator's human-merge-only lock still wins: every sandbox verdict passes and the repo is listed, so the gate makes zero merge calls", async () => {
    const w = await world();
    await passBoth(w, "sandbox");
    process.env[ENV] = `1,${w.ghRepoId}`;
    const out = await gate(w);
    expect(out.outcome).toBe("ready_human_merges");
    expect(reasonsOf(out)).toEqual(["human_merge_only"]);
    expect(w.gh.merges).toEqual([]);
    // the control: the same world merges once the lock is lifted
    process.env[ENV] = "1";
    expect((await gate(w)).outcome).toBe("merged");
    expect(w.gh.merges).toHaveLength(1);
  });
});

describe("mutation (b): the runner-admin definition is runner_local only", () => {
  it("a runner_verified runner run has runner_admin_ok = false, however trusted its runner is; the same run as runner_local has it true (the control)", async () => {
    const w = await world();
    await review(w, "code-reviewer", "pass", "runner_verified");
    const rows = await loadRunsOnSha(h.runWriterPool, w.accountId, w.workItemId, HEAD);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "code-reviewer", runtime: "runner", runner_admin_ok: false });

    const control = await world();
    await review(control, "code-reviewer", "pass", "runner_local");
    expect((await loadRunsOnSha(h.runWriterPool, control.accountId, control.workItemId, HEAD))[0]).toMatchObject({ runtime: "runner", runner_admin_ok: true });
  });

  it("every other shape of the verified runner run is false too: a revoked runner, a member's runner, no runner", async () => {
    const w = await world();
    const member = await user(w.accountId, "member");
    const revoked = await runner(w.accountId, await user(w.accountId, "admin"));
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [revoked]);
    await review(w, "code-reviewer", "pass", "runner_verified", HEAD, null);
    await review(w, "acceptance-tester", "pass", "runner_verified", HEAD, await runner(w.accountId, member));
    await review(w, "security-reviewer", "pass", "runner_verified", HEAD, revoked);
    const rows = await loadRunsOnSha(h.runWriterPool, w.accountId, w.workItemId, HEAD);
    expect(rows.map((r) => [r.role, r.runner_admin_ok]).sort()).toEqual([["acceptance-tester", false], ["code-reviewer", false], ["security-reviewer", false]]);
  });

  it("a production-runtime verdict does not depend on it: the sandbox rows read false for runner_admin_ok and still count", async () => {
    const w = await world();
    await passBoth(w, "sandbox");
    const rows = await loadRunsOnSha(h.runWriterPool, w.accountId, w.workItemId, HEAD);
    expect(rows.map((r) => [r.runtime, r.runner_admin_ok])).toEqual([["production", false], ["production", false]]);
    expect((await gate(w)).outcome).toBe("merged");
  });
});
