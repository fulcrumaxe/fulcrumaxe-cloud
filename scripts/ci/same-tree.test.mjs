// Run with: node --test scripts/ci/same-tree.test.mjs
//
// scripts/ci/same-tree.mjs decides whether a merge queue run may skip the suites. Every case builds the inputs
// by hand (no network, no git): the decision function takes its git and API readers as arguments.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, envLines, isOurBot } from "./same-tree.mjs";

const sha = (c) => c.repeat(40);
const BASE = sha("b");
const GROUP = sha("c");
const PR_HEAD = sha("d");
const TREE = sha("e");
const PR = 42;

const goodEnv = {
  CI_EVENT_NAME: "merge_group",
  MG_HEAD_REF: `refs/heads/gh-readonly-queue/main/pr-${PR}-${BASE}`,
  MG_HEAD_SHA: GROUP,
  MG_BASE_SHA: BASE,
  GITHUB_REPOSITORY: "acme/widgets",
  FX_APP_BOT_LOGIN: "fx-app[bot]",
};
const goodGit = (args) => {
  const a = args.join(" ");
  if (a === "rev-parse HEAD") return `${GROUP}\n`;
  if (a === "rev-parse HEAD^1") return `${BASE}\n`;
  if (a === "rev-parse HEAD^{tree}") return `${TREE}\n`;
  throw new Error(`unexpected git ${a}`);
};
const goodStatuses = [
  { context: "other", state: "failure", creator: { type: "User", login: "x" } },
  { context: "fx-gate1", state: "success", creator: { type: "Bot", login: "fx-app[bot]" } },
  { context: "fx-gate1", state: "failure", creator: { type: "Bot", login: "fx-app[bot]" } },
];
/** An API fake that serves the three reads, with per-test overrides; it records every path it was asked for. */
function api(over = {}) {
  const calls = [];
  const getJson = async (path) => {
    calls.push(path);
    const hit = Object.entries(over).find(([k]) => path.startsWith(k));
    if (hit) {
      if (typeof hit[1] === "function") return hit[1](path);
      return hit[1];
    }
    if (path === `/repos/acme/widgets/pulls/${PR}`) return { head: { sha: PR_HEAD } };
    if (path === `/repos/acme/widgets/git/commits/${PR_HEAD}`) return { tree: { sha: TREE }, parents: [{ sha: BASE }] };
    if (path.startsWith(`/repos/acme/widgets/commits/${PR_HEAD}/statuses`)) return goodStatuses;
    throw new Error(`unexpected GET ${path}`);
  };
  return { getJson, calls };
}
const run = (over = {}, { env = {}, git = goodGit } = {}) => decide({ env: { ...goodEnv, ...env }, git, getJson: api(over).getJson });

test("identical tree and fx-gate1 = success from our App: proven", async () => {
  const r = await run();
  assert.equal(r.proven, true, r.reason);
});

test("the App login matches with or without [bot], never by prefix or by a user account", () => {
  assert.equal(isOurBot({ type: "Bot", login: "fx-app[bot]" }, "fx-app"), true);
  assert.equal(isOurBot({ type: "Bot", login: "fx-app" }, "fx-app[bot]"), true);
  assert.equal(isOurBot({ type: "Bot", login: "fx-app-evil[bot]" }, "fx-app"), false);
  assert.equal(isOurBot({ type: "User", login: "fx-app" }, "fx-app"), false);
  assert.equal(isOurBot({ type: "Bot", login: "fx-app" }, ""), false);
  assert.equal(isOurBot(null, "fx-app"), false);
});

test("a different tree (the base moved): not proven", async () => {
  const r = await run({ [`/repos/acme/widgets/git/commits/${PR_HEAD}`]: { tree: { sha: sha("f") }, parents: [{ sha: BASE }] } });
  assert.equal(r.proven, false);
  assert.match(r.reason, /trees differ/);
});

test("the revert case: same tree but the head was built on an older main (parent is not the group base): not proven", async () => {
  const older = sha("8");
  const r = await run({ [`/repos/acme/widgets/git/commits/${PR_HEAD}`]: { tree: { sha: TREE }, parents: [{ sha: older }] } });
  assert.equal(r.proven, false);
  assert.match(r.reason, /directly on the base tip/);
});

test("a head with two parents, no parents, or no parents field: not proven", async () => {
  const path = `/repos/acme/widgets/git/commits/${PR_HEAD}`;
  for (const parents of [[{ sha: BASE }, { sha: sha("7") }], [], undefined, null, [{}]]) {
    const r = await run({ [path]: { tree: { sha: TREE }, parents } });
    assert.equal(r.proven, false, JSON.stringify(parents));
  }
});

test("multi pull request group: a ref whose base is not the group base, or a parent that is not the base: not proven", async () => {
  const other = sha("9");
  const refDiffers = await run({}, { env: { MG_HEAD_REF: `refs/heads/gh-readonly-queue/main/pr-${PR}-${other}` } });
  assert.equal(refDiffers.proven, false);
  const parentDiffers = await run({}, { git: (a) => (a.join(" ") === "rev-parse HEAD^1" ? `${other}\n` : goodGit(a)) });
  assert.equal(parentDiffers.proven, false);
  assert.match(parentDiffers.reason, /directly on the base tip/);
});

test("a head ref that does not name one pull request: not proven", async () => {
  for (const ref of ["", "refs/heads/main", `refs/heads/gh-readonly-queue/main/pr-${PR}`, `refs/heads/gh-readonly-queue/main/pr-${PR}-${PR}-${BASE}`, `refs/heads/gh-readonly-queue/main/pr-x-${BASE}`]) {
    const r = await run({}, { env: { MG_HEAD_REF: ref } });
    assert.equal(r.proven, false, ref);
  }
});

test("not a merge group event, or the checked-out commit is not the group head: not proven", async () => {
  assert.equal((await run({}, { env: { CI_EVENT_NAME: "pull_request" } })).proven, false);
  assert.equal((await run({}, { git: (a) => (a.join(" ") === "rev-parse HEAD" ? `${sha("1")}\n` : goodGit(a)) })).proven, false);
});

test("fx-gate1 missing, failing, pending, or posted by someone else: not proven", async () => {
  const cases = {
    missing: [{ context: "other", state: "success", creator: { type: "Bot", login: "fx-app[bot]" } }],
    empty: [],
    failure: [{ context: "fx-gate1", state: "failure", creator: { type: "Bot", login: "fx-app[bot]" } }],
    pending: [{ context: "fx-gate1", state: "pending", creator: { type: "Bot", login: "fx-app[bot]" } }],
    foreignBot: [{ context: "fx-gate1", state: "success", creator: { type: "Bot", login: "other-app[bot]" } }],
    user: [{ context: "fx-gate1", state: "success", creator: { type: "User", login: "fx-app" } }],
    newestWins: [
      { context: "fx-gate1", state: "failure", creator: { type: "Bot", login: "fx-app[bot]" } },
      { context: "fx-gate1", state: "success", creator: { type: "Bot", login: "fx-app[bot]" } },
    ],
    notAList: { message: "nope" },
    malformed: [null],
  };
  for (const [name, statuses] of Object.entries(cases)) {
    const r = await run({ [`/repos/acme/widgets/commits/${PR_HEAD}/statuses`]: statuses });
    assert.equal(r.proven, false, name);
  }
  assert.equal((await run({}, { env: { FX_APP_BOT_LOGIN: "" } })).proven, false, "no App login configured");
});

test("any API error (or an unreadable answer) is not proven, never a throw", async () => {
  const boom = () => {
    throw new Error("GET answered 502");
  };
  for (const path of [`/repos/acme/widgets/pulls/${PR}`, `/repos/acme/widgets/git/commits/${PR_HEAD}`, `/repos/acme/widgets/commits/${PR_HEAD}/statuses`]) {
    const r = await run({ [path]: boom });
    assert.equal(r.proven, false, path);
    assert.match(r.reason, /error/);
  }
  assert.equal((await run({ [`/repos/acme/widgets/pulls/${PR}`]: {} })).proven, false);
  assert.equal((await run({ [`/repos/acme/widgets/pulls/${PR}`]: { head: { sha: "short" } } })).proven, false);
  assert.equal((await run({ [`/repos/acme/widgets/git/commits/${PR_HEAD}`]: {} })).proven, false);
  const gitBoom = await run({}, { git: () => { throw new Error("git failed"); } });
  assert.equal(gitBoom.proven, false);
});

test("a long status list is paged, and a missing fx-gate1 after the last page is not proven", async () => {
  const filler = Array.from({ length: 100 }, () => ({ context: "other", state: "success", creator: { type: "Bot", login: "x" } }));
  const second = [{ context: "fx-gate1", state: "success", creator: { type: "Bot", login: "fx-app[bot]" } }];
  const paged = (path) => (path.endsWith("&page=1") ? filler : second);
  assert.equal((await run({ [`/repos/acme/widgets/commits/${PR_HEAD}/statuses`]: paged })).proven, true);
  assert.equal((await run({ [`/repos/acme/widgets/commits/${PR_HEAD}/statuses`]: () => filler })).proven, false);
});

test("the answer reads only: every request is a GET path under the repository", async () => {
  const a = api();
  await decide({ env: goodEnv, git: goodGit, getJson: a.getJson });
  assert.ok(a.calls.length >= 3);
  for (const p of a.calls) assert.match(p, /^\/repos\/acme\/widgets\//);
});

test("env lines: CI_SAME_TREE always, plus at most one constant assignment of the exact allowed shape", () => {
  assert.equal(envLines(undefined), "CI_SAME_TREE=true\n");
  assert.equal(envLines("CI_SCOPE_E2E=false"), "CI_SAME_TREE=true\nCI_SCOPE_E2E=false\n");
  for (const bad of ["CI_SCOPE_E2E=false\nPATH=/x", "lower=false", "A=B C", "A=false;x", "A=1"]) assert.equal(envLines(bad), "CI_SAME_TREE=true\n", bad);
});
