// apps/workspace/test/team.test.mjs
//
// The Team app's logic (team-model.js) against a fake client. The page, with the real DOM, axe, the layouts and the production CSP,
// is driven on the built output in e2e/team.spec.ts. Pinned here: the exact requests, the agent-state table (L3), the data age and gap rules
// (L1, L2), the per-source limits, the refetch-everything-on-engine.changed rule, and that nothing a screen shows is null, undefined or NaN.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DELETE_URL, LOG_LIMIT, REPOS_URL, SETTINGS_URL, clearHaltUrl, commandUrl, commandsUrl, createTeamApi, dialUrl, dialsUrl, haltUrl, lanesUrl, logUrl, panelUrl } from "../apps/team/team-model.js";
import { DIAL_CLASSES, ENGINE_DIALS, HALT_WORDS, OP_WORDS, REFUSALS, ROLES, TTL, agentWords, cancelFailure, commandRow, dialFailure, haltFailure, lockReason, readCommands, readDials, sendFailure } from "../apps/team/team-operate.js";
import { DEBOUNCE_MS, LANE_PAGES, LOG_WINDOW, ROADMAP_PAGE, SAFETY_MS, SOURCE_LIMIT_S, WORDS, agentRow, asOfWords, chipOf, createTeam, describe as describeState, failureSentence, gapBanner, githubLink, hm, isStale, laneRows, logRow, planView, readEnvelope, readPlan, readRepos, readSettings, readStats, readUsage, sourceNotices, statsView, usageView } from "../apps/team/team-model.js";
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
    ["GET " + panelUrl("log", REPO_A)]: F.envelope([F.logLine()]),
    ["GET " + panelUrl("plan", REPO_A)]: F.plan(),
    ["GET " + panelUrl("stats", REPO_A)]: F.stats(),
    ["GET " + panelUrl("usage", REPO_A)]: F.usage(),
    ["GET " + panelUrl("agents", REPO_B)]: F.envelope([]),
    ["GET " + panelUrl("lanes", REPO_B)]: F.envelope([]),
    ["GET " + panelUrl("gates", REPO_B)]: F.envelope([]),
    ["GET " + commandsUrl(REPO_A) + "?limit=50"]: F.commands([]),
    ["GET " + commandsUrl(REPO_B) + "?limit=50"]: F.commands([]),
    ["GET " + dialsUrl(REPO_A)]: F.dials(),
    ["GET " + dialsUrl(REPO_B)]: F.dials(),
    ["GET " + panelUrl("log", REPO_B)]: F.envelope([]),
    ["GET " + panelUrl("plan", REPO_B)]: null, // 204: no snapshot
    ["GET " + panelUrl("stats", REPO_B)]: F.stats(),
    ["GET " + panelUrl("usage", REPO_B)]: F.usage(),
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
  let id = 0, time = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTime: (ms) => { time = ms; },
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms, repeat: false }); return id; },
    clearTimer: (i) => timers.delete(i),
    setRepeat: (fn, ms) => { timers.set(++id, { fn, ms, repeat: true }); return id; },
    clearRepeat: (i) => timers.delete(i),
    fire: (pred) => { for (const [i, t] of [...timers]) if (pred(t)) { if (!t.repeat) timers.delete(i); t.fn(); } },
    count: () => timers.size,
  };
}
/** `now` is the moment the view is drawn at: t.view() is describe() of the current state at that time (the controller itself keeps no clock). */
function team({ now = NOW, clockNow, ...over } = {}, routes = {}) {
  const f = fakeCall(routes);
  const clk = clock();
  const t = createTeam({ client: createTeamApi(f.call), ...clk, ...(clockNow ? { now: clockNow } : {}), ...over });
  t.view = () => describeState(t.state, now);
  return { t, f, clk };
}
const texts = (v) => JSON.stringify(v);
/** Every string a view holds, however deep. */
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
const bad = /\bnull\b|undefined|NaN|Invalid Date/;

describe("requests", () => {
  it("reads the settings, the repos, then the seven panels of the first repo, at exactly these paths", async () => {
    const { t, f } = team();
    await t.load();
    expect(f.log.map(([m, p]) => m + " " + p)).toEqual([
      "GET /api/v1/engine/settings",
      "GET /api/v1/engine/repos",
      `GET /api/v1/engine/repos/${REPO_A}/commands?limit=50`, // an owner or admin also reads the command list and the dials
      `GET /api/v1/repos/${REPO_A}/decision-settings`,
      `GET /api/v1/engine/repos/${REPO_A}/agents?state=running`,
      `GET /api/v1/engine/repos/${REPO_A}/lanes`,
      `GET /api/v1/engine/repos/${REPO_A}/gates`,
      `GET /api/v1/engine/repos/${REPO_A}/log?limit=100`,
      `GET /api/v1/engine/repos/${REPO_A}/plan`,
      `GET /api/v1/engine/repos/${REPO_A}/stats`,
      `GET /api/v1/engine/repos/${REPO_A}/usage`,
    ]);
    expect(LOG_LIMIT).toBe(100);
    expect(f.log.some(([, p]) => p.includes("pr="))).toBe(false); // gates are read without a pr; the client groups by PR
  });
  it("reads no repo and no panel while watch is off", async () => {
    const { t, f } = team({}, { ["GET " + SETTINGS_URL]: F.settings({ watch_enabled: false }) });
    await t.load();
    expect(f.log.map(([m, p]) => m + " " + p)).toEqual(["GET " + SETTINGS_URL, "GET /api/runners"]); // the off screen names the runner, so it reads them; nothing else
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
    const { t } = team({}, { ["GET " + panelUrl("agents", REPO_A)]: F.envelope([F.agent()], { heard_age_s: 451 }) });
    await t.load();
    const v = t.view();
    expect(v.agents.rows.map((r) => r.state)).toEqual(["unknown"]);
    expect(v.agents.warn).toBe("last seen 7 min ago");
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
  it("stale means: not live, no heartbeat age, or more than 450 s (1.5 times the bridge's 300 s status interval)", () => {
    const repo = readRepos(F.list([F.repo()]))[0];
    expect(isStale(repo, readEnvelope(F.envelope([], { heard_age_s: 299 })))).toBe(false); // an idle bridge's status is up to 300 s apart
    expect(isStale(repo, readEnvelope(F.envelope([], { heard_age_s: 450 })))).toBe(false);
    expect(isStale(repo, readEnvelope(F.envelope([], { heard_age_s: 451 })))).toBe(true);
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

describe("a save and a refresh at the same time", () => {
  /** A server that remembers the watch switch. A held read answers with what the server said when the read began. */
  function server() {
    const s = { watch: true, operate: false, hold: null, release: null, failPut: null };
    const routes = {
      ["GET " + SETTINGS_URL]: () => { const snap = F.settings({ watch_enabled: s.watch, operate_enabled: s.operate, ...(s.ids ? { repos: [F.settingsRepo({ enabled: s.ids.includes(REPO_A) }), F.settingsRepo({ repo_id: REPO_B, full_name: "acme-labs/site", enabled: false, eligible: false, refusal: "public_repo" })] } : {}), ...(s.other ? { repos: [F.settingsRepo(), F.settingsRepo({ repo_id: REPO_B, full_name: "acme-labs/site", enabled: true, eligible: true })] } : {}) }); return s.hold ? s.hold.then(() => snap) : snap; },
      ["PUT " + SETTINGS_URL]: (body) => {
        if (s.failPut) return s.failPut;
        const apply = () => { if ("watch_enabled" in body) s.watch = body.watch_enabled; if ("operate_enabled" in body) s.operate = body.operate_enabled; if ("repo_ids" in body) s.ids = body.repo_ids; };
        if (!s.release) { apply(); return { ok: true }; }
        return new Promise((r) => { s.release.fn = () => { apply(); r({ ok: true }); }; });
      },
    };
    return { s, routes };
  }
  /** The controller with a record of the settings it held at every change. */
  function tracked(routes) {
    const f = fakeCall(routes);
    const hist = [], ops = [];
    const t = createTeam({ client: createTeamApi(f.call), ...clock(), onChange: () => { hist.push(t.state.settings ? t.state.settings.watch : null); ops.push(t.state.settings ? t.state.settings.operate : null); } });
    t.view = () => describeState(t.state, NOW);
    return { t, f, hist, ops };
  }

  it("a refresh that lands while a save is out does not undo the click, and the server's answer shows once the save is done", async () => {
    const { s, routes } = server();
    s.release = {};
    const { t } = team({}, routes);
    await t.load();
    const save = t.setWatch(false);
    expect(t.view().sheet.watch).toBe(false);
    s.other = true; // the server now also has the second repo ticked
    await t.refresh();
    expect(t.view().sheet.watch).toBe(false);
    expect(t.state.saving).toBe(true);
    expect(t.state.settings.repos.find((r) => r.id === REPO_B).enabled).toBe(false); // that answer was dropped
    s.release.fn();
    await save;
    expect(t.view().sheet.watch).toBe(false);
    expect(t.state.settings.repos.find((r) => r.id === REPO_B).enabled).toBe(true); // the read after the save
  });
  it("a refresh begun before the save and landing after it is dropped", async () => {
    const { s, routes } = server();
    const { t, hist } = tracked(routes);
    await t.load();
    let release;
    s.hold = new Promise((r) => { release = r; });
    const old = t.refresh(); // asks while the server still says true
    await flush();
    const save = t.setWatch(false); // saved and answered while that read is out
    await flush(); await flush();
    s.hold = null;
    expect(t.view().sheet.watch).toBe(false);
    release(); // the old read lands now, with watch: true
    await old; await save; await flush(); await flush();
    expect(hist.includes(false)).toBe(true);
    expect(hist.slice(hist.indexOf(false)).includes(true)).toBe(false); // once the save is in, the old answer never shows
    expect(t.state.settings.watch).toBe(false);
    expect(t.state.saving).toBe(false);
  });
  it("a repo box keeps the person's choice while its save is out and a refresh lands, then shows the server's answer", async () => {
    const { s, routes } = server();
    s.release = {};
    const { t } = team({}, routes);
    await t.load();
    const box = () => t.view().sheet.repos.find((r) => r.id === REPO_A).checked;
    expect(box()).toBe(true);
    const save = t.setRepo(REPO_A, false);
    expect(box()).toBe(false);
    await t.refresh(); // the server still says ticked
    expect(box()).toBe(false);
    expect(t.state.settings.repos.find((r) => r.id === REPO_A).enabled).toBe(true); // that answer was dropped
    s.release.fn();
    await save;
    expect(box()).toBe(false);
  });
  it("the operate switch keeps the person's choice while its save is out and a refresh lands", async () => {
    const { s, routes } = server();
    s.release = {};
    const { t } = team({}, routes);
    await t.load();
    expect(t.view().operate.sw.on).toBe(false);
    const save = t.operate.setOperate(true);
    expect(t.view().operate.sw.on).toBe(true);
    s.other = true; // a different answer, to see whether it is kept
    await t.refresh(); // the server still says operate is off
    expect(t.view().operate.sw.on).toBe(true);
    expect(t.state.settings.repos.find((r) => r.id === REPO_B).enabled).toBe(false); // that answer was dropped
    s.release.fn();
    await save;
    expect(t.view().operate.sw.on).toBe(true);
    expect(t.state.settings.repos.find((r) => r.id === REPO_B).enabled).toBe(true); // the read after the save
  });
  it("an operate read begun before the save and landing after it is dropped", async () => {
    const { s, routes } = server();
    const { t, ops } = tracked(routes);
    await t.load();
    let release;
    s.hold = new Promise((r) => { release = r; });
    const old = t.refresh(); // asks while the server says operate is off
    await flush();
    const save = t.operate.setOperate(true);
    await flush(); await flush();
    s.hold = null;
    release(); // the old read lands with operate: false
    await old; await save; await flush(); await flush();
    expect(ops.includes(true)).toBe(true);
    expect(ops.slice(ops.indexOf(true)).includes(false)).toBe(false);
    expect(t.state.settings.operate).toBe(true);
  });
  it("a failed operate save puts the switch back", async () => {
    const { s, routes } = server();
    s.failPut = fail(500, "server_error");
    const { t } = team({}, routes);
    await t.load();
    await t.operate.setOperate(true);
    expect(t.view().operate.sw.on).toBe(false);
    expect(t.state.draft).toBe(null);
  });
  it("a failed save puts the last server value back and says so once", async () => {
    const { s, routes } = server();
    s.failPut = fail(500, "server_error");
    const notices = [];
    const f = fakeCall(routes);
    const t = createTeam({ client: createTeamApi(f.call), ...clock(), onChange: () => notices.push(t.state.notice) });
    await t.load();
    const save = t.setWatch(false);
    expect(describeState(t.state, NOW).sheet.watch).toBe(false); // shown while the save is out
    await save;
    await t.refresh();
    expect(describeState(t.state, NOW).sheet.watch).toBe(true);
    expect(t.state.notice).toBe(failureSentence(fail(500, "server_error")));
    expect(notices.filter((n, i) => n !== "" && n !== notices[i - 1])).toHaveLength(1);
  });
  it("a refresh that finds the same settings keeps the same objects, so nothing that shows them is redrawn", async () => {
    const { t } = team();
    await t.load();
    const [settings, repos] = [t.state.settings, t.state.repos];
    const sheet = JSON.stringify(t.view().sheet);
    await t.refresh();
    expect(t.state.settings).toBe(settings);
    expect(t.state.repos).toBe(repos);
    expect(JSON.stringify(t.view().sheet)).toBe(sheet);
  });
});

describe("a hidden tab", () => {
  it("reads nothing on the timer, on engine.changed or on a live-stream nudge, and reads once when shown again", async () => {
    let hidden = true, shown, nudge, on;
    const { t, f, clk } = team();
    await t.load();
    t.start({ hidden: () => hidden, subscribe: (fn) => { nudge = fn; return () => {}; }, listen: (type, fn) => { on = fn; return () => {}; }, visibility: (fn) => { shown = fn; return () => {}; } });
    f.log.length = 0;
    clk.setTime(60000);
    clk.fire((x) => x.ms === SAFETY_MS);
    on({ type: "engine.changed", data: { repo_id: REPO_A, session_id: "s", last_seq: 3 } });
    clk.fire((x) => x.ms === DEBOUNCE_MS);
    nudge();
    clk.fire(() => true);
    await flush(); await flush();
    expect(f.log).toHaveLength(0);
    hidden = false;
    shown();
    await flush(); await flush(); await flush();
    expect(f.log.filter(([, p]) => p === SETTINGS_URL)).toHaveLength(1);
    expect(SAFETY_MS).toBe(120000);
  });
});

describe("refresh", () => {
  it("engine.changed with no panels named refetches every panel once, 1 s after it arrives, however many notices come in a burst", async () => {
    const { t, f, clk } = team();
    await t.load();
    clk.setTime(60000); // long after the first read, so the 10 s gate is open
    let on;
    t.start({ subscribe: () => () => {}, listen: (type, fn) => { if (type === "engine.changed") on = fn; return () => {}; } });
    f.log.length = 0;
    const dto = { type: "engine.changed", data: { repo_id: REPO_A, session_id: "s", last_seq: 5 } };
    on(dto); on(dto); on(dto);
    expect(f.log).toHaveLength(0);
    clk.setTime(61000);
    clk.fire((x) => x.ms === DEBOUNCE_MS);
    await flush(); await flush();
    expect(f.log.map(([, p]) => p).filter((p) => p.includes(REPO_A + "/") && !p.includes("/commands") && !p.includes("decision-settings"))).toEqual(["agents", "lanes", "gates", "log", "plan", "stats", "usage"].map((k) => panelUrl(k, REPO_A)));
    expect(f.log.filter(([, p]) => p === SETTINGS_URL || p === REPOS_URL)).toHaveLength(2); // the status too, and the operate half
    expect(DEBOUNCE_MS).toBe(1000);
  });
  it("a notice read while a command is waiting includes the commands and the dials, with no command poll to cover for it; with none waiting it does not", async () => {
    for (const [state, expectOp] of [["pending", true], ["delivered", true], ["applied", false]]) {
      const cmd = F.command({ state, ...(state === "applied" ? { acked_at: F.iso(5) } : {}) });
      const { t, f, clk } = team({}, { ["GET " + commandsUrl(REPO_A) + "?limit=50"]: F.commands([cmd]) });
      await t.load();
      let on;
      t.start({ listen: (type, fn) => { on = fn; return () => {}; } });
      f.log.length = 0;
      clk.setTime(100_000); // past the 10 s gate of the first read
      on({ type: "engine.changed", data: { repo_id: REPO_A, session_id: "s", last_seq: 1, panels: ["lanes"] } });
      clk.setTime(100_000 + DEBOUNCE_MS);
      clk.fire((x) => x.ms === DEBOUNCE_MS); // the settle only: the 10 s command repeat is never fired here
      await flush(); await flush();
      const paths = f.log.map(([, p]) => p);
      expect(paths).toContain(panelUrl("lanes", REPO_A));
      expect(paths.includes(commandsUrl(REPO_A) + "?limit=50")).toBe(expectOp);
      expect(paths.includes(dialsUrl(REPO_A))).toBe(expectOp);
    }
  });
  it("an event for another repo reads nothing", async () => {
    const { t, f, clk } = team();
    await t.load();
    let on;
    t.start({ listen: (type, fn) => { on = fn; return () => {}; } });
    f.log.length = 0;
    on({ type: "engine.changed", data: { repo_id: REPO_B, session_id: "s", last_seq: 1 } });
    expect(clk.count()).toBe(2); // only the safety and the command-read repeats: no notice is waiting
    expect(f.log).toHaveLength(0);
  });
  it("without a live stream it still reads everything 120 s after the last full read, not while the page is hidden, and stop() leaves no timer", async () => {
    let hidden = false, shown = () => {};
    const { t, f, clk } = team();
    await t.load();
    t.start({ hidden: () => hidden, visibility: (fn) => { shown = fn; return () => {}; } });
    f.log.length = 0;
    hidden = true;
    clk.fire((x) => x.ms === SAFETY_MS);
    await flush();
    expect(f.log).toHaveLength(0); // a hidden tab reads nothing and holds no timer
    hidden = false;
    shown(); // showing it reads everything, and that read sets the timer again
    await flush(); await flush();
    expect(f.log.length).toBeGreaterThanOrEqual(8);
    f.log.length = 0;
    clk.fire((x) => x.ms === SAFETY_MS);
    await flush(); await flush();
    expect(f.log.length).toBeGreaterThanOrEqual(8);
    expect(SAFETY_MS).toBe(120000);
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
    expect(v.refreshFailed).toBe(""); // one panel failing is that panel's note, not the view's
  });
  it("one panel failing marks that panel only; the view-wide note stays off", async () => {
    const { t } = team({}, { ["GET " + panelUrl("plan", REPO_A)]: fail(404) }); // a server without the plan route answers 404 with no code
    await t.load();
    const v = t.view();
    expect(v.plan).toMatchObject({ failed: true, none: false, view: null });
    expect(v.agents.failed).toBe(false);
    expect(v.lanes.failed).toBe(false);
    expect(v.refreshFailed).toBe("");
    expect(v.failedKeys).toEqual(["plan"]);
  });
  it("the plan route's 204 (no snapshot yet) is the not-synced state, never a failure", async () => {
    const { t } = team({}, { ["GET " + panelUrl("plan", REPO_A)]: null });
    await t.load();
    expect(t.view().plan).toMatchObject({ failed: false, none: true });
    expect(t.view().refreshFailed).toBe("");
    expect(t.view().failedKeys).toEqual([]);
  });
  it("every panel failing at once, or the core reads failing, turns the view-wide note on", async () => {
    const all = {};
    for (const k of ["agents", "lanes", "gates", "log", "plan", "stats", "usage"]) all["GET " + panelUrl(k, REPO_A)] = fail(500, "server_error");
    const a = team({}, all);
    await a.t.load();
    expect(a.t.view().refreshFailed).toBe(WORDS.refreshFailed);
    // settings failing on a refresh, after a good load
    let n = 0;
    const b = team({}, { ["GET " + SETTINGS_URL]: () => (++n === 1 ? F.settings() : fail(500, "server_error")) });
    await b.t.load();
    expect(b.t.view().refreshFailed).toBe("");
    await b.t.refresh();
    expect(b.t.view().refreshFailed).toBe(WORDS.refreshFailed);
    expect(b.t.view().agents.failed).toBe(false); // the last data stays
    // the repo list failing on a refresh
    let m = 0;
    const c = team({}, { ["GET " + REPOS_URL]: () => (++m === 1 ? F.list([F.repo()]) : fail(500, "server_error")) });
    await c.t.load();
    await c.t.refresh();
    expect(c.t.view().refreshFailed).toBe(WORDS.refreshFailed);
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
      planNone: { ["GET " + panelUrl("plan", REPO_A)]: null },
      planStale: { ["GET " + panelUrl("plan", REPO_A)]: F.plan({ age_s: 30 * 3600, plan_date: "2026-11-14" }) },
      planSparse: { ["GET " + panelUrl("plan", REPO_A)]: F.plan({ plan_date: null, age_s: null, items: [{}, { discussion: 5 }], roadmap: [{}, { row_key: null, discussion: 0 }, { row_key: HOSTILE, status: HOSTILE, planned_prs: "x" }] }) },
      planBroken: { ["GET " + panelUrl("plan", REPO_A)]: { items: [] }, ["GET " + panelUrl("stats", REPO_A)]: { agents_by_role: 1 } },
      logSparse: { ["GET " + panelUrl("log", REPO_A)]: F.envelope([{}, { line_id: 1, ts: "later", category: HOSTILE, actor_role: HOSTILE, pr: "7", discussion: null }]) },
      statsSparse: { ["GET " + panelUrl("stats", REPO_A)]: { gaps: [], missing_events: 0 } },
      statsOdd: { ["GET " + panelUrl("stats", REPO_A)]: F.stats({ agents_by_role: { value: { x: "y" } }, duration_s: { n: 0, median: null, p90: null }, merges: { value: -1 }, gate_pass_rate: { value: null, numerator: 0, denominator: 0, provenance: {} }, window: null }) },
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
    // The only words let through are the server's exact field names (read, never computed) and the labels that name its figures; each must really be in the source,
    // so the list cannot go stale and a computed median or total anywhere else still matches the ban below.
    const READS = ["raw.gate_pass_rate", "median: num(", "dur.median", '"median "', "api_equivalent_usd", "raw.totals", "usd as dollars", "dollars(", '"No API price for this model"', 'usage: "Cost"'];
    // The cost analyst is one of the protocol's spawnable roles, so its name is a role id here and not a figure.
    const src = Object.fromEntries(["team-model.js", "team-app.js", "team-operate.js"].map((f) => [f, readFileSync(join(dir, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/cost-analyst|Cost analyst/g, "")]));
    expect(READS.filter((r) => Object.values(src).some((t) => t.includes(r)))).toEqual(READS);
    for (const [file, text] of Object.entries(src)) {
      const stripped = READS.reduce((t, r) => t.split(r).join(" "), text);
      expect(stripped, file).not.toMatch(/\b(usd|cost|price|spend|median|percentile|average|mean|sum|total|rate)\b/i);
      expect(stripped, file).not.toMatch(/\.reduce\(|toFixed|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/);
    }
  });
});


describe("log (EB-6b)", () => {
  const lines = (n, start) => F.envelope(F.logLines(n, start), { next_cursor: "c" + (start + n) });
  it("shows each line's time, role, kind and D# / PR links, built from the repo's own name", async () => {
    const { t } = team();
    await t.load();
    const v = t.view().log;
    expect(v.rows).toEqual([{ id: "0123456789abcdef", time: hm(F.iso(180)), role: "team-lead", category: "merged", discussion: 42, discussionLink: "https://github.com/acme-labs/widgets/discussions/42", pr: 7, prLink: "https://github.com/acme-labs/widgets/pull/7" }]);
    expect(v.note).toBe("Log text stays on your machine; the cloud receives only what kind of line it was.");
    expect(v.asOf).toMatch(/^as of \d\d:\d\d \(0 min ago\)$/);
  });
  it("a line from an earlier day carries its date; an odd kind reads other, a hostile role stays text", () => {
    expect(logRow(F.logLine({ ts: F.iso(2 * 86400) }), 0, "a/b", NOW).time).toMatch(/^\d\d-\d\d \d\d:\d\d$/);
    const r = logRow(F.logLine({ category: HOSTILE, actor_role: HOSTILE, discussion: null, pr: null, line_id: null, ts: "never" }), 3, "a/b", NOW);
    expect(r).toMatchObject({ category: "other", role: HOSTILE, discussion: 0, pr: 0, id: "row3", time: "unknown time" });
  });
  it("Load older asks for the page named by the cursor and appends it", async () => {
    const { t, f } = team({}, { ["GET " + panelUrl("log", REPO_A)]: lines(100, 0), ["GET " + logUrl(REPO_A, "c100")]: lines(100, 100) });
    await t.load();
    expect(t.view().log).toMatchObject({ older: "Load older", canOlder: true });
    await t.loadOlder();
    expect(f.log.at(-1)[1]).toBe(`/api/v1/engine/repos/${REPO_A}/log?limit=100&cursor=c100`);
    expect(t.view().log.rows).toHaveLength(200);
    expect(t.view().log.said).toBe("Older log lines loaded (page 2).");
  });
  it("never holds more than 400 rows: older pages push the newest out, and Back to newest says how many are not shown", async () => {
    const pages = {};
    for (let p = 1; p < 100; p++) pages["GET " + logUrl(REPO_A, "c" + p * 100)] = F.envelope(F.logLines(100, p * 100), { next_cursor: p === 99 ? null : "c" + (p + 1) * 100 });
    const { t } = team({}, { ["GET " + panelUrl("log", REPO_A)]: lines(100, 0), ...pages });
    await t.load();
    for (let i = 0; i < 99; i++) {
      await t.loadOlder();
      expect(t.view().log.rows.length).toBeLessThanOrEqual(LOG_WINDOW);
    }
    const v = t.view().log;
    expect(LOG_WINDOW).toBe(400);
    expect(v.rows).toHaveLength(400);
    expect(v.rows[0].id).toBe("l" + String(9600).padStart(15, "0")); // the oldest 400 of 10,000
    expect(v.canOlder).toBe(false);
    expect(v.older).toBe("No older lines");
    expect(v.newest).toBe("Back to newest (9600 newer lines not shown)");
  });
  it("Back to newest reads the first page again and forgets the older ones", async () => {
    const { t, f } = team({}, { ["GET " + panelUrl("log", REPO_A)]: lines(100, 0), ["GET " + logUrl(REPO_A, "c100")]: lines(100, 100) });
    await t.load();
    await t.loadOlder();
    f.log.length = 0;
    t.newest();
    await flush(); await flush();
    expect(t.view().log.rows).toHaveLength(100);
    expect(f.log.some(([, p]) => p === panelUrl("log", REPO_A))).toBe(true);
  });
  it("a refresh refills the list while only the first page is open, and leaves it alone once older pages are", async () => {
    let n = 0;
    const { t } = team({}, { ["GET " + panelUrl("log", REPO_A)]: () => (++n === 1 ? lines(100, 0) : lines(100, 1000)), ["GET " + logUrl(REPO_A, "c1100")]: lines(100, 1100) });
    await t.load();
    await t.refresh();
    expect(t.view().log.rows[0].id).toBe("l" + String(1000).padStart(15, "0"));
    await t.loadOlder();
    await t.refresh();
    expect(t.view().log.rows).toHaveLength(200);
    expect(t.view().log.rows[0].id).toBe("l" + String(1000).padStart(15, "0")); // the list the person is reading did not jump
  });
  it("one page at a time; a page that cannot be read says so and keeps the rows", async () => {
    let release;
    const { t, f } = team({}, { ["GET " + panelUrl("log", REPO_A)]: lines(100, 0), ["GET " + logUrl(REPO_A, "c100")]: () => new Promise((r) => { release = r; }) });
    await t.load();
    const first = t.loadOlder();
    await t.loadOlder();
    expect(t.view().log.older).toBe(WORDS.olderLoading);
    expect(f.log.filter(([, p]) => p.includes("cursor=")).length).toBe(1);
    release({ weird: true });
    await first;
    expect(t.view().log).toMatchObject({ olderFailed: WORDS.olderFailed, canOlder: true });
    expect(t.view().log.rows).toHaveLength(100);
  });
  it("the log's gap and age travel with the rest: its gap reaches the banner and its source age the notices", async () => {
    const { t } = team({}, { ["GET " + panelUrl("log", REPO_A)]: F.envelope([F.logLine()], { missing_events: 2, gaps: [{ from_seq: 1, to_seq: 2, before_ts: F.iso(300) }], source_ages_s: { team_log: 3 * 3600 } }) });
    await t.load();
    expect(t.view().banner).toBe("Events missing since " + hm(F.iso(300)) + " (2 events)");
    expect(t.view().notices).toEqual(["team log not updated for 3 h"]);
  });
  it("a stale heartbeat adds last seen to the log header and keeps its rows", async () => {
    const { t } = team({}, { ["GET " + panelUrl("log", REPO_A)]: F.envelope([F.logLine()], { heard_age_s: 900 }) });
    await t.load();
    expect(t.view().log.warn).toBe("last seen 15 min ago");
    expect(t.view().log.rows).toHaveLength(1);
  });
});

describe("plan (EB-6b)", () => {
  const view = (over, lanes = F.envelope([]), page = 0) => planView(readPlan(F.plan(over)), readEnvelope(lanes), NOW, "acme-labs/widgets", page);
  it("a state or status word named like an Object.prototype key reads as Unknown, in the plan and in the usage rows", () => {
    for (const word of ["constructor", "__proto__"]) {
      const v = view({ items: [{ discussion: 42, ordinal: 1, state: word }], roadmap: [{ row_key: "EB-6b", discussion: 42, status: word, planned_prs: 1 }] });
      expect(v.items[0].state, word).toBe("Unknown");
      expect(v.rows[0].status, word).toBe("Unknown");
      expect(usageView(readUsage(F.usage({ items: [F.usageItem({ api_equivalent_usd: null, note: null, state: word })] }))).rows[0].value, word).toBe("no figure");
    }
  });
  it("lists today's items with a D# link, the ordinal and the state, and the roadmap rows with key, D#, status and counts", async () => {
    const { t } = team();
    await t.load();
    const p = t.view().plan;
    expect(p).toMatchObject({ none: false, failed: false, notSynced: "Plan not synced yet" });
    expect(p.view.title).toBe("Plan for " + new Date(NOW).toISOString().slice(0, 10));
    expect(p.view.items).toEqual([
      { discussion: 42, link: "https://github.com/acme-labs/widgets/discussions/42", ordinal: "1", state: "In progress" },
      { discussion: 43, link: "https://github.com/acme-labs/widgets/discussions/43", ordinal: "2", state: "Planned" },
    ]);
    expect(p.view.rows.map((r) => [r.key, r.discussion, r.status])).toEqual([["EB-6b", 42, "In progress"], ["(no key)", 44, "Done"]]);
    expect(p.asOf).toMatch(/^as of \d\d:\d\d \(0 min ago\)$/);
  });
  it("each of the six item states has its own words; one it does not know reads Unknown, and the roadmap's own words are a different list", () => {
    const words = { planned: "Planned", in_progress: "In progress", pr_open: "Pull request open", merged: "Merged", blocked: "Blocked", dropped: "Dropped" };
    const items = Object.keys(words).concat("not_started").map((state, i) => ({ discussion: 10 + i, ordinal: i + 1, state }));
    expect(view({ items }).items.map((i) => i.state)).toEqual([...Object.values(words), "Unknown"]);
    expect(view({ roadmap: [{ row_key: "R", discussion: 1, status: "done", planned_prs: null }] }).rows[0].status).toBe("Done");
  });
  it("no snapshot (204) reads Plan not synced yet, with no stale warning and no gap invented", async () => {
    const { t } = team({}, { ["GET " + panelUrl("plan", REPO_A)]: null });
    await t.load();
    const p = t.view().plan;
    expect(p).toMatchObject({ none: true, failed: false, warn: "", asOf: WORDS.noData });
    expect(t.view().banner).toBe("");
  });
  it("a snapshot older than 26 h reads Plan from <date>; at 26 h it is still today's", () => {
    expect(view({ age_s: 26 * 3600 + 1, plan_date: "2026-11-14" }).title).toBe("Plan from 2026-11-14");
    expect(view({ age_s: 26 * 3600, plan_date: "2026-11-14" }).title).toBe("Plan for 2026-11-14");
    expect(view({ age_s: 99999, plan_date: "soon" }).title).toBe("Plan is out of date");
  });
  it("counts the PRs merged for the row's Discussion in the last 30 days, from the lane list; never a lifetime figure", () => {
    const lanes = F.envelope([
      F.lane({ pr: 1, discussion: 42, state: "merged", updated_at: F.iso(86400) }), F.lane({ pr: 2, discussion: 42, state: "merged", updated_at: F.iso(29 * 86400) }),
      F.lane({ pr: 3, discussion: 42, state: "merged", updated_at: F.iso(31 * 86400) }), F.lane({ pr: 4, discussion: 42, state: "queued" }), F.lane({ pr: 5, discussion: 44, state: "merged", updated_at: F.iso(60) }),
    ]);
    const rows = view({}, lanes).rows;
    expect(rows[0].counts).toBe("2 merged in the last 30 days · 3 planned");
    expect(rows[1].counts).toBe("1 merged in the last 30 days");
    expect(view({}, F.envelope([])).rows[0].counts).toBe("0 merged in the last 30 days · 3 planned");
    expect(view({}, F.envelope([F.lane({ discussion: 42, state: "merged", updated_at: F.iso(60) })], { next_cursor: "more" })).rows[0].counts).toBe("at least 1 merged in the last 30 days · 3 planned");
    expect(planView(readPlan(F.plan()), null, NOW, "acme-labs/widgets", 0).rows[0].counts).toBe("3 planned"); // lanes unreadable: no count is invented
    expect(JSON.stringify(view({}, lanes))).not.toMatch(/lifetime|all time/i);
  });
  it("the merged count follows the lane list's cursor for up to five pages, and says at least only when pages remain after that", async () => {
    const page = (n, over = {}) => F.envelope([F.lane({ pr: 100 + n, discussion: 42, state: "merged", updated_at: F.iso(60) })], { next_cursor: "p" + (n + 1), ...over });
    const routes = { ["GET " + panelUrl("lanes", REPO_A)]: page(0) };
    for (let n = 1; n < 9; n++) routes["GET " + lanesUrl(REPO_A, "p" + n)] = page(n, n === 3 ? { next_cursor: null } : {});
    const { t, f } = team({}, routes);
    await t.load();
    expect(f.log.filter(([, p]) => p.includes("/lanes")).map(([, p]) => p.split("/lanes")[1])).toEqual(["", "?cursor=p1", "?cursor=p2", "?cursor=p3"]);
    expect(t.view().plan.view.rows[0].counts).toBe("4 merged in the last 30 days · 3 planned"); // the last page had no cursor: nothing is hidden
    const long = {};
    for (let n = 1; n < 9; n++) long["GET " + lanesUrl(REPO_A, "p" + n)] = page(n);
    const more = team({}, { ["GET " + panelUrl("lanes", REPO_A)]: page(0), ...long });
    await more.t.load();
    expect(LANE_PAGES).toBe(5);
    expect(more.f.log.filter(([, p]) => p.includes("/lanes")).length).toBe(5);
    expect(more.t.view().plan.view.rows[0].counts).toBe("at least 5 merged in the last 30 days · 3 planned");
  });
  it("a lane page that cannot be read keeps what was read and still says at least", async () => {
    const first = F.envelope([F.lane({ pr: 1, discussion: 42, state: "merged", updated_at: F.iso(60) })], { next_cursor: "p1" });
    const { t } = team({}, { ["GET " + panelUrl("lanes", REPO_A)]: first, ["GET " + lanesUrl(REPO_A, "p1")]: { weird: true } });
    await t.load();
    expect(t.view().plan.view.rows[0].counts).toBe("at least 1 merged in the last 30 days · 3 planned");
    expect(t.view().lanes.failed).toBe(false);
  });
  it("a row with no key shows (no key); a hostile key stays text; an unknown status reads Unknown", () => {
    const rows = view({ roadmap: [{ row_key: "", discussion: null, status: "weird", planned_prs: null }, { row_key: HOSTILE, discussion: 5, status: HOSTILE, planned_prs: 1 }] }).rows;
    expect(rows[0]).toMatchObject({ key: "(no key)", status: "Unknown", counts: "", discussion: 0 });
    expect(rows[1]).toMatchObject({ key: HOSTILE, status: "Unknown" });
  });
  it("the roadmap is paged at 100 rows so the page never holds the whole of a long roadmap", () => {
    const roadmap = Array.from({ length: 250 }, (_, i) => ({ row_key: "R" + i, discussion: null, status: "done", planned_prs: null }));
    expect(ROADMAP_PAGE).toBe(100);
    const first = view({ roadmap });
    expect(first.rows).toHaveLength(100);
    expect(first).toMatchObject({ hasPrev: false, hasNext: true, span: "Rows 1–100 of 250" });
    const last = view({ roadmap }, F.envelope([]), 2);
    expect(last.rows.map((r) => r.key)[0]).toBe("R200");
    expect(last).toMatchObject({ hasPrev: true, hasNext: false, span: "Rows 201–250 of 250" });
    expect(view({ roadmap }, F.envelope([]), 99).rows).toHaveLength(50); // a page past the end lands on the last
    expect(view({}).span).toBe("");
  });
  it("planPage moves the page and a repo change puts it back to the first", async () => {
    const { t } = team();
    await t.load();
    t.planPage(1);
    expect(t.state.planPage).toBe(1);
    t.planPage(-5);
    expect(t.state.planPage).toBe(0);
    t.planPage(1);
    t.select(REPO_B);
    expect(t.state.planPage).toBe(0);
  });
  it("the plan body must carry its list and gap fields: a reply without the roadmap is unreadable, not empty", () => {
    for (const drop of ["roadmap", "items", "gaps", "missing_events"]) {
      const raw = F.plan();
      delete raw[drop];
      expect(readPlan(raw), drop).toBeNull();
    }
    expect(readPlan(F.plan({ plan_date: "tomorrow" })).date).toBe("");
  });
  it("the plan's own gap and age feed the banner and the plan source notice", async () => {
    const { t } = team({}, { ["GET " + panelUrl("plan", REPO_A)]: F.plan({ missing_events: 4, gaps: [{ from_seq: 1, to_seq: 4, before_ts: F.iso(600) }], source_ages_s: { plan: 30 * 3600 } }) });
    await t.load();
    expect(t.view().banner).toBe("Events missing since " + hm(F.iso(600)) + " (4 events)");
    expect(t.view().notices).toEqual(["plan not updated for 30 h"]);
  });
});

describe("stats (EB-6b): the server's figures, as sent", () => {
  it("shows each figure exactly as the server sent it, with the number of events behind it, and the window", async () => {
    const { t } = team();
    await t.load();
    const v = t.view().stats.view;
    expect(v.rows.map(({ id, label, value, from }) => ({ id, label, value, from }))).toEqual([
      { id: "roles", label: "Agents by role", value: "executor 2, code-reviewer 1", from: " (from 6 events)" },
      { id: "duration", label: "Duration", value: "median 120.5 s, p90 300 s", from: " (from 3 events)" },
      { id: "merges", label: "Merges", value: "4", from: " (from 4 events)" },
      { id: "gates", label: "Gates passed", value: "3 of 4", from: " (from 1 event)" },
    ]);
    expect(v.window).toBe("Window: " + F.iso(30 * 86400).slice(0, 10) + " to " + F.iso(0).slice(0, 10));
  });
  it("the events behind a figure are a disclosure: closed until toggled, listing the kinds, the count and the event numbers per session, never a session id", async () => {
    const seqs = [...[3, 4, 5, 7].map((seq) => ({ session_id: "s-one", seq })), { session_id: "s-two", seq: 12 }, { session_id: "s-one", seq: 6 }];
    const { t } = team({}, { ["GET " + panelUrl("stats", REPO_A)]: F.stats({ merges: { value: 4, provenance: { kinds: ["pr_merged", "gate_passed"], count: 6, seqs } } }) });
    await t.load();
    const row = () => t.view().stats.view.rows.find((r) => r.id === "merges");
    expect(row()).toMatchObject({ open: false, prov: ["Event kinds: pr merged, gate passed", "Events: 6", "Session 1: seq 3–7", "Session 2: seq 12"] });
    expect(JSON.stringify(row())).not.toMatch(/s-one|s-two/);
    t.toggleProv("merges");
    expect(row().open).toBe(true);
    expect(t.view().stats.view.rows.filter((r) => r.open)).toHaveLength(1);
    t.toggleProv("merges");
    expect(row().open).toBe(false);
    t.toggleProv("merges");
    t.select(REPO_B);
    expect(t.state.provOpen).toEqual([]); // another repo starts closed
  });
  it("a figure with nothing behind it has no disclosure", () => {
    const v = statsView(readStats(F.stats({ merges: { value: 0, provenance: { count: 0 } }, agents_by_role: undefined })));
    expect(v.rows[0]).toMatchObject({ value: "no figures yet", prov: null, from: "" });
  });
  it("a figure the server could not give reads no figures yet, never 0 or blank", () => {
    const v = statsView(readStats(F.stats({ duration_s: { n: 0, median: null, p90: null, provenance: { count: 0 } }, gate_pass_rate: { value: null, numerator: 0, denominator: 0, provenance: { count: 0 } }, merges: { value: 0, provenance: { count: 0 } }, agents_by_role: undefined })));
    expect(v.rows.map((r) => r.value)).toEqual(["no figures yet", "no figures yet", "0", "no figures yet"]);
    expect(v.rows[0].from).toBe("");
  });
  it("a reply without the envelope fields is unreadable", () => {
    const raw = F.stats();
    delete raw.gaps;
    expect(readStats(raw)).toBeNull();
    expect(readStats(null)).toBeNull();
  });
  it("the stats panel echoes the server's number: a changed fixture changes the text one for one", async () => {
    const { t } = team({}, { ["GET " + panelUrl("stats", REPO_A)]: F.stats({ merges: { value: 17, provenance: { count: 21 } } }) });
    await t.load();
    expect(t.view().stats.view.rows[2]).toMatchObject({ label: "Merges", value: "17", from: " (from 21 events)" });
  });
});

describe("cost (EB-6b.6): the server's figures, as sent, through the one formatter", () => {
  it("shows the route's total as sent, then each row's own figure, with the window", async () => {
    const { t } = team();
    await t.load();
    const u = t.view().usage;
    expect(u).toMatchObject({ failed: false, asOf: expect.stringMatching(/^as of \d\d:\d\d \(0 min ago\)$/) });
    expect(u.view.headline).toBe("$12.3456");
    expect(u.view.rows.map((r) => [r.label, r.value])).toEqual([
      ["Agent · sonnet-5 · on your Claude plan", "$1.2345"],
      ["Tick · unknown model", "No API price for this model. That is not the same as $0."],
    ]);
    expect(u.view.window).toBe("Window: " + F.iso(30 * 86400).slice(0, 10) + " to " + F.iso(0).slice(0, 10));
  });
  it("a row with no figure says its note or its state's words, and is never $0", () => {
    const rows = (over) => usageView(readUsage(F.usage({ items: [F.usageItem({ api_equivalent_usd: null, ...over })] }))).rows[0].value;
    expect(rows({ state: "not_recorded", note: "Not recorded for this run." })).toBe("Not recorded for this run.");
    expect(rows({ state: "not_priced", note: null })).toBe("No API price for this model");
    expect(rows({ state: "not_recorded", note: "" })).toBe("Usage was not recorded");
    expect(rows({ state: null, note: null })).toBe("no figure");
    expect(rows({ state: "weird", note: null })).toBe("no figure");
    expect(rows({ state: "recorded", note: null })).not.toMatch(/^\$0/);
  });
  it("echoes the server's numbers one for one through the shared formatter", async () => {
    for (const [sent, shown] of [[0, "$0.00"], [0.0042, "$0.0042"], [1234.5, "$1,234.50"], [12.3456, "$12.3456"], [7, "$7.00"]]) {
      const { t } = team({}, { ["GET " + panelUrl("usage", REPO_A)]: F.usage({ totals: { api_equivalent_usd: sent, tokens: {} }, items: [F.usageItem({ api_equivalent_usd: sent })] }) });
      await t.load();
      expect(t.view().usage.view.headline, String(sent)).toBe(shown);
      expect(t.view().usage.view.rows[0].value, String(sent)).toBe(shown);
    }
  });
  it("an empty list says so; a cursor says more rows exist; no total is added up from rows", async () => {
    const { t } = team({}, { ["GET " + panelUrl("usage", REPO_A)]: F.usage({ items: [], next_cursor: "more", totals: { api_equivalent_usd: 3.25, tokens: {} } }) });
    await t.load();
    expect(t.view().usage.view).toMatchObject({ headline: "$3.25", rows: [], empty: "No usage reported yet", more: "More rows exist than are shown." });
    const two = team({}, { ["GET " + panelUrl("usage", REPO_A)]: F.usage({ items: [F.usageItem({ api_equivalent_usd: 1 }), F.usageItem({ api_equivalent_usd: 2 })], totals: { api_equivalent_usd: 99, tokens: {} } }) });
    await two.t.load();
    expect(two.t.view().usage.view.headline).toBe("$99.00");
  });
  it("a reply without a numeric total, or without the envelope fields, is unreadable and the panel says so", async () => {
    for (const bad of [{ totals: null }, { totals: { api_equivalent_usd: "12" } }, { totals: {} }, { gaps: undefined }]) {
      expect(readUsage(F.usage(bad)), JSON.stringify(bad)).toBeNull();
    }
    expect(readUsage(null)).toBeNull();
    const { t } = team({}, { ["GET " + panelUrl("usage", REPO_A)]: { weird: true } });
    await t.load();
    expect(t.view().usage).toMatchObject({ failed: true, view: null });
    expect(t.view().agents.failed).toBe(false);
    expect(t.view().refreshFailed).toBe("");
  });
  it("its gap, its age and its source ages reach the banner, the notices and the header like every other panel's", async () => {
    const { t } = team({}, { ["GET " + panelUrl("usage", REPO_A)]: F.usage({ missing_events: 3, gaps: [{ from_seq: 1, to_seq: 3, before_ts: F.iso(400) }], source_ages_s: { loop: 2 * 3600 }, heard_age_s: 900 }) });
    await t.load();
    expect(t.view().banner).toBe("Events missing since " + hm(F.iso(400)) + " (3 events)");
    expect(t.view().notices).toEqual(["loop not updated for 2 h"]);
    expect(t.view().usage.warn).toBe("last seen 15 min ago");
    expect(t.view().usage.asOf).toMatch(/^as of /);
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

// ── Operate ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const ON = () => F.operateOn();
const sends = (f) => f.log.filter(([m]) => m !== "GET");
/** An owner with operate switched on and a repo that is live. */
async function operating(routes = {}, extra = {}) {
  const r = team(extra, { ["GET " + SETTINGS_URL]: ON().settings, ["GET " + REPOS_URL]: ON().repos, ["POST " + commandsUrl(REPO_A)]: { command_id: "c1", state: "pending", expires_at: F.iso(-600) }, ...routes });
  await r.t.load();
  r.f.log.length = 0;
  return r;
}

describe("operate: who sees controls and when they are locked", () => {
  it("a member sees no controls and no command or dial is read", async () => {
    const { t, f } = team({}, { ["GET " + SETTINGS_URL]: F.settings({ can_edit: false, operate_enabled: true }) });
    await t.load();
    expect(t.view().operate).toEqual({ show: false });
    expect(f.log.some(([, p]) => p.includes("/commands") || p.includes("decision-settings"))).toBe(false);
    expect(await t.operate.pause()).toBe(false);
    expect(sends(f)).toEqual([]);
  });
  it("the reason names the first thing that is off: a halt being applied, then watch, then no repo, then operate, then a halt", () => {
    const repo = { operate: true, halted: false, haltPending: false };
    expect(lockReason({ watch: false, operate: true }, repo)).toBe("Engine watch is off.");
    expect(lockReason({ watch: true, operate: true }, undefined)).toBe(OP_WORDS.noRepo);
    expect(lockReason({ watch: true, operate: false }, repo)).toBe("Operate is off.");
    expect(lockReason({ watch: true, operate: true }, { ...repo, operate: false })).toBe("Operate is off."); // either switch off locks it
    expect(lockReason({ watch: true, operate: true }, { ...repo, halted: true })).toBe("The engine is halted.");
    expect(lockReason({ watch: true, operate: true }, { ...repo, haltPending: true })).toBe("A halt is being applied.");
    // a pending halt wins over every other reason
    expect(lockReason({ watch: false, operate: true }, { ...repo, haltPending: true })).toBe("A halt is being applied.");
    expect(lockReason({ watch: true, operate: false }, { ...repo, haltPending: true })).toBe("A halt is being applied.");
    expect(lockReason({ watch: true, operate: true }, { ...repo, operate: false, haltPending: true })).toBe("A halt is being applied.");
    expect(lockReason({ watch: true, operate: true }, repo)).toBe("");
  });
  for (const [name, routes, reason] of [
    ["operate off", {}, "Operate is off."],
    ["watch off", { ["GET " + SETTINGS_URL]: F.settings({ watch_enabled: false, operate_enabled: true }) }, "Engine watch is off."],
    ["halted", { ["GET " + REPOS_URL]: F.list([F.repo({ operate_enabled: true, halted: true })]), ["GET " + SETTINGS_URL]: ON().settings }, "The engine is halted."],
    ["halt pending", { ["GET " + REPOS_URL]: F.list([F.repo({ operate_enabled: true, halt_pending: true })]), ["GET " + SETTINGS_URL]: ON().settings }, "A halt is being applied."],
  ]) {
    it(`${name}: every control is locked with the reason, and a press that reaches the controller sends nothing`, async () => {
      const { t, f } = team({}, routes);
      await t.load();
      f.log.length = 0;
      expect(t.view().operate).toMatchObject({ show: true, reason });
      const o = t.operate;
      await Promise.all([o.startDay(), o.pause(), o.resume(), o.requestSpawn("executor", "5"), o.setDialLevel("agent.spawn", 3, "none"), o.stop("a1b2c3d4e5f60718"), o.saveDial("engine_merge", "act")]);
      o.askStop("a1b2c3d4e5f60718");
      expect(t.state.op.confirmStop).toBeNull();
      expect(sends(f)).toEqual([]);
    });
  }
  it("cancelling a pending command stays allowed while operate is off or the repo is halted, and is locked only by watch off, a save in flight or a member", async () => {
    const id = "c0000000-0000-4000-8000-000000000001";
    for (const routes of [{}, { ["GET " + REPOS_URL]: F.list([F.repo({ operate_enabled: true, halted: true })]), ["GET " + SETTINGS_URL]: ON().settings }]) {
      const { t, f } = team({}, { ["DELETE " + commandUrl(id)]: { command_id: id, state: "cancelled" }, ...routes });
      await t.load();
      f.log.length = 0;
      expect(t.view().operate.reason).not.toBe("");
      expect(await t.operate.cancel(id)).toBe(true);
      expect(sends(f)).toEqual([["DELETE", commandUrl(id), undefined]]);
      expect(await t.operate.pause()).toBe(false); // everything else stays locked
    }
    const off = team({}, { ["GET " + SETTINGS_URL]: F.settings({ watch_enabled: false, operate_enabled: true }) });
    await off.t.load();
    off.f.log.length = 0;
    expect(await off.t.operate.cancel(id)).toBe(false);
    const member = team({}, { ["GET " + SETTINGS_URL]: F.settings({ can_edit: false, operate_enabled: true }), ["GET " + REPOS_URL]: ON().repos });
    await member.t.load();
    member.f.log.length = 0;
    expect(await member.t.operate.cancel(id)).toBe(false);
    expect(sends(off.f).concat(sends(member.f))).toEqual([]);
  });
  it("watch off shows the operate panel locked with no lists; its switch cannot be turned on", async () => {
    const { t, f } = team({}, { ["GET " + SETTINGS_URL]: F.settings({ watch_enabled: false }) });
    await t.load();
    f.log.length = 0;
    expect(t.view().operate).toMatchObject({ commands: null, dials: null, sw: { on: false, why: OP_WORDS.watchFirst } });
    expect(await t.operate.setOperate(true)).toBe(false);
    expect(f.log).toEqual([]);
  });
  it("a removed runner hides the controls with a sentence; an offline machine says commands expire in 10 min", async () => {
    const gone = await operating({ ["GET " + REPOS_URL]: F.list([F.repo({ operate_enabled: true, liveness: "runner_removed" })]) });
    await gone.t.refresh();
    expect(gone.t.view().operate).toMatchObject({ removed: OP_WORDS.removed, commands: null, dials: null });
    const off = await operating({ ["GET " + REPOS_URL]: F.list([F.repo({ operate_enabled: true, liveness: "stale" })]) });
    await off.t.refresh();
    expect(off.t.view().operate.offline).toBe("Machine offline; commands will expire in 10 min.");
    expect(OP_WORDS.offline).toBe("Machine offline; commands will expire in 10 min.");
    const live = await operating();
    expect(live.t.view().operate).toMatchObject({ offline: "", removed: "", reason: "" });
  });
});

describe("operate: the commands that are sent", () => {
  it("start day, pause and resume send exactly their kind and empty args to the repo's command route", async () => {
    const { t, f } = await operating();
    await t.operate.startDay();
    await t.operate.pause();
    await t.operate.resume();
    expect(sends(f)).toEqual([["POST", commandsUrl(REPO_A), { kind: "start_day", args: {} }], ["POST", commandsUrl(REPO_A), { kind: "pause_loop", args: {} }], ["POST", commandsUrl(REPO_A), { kind: "resume_loop", args: {} }]]);
    expect(t.state.op.notice).toBe(OP_WORDS.sent);
  });
  it("request agent sends the role and the Discussion as a whole number, and refuses a bad one without a request", async () => {
    const { t, f } = await operating();
    await t.operate.requestSpawn("code-reviewer", " 42 ");
    expect(sends(f)).toEqual([["POST", commandsUrl(REPO_A), { kind: "request_spawn", args: { role: "code-reviewer", discussion: 42 } }]]);
    f.log.length = 0;
    for (const [role, d] of [["wizard", "5"], ["executor", "0"], ["executor", "-3"], ["executor", "4.5"], ["executor", ""], ["executor", "1e3"], ["executor", "D#5"], ["executor", "9999999999"]]) {
      expect(await t.operate.requestSpawn(role, d), role + d).toBe(false);
      expect(t.state.op.notice).toBe(OP_WORDS.badSpawn);
    }
    expect(sends(f)).toEqual([]);
    expect(Object.keys(ROLES)).toEqual(["executor", "code-reviewer", "security-reviewer", "acceptance-tester", "browser-tester", "project-manager", "technical-architect", "product-owner", "cost-analyst", "performance-expert", "security-expert"]);
  });
  it("set dial sends a settable class, a level 1 to 5 and the lifetime; anything else sends nothing", async () => {
    const { t, f } = await operating();
    await t.operate.setDialLevel("merge.fast-path", "4", "for_today");
    expect(sends(f)).toEqual([["POST", commandsUrl(REPO_A), { kind: "set_dial", args: { dial_class: "merge.fast-path", level: 4, ttl: "for_today" } }]]);
    f.log.length = 0;
    for (const [c, l, ttl] of [["sandbox.modify", 3, "none"], ["cost.spend", 3, "none"], ["agent.spawn", 0, "none"], ["agent.spawn", 6, "none"], ["agent.spawn", 2.5, "none"], ["agent.spawn", 3, "forever"]]) expect(await t.operate.setDialLevel(c, l, ttl)).toBe(false);
    expect(sends(f)).toEqual([]);
    expect(Object.keys(DIAL_CLASSES)).toEqual(["docs.write", "tests.add", "deps.bump", "agent.spawn", "merge.standard", "merge.fast-path", "memory.write", "archive.move"]);
    expect(Object.keys(TTL)).toEqual(["for_today", "none"]);
  });
  it("the stop button asks first; Cancel sends nothing; Yes sends one stop_agent for that agent and closes the question", async () => {
    const { t, f } = await operating();
    const id = "a1b2c3d4e5f60718";
    t.operate.askStop(id);
    expect(t.view().operate.confirm).toMatchObject({ id, title: "Stop this agent?" });
    t.operate.cancelStop();
    expect(t.view().operate.confirm).toBeNull();
    expect(sends(f)).toEqual([]);
    t.operate.askStop(id);
    await t.operate.stop(id);
    expect(sends(f)).toEqual([["POST", commandsUrl(REPO_A), { kind: "stop_agent", args: { agent_id: id } }]]);
    expect(t.state.op.confirmStop).toBeNull();
    await t.operate.stop("not an id!");
    expect(sends(f)).toHaveLength(1);
  });
  it("an agent is named by its role in words, its Discussion and a short id, never the wire enum", () => {
    expect(agentWords({ role: "executor", discussion: 42, stopId: "a1b2c3d4e5f60718" })).toBe("the executor agent on D#42 (id a1b2c3)");
    expect(agentWords({ role: "code-reviewer", discussion: 43, stopId: "b2c3d4e5f6071829" })).toBe("the code reviewer agent on D#43 (id b2c3d4)");
    expect(agentWords({ role: "<b>x</b>", discussion: 0, stopId: "" })).toBe("the agent");
    expect(agentWords({ role: "executor", discussion: 42, stopId: "a1b2c3d4e5f60718" })).not.toContain("code-reviewer");
  });
  it("the stop question names its agent and closes when that agent is no longer a running one", async () => {
    const id = "a1b2c3d4e5f60718";
    const { t, f } = await operating({ ["GET " + panelUrl("agents", REPO_A)]: F.envelope([F.agent(), F.agent({ agent_id: "b2c3d4e5f6071829", role: "code-reviewer", discussion: 43 })]) });
    await t.refresh();
    expect(t.view().agents.rows.map((r) => r.who)).toEqual(["the executor agent on D#42 (id a1b2c3)", "the code reviewer agent on D#43 (id b2c3d4)"]);
    t.operate.askStop(id);
    expect(t.view().operate.confirm).toMatchObject({ id, who: "the executor agent on D#42 (id a1b2c3)" });
    f.routes["GET " + panelUrl("agents", REPO_A)] = F.envelope([F.agent({ agent_id: "b2c3d4e5f6071829", role: "code-reviewer", discussion: 43 })]);
    await t.refresh();
    expect(t.view().operate.confirm).toBeNull(); // its agent is gone: nothing left to confirm
  });
  it("a Stop control shows only on a running agent with a usable id, and says so once a stop is on its way", async () => {
    const pending = F.command({ kind: "stop_agent", args: { agent_id: "a1b2c3d4e5f60718" } });
    const { t } = await operating({
      ["GET " + commandsUrl(REPO_A) + "?limit=50"]: F.commands([pending]),
      ["GET " + panelUrl("agents", REPO_A)]: F.envelope([F.agent(), F.agent({ agent_id: "b2c3d4e5f6071829", role: "code-reviewer" }), F.agent({ agent_id: HOSTILE }), F.agent({ agent_id: "c3d4e5f607182930", started_at: F.iso(5 * 3600) })]),
    });
    await t.refresh();
    expect(t.view().agents.rows.map((r) => r.stop)).toEqual([{ pending: true }, { pending: false }, null, null]); // hostile id: no control; over 3 h: unknown, no control
    const member = team({}, { ["GET " + SETTINGS_URL]: F.settings({ can_edit: false, operate_enabled: true }), ["GET " + REPOS_URL]: ON().repos });
    await member.t.load();
    expect(member.t.view().agents.rows.every((r) => r.stop === null)).toBe(true);
  });
  it("one command at a time: a second press while one is out sends nothing", async () => {
    let release;
    const { t, f } = await operating({ ["POST " + commandsUrl(REPO_A)]: () => new Promise((r) => { release = r; }) });
    const first = t.operate.pause();
    expect(t.view().operate.saving).toBe(true);
    await t.operate.resume();
    release({ command_id: "c1", state: "pending", expires_at: F.iso(-600) });
    await first;
    expect(sends(f)).toHaveLength(1);
    expect(t.view().operate.saving).toBe(false);
  });
  it("after a send the commands are read again", async () => {
    const { t, f } = await operating();
    await t.operate.pause();
    expect(f.log.filter(([m, p]) => m === "GET" && p.includes("/commands"))).toHaveLength(1);
  });
});

describe("operate: a sentence for every refusal", () => {
  const e = (status, code, extra = {}) => Object.assign(new Error("server text that must never be shown"), { status, code, ...extra });
  it("issuing: each 409 the route documents, in plain words, and 403, 404, 429 and the rest", () => {
    expect(sendFailure(e(409, "operate_off"))).toBe("Operate is off for this repository. Turn it on first.");
    expect(sendFailure(e(409, "engine_not_connected"))).toBe("No engine is connected for this repository. Start the engine on your machine first.");
    expect(sendFailure(e(409, "halted"))).toBe("The engine is halted, so this command isn't allowed.");
    expect(sendFailure(e(409, "too_many_pending"))).toBe("Too many commands are waiting (20 is the most). Wait for some to finish, or cancel one.");
    expect(sendFailure(e(403, "forbidden"))).toBe(OP_WORDS.forbidden);
    expect(sendFailure(e(403, "session_required"))).toBe(OP_WORDS.forbidden);
    expect(sendFailure(e(404, "not_found"))).toBe(OP_WORDS.gone);
    expect(sendFailure(e(429, "rate_limited", { retryAfter: 8 }))).toBe("Try again in 8 seconds.");
    for (const x of [e(500, "server_error"), e(409, "something_new"), e(422, "invalid"), e(0, "offline"), null]) expect(sendFailure(x)).toBe(OP_WORDS.sendFailed);
  });
  it("cancelling: already delivered, expired, already cancelled", () => {
    expect(cancelFailure(e(409, "already_delivered"))).toBe("The runner already has this command, so it can't be cancelled.");
    expect(cancelFailure(e(409, "expired"))).toBe("That command has already expired.");
    expect(cancelFailure(e(409, "already_cancelled"))).toBe("That command is already cancelled.");
    expect(cancelFailure(e(404, "not_found"))).toBe(OP_WORDS.gone);
  });
  it("dials: a member, a refused value, a dial that moved, and the rest", () => {
    expect(dialFailure(e(403, "forbidden"))).toBe(OP_WORDS.dialForbidden);
    expect(dialFailure(e(403, "plan_holder_only"))).toBe(OP_WORDS.dialForbidden);
    expect(dialFailure(e(422, "validation_failed"))).toBe(OP_WORDS.dialRefused);
    expect(dialFailure(e(409, "dial_changed"))).toBe(OP_WORDS.dialChanged);
    expect(dialFailure(e(500, "server_error"))).toBe(OP_WORDS.dialFailed);
  });
  it("a refused send shows the sentence, never the server's text, and reads nothing again", async () => {
    for (const [err, sentence] of [[e(409, "too_many_pending"), "Too many commands are waiting (20 is the most). Wait for some to finish, or cancel one."], [e(409, "halted"), "The engine is halted, so this command isn't allowed."], [e(500, "server_error"), OP_WORDS.sendFailed]]) {
      const { t, f } = await operating({ ["POST " + commandsUrl(REPO_A)]: err });
      await t.operate.startDay();
      expect(t.state.op.notice).toBe(sentence);
      expect(t.state.op.saving).toBe(false);
      expect(f.log).toHaveLength(1);
      expect(JSON.stringify(t.view().operate)).not.toContain("server text");
    }
  });
});

describe("operate: the command list and what became of each command", () => {
  const row = (over, now = NOW) => commandRow(readCommands(F.commands([F.command(over)]))[0], now, () => OP_WORDS.unknownAgent);
  it("one word for every state, and a detail", () => {
    const pairs = [["pending", "Pending"], ["delivered", "Delivered"], ["applied", "Applied"], ["refused", "Refused"], ["expired", "Expired"], ["cancelled", "Cancelled"], ["not_confirmed", "Not confirmed"]];
    for (const [state, word] of pairs) {
      const r = row({ state, acked_at: state === "applied" ? F.iso(5) : null, refusal: state === "refused" ? "halted" : null, expires_at: state === "pending" ? F.iso(-300) : F.iso(300) });
      expect(r.word).toBe(word);
      expect(r.detail).not.toBe("");
    }
  });
  it("Applied needs the runner's report: an applied row with no acked_at reads Delivered", () => {
    expect(row({ state: "applied", acked_at: null }).word).toBe("Delivered");
    expect(row({ state: "applied", acked_at: F.iso(3) }).word).toBe("Applied");
  });
  it("a pending command past its life reads Expired at once, with no Cancel", () => {
    expect(row({ state: "pending", expires_at: F.iso(1) })).toMatchObject({ word: "Expired", cancel: false });
    expect(row({ state: "pending", expires_at: F.iso(-60) })).toMatchObject({ word: "Pending", cancel: true });
    for (const state of ["delivered", "applied", "refused", "expired", "cancelled", "not_confirmed"]) expect(row({ state, acked_at: F.iso(1) }).cancel).toBe(false);
  });
  it("a refusal is said in words: one sentence for each of the eleven codes, and a fallback", () => {
    expect(Object.keys(REFUSALS)).toEqual(["signature_invalid", "wrong_runner", "wrong_repo", "expired", "seq_not_increasing", "halted", "operate_off", "host_not_running", "unknown_ask", "unknown_agent", "ceiling"]);
    for (const code of Object.keys(REFUSALS)) expect(row({ state: "refused", refusal: code }).detail).toBe(REFUSALS[code]);
    expect(row({ state: "refused", refusal: "halted" }).detail).toBe("The engine is halted.");
    expect(row({ state: "refused", refusal: "from the future" }).detail).toBe("The runner refused it.");
    expect(row({ state: "refused", refusal: null }).detail).toBe("The runner refused it.");
  });
  it("each command reads as a sentence with names, not ids", () => {
    const text = (kind, args) => row({ kind, args }).text;
    expect(text("start_day", {})).toBe("Start the day");
    expect(text("pause_loop", {})).toBe("Pause the loop");
    expect(text("resume_loop", {})).toBe("Resume the loop");
    expect(text("request_spawn", { role: "code-reviewer", discussion: 42 })).toBe("Request a code reviewer for D#42");
    expect(text("set_dial", { dial_class: "merge.standard", level: 2, ttl: "for_today" })).toBe("Set standard merges to level 2 (for today)");
    expect(text("stop_agent", { agent_id: "a1b2c3d4e5f60718" })).toBe("Stop an agent");
    expect(text("answer_ask", { ask_id: "0123456789abcdef", choice: "approve" })).toBe("Answer an ask: approve");
    expect(text("request_spawn", { role: HOSTILE, discussion: "x" })).toBe("Request an agent");
  });
  it("a stop names the agent by its role when the agent is on screen", async () => {
    const { t } = await operating({ ["GET " + commandsUrl(REPO_A) + "?limit=50"]: F.commands([F.command({ kind: "stop_agent", args: { agent_id: "a1b2c3d4e5f60718" } })]) });
    await t.refresh();
    expect(t.view().operate.commands.rows[0].text).toBe("Stop the executor agent");
  });
  it("the list is read as {commands}; anything else is a failed read that keeps the earlier list", async () => {
    expect(readCommands({ items: [] })).toBeNull();
    expect(readCommands(F.commands([{}, F.command({ kind: "format_disk" }), F.command({ state: "mystery" }), F.command()]))).toHaveLength(1);
    let n = 0;
    const { t } = await operating({ ["GET " + commandsUrl(REPO_A) + "?limit=50"]: () => (++n === 1 ? F.commands([F.command()]) : { weird: 1 }) });
    await t.refresh();
    await t.refresh();
    const c = t.view().operate.commands;
    expect(c.rows).toHaveLength(1);
    expect(c.failed).toBe(true);
  });
  it("the list shows its own as-of time, and no data yet before the first read", async () => {
    const { t } = await operating();
    await t.refresh();
    expect(t.view().operate.commands.asOf).toMatch(/^as of \d\d:\d\d \(\d+ min ago\)$/);
    expect(t.view().operate.dials.asOf).toMatch(/^as of \d\d:\d\d \(\d+ min ago\)$/);
    const none = team({}, { ["GET " + SETTINGS_URL]: ON().settings, ["GET " + REPOS_URL]: ON().repos, ["GET " + commandsUrl(REPO_A) + "?limit=50"]: fail(500, "server_error") });
    await none.t.load();
    expect(none.t.view().operate.commands).toMatchObject({ asOf: "no data yet", failed: true, rows: [] });
  });
  it("cancel sends one DELETE for a pending command and reads again; a refusal says why", async () => {
    const id = "c0000000-0000-4000-8000-000000000001";
    const { t, f } = await operating({ ["DELETE " + commandUrl(id)]: { command_id: id, state: "cancelled" } });
    await t.operate.cancel(id);
    expect(sends(f)).toEqual([["DELETE", commandUrl(id), undefined]]);
    expect(t.state.op.notice).toBe(OP_WORDS.cancelled);
    const late = await operating({ ["DELETE " + commandUrl("c1")]: fail(409, "already_delivered") });
    await late.t.operate.cancel("c1");
    expect(late.t.state.op.notice).toBe("The runner already has this command, so it can't be cancelled.");
    expect(late.f.log.filter(([m, p]) => m === "GET" && p.includes("/commands"))).toHaveLength(1); // a 409 means the list was stale: it is read again
    const other = await operating({ ["DELETE " + commandUrl("c1")]: fail(500, "server_error") });
    await other.t.operate.cancel("c1");
    expect(other.f.log.filter(([m, p]) => m === "GET" && p.includes("/commands"))).toHaveLength(0); // any other failure does not read again
  });
});

describe("operate: the three engine dials", () => {
  it("only the engine's three are shown, with the server's own label and the options the entry allows", async () => {
    const { t } = await operating();
    await t.refresh();
    const rows = t.view().operate.dials.rows;
    expect(rows.map((r) => r.type)).toEqual(ENGINE_DIALS);
    expect(rows[0]).toMatchObject({ label: "Server label for engine_spawn", value: "ask", adjustable: true });
    expect(rows[1].value).toBe("announce");
    expect(rows[2].options.map((o) => o.label)).toEqual(["Go ahead", "Ask me first"]); // Spec-ready offers act or ask only
    expect(readDials(F.dials({ dials: [F.dial("engine_merge", { label: "" })] }))[0].label).toBe("Letting the engine merge a pull request");
    expect(readDials({ dials: "x" })).toBeNull();
  });
  it("Apply posts one dial to the repo's decision-settings route and reads again; a refusal says why", async () => {
    const { t, f } = await operating({ ["POST " + dialUrl(REPO_A)]: F.dials() });
    await t.operate.saveDial("engine_merge", "act");
    expect(sends(f)).toEqual([["POST", dialUrl(REPO_A), { decision_type: "engine_merge", disposition: "act" }]]);
    expect(t.state.op.notice).toBe(OP_WORDS.dialSaved);
    f.log.length = 0;
    expect(await t.operate.saveDial("start_small_item", "act")).toBe(false); // not one of the engine's three
    expect(await t.operate.saveDial("engine_merge", "maybe")).toBe(false);
    expect(sends(f)).toEqual([]);
    const refused = await operating({ ["POST " + dialUrl(REPO_A)]: fail(422, "validation_failed") });
    await refused.t.operate.saveDial("engine_spec_ready", "announce");
    expect(refused.t.state.op.notice).toBe(OP_WORDS.dialRefused);
  });
  it("a dial the server will not let this person move shows its value and no control", async () => {
    const { t } = await operating({ ["GET " + dialsUrl(REPO_A)]: F.dials({ dials: [F.dial("engine_merge", { adjustable: false })] }) });
    await t.refresh();
    expect(t.view().operate.dials.rows[0].adjustable).toBe(false);
  });
});

describe("operate: the switch", () => {
  it("turning operate on writes only operate_enabled and reads the settings again", async () => {
    const { t, f } = team({});
    await t.load();
    f.log.length = 0;
    await t.operate.setOperate(true);
    expect(f.log[0]).toEqual(["PUT", SETTINGS_URL, { operate_enabled: true }]);
    expect(f.log[1][1]).toBe(SETTINGS_URL);
    expect(t.state.op.notice).toBe(OP_WORDS.operateSaved);
  });
  it("a refusal on the switch says only an owner or admin can do it", async () => {
    const { t } = team({}, { ["PUT " + SETTINGS_URL]: fail(403, "forbidden") });
    await t.load();
    await t.operate.setOperate(true);
    expect(t.state.op.notice).toBe(OP_WORDS.forbidden);
  });
});

describe("operate: what a screen may show", () => {
  it("no state puts null, undefined or NaN in a string; the operate view is clean in every state", async () => {
    const states = {
      on: {},
      hostile: { ["GET " + commandsUrl(REPO_A) + "?limit=50"]: F.commands([F.command({ kind: "request_spawn", args: { role: HOSTILE, discussion: null }, state: "refused", refusal: HOSTILE, expires_at: null, acked_at: null }), F.command({ id: "c2", kind: "set_dial", args: {} }), F.command({ id: "c3", kind: "stop_agent", args: { agent_id: HOSTILE } })]), ["GET " + dialsUrl(REPO_A)]: F.dials({ dials: [F.dial("engine_spawn", { label: null, allowed_dispositions: null })] }) },
      empty: { ["GET " + commandsUrl(REPO_A) + "?limit=50"]: F.commands([]), ["GET " + dialsUrl(REPO_A)]: F.dials({ dials: [] }) },
      failed: { ["GET " + commandsUrl(REPO_A) + "?limit=50"]: fail(500, "x"), ["GET " + dialsUrl(REPO_A)]: fail(500, "x") },
    };
    for (const [name, routes] of Object.entries(states)) {
      const { t } = await operating(routes);
      await t.refresh();
      for (const text of strings(t.view().operate)) expect(text, name).not.toMatch(bad);
      expect(texts(t.view().operate), name).not.toContain("onerror");
    }
  });
  it("the engine dial wording and the closed command sets match the protocol", () => {
    expect(ENGINE_DIALS).toEqual(["engine_spawn", "engine_merge", "engine_spec_ready"]);
    expect(OP_WORDS.operateOff).toBe("Operate is off.");
  });
});

describe("halt: the state, who sees controls, the questions and the requests", () => {
  const e = (status, code, extra = {}) => Object.assign(new Error("server text that must never be shown"), { status, code, ...extra });
  const HALT = "POST " + haltUrl(REPO_A), CLEAR = "POST " + clearHaltUrl(REPO_A);
  const ok = (over = {}) => ({ [HALT]: { halt_epoch: 1, halted: true, applied: false }, [CLEAR]: { halt_epoch: 1, halted: false }, ...over });
  const withRepo = (repoOver, settingsOver = {}, routes = {}) => ({ ["GET " + SETTINGS_URL]: F.settings({ operate_enabled: true, ...settingsOver }), ["GET " + REPOS_URL]: F.list([F.repo({ operate_enabled: true, ...repoOver })]), ...ok(), ...routes });
  const halting = async (repoOver = {}, settingsOver = {}, routes = {}) => {
    const r = team({}, withRepo(repoOver, settingsOver, routes));
    await r.t.load();
    r.f.log.length = 0;
    return r;
  };
  it("the two routes are the halt routes of the repo, and each is one POST with an empty object", async () => {
    expect(haltUrl(REPO_A)).toBe("/api/v1/engine/repos/" + REPO_A + "/halt");
    expect(clearHaltUrl(REPO_A)).toBe("/api/v1/engine/repos/" + REPO_A + "/halt/clear");
    const call = vi.fn(async () => ({}));
    await createTeamApi(call).halt(REPO_A);
    await createTeamApi(call).clearHalt(REPO_A);
    expect(call.mock.calls.map((c) => c.slice(0, 3))).toEqual([["POST", haltUrl(REPO_A), {}], ["POST", clearHaltUrl(REPO_A), {}]]);
  });
  it("not halted: an owner sees Halt and no Clear; a member sees no controls and no chip", async () => {
    const owner = await halting();
    expect(owner.t.view().halt).toMatchObject({ state: "none", chip: "", canHalt: true, canClear: false, confirm: null });
    const member = await halting({}, { can_edit: false });
    expect(member.t.view().halt).toMatchObject({ state: "none", canHalt: false, canClear: false });
  });
  it("halting: the chip reads Halting…, and Clear halt is offered to an owner only", async () => {
    const owner = await halting({ halted: true, halt_pending: true });
    expect(owner.t.view().halt).toMatchObject({ state: "pending", chip: "Halting…", canHalt: false, canClear: true, text: HALT_WORDS.pending });
    const member = await halting({ halted: true, halt_pending: true }, { can_edit: false });
    expect(member.t.view().halt).toMatchObject({ state: "pending", chip: "Halting…", canHalt: false, canClear: false });
  });
  it("halted: says who halted it and when, to an owner and to a member; the name is isolated text, never markup", async () => {
    const at = F.iso(5 * 60);
    const by = { id: "u0000000-0000-4000-8000-000000000009", display_name: "Olive <b>Owner</b>" };
    const hh = (iso) => hm(iso);
    for (const settings of [{}, { can_edit: false }]) {
      const r = await halting({ halted: true, halted_at: at, halted_by: by }, settings);
      const w = r.t.view().halt.by;
      expect(w.text).toBe("Halted by Olive <b>Owner</b> at " + hh(at));
      expect(w.parts).toEqual(["Halted by ", { bdi: "Olive <b>Owner</b>" }, " at " + hh(at)]);
    }
    // A halt from before the author was recorded, or an author who has left the account: the time alone, never "null" or "undefined".
    for (const halted_by of [null, undefined, { id: by.id, display_name: "" }, "x"]) {
      const w = (await halting({ halted: true, halted_at: at, halted_by })).t.view().halt.by;
      expect(w.text).toBe("Halted at " + hh(at));
      expect(w.text).not.toMatch(/null|undefined/);
    }
    // Yesterday's halt carries its day; a halt with no usable time, and a repo that is not halted, say nothing.
    const old = new Date(NOW - 26 * 3600 * 1000).toISOString();
    expect((await halting({ halted: true, halted_at: old, halted_by: by })).t.view().halt.by.text).toMatch(/^Halted by Olive <b>Owner<\/b> at \d\d-\d\d \d\d:\d\d$/);
    expect((await halting({ halted: true, halted_at: null, halted_by: by })).t.view().halt.by).toBeNull();
    expect((await halting({ halted: true, halted_at: "soon", halted_by: by })).t.view().halt.by).toBeNull();
    expect((await halting({ halted: false, halted_at: at, halted_by: by })).t.view().halt.by).toBeNull();
  });
  it("halted: the chip reads Halted, in the owner's view and the member's", async () => {
    const owner = await halting({ halted: true });
    expect(owner.t.view().halt).toMatchObject({ state: "halted", chip: "Halted", canHalt: false, canClear: true, text: HALT_WORDS.halted });
    const member = await halting({ halted: true }, { can_edit: false });
    expect(member.t.view().halt).toMatchObject({ state: "halted", chip: "Halted", canClear: false, canHalt: false });
    expect(member.t.view().operate).toEqual({ show: false });
  });
  it("Halt works while operate is off, and watch off shows no halt at all", async () => {
    const off = await halting({ operate_enabled: false }, { operate_enabled: false });
    expect(off.t.view().halt.canHalt).toBe(true);
    expect(await off.t.operate.pause()).toBe(false); // everything else stays locked
    const watchOff = await halting({}, { watch_enabled: false });
    expect(watchOff.t.view().halt).toBeUndefined();
    watchOff.t.operate.askHalt("halt");
    expect(await watchOff.t.operate.halt()).toBe(false);
    expect(sends(watchOff.f)).toEqual([]);
  });
  it("Halt asks first, in plain words naming the runner; Cancel sends nothing; Yes sends one POST and closes the question", async () => {
    const { t, f } = await halting();
    t.operate.askHalt("halt");
    const c = t.view().halt.confirm;
    expect(c).toMatchObject({ kind: "halt", title: "Halt the engine?", yes: "Yes, halt" });
    expect(c.parts).toEqual(["This stops the engine on ", { bdi: "Workshop laptop" }, " now and kills its agents."]);
    expect(c.texts[0]).toContain("Every command is refused until an owner or admin clears the halt");
    t.operate.cancelHalt();
    expect(t.view().halt.confirm).toBeNull();
    expect(sends(f)).toEqual([]);
    t.operate.askHalt("halt");
    expect(await t.operate.halt()).toBe(true);
    expect(sends(f)).toEqual([["POST", haltUrl(REPO_A), {}]]);
    expect(t.state.op.confirmHalt).toBeNull();
    expect(f.log.at(-1)[0]).toBe("GET"); // the repos are read again
  });
  it("Cancel on the halt question and on the clear question sends nothing", async () => {
    const live = await halting();
    live.t.operate.askHalt("halt");
    expect(live.t.view().halt.confirm).toMatchObject({ kind: "halt" });
    live.t.operate.cancelHalt();
    expect(live.t.view().halt.confirm).toBeNull();
    expect(sends(live.f)).toEqual([]);
    const halted = await halting({ halted: true });
    halted.t.operate.askHalt("clear");
    expect(halted.t.view().halt.confirm).toMatchObject({ kind: "clear" });
    halted.t.operate.cancelHalt();
    expect(halted.t.view().halt.confirm).toBeNull();
    expect(sends(halted.f)).toEqual([]);
  });
  it("a runner with no name reads your machine, and a hostile name stays a text part", async () => {
    const a = await halting({ runner_name: "" });
    a.t.operate.askHalt("halt");
    expect(a.t.view().halt.confirm.parts[1]).toBe("your machine");
    const b = await halting({ runner_name: HOSTILE });
    b.t.operate.askHalt("halt");
    expect(b.t.view().halt.confirm.parts[1]).toEqual({ bdi: HOSTILE });
  });
  it("Clear halt has its own question, says the engine is not started and that a local stop is not lifted, and sends one POST", async () => {
    const { t, f } = await halting({ halted: true });
    t.operate.askHalt("clear");
    const c = t.view().halt.confirm;
    expect(c).toMatchObject({ kind: "clear", title: "Clear the halt?", yes: "Yes, clear it" });
    expect(c.parts.join("")).toContain("The engine is not started for you");
    expect(c.texts[0]).toContain("does not lift that");
    expect(await t.operate.clearHalt()).toBe(true);
    expect(sends(f)).toEqual([["POST", clearHaltUrl(REPO_A), {}]]);
  });
  it("a press that does not fit the state sends nothing: Halt on a halted repo, Clear on a live one, a member, a save in flight", async () => {
    const halted = await halting({ halted: true });
    halted.t.operate.askHalt("halt");
    expect(halted.t.state.op.confirmHalt).toBeNull();
    expect(await halted.t.operate.halt()).toBe(false);
    const live = await halting();
    live.t.operate.askHalt("clear");
    expect(live.t.state.op.confirmHalt).toBeNull();
    expect(await live.t.operate.clearHalt()).toBe(false);
    const member = await halting({}, { can_edit: false });
    expect(await member.t.operate.halt()).toBe(false);
    expect(sends(halted.f).concat(sends(live.f), sends(member.f))).toEqual([]);
    const busy = await halting({}, {}, { [HALT]: () => new Promise(() => {}) });
    const first = busy.t.operate.halt();
    expect(busy.t.view().halt.locked).toBe(true);
    expect(busy.t.view().halt.why).toBe(HALT_WORDS.busy);
    expect(await busy.t.operate.halt()).toBe(false);
    expect(sends(busy.f)).toHaveLength(1);
    void first;
  });
  it("the question closes when the state changes under it: someone else halted, or cleared", async () => {
    const { t, f } = await halting();
    t.operate.askHalt("halt");
    f.routes["GET " + REPOS_URL] = F.list([F.repo({ operate_enabled: true, halted: true })]);
    await t.refresh();
    expect(t.view().halt.confirm).toBeNull();
    expect(t.view().halt.stale).toBe(true);
    t.operate.cancelHalt();
    t.operate.askHalt("clear");
    f.routes["GET " + REPOS_URL] = F.list([F.repo({ operate_enabled: true })]);
    await t.refresh();
    expect(t.view().halt.confirm).toBeNull();
  });
  it("opening a halt question closes a stop question and the other way round", async () => {
    const { t } = await halting();
    t.operate.askStop("a1b2c3d4e5f60718");
    t.operate.askHalt("halt");
    expect(t.state.op.confirmStop).toBeNull();
    expect(t.state.op.confirmHalt).toBe("halt");
    t.operate.askStop("a1b2c3d4e5f60718");
    expect(t.state.op.confirmHalt).toBeNull();
  });
  it("every refusal is a plain sentence, never the server's text; an unknown outcome says the halt may not have gone through", () => {
    expect(haltFailure(e(403, "forbidden"), false)).toBe("Only an owner or admin can halt the engine.");
    expect(haltFailure(e(403, "session_required"), true)).toBe("Only an owner or admin, signed in, can clear a halt.");
    expect(haltFailure(e(401, "unauthorized"), false)).toBe(HALT_WORDS.signedOut);
    expect(haltFailure(e(404, "not_found"), false)).toBe(HALT_WORDS.gone);
    expect(haltFailure(e(429, "rate_limited", { retryAfter: 8 }), false)).toBe("Try again in 8 seconds.");
    for (const x of [e(400, "x"), e(409, "x"), e(422, "x")]) { expect(haltFailure(x, false)).toBe(HALT_WORDS.haltRefused); expect(haltFailure(x, true)).toBe(HALT_WORDS.clearRefused); }
    for (const x of [e(500, "server_error"), e(0, "offline"), e(0, "timeout"), null]) { expect(haltFailure(x, false)).toBe(HALT_WORDS.haltUnknown); expect(haltFailure(x, true)).toBe(HALT_WORDS.clearUnknown); }
    for (const w of Object.values(HALT_WORDS)) expect(w).not.toMatch(bad);
  });
  it("a refused halt shows the sentence as a note and reads the repos again, so what is true is shown", async () => {
    for (const [err, sentence] of [[e(403, "forbidden"), HALT_WORDS.haltForbidden], [e(409, "x"), HALT_WORDS.haltRefused], [e(500, "server_error"), HALT_WORDS.haltUnknown]]) {
      const { t, f } = await halting({}, {}, { [HALT]: err });
      t.operate.askHalt("halt");
      expect(await t.operate.halt()).toBe(false);
      expect(t.view().halt.note).toBe(sentence);
      expect(t.state.op.saving).toBe(false);
      expect(f.log.filter(([m]) => m === "GET").length).toBeGreaterThan(0);
      expect(texts(t.view().halt)).not.toContain("server text");
    }
  });
  it("a refused clear says so the same way, and the note is gone once another question opens", async () => {
    const { t } = await halting({ halted: true }, {}, { [CLEAR]: e(403, "forbidden") });
    expect(await t.operate.clearHalt()).toBe(false);
    expect(t.view().halt.note).toBe(HALT_WORDS.clearForbidden);
    t.operate.askHalt("clear");
    expect(t.view().halt.note).toBe("");
  });
  it("no halt string holds null, undefined or NaN in any state", async () => {
    for (const repoOver of [{}, { halted: true }, { halted: true, halt_pending: true }, { halt_pending: true }, { runner_name: HOSTILE, halted: true }]) {
      const { t } = await halting(repoOver);
      t.operate.askHalt(repoOver.halted || repoOver.halt_pending ? "clear" : "halt");
      for (const text of strings(t.view().halt)) expect(text).not.toMatch(bad);
    }
  });
  it("the halt flags are read as booleans and nothing else", () => {
    expect(readRepos([{ repo_id: REPO_A, full_name: "a/b", halted: "yes", halt_pending: 1 }])[0]).toMatchObject({ halted: false, haltPending: false });
    expect(readRepos([{ repo_id: REPO_A, full_name: "a/b", halted: true, halt_pending: true }])[0]).toMatchObject({ halted: true, haltPending: true });
  });
});
