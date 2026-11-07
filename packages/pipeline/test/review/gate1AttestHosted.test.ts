import { describe, expect, it } from "vitest";
import { ACTIONS_APP_ID, GATE1_DESCRIPTIONS, GATE1_WORKFLOW_CONTEXTS, attestGate1Head, gate1ReadsFor, hostedGate1Reads, parseGate1AttestRepos } from "../../src/review/gate1Attest.js";
import type { GitHubHttp } from "../../src/build/githubMergePort.js";
import { fakeGitHubRest, freshRepo, type FakeCheckRun, type FakeRepoState } from "./helpers/fakeGitHubRest.js";
import { fakeGitHubLocal, gate1World, type Gate1World } from "./helpers/fakeGitHubLocal.js";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 (TL ruling 11-07 01:25, option B): the hosted adapter. The same decision as the fenced path, with the reads a hosted `merge_gate`
 * client already allows (pull request files, issue events, check runs with `filter=latest`, commit statuses) over the strict REST fake.
 */
const T = "2026-11-07T10:00:00Z";
const AFTER = "2026-11-07T10:05:00Z";
const BEFORE = "2026-11-07T09:55:00Z";
const HEAD = "c".repeat(40);
const REPOS = parseGate1AttestRepos("acme/widgets");
const actions = (startedAt: string, conclusion: string | null = "success"): FakeCheckRun[] => GATE1_WORKFLOW_CONTEXTS.map((name) => ({ name, status: "completed", conclusion, startedAt, app: { id: ACTIONS_APP_ID } }));
const LABELED = { labels: ["ci:full"], labelEvents: [{ event: "labeled" as const, label: "ci:full", createdAt: T }] };

function world(over: Partial<FakeRepoState> = {}, g: Partial<Gate1World> = {}) {
  const s = freshRepo({ headSha: HEAD, files: [{ filename: "packages/a.ts" }], checks: { [HEAD]: actions(BEFORE) }, ...over });
  const w = gate1World(g);
  const http = fakeGitHubRest(s, { gate1: w });
  const run = (repos: ReadonlySet<string> = REPOS) =>
    attestGate1Head(http, { repos, owner: s.owner, name: s.name, number: s.prNumber, sha: HEAD, ourLogin: async () => "fx-cloud-app[bot]", readHead: async () => s.headSha });
  const sent = () => s.requests.map((r) => `${r.method} ${r.path.replace(`/repos/${s.owner}/${s.name}`, "")}`);
  return { s, w, http, run, sent };
}

describe("attestGate1Head on a hosted pair, through REST reads", () => {
  it("the hosted client gets the REST adapter, the fenced client the documents", async () => {
    const head = { owner: "acme", name: "widgets", sha: HEAD, number: 41 };
    const s = freshRepo({ headSha: HEAD });
    expect(await gate1ReadsFor(fakeGitHubRest(s, { gate1: gate1World() }), head).oursSucceeded("fx-cloud-app[bot]")).toBe(false);
    expect(s.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET /repos/acme/widgets/commits/${HEAD}/statuses`]);
    const local = fakeGitHubLocal(freshRepo({ headSha: HEAD, checks: { [HEAD]: [] } }), { exclude: ["A10"], gate1: gate1World() });
    expect(await gate1ReadsFor(local.http, head).oursSucceeded("fx-cloud-app[bot]")).toBe(false);
    expect(local.calls.map((c) => c.label)).toEqual(["A17"]);
  });

  it("off for an unlisted repository: not one request", async () => {
    const t = world();
    expect(await t.run(new Set())).toEqual({ kind: "off" });
    expect(t.s.requests).toEqual([]);
  });

  it("the full path: label added; a run before the label waits; a green full run after it posts fx-gate1 once, then already", async () => {
    const t = world();
    expect(await t.run()).toEqual({ kind: "label_added" });
    expect(t.sent()).toEqual([`GET /commits/${HEAD}/statuses`, "GET /pulls/41/files", "GET /issues/41/events", `GET /commits/${HEAD}/check-runs`, "POST /issues/41/labels"]);
    expect(t.s.requests.find((r) => r.path.endsWith("/check-runs"))!.query).toMatchObject({ filter: "latest" });
    expect(await t.run()).toEqual({ kind: "wait", reason: "run_before_label" });
    t.s.checks[HEAD] = actions(AFTER);
    expect(await t.run()).toEqual({ kind: "posted", state: "success" });
    expect(t.s.posts).toEqual([{ sha: HEAD, body: { state: "success", context: "fx-gate1", description: GATE1_DESCRIPTIONS.success } }]);
    expect(await t.run()).toEqual({ kind: "already" });
    expect(t.s.posts).toHaveLength(1);
    expect(t.w.labelAdds).toBe(1);
  });

  it("a rename uses the real previous path: out of a CI path fails ci_paths with no label; a rename of an ordinary file does not", async () => {
    const out = world({ files: [{ filename: "docs/moved.yml", previous_filename: ".github/workflows/old.yml", status: "renamed" }] });
    expect(await out.run()).toEqual({ kind: "posted", state: "failure", reason: "ci_paths" });
    expect(out.w.labelAdds).toBe(0);
    expect(out.sent()).toEqual([`GET /commits/${HEAD}/statuses`, "GET /pulls/41/files", `POST /statuses/${HEAD}`]);
    const plain = world({ files: [{ filename: "docs/b.md", previous_filename: "docs/a.md", status: "renamed" }] });
    expect(await plain.run()).toEqual({ kind: "label_added" });
  });

  it.each([
    ["a user whose login is our bot's", { __typename: "User", login: "fx-cloud-app[bot]" }, "success"],
    ["a near-miss slug", { __typename: "Bot", login: "fx-cloud-app-x[bot]" }, "success"],
    ["another App's bot", { __typename: "Bot", login: "other-app[bot]" }, "success"],
    ["our bot, but a failure", { __typename: "Bot", login: "fx-cloud-app[bot]" }, "failure"],
  ])("%s is not ours: the attester decides from the runs and posts", async (_what, creator, state) => {
    const t = world({ checks: { [HEAD]: actions(AFTER) }, statuses: { [HEAD]: { "fx-gate1": state } } }, { ...LABELED, creators: { [HEAD]: creator } });
    expect(await t.run()).toEqual({ kind: "posted", state: "success" });
  });
  it("our bot's success (REST login with [bot], typed Bot): already, nothing else read", async () => {
    const t = world({ statuses: { [HEAD]: { "fx-gate1": "success" } } }, { creators: { [HEAD]: { __typename: "Bot", login: "fx-cloud-app[bot]" } } });
    expect(await t.run()).toEqual({ kind: "already" });
    expect(t.sent()).toEqual([`GET /commits/${HEAD}/statuses`]);
  });

  it("a red full run fails ci_red; a removed label waits; a moved head waits before any label or post", async () => {
    expect(await world({ checks: { [HEAD]: actions(AFTER, "cancelled") } }, LABELED).run()).toEqual({ kind: "posted", state: "failure", reason: "ci_red" });
    const off = world({ checks: { [HEAD]: actions(AFTER) } }, { labelEvents: [...LABELED.labelEvents, { event: "unlabeled", label: "ci:full", createdAt: AFTER }] });
    expect(await off.run()).toEqual({ kind: "wait", reason: "label_removed" });
    const moved = world({ checks: { [HEAD]: actions(AFTER) } }, LABELED);
    moved.s.headSha = "d".repeat(40);
    expect(await moved.run()).toEqual({ kind: "wait", reason: "head_moved" });
    expect([...off.s.posts, ...moved.s.posts]).toEqual([]);
  });

  it("an events list longer than the read cap is unknown, even with a ci:full event read: wait label_unknown, no label, no post", async () => {
    // The list runs oldest first: the events past the cap could hold an unlabel, so the ci:full event that was read proves nothing.
    const noise = Array.from({ length: 1000 }, (_, i) => ({ event: "labeled" as const, label: `n${i}`, createdAt: AFTER }));
    const t = world({ checks: { [HEAD]: actions(AFTER) } }, { labels: ["ci:full"], labelEvents: [...LABELED.labelEvents, ...noise] });
    expect(await t.run()).toEqual({ kind: "wait", reason: "label_unknown" });
    expect(t.w.labelAdds).toBe(0);
    expect(t.s.posts).toEqual([]);
  });

  // The app id is each REST run's own `app.id`, never assumed.
  it.each([
    ["another App's run (app.id 999)", { id: 999 }],
    ["a run with app null", null],
  ] as const)("%s among five green runs after the label: failure foreign_app, never a success", async (_what, app) => {
    const t = world({ checks: { [HEAD]: actions(AFTER).map((c, i) => (i === 1 ? { ...c, app } : c)) } }, LABELED);
    expect(await t.run()).toEqual({ kind: "posted", state: "failure", reason: "foreign_app" });
    expect(t.s.posts).toEqual([{ sha: HEAD, body: { state: "failure", context: "fx-gate1", description: GATE1_DESCRIPTIONS.failure.foreign_app } }]);
  });

  const filler = (n: number): FakeCheckRun[] => Array.from({ length: n }, (_, i) => ({ name: `lint-${i}`, status: "completed", conclusion: "success", startedAt: AFTER, app: { id: ACTIONS_APP_ID } }));
  it("check runs past the first page are read: a newer red run of a context on page 2 wins over its green run on page 1", async () => {
    const red: FakeCheckRun = { name: GATE1_WORKFLOW_CONTEXTS[0]!, status: "completed", conclusion: "failure", startedAt: "2026-11-07T10:20:00Z", app: { id: ACTIONS_APP_ID } };
    const t = world({ checks: { [HEAD]: [...actions(AFTER), ...filler(95), red] } }, LABELED);
    expect(await t.run()).toEqual({ kind: "posted", state: "failure", reason: "ci_red" });
    expect(t.s.requests.filter((r) => r.path.endsWith("/check-runs")).map((r) => Number(r.query?.page))).toEqual([1, 2]);
  });
  it("more check runs than the five pages read: wait checks_incomplete, no post", async () => {
    const t = world({ checks: { [HEAD]: [...actions(AFTER), ...filler(500)] } }, LABELED);
    expect(await t.run()).toEqual({ kind: "wait", reason: "checks_incomplete" });
    expect(t.s.requests.filter((r) => r.path.endsWith("/check-runs"))).toHaveLength(5);
    expect(t.s.posts).toEqual([]);
  });

  const OURS = { login: "fx-cloud-app[bot]", type: "Bot" };
  it("only the fx-gate1 context counts: our App's success on another context (fulcrumaxe/review) is not already", async () => {
    const t = world({ checks: { [HEAD]: actions(AFTER) }, statusLog: { [HEAD]: [{ context: "fulcrumaxe/review", state: "success", creator: OURS }] } }, LABELED);
    expect(await t.run()).toEqual({ kind: "posted", state: "success" });
    expect(t.s.posts).toHaveLength(1);
  });
  it("the newest fx-gate1 entry is the context's state: a newer failure over an older success of ours is not already; the reverse is", async () => {
    const failedLast = world({ checks: { [HEAD]: actions(AFTER, "failure") }, statusLog: { [HEAD]: [{ context: "fx-gate1", state: "success", creator: OURS }, { context: "fx-gate1", state: "failure", creator: OURS }] } }, LABELED);
    expect(await failedLast.run()).toEqual({ kind: "posted", state: "failure", reason: "ci_red" });
    const passedLast = world({ checks: { [HEAD]: actions(AFTER) }, statusLog: { [HEAD]: [{ context: "fx-gate1", state: "failure", creator: OURS }, { context: "fx-gate1", state: "success", creator: OURS }] } }, LABELED);
    expect(await passedLast.run()).toEqual({ kind: "already" });
    expect(passedLast.sent()).toEqual([`GET /commits/${HEAD}/statuses`]);
    expect(passedLast.s.posts).toEqual([]);
  });

  it("a failed or malformed read throws (the step retries); nothing is posted", async () => {
    const t = world();
    const broken: GitHubHttp = { request: async (req) => (req.path.endsWith("/events") ? { status: 502, body: { message: "Bad Gateway" } } : t.http.request(req)) };
    await expect(attestGate1Head(broken, { repos: REPOS, owner: "acme", name: "widgets", number: 41, sha: HEAD, ourLogin: async () => "fx-cloud-app[bot]", readHead: async () => HEAD })).rejects.toThrow(/gate1 attest/);
    const wrongSha: GitHubHttp = { request: async (req) => (req.path.endsWith("/check-runs") ? { status: 200, body: { total_count: 1, check_runs: [{ name: "check", head_sha: "e".repeat(40), status: "completed", conclusion: "success", started_at: AFTER, app: { id: ACTIONS_APP_ID } }] } } : t.http.request(req)) };
    await expect(hostedGate1Reads(wrongSha, { owner: "acme", name: "widgets", sha: HEAD, number: 41 }).checkRuns()).rejects.toThrow(/check run/);
    expect(t.s.posts).toEqual([]);
  });
});
