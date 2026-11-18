// apps/workspace/test/team-push.test.mjs
//
// The Team app on push: a notice names the panels that changed, and only those are read again, at most once per panel per 10 s.
// Pinned here: the coalescer on its own (union across a window, one read per part per window, a burst is not a storm), the controller's requests per
// notice (counted on a fake client), the idle budget, the counted-GET budget of an hour, and a real SSE connection (a local server speaking the account
// stream's framing, read by the shell's real live client) driving the controller. The page itself is driven in e2e/team.spec.ts.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createLive } from "../shell/core/cloud-live.js";
import { REPOS_URL, SETTINGS_URL, commandsUrl, createTeamApi, dialsUrl, logUrl, panelUrl } from "../apps/team/team-model.js";
import { DEBOUNCE_MS, NOTICE_PANELS, PANEL_GATE_MS, READ_NAMES, SAFETY_MS, createCoalescer, createTeam, describe as describeState, noticeNames } from "../apps/team/team-model.js";
import { REPO_A, makeFixtures } from "./fixtures/team/fixtures.mjs";

const NOW = Date.parse("2026-11-16T15:00:00.000Z");
const F = makeFixtures(NOW);
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A clock and timers the test moves by hand; advance() runs every timer that falls due, in order, at its own time. */
function sched() {
  let time = 1_000_000, id = 0;
  const timers = new Map();
  const s = {
    now: () => time,
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: time + Math.max(0, ms), every: 0 }); return id; },
    clearTimer: (i) => timers.delete(i),
    setRepeat: (fn, ms) => { timers.set(++id, { fn, at: time + ms, every: ms }); return id; },
    clearRepeat: (i) => timers.delete(i),
    count: () => timers.size,
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [i, t] = next;
        time = Math.max(time, t.at);
        if (t.every) t.at += t.every; else timers.delete(i);
        t.fn();
        await flush();
      }
      time = end;
      await flush();
    },
  };
  return s;
}

describe("noticeNames: which parts a notice asks for", () => {
  it("a closed list of known names narrows the read; asks has no reader in this app", () => {
    expect(noticeNames({ panels: ["lanes", "log", "lanes"] })).toEqual(["lanes", "log"]);
    expect(noticeNames({ panels: ["status"] })).toEqual(["status"]);
    expect(noticeNames({ panels: ["asks", "log"] })).toEqual(["log"]);
    expect(noticeNames({ panels: ["asks"] })).toEqual([]);
  });
  it("a missing, empty, mistyped or unknown entry means everything", () => {
    for (const data of [undefined, null, {}, { panels: [] }, { panels: "lanes" }, { panels: ["lanes", "cost"] }, { panels: ["lanes", 3] }, { panels: [null] }, { panels: { 0: "lanes" } }]) {
      expect(noticeNames(data)).toEqual(READ_NAMES);
    }
  });
  it("every name the cloud may send is in the closed set", () => {
    expect(NOTICE_PANELS).toEqual(["agents", "lanes", "gates", "asks", "log", "plan", "stats", "usage", "status"]);
  });
});

describe("the coalescer", () => {
  function rig() {
    const s = sched();
    const runs = [];
    const c = createCoalescer({ now: s.now, setTimer: s.setTimer, clearTimer: s.clearTimer, run: (names) => runs.push([s.now() - 1_000_000, names]) });
    return { s, c, runs };
  }
  it("reads the parts named after the settle, together", async () => {
    const { s, c, runs } = rig();
    c.note(["lanes", "log"]);
    await s.advance(DEBOUNCE_MS - 1);
    expect(runs).toEqual([]);
    await s.advance(1);
    expect(runs).toEqual([[DEBOUNCE_MS, ["lanes", "log"]]]);
  });
  it("a part named again inside its window waits for the end of it, and is read once with whatever else was named meanwhile", async () => {
    const { s, c, runs } = rig();
    c.note(["lanes"]);
    await s.advance(1000); // lanes read at 1000
    await s.advance(500);
    c.note(["lanes", "log"]); // 1500: log is read at 2500; lanes waits for 11000
    await s.advance(3500);
    c.note(["lanes", "agents", "log"]); // 5000: agents at 6000; log was read at 2500, so it waits for 12500; lanes is already queued
    await s.advance(20000);
    expect(runs).toEqual([[1000, ["lanes"]], [2500, ["log"]], [6000, ["agents"]], [11000, ["lanes"]], [12500, ["log"]]]);
  });
  it("names that become due together are read in one call (the union of the window)", async () => {
    const { s, c, runs } = rig();
    c.mark(["lanes", "log", "stats"]); // read at 0
    await s.advance(100);
    c.note(["lanes"]);
    await s.advance(2000);
    c.note(["log"]);
    await s.advance(2000);
    c.note(["stats", "lanes"]);
    await s.advance(20000);
    expect(runs).toEqual([[10000, ["lanes", "log", "stats"]]]);
  });
  it("a burst of 200 notices in 20 s reads a part at most once in any 10 s", async () => {
    const { s, c, runs } = rig();
    for (let i = 0; i < 200; i++) { c.note(["lanes", "log"]); await s.advance(100); }
    await s.advance(20000);
    const at = runs.filter(([, n]) => n.includes("lanes")).map(([t]) => t);
    expect(at.length).toBeGreaterThan(1);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(PANEL_GATE_MS);
    expect(at.length).toBeLessThanOrEqual(3); // 20 s of notices and the trailing read: never one read per notice
  });
  it("a full read drops the queued parts, and starts their window", async () => {
    const { s, c, runs } = rig();
    c.note(["lanes"]);
    c.mark(["lanes"]);
    await s.advance(5000);
    expect(runs).toEqual([]);
    c.note(["lanes"]);
    await s.advance(20000);
    expect(runs).toEqual([[10000, ["lanes"]]]); // 10 s after the full read, not 1 s after the notice
  });
  it("cancel leaves nothing waiting and no timer", async () => {
    const { s, c, runs } = rig();
    c.note(["lanes"]);
    c.cancel();
    await s.advance(30000);
    expect(runs).toEqual([]);
    expect(s.count()).toBe(0);
  });
});

/** The controller on a fake client that counts every GET by path. */
function rig(over = {}) {
  const s = sched();
  const reads = [];
  const routes = {
    ["GET " + SETTINGS_URL]: () => F.settings(),
    ["GET " + REPOS_URL]: () => F.list([F.repo()]),
    ["GET " + panelUrl("agents", REPO_A)]: () => F.envelope([F.agent()]),
    ["GET " + panelUrl("lanes", REPO_A)]: () => F.envelope([F.lane()]),
    ["GET " + panelUrl("gates", REPO_A)]: () => F.envelope([F.gate()]),
    ["GET " + panelUrl("log", REPO_A)]: () => F.envelope([F.logLine()]),
    ["GET " + panelUrl("plan", REPO_A)]: () => F.plan(),
    ["GET " + panelUrl("stats", REPO_A)]: () => F.stats(),
    ["GET " + panelUrl("usage", REPO_A)]: () => F.usage(),
    ["GET " + commandsUrl(REPO_A) + "?limit=50"]: () => F.commands([]),
    ["GET " + dialsUrl(REPO_A)]: () => F.dials(),
    ...over,
  };
  const call = async (method, path) => {
    reads.push({ at: s.now(), path });
    const r = routes[method + " " + path];
    if (!r) throw Object.assign(new Error("x"), { status: 404 });
    const v = r();
    if (v instanceof Error) throw v;
    return v;
  };
  const t = createTeam({ client: createTeamApi(call), now: s.now, setTimer: s.setTimer, clearTimer: s.clearTimer, setRepeat: s.setRepeat, clearRepeat: s.clearRepeat });
  let hidden = false, notify = () => {}, nudge = () => {}, shown = () => {};
  const st = { hide: (v) => { hidden = v; }, notice: (panels, repo = REPO_A) => notify({ id: "e", type: "engine.changed", created_at: "x", data: { repo_id: repo, session_id: "s", last_seq: 1, ...(panels === undefined ? {} : { panels }) } }) };
  const start = async () => {
    await t.load();
    t.start({ hidden: () => hidden, subscribe: (fn) => { nudge = fn; return () => {}; }, listen: (type, fn) => { notify = fn; return () => {}; }, visibility: (fn) => { shown = fn; return () => {}; } });
    reads.length = 0;
  };
  const paths = () => reads.map((r) => r.path);
  const url = (k) => panelUrl(k, REPO_A);
  return { s, t, reads, paths, start, url, nudge: (why) => nudge(why), shown: () => shown(), ...st };
}

describe("a read the person causes never waits on the coalescer", () => {
  const paged = () => ({ ["GET " + panelUrl("log", REPO_A)]: () => F.envelope([F.logLine()], { next_cursor: "c1" }), ["GET " + logUrl(REPO_A, "c1")]: () => F.envelope([F.logLine({ line_id: "older0000000001" })]) });
  it("Load older right after a notice-driven log read, and again inside its 10 s window, is requested at once", async () => {
    const r = rig(paged());
    await r.start();
    await r.s.advance(60_000);
    r.notice(["log"]);
    await r.s.advance(DEBOUNCE_MS); // the notice-driven log read happens now and starts the log's 10 s window
    expect(r.paths()).toEqual([r.url("log")]);
    r.reads.length = 0;
    r.notice(["log"]); // a second notice is now held until the window ends
    await r.s.advance(500);
    expect(r.paths()).toEqual([]);
    const before = r.s.now();
    await r.t.loadOlder(); // the person scrolled to the end: no timer is waited on
    expect(r.reads.map((x) => [x.at - before, x.path])).toEqual([[0, logUrl(REPO_A, "c1")]]);
    expect(r.t.state.log.rows).toHaveLength(2);
  });
  it("Load older does not move the log's window: a notice after it is still read when the earlier read's window ends, not later", async () => {
    const r = rig(paged());
    await r.start();
    await r.s.advance(60_000);
    r.notice(["log"]);
    await r.s.advance(DEBOUNCE_MS);
    const readAt = r.s.now();
    r.reads.length = 0;
    await r.s.advance(4000);
    await r.t.loadOlder();
    r.notice(["log"]);
    await r.s.advance(30_000);
    const logReads = r.reads.filter((x) => x.path === r.url("log")).map((x) => x.at - readAt);
    expect(logReads).toEqual([PANEL_GATE_MS]);
  });
});


describe("a resync is not coalesced", () => {
  it("the stream coming back (or the server saying events were missed) reads everything at once, with no settle and no timer to wait on", async () => {
    let n = 1;
    const r = rig({ ["GET " + panelUrl("log", REPO_A)]: () => F.envelope(F.logLines(n)) });
    await r.start();
    expect(r.t.state.panels.log.items).toHaveLength(1);
    n = 100; // the log grew while the stream was down
    r.nudge("resync");
    await r.s.advance(0);
    expect(r.paths()).toHaveLength(11); // settings, repos, seven panels, commands, dials: all, before any timer has run
    expect(r.t.state.panels.log.items).toHaveLength(100);
  });
  it("a notice right behind a resync read is held to the window that read started, so the pair is two reads of a part at most 10 s apart", async () => {
    const r = rig();
    await r.start();
    await r.s.advance(60_000);
    r.reads.length = 0;
    r.nudge("resync");
    await r.s.advance(0);
    const at = r.s.now();
    r.notice(["log"]);
    await r.s.advance(30_000);
    expect(r.reads.filter((x) => x.path === r.url("log")).map((x) => x.at - at)).toEqual([0, PANEL_GATE_MS]);
  });
  it("a hidden tab ignores a resync", async () => {
    const r = rig();
    await r.start();
    r.hide(true);
    r.nudge("resync");
    await r.s.advance(30_000);
    expect(r.paths()).toEqual([]);
  });
});

describe("the Team app on push: requests per notice", () => {
  it("a lanes notice reads the lanes panel and nothing else", async () => {
    const r = rig();
    await r.start();
    await r.s.advance(60_000);
    r.notice(["lanes"]);
    await r.s.advance(DEBOUNCE_MS);
    expect(r.paths()).toEqual([r.url("lanes")]);
  });
  it("a usage notice reads the usage panel at once (after the settle), and only that", async () => {
    const r = rig();
    await r.start();
    await r.s.advance(60_000);
    r.notice(["usage"]);
    await r.s.advance(DEBOUNCE_MS);
    expect(r.paths()).toEqual([r.url("usage")]);
  });
  it("a status notice reads the repo list only (liveness, last heard, halt): not the settings, not a panel, not the operate half", async () => {
    const r = rig();
    await r.start();
    await r.s.advance(60_000);
    r.notice(["status"]);
    await r.s.advance(DEBOUNCE_MS);
    expect(r.paths()).toEqual([REPOS_URL]);
  });
  it("an asks notice names nothing the Team app reads: no request at all", async () => {
    const r = rig();
    await r.start();
    await r.s.advance(60_000);
    r.notice(["asks"]);
    await r.s.advance(30_000);
    expect(r.paths()).toEqual([]);
  });
  it("notices that arrive inside one window are read together: the union, each part once", async () => {
    const r = rig();
    await r.start();
    await r.s.advance(60_000);
    r.notice(["lanes"]);
    await r.s.advance(300);
    r.notice(["log"]);
    await r.s.advance(300);
    r.notice(["lanes", "stats"]);
    await r.s.advance(5000);
    const got = r.paths();
    expect(got.filter((p) => p === r.url("lanes"))).toHaveLength(1);
    expect(got.filter((p) => p === r.url("log"))).toHaveLength(1);
    expect(got.filter((p) => p === r.url("stats"))).toHaveLength(1);
    expect(got).toHaveLength(3);
  });
  it("no panels field, an empty one, or an unknown name re-reads everything, still once", async () => {
    for (const panels of [undefined, [], ["cost"], ["lanes", "cost"]]) {
      const r = rig();
      await r.start();
      await r.s.advance(60_000);
      r.notice(panels);
      r.notice(panels);
      await r.s.advance(DEBOUNCE_MS);
      const got = r.paths();
      expect(got.filter((p) => p === SETTINGS_URL)).toHaveLength(1);
      expect(got.filter((p) => p === REPOS_URL)).toHaveLength(1);
      for (const k of ["agents", "lanes", "gates", "log", "plan", "stats", "usage"]) expect(got.filter((p) => p === r.url(k))).toHaveLength(1);
      expect(got).toHaveLength(11); // settings, repos, seven panels, commands and dials
    }
  });
  it("a notice for another repo reads nothing", async () => {
    const r = rig();
    await r.start();
    await r.s.advance(60_000);
    r.notice(["lanes"], "someone-elses-repo");
    await r.s.advance(30_000);
    expect(r.paths()).toEqual([]);
  });
  it("a burst of 20 notices in 2 s reads each named panel once, and nothing else", async () => {
    const r = rig();
    await r.start();
    await r.s.advance(60_000);
    for (let i = 0; i < 20; i++) { r.notice(["lanes", "log"]); await r.s.advance(100); }
    await r.s.advance(DEBOUNCE_MS + 500);
    expect(r.paths().sort()).toEqual([r.url("lanes"), r.url("log")].sort());
    await r.s.advance(9000); // the rest of the window: the notices of the second half were queued behind the gate and are read once, at its end
    expect(r.paths().filter((p) => p === r.url("lanes"))).toHaveLength(2);
    expect(r.paths().filter((p) => p === r.url("log"))).toHaveLength(2);
    await r.s.advance(30_000);
    expect(r.paths()).toHaveLength(4); // and nothing after that: no trailing read for notices already read
  });
  it("a panel that fails on a partial read marks that panel only, and keeps the others", async () => {
    let n = 0;
    const r = rig({ ["GET " + panelUrl("lanes", REPO_A)]: () => (++n === 1 ? F.envelope([F.lane()]) : Object.assign(new Error("x"), { status: 500 })) });
    await r.start();
    await r.s.advance(60_000);
    r.notice(["lanes"]);
    await r.s.advance(DEBOUNCE_MS);
    const v = describeState(r.t.state, NOW);
    expect(v.lanes.failed).toBe(false); // the last good lanes stay on screen
    expect(r.t.state.failedKeys).toEqual(["lanes"]);
    expect(v.refreshFailed).toBe("");
    expect(v.agents.failed).toBe(false);
  });
});

const PENDING = () => F.commands([F.command()]);
const SETTLED = () => F.commands([F.command({ state: "applied", acked_at: new Date(NOW).toISOString() })]);
describe("commands and dials", () => {
  it("while a command is waiting, every notice-driven read includes the commands and the dials; with none waiting it does not", async () => {
    const r = rig({ ["GET " + commandsUrl(REPO_A) + "?limit=50"]: PENDING });
    await r.start();
    await r.s.advance(60_000);
    r.reads.length = 0;
    r.notice(["lanes"]);
    await r.s.advance(DEBOUNCE_MS + 10_000); // the commands were last read by the 10 s repeat, so they wait out the gate like any part
    expect(r.paths().filter((p) => p === r.url("lanes"))).toHaveLength(1);
    expect(r.paths()).toContain(commandsUrl(REPO_A) + "?limit=50");
    expect(r.paths()).toContain(dialsUrl(REPO_A));
    expect(r.paths().filter((p) => p !== r.url("lanes") && !p.includes("/commands") && !p.includes("decision-settings"))).toEqual([]);
    const q = rig({ ["GET " + commandsUrl(REPO_A) + "?limit=50"]: SETTLED });
    await q.start();
    await q.s.advance(60_000);
    q.reads.length = 0;
    q.notice(["lanes"]);
    await q.s.advance(DEBOUNCE_MS);
    expect(q.paths()).toEqual([q.url("lanes")]);
  });
  it("while a command is waiting, the commands and dials alone are read every 10 s with no notice, and it stops when nothing waits", async () => {
    let answer = PENDING;
    const r = rig({ ["GET " + commandsUrl(REPO_A) + "?limit=50"]: () => answer() });
    await r.start();
    await r.s.advance(10_000);
    expect(r.paths()).toEqual([commandsUrl(REPO_A) + "?limit=50", dialsUrl(REPO_A)]);
    await r.s.advance(10_000);
    expect(r.paths()).toHaveLength(4);
    answer = SETTLED;
    await r.s.advance(10_000); // this read finds it settled
    expect(r.paths()).toHaveLength(6);
    expect(describeState(r.t.state, NOW).operate.commands.rows[0].state).toBe("applied");
    await r.s.advance(60_000);
    expect(r.paths()).toHaveLength(6);
  });
  it("a hidden tab reads no commands either", async () => {
    const r = rig({ ["GET " + commandsUrl(REPO_A) + "?limit=50"]: PENDING });
    await r.start();
    r.hide(true);
    await r.s.advance(60_000);
    expect(r.paths()).toEqual([]);
  });
});

describe("resync, retry and the safety timer", () => {
  it("a resync nudge reads everything even right after a full read; a plain nudge does not", async () => {
    const r = rig();
    await r.start();
    await r.s.advance(30_000);
    r.nudge();
    await r.s.advance(DEBOUNCE_MS);
    expect(r.paths()).toEqual([]);
    r.nudge("resync");
    await r.s.advance(DEBOUNCE_MS);
    expect(r.paths()).toHaveLength(11);
  });
  it("a failed partial read is tried once more after 10 s, and only once", async () => {
    let n = 0;
    const r = rig({ ["GET " + panelUrl("lanes", REPO_A)]: () => (++n === 1 ? F.envelope([F.lane()]) : Object.assign(new Error("x"), { status: 500 })) });
    await r.start();
    await r.s.advance(60_000);
    r.reads.length = 0;
    r.notice(["lanes"]);
    await r.s.advance(DEBOUNCE_MS);
    expect(r.paths()).toEqual([r.url("lanes")]);
    await r.s.advance(10_000);
    expect(r.paths()).toEqual([r.url("lanes"), r.url("lanes")]);
    await r.s.advance(20_000);
    expect(r.paths()).toHaveLength(2);
  });
  it("the retry succeeds quietly: a recovered part is cleared and nothing more is read", async () => {
    let n = 0;
    const r = rig({ ["GET " + panelUrl("lanes", REPO_A)]: () => (++n === 2 ? Object.assign(new Error("x"), { status: 500 }) : F.envelope([F.lane()])) });
    await r.start();
    await r.s.advance(60_000);
    r.notice(["lanes"]);
    await r.s.advance(DEBOUNCE_MS + 10_000 + 1_000);
    expect(r.t.state.failedKeys).toEqual([]);
  });
  it("the safety read comes 120 s after the last full read, whatever caused it: a full read at 101 s means the next at about 221 s, not 361 s", async () => {
    const r = rig();
    await r.start();
    await r.s.advance(100_000);
    r.notice(undefined); // names nothing: everything is read
    await r.s.advance(DEBOUNCE_MS);
    expect(r.paths()).toHaveLength(11);
    await r.s.advance(118_000); // 219 s: the timer that would have fired at 120 s is gone
    expect(r.paths()).toHaveLength(11);
    await r.s.advance(3_000); // 222 s
    expect(r.paths()).toHaveLength(22);
    await r.s.advance(121_000); // and the one after that 120 s later
    expect(r.paths()).toHaveLength(33);
  });
});

describe("a hidden tab", () => {
  it("ignores notices and the safety timer for an hour, then makes one catch-up read of everything when shown", async () => {
    const r = rig();
    await r.start();
    r.hide(true);
    for (let i = 0; i < 150; i++) { r.notice(["lanes"]); r.notice(undefined); await r.s.advance(24_000); }
    r.nudge();
    expect(r.paths()).toEqual([]);
    r.hide(false);
    r.shown();
    await flush();
    expect(r.paths()).toHaveLength(11);
    await r.s.advance(DEBOUNCE_MS * 2);
    expect(r.paths()).toHaveLength(11); // the ignored notices were not queued behind it
  });
});

describe("the request budget", () => {
  it("idle: nothing arrives, nothing is requested, until the 120 s safety read", async () => {
    const r = rig();
    await r.start();
    await r.s.advance(SAFETY_MS - 1);
    expect(r.paths()).toEqual([]);
    await r.s.advance(1);
    expect(r.paths()).toHaveLength(11);
    await r.s.advance(SAFETY_MS - 1);
    expect(r.paths()).toHaveLength(11);
    await r.s.advance(1);
    expect(r.paths()).toHaveLength(22);
  });
  it("the stream's own nudge adds no read inside a safety interval of a full read", async () => {
    const r = rig();
    await r.start();
    await r.s.advance(30_000);
    r.nudge();
    await r.s.advance(30_000);
    expect(r.paths()).toEqual([]);
    await r.s.advance(SAFETY_MS - 60_000);
    expect(r.paths()).toHaveLength(11);
  });
  it("one visible owner tab on a repo receiving 150 batches an hour makes at most 700 GETs with the panels the cloud names", async () => {
    // The mix a repo produces, from the kind-to-panel table the cloud writes: log lines, heartbeats and ticks (status), agent and merge events, asks, usage, plan.
    const mix = [["log"], ["status"], ["log"], ["status"], ["agents", "log", "stats"], ["log"], ["status"], ["lanes", "log", "gates", "stats"], ["stats", "usage"], ["asks", "log"], ["plan"], ["log"], ["status"], ["log"], ["status"]];
    const r = rig();
    await r.start();
    for (let i = 0; i < 150; i++) { await r.s.advance(24_000); r.notice(mix[i % mix.length]); }
    await r.s.advance(60_000);
    expect(r.reads.length).toBeLessThanOrEqual(700);
    expect(r.reads.length).toBeGreaterThan(150); // the budget is not met by reading nothing
    // and a repo whose every notice names nothing is held to one full read per 10 s, which is why the cloud names its panels
    for (const p of ["lanes", "log"]) {
      const at = r.reads.filter((x) => x.path === r.url(p)).map((x) => x.at);
      for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(PANEL_GATE_MS);
    }
  });
});

describe("the data age follows the status read", () => {
  it("a repo last heard long ago reads stale with no panel read since; a later status read makes it live again", async () => {
    const heard = { at: NOW - 20_000 };
    const r = rig({ ["GET " + REPOS_URL]: () => F.list([F.repo({ last_heard_at: new Date(heard.at).toISOString() })]) });
    await r.start();
    const fresh = describeState(r.t.state, NOW);
    expect(fresh.agents.warn).toBe("");
    expect(describeState(r.t.state, NOW + 600_000).agents.warn).toMatch(/^last seen \d+ min ago$/);
    expect(describeState(r.t.state, NOW + 280_000).agents.warn).toBe(""); // heard 299 s ago: an idle bridge's status is up to 300 s apart
    expect(describeState(r.t.state, NOW - 20_000 + 451_000).agents.warn).not.toBe(""); // just over 450 s (1.5 times the 300 s status interval)
    heard.at = NOW + 390_000; // a heartbeat arrived: its notice names status only
    await r.s.advance(60_000);
    r.notice(["status"]);
    await r.s.advance(DEBOUNCE_MS);
    expect(r.paths()).toEqual([REPOS_URL]);
    expect(describeState(r.t.state, NOW + 400_000).agents.warn).toBe("");
  });
});

// A local server that speaks the account stream's framing (id, event and a JSON AccountEventDTO in data; a comment heartbeat) and refuses what the real
// one refuses: any path but the bare /api/v1/events, a request that does not ask for text/event-stream, one with an Authorization header.
function streamServer() {
  const open = new Set();
  const seen = { requests: [], refused: [] };
  const server = createServer((req, res) => {
    seen.requests.push({ url: req.url, lastEventId: req.headers["last-event-id"] ?? "" });
    if (req.url !== "/api/v1/events" || req.headers.accept !== "text/event-stream" || req.headers.authorization) { seen.refused.push(req.url); res.writeHead(400).end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    res.write(": hb\n\n");
    open.add(res);
    res.on("close", () => open.delete(res));
  });
  let n = 0;
  return {
    seen,
    listen: () => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port))),
    emit: (data) => { n += 1; const dto = { id: "ev" + n, type: "engine.changed", created_at: new Date().toISOString(), data }; for (const res of open) res.write("id: cur-" + n + "\nevent: engine.changed\ndata: " + JSON.stringify(dto) + "\n\n"); },
    close: () => new Promise((ok) => { for (const res of open) res.end(); server.closeAllConnections(); server.close(() => ok()); }),
    open: () => open.size,
  };
}

describe("over a real connection", () => {
  it("notices read by the shell's live client reach the model with their panels, and drive exactly the reads above", async () => {
    const srv = streamServer();
    const port = await srv.listen();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const win = new EventTarget();
    const live = createLive({ win, doc, locks: undefined, BroadcastChannel: undefined, getNamespace: () => "ns", signOut: () => {}, fetch: (u, init) => fetch("http://127.0.0.1:" + port + u, init) });
    const r = rig();
    await r.t.load();
    let hidden = false;
    r.t.start({ hidden: () => hidden, listen: (type, fn) => live.on(type, fn), subscribe: (fn) => live.onRefresh(fn) });
    r.reads.length = 0;
    try {
      live.start();
      for (let i = 0; i < 100 && srv.open() === 0; i++) await new Promise((ok) => setTimeout(ok, 10));
      expect(srv.open()).toBe(1);
      await r.s.advance(60_000);
      r.reads.length = 0;
      // a burst of 20, as the server writes them, then the settle
      for (let i = 0; i < 20; i++) { srv.emit({ repo_id: REPO_A, session_id: "s", last_seq: i + 1, panels: ["lanes"] }); await new Promise((ok) => setTimeout(ok, 5)); await r.s.advance(100); }
      await r.s.advance(DEBOUNCE_MS + 200);
      expect(r.reads.map((x) => x.path)).toEqual([r.url("lanes")]);
      // a notice naming a panel the cloud has never heard of is read as everything
      await r.s.advance(60_000);
      r.reads.length = 0;
      srv.emit({ repo_id: REPO_A, session_id: "s", last_seq: 99, panels: ["agents", "cost"] });
      await new Promise((ok) => setTimeout(ok, 50));
      await r.s.advance(PANEL_GATE_MS + DEBOUNCE_MS); // the safety read had just made one, so the gate holds this one back
      expect(r.reads).toHaveLength(11);
      expect(srv.seen.refused).toEqual([]);
      hidden = true;
      r.reads.length = 0;
      srv.emit({ repo_id: REPO_A, session_id: "s", last_seq: 100, panels: ["lanes"] });
      await new Promise((ok) => setTimeout(ok, 50));
      await r.s.advance(60_000);
      expect(r.reads).toEqual([]);
    } finally {
      r.t.stop();
      live.shutdown();
      await srv.close();
    }
  });
});
