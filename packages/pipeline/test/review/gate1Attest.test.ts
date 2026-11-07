import { describe, expect, it } from "vitest";
import { FX_GATE1_DESCRIPTIONS } from "@fx/runner-cloud";
import { ACTIONS_APP_ID, GATE1_DESCRIPTIONS, GATE1_WORKFLOW_CONTEXTS, Gate1AttestConfigError, attestGate1Head, decideGate1, parseGate1AttestRepos, type Gate1Facts } from "../../src/review/gate1Attest.js";
import { freshRepo, type FakeCheckRun, type FakeRepoState } from "./helpers/fakeGitHubRest.js";
import { fakeGitHubLocal, gate1World, type Gate1World } from "./helpers/fakeGitHubLocal.js";

const T = "2026-11-07T10:00:00Z";
const AFTER = "2026-11-07T10:05:00Z";
const BEFORE = "2026-11-07T09:55:00Z";
const green = (startedAt = AFTER): Gate1Facts["checkRuns"][number][] => GATE1_WORKFLOW_CONTEXTS.map((name) => ({ name, appId: ACTIONS_APP_ID, status: "completed", conclusion: "success", startedAt }));
const facts = (over: Partial<Gate1Facts> = {}): Gate1Facts => ({
  labelEvents: [{ event: "labeled", label: "ci:full", createdAt: T }],
  labelEventsComplete: true,
  checkRuns: green(),
  checkRunsComplete: true,
  changedPaths: ["packages/pipeline/src/x.ts"],
  changedPathsComplete: true,
  renameUnknown: false,
  oursSucceeded: false,
  ...over,
});

describe("decideGate1 (pure)", () => {
  it("label missing: add it", () => expect(decideGate1(facts({ labelEvents: [] }))).toEqual({ verdict: "add_label" }));
  it("label never seen but the events read was cut short: wait, never guess", () => expect(decideGate1(facts({ labelEvents: [], labelEventsComplete: false }))).toEqual({ verdict: "wait", reason: "label_unknown" }));
  it("a job that started before the label: wait, red or green", () => {
    const runs = green();
    runs[2] = { ...runs[2]!, startedAt: BEFORE };
    expect(decideGate1(facts({ checkRuns: runs }))).toEqual({ verdict: "wait", reason: "run_before_label" });
    runs[2] = { ...runs[2]!, conclusion: "failure" };
    expect(decideGate1(facts({ checkRuns: runs }))).toEqual({ verdict: "wait", reason: "run_before_label" });
  });
  it("label removed after it was added: wait (never added back over a person)", () =>
    expect(decideGate1(facts({ labelEvents: [{ event: "labeled", label: "ci:full", createdAt: T }, { event: "unlabeled", label: "ci:full", createdAt: AFTER }] }))).toEqual({ verdict: "wait", reason: "label_removed" }));
  it("another label's events do not count", () => expect(decideGate1(facts({ labelEvents: [{ event: "labeled", label: "ci:fast", createdAt: T }] }))).toEqual({ verdict: "add_label" }));
  it("all five green from Actions after T: pass", () => expect(decideGate1(facts())).toEqual({ verdict: "pass" }));
  it("one job from another app: not pass (fail foreign_app)", () => {
    const runs = green();
    runs[0] = { ...runs[0]!, appId: 999 };
    expect(decideGate1(facts({ checkRuns: runs }))).toEqual({ verdict: "fail", reason: "foreign_app" });
    expect(decideGate1(facts({ checkRuns: [...green(), { ...green()[0]!, appId: 999 }] })).verdict).not.toBe("pass");
  });
  it("a red job after T: fail", () => {
    const runs = green();
    runs[1] = { ...runs[1]!, conclusion: "failure" };
    expect(decideGate1(facts({ checkRuns: runs }))).toEqual({ verdict: "fail", reason: "ci_red" });
  });
  it("a re-run attempt: the newest run of the name counts", () =>
    expect(decideGate1(facts({ checkRuns: [...green(), { ...green(BEFORE)[1]!, conclusion: "failure" }] }))).toEqual({ verdict: "pass" }));
  it("a running job: wait", () => {
    const runs = green();
    runs[4] = { ...runs[4]!, status: "in_progress", conclusion: null };
    expect(decideGate1(facts({ checkRuns: runs }))).toEqual({ verdict: "wait", reason: "check_running" });
  });
  it("a missing job, or an unfinished checks read: wait", () => {
    expect(decideGate1(facts({ checkRuns: green().slice(1) }))).toEqual({ verdict: "wait", reason: "check_missing" });
    expect(decideGate1(facts({ checkRunsComplete: false }))).toEqual({ verdict: "wait", reason: "checks_incomplete" });
  });
  it.each([".github/workflows/ci.yml", "scripts/ci/rerun-ci-full.sh", "flake.nix", "flake.lock"])("%s: fail ci_paths, before any label (TL ruling 00:45)", (p) => {
    expect(decideGate1(facts({ changedPaths: ["a.ts", p] }))).toEqual({ verdict: "fail", reason: "ci_paths" });
    expect(decideGate1(facts({ changedPaths: ["a.ts", p], labelEvents: [] }))).toEqual({ verdict: "fail", reason: "ci_paths" });
  });
  it("a path that only looks like one is not a CI path", () => expect(decideGate1(facts({ changedPaths: ["docs/.github/x", "packages/flake.nix", "scripts/cix/a"] }))).toEqual({ verdict: "pass" }));
  it("an existing success by us: already, no second post", () => expect(decideGate1(facts({ oursSucceeded: true }))).toEqual({ verdict: "already" }));
  it("an incomplete file list: wait, and no label added", () => expect(decideGate1(facts({ changedPathsComplete: false, labelEvents: [] }))).toEqual({ verdict: "wait", reason: "files_incomplete" }));
  it("a rename whose old path is unknown: fail ci_paths, before any label", () => {
    expect(decideGate1(facts({ renameUnknown: true }))).toEqual({ verdict: "fail", reason: "ci_paths" });
    expect(decideGate1(facts({ renameUnknown: true, labelEvents: [] }))).toEqual({ verdict: "fail", reason: "ci_paths" });
  });

  // Every conclusion GitHub's CheckConclusionState has besides success: none of them is green.
  it.each(["skipped", "neutral", "cancelled", "timed_out", "action_required", "stale", "startup_failure", "failure"])("a %s job after T: fail ci_red, never pass", (conclusion) => {
    const runs = green();
    runs[3] = { ...runs[3]!, conclusion };
    expect(decideGate1(facts({ checkRuns: runs }))).toEqual({ verdict: "fail", reason: "ci_red" });
  });
  it("a completed job with no conclusion: fail ci_red", () => {
    const runs = green();
    runs[0] = { ...runs[0]!, conclusion: null };
    expect(decideGate1(facts({ checkRuns: runs }))).toEqual({ verdict: "fail", reason: "ci_red" });
  });

  it("the newest run of a name counts, whichever order GitHub lists them in", () => {
    const LATER = "2026-11-07T10:09:00Z";
    // An older green listed first, a newer red after it: red.
    expect(decideGate1(facts({ checkRuns: [...green(), { ...green(LATER)[1]!, conclusion: "failure" }] }))).toEqual({ verdict: "fail", reason: "ci_red" });
    // An older run from before the label listed first, a newer green after it: pass.
    expect(decideGate1(facts({ checkRuns: [{ ...green(BEFORE)[2]!, conclusion: "failure" }, ...green()] }))).toEqual({ verdict: "pass" });
  });
  it("same-second boundaries: a run that started exactly at the label time waits; an unlabel exactly at the label time waits", () => {
    expect(decideGate1(facts({ checkRuns: green(T) }))).toEqual({ verdict: "wait", reason: "run_before_label" });
    expect(decideGate1(facts({ labelEvents: [{ event: "labeled", label: "ci:full", createdAt: T }, { event: "unlabeled", label: "ci:full", createdAt: T }] }))).toEqual({ verdict: "wait", reason: "label_removed" });
    expect(decideGate1(facts({ checkRuns: green("2026-11-07T10:00:01Z") }))).toEqual({ verdict: "pass" });
  });
});

describe("FX_GATE1_ATTEST_REPOS", () => {
  it("unset or blank is off; a list is read case-insensitively", () => {
    expect(parseGate1AttestRepos(undefined).size).toBe(0);
    expect(parseGate1AttestRepos(" ").size).toBe(0);
    expect([...parseGate1AttestRepos("Fulcrumaxe/fulcrumaxe-cloud, acme/app")]).toEqual(["fulcrumaxe/fulcrumaxe-cloud", "acme/app"]);
  });
  it.each(["fulcrumaxe", "a/b/c", "a/", "/b", "a/b,", "a b/c", "a/..", "https://github.com/a/b"])("%j is malformed and throws", (raw) => expect(() => parseGate1AttestRepos(raw)).toThrow(Gate1AttestConfigError));
  it("the descriptions are the fence's, byte for byte", () => expect(GATE1_DESCRIPTIONS).toEqual(FX_GATE1_DESCRIPTIONS));
});

const HEAD = "c".repeat(40);
const REPOS = parseGate1AttestRepos("acme/widgets");
const actions = (startedAt: string, conclusion: string | null = "success", status = "completed"): FakeCheckRun[] =>
  GATE1_WORKFLOW_CONTEXTS.map((name) => ({ name, status, conclusion, startedAt, app: { id: ACTIONS_APP_ID } }));

function world(over: Partial<FakeRepoState> = {}, g: Partial<Gate1World> = {}) {
  const s = freshRepo({ headSha: HEAD, files: [{ filename: "packages/a.ts" }], checks: { [HEAD]: actions(BEFORE) }, ...over });
  const w = gate1World(g);
  const fake = fakeGitHubLocal(s, { exclude: ["A10"], gate1: w });
  // The live head is the fake's own; a test moves it with `s.headSha`, or `moveAfterFiles` moves it the moment the file list has been read.
  const head = { moveAfterFiles: null as string | null };
  const run = (repos: ReadonlySet<string> = REPOS) =>
    attestGate1Head(fake.http, {
      repos,
      owner: s.owner,
      name: s.name,
      number: s.prNumber,
      sha: HEAD,
      ourLogin: async () => "fx-cloud-app[bot]",
      readHead: async () => {
        if (head.moveAfterFiles !== null && fake.calls.some((c) => c.label === "A1 PullRequestFiles")) s.headSha = head.moveAfterFiles;
        return s.headSha;
      },
    });
  return { s, w, fake, run, head };
}
const LABELED = { labels: ["ci:full"], labelEvents: [{ event: "labeled" as const, label: "ci:full", createdAt: T }] };
const g1Calls = (fake: { calls: { label: string }[] }) => fake.calls.map((c) => c.label).filter((l) => ["A14", "A15", "A16", "A7"].includes(l));

describe("attestGate1Head over the strict fake, through the real fence", () => {
  it("off for an unlisted repository: not one call (TL ruling 00:45)", async () => {
    const t = world();
    expect(await t.run(new Set())).toEqual({ kind: "off" });
    expect(await t.run(parseGate1AttestRepos("acme/other"))).toEqual({ kind: "off" });
    expect(t.fake.calls).toEqual([]);
  });

  it("the full path: label added; then a run before the label waits; then a green full run after it posts fx-gate1 once", async () => {
    const t = world();
    expect(await t.run()).toEqual({ kind: "label_added" });
    expect(t.w.labelAdds).toBe(1);
    expect(t.fake.calls.map((c) => c.label)).toEqual(["A17", "A1 PullRequestFiles", "A16", "A15", "A14"]);
    expect(await t.run()).toEqual({ kind: "wait", reason: "run_before_label" });
    t.s.checks[HEAD] = actions(AFTER);
    expect(await t.run()).toEqual({ kind: "posted", state: "success" });
    expect(t.s.posts).toEqual([{ sha: HEAD, body: { state: "success", context: "fx-gate1", description: GATE1_DESCRIPTIONS.success } }]);
    expect(await t.run()).toEqual({ kind: "already" });
    expect(t.s.posts).toHaveLength(1);
    expect(t.w.labelAdds).toBe(1);
    expect(t.fake.denied).toEqual([]);
    expect(t.fake.refused).toEqual([]);
  });

  it("a CI path is refused with a fixed failure and no label, before any label or checks read (TL ruling 00:45)", async () => {
    for (const p of [".github/workflows/ci-full-label.yml", "scripts/ci/rerun-ci-full.sh", "flake.lock", "flake.nix"]) {
      const t = world({ files: [{ filename: "packages/a.ts" }, { filename: p }] });
      expect(await t.run()).toEqual({ kind: "posted", state: "failure", reason: "ci_paths" });
      expect(t.w.labelAdds).toBe(0);
      expect(t.fake.calls.map((c) => c.label)).toEqual(["A17", "A1 PullRequestFiles", "A7"]);
      expect(t.s.posts[0]!.body).toEqual({ state: "failure", context: "fx-gate1", description: GATE1_DESCRIPTIONS.failure.ci_paths });
    }
  });

  it("a red full run posts failure; a removed label waits and posts nothing", async () => {
    const red = world({ checks: { [HEAD]: actions(AFTER, "failure") } }, { labels: ["ci:full"], labelEvents: [{ event: "labeled", label: "ci:full", createdAt: T }] });
    expect(await red.run()).toEqual({ kind: "posted", state: "failure", reason: "ci_red" });
    const off = world({ checks: { [HEAD]: actions(AFTER) } }, { labelEvents: [{ event: "labeled", label: "ci:full", createdAt: T }, { event: "unlabeled", label: "ci:full", createdAt: AFTER }] });
    expect(await off.run()).toEqual({ kind: "wait", reason: "label_removed" });
    expect(off.s.posts).toEqual([]);
    expect(off.w.labelAdds).toBe(0);
  });

  it("a success someone else posted is not ours: the attester still decides from the runs and posts its own", async () => {
    const t = world({ checks: { [HEAD]: actions(AFTER) }, statuses: { [HEAD]: { "fx-gate1": "success" } } }, { labels: ["ci:full"], labelEvents: [{ event: "labeled", label: "ci:full", createdAt: T }], creators: { [HEAD]: { __typename: "User", login: "fx-cloud-app" } } });
    expect(await t.run()).toEqual({ kind: "posted", state: "success" });
  });

  // GraphQL names our App's bot by its slug and REST adds `[bot]`; anything else, however close, is someone else's status.
  it.each([
    ["a near-miss slug", { __typename: "Bot", login: "fx-cloud-app-x" }, "SUCCESS"],
    ["our slug in another case", { __typename: "Bot", login: "FX-CLOUD-APP" }, "SUCCESS"],
    ["another App's bot", { __typename: "Bot", login: "other-app" }, "SUCCESS"],
    ["a user whose login is our bot's", { __typename: "User", login: "fx-cloud-app[bot]" }, "SUCCESS"],
    ["our own bot, but a failure", { __typename: "Bot", login: "fx-cloud-app" }, "FAILURE"],
  ])("%s does not count as ours: the attester decides from the runs and posts its own success", async (_what, creator, state) => {
    const t = world({ checks: { [HEAD]: actions(AFTER) }, statuses: { [HEAD]: { "fx-gate1": state.toLowerCase() } } }, { ...LABELED, creators: { [HEAD]: creator } });
    expect(await t.run()).toEqual({ kind: "posted", state: "success" });
    expect(t.s.posts).toHaveLength(1);
  });
  it.each(["fx-cloud-app", "fx-cloud-app[bot]"])("our bot as %s, typed Bot, with success: already, no read of files, labels or runs and no post", async (login) => {
    const t = world({ checks: { [HEAD]: actions(AFTER) }, statuses: { [HEAD]: { "fx-gate1": "success" } } }, { ...LABELED, creators: { [HEAD]: { __typename: "Bot", login } } });
    expect(await t.run()).toEqual({ kind: "already" });
    expect(t.fake.calls.map((c) => c.label)).toEqual(["A17"]);
    expect(t.s.posts).toEqual([]);
  });

  it.each(["skipped", "neutral", "cancelled", "timed_out", "action_required", "stale", "startup_failure"])("a %s run started after the label: failure ci_red, never a success", async (conclusion) => {
    const t = world({ checks: { [HEAD]: actions(AFTER, conclusion) } }, LABELED);
    expect(await t.run()).toEqual({ kind: "posted", state: "failure", reason: "ci_red" });
    expect(t.s.posts.map((p) => p.body.state)).toEqual(["failure"]);
  });

  it("the head moves while the files are read: wait head_moved, before any label, checks read or post", async () => {
    for (const files of [[{ filename: "packages/a.ts" }], [{ filename: ".github/workflows/ci.yml" }]]) {
      const t = world({ files, checks: { [HEAD]: actions(AFTER) } });
      t.head.moveAfterFiles = "d".repeat(40);
      expect(await t.run()).toEqual({ kind: "wait", reason: "head_moved" });
      expect(t.fake.calls.map((c) => c.label)).toEqual(["A17", "A1 PullRequestFiles"]);
      expect(t.s.posts).toEqual([]);
      expect(t.w.labelAdds).toBe(0);
    }
  });

  it("a renamed file (the fenced read gives no old path): fixed failure ci_paths, no label added", async () => {
    const t = world({ files: [{ filename: "packages/a.ts" }, { filename: "docs/moved.md", previous_filename: ".github/workflows/old.yml" }] });
    expect(await t.run()).toEqual({ kind: "posted", state: "failure", reason: "ci_paths" });
    expect(g1Calls(t.fake)).toEqual(["A7"]);
    expect(t.w.labelAdds).toBe(0);
    expect(t.s.posts[0]!.body).toEqual({ state: "failure", context: "fx-gate1", description: GATE1_DESCRIPTIONS.failure.ci_paths });
  });

  // The app id comes from each run's own check suite (A15), never assumed: a run by another App, or one GitHub reports with no App, is not Actions'.
  it.each([
    ["another App's run (app id 999)", { id: 999 }],
    ["a run with no App", null],
  ] as const)("%s among five green runs after the label: failure foreign_app, never a success", async (_what, app) => {
    const runs = actions(AFTER).map((c, i) => (i === 2 ? { ...c, app } : c));
    const t = world({ checks: { [HEAD]: runs } }, LABELED);
    expect(await t.run()).toEqual({ kind: "posted", state: "failure", reason: "foreign_app" });
    expect(t.s.posts).toEqual([{ sha: HEAD, body: { state: "failure", context: "fx-gate1", description: GATE1_DESCRIPTIONS.failure.foreign_app } }]);
    expect(t.w.labelAdds).toBe(0);
  });

  it("more check runs than the five pages A15 may read: wait checks_incomplete, no post", async () => {
    const filler: FakeCheckRun[] = Array.from({ length: 500 }, (_, i) => ({ name: `lint-${i}`, status: "completed", conclusion: "success", startedAt: AFTER, app: { id: ACTIONS_APP_ID } }));
    const t = world({ checks: { [HEAD]: [...actions(AFTER), ...filler] } }, LABELED);
    expect(await t.run()).toEqual({ kind: "wait", reason: "checks_incomplete" });
    expect(t.fake.calls.filter((c) => c.label === "A15")).toHaveLength(5);
    expect(t.s.posts).toEqual([]);
  });
});
