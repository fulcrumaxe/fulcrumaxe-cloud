import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { listDriverEvents } from "@fx/core/src/work-items/driverEvents.js";
import { readPublicPullRequest } from "../../src/review/publicPullRequest.js";
import { runMergeGateForItem } from "../../src/review/mergeGateRun.js";
import { REVIEW_STATUS_CONTEXT } from "../../src/review/githubReads.js";
import { discussingItem } from "../plan/helpers/panelFixtures.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { FAKE_MERGE_BASE, fakeGitHubRest, freshRepo, type FakeRepoState } from "./helpers/fakeGitHubRest.js";

/** D#598 P1d-1: the platform's own App bot opened the public pull request (the normal case), so the author rule trusts it without a permission read. */
const BOT_LOGIN = "fulcrumaxe-app[bot]";
const BOT_TRUST = { botLogins: async () => [BOT_LOGIN], allowlist: () => null };

/**
 * Two planes [pg]: the merge gate of a paired item merges the PUBLIC pull request (the private run branch's copy is reviewed, never merged).
 * Both repositories are fakes that answer like GitHub (helpers/fakeGitHubRest.ts) over real Postgres (work item, reviewer runs, pairing, the
 * platform's push record). The opener refuses any coordinates but the code repository's, so a gate that guessed them fails here.
 *
 * Not faked faithfully (said in the PR): whether the App's installation covers the code repository, and GitHub's own ruleset refusals beyond
 * the status codes the fake can answer.
 */
const h = pgHarness();
const HEAD = "a".repeat(40);
const PUB_HEAD = "c".repeat(40);
const OTHER = "d".repeat(40);
const PUB_PR = 12;
const BLOB = "f".repeat(40);
const file = (filename: string, over: Record<string, unknown> = {}) => ({ filename, status: "modified", sha: BLOB, patch: "@@ -1 +1 @@\n+x", changes: 1, ...over });
const green = [{ name: "build", status: "completed", conclusion: "success" }];

interface Opts {
  settings?: Record<string, unknown>;
  paired?: boolean;
  stamp?: string | null;
  /** The private head the stamp says the public head was built from (default: the reviewed one). */
  source?: string | null;
  state?: string;
  /** Runner-built stamps: the finished runner attempts that pushed, oldest first, each with the branch head the cloud read when its run finished. */
  runner?: Array<{ kind: "push" | "fix_round"; outcome: string; headOid: string | null }>;
  managed?: boolean;
  pubChecks?: FakeRepoState["checks"];
  pubHead?: string;
}

async function world(o: Opts = {}) {
  const accountId = randomUUID();
  const repoId = randomUUID();
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', settings = $2::jsonb WHERE id = $1", [repoId, JSON.stringify(o.settings ?? { autoMerge: true })]);
  const { workItemId } = await discussingItem(h.runWriterPool, accountId, { title: "Add a footer", body: "Show the year in the footer.", category: "feature", repoId });
  await h.admin.query("UPDATE work_items SET gh_number = 7, repo_id = $2, stage = 'pr_opened', provenance = 'internal' WHERE id = $1", [workItemId, repoId]);
  const body = "1. The footer shows the year.";
  await h.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
  for (const role of ["code-reviewer", "acceptance-tester"]) {
    await h.admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, 'production', 'succeeded', $4::jsonb, $5)", [accountId, workItemId, role, JSON.stringify({ verdict: "pass" }), HEAD]);
  }
  const pubHead = o.pubHead ?? PUB_HEAD;
  const priv = freshRepo({ headSha: HEAD, checks: { [HEAD]: [] }, files: [file("src/ui/button.tsx")] });
  const pub = freshRepo({ owner: "acme", name: "widgets-public", prNumber: PUB_PR, isPublic: true, authorLogin: BOT_LOGIN, headSha: pubHead, checks: o.pubChecks ?? { [pubHead]: green }, files: [file("src/ui/button.tsx")] });
  if (o.paired !== false) {
    await h.admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['.autonomous-team/**'])", [repoId, accountId]);
    const stamp = o.stamp === undefined ? PUB_HEAD : o.stamp;
    await h.admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state, head_sha, tip_sha, pr_number, pr_url, source_head${o.managed ? ", managed_by_person_at" : ""})
       VALUES ($1, $2, $3, 'acme/widgets-public', $4, '${o.state ?? "pr_opened"}', $5, $5, $6, 'https://github.com/acme/widgets-public/pull/12', $7${o.managed ? ", now()" : ""})`,
      [accountId, workItemId, repoId, "a".repeat(64), stamp, PUB_PR, o.source === undefined ? HEAD : o.source],
    );
  }
  if (o.paired !== false) {
    let no = 0;
    for (const att of o.runner ?? []) {
      no += 1;
      const runId = randomUUID();
      await h.admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded', 'runner_local')", [runId, accountId, workItemId]);
      if (att.headOid !== null) {
        await h.admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)", [accountId, runId, JSON.stringify({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: 41, branch: "fx/x-g1", headOid: att.headOid })]);
      }
      await h.admin.query(
        "INSERT INTO plane_push_attempts (account_id, plane_push_id, run_id, lease_generation, runtime, kind, attempt_no, token_issued_at, finished_at, outcome) SELECT $1, id, $2, 1, 'runner', $3, $4, now(), now() + ($5 || ' seconds')::interval, $6 FROM plane_pushes WHERE work_item_id = $7",
        [accountId, runId, att.kind, no, String(no), att.outcome, workItemId],
      );
    }
  }
  return { accountId, workItemId, repoId, priv, pub };
}
type World = Awaited<ReturnType<typeof world>>;

const gate = (w: World) =>
  runMergeGateForItem(
    {
      pool: h.runWriterPool,
      authorTrust: BOT_TRUST,
      http: fakeGitHubRest(w.priv),
      publicPlane: {
        open: async (c) => {
          expect(`${c.owner}/${c.name}`).toBe("acme/widgets-public");
          expect(c.repoId).toBe(w.repoId);
          return fakeGitHubRest(w.pub);
        },
        read: readPublicPullRequest(h.runWriterPool),
      },
    },
    { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.priv.prNumber },
  );
const events = (w: World) => withTenant(h.runWriterPool, w.accountId, (c) => listDriverEvents(c, w.workItemId));

describe("a paired item: the gate merges the public pull request", () => {
  it("green public head: the status and the merge go to the code repository at its live head; the private copy is never merged", async () => {
    const w = await world();
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "merged", headSha: PUB_HEAD, status: "posted", reasons: [] });
    expect(w.pub.merges).toEqual([{ sha: PUB_HEAD, method: "squash" }]);
    expect(w.pub.posts).toHaveLength(1);
    expect(w.pub.posts[0]).toMatchObject({ sha: PUB_HEAD, body: { state: "success", context: REVIEW_STATUS_CONTEXT } });
    expect(w.priv.merges).toEqual([]);
    expect(w.priv.posts).toEqual([]);
    // The changed files and the CI came from the public pull request.
    // No live file list is read anywhere in the paired path; the changed files come from the explicit commits.
    expect([...w.pub.requests, ...w.priv.requests].some((r) => /\/pulls\/\d+\/files$/.test(r.path))).toBe(false);
    expect(w.priv.requests.some((r) => r.path.includes("/check-runs") || r.method === "PUT")).toBe(false);
  });

  it("the card's rows keep speaking of the reviewed head and the item's own pull request", async () => {
    const w = await world();
    await gate(w);
    const ev = await events(w);
    expect(ev.map((e) => e.kind)).toEqual(["review_status", "merge_gate", "merged_by_gate"]);
    expect(ev.find((e) => e.kind === "merge_gate")).toMatchObject({ code: "merged", head_sha: HEAD, pr_number: 41 });
  });

  it("the public check red: no merge on either repository, marked for a person with ci_not_green", async () => {
    const w = await world({ pubChecks: { [PUB_HEAD]: [{ name: "build", status: "completed", conclusion: "failure" }] } });
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["ci_not_green"] });
    expect(w.pub.merges).toEqual([]);
    expect(w.priv.merges).toEqual([]);
  });

  it("the public check still running: no merge", async () => {
    const w = await world({ pubChecks: { [PUB_HEAD]: [{ name: "build", status: "in_progress", conclusion: null }] } });
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["ci_not_green"] });
    expect(w.pub.merges).toEqual([]);
    expect(w.priv.merges).toEqual([]);
  });

  it("a green private copy does not stand in for a red public one", async () => {
    const w = await world({ pubChecks: { [PUB_HEAD]: [{ name: "build", status: "completed", conclusion: "failure" }] } });
    w.priv.checks[HEAD] = green;
    await gate(w);
    expect(w.pub.merges).toEqual([]);
    expect(w.priv.merges).toEqual([]);
  });

  it("a public head the platform did not push (the stamp names another): no status, no merge", async () => {
    const w = await world({ stamp: OTHER });
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "ready_human_merges", reasons: ["public_head_unrecorded"], status: "skipped" });
    expect(w.pub.merges).toEqual([]);
    expect(w.pub.posts).toEqual([]);
    expect(w.priv.merges).toEqual([]);
  });

  it("a branch a person took over (even at the stamped head): a human merge, no status, no merge", async () => {
    for (const stamp of [OTHER, PUB_HEAD]) {
      const w = await world({ stamp, managed: true });
      const out = await gate(w);
      expect(out).toMatchObject({ outcome: "ready_human_merges", status: "skipped" });
      expect(out.outcome === "ready_human_merges" && out.reasons).toContain("public_branch_person_managed");
      expect(w.pub.merges).toEqual([]);
      expect(w.pub.posts).toEqual([]);
    }
  });

  it("no stamp at all fails closed: public_head_unrecorded, no status, no merge", async () => {
    // The table forbids a pr_opened row with no head; a row mid-update can carry a pull request and no stamp.
    const w = await world({ stamp: null, state: "updating" });
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["public_head_unrecorded"], status: "skipped" });
    expect(w.pub.merges).toEqual([]);
    expect(w.pub.posts).toEqual([]);
  });

  it("a stamp with no recorded source head (a row from before it was kept) is a human merge", async () => {
    const w = await world({ source: null });
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["public_head_unrecorded"], status: "skipped" });
    expect(w.pub.merges).toEqual([]);
  });

  it("the public head was built from an older private head than the one the reviewers cleared: no status, no merge", async () => {
    const w = await world({ source: OTHER });
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["public_head_not_reviewed"], status: "skipped" });
    expect(w.pub.merges).toEqual([]);
    expect(w.pub.posts).toEqual([]);
  });

  it("the public head moves after the first read (before the status): no status and no merge", async () => {
    const w = await world();
    w.pub.checks[OTHER] = green;
    let reads = 0;
    const real = fakeGitHubRest(w.pub);
    const out = await runMergeGateForItem(
      {
        pool: h.runWriterPool,
        authorTrust: BOT_TRUST,
        http: fakeGitHubRest(w.priv),
        publicPlane: {
          open: async () => ({ request: async (req) => { if (req.method === "GET" && req.path === `/repos/acme/widgets-public/pulls/${PUB_PR}` && ++reads === 2) w.pub.headSha = OTHER; return real.request(req); } }),
          read: readPublicPullRequest(h.runWriterPool),
        },
      },
      { accountId: w.accountId, workItemId: w.workItemId, prNumber: 41 },
    );
    expect(out.outcome).toBe("head_moved");
    expect(w.pub.merges).toEqual([]);
    expect(w.pub.posts).toEqual([]);
  });

  it("the public head moves between the status and the gate's own read: no merge on the new head", async () => {
    const w = await world();
    w.pub.checks[OTHER] = green;
    let reads = 0;
    const real = fakeGitHubRest(w.pub);
    const out = await runMergeGateForItem(
      {
        pool: h.runWriterPool,
        authorTrust: BOT_TRUST,
        http: fakeGitHubRest(w.priv),
        publicPlane: {
          open: async () => ({ request: async (req) => { if (req.method === "GET" && req.path === `/repos/acme/widgets-public/pulls/${PUB_PR}` && ++reads === 3) w.pub.headSha = OTHER; return real.request(req); } }),
          read: readPublicPullRequest(h.runWriterPool),
        },
      },
      { accountId: w.accountId, workItemId: w.workItemId, prNumber: 41 },
    );
    expect(out).toMatchObject({ outcome: "head_moved" });
    expect(w.pub.merges).toEqual([]);
  });

  it("the private copy already closed while the public one is open: the files are still read (the security trigger decides) and the gate goes on", async () => {
    const w = await world();
    w.priv.state = "closed";
    w.pub.files = w.priv.files = [file("packages/auth/session.ts")];
    const out = await gate(w);
    expect(w.pub.requests.some((r) => r.path.endsWith("/files"))).toBe(false);
    // A security-sensitive path needs the security reviewer, who has no record here: no merge.
    expect(out.outcome === "ready_human_merges" && out.reasons.some((r) => r.includes("security"))).toBe(true);
    expect(w.pub.merges).toEqual([]);
  });

  it("auto-merge off: no merge on either repository, and the refusal is visible", async () => {
    const w = await world({ settings: {} });
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["auto_merge_not_allowed"] });
    expect(w.pub.merges).toEqual([]);
    expect(w.priv.merges).toEqual([]);
    expect((await events(w)).find((e) => e.kind === "merge_gate")).toMatchObject({ code: "ready_human_merges", reasons: ["auto_merge_not_allowed"] });
  });

  it("the reviewers' records are bound to the private head: a reviewer needs-fix there blocks the public merge", async () => {
    const w = await world();
    await h.admin.query("UPDATE agent_runs SET envelope = '{\"verdict\":\"needs-fix\"}'::jsonb WHERE work_item_id = $1 AND role = 'code-reviewer'", [w.workItemId]);
    const out = await gate(w);
    expect(out.outcome).toBe("ready_human_merges");
    expect(w.pub.merges).toEqual([]);
  });

  it("the public pull request already merged or closed: pr_not_open, nothing merged", async () => {
    const w = await world();
    w.pub.state = "closed";
    expect((await gate(w)).outcome).toBe("pr_not_open");
    expect(w.pub.merges).toEqual([]);
  });
});

describe("the public pull request must hold exactly what was reviewed (content binding)", () => {
  const blocked = async (w: World) => {
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "ready_human_merges", status: "skipped" });
    expect(out.outcome === "ready_human_merges" && out.reasons).toContain("public_head_not_reviewed");
    expect(w.pub.merges).toEqual([]);
    expect(w.pub.posts).toEqual([]);
    expect(w.priv.merges).toEqual([]);
  };

  it("an extra file in the public pull request", async () => {
    const w = await world();
    w.pub.files.push(file("src/evil.ts", { status: "added" }));
    await blocked(w);
  });

  it("a changed blob", async () => {
    const w = await world();
    w.pub.files = [file("src/ui/button.tsx", { sha: "e".repeat(40) })];
    await blocked(w);
  });

  it("a file the reviewed head changed but the public one lacks", async () => {
    const w = await world();
    w.priv.files.push(file("src/ui/other.tsx"));
    await blocked(w);
  });

  it("a different change type", async () => {
    const w = await world();
    w.pub.files = [file("src/ui/button.tsx", { status: "added" })];
    await blocked(w);
  });

  it("a public pull request that carries an overlay path", async () => {
    const w = await world();
    w.pub.files.push(file(".autonomous-team/plan.md", { status: "added" }));
    await blocked(w);
  });

  it("a truncated tree on either side", async () => {
    for (const side of ["pub", "priv"] as const) {
      const w = await world();
      w[side].treesTruncated = true;
      await blocked(w);
    }
  });

  it("a merge base that cannot be found", async () => {
    const w = await world();
    w.pub.compareFails = 404;
    await blocked(w);
  });

  it("a mode change with the same blob (exec bit), or a file turned into a symlink", async () => {
    for (const mode of ["100755", "120000"]) {
      const w = await world();
      w.pub.files = [file("src/ui/button.tsx", { mode })];
      await blocked(w);
    }
  });

  it("the pull request's own file list is clean but the tree at the bound public head holds something unreviewed: no merge", async () => {
    const w = await world();
    // The old files read would say "button.tsx only"; the commit itself also adds a file.
    w.pub.trees = { [PUB_HEAD]: [{ path: "src/ui/button.tsx", mode: "100644", type: "blob", sha: BLOB }, { path: "src/evil.ts", mode: "100644", type: "blob", sha: BLOB }] };
    await blocked(w);
  });

  it("the same on the private side: the reviewed head's tree differs from what its file list claims", async () => {
    const w = await world();
    w.priv.trees = { [HEAD]: [{ path: "src/ui/button.tsx", mode: "100644", type: "blob", sha: BLOB }, { path: "src/more.ts", mode: "100644", type: "blob", sha: BLOB }] };
    await blocked(w);
  });

  it("identical content merges, and an overlay-only difference on the private side is ignored", async () => {
    const w = await world();
    w.priv.files.push(file(".autonomous-team/plan.md", { status: "added", sha: "d".repeat(40) }));
    expect((await gate(w)).outcome).toBe("merged");
    expect(w.pub.merges).toEqual([{ sha: PUB_HEAD, method: "squash" }]);
  });

  const e = (path: string, sha: string, over: { mode?: string; type?: string } = {}) => ({ path, mode: "100644", type: "blob", sha, ...over });
  const X = "c".repeat(40);
  const V1 = "1".repeat(40);
  const V2 = "2".repeat(40);

  it("the same end content reached from a different starting content (v1->X reviewed, v2->X public): no merge", async () => {
    const w = await world();
    w.priv.trees = { [FAKE_MERGE_BASE]: [e("src/a.ts", V1)], [HEAD]: [e("src/a.ts", X)] };
    w.pub.trees = { [FAKE_MERGE_BASE]: [e("src/a.ts", V2)], [PUB_HEAD]: [e("src/a.ts", X)] };
    await blocked(w);
  });

  it("the same change from the same starting content merges (control for the case above)", async () => {
    const w = await world();
    w.priv.trees = { [FAKE_MERGE_BASE]: [e("src/a.ts", V1)], [HEAD]: [e("src/a.ts", X)] };
    w.pub.trees = { [FAKE_MERGE_BASE]: [e("src/a.ts", V1)], [PUB_HEAD]: [e("src/a.ts", X)] };
    w.pub.files = [file("src/a.ts")];
    expect((await gate(w)).outcome).toBe("merged");
  });

  it("the public pull request deletes a file the reviewed head does not", async () => {
    const w = await world();
    w.pub.files.push(file("src/gone.ts", { status: "removed" }));
    await blocked(w);
  });

  it("the reviewed head deletes a file the public pull request keeps", async () => {
    const w = await world();
    w.priv.files.push(file("src/gone.ts", { status: "removed" }));
    await blocked(w);
  });

  it("both delete the same file (also a nested one): merges; a nested deletion on one side only does not", async () => {
    const both = await world();
    for (const repo of [both.priv, both.pub]) repo.files.push(file("src/gone.ts", { status: "removed" }), file("src/deep/er/x.ts", { status: "removed" }));
    expect((await gate(both)).outcome).toBe("merged");
    const one = await world();
    one.pub.files.push(file("src/deep/er/x.ts", { status: "removed" }));
    await blocked(one);
  });

  it("a gitlink (mode 160000, type commit) or a type change with the same sha and a plain mode", async () => {
    for (const over of [{ mode: "160000", type: "commit" }, { type: "commit" }]) {
      const w = await world();
      w.pub.trees = { [PUB_HEAD]: [e("src/ui/button.tsx", BLOB, over)] };
      await blocked(w);
    }
  });

  it("a pull request whose base is not the repository's default branch, on either side", async () => {
    for (const side of ["pub", "priv"] as const) {
      const w = await world();
      w[side].baseRef = "old-main";
      await blocked(w);
    }
  });

  it("a public head that is not one commit on its merge base (two parents, or another parent)", async () => {
    for (const parents of [[FAKE_MERGE_BASE, OTHER], [OTHER]]) {
      const w = await world();
      w.pub.commitParents = { [PUB_HEAD]: parents };
      await blocked(w);
    }
  });

  it("the live file list is clean but the commits change a security-sensitive path: the security reviewer is required", async () => {
    const w = await world();
    const clean = [e("src/ui/button.tsx", BLOB)];
    const withAuth = [...clean, e("packages/auth/session.ts", BLOB)];
    // The pull requests' own file lists (what a live read would see) say "button.tsx only".
    w.priv.trees = { [HEAD]: withAuth };
    w.pub.trees = { [PUB_HEAD]: withAuth };
    const out = await gate(w);
    expect(out.outcome).toBe("ready_human_merges");
    expect(out.outcome === "ready_human_merges" && out.reasons).toContain("missing_run_security_reviewer");
    expect(w.pub.merges).toEqual([]);
  });

  it("a path in the tree diff that the compare did not list is a change of unknown size: the security reviewer is required, no merge", async () => {
    const w = await world();
    w.pub.compareFiles = [];
    const out = await gate(w);
    expect(out.outcome === "ready_human_merges" && out.reasons).toContain("missing_run_security_reviewer");
    expect(w.pub.merges).toEqual([]);
  });

  it("a compare entry with no patch and no count of changes is a change of unknown size too", async () => {
    const w = await world();
    w.pub.compareFiles = [{ filename: "src/ui/button.tsx" }];
    const out = await gate(w);
    expect(out.outcome === "ready_human_merges" && out.reasons).toContain("missing_run_security_reviewer");
    expect(w.pub.merges).toEqual([]);
  });

  it("over 100 files is one compare read (GitHub does not page a compare's files) and merges when both sides are identical", async () => {
    const w = await world();
    const many = Array.from({ length: 150 }, (_, i) => file(`src/f${i}.ts`));
    w.priv.files = many;
    w.pub.files = many;
    expect((await gate(w)).outcome).toBe("merged");
    expect(w.pub.requests.filter((r) => /\/compare\/[0-9a-f]{40}\.\.\./.test(r.path)).length).toBe(1);
  });

  it("a compare that lists 300 files may be cut short: incomplete, so the security trigger fires and nothing merges", async () => {
    const w = await world();
    const many = Array.from({ length: 300 }, (_, i) => file(`src/f${i}.ts`));
    w.priv.files = many;
    w.pub.files = many;
    const out = await gate(w);
    expect(out.outcome === "ready_human_merges" && out.reasons).toEqual(expect.arrayContaining(["public_head_not_reviewed", "missing_run_security_reviewer"]));
    expect(w.pub.merges).toEqual([]);
  });

  it("the files compare failing leaves the list incomplete even with no paths to judge: the security trigger fires and nothing merges", async () => {
    const w = await world();
    w.priv.files = [];
    w.pub.files = [];
    w.pub.compareFilesFail = 500;
    const out = await gate(w);
    expect(out.outcome === "ready_human_merges" && out.reasons).toEqual(expect.arrayContaining(["public_head_not_reviewed", "missing_run_security_reviewer"]));
    expect(w.pub.merges).toEqual([]);
  });

  it("each side's trees are read once per gate pass", async () => {
    const w = await world();
    await gate(w);
    for (const repo of [w.priv, w.pub]) expect(repo.requests.filter((r) => r.path.includes("/git/trees/")).length).toBe(2);
  });
});

describe("a runner-built item: the private head comes from what the cloud recorded, never from the runner", () => {
  it("first push: the stamp has no source head of its own; the cloud-read head of the finishing run clears it", async () => {
    const w = await world({ source: null, runner: [{ kind: "push", outcome: "pr_opened", headOid: HEAD }] });
    expect((await h.admin.query("SELECT source_head FROM plane_pushes WHERE work_item_id = $1", [w.workItemId])).rows[0].source_head).toBeNull();
    expect((await gate(w)).outcome).toBe("merged");
    expect(w.pub.merges).toEqual([{ sha: PUB_HEAD, method: "squash" }]);
  });

  it("re-push (fix round): the newest stamp-moving attempt's head is the one that counts", async () => {
    const w = await world({ source: null, runner: [{ kind: "push", outcome: "pr_opened", headOid: OTHER }, { kind: "fix_round", outcome: "updated", headOid: HEAD }] });
    expect((await gate(w)).outcome).toBe("merged");
  });

  it("re-push built from a head other than the reviewed one: public_head_not_reviewed, no merge", async () => {
    const w = await world({ source: null, runner: [{ kind: "push", outcome: "pr_opened", headOid: HEAD }, { kind: "fix_round", outcome: "updated", headOid: OTHER }] });
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["public_head_not_reviewed"] });
    expect(w.pub.merges).toEqual([]);
  });

  it("the newest attempt's run has no succeeded finish: its head is unknown, and an older run's head is never used in its place", async () => {
    const w = await world({ source: null, runner: [{ kind: "push", outcome: "pr_opened", headOid: HEAD }, { kind: "fix_round", outcome: "updated", headOid: null }] });
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["public_head_unrecorded"] });
    expect(w.pub.merges).toEqual([]);
  });

  it("a refused or no-change attempt does not move the answer; no recorded head at all is a human merge", async () => {
    const a = await world({ source: null, runner: [{ kind: "push", outcome: "pr_opened", headOid: HEAD }, { kind: "fix_round", outcome: "no_change", headOid: OTHER }] });
    expect((await gate(a)).outcome).toBe("merged");
    const b = await world({ source: null, runner: [{ kind: "push", outcome: "pr_opened", headOid: null }] });
    expect(await gate(b)).toMatchObject({ outcome: "ready_human_merges", reasons: ["public_head_unrecorded"] });
    expect(b.pub.merges).toEqual([]);
  });
});

describe("a single-plane item is unchanged", () => {
  it("no pairing: the gate merges the item's own pull request and never opens the code repository", async () => {
    const w = await world({ paired: false });
    const out = await runMergeGateForItem(
      {
        pool: h.runWriterPool,
        authorTrust: BOT_TRUST,
        http: fakeGitHubRest(w.priv),
        publicPlane: {
          open: async () => {
            throw new Error("the public plane must not be opened");
          },
          read: readPublicPullRequest(h.runWriterPool),
        },
      },
      { accountId: w.accountId, workItemId: w.workItemId, prNumber: 41 },
    );
    expect(out).toMatchObject({ outcome: "merged", headSha: HEAD });
    expect(w.priv.merges).toEqual([{ sha: HEAD, method: "squash" }]);
    expect(w.pub.requests).toEqual([]);
  });
});
