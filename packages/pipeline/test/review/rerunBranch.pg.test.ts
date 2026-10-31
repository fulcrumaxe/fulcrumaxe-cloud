import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { plannedFixture, type PlannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import { sandboxRunBranch } from "@fx/core/src/work-items/buildIdentity.js";
import type { GitHubHttp } from "../../src/build/githubMergePort.js";
import { loadReviewContext } from "../../src/review/context.js";
import { findPullRequestForItem } from "../../src/review/githubReads.js";
import { buildReviewPrompt } from "../../src/review/reviewPrompts.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * [pg] SANDBOX-RERUN-BRANCH-a, criterion 5 (the review side): an item built twice has run 1 on its fixed branch (its pull request closed) and run 2 on a run branch (its pull request open).
 * The real review context builder gives the run branch, the lookup returns run 2's pull request, a list that holds only run 1's closed one is `no_open_pr`, and the branch reaches the
 * reviewer prompt. GitHub is a stateful fake that answers the head-filtered, state-filtered pulls list the way the real one does (head is `owner:branch`, `state` open or closed).
 */
const h = pgHarness();
const SHA = "a".repeat(40);

interface Pull { number: number; state: "open" | "closed"; branch: string }
function githubWith(pulls: Pull[]): GitHubHttp {
  return {
    request: async (r) => {
      if (r.method !== "GET" || r.path !== "/repos/acme/widgets/pulls") throw new Error(`strict fake: unexpected request ${JSON.stringify(r)}`);
      const q = r.query as { state?: string; head?: string };
      const rows = pulls.filter((p) => (q.state === "all" || p.state === (q.state ?? "open")) && q.head === `acme:${p.branch}`);
      return { status: 200, body: rows.map((p) => ({ number: p.number, state: p.state, head: { ref: p.branch, sha: SHA, repo: { id: 9001, full_name: "acme/widgets" } }, base: { ref: "main", sha: "d".repeat(40), repo: { id: 9001, full_name: "acme/widgets" } } })) };
    },
  };
}

async function twiceBuilt(): Promise<{ f: PlannedFixture; runBranch: string; childBranch: string }> {
  const f = await plannedFixture(h.admin, h.pureAppUserPool, { dial: null, weeklyUsd: null });
  const { accountId } = f.t;
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [f.t.repoId]);
  await h.admin.query("UPDATE work_items SET gh_number = 41 WHERE id = $1", [f.parent]);
  await h.admin.query("INSERT INTO discussions (account_id, number, repo_id, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, 41, $2, 'feature', 'Parent', $3, 'internal', 'system')", [accountId, f.t.repoId, f.parent]);
  await h.admin.query("UPDATE work_items SET discussion_id = (SELECT id FROM discussions WHERE account_id = $1 AND root_work_item_id = $2) WHERE id = $2", [accountId, f.parent]);
  const made: Record<string, string> = {};
  let n = 0;
  for (const item of [f.parent, f.kids.api!]) {
    const record = async (branch: (id: string) => string, kind = "build.branch") => {
      const id = randomUUID();
      await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', now() + make_interval(secs => $4))`, [id, accountId, item, ++n]);
      await h.admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, $3, $4::jsonb)`, [accountId, id, kind, JSON.stringify({ branch: branch(id) })]);
      return id;
    };
    await record(() => (item === f.parent ? "fx/issue-41" : "fx/41-api"));
    made[item] = await record((id) => sandboxRunBranch(id));
  }
  return { f, runBranch: sandboxRunBranch(made[f.parent]!), childBranch: sandboxRunBranch(made[f.kids.api!]!) };
}

describe("the review side of a sandbox re-run [pg]", { timeout: 60_000 }, () => {
  it("the real review context is the newest run's branch, for the item and for a child, and the fixed name for a run that only ever used it", async () => {
    const { f, runBranch, childBranch } = await twiceBuilt();
    const top = await loadReviewContext(h.runWriterPool, f.t.accountId, f.parent);
    const kid = await loadReviewContext(h.runWriterPool, f.t.accountId, f.kids.api!);
    expect(top).toMatchObject({ ok: true, ctx: { issue: 41, branch: runBranch } });
    expect(kid).toMatchObject({ ok: true, ctx: { issue: 41, branch: childBranch, child: true } });
    // The sibling that was built once is untouched: its branch is still the fixed one.
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded')`, [randomUUID(), f.t.accountId, f.kids.ui!]);
    expect(await loadReviewContext(h.runWriterPool, f.t.accountId, f.kids.ui!)).toMatchObject({ ok: true, ctx: { branch: "fx/41-ui" } });
  });

  it("run 2's open pull request is found by its run branch; a list that holds only run 1's closed pull request is no_open_pr; the branch reaches the reviewer prompt", async () => {
    const { f, runBranch } = await twiceBuilt();
    const loaded = await loadReviewContext(h.runWriterPool, f.t.accountId, f.parent);
    if (!loaded.ok) throw new Error(loaded.reason);
    const { ctx } = loaded;
    const source = { owner: ctx.owner, name: ctx.name, branch: ctx.branch, executionMode: ctx.executionMode, recordedPr: null };
    const both = githubWith([{ number: 40, state: "closed", branch: "fx/issue-41" }, { number: 41, state: "open", branch: runBranch }]);
    expect(await findPullRequestForItem(both, source)).toMatchObject({ ok: true, pr: { number: 41, branch: runBranch } });
    const onlyFirst = githubWith([{ number: 40, state: "closed", branch: "fx/issue-41" }]);
    expect(await findPullRequestForItem(onlyFirst, source)).toEqual({ ok: false, reason: "no_open_pr" });
    // Run 1's pull request still open on the fixed name is not run 2's: it is never returned for the run-branch lookup.
    const staleOpen = githubWith([{ number: 40, state: "open", branch: "fx/issue-41" }]);
    expect(await findPullRequestForItem(staleOpen, source)).toEqual({ ok: false, reason: "no_open_pr" });
    const prompt = buildReviewPrompt({ role: "code-reviewer", owner: ctx.owner, name: ctx.name, issue: ctx.issue, pr: 41, headSha: SHA, baseRef: "main", branch: ctx.branch, version: 1, spec: "1. Add a footer." });
    expect(prompt).toContain(runBranch);
    expect(prompt).not.toContain("fx/issue-41");
  });
});
