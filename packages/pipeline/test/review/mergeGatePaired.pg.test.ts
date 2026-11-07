import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { listDriverEvents } from "@fx/core/src/work-items/driverEvents.js";
import { DEQUEUE_PULL_REQUEST_DOCUMENT, ENABLE_AUTO_MERGE_DOCUMENT, ENQUEUE_PULL_REQUEST_DOCUMENT, MERGE_QUEUE_ENTRY_DOCUMENT, MERGE_QUEUE_READ_DOCUMENT } from "../../../github/src/mergeGateGraphql.js";
import { clearMergeQueueModeCache } from "../../src/build/githubMergePort.js";
import { applyQueueEvent } from "../../src/mergeQueue/index.js";
import { readPublicPullRequest } from "../../src/review/publicPullRequest.js";
import { runMergeGateForItem, type Gate1StatusCheck } from "../../src/review/mergeGateRun.js";
import { ACTIONS_APP_ID, GATE1_DESCRIPTIONS, GATE1_WORKFLOW_CONTEXTS } from "../../src/review/gate1Attest.js";
import { gate1World } from "./helpers/fakeGitHubLocal.js";
import { REVIEW_STATUS_CONTEXT } from "../../src/review/githubReads.js";
import { discussingItem } from "../plan/helpers/panelFixtures.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { FAKE_MERGE_BASE, defaultGhId, fakeGitHubRest, freshRepo, type FakeRepoState } from "./helpers/fakeGitHubRest.js";

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
  /** D#598 P1g-3a: a person's confirmed Replace, not yet used by an update: the head the authorization names. */
  authorized?: string;
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
  if (o.paired !== false && o.authorized !== undefined) await h.admin.query("UPDATE plane_pushes SET replace_authorized_head = $2 WHERE work_item_id = $1", [workItemId, o.authorized]);
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

  it("D#598 P1g-3a: after a confirmed Replace and before the update, the person's head is not merged and not blessed: public_head_unrecorded, no status, no merge", async () => {
    // The stamp is still the platform's older head; the live head is the person's, and it is exactly the head the authorization names.
    const w = await world({ stamp: OTHER, pubHead: PUB_HEAD, authorized: PUB_HEAD });
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["public_head_unrecorded"], status: "skipped" });
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
    // The code repository (public) also has its default branch's tree read once for the order check (D#483 S5-j2a2).
    expect(w.priv.requests.filter((r) => r.path.includes("/git/trees/")).length).toBe(2);
    expect(w.pub.requests.filter((r) => r.path.includes("/git/trees/")).length).toBe(3);
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

describe("D#483 S5-j2a2: the order check of a paired item reads the code repository, on the public client", () => {
  const MIGS = ["sql/0009_x.sql", "sql/0010_a.sql"];
  const entry = (path: string) => ({ path, mode: "100644", type: "blob", sha: BLOB });
  const HEAD2 = "e".repeat(40);
  const PUB_HEAD2 = "1".repeat(40);

  /** A second work item on the first one's repository, with its private copy (PR 42) and its public pull request (13). Unpaired until `pair` is called. */
  async function sibling(w: World) {
    const { workItemId } = await discussingItem(h.runWriterPool, w.accountId, { title: "Add a header", body: "Show the year in the header.", category: "feature", repoId: w.repoId });
    await h.admin.query("UPDATE work_items SET gh_number = 8, repo_id = $2, stage = 'pr_opened', provenance = 'internal' WHERE id = $1", [workItemId, w.repoId]);
    const body = "1. The header shows the year.";
    await h.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [w.accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
    // A migration file in the diff brings the security reviewer in.
    for (const role of ["code-reviewer", "acceptance-tester", "security-reviewer"]) {
      await h.admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, 'production', 'succeeded', $4::jsonb, $5)", [w.accountId, workItemId, role, JSON.stringify({ verdict: "pass" }), HEAD2]);
    }
    await h.admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, 'security-reviewer', 'production', 'succeeded', $3::jsonb, $4)", [w.accountId, w.workItemId, JSON.stringify({ verdict: "pass" }), HEAD]);
    const priv = freshRepo({ headSha: HEAD2, prNumber: 42, checks: { [HEAD2]: [] }, files: [file("sql/0011_b.sql", { status: "added" })] });
    const pub = freshRepo({ owner: "acme", name: "widgets-public", prNumber: 13, isPublic: true, authorLogin: BOT_LOGIN, headSha: PUB_HEAD2, checks: { [PUB_HEAD2]: green }, files: [file("sql/0011_b.sql", { status: "added" })] });
    return { workItemId, priv, pub, pubHead: PUB_HEAD2, head: HEAD2 };
  }
  type Sibling = Awaited<ReturnType<typeof sibling>>;

  /** The repository has a pairing from now on, and the platform pushed both public pull requests (the stamps). */
  async function pair(w: World, s: Sibling) {
    await h.admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['.autonomous-team/**'])", [w.repoId, w.accountId]);
    const push = (workItemId: string, pubHead: string, pr: number, source: string) =>
      h.admin.query(
        `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state, head_sha, tip_sha, pr_number, pr_url, source_head)
         VALUES ($1, $2, $3, 'acme/widgets-public', $4, 'pr_opened', $5, $5, $6, $7, $8)`,
        [w.accountId, workItemId, w.repoId, "a".repeat(64), pubHead, pr, `https://github.com/acme/widgets-public/pull/${pr}`, source],
      );
    await push(w.workItemId, PUB_HEAD, PUB_PR, HEAD);
    await push(s.workItemId, s.pubHead, 13, s.head);
  }

  /** The default branch of the code repository holds `paths`, on both planes (the content check compares their base trees, which must agree). */
  const setTip = (fakes: FakeRepoState[], paths: string[]) => {
    for (const f of fakes) f.trees = { ...f.trees, [FAKE_MERGE_BASE]: paths.map(entry) };
  };
  const gateOf = (w: World, workItemId: string, priv: FakeRepoState, pub: FakeRepoState) =>
    runMergeGateForItem(
      { pool: h.runWriterPool, authorTrust: BOT_TRUST, http: fakeGitHubRest(priv), publicPlane: { open: async () => fakeGitHubRest(pub), read: readPublicPullRequest(h.runWriterPool) } },
      { accountId: w.accountId, workItemId, prNumber: priv.prNumber },
    );

  it("pairing after claims: two hosted items start unpaired, a pairing row is added, both reach the gate: exactly one merges, the other is stopped on the code repository's tip", async () => {
    const w = await world({ paired: false });
    w.priv.files = [file("sql/0011_a.sql", { status: "added" })];
    w.pub.files = [file("sql/0011_a.sql", { status: "added" })];
    const s = await sibling(w);
    await pair(w, s);
    setTip([w.priv, w.pub, s.priv, s.pub], MIGS);
    const first = await gateOf(w, w.workItemId, w.priv, w.pub);
    expect(first).toMatchObject({ outcome: "merged", headSha: PUB_HEAD });
    // The first one landed on the code repository's default branch.
    setTip([s.priv, s.pub], [...MIGS, "sql/0011_a.sql"]);
    const second = await gateOf(w, s.workItemId, s.priv, s.pub);
    expect(second).toMatchObject({ outcome: "ready_human_merges", reasons: ["ordered_resource_out_of_order"] });
    expect(s.pub.merges).toEqual([]);
    expect(s.priv.merges).toEqual([]);
  });

  it("the tip and the pull request's adds come from the code repository through the public client; the private repository is not asked", async () => {
    const w = await world();
    await h.admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, 'security-reviewer', 'production', 'succeeded', $3::jsonb, $4)", [w.accountId, w.workItemId, JSON.stringify({ verdict: "pass" }), HEAD]);
    w.priv.files = [file("sql/0011_a.sql", { status: "added" })];
    w.pub.files = [file("sql/0011_a.sql", { status: "added" })];
    setTip([w.priv, w.pub], MIGS);
    expect(await gateOf(w, w.workItemId, w.priv, w.pub)).toMatchObject({ outcome: "merged" });
    expect(w.pub.requests.some((r) => r.path.includes("/git/trees/"))).toBe(true);
    expect(w.pub.requests.some((r) => /\/pulls\/12\/files$/.test(r.path))).toBe(true);
    expect(w.priv.requests.some((r) => r.path.includes("/git/ref/") || /\/pulls\/\d+\/files$/.test(r.path))).toBe(false);
  });

  describe("a paired item behind the code repository's own merge queue holds the lease until the code repository's webhook settles it", () => {
    const docs = { read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT, dequeue: DEQUEUE_PULL_REQUEST_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT };
    const enqueuedPaired = async (queueOver: Partial<NonNullable<FakeRepoState["mergeQueue"]>> = {}) => {
      clearMergeQueueModeCache();
      const w = await world();
      // A numbered file on a tip that holds 0009 and 0010: the lease is held for it (R-C35-4).
      await h.admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, 'security-reviewer', 'production', 'succeeded', $3::jsonb, $4)", [w.accountId, w.workItemId, JSON.stringify({ verdict: "pass" }), HEAD]);
      w.priv.files = [file("sql/0011_a.sql", { status: "added" })];
      w.pub.files = [file("sql/0011_a.sql", { status: "added" })];
      setTip([w.priv, w.pub], MIGS);
      w.pub.mergeQueue = { exists: true, mutations: [], ...queueOver };
      w.pub.rulesetRules = [{ type: "merge_queue", enforcement: "active" }];
      const out = await runMergeGateForItem(
        { pool: h.runWriterPool, authorTrust: BOT_TRUST, http: fakeGitHubRest(w.priv), queueDocuments: docs, publicPlane: { open: async () => fakeGitHubRest(w.pub), read: readPublicPullRequest(h.runWriterPool) } },
        { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.priv.prNumber },
      );
      expect(out.outcome).toBe("merge_enqueued");
      return w;
    };
    const holders = async (w: World) => (await h.admin.query<{ holder: string }>("SELECT holder FROM repo_merge_leases WHERE repo_id = $1", [w.repoId])).rows.map((r) => r.holder);
    // The event is the code repository's: its repository id is not the private one, and its payload names the code repository.
    const hook = (w: World, payload: Record<string, unknown>) =>
      withTenant(h.runWriterPool, w.accountId, (c) => applyQueueEvent(c, { accountId: w.accountId, repoId: randomUUID(), eventName: "pull_request", payload: { repository: { id: defaultGhId("acme", "widgets-public") }, ...payload } }));

    it("the hold is named for the public pull request; sibling direct merges see merge_repo_busy meanwhile; a close of it frees the lease at once", async () => {
      const w = await enqueuedPaired();
      expect(await holders(w)).toEqual([expect.stringMatching(new RegExp(`^ghq:${PUB_PR}:${defaultGhId("acme", "widgets-public")}:\\d+:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`))]);
      expect(await gateOf(w, w.workItemId, w.priv, w.pub)).toMatchObject({ outcome: "ready_human_merges", reasons: ["merge_repo_busy"] });
      // The private copy's number and another repository's event leave it.
      await hook(w, { action: "closed", pull_request: { number: 41, merged: true, head: { sha: HEAD } } });
      await hook(w, { action: "closed", repository: { id: 1 }, pull_request: { number: PUB_PR, merged: true, head: { sha: HEAD } } });
      expect(await holders(w)).toHaveLength(1);
      await hook(w, { action: "closed", pull_request: { number: PUB_PR, merged: true, head: { sha: PUB_HEAD } } });
      expect(await holders(w)).toEqual([]);
    });

    const lapse = (w: World) => h.admin.query("UPDATE repo_merge_leases SET lease_until = now() - interval '1 second' WHERE repo_id = $1", [w.repoId]);
    const reread = (w: World) =>
      runMergeGateForItem(
        { pool: h.runWriterPool, authorTrust: BOT_TRUST, http: fakeGitHubRest(w.priv), queueDocuments: docs, publicPlane: { open: async () => fakeGitHubRest(w.pub), read: readPublicPullRequest(h.runWriterPool) } },
        { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.priv.prNumber },
      );
    // The private pull request is 41 and the public one 12: the facts of the item carry 41, the hold carries 12 and the item's id. Another item whose private number is 12 is never the one read.
    const decoy = async (w: World, code: string) => {
      const s = await sibling(w);
      await h.admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key, code, head_sha, pr_number) VALUES ($1, $2, 'merge_enqueued', 'decoy', $3, $4, $5)", [w.accountId, s.workItemId, code, s.head, PUB_PR]);
      return s;
    };

    it("a paired item that fell back to auto-merge holds past its lapse while the public pull request is open (the hold is read by the item, not by a pull request number), and frees when it closes", async () => {
      const w = await enqueuedPaired({ enqueue: "forbidden" });
      const { rows } = await h.admin.query("SELECT code, pr_number FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'merge_enqueued'", [w.workItemId]);
      expect(rows).toEqual([{ code: "auto_merge", pr_number: 41 }]);
      await lapse(w);
      expect(await reread(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["merge_repo_busy"] });
      expect(await holders(w)).toHaveLength(1);
      await lapse(w);
      w.pub.state = "closed";
      w.pub.merged = true;
      expect(await reread(w)).toMatchObject({ outcome: "pr_not_open" });
      expect(await holders(w)).toEqual([]);
    });

    it("another item whose private number equals the public one is never read: its auto-merge fact does not keep a queued item's lapsed hold, and a queued item's own lapsed hold is gone once it left the queue", async () => {
      const w = await enqueuedPaired({ entry: undefined });
      await decoy(w, "auto_merge");
      w.pub.mergeQueue = { ...w.pub.mergeQueue!, entry: null };
      await lapse(w);
      expect(await reread(w)).toMatchObject({ outcome: "merge_enqueued" });
    });

    it("the 24-hour end is recorded on the item the hold names, not on another item with the same number", async () => {
      const w = await enqueuedPaired();
      const other = await decoy(w, "queue");
      await h.admin.query("UPDATE repo_merge_leases SET lease_until = now() - interval '1 second', holder = regexp_replace(holder, '^(ghq:[0-9]+:[0-9]+:)[0-9]+', '\\1' || (floor(extract(epoch FROM now()) / 60) - 1500)::bigint::text) WHERE repo_id = $1", [w.repoId]);
      expect(await reread(w)).toMatchObject({ outcome: "merge_enqueued" });
      const on = async (id: string) => (await h.admin.query("SELECT 1 FROM work_item_driver_events WHERE work_item_id = $1 AND code = 'merge_hold_expired'", [id])).rows.length;
      expect([await on(w.workItemId), await on(other.workItemId)]).toEqual([1, 0]);
    });

    it("unreadable reads of a paired hold are counted and surface at the third; still in the queue stays busy; out of the queue and open frees it", async () => {
      const w = await enqueuedPaired();
      w.pub.mergeQueue = { ...w.pub.mergeQueue!, readFails: true };
      for (let n = 1; n <= 2; n++) {
        await lapse(w);
        expect(await reread(w), String(n)).toMatchObject({ reasons: ["merge_repo_busy"] });
      }
      await lapse(w);
      expect(await reread(w)).toMatchObject({ reasons: ["merge_repo_busy", "ordered_resource_unreadable"] });
      await lapse(w);
      w.pub.mergeQueue = { exists: true, mutations: [], entry: { id: "MQE_kwDOfake1", state: "AWAITING_CHECKS", position: 1 } };
      expect(await reread(w)).toMatchObject({ reasons: ["merge_repo_busy"] });
      await lapse(w);
      w.pub.mergeQueue = { exists: true, mutations: [], entry: null };
      expect(await reread(w)).toMatchObject({ outcome: "merge_enqueued" });
    });

    it("a removal from the queue that is not its own success frees it as well", async () => {
      const w = await enqueuedPaired();
      await hook(w, { action: "dequeued", reason: "MERGE", pull_request: { number: PUB_PR, merged: false, head: { sha: PUB_HEAD } } });
      expect(await holders(w)).toHaveLength(1);
      await hook(w, { action: "dequeued", reason: "CI_FAILURE", pull_request: { number: PUB_PR, merged: false, head: { sha: PUB_HEAD } } });
      expect(await holders(w)).toEqual([]);
    });
  });

  it("the code repository's tip that cannot be read stops the paired item; nothing is merged", async () => {
    const w = await world();
    await h.admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, 'security-reviewer', 'production', 'succeeded', $3::jsonb, $4)", [w.accountId, w.workItemId, JSON.stringify({ verdict: "pass" }), HEAD]);
    w.priv.files = [file("sql/0011_a.sql", { status: "added" })];
    w.pub.files = [file("sql/0011_a.sql", { status: "added" })];
    setTip([w.priv, w.pub], MIGS);
    w.pub.treesTruncated = true;
    const out = await gateOf(w, w.workItemId, w.priv, w.pub);
    expect(out.outcome === "ready_human_merges" && out.reasons).toContain("ordered_resource_unreadable");
    expect(w.pub.merges).toEqual([]);
  });
});

describe("D#6 CLOUD-POSTS-FX-GATE1 PR 1e: a hosted cloud item counts fx-gate1 only when our App's bot posted it (REST statuses)", () => {
  const LISTED: Gate1StatusCheck = { repos: new Set(["acme/widgets-public"]), ourLogin: async () => "fx-cloud-app[bot]" };
  const AGENT = { __typename: "User", login: "autonomous-agent-7" };
  const OURS = { __typename: "Bot", login: "fx-cloud-app[bot]" };
  /** The public head carries `fx-gate1` (state as given) from `creator`, on the plain hosted client (REST creator `{ login, type }`). */
  async function posted(creator: { __typename: string; login: string } | null, o: { state?: string } = {}) {
    const w = await world();
    if (creator !== null) w.pub.statuses[PUB_HEAD] = { "fx-gate1": o.state ?? "success" };
    const g1 = gate1World({ creators: creator === null ? {} : { [PUB_HEAD]: creator } });
    const run = (gate1Status?: Gate1StatusCheck) =>
      runMergeGateForItem(
        { pool: h.runWriterPool, authorTrust: BOT_TRUST, http: fakeGitHubRest(w.priv), publicPlane: { open: async () => fakeGitHubRest(w.pub, { gate1: g1 }), read: readPublicPullRequest(h.runWriterPool) }, ...(gate1Status ? { gate1Status } : {}) },
        { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.priv.prNumber },
      );
    const creatorReads = () => w.pub.requests.filter((r) => r.method === "GET" && r.path === `/repos/acme/widgets-public/commits/${PUB_HEAD}/statuses`).length;
    return { w, run, creatorReads };
  }
  const reasonsOf = (out: Awaited<ReturnType<typeof runMergeGateForItem>>) => ("reasons" in out ? out.reasons : []);

  it("a person's or a token's fx-gate1, another app's, and every lookalike: not green, gate1_status_foreign, nothing merged, read through REST (no GraphQL)", async () => {
    const lookalikes = [AGENT, { __typename: "Bot", login: "other-app[bot]" }, { __typename: "User", login: "fx-cloud-app[bot]" }, { __typename: "Organization", login: "fx-cloud-app" }, { __typename: "Bot", login: "FX-cloud-app[bot]" }, { __typename: "Bot", login: "fx-cloud-app-evil[bot]" }, { __typename: "Bot", login: "fx-cloud-ap[bot]" }, { __typename: "Bot", login: "fx-cloud-app[bot]x" }];
    for (const creator of lookalikes) {
      const t = await posted(creator);
      const out = await t.run(LISTED);
      expect(out.outcome, creator.login).toBe("ready_human_merges");
      expect(reasonsOf(out)).toEqual(expect.arrayContaining(["ci_not_green", "gate1_status_foreign"]));
      expect(t.w.pub.merges).toEqual([]);
      expect(t.creatorReads()).toBeGreaterThan(0);
      expect(t.w.pub.requests.some((r) => r.path === "/graphql")).toBe(false);
      expect((await events(t.w)).find((e) => e.kind === "merge_gate")?.reasons).toContain("gate1_status_foreign");
    }
  });

  it("our App's bot posted success (by REST login or bare slug): green, merged", async () => {
    for (const creator of [OURS, { __typename: "Bot", login: "fx-cloud-app" }]) {
      const t = await posted(creator);
      expect(await t.run(LISTED), creator.login).toMatchObject({ outcome: "merged", headSha: PUB_HEAD });
      expect(t.w.pub.merges).toEqual([{ sha: PUB_HEAD, method: "squash" }]);
      expect(t.creatorReads()).toBeGreaterThan(0);
    }
  });

  it("a CHECK RUN named fx-gate1, from any app (Actions included), is foreign: alone, or next to our own success status", async () => {
    for (const app of [{ id: 15368 }, { id: 1 }]) {
      for (const creator of [null, OURS]) {
        const t = await posted(creator);
        t.w.pub.checks[PUB_HEAD] = [...green, { name: "fx-gate1", status: "completed", conclusion: "success", app }];
        const out = await t.run(LISTED);
        expect(out.outcome, `${app.id} ${creator?.login}`).toBe("ready_human_merges");
        expect(reasonsOf(out)).toEqual(expect.arrayContaining(["ci_not_green", "gate1_status_foreign"]));
        expect(t.w.pub.merges).toEqual([]);
      }
    }
    // A check run of another name is not touched.
    const t = await posted(OURS);
    t.w.pub.checks[PUB_HEAD] = [...green, { name: "fx-gate1-lint", status: "completed", conclusion: "success" }];
    expect(await t.run(LISTED)).toMatchObject({ outcome: "merged" });
  });

  it("our App's bot posted failure, error or pending: not green, not merged, not foreign", async () => {
    for (const state of ["failure", "error", "pending"]) {
      const t = await posted(OURS, { state });
      const r = reasonsOf(await t.run(LISTED));
      expect(r, state).toContain("ci_not_green");
      expect(r, state).not.toContain("gate1_status_foreign");
      expect(t.w.pub.merges).toEqual([]);
    }
  });

  it("unlisted, the setting empty, or no check given: no creator read, and the gate is as before (a foreign fx-gate1 still counts)", async () => {
    for (const g of [{ repos: new Set(["acme/other"]), ourLogin: LISTED.ourLogin }, { repos: new Set<string>(), ourLogin: LISTED.ourLogin }, undefined]) {
      const t = await posted(AGENT);
      expect(await t.run(g)).toMatchObject({ outcome: "merged" });
      expect(t.creatorReads()).toBe(0);
    }
  });

  describe("an item in flight when the setting went on: the gate attests the head it is about to judge when our success is missing", () => {
    const T = "2026-11-07T10:00:00Z";
    const AFTER = "2026-11-07T10:05:00Z";
    const ATTEST: Gate1StatusCheck = { ...LISTED, attest: true };
    const actions = (startedAt: string, conclusion: string | null = "success") => GATE1_WORKFLOW_CONTEXTS.map((name) => ({ name, status: "completed", conclusion, startedAt, app: { id: ACTIONS_APP_ID } }));
    /** The public head: a team-posted (or no) fx-gate1, the five Actions contexts as given, and `ci:full` labelled at T or not at all. */
    async function inFlight(o: { creator?: { __typename: string; login: string } | null; runs?: ReturnType<typeof actions>; labeled?: boolean } = {}) {
      const w = await world({ pubChecks: { [PUB_HEAD]: o.runs ?? actions(AFTER) } });
      const creator = o.creator === undefined ? AGENT : o.creator;
      if (creator !== null) w.pub.statuses[PUB_HEAD] = { "fx-gate1": "success" };
      const g1 = gate1World({ creators: creator === null ? {} : { [PUB_HEAD]: creator }, ...(o.labeled === false ? {} : { labels: ["ci:full"], labelEvents: [{ event: "labeled" as const, label: "ci:full", createdAt: T }] }) });
      const run = (gate1Status?: Gate1StatusCheck) =>
        runMergeGateForItem(
          { pool: h.runWriterPool, authorTrust: BOT_TRUST, http: fakeGitHubRest(w.priv), publicPlane: { open: async () => fakeGitHubRest(w.pub, { gate1: g1 }), read: readPublicPullRequest(h.runWriterPool) }, ...(gate1Status ? { gate1Status } : {}) },
          { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.priv.prNumber },
        );
      const attesterReads = () => w.pub.requests.filter((r) => r.path.endsWith("/events") || r.path.endsWith(`/pulls/${PUB_PR}/files`)).length;
      return { w, g1, run, attesterReads };
    }
    const gate1Posts = (w: World) => w.pub.posts.filter((p) => p.sha === PUB_HEAD && (p.body as { context?: string }).context === "fx-gate1").map((p) => p.body);

    it("only a foreign fx-gate1 (a person's, a token's): ours is posted, the status is read again, and the item merges", async () => {
      const t = await inFlight();
      expect(await t.run(ATTEST)).toMatchObject({ outcome: "merged", headSha: PUB_HEAD });
      expect(gate1Posts(t.w)).toEqual([{ state: "success", context: "fx-gate1", description: GATE1_DESCRIPTIONS.success }]);
      expect(t.w.pub.merges).toEqual([{ sha: PUB_HEAD, method: "squash" }]);
      expect(t.g1.labelAdds).toBe(0);
    });

    it("no fx-gate1 on the head at all: attested the same way, then merged", async () => {
      const t = await inFlight({ creator: null });
      expect(await t.run(ATTEST)).toMatchObject({ outcome: "merged" });
      expect(gate1Posts(t.w)).toHaveLength(1);
    });

    it("the attester says wait (no ci:full yet: the label is added): the gate waits, nothing is posted, nothing is merged, and it is not read as foreign", async () => {
      for (const creator of [AGENT, null]) {
        const t = await inFlight({ creator, labeled: false });
        const out = await t.run(ATTEST);
        expect(out.outcome, String(creator?.login)).toBe("ready_human_merges");
        expect(reasonsOf(out)).toContain("ci_not_green");
        expect(reasonsOf(out)).not.toContain("gate1_status_foreign");
        expect(t.g1.labelAdds).toBe(1);
        expect(gate1Posts(t.w)).toEqual([]);
        expect(t.w.pub.merges).toEqual([]);
      }
    });

    it("a run that started before the label, or one still running: wait, nothing posted, nothing merged", async () => {
      const running = actions(AFTER).map((c, i) => (i === 2 ? { ...c, status: "in_progress", conclusion: null } : c));
      for (const runs of [actions("2026-11-07T09:55:00Z"), running]) {
        const t = await inFlight({ runs });
        expect((await t.run(ATTEST)).outcome).toBe("ready_human_merges");
        expect(gate1Posts(t.w)).toEqual([]);
        expect(t.w.pub.merges).toEqual([]);
      }
    });

    it("a red full run: the attester posts failure, the gate takes the failure path, nothing is merged", async () => {
      const t = await inFlight({ runs: actions(AFTER, "failure") });
      const out = await t.run(ATTEST);
      expect(out.outcome).toBe("ready_human_merges");
      expect(reasonsOf(out)).toContain("ci_not_green");
      expect(gate1Posts(t.w)).toEqual([{ state: "failure", context: "fx-gate1", description: GATE1_DESCRIPTIONS.failure.ci_red }]);
      expect(t.w.pub.merges).toEqual([]);
    });

    it("a change to CI files is refused before any label: failure posted, nothing merged", async () => {
      const t = await inFlight({ labeled: false });
      t.w.pub.files = [{ filename: ".github/workflows/ci.yml", status: "modified", sha: BLOB, patch: "@@ -1 +1 @@\n+x", changes: 1 }];
      expect((await t.run(ATTEST)).outcome).toBe("ready_human_merges");
      expect(t.g1.labelAdds).toBe(0);
      expect(gate1Posts(t.w)).toEqual([{ state: "failure", context: "fx-gate1", description: GATE1_DESCRIPTIONS.failure.ci_paths }]);
      expect(t.w.pub.merges).toEqual([]);
    });

    it("our success already on the head: no attester read at all; unlisted repository, or the flag off (the go phase's read-only form): zero attester calls, as before", async () => {
      const ours = await inFlight({ creator: OURS });
      expect(await ours.run(ATTEST)).toMatchObject({ outcome: "merged" });
      expect(ours.attesterReads()).toBe(0);
      expect(gate1Posts(ours.w)).toEqual([]);
      for (const g of [{ repos: new Set(["acme/other"]), ourLogin: LISTED.ourLogin, attest: true }, { repos: new Set<string>(), ourLogin: LISTED.ourLogin, attest: true }, LISTED, undefined]) {
        const t = await inFlight();
        const out = await t.run(g);
        expect(t.attesterReads()).toBe(0);
        expect(gate1Posts(t.w)).toEqual([]);
        expect(t.g1.labelAdds).toBe(0);
        // Listed without the flag: the foreign status still stops; otherwise the gate is as before.
        if (g === LISTED) expect(reasonsOf(out)).toContain("gate1_status_foreign");
      }
    });

    it("a head the platform did not stamp, or a person's branch, is never attested", async () => {
      for (const o of [{ stamp: "e".repeat(40) }, { managed: true }]) {
        const w = await world({ ...o, pubChecks: { [PUB_HEAD]: actions(AFTER) } });
        w.pub.statuses[PUB_HEAD] = { "fx-gate1": "success" };
        const g1 = gate1World({ creators: { [PUB_HEAD]: AGENT }, labels: ["ci:full"], labelEvents: [{ event: "labeled" as const, label: "ci:full", createdAt: T }] });
        await runMergeGateForItem(
          { pool: h.runWriterPool, authorTrust: BOT_TRUST, http: fakeGitHubRest(w.priv), publicPlane: { open: async () => fakeGitHubRest(w.pub, { gate1: g1 }), read: readPublicPullRequest(h.runWriterPool) }, gate1Status: ATTEST },
          { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.priv.prNumber },
        );
        expect(gate1Posts(w)).toEqual([]);
        expect(w.pub.merges).toEqual([]);
      }
    });
  });

  it("no fx-gate1 on the head: no creator read; an unreadable read is a throw, never green", async () => {
    const none = await posted(null);
    expect(await none.run(LISTED)).toMatchObject({ outcome: "merged" });
    expect(none.creatorReads()).toBe(0);
    const broken = await posted(AGENT);
    await expect(broken.run({ ...LISTED, ourLogin: async () => Promise.reject(new Error("no installation")) })).rejects.toThrow();
    expect(broken.w.pub.merges).toEqual([]);
  });
});
