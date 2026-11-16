// Run with: node --test scripts/ci/rollup-position.test.mjs
//
// scripts/ci/rollup-position.mjs decides whether a merge queue entry runs the suites or waits for the entry on top
// of it. Every case builds the queue by hand: no network, no clock (the clock and the sleep are injected).
// The queue fake behaves like GitHub where it matters: when a group merges, its pull requests become merged and its
// queue refs are DELETED.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_WAIT_SECONDS, MAX_API_ERRORS, POLL_SECONDS, checkRuleset, classify, isCloud, run } from "./rollup-position.mjs";

const sha = (c) => c.repeat(40);
const BASE = sha("b");
const A = sha("1");
const B = sha("2");
const C = sha("3");
const ref = (pr, s) => ({ ref: `refs/heads/gh-readonly-queue/main/pr-${pr}-${BASE}`, object: { sha: s } });
const env = (pr, s) => ({
  CI_EVENT_NAME: "merge_group",
  MG_HEAD_REF: `refs/heads/gh-readonly-queue/main/pr-${pr}-${BASE}`,
  MG_HEAD_SHA: s,
  GITHUB_REPOSITORY: "acme/widgets",
});
const teamPr = { user: { type: "User" }, head: { ref: "feature" }, merged: false };
// Check runs of the entry on top, every one green. The fake serves them so that a regression that trusts them is caught.
const greenRuns = ["check", "e2e-runner", "workspace-e2e (desktop)", "workspace-e2e (phone)", "workspace-e2e (tablet)"].map((name) => ({
  name, status: "completed", conclusion: "success", completed_at: "2026-01-01T00:00:00Z", app: { id: 15368 },
}));

// The live ruleset as the rules API answers it. The default is the settings rollups need: HEADGREEN and 150 minutes.
const mqRule = (grouping = "HEADGREEN", timeout = 150) => ({
  type: "merge_queue", parameters: { grouping_strategy: grouping, check_response_timeout_minutes: timeout, max_entries_to_build: 5 },
});

/**
 * A mutable queue fake. `order` lists [pr, sha] first to last; entry i contains every entry before it.
 *   q.merge(prs)   the group merged: those pull requests become merged and ALL queue refs are deleted (as GitHub does)
 *   q.set(order)   the queue was rebuilt
 *   q.broken       a path prefix that throws; q.cmp  override of the compare answer per "from>to" key
 * `q.calls` records every path.
 */
function queue(order, over = {}) {
  const q = { order, merged: new Set(), refsGone: false, broken: over.broken ?? null, cmp: over.cmp ?? {}, calls: [] };
  const idx = (s) => q.order.findIndex(([, x]) => x === s);
  q.merge = (prs) => { for (const p of prs) q.merged.add(p); q.refsGone = true; q.order = []; };
  q.set = (o) => { q.order = o; };
  q.getJson = async (path) => {
    q.calls.push(path);
    if (q.broken && path.startsWith(q.broken)) throw new Error("boom");
    if (path.includes("/rules/branches/")) {
      if (over.rulesError) throw new Error("rules boom");
      return over.rules ?? [mqRule()];
    }
    if (path.includes("/git/matching-refs/")) return q.refsGone ? [] : (over.refs ?? q.order.map(([pr, s]) => ref(pr, s)));
    const cmp = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
    if (cmp) {
      if (q.cmp[`${cmp[1]}>${cmp[2]}`]) return q.cmp[`${cmp[1]}>${cmp[2]}`];
      const [i, j] = [idx(cmp[1]), idx(cmp[2])];
      return j > i ? { status: "ahead", behind_by: 0 } : { status: "behind", behind_by: 1 };
    }
    const pr = /\/pulls\/(\d+)$/.exec(path);
    if (pr) {
      const n = Number(pr[1]);
      const base = typeof over.pulls === "function" ? over.pulls(n) : (over.pulls?.[pr[1]] ?? teamPr);
      return { ...base, merged: q.merged.has(n) };
    }
    const cr = /\/commits\/([0-9a-f]{40})\/check-runs/.exec(path);
    if (cr) return { check_runs: over.runs?.[cr[1]] ?? [] };
    throw new Error(`unexpected GET ${path}`);
  };
  return q;
}

/** A fake monotonic clock: sleeping advances it, and `onSleep` lets a test change the queue between looks. */
function clock(onSleep = () => {}) {
  let t = 0;
  let n = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; onSleep(++n, t); }, elapsed: () => t };
}
const POLL = POLL_SECONDS * 1000;
const CAP = MAX_WAIT_SECONDS * 1000;

test("a single entry is the last one and runs the suites", async () => {
  const q = queue([[10, A]]);
  const c = clock();
  const r = await run({ env: env(10, A), getJson: q.getJson, ...c });
  assert.equal(r.skip, false);
  assert.equal(c.elapsed(), 0);
});

test("last of a batch runs the suites, middle and first are covered", async () => {
  const q = queue([[10, A], [11, B], [12, C]]);
  assert.equal((await classify({ env: env(12, C), getJson: q.getJson })).role, "last");
  const mid = await classify({ env: env(11, B), getJson: q.getJson });
  assert.equal(mid.role, "covered");
  assert.deepEqual(mid.covering.map((e) => e.pr), [12]);
  const first = await classify({ env: env(10, A), getJson: q.getJson });
  assert.deepEqual(first.covering.map((e) => e.pr), [11, 12]);
});

test("a covered entry waits, and skips only once its own pull request is merged (queue refs deleted, as GitHub does)", async () => {
  const q = queue([[10, A], [11, B]]);
  const c = clock((n) => { if (n === 3) q.merge([10, 11]); });
  const r = await run({ env: env(10, A), getJson: q.getJson, ...c });
  assert.equal(r.skip, true);
  assert.match(r.reason, /merged/);
  assert.equal(c.elapsed(), 3 * POLL);
});

test("merged is checked before the own ref is looked up: refs gone and merged is a skip, refs gone and not merged is a full run", async () => {
  const merged = queue([[10, A], [11, B]]);
  merged.merge([10, 11]);
  const r = await run({ env: env(10, A), getJson: merged.getJson, ...clock() });
  assert.equal(r.skip, true);
  assert.match(r.reason, /merged/);
  const gone = queue([[10, A], [11, B]]);
  gone.refsGone = true;
  const f = await run({ env: env(10, A), getJson: gone.getJson, ...clock() });
  assert.equal(f.skip, false);
  assert.match(f.reason, /no longer in the queue/);
});

test("the entry on top is green but this pull request is not merged: no success, a full run at the cap", async () => {
  // Every check run of the entry on top is green and the fake serves them; none of it may matter.
  const q = queue([[10, A], [11, B]], { runs: { [B]: greenRuns } });
  const c = clock();
  const r = await run({ env: env(10, A), getJson: q.getJson, ...c });
  assert.equal(r.skip, false);
  assert.match(r.reason, /cap/);
  assert.ok(c.elapsed() >= CAP);
});

test("the cap runs in full, with nothing else but the cap to end the wait", async () => {
  const q = queue([[10, A], [11, B]]);
  const c = clock();
  const r = await run({ env: env(10, A), getJson: q.getJson, ...c });
  assert.deepEqual({ skip: r.skip, reason: r.reason }, { skip: false, reason: "waited the cap for the entries on top" });
  assert.ok(c.elapsed() >= CAP && c.elapsed() < CAP + 2 * POLL);
});

test("the cap is counted from after the settle delay, on the injected monotonic clock", async () => {
  const q = queue([[10, A], [11, B]]);
  const c = clock();
  const r = await run({ env: env(10, A), getJson: q.getJson, ...c, settle: 120 });
  assert.equal(r.skip, false);
  assert.ok(c.elapsed() >= 120_000 + CAP);
});

test("the queue changes mid-run: the entry on top is removed, so this one becomes last and runs in full", async () => {
  const q = queue([[10, A], [11, B]]);
  const c = clock((n) => { if (n === 2) q.set([[10, A]]); });
  const r = await run({ env: env(10, A), getJson: q.getJson, ...c });
  assert.equal(r.skip, false);
  assert.match(r.reason, /no queue entry sits on top/);
  assert.equal(c.elapsed(), 2 * POLL);
});

test("the entry on top is replaced by a rebuilt one: still waiting, still no skip", async () => {
  const q = queue([[10, A], [11, B]], { runs: { [B]: greenRuns } });
  const c = clock((n) => { if (n === 4) q.set([[10, A], [11, sha("7")]]); });
  const r = await run({ env: env(10, A), getJson: q.getJson, ...c });
  assert.equal(r.skip, false);
  assert.match(r.reason, /cap/);
});

test("the queue changes mid-run: this entry was rebuilt away, so it runs in full", async () => {
  const q = queue([[10, A], [11, B]]);
  const c = clock((n) => { if (n === 1) q.set([[10, sha("9")], [11, sha("8")]]); });
  const r = await run({ env: env(10, A), getJson: q.getJson, ...c });
  assert.equal(r.skip, false);
  assert.match(r.reason, /no longer in the queue/);
});

test("an API error on the first look runs in full, at once", async () => {
  for (const broken of ["/repos/acme/widgets/git/matching-refs", "/repos/acme/widgets/compare", "/repos/acme/widgets/pulls"]) {
    const q = queue([[10, A], [11, B]], { broken });
    const c = clock();
    const r = await run({ env: env(10, A), getJson: q.getJson, ...c });
    assert.equal(r.skip, false, broken);
    assert.match(r.reason, /error: boom/);
    assert.equal(c.elapsed(), 0);
  }
});

test("API errors while waiting are retried a few times, then run in full and never skip (every read)", async () => {
  for (const broken of ["/repos/acme/widgets/git/matching-refs", "/repos/acme/widgets/compare", "/repos/acme/widgets/pulls"]) {
    const q = queue([[10, A], [11, B]]);
    const c = clock((n) => { if (n === 1) q.broken = broken; });
    const r = await run({ env: env(10, A), getJson: q.getJson, ...c });
    assert.equal(r.skip, false, broken);
    assert.match(r.reason, /error: boom/, broken);
    assert.equal(c.elapsed(), (1 + MAX_API_ERRORS) * POLL, broken);
  }
});

test("a single transient error while waiting does not end the wait, and a merge after it is still a skip", async () => {
  const q = queue([[10, A], [11, B]]);
  const c = clock((n) => {
    q.broken = n === 1 ? "/repos/acme/widgets/pulls" : null;
    if (n === 3) q.merge([10, 11]);
  });
  const r = await run({ env: env(10, A), getJson: q.getJson, ...c });
  assert.equal(r.skip, true);
  assert.match(r.reason, /merged/);
});

test("an error while waiting right after the group merged (refs gone) is not a skip either", async () => {
  const q = queue([[10, A], [11, B]]);
  const c = clock((n) => { if (n === 1) { q.merge([10, 11]); q.broken = "/repos/acme/widgets/pulls"; } });
  const r = await run({ env: env(10, A), getJson: q.getJson, ...c });
  assert.equal(r.skip, false);
});

test("compare answers that are not 'ahead with behind_by 0' never count as sitting on top", async () => {
  const cases = [
    { status: "diverged", ahead_by: 1, behind_by: 1 },
    { status: "identical", ahead_by: 0, behind_by: 0 },
    { status: "ahead", ahead_by: 1, behind_by: 1 },
    { status: "behind", ahead_by: 0, behind_by: 1 },
  ];
  for (const answer of cases) {
    const q = queue([[10, A], [11, B]], { cmp: { [`${A}>${B}`]: answer } });
    const r = await classify({ env: env(10, A), getJson: q.getJson });
    assert.equal(r.role, "last", answer.status);
    const c = clock();
    const out = await run({ env: env(10, A), getJson: q.getJson, ...c });
    assert.equal(out.skip, false, answer.status);
    assert.match(out.reason, /no queue entry sits on top/, answer.status);
    assert.equal(c.elapsed(), 0, answer.status);
  }
});

test("malformed refs or inputs run in full", async () => {
  assert.equal((await classify({ env: { ...env(10, A), MG_HEAD_REF: "refs/heads/main" }, getJson: queue([]).getJson })).role, "full");
  assert.equal((await classify({ env: { ...env(10, A), CI_EVENT_NAME: "pull_request" }, getJson: queue([]).getJson })).role, "full");
  const bad = queue([[10, A]], { refs: [{ ref: "refs/heads/gh-readonly-queue/main/odd", object: { sha: A } }] });
  assert.equal((await classify({ env: env(10, A), getJson: bad.getJson })).role, "full");
  const notArray = queue([[10, A]], { refs: { message: "Not Found" } });
  assert.equal((await classify({ env: env(10, A), getJson: notArray.getJson })).role, "full");
  const wrong = await run({ env: { ...env(10, A), CI_EVENT_NAME: "pull_request" }, getJson: queue([]).getJson, ...clock() });
  assert.equal(wrong.skip, false);
});

test("a cloud-built entry anywhere in the chain forces the full run", async () => {
  for (const pulls of [
    { 11: { user: { type: "Bot" }, head: { ref: "x" } } },
    { 10: { user: { type: "User" }, head: { ref: "fx/p-7" } } },
    { 11: { user: { type: "User" } } },
  ]) {
    const q = queue([[10, A], [11, B]], { pulls });
    const r = await classify({ env: env(10, A), getJson: q.getJson });
    assert.equal(r.role, "full");
    assert.match(r.reason, /cloud-built or unreadable/);
  }
  assert.equal(isCloud(null), true);
  assert.equal(isCloud(teamPr), false);
});

test("a cloud entry that is only ahead of this one does not matter, and last never reads another pull request", async () => {
  const q = queue([[10, A], [11, B]], { pulls: { 10: { user: { type: "Bot" }, head: { ref: "fx/p-1" } } } });
  const r = await classify({ env: env(11, B), getJson: q.getJson });
  assert.equal(r.role, "last");
  assert.equal(q.calls.some((p) => p.includes("/pulls/")), false);
});

test("the settle delay is spent before the first look", async () => {
  const q = queue([[10, A]]);
  const c = clock();
  await run({ env: env(10, A), getJson: q.getJson, ...c, settle: 120 });
  assert.equal(c.elapsed(), 120_000);
});

test("the script never reads check runs (nothing it reports depends on them)", async () => {
  const q = queue([[10, A], [11, B]], { runs: { [B]: greenRuns } });
  await run({ env: env(10, A), getJson: q.getJson, ...clock() });
  assert.equal(q.calls.some((p) => p.includes("check-runs")), false);
});

test("timing budget: the longest settle (10 min) + the cap + a 50 minute full run fits well inside the 150 minute queue timeout", () => {
  assert.ok(10 + MAX_WAIT_SECONDS / 60 + 50 <= 140);
});

// ---- the live ruleset decides whether waiting is allowed at all -------------------------------------------------
async function viaRun(over) {
  const q = queue([[10, A], [11, B]], over);
  const c = clock(() => q.merge([10, 11]));
  const r = await run({ env: env(10, A), getJson: q.getJson, ...c });
  return { r, q, c };
}

test("ruleset ALLGREEN: run in full at once, no wait, no queue read", async () => {
  const { r, q, c } = await viaRun({ rules: [mqRule("ALLGREEN", 150)] });
  assert.equal(r.skip, false);
  assert.match(r.reason, /ALLGREEN/);
  assert.equal(c.elapsed(), 0);
  assert.equal(q.calls.some((p) => p.includes("/pulls/") || p.includes("/matching-refs/")), false);
});

test("ruleset HEADGREEN with a 90 minute timeout: run in full at once", async () => {
  const { r, c } = await viaRun({ rules: [mqRule("HEADGREEN", 90)] });
  assert.equal(r.skip, false);
  assert.match(r.reason, /90/);
  assert.equal(c.elapsed(), 0);
});

test("ruleset HEADGREEN with a 150 minute timeout: the entry may wait, and skips once its pull request is merged", async () => {
  const { r, c } = await viaRun({ rules: [mqRule("HEADGREEN", 150)] });
  assert.equal(r.skip, true);
  assert.equal(r.ruleset.mayWait, true);
  assert.ok(c.elapsed() > 0);
});

test("ruleset read error: run in full at once", async () => {
  const { r, c } = await viaRun({ rulesError: true });
  assert.equal(r.skip, false);
  assert.match(r.reason, /error:/);
  assert.equal(c.elapsed(), 0);
});

test("ruleset answers that cannot be trusted never allow waiting", async () => {
  const bad = [
    "not an array",
    [],
    [{ type: "pull_request", parameters: {} }],
    [{ type: "merge_queue" }],
    [{ type: "merge_queue", parameters: { grouping_strategy: "HEADGREEN" } }],
    [{ type: "merge_queue", parameters: { grouping_strategy: "HEADGREEN", check_response_timeout_minutes: "150" } }],
    [mqRule("HEADGREEN", 150), mqRule("ALLGREEN", 150)],
    [mqRule("HEADGREEN", 150), mqRule("HEADGREEN", 149)],
  ];
  for (const rules of bad) {
    const out = await checkRuleset({ env: env(10, A), getJson: queue([], { rules }).getJson });
    assert.equal(out.mayWait, false, JSON.stringify(rules));
  }
  assert.equal((await checkRuleset({ env: { ...env(10, A), MG_HEAD_REF: "refs/heads/main" }, getJson: queue([]).getJson })).mayWait, false);
});

test("the ruleset is read for the queue's base branch", async () => {
  const q = queue([]);
  await checkRuleset({ env: env(10, A), getJson: q.getJson });
  assert.deepEqual(q.calls, ["/repos/acme/widgets/rules/branches/main"]);
});
