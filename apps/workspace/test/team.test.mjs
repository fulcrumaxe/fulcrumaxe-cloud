// apps/workspace/test/team.test.mjs
//
// The Team app's logic (team-model.js, team-api.js) against a fake client. The page, with the real DOM, axe, the layouts and the production CSP,
// is driven on the built output in e2e/team.spec.ts. Pinned here: the exact requests, the agent-state table (L3), the data age and gap rules
// (L1, L2), the per-source limits, the refetch-everything-on-engine.changed rule, and that nothing a screen shows is null, undefined or NaN.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DELETE_URL, REPOS_URL, SETTINGS_URL, createTeamApi, panelUrl } from "../apps/team/team-api.js";
import { DEBOUNCE_MS, REFRESH_MS, SOURCE_LIMIT_S, WORDS, agentRow, asOfWords, chipOf, createTeam, describe as describeState, failureSentence, gapBanner, githubLink, hm, isStale, laneRows, readEnvelope, readRepos, readSettings, sourceNotices } from "../apps/team/team-model.js";
import { HOSTILE, REPO_A, REPO_B, makeFixtures } from "./fixtures/team/fixtures.mjs";

const NOW = Date.parse("2026-11-16T15:00:00.000Z");
const F = makeFixtures(NOW);
const flush = () => new Promise((r) => setTimeout(r, 0));
const fail = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });

/** A call() answering by "METHOD path"; a function value is called each time, an Error is thrown. */
function fakeCall(over = {}) {
  const log = [];
  const routes = {
    ["GET " + SETTINGS_URL]: F.settings(),
    ["GET " + REPOS_URL]: F.list([F.repo(), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site" })]),
    ["GET " + panelUrl("agents", REPO_A)]: F.envelope([F.agent()]),
    ["GET " + panelUrl("lanes", REPO_A)]: F.envelope([F.lane()]),
    ["GET " + panelUrl("gates", REPO_A)]: F.envelope([F.gate()]),
    ["GET " + panelUrl("agents", REPO_B)]: F.envelope([]),
    ["GET " + panelUrl("lanes", REPO_B)]: F.envelope([]),
    ["GET " + panelUrl("gates", REPO_B)]: F.envelope([]),
    ["PUT " + SETTINGS_URL]: { ok: true },
    ["PUT " + DELETE_URL]: { ok: true },
    ...over,
  };
  const call = vi.fn(async (method, path, body) => {
    log.push([method, path, body]);
    const r = routes[method + " " + path];
    if (r === undefined) throw fail(404, "not_found");
    const v = typeof r === "function" ? r(body) : r;
    if (v instanceof Error) throw v;
    return v;
  });
  return { call, log, routes };
}
/** Timers the test moves by hand. */
function clock() {
  let id = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms, repeat: false }); return id; },
    clearTimer: (i) => timers.delete(i),
    setRepeat: (fn, ms) => { timers.set(++id, { fn, ms, repeat: true }); return id; },
    clearRepeat: (i) => timers.delete(i),
    fire: (pred) => { for (const [i, t] of [...timers]) if (pred(t)) { if (!t.repeat) timers.delete(i); t.fn(); } },
    count: () => timers.size,
  };
}
/** `now` is the moment the view is drawn at: t.view() is describe() of the current state at that time (the controller itself keeps no clock). */
function team({ now = NOW, ...over } = {}, routes = {}) {
  const f = fakeCall(routes);
  const clk = clock();
  const t = createTeam({ client: createTeamApi(f.call), ...clk, ...over });
  t.view = () => describeState(t.state, now);
  return { t, f, clk };
}
const texts = (v) => JSON.stringify(v);
/** Every string a view holds, however deep. */
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
const bad = /\bnull\b|undefined|NaN|Invalid Date/;

describe("requests", () => {
  it("reads the settings, the repos, then the three panels of the first repo, at exactly these paths", async () => {
    const { t, f } = team();
    await t.load();
    expect(f.log.map(([m, p]) => m + " " + p)).toEqual([
      "GET /api/v1/engine/settings",
      "GET /api/v1/engine/repos",
      `GET /api/v1/engine/repos/${REPO_A}/agents?state=running`,
      `GET /api/v1/engine/repos/${REPO_A}/lanes`,
      `GET /api/v1/engine/repos/${REPO_A}/gates`,
    ]);
    expect(f.log.some(([, p]) => p.includes("pr="))).toBe(false); // gates are read without a pr; the client groups by PR
  });
  it("reads no repo and no panel while watch is off", async () => {
    const { t, f } = team({}, { ["GET " + SETTINGS_URL]: F.settings({ watch_enabled: false }) });
    await t.load();
    expect(f.log).toHaveLength(1);
    expect(t.state.status).toBe("ready");
    expect(t.view().kind).toBe("off");
  });
});

describe("agent state (L3): never running after a crash or after 3 h, or when the session is not live", () => {
  const HOUR = 3600;
  for (const claimed of ["running", "unknown", "stopped"])
    for (const live of [true, false])
      for (const [label, age] of [["under 3 h", 2 * HOUR], ["over 3 h", 4 * HOUR], ["exactly 3 h", 3 * HOUR]]) {
        it(`${claimed} / ${live ? "live" : "not live"} / ${label}`, () => {
          const row = agentRow(F.agent({ state: claimed, started_at: F.iso(age) }), live, NOW, "acme-labs/widgets");
          const expected = claimed === "stopped" ? "stopped" : claimed === "running" && live && age < 3 * HOUR ? "running" : "unknown";
          expect(row.state).toBe(expected);
          if (expected === "unknown") {
            expect(row.text).toBe("unknown: started " + hm(F.iso(age)) + ", no stop seen");
            expect(row.text).not.toMatch(/running/i);
          }
        });
      }
  it("a start time that cannot be read is unknown, never running", () => {
    expect(agentRow(F.agent({ started_at: "soon" }), true, NOW, "acme-labs/widgets").state).toBe("unknown");
    expect(agentRow(F.agent({ state: "banana" }), true, NOW, "acme-labs/widgets").state).toBe("unknown");
  });
  it("a stale engine heartbeat turns every running agent in the rendered panel into unknown, with its data kept", async () => {
    const { t } = team({}, { ["GET " + panelUrl("agents", REPO_A)]: F.envelope([F.agent()], { heard_age_s: 181 }) });
    await t.load();
    const v = t.view();
    expect(v.agents.rows.map((r) => r.state)).toEqual(["unknown"]);
    expect(v.agents.warn).toBe("last seen 3 min ago");
  });
  it("the bridge session counts too: the repo list saying stale makes a freshly heard panel not live", async () => {
    const { t } = team({}, { ["GET " + REPOS_URL]: F.list([F.repo({ liveness: "stale" })]) });
    await t.load();
    expect(t.view().agents.rows[0].state).toBe("unknown");
  });
  it("a live session with a fresh heartbeat shows the agent as running with its D# link and mode", async () => {
    const { t } = team();
    await t.load();
    const row = t.view().agents.rows[0];
    expect(row).toMatchObject({ state: "running", role: "executor", discussion: 42, mode: "foreground", link: "https://github.com/acme-labs/widgets/discussions/42" });
    expect(row.text).toBe("since " + hm(F.iso(600)));
  });
});

describe("data age and liveness (L2)", () => {
  it("every panel header reads as of HH:MM (N min ago)", () => {
    const env = readEnvelope(F.envelope([], { as_of: F.iso(7 * 60 + 5) }));
    expect(asOfWords(env, NOW)).toBe("as of " + hm(F.iso(7 * 60 + 5)) + " (7 min ago)");
    expect(asOfWords(null, NOW)).toBe(WORDS.noData);
  });
  it("stale means: not live, no heartbeat age, or more than 180 s", () => {
    const repo = readRepos(F.list([F.repo()]))[0];
    expect(isStale(repo, readEnvelope(F.envelope([], { heard_age_s: 180 })))).toBe(false);
    expect(isStale(repo, readEnvelope(F.envelope([], { heard_age_s: 181 })))).toBe(true);
    expect(isStale(repo, readEnvelope(F.envelope([], { heard_age_s: null })))).toBe(true);
    expect(isStale({ ...repo, liveness: "never" }, readEnvelope(F.envelope([])))).toBe(true);
    expect(isStale(repo, null)).toBe(true);
  });
  it("a stale panel keeps its rows and adds last seen N min ago; a never-heard one says so", async () => {
    const { t } = team({}, { ["GET " + panelUrl("lanes", REPO_A)]: F.envelope([F.lane()], { heard_age_s: 600 }), ["GET " + panelUrl("agents", REPO_A)]: F.envelope([], { heard_age_s: null }) });
    await t.load();
    const v = t.view();
    expect(v.lanes.warn).toBe("last seen 10 min ago");
    expect(v.lanes.open).toHaveLength(1);
    expect(v.agents.warn).toBe("last seen: never");
  });
  it("the liveness chip for each state", () => {
    const r = (o) => readRepos(F.list([F.repo(o)]))[0];
    expect(chipOf(r({ liveness: "live" }))).toBe("Live");
    expect(chipOf(r({ liveness: "stale", last_heard_at: F.iso(900) }))).toBe("Stale since " + hm(F.iso(900)));
    expect(chipOf(r({ liveness: "runner_removed" }))).toBe("Runner removed");
    expect(chipOf(r({ liveness: "never" }))).toBe("Never connected");
    expect(chipOf(r({ liveness: "something else" }))).toBe("Unknown");
  });
  const envWith = (src, age) => readEnvelope(F.envelope([], { source_ages_s: { [src]: age } }));
  const open = readEnvelope(F.envelope([F.lane({ state: "queued" })]));
  for (const [src, name] of [["loop", "loop"], ["team_log", "team log"], ["plan", "plan"], ["merge_queue", "merge queue"]]) {
    it(`${src}: shown over its limit as "<source> not updated for N h", not at the limit`, () => {
      const limit = SOURCE_LIMIT_S[src];
      expect(sourceNotices([envWith(src, limit)], open)).toEqual([]);
      expect(sourceNotices([envWith(src, limit + 1)], open)).toEqual([name + " not updated for " + Math.floor((limit + 1) / 3600) + " h"]);
      expect(sourceNotices([envWith(src, 5 * limit)], open)).toEqual([name + " not updated for " + Math.floor((5 * limit) / 3600) + " h"]);
    });
  }
  it("the limits are loop 1 h, team log 2 h, plan 26 h, merge queue 6 h", () => {
    expect(SOURCE_LIMIT_S).toEqual({ loop: 3600, team_log: 7200, plan: 26 * 3600, merge_queue: 6 * 3600 });
  });
  it("the merge-queue limit only counts while a pull request in the lane is not final", () => {
    const old = envWith("merge_queue", 20 * 3600);
    for (const state of ["merged", "failed", "dequeued", "refused"]) expect(sourceNotices([old], readEnvelope(F.envelope([F.lane({ state })])))).toEqual([]);
    expect(sourceNotices([old], readEnvelope(F.envelope([])))).toEqual([]);
    for (const state of ["queued", "testing"]) expect(sourceNotices([old], readEnvelope(F.envelope([F.lane({ state })])))).toHaveLength(1);
    expect(sourceNotices([envWith("loop", 9 * 3600)], readEnvelope(F.envelope([])))).toEqual(["loop not updated for 9 h"]); // other sources are not excused by an empty lane
  });
});

describe("gaps (L1)", () => {
  it("a gap puts the banner on the app, with the earliest gap's time and the count", () => {
    const env = readEnvelope(F.envelope([], { missing_events: 12, gaps: [{ from_seq: 5, to_seq: 9, before_ts: F.iso(1800) }, { from_seq: 20, to_seq: 26, before_ts: F.iso(600) }] }));
    expect(gapBanner([env])).toBe("Events missing since " + hm(F.iso(1800)) + " (12 events)");
    expect(gapBanner([readEnvelope(F.envelope([], { missing_events: 1, gaps: [{ from_seq: 5, to_seq: 5, before_ts: F.iso(60) }] }))])).toBe("Events missing since " + hm(F.iso(60)) + " (1 event)");
  });
  it("no gap, no banner; the worst panel decides", () => {
    expect(gapBanner([readEnvelope(F.envelope([])), null])).toBe("");
    const small = readEnvelope(F.envelope([], { missing_events: 2, gaps: [{ from_seq: 1, to_seq: 2, before_ts: F.iso(100) }] }));
    const big = readEnvelope(F.envelope([], { missing_events: 9, gaps: [{ from_seq: 3, to_seq: 11, before_ts: F.iso(200) }] }));
    expect(gapBanner([small, big])).toContain("(9 events)");
  });
  it("a reply without the gap fields is a failed read, never a quiet 'no gaps'", () => {
    for (const drop of ["gaps", "missing_events", "items"]) {
      const raw = F.envelope([]);
      delete raw[drop];
      expect(readEnvelope(raw)).toBeNull();
    }
    expect(readEnvelope(F.envelope([], { missing_events: -1 }))).toBeNull();
    expect(readEnvelope("nope")).toBeNull();
  });
  it("the banner has no dismiss: the description carries no control and no state for one", async () => {
    const { t } = team({}, { ["GET " + panelUrl("lanes", REPO_A)]: F.envelope([], { missing_events: 3, gaps: [{ from_seq: 1, to_seq: 3, before_ts: F.iso(100) }] }) });
    await t.load();
    expect(t.view().banner).toMatch(/^Events missing since \d\d:\d\d \(3 events\)$/);
    expect(Object.keys(t)).not.toContain("dismiss");
  });
});

describe("lanes", () => {
  it("groups gates by PR, and moves a PR that merged today to Merged today", () => {
    const lanes = readEnvelope(F.envelope([F.lane({ pr: 9, state: "queued" }), F.lane({ pr: 7, state: "merged" }), F.lane({ pr: 3, state: "merged", updated_at: F.iso(3 * 86400) })]));
    const gates = readEnvelope(F.envelope([F.gate({ pr: 9, gate: "gate1", result: "pass" }), F.gate({ pr: 9, gate: "code_review", result: "fail" }), F.gate({ pr: 7, gate: "ci_full", result: "skipped" })]));
    const rows = laneRows(lanes, gates, NOW, "acme-labs/widgets");
    expect(rows.open.map((r) => r.pr)).toEqual([9]);
    expect(rows.open[0].gates).toEqual([{ gate: "Gate 1", result: "pass" }, { gate: "Code review", result: "fail" }]);
    expect(rows.merged.map((r) => r.pr)).toEqual([7]); // PR 3 merged on an earlier day
    expect(rows.merged[0].gates).toEqual([{ gate: "CI full", result: "skipped" }]);
    expect(rows.open[0]).toMatchObject({ state: "Queued", prLink: "https://github.com/acme-labs/widgets/pull/9", discussionLink: "https://github.com/acme-labs/widgets/discussions/42" });
  });
  it("a state or gate it does not know reads as a plain word, not the raw string", () => {
    const rows = laneRows(readEnvelope(F.envelope([F.lane({ state: HOSTILE })])), readEnvelope(F.envelope([F.gate({ gate: HOSTILE, result: HOSTILE })])), NOW, "acme-labs/widgets");
    expect(texts(rows)).not.toContain("onerror");
    expect(rows.open[0].state).toBe("Unknown");
    expect(rows.open[0].gates).toEqual([{ gate: "Other gate", result: "unknown" }]);
  });
  it("links are built only from a usable repo name and a positive number", () => {
    expect(githubLink("a/b", "pull", 3)).toBe("https://github.com/a/b/pull/3");
    for (const [n, k, i] of [["a b/c", "pull", 3], ["../x", "pull", 3], ["a/b", "pull", 0], ["a/b", "tree", 3], ["a/b", "pull", "3"], [HOSTILE, "pull", 3]]) expect(githubLink(n, k, i)).toBeNull();
  });
});

describe("settings", () => {
  it("shows a refused repo greyed with its reason, and a member read-only", async () => {
    const { t } = team({}, { ["GET " + SETTINGS_URL]: F.settings({ can_edit: false }) });
    await t.load();
    const sheet = t.view().sheet;
    expect(sheet.readOnly).toBe(WORDS.readOnly);
    expect(sheet.repos).toEqual([{ id: REPO_A, name: "acme-labs/widgets", checked: true, refused: false, reason: "" }, { id: REPO_B, name: "acme-labs/site", checked: false, refused: true, reason: "Public repository" }]);
    const own = F.settings({ repos: [F.settingsRepo({ enabled: false, eligible: false, refusal: "repo_not_runner_local" }), F.settingsRepo({ repo_id: REPO_B, full_name: "x/y", enabled: false, eligible: false, refusal: "mystery" })] });
    const later = team({}, { ["GET " + SETTINGS_URL]: own });
    await later.t.load();
    expect(describeState(later.t.state, NOW).sheet.repos.map((r) => r.reason)).toEqual(["Not on one of your runners", WORDS.refusalOther]);
  });
  it("the watch switch writes only watch_enabled, then reads the settings again", async () => {
    const { t, f } = team();
    await t.load();
    f.log.length = 0;
    await t.setWatch(false);
    expect(f.log[0]).toEqual(["PUT", SETTINGS_URL, { watch_enabled: false }]);
    expect(f.log.slice(1).map(([m, p]) => m + " " + p)[0]).toBe("GET " + SETTINGS_URL);
    expect(t.state.notice).toBe(WORDS.saved);
  });
  it("a repo box writes the whole list of ticked repos, with the ids as the settings gave them", async () => {
    const { t, f } = team();
    await t.load();
    await t.setRepo(REPO_B, true);
    expect(f.log.find(([m]) => m === "PUT")[2]).toEqual({ repo_ids: [REPO_A, REPO_B] });
    await t.setRepo(REPO_A, false);
    expect(f.log.filter(([m]) => m === "PUT")[1][2]).toEqual({ repo_ids: [] });
  });
  it("a refused write says why in the app's own words and changes nothing else", async () => {
    for (const [e, sentence] of [[fail(403, "forbidden"), WORDS.forbidden], [fail(409, "public_repo"), WORDS.sendRefusals.public_repo], [fail(409, "repo_not_runner_local"), WORDS.sendRefusals.repo_not_runner_local], [fail(500, "server_error"), WORDS.saveFailed], [fail(409, "other"), WORDS.saveFailed]]) {
      const { t, f } = team({}, { ["PUT " + SETTINGS_URL]: e });
      await t.load();
      f.log.length = 0;
      await t.setWatch(false);
      expect(t.state.notice).toBe(sentence);
      expect(t.state.saving).toBe(false);
      expect(f.log).toHaveLength(1); // no refresh after a refusal
    }
    expect(failureSentence(Object.assign(new Error("x"), { status: 429, retryAfter: 8 }))).toBe("Try again in 8 seconds.");
  });
  it("a 403 on the delete route says the account owner, not owner or admin", async () => {
    const { t } = team({}, { ["PUT " + DELETE_URL]: fail(403, "forbidden") });
    await t.load();
    await t.deleteData();
    expect(t.state.notice).toBe("Only the account owner can delete engine data.");
    expect(failureSentence(fail(403, "forbidden"))).toBe(WORDS.forbidden);
  });
  it("the view is drawn at the time the helper is given", async () => {
    const { t } = team({ now: NOW + 3 * 3600 * 1000 + 60000 });
    await t.load();
    expect(t.view().agents.rows[0].state).toBe("unknown"); // the fixture agent started minutes before NOW, so three hours on it has no stop seen
  });
  it("one write at a time: a second press while one is out sends nothing", async () => {
    let release;
    const { t, f } = team({}, { ["PUT " + SETTINGS_URL]: () => new Promise((r) => { release = r; }) });
    await t.load();
    const first = t.setWatch(false);
    await t.setWatch(true);
    release({ ok: true });
    await first;
    expect(f.log.filter(([m]) => m === "PUT")).toHaveLength(1);
  });
  it("deleting data asks first, then sends one PUT to the delete route", async () => {
    const { t, f } = team();
    await t.load();
    t.askDelete();
    expect(t.view().sheet.confirmDelete).toBe(true);
    t.cancelDelete();
    expect(f.log.some(([, p]) => p === DELETE_URL)).toBe(false);
    t.askDelete();
    await t.deleteData();
    expect(f.log.filter(([, p]) => p === DELETE_URL)).toEqual([["PUT", DELETE_URL, undefined]]);
    expect(t.state.notice).toBe(WORDS.deleted);
    expect(t.state.confirmDelete).toBe(false);
  });
});

describe("refresh", () => {
  it("engine.changed for the open repo refetches every panel once, 1 s after the last event in a burst", async () => {
    const { t, f, clk } = team();
    await t.load();
    let on;
    t.start({ subscribe: () => () => {}, listen: (type, fn) => { if (type === "engine.changed") on = fn; return () => {}; } });
    f.log.length = 0;
    const dto = { type: "engine.changed", data: { repo_id: REPO_A, session_id: "s", last_seq: 5 } };
    on(dto); on(dto); on(dto);
    expect(f.log).toHaveLength(0);
    clk.fire((x) => x.ms === DEBOUNCE_MS);
    await flush(); await flush();
    expect(f.log.map(([, p]) => p).filter((p) => p.includes(REPO_A + "/"))).toEqual([panelUrl("agents", REPO_A), panelUrl("lanes", REPO_A), panelUrl("gates", REPO_A)]);
    expect(DEBOUNCE_MS).toBe(1000);
  });
  it("an event for another repo reads nothing", async () => {
    const { t, f, clk } = team();
    await t.load();
    let on;
    t.start({ listen: (type, fn) => { on = fn; return () => {}; } });
    f.log.length = 0;
    on({ type: "engine.changed", data: { repo_id: REPO_B, session_id: "s", last_seq: 1 } });
    expect(clk.count()).toBe(1); // only the 15 s repeat
    expect(f.log).toHaveLength(0);
  });
  it("without a live stream it still reads every 15 s, not while the page is hidden, and stop() leaves no timer", async () => {
    let hidden = true;
    const { t, f, clk } = team();
    await t.load();
    t.start({ hidden: () => hidden });
    f.log.length = 0;
    clk.fire((x) => x.ms === REFRESH_MS);
    await flush();
    expect(f.log).toHaveLength(0);
    hidden = false;
    clk.fire((x) => x.ms === REFRESH_MS);
    await flush(); await flush();
    expect(f.log.length).toBeGreaterThanOrEqual(5);
    expect(REFRESH_MS).toBe(15000);
    t.stop();
    expect(clk.count()).toBe(0);
  });
  it("a read that fails keeps the last data on screen and says so; it never becomes an empty list", async () => {
    let n = 0;
    const { t } = team({}, { ["GET " + panelUrl("lanes", REPO_A)]: () => (++n === 1 ? F.envelope([F.lane()]) : fail(500, "server_error")) });
    await t.load();
    await t.refresh();
    const v = t.view();
    expect(v.lanes.open).toHaveLength(1);
    expect(v.refreshFailed).toBe(WORDS.refreshFailed);
  });
  it("a first read that fails shows the panel as unreadable, not as empty", async () => {
    const { t } = team({}, { ["GET " + panelUrl("lanes", REPO_A)]: fail(500, "server_error") });
    await t.load();
    expect(t.view().lanes).toMatchObject({ failed: true, open: [], asOf: WORDS.noData });
  });
  it("a settings reply of the wrong shape is an error screen, and an aborted read is silent", async () => {
    const bad1 = team({}, { ["GET " + SETTINGS_URL]: { watch_enabled: "yes" } });
    await bad1.t.load();
    expect(describeState(bad1.t.state, NOW)).toEqual({ kind: "error", text: WORDS.error });
    const ac = new AbortController();
    const quiet = team({ signal: ac.signal }, { ["GET " + SETTINGS_URL]: () => { ac.abort(); return fail(0, "x"); } });
    await quiet.t.load();
    expect(quiet.t.state.status).toBe("loading");
  });
  it("choosing another repo clears its panels and reads the new repo; a late answer for the old one is dropped", async () => {
    let release;
    const { t } = team({}, { ["GET " + panelUrl("agents", REPO_A)]: () => new Promise((r) => { release = r; }) });
    const first = t.load();
    await flush(); await flush();
    t.select(REPO_B);
    release(F.envelope([F.agent()]));
    await first;
    await flush(); await flush();
    expect(t.state.selectedId).toBe(REPO_B);
    expect(t.view().agents.rows).toEqual([]);
  });
});

describe("what a screen may show", () => {
  it("empty states", async () => {
    const { t } = team({}, { ["GET " + panelUrl("agents", REPO_A)]: F.envelope([]), ["GET " + panelUrl("lanes", REPO_A)]: F.envelope([]) });
    await t.load();
    const v = t.view();
    expect([v.agents.empty, v.lanes.empty]).toEqual(["No agents running", "No pull requests in the merge lane"]);
    expect(WORDS.watchOff).toBe("Engine watch is off");
  });
  it("no state, hostile or odd, puts null, undefined or NaN in a string a screen shows", async () => {
    const states = {
      ready: {},
      off: { ["GET " + SETTINGS_URL]: F.settings({ watch_enabled: false }) },
      readOnly: { ["GET " + SETTINGS_URL]: F.settings({ can_edit: false }) },
      noRepos: { ["GET " + REPOS_URL]: F.list([]) },
      stale: { ["GET " + REPOS_URL]: F.list([F.repo({ liveness: "stale", last_heard_at: null })]) },
      removed: { ["GET " + REPOS_URL]: F.list([F.repo({ liveness: "runner_removed", runner_name: null })]) },
      never: { ["GET " + REPOS_URL]: F.list([F.repo({ liveness: "never", last_heard_at: null, last_event_at: null, session_id: null })]) },
      hostile: { ["GET " + REPOS_URL]: F.list([F.repo({ full_name: HOSTILE.replace(/[/ ]/g, "-"), runner_name: HOSTILE })]), ["GET " + panelUrl("agents", REPO_A)]: F.envelope([F.agent({ role: HOSTILE, agent_id: HOSTILE, discussion: null, started_at: null })]) },
      sparse: { ["GET " + panelUrl("agents", REPO_A)]: F.envelope([{}]), ["GET " + panelUrl("lanes", REPO_A)]: F.envelope([{}, { pr: 4 }, { pr: 5, state: "merged" }]), ["GET " + panelUrl("gates", REPO_A)]: F.envelope([{}, { pr: 4 }]) },
      noAge: { ["GET " + panelUrl("agents", REPO_A)]: F.envelope([F.agent()], { as_of: null, heard_age_s: null, source_ages_s: null }) },
      gap: { ["GET " + panelUrl("agents", REPO_A)]: F.envelope([F.agent()], { missing_events: 4, gaps: [{ from_seq: 1, to_seq: 4, before_ts: "bad" }] }) },
      sources: { ["GET " + panelUrl("agents", REPO_A)]: F.envelope([F.agent()], { source_ages_s: { loop: 99999, team_log: 99999, plan: 99999, merge_queue: 99999 } }) },
      failed: { ["GET " + panelUrl("lanes", REPO_A)]: fail(500, "server_error"), ["GET " + panelUrl("agents", REPO_A)]: { weird: true } },
    };
    for (const [name, routes] of Object.entries(states)) {
      const { t } = team({}, routes);
      await t.load();
      // Every string a screen shows. (A link or an empty part may be null in the view: the page leaves it out and never prints it.)
      for (const text of strings(t.view())) expect(text, name).not.toMatch(bad);
    }
    for (const text of strings(describeState({ status: "loading" }, NOW))) expect(text).not.toMatch(bad);
  });
  it("the model does no cost or statistics maths", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "team");
    for (const file of ["team-model.js", "team-app.js", "team-api.js"]) {
      const src = readFileSync(join(dir, file), "utf8").replace(/\/\/.*$/gm, "");
      expect(src, file).not.toMatch(/\b(usd|cost|price|spend|median|percentile|average|mean|sum|total|rate)\b/i);
      expect(src, file).not.toMatch(/\.reduce\(|toFixed|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/);
    }
  });
});

describe("readers", () => {
  it("the repo list accepts the documented {items} list or a bare array, and nothing else", () => {
    expect(readRepos(F.list([F.repo()]))).toHaveLength(1);
    expect(readRepos([F.repo()])).toHaveLength(1);
    expect(readRepos({ repos: [] })).toBeNull();
    expect(readRepos(F.list([{ full_name: "a/b" }, F.repo({ full_name: "" })]))).toEqual([]);
  });
  it("settings need booleans and a repo list", () => {
    expect(readSettings(F.settings())).toMatchObject({ watch: true, canEdit: true });
    for (const raw of [null, {}, { ...F.settings(), can_edit: 1 }, { ...F.settings(), repos: "x" }]) expect(readSettings(raw)).toBeNull();
  });
});
