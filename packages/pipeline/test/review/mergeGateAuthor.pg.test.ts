import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { TRANSIENT_GATE_REASONS } from "@fx/core/src/work-items/stalled.js";
import { DEQUEUE_PULL_REQUEST_DOCUMENT, ENABLE_AUTO_MERGE_DOCUMENT, ENQUEUE_PULL_REQUEST_DOCUMENT, MERGE_QUEUE_ENTRY_DOCUMENT, MERGE_QUEUE_READ_DOCUMENT } from "../../../github/src/mergeGateGraphql.js";
import { clearMergeQueueModeCache, type GitHubHttp } from "../../src/build/githubMergePort.js";
import { runMergeGateForItem } from "../../src/review/mergeGateRun.js";
import { discussingItem } from "../plan/helpers/panelFixtures.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { fakeGitHubRest, freshRepo, type FakeRepoState } from "./helpers/fakeGitHubRest.js";

/**
 * D#598 P1d-1 [pg]: the merge gate refuses a pull request that someone outside the repository's admins and maintainers opened, in a public repository, whatever the
 * labels, the auto-merge setting or `blockExternalAutoMerge` say. The fake answers the permission read the way GitHub does (200 with `permission` and `role_name`;
 * 404 for a login with no access) and records every login asked. Not faked faithfully (said in the PR): GitHub's rate limits.
 */
const h = pgHarness();
const HEAD = "a".repeat(40);
const BOT = "fulcrumaxe-app[bot]";
const trust = { botLogins: async () => [BOT], allowlist: () => null };
const queueDocuments = { read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT, dequeue: DEQUEUE_PULL_REQUEST_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT };

async function world(repo: Partial<FakeRepoState> = {}) {
  const accountId = randomUUID();
  const repoId = randomUUID();
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  // Every switch that could let an outside author through is on: auto-merge is allowed and the external-provenance guard is off.
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', settings = $2::jsonb WHERE id = $1", [repoId, JSON.stringify({ autoMerge: true, blockExternalAutoMerge: false })]);
  const { workItemId } = await discussingItem(h.runWriterPool, accountId, { title: "Add a footer", body: "Show the year in the footer.", category: "feature", repoId });
  await h.admin.query("UPDATE work_items SET gh_number = 7, repo_id = $2, stage = 'pr_opened', provenance = 'internal' WHERE id = $1", [workItemId, repoId]);
  const body = "1. The footer shows the year.";
  await h.admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
  for (const role of ["code-reviewer", "acceptance-tester"]) {
    await h.admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, 'production', 'succeeded', '{\"verdict\":\"pass\"}'::jsonb, $4)", [accountId, workItemId, role, HEAD]);
  }
  const gh = freshRepo({ headSha: HEAD, checks: { [HEAD]: [{ name: "ci", status: "completed", conclusion: "success" }] }, isPublic: true, ...repo });
  return { accountId, workItemId, gh };
}
type World = Awaited<ReturnType<typeof world>>;
const gate = (w: World, http: GitHubHttp = fakeGitHubRest(w.gh), extra: { queue?: boolean } = {}) =>
  runMergeGateForItem({ pool: h.runWriterPool, http, authorTrust: trust, ...(extra.queue ? { queueDocuments } : {}) }, { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.gh.prNumber });
const queueRepo = (): Partial<FakeRepoState> => ({ mergeQueue: { exists: true, mutations: [] }, rulesetRules: [{ type: "merge_queue", enforcement: "active" }] });
/** The fake with the permission read answered by `reply` (a status and body, or a throw for a transport failure). */
const permissionAnswers = (w: World, reply: () => { status: number; body: unknown }): GitHubHttp => {
  const real = fakeGitHubRest(w.gh);
  return {
    request: async (req) => {
      if (!/\/collaborators\/[^/]+\/permission$/.test(req.path)) return real.request(req);
      (w.gh.permissionReads ??= []).push("x");
      return reply();
    },
  };
};
const noMergeCall = (w: World) => {
  expect(w.gh.merges).toEqual([]);
  expect(w.gh.mergeQueue?.mutations ?? []).toEqual([]);
  expect(w.gh.requests.some((r) => r.method === "PUT" || r.path === "/graphql" && r.method === "POST")).toBe(false);
};

describe("a public repository: the author of the pull request decides", () => {
  beforeEach(() => clearMergeQueueModeCache());

  it.each(["write", "triage", "read"])("an author with %s permission is refused: ready_human_merges with pr_author_untrusted, and no merge, enqueue or auto-merge call", async (role) => {
    const w = await world({ authorLogin: "Outsider", collaborators: { outsider: role }, ...queueRepo() });
    for (const queue of [false, true]) expect(await gate(w, undefined, { queue })).toMatchObject({ outcome: "ready_human_merges", reasons: ["pr_author_untrusted"] });
    noMergeCall(w);
    expect(w.gh.permissionReads).toEqual(["Outsider", "Outsider"]);
  });

  it("an author GitHub does not list at all (404 means none) is refused the same way", async () => {
    const w = await world({ authorLogin: "stranger" });
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["pr_author_untrusted"] });
    noMergeCall(w);
  });

  it("the platform's own bot merges in any letter case with zero permission reads", async () => {
    const w = await world({ authorLogin: "FulcrumAXE-App[BOT]" });
    expect(await gate(w)).toMatchObject({ outcome: "merged", reasons: [] });
    expect(w.gh.permissionReads ?? []).toEqual([]);
  });

  it.each(["admin", "maintain"])("%s merges after exactly one permission read (role_name is read, not the legacy folded word)", async (role) => {
    const w = await world({ authorLogin: "carol", collaborators: { Carol: role } });
    expect(await gate(w)).toMatchObject({ outcome: "merged", reasons: [] });
    expect(w.gh.permissionReads).toEqual(["carol"]);
    expect(w.gh.merges).toEqual([{ sha: HEAD, method: "squash" }]);
  });

  it("an allowlisted login merges with no read, and so does the queue path for a trusted author", async () => {
    const w = await world({ authorLogin: "Dependabot", ...queueRepo() });
    const out = await runMergeGateForItem({ pool: h.runWriterPool, http: fakeGitHubRest(w.gh), authorTrust: { botLogins: async () => [], allowlist: () => ["dependabot"] }, queueDocuments }, { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.gh.prNumber });
    expect(out).toMatchObject({ outcome: "merge_enqueued" });
    expect(w.gh.permissionReads ?? []).toEqual([]);
  });

  it.each([
    ["a 500", () => ({ status: 500, body: { message: "Server Error" } })],
    ["a 429", () => ({ status: 429, body: { message: "rate limited" } })],
    ["a 403", () => ({ status: 403, body: { message: "Resource not accessible by integration" } })],
    ["a body that is not JSON", () => ({ status: 200, body: "<html>" })],
    ["a body that names no permission", () => ({ status: 200, body: { user: { login: "carol" } } })],
    ["a transport failure or timeout", () => { throw new Error("socket hang up carol"); }],
  ])("%s on the permission read: pr_author_unverified, no merge call, and a later definite maintain answer merges", async (_name, reply) => {
    const w = await world({ authorLogin: "carol", collaborators: { carol: "maintain" } });
    const first = await gate(w, permissionAnswers(w, reply));
    expect(first).toMatchObject({ outcome: "ready_human_merges", reasons: ["pr_author_unverified"] });
    noMergeCall(w);
    expect(TRANSIENT_GATE_REASONS).toContain("pr_author_unverified");
    expect(await gate(w)).toMatchObject({ outcome: "merged" });
  });

  it("an app login that cannot be read does not widen trust: a human admin still merges; anyone else is unverified", async () => {
    const w = await world({ authorLogin: "carol", collaborators: { carol: "admin" } });
    const broken = { botLogins: async (): Promise<string[]> => { throw new Error("app read failed"); }, allowlist: () => null };
    const run = (x: World) => runMergeGateForItem({ pool: h.runWriterPool, http: fakeGitHubRest(x.gh), authorTrust: broken }, { accountId: x.accountId, workItemId: x.workItemId, prNumber: x.gh.prNumber });
    expect(await run(w)).toMatchObject({ outcome: "merged" });
    const other = await world({ authorLogin: "dave", collaborators: { dave: "write" } });
    expect(await run(other)).toMatchObject({ outcome: "ready_human_merges", reasons: ["pr_author_unverified"] });
  });

  it.each([null, "   ", "a/b", "../x", "evil login", "x".repeat(40)])("a missing or malformed author (%j) is untrusted and the permission read is never made", async (login) => {
    const w = await world({ authorLogin: login, collaborators: { "a/b": "admin" } });
    expect(await gate(w)).toMatchObject({ outcome: "ready_human_merges", reasons: ["pr_author_untrusted"] });
    noMergeCall(w);
    expect(w.gh.permissionReads ?? []).toEqual([]);
  });
});

describe("a private repository that is not paired keeps today's rules", () => {
  it("a non-bot author merges exactly as before, with no permission read and the same merge call", async () => {
    const w = await world({ isPublic: false, authorLogin: "someone" });
    expect(await gate(w)).toMatchObject({ outcome: "merged", reasons: [] });
    expect(w.gh.merges).toEqual([{ sha: HEAD, method: "squash" }]);
    expect(w.gh.permissionReads ?? []).toEqual([]);
  });
});
