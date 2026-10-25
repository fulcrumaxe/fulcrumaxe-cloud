import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { listDriverEvents } from "@fx/core/src/work-items/driverEvents.js";
import { LocalOnlyGithubError } from "@fx/runner-cloud";
import type { GitHubHttp, LocalGitHubHttp } from "../../src/build/githubMergePort.js";
import { LOCAL_REVIEW_DESCRIPTION, REVIEW_STATUS_CONTEXT } from "../../src/review/githubReads.js";
import { runMergeGateForItem, type LocalReviewOptInPort } from "../../src/review/mergeGateRun.js";
import { readPublicPullRequest } from "../../src/review/publicPullRequest.js";
import { discussingItem } from "../plan/helpers/panelFixtures.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { fakeGitHubLocal } from "./helpers/fakeGitHubLocal.js";
import { fakeGitHubRest, freshRepo, type FakeRepoState } from "./helpers/fakeGitHubRest.js";

/**
 * Two planes, `runner_local` [pg]: the merge gate of a paired item whose repository runs on the customer's machine judges the PUBLIC pull request (its
 * draft state, CI, protection, stamps, locks), never the private draft copy, and the cloud never merges it.
 *
 * Both repositories are the strict local-only fake (helpers/fakeGitHubLocal.ts) behind the real `localOnlyGithub` fence, over real Postgres (work item,
 * runner reviews, pairing, the platform's push record). The code repository's fence is built the way production builds it, without A10. Every "no merge"
 * is read from the fakes' merge logs and from the calls that reached them, not from the gate's own answer.
 *
 * Not faked faithfully (said in the PR): that GitHub's schema accepts the CommitChecks document, rate limits, whether the App's installation covers the
 * code repository, and the content check of the public head (the cloud cannot make it behind the fence; the runner will, in a later change).
 */
const h = pgHarness();
const HEAD = "a".repeat(40);
const PUB_HEAD = "c".repeat(40);
const OTHER = "d".repeat(40);
const PUB_PR = 12;
const BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
const green = { name: "build", status: "completed", conclusion: "success" };
const file = (filename: string) => ({ filename, status: "modified", sha: "f".repeat(40), changes: 1 });
/** A sandbox repo's file list carries patches (the security trigger can read them); a runner_local one never does. */
const patched = (filename: string) => ({ ...file(filename), patch: "@@ -1 +1 @@\n+x" });
const ENV = "FX_HUMAN_MERGE_ONLY_REPO_IDS";
const saved = process.env[ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

interface Opts {
  autoMerge?: boolean;
  stamp?: string | null;
  source?: string | null;
  managed?: boolean;
  /** The push record's state; "pr_merged" / "pr_closed" mean the public pull request is no longer open. */
  state?: string;
  /** No pull request number recorded at all (nothing opened yet). */
  noPr?: boolean;
  pairing?: boolean;
  executionMode?: string;
  pub?: Partial<FakeRepoState>;
  priv?: Partial<FakeRepoState>;
}

async function world(o: Opts = {}) {
  const accountId = randomUUID();
  const repoId = randomUUID();
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  const local = (o.executionMode ?? "runner_local") === "runner_local";
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = $2, settings = $3::jsonb WHERE id = $1", [repoId, o.executionMode ?? "runner_local", JSON.stringify({ autoMerge: o.autoMerge ?? true })]);
  const ghRepoId = Number((await h.admin.query("SELECT gh_repo_id FROM repos WHERE id = $1", [repoId])).rows[0].gh_repo_id);
  const { workItemId } = await discussingItem(h.runWriterPool, accountId, { title: "Add a footer", body: "Show the year in the footer.", category: "feature", repoId });
  await h.admin.query("UPDATE work_items SET gh_number = 7, repo_id = $2, stage = 'pr_opened', provenance = 'internal' WHERE id = $1", [workItemId, repoId]);
  const body = "1. The footer shows the year.";
  await h.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
  const admin = randomUUID();
  await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [admin, `${admin}@fixture.test`]);
  await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')", [accountId, admin]);
  const runnerId = randomUUID();
  const k = randomUUID().replace(/-/g, "").padEnd(43, "k");
  await h.admin.query("INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription')", [runnerId, accountId, admin, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: k }), k]);
  const priv = freshRepo({ headSha: HEAD, draft: true, checks: { [HEAD]: [green] }, protectedWithoutChecks: true, runBranch: BRANCH, files: [(local ? file : patched)("src/ui/button.tsx")], ...o.priv });
  if (local) {
    // What the runner's `done` recorded: the private pull request and the run branch it came from.
    const executor = randomUUID();
    await h.admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, runner_id) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded', 'runner_local', $4)", [executor, accountId, workItemId, runnerId]);
    await h.admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)", [accountId, executor, JSON.stringify({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: priv.prNumber, branch: BRANCH })]);
    for (const role of ["code-reviewer", "acceptance-tester", "security-reviewer"]) {
      await h.admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode, runner_id) VALUES ($1, $2, $3, 'runner', 'succeeded', '{\"verdict\":\"pass\"}'::jsonb, $4, 'runner_local', $5)", [accountId, workItemId, role, HEAD, runnerId]);
    }
  } else {
    for (const role of ["code-reviewer", "acceptance-tester"]) {
      await h.admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode) VALUES ($1, $2, $3, 'production', 'succeeded', '{\"verdict\":\"pass\"}'::jsonb, $4, 'sandbox')", [accountId, workItemId, role, HEAD]);
    }
  }
  if (o.pairing !== false) {
    await h.admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['.autonomous-team/**'])", [repoId, accountId]);
    const stamp = o.stamp === undefined ? PUB_HEAD : o.stamp;
    if (o.noPr) {
      await h.admin.query("INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state) VALUES ($1, $2, $3, 'acme/widgets-public', $4, 'building')", [accountId, workItemId, repoId, "a".repeat(64)]);
    } else {
      await h.admin.query(
        `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state, head_sha, tip_sha, pr_number, pr_url, source_head${o.managed ? ", managed_by_person_at" : ""})
         VALUES ($1, $2, $3, 'acme/widgets-public', $4, $5, $6, $6, $7, 'https://github.com/acme/widgets-public/pull/12', $8${o.managed ? ", now()" : ""})`,
        [accountId, workItemId, repoId, "a".repeat(64), o.state ?? (stamp === null ? "updating" : "pr_opened"), stamp, PUB_PR, o.source === undefined ? HEAD : o.source],
      );
    }
  }
  const pubBranch = o.pairing === false ? "fx/none" : String((await h.admin.query("SELECT branch FROM plane_pushes WHERE work_item_id = $1", [workItemId])).rows[0].branch);
  const pubHead = o.pub?.headSha ?? PUB_HEAD;
  const pub = freshRepo({ owner: "acme", name: "widgets-public", prNumber: PUB_PR, headSha: pubHead, checks: { [pubHead]: [green] }, protectedWithoutChecks: true, runBranch: pubBranch, files: [(local ? file : patched)("src/ui/button.tsx")], ghId: 8123456, ...o.pub });
  return { accountId, workItemId, repoId, ghRepoId, priv, pub, pubBranch, local, privLocal: fakeGitHubLocal(priv), pubLocal: fakeGitHubLocal(pub, { exclude: ["A10"] }) };
}
type World = Awaited<ReturnType<typeof world>>;

const on: LocalReviewOptInPort = { enabled: async () => true };
const off: LocalReviewOptInPort = { enabled: async () => false };
const gate = (w: World, o: { optIn?: LocalReviewOptInPort; pubHttp?: GitHubHttp; privHttp?: GitHubHttp; seen?: { opened: Array<{ owner: string; name: string; executionMode: string }> } } = {}) =>
  runMergeGateForItem(
    {
      pool: h.runWriterPool,
      http: o.privHttp ?? (w.local ? w.privLocal.http : fakeGitHubRest(w.priv)),
      localReviewOptIn: o.optIn ?? on,
      publicPlane: {
        open: async (c) => {
          expect(`${c.owner}/${c.name}`).toBe("acme/widgets-public");
          expect(c.repoId).toBe(w.repoId);
          o.seen?.opened.push({ owner: c.owner, name: c.name, executionMode: c.executionMode });
          return o.pubHttp ?? (w.local ? w.pubLocal.http : fakeGitHubRest(w.pub));
        },
        read: readPublicPullRequest(h.runWriterPool),
      },
    },
    { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.priv.prNumber },
  );
const reasons = (out: Awaited<ReturnType<typeof gate>>) => (out.outcome === "ready_human_merges" ? out.reasons : []);
const events = (w: World) => withTenant(h.runWriterPool, w.accountId, (c) => listDriverEvents(c, w.workItemId));
/** Nothing in either repository was merged, and no call to a merge endpoint reached either fake. */
function expectNoMergeAnywhere(w: World) {
  expect(w.pub.merges).toEqual([]);
  expect(w.priv.merges).toEqual([]);
  expect([...w.pubLocal.calls, ...w.privLocal.calls].filter((c) => c.label === "A10")).toEqual([]);
}

describe("a paired runner_local item: the gate judges the public pull request", () => {
  it("every condition met on the public pull request: a human merge for the one reason the cloud does not merge, and the private draft copy is not read for its draft state", async () => {
    const w = await world();
    expect(w.priv.draft).toBe(true);
    const seen = { opened: [] as Array<{ owner: string; name: string; executionMode: string }> };
    const out = await gate(w, { seen });
    expect(out).toMatchObject({ outcome: "ready_human_merges", headSha: PUB_HEAD, reasons: ["runner_merge_unavailable"], status: "posted" });
    expect(reasons(out)).not.toContain("pr_draft");
    expectNoMergeAnywhere(w);
    // The local-only status goes on the PUBLIC head with the local-review wording; the private copy gets nothing.
    expect(w.pub.posts).toHaveLength(1);
    expect(w.pub.posts[0]).toMatchObject({ sha: PUB_HEAD, body: { state: "success", context: REVIEW_STATUS_CONTEXT, description: LOCAL_REVIEW_DESCRIPTION } });
    expect(w.priv.posts).toEqual([]);
    expect(seen.opened).toEqual([{ owner: "acme", name: "widgets-public", executionMode: "runner_local" }]);
    // Every call that reached either repository is on the allowlist, and the public pull request was found by the branch our own push record names.
    expect(w.pubLocal.denied).toEqual([]);
    expect(w.pubLocal.refused).toEqual([]);
    expect(w.pubLocal.calls.map((c) => c.label).sort()).toEqual(expect.arrayContaining(["A2", "A3", "A7", "A8", "A9 CommitChecks"]));
    expect(w.pubLocal.calls.some((c) => c.path.endsWith(`/pulls`) && c.label === "A3")).toBe(true);
    // The gate's driver event speaks of the reviewed head and the item's own pull request, as for a sandbox pair.
    const ev = (await events(w)).find((e) => e.kind === "merge_gate");
    expect(ev).toMatchObject({ code: "ready_human_merges", head_sha: HEAD, pr_number: w.priv.prNumber, reasons: ["runner_merge_unavailable"] });
  });

  it("a draft PUBLIC pull request is pr_draft, and the card says so rather than the merge reason", async () => {
    const w = await world({ pub: { draft: true } });
    const out = await gate(w);
    expect(reasons(out)).toEqual(["pr_draft"]);
    expectNoMergeAnywhere(w);
  });

  it("a ready private copy does not stand in for a draft public one (and the reverse is the default above)", async () => {
    const w = await world({ priv: { draft: false }, pub: { draft: true } });
    expect(reasons(await gate(w))).toContain("pr_draft");
    expectNoMergeAnywhere(w);
  });

  it("the public CI red or still running: ci_not_green, even though the private copy is green", async () => {
    const red = await world({ pub: { checks: { [PUB_HEAD]: [{ name: "build", status: "completed", conclusion: "failure" }] } } });
    expect(reasons(await gate(red))).toContain("ci_not_green");
    const running = await world({ pub: { checks: { [PUB_HEAD]: [{ name: "build", status: "in_progress", conclusion: null }] } } });
    expect(reasons(await gate(running))).toContain("ci_not_green");
    expectNoMergeAnywhere(red);
    expectNoMergeAnywhere(running);
  });

  it("the public repository has no CI of its own, or no protection on its default branch: the stops the opt-in requires", async () => {
    const noCi = await world({ pub: { checks: { [PUB_HEAD]: [] } } });
    expect(reasons(await gate(noCi))).toContain("repo_ci_missing");
    const open = await world({ pub: { protectedWithoutChecks: false } });
    expect(reasons(await gate(open))).toEqual(["no_branch_protection"]);
    // A private copy that has all of it does not change that.
    expect(open.priv.protectedWithoutChecks).toBe(true);
    expectNoMergeAnywhere(noCi);
    expectNoMergeAnywhere(open);
  });

  it("the opt-in off: local_review_not_enabled, no status, and the merge reason does not hide it", async () => {
    const w = await world();
    const out = await gate(w, { optIn: off });
    expect(reasons(out)).toContain("local_review_not_enabled");
    expect(reasons(out)).not.toContain("runner_merge_unavailable");
    expect(out).toMatchObject({ status: "skipped" });
    expect(w.pub.posts).toEqual([]);
    expectNoMergeAnywhere(w);
  });

  it("auto-merge off for the repository: auto_merge_not_allowed", async () => {
    const w = await world({ autoMerge: false });
    expect(reasons(await gate(w))).toEqual(["auto_merge_not_allowed"]);
    expectNoMergeAnywhere(w);
  });

  it("a reviewer needs-fix on the reviewed head blocks, as on any plane", async () => {
    const w = await world();
    await h.admin.query("UPDATE agent_runs SET envelope = '{\"verdict\":\"needs-fix\"}'::jsonb WHERE work_item_id = $1 AND role = 'code-reviewer'", [w.workItemId]);
    const out = await gate(w);
    expect(reasons(out)).toContain("verdict_not_pass_code_reviewer");
    expect(w.pub.posts).toEqual([]);
    expectNoMergeAnywhere(w);
  });

  it("a base that is not the default branch: stacked_on_open_pr", async () => {
    const w = await world({ pub: { baseRef: "feature", defaultBranch: "main", protectedWithoutChecks: true } });
    // The protection read is of the base branch named by the pull request; the fake answers it, so only the stack stop is under test here.
    expect(reasons(await gate(w))).toContain("stacked_on_open_pr");
    expectNoMergeAnywhere(w);
  });
});

describe("a paired runner_local item: each stop the platform's own record adds", () => {
  it("a branch a person took over: public_branch_person_managed, no status", async () => {
    const w = await world({ managed: true });
    const out = await gate(w);
    expect(reasons(out)).toEqual(["public_branch_person_managed"]);
    expect(out).toMatchObject({ status: "skipped" });
    expect(w.pub.posts).toEqual([]);
    expectNoMergeAnywhere(w);
  });

  it("a public head the platform did not push, or no stamp at all, or no recorded source head: public_head_unrecorded", async () => {
    const moved = await world({ stamp: OTHER });
    expect(reasons(await gate(moved))).toEqual(["public_head_unrecorded"]);
    const none = await world({ stamp: null });
    expect(reasons(await gate(none))).toEqual(["public_head_unrecorded"]);
    const noSource = await world({ source: null });
    expect(reasons(await gate(noSource))).toEqual(["public_head_unrecorded"]);
    for (const w of [moved, none, noSource]) {
      expect(w.pub.posts).toEqual([]);
      expectNoMergeAnywhere(w);
    }
  });

  it("the public head was built from a private head other than the one the reviewers cleared: public_head_not_reviewed", async () => {
    const w = await world({ source: OTHER });
    const out = await gate(w);
    expect(reasons(out)).toEqual(["public_head_not_reviewed"]);
    expect(out).toMatchObject({ status: "skipped" });
    expectNoMergeAnywhere(w);
  });

  it("a malformed public head: head_sha_malformed", async () => {
    const w = await world({ pub: { headSha: "not-a-sha", checks: {} } });
    expect(reasons(await gate(w))).toContain("head_sha_malformed");
    expectNoMergeAnywhere(w);
  });

  it("the public head moves after the first read (before the status): head_moved, no status", async () => {
    const w = await world();
    w.pub.checks[OTHER] = [green];
    let lists = 0;
    const real = w.pubLocal.http;
    const moving: LocalGitHubHttp = {
      request: async (req) => {
        if (req.method === "GET" && req.path === "/repos/acme/widgets-public/pulls" && ++lists === 2) w.pub.headSha = OTHER;
        return real.request(req);
      },
      graphql: (op, v) => real.graphql(op, v),
    };
    const out = await gate(w, { pubHttp: moving });
    expect(out.outcome).toBe("head_moved");
    expect(w.pub.posts).toEqual([]);
    expectNoMergeAnywhere(w);
  });

  it("the public head moves between the status and the gate's own read: head_moved", async () => {
    const w = await world();
    w.pub.checks[OTHER] = [green];
    let lists = 0;
    const real = w.pubLocal.http;
    const moving: LocalGitHubHttp = {
      request: async (req) => {
        if (req.method === "GET" && req.path === "/repos/acme/widgets-public/pulls" && ++lists === 3) w.pub.headSha = OTHER;
        return real.request(req);
      },
      graphql: (op, v) => real.graphql(op, v),
    };
    expect((await gate(w, { pubHttp: moving })).outcome).toBe("head_moved");
    expectNoMergeAnywhere(w);
  });

  it("the changed paths of either pull request decide the security reviewer: a sensitive path only on the public side needs one, and none is recorded", async () => {
    const w = await world({ pub: { files: [file("src/ui/button.tsx"), file("packages/auth/session.ts")] } });
    await h.admin.query("DELETE FROM agent_runs WHERE work_item_id = $1 AND role = 'security-reviewer'", [w.workItemId]);
    const out = await gate(w);
    expect(reasons(out).some((r) => r.includes("security"))).toBe(true);
    expectNoMergeAnywhere(w);
  });
});

describe("the operator's human-merge lock names either repository", () => {
  it("the private repository listed: human_merge_only", async () => {
    const w = await world();
    process.env[ENV] = String(w.ghRepoId);
    expect(reasons(await gate(w))).toEqual(["human_merge_only"]);
    expectNoMergeAnywhere(w);
  });

  it("only the CODE repository listed: human_merge_only too", async () => {
    const w = await world();
    process.env[ENV] = String(w.pub.ghId);
    expect(w.pub.ghId).not.toBe(w.ghRepoId);
    expect(reasons(await gate(w))).toEqual(["human_merge_only"]);
    expectNoMergeAnywhere(w);
  });

  it("another repository listed (control): the lock does not fire, and the merge reason is the only stop", async () => {
    const w = await world();
    process.env[ENV] = "999";
    expect(reasons(await gate(w))).toEqual(["runner_merge_unavailable"]);
  });

  it("a sandbox pair: only the CODE repository listed locks it too (the same rule in both runtimes), and the sandbox control merges", async () => {
    const locked = await world({ executionMode: "sandbox" });
    process.env[ENV] = String(locked.pub.ghId);
    expect(reasons(await gate(locked))).toEqual(["human_merge_only"]);
    expect(locked.pub.merges).toEqual([]);
    process.env[ENV] = "999";
    const control = await world({ executionMode: "sandbox" });
    expect((await gate(control)).outcome).toBe("merged");
    expect(control.pub.merges).toEqual([{ sha: PUB_HEAD, method: "squash" }]);
  });

  it("a malformed list locks everything", async () => {
    const w = await world();
    process.env[ENV] = "12, 13";
    expect(reasons(await gate(w))).toEqual(["human_merge_only"]);
  });

  it("a code repository answer without a usable id counts as listed while any id is configured", async () => {
    const w = await world();
    process.env[ENV] = "999";
    const real = w.pubLocal.http;
    const noId: LocalGitHubHttp = { request: async (req) => (req.method === "GET" && req.path === "/repos/acme/widgets-public" ? { status: 200, body: { full_name: "acme/widgets-public" } } : real.request(req)), graphql: (op, v) => real.graphql(op, v) };
    expect(reasons(await gate(w, { pubHttp: noId }))).toEqual(["human_merge_only"]);
  });
});

describe("a paired item whose public pull request is not open: public_pr_not_open, never a fall-through to the private copy", () => {
  it.each([
    ["merged", { state: "pr_merged" }],
    ["closed", { state: "pr_closed" }],
    ["not opened yet", { noPr: true }],
  ])("runner_local, public pull request %s", async (_name, over) => {
    const w = await world(over);
    // The private copy is ready, green and approved: it still does not merge.
    w.priv.draft = false;
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "ready_human_merges", reasons: expect.arrayContaining(["public_pr_not_open"]) });
    expect(reasons(out)).not.toContain("runner_merge_unavailable");
    expect(w.pub.requests).toEqual([]);
    expect(w.pubLocal.calls).toEqual([]);
    expect(out).toMatchObject({ status: "skipped" });
    expectNoMergeAnywhere(w);
  });

  it("a sandbox pair, public pull request merged: the private copy does not merge in its place", async () => {
    const w = await world({ executionMode: "sandbox", state: "pr_merged" });
    w.priv.draft = false;
    const out = await gate(w);
    expect(reasons(out)).toEqual(["public_pr_not_open"]);
    expect(w.priv.merges).toEqual([]);
    expect(w.pub.requests).toEqual([]);
  });

  it("a sandbox pair, nothing opened yet: public_pr_not_open", async () => {
    const w = await world({ executionMode: "sandbox", noPr: true });
    w.priv.draft = false;
    expect(reasons(await gate(w))).toEqual(["public_pr_not_open"]);
    expect(w.priv.merges).toEqual([]);
  });

  it("a pairing that now names another code repository counts as no open public pull request", async () => {
    const w = await world();
    await h.admin.query("UPDATE repo_pairing SET code_repo = 'other-co/elsewhere' WHERE repo_id = $1", [w.repoId]);
    w.priv.draft = false;
    expect(reasons(await gate(w))).toEqual(expect.arrayContaining(["public_pr_not_open"]));
    expectNoMergeAnywhere(w);
  });

  it("an item with no pairing is a single-plane item: the public plane is never opened, and a runner_local merge stays the private client's own", async () => {
    const w = await world({ pairing: false });
    w.priv.draft = false;
    const out = await runMergeGateForItem(
      {
        pool: h.runWriterPool,
        http: w.privLocal.http,
        localReviewOptIn: on,
        publicPlane: {
          open: async () => {
            throw new Error("the public plane must not be opened");
          },
          read: readPublicPullRequest(h.runWriterPool),
        },
      },
      { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.priv.prNumber },
    );
    expect(out).toMatchObject({ outcome: "merged", headSha: HEAD });
    expect(w.priv.merges).toEqual([{ sha: HEAD, method: "squash" }]);
  });
});

describe("the public pull request lookup tells 'paired, nothing open' from 'not paired'", () => {
  const read = (w: World) => readPublicPullRequest(h.runWriterPool)(w.accountId, w.workItemId);

  it("an open public pull request carries the branch of our own push record", async () => {
    const w = await world();
    const got = await read(w);
    expect(got).toMatchObject({ paired: true, pr: { owner: "acme", name: "widgets-public", number: PUB_PR, branch: w.pubBranch, stampedHead: PUB_HEAD, sourceHead: HEAD } });
    expect(w.pubBranch).toMatch(/^fx\/p-[0-9a-f-]{36}$/);
  });

  it("closed, merged, never opened and a re-pointed pairing are paired with no pull request; no pairing is null", async () => {
    expect(await read(await world({ state: "pr_closed" }))).toEqual({ paired: true, pr: null });
    expect(await read(await world({ state: "pr_merged" }))).toEqual({ paired: true, pr: null });
    expect(await read(await world({ noPr: true }))).toEqual({ paired: true, pr: null });
    const moved = await world();
    await h.admin.query("UPDATE repo_pairing SET code_repo = 'other-co/elsewhere' WHERE repo_id = $1", [moved.repoId]);
    expect(await read(moved)).toEqual({ paired: true, pr: null });
    expect(await read(await world({ pairing: false }))).toBeNull();
  });

  it("another account's item is never read", async () => {
    const a = await world();
    const b = await world();
    expect(await readPublicPullRequest(h.runWriterPool)(b.accountId, a.workItemId)).toBeNull();
  });
});

describe("the cloud cannot call merge on a runner_local pair's code repository", () => {
  it("the code repository's fence refuses the merge call before any request, whatever the body", async () => {
    const w = await world();
    for (const body of [{ sha: PUB_HEAD, merge_method: "squash" }, { sha: PUB_HEAD, merge_method: "merge" }, undefined]) {
      await expect(w.pubLocal.http.request({ method: "PUT", path: `/repos/acme/widgets-public/pulls/${PUB_PR}/merge`, body })).rejects.toBeInstanceOf(LocalOnlyGithubError);
    }
    expect(w.pubLocal.refused).toEqual(["not_allowlisted", "not_allowlisted", "not_allowlisted"]);
    expect(w.pubLocal.calls).toEqual([]);
    expect(w.pub.merges).toEqual([]);
  });

  it("the private repository's fence is unchanged (a single-plane runner_local merge still goes through A10 there)", async () => {
    const w = await world();
    const res = await w.privLocal.http.request({ method: "PUT", path: `/repos/acme/widgets/pulls/${w.priv.prNumber}/merge`, body: { sha: HEAD, merge_method: "squash" } });
    expect(res.status).toBe(200);
  });

  it("even a code-repository client that DID allow merge is never asked to: the gate stops before the one merge call, and the port it merges through refuses", async () => {
    const w = await world();
    const unfenced = fakeGitHubLocal(w.pub);
    const out = await gate(w, { pubHttp: unfenced.http });
    expect(out).toMatchObject({ outcome: "ready_human_merges", reasons: ["runner_merge_unavailable"] });
    expect(unfenced.calls.filter((c) => c.label === "A10")).toEqual([]);
    expect(w.pub.merges).toEqual([]);
    expect(w.priv.merges).toEqual([]);
  });

  it("all of it while every condition is met and the run's reviews are in: the item always ends as a human merge", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) await gate(w);
    expectNoMergeAnywhere(w);
    expect(w.pub.state).toBe("open");
  });
});

describe("failure paths: a read that fails is a throw (the step's retry), never a merge or a green answer", () => {
  it("a code-repository client that is not the local-only one is refused before a call", async () => {
    const w = await world();
    const plain = fakeGitHubRest(w.pub);
    await expect(gate(w, { pubHttp: plain })).rejects.toThrow(/local-only GitHub client/);
    expect(w.pub.requests).toEqual([]);
    expectNoMergeAnywhere(w);
  });

  it("the public pull request is not listed under the branch our record names: the read throws", async () => {
    const w = await world({ pub: { runBranch: "fx/p-someone-elses-branch" } });
    await expect(gate(w)).rejects.toThrow(/not listed/);
    expectNoMergeAnywhere(w);
  });

  it("the repository read fails: the gate throws and nothing is posted or merged", async () => {
    const w = await world();
    const real = w.pubLocal.http;
    const failing: LocalGitHubHttp = { request: async (req) => (req.method === "GET" && req.path === "/repos/acme/widgets-public" ? { status: 500, body: { message: "Server Error" } } : real.request(req)), graphql: (op, v) => real.graphql(op, v) };
    await expect(gate(w, { pubHttp: failing })).rejects.toThrow(/repository read answered 500/);
    expect(w.pub.posts).toEqual([]);
    expectNoMergeAnywhere(w);
  });

  it("the public changed-path read fails: the gate throws, no status", async () => {
    const w = await world({ pub: { filesFail: 502 } });
    await expect(gate(w)).rejects.toThrow(/files/);
    expect(w.pub.posts).toEqual([]);
    expectNoMergeAnywhere(w);
  });

  it("the status post fails: it is recorded as failed and the item is still a human merge, never a merge", async () => {
    const w = await world({ pub: { statusPostFails: 500 } });
    const out = await gate(w);
    expect(out).toMatchObject({ outcome: "ready_human_merges", status: "failed" });
    expectNoMergeAnywhere(w);
  });

  it("the public pull request is closed on GitHub while the record still says open: pr_not_open, nothing marked or merged", async () => {
    const w = await world({ pub: { state: "closed" } });
    expect((await gate(w)).outcome).toBe("pr_not_open");
    expectNoMergeAnywhere(w);
  });

  it("every allowlisted call the fakes saw is a paths-and-states read: no answer carries a patch or a body", async () => {
    const w = await world();
    await gate(w);
    for (const answer of [...w.pubLocal.answers, ...w.privLocal.answers]) expect(JSON.stringify(answer)).not.toMatch(/"patch"/);
  });
});
