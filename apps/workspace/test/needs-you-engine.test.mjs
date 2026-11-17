// apps/workspace/test/needs-you-engine.test.mjs
//
// EB-6c: the engine's open asks inside the Needs you list (needs-you-model.js), against a fake call(). What is pinned here: a row shows the repo, a fixed
// sentence per kind of ask (never the enum), D# and PR # links built from the cloud's own repo name, and its age; an ask over 7 days says it may be stale; a stale
// heartbeat, a quiet team log and the data's own "as of" are worded from the read; a cleared ask leaves on the next read; a failed engine read is one line and
// leaves every other row; `engine.changed` reads only the engine asks, 1 s after the first event of a burst; what changed is said once and the first read says nothing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ASKS_FIRST_URL, ENGINE_CHANGED, ENGINE_DEBOUNCE_MS, ENGINE_KIND_WORDS, ENGINE_MAX_REPOS, ENGINE_REPOS_URL, LIST_URL, MERGE_URL, NEEDS_HUMAN_URL, SIGN_IN_URL, STALLED_URL, WORDS,
  ageWords, arrangeRows, createNeedsYou, engineAsksUrl, engineChangeWords, engineKindWords, engineLink, engineWords, insertEngine, readAll, readEngine, readEngineAsk,
} from "../apps/needs-you/needs-you-model.js";

const NOW = Date.parse("2026-11-16T10:00:00.000Z");
const R1 = "6f1c2f5e-3d8f-4f43-8d6e-8f2f6a9b1c22";
const R2 = "6f1c2f5e-3d8f-4f43-8d6e-8f2f6a9b1c33";
const SERVER_TEXT = "server text that must never be shown";
const fail = (status, code = "x") => Object.assign(new Error(SERVER_TEXT), { status, code });
const repo = (over = {}) => ({ repo_id: R1, full_name: "acme-labs/widgets", liveness: "live", watch_enabled: true, ...over });
const ask = (over = {}) => ({ ask_id: "0123456789abcdef", ask_kind: "owner_decision", source: "team_log", discussion: 42, pr: null, raised_at: "2026-11-16T09:00:00.000Z", cleared_at: null, how: null, ...over });
const envelope = (items, over = {}) => ({ items, next_cursor: null, as_of: "2026-11-16T09:59:30.000Z", heard_age_s: 30, source_ages_s: { loop: 60, team_log: 120 }, gaps: [], missing_events: 0, ...over });
const listOf = (items) => ({ items, next_cursor: null, as_of: "2026-11-16T09:59:30.000Z", heard_age_s: 30, source_ages_s: {}, gaps: [], missing_events: 0 });

/** A call() that answers by "GET path"; a function is called each time, an Error is thrown. Every read of the rest of the list answers empty. */
function fakeCall(routes = {}) {
  const log = [];
  const all = {
    ["GET " + ASKS_FIRST_URL]: { data: [], next_cursor: null },
    ["GET " + MERGE_URL]: { items: [], not_shown: 0 },
    ["GET " + STALLED_URL]: { items: [], not_shown: 0 },
    ["GET " + SIGN_IN_URL]: { items: [] },
    ["GET " + NEEDS_HUMAN_URL]: { data: [], next_cursor: null },
    ["GET " + LIST_URL]: { requests: [], truncated: false },
    ["GET /api/cloud/auth/me"]: { is_admin: true },
    ...routes,
  };
  const call = vi.fn(async (method, path) => {
    log.push(method + " " + path);
    const r = all[method + " " + path];
    if (r === undefined) throw fail(404, "not_found");
    const v = typeof r === "function" ? r() : r;
    if (v instanceof Error) throw v;
    return v;
  });
  return { call, log };
}
const engineRoutes = (repos, asksByRepo) => ({
  ["GET " + ENGINE_REPOS_URL]: listOf(repos),
  ...Object.fromEntries(Object.entries(asksByRepo).map(([id, v]) => ["GET " + engineAsksUrl(id), v])),
});
const engineLog = (log) => log.filter((l) => l.includes("/api/v1/engine"));

describe("the words of an engine ask", () => {
  it("every kind of ask has its own fixed sentence, and the enum is never shown", () => {
    for (const kind of ["owner_decision", "merge_blocked", "credential", "budget", "review_blocked", "other", "decision"]) {
      const words = engineKindWords(kind);
      expect(words).toBe(ENGINE_KIND_WORDS[kind]);
      expect(words).not.toContain(kind);
      expect(words).not.toMatch(/_/);
    }
    expect(new Set(Object.values(ENGINE_KIND_WORDS)).size).toBe(Object.keys(ENGINE_KIND_WORDS).length);
  });

  it("a kind this page does not know reads as 'other', and a hostile or missing one is no property lookup", () => {
    for (const kind of ["something_new", "__proto__", "constructor", "toString", "", null, undefined, 5, {}]) expect(engineKindWords(kind)).toBe(ENGINE_KIND_WORDS.other);
  });

  it("ages are whole minutes, then hours, then days, and never negative", () => {
    expect([0, 59, 60, 119, 3599].map(ageWords)).toEqual(["0 min", "0 min", "1 min", "1 min", "59 min"]);
    expect([7199, 7200, 86400, 172799].map(ageWords)).toEqual(["119 min", "2 h", "24 h", "47 h"]);
    expect([172800, 86400 * 9].map(ageWords)).toEqual(["2 days", "9 days"]);
    expect([-5, NaN, undefined].map(ageWords)).toEqual(["0 min", "0 min", "0 min"]);
  });
});

describe("links built from the cloud's own repo name", () => {
  it("a Discussion and a pull request link on github.com, and nothing for a name or number that is not usable", () => {
    expect(engineLink("acme-labs/widgets", "discussions", 42)).toEqual({ href: "https://github.com/acme-labs/widgets/discussions/42", text: "D#42" });
    expect(engineLink("acme-labs/widgets", "pull", 7)).toEqual({ href: "https://github.com/acme-labs/widgets/pull/7", text: "PR #7" });
    for (const name of ["", "widgets", "a/b/c", "../x", "a/..", "./b", "a b/c", "a/b?x=1", "a/b#x", "https://evil.example/x", 'a/"onclick', "a/<b>", null, undefined, 5]) {
      expect(engineLink(name, "pull", 7), String(name)).toBeNull();
    }
    for (const n of [0, -1, 1.5, NaN, "7", null, undefined]) expect(engineLink("a/b", "pull", n), String(n)).toBeNull();
  });
});

describe("reading an engine ask", () => {
  const env = envelope([]);
  const row = readEngineAsk(repo(), env, ask({ pr: 7 }), NOW);

  it("keeps the repo, the fixed sentence, the links and the times; no id is the title", () => {
    expect(row).toMatchObject({ kind: "engine", state: "open", workItemId: "", title: "acme-labs/widgets", sentence: ENGINE_KIND_WORDS.owner_decision });
    expect(row.links.map((l) => l.text)).toEqual(["D#42", "PR #7"]);
    expect(row.raisedMs).toBe(Date.parse("2026-11-16T09:00:00.000Z"));
    expect(row.asOfMs).toBe(Date.parse(env.as_of));
    expect(row.heardAgeS).toBe(30);
    expect(row.teamLogAgeS).toBe(120);
  });

  it("an ask with neither a Discussion nor a pull request has no links, and one that does not read is dropped", () => {
    expect(readEngineAsk(repo(), env, ask({ discussion: null, pr: null }), NOW).links).toEqual([]);
    for (const bad of [null, undefined, {}, ask({ ask_id: "" }), ask({ ask_id: 5 }), ask({ ask_id: "x".repeat(65) }), ask({ raised_at: "not a time" }), ask({ raised_at: null })]) expect(readEngineAsk(repo(), env, bad, NOW)).toBeNull();
  });

  it("an envelope with no age or time still reads, with no null or NaN anywhere in the words", () => {
    const bare = readEngineAsk(repo({ full_name: "" }), { items: [] }, ask(), NOW);
    expect(bare.title).toBe(WORDS.engineRepo);
    expect(bare.heardAgeS).toBeNull();
    expect(bare.teamLogAgeS).toBeNull();
    expect(bare.asOfMs).toBe(NOW);
    for (const v of Object.values(engineWords(bare, NOW))) expect(v).not.toMatch(/null|undefined|NaN/);
  });

  it("the repo's name is kept as it is (text for the page to put in <bdi>), whatever it holds", () => {
    const hostile = '<img src=x onerror="window.__pwned=1">/**bold**';
    expect(readEngineAsk(repo({ full_name: hostile }), env, ask(), NOW).title).toBe(hostile);
    expect(readEngineAsk(repo({ full_name: hostile }), env, ask({ pr: 3 }), NOW).links).toEqual([]);
  });
});

describe("the age sentences (L2), worked out at draw time", () => {
  const at = (over = {}, env = {}) => readEngineAsk(repo(), envelope([], env), ask(over), NOW);

  it("says when the ask was raised, and 'just now' under a minute", () => {
    expect(engineWords(at(), NOW).raised).toBe("Raised 60 min ago");
    expect(engineWords(at({ raised_at: "2026-11-16T09:57:00.000Z" }), NOW).raised).toBe("Raised 3 min ago");
    expect(engineWords(at({ raised_at: "2026-11-16T09:59:30.000Z" }), NOW).raised).toBe("Raised just now");
    expect(engineWords(at({ raised_at: "2026-11-14T10:00:00.000Z" }), NOW).raised).toBe("Raised 2 days ago");
  });

  it("an ask over 7 days old says it may be stale; one exactly 7 days old does not", () => {
    expect(engineWords(at({ raised_at: "2026-11-09T10:00:00.000Z" }), NOW).stale).toBe("");
    expect(engineWords(at({ raised_at: "2026-11-09T09:59:59.000Z" }), NOW).stale).toBe(WORDS.engineStale);
    expect(WORDS.engineStale).toMatch(/may be stale/);
  });

  it("the data's own time is 'as of HH:MM (N min ago)'", () => {
    const hhmm = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(Date.parse("2026-11-16T09:59:30.000Z")));
    expect(engineWords(at(), NOW).asOf).toBe("As of " + hhmm + " (0 min ago)");
    expect(engineWords(at(), NOW + 5 * 60000).asOf).toBe("As of " + hhmm + " (5 min ago)");
  });

  it("the machine is quiet only past 180 s: 'last seen N min ago; this ask may already be answered'", () => {
    expect(engineWords(at({}, { heard_age_s: 0 }), NOW).machine).toBe("");
    expect(engineWords(at({}, { heard_age_s: 180 }), NOW).machine).toBe("");
    expect(engineWords(at({}, { heard_age_s: 181 }), NOW).machine).toBe("Machine last seen 3 min ago; this ask may already be answered.");
    expect(engineWords(at({}, { heard_age_s: 600 }), NOW).machine).toBe("Machine last seen 10 min ago; this ask may already be answered.");
  });

  it("the quiet time keeps growing between reads, so a row that has not been read again does not look fresher than it is", () => {
    const r = at({}, { heard_age_s: 100 });
    expect(engineWords(r, NOW).machine).toBe("");
    expect(engineWords(r, NOW + 90000).machine).toBe("Machine last seen 3 min ago; this ask may already be answered.");
  });

  it("a machine that was never heard from says so; it is not 'last seen' a number", () => {
    const w = engineWords(at({}, { heard_age_s: null }), NOW);
    expect(w.machine).toBe(WORDS.engineNoHeartbeat);
    expect(w.machine).not.toMatch(/null|NaN/);
  });

  it("the team log, where the asks come from, is flagged past 2 h and not before", () => {
    expect(engineWords(at({}, { source_ages_s: { team_log: 7200 } }), NOW).source).toBe("");
    expect(engineWords(at({}, { source_ages_s: { team_log: 7201 } }), NOW).source).toBe("Team log not updated for 2 h.");
    expect(engineWords(at({}, { source_ages_s: { team_log: 3 * 3600 + 5 } }), NOW).source).toBe("Team log not updated for 3 h.");
    expect(engineWords(at({}, { source_ages_s: { loop: 99999 } }), NOW).source).toBe("");
    expect(engineWords(at({}, { source_ages_s: {} }), NOW).source).toBe("");
  });
});

describe("reading the engine", () => {
  it("one row per open ask of every repo, oldest first", async () => {
    const { call } = fakeCall(engineRoutes([repo(), repo({ repo_id: R2, full_name: "acme-labs/gadgets" })], { [R1]: envelope([ask({ ask_id: "bbbb", raised_at: "2026-11-16T09:30:00.000Z" })]), [R2]: envelope([ask({ ask_id: "aaaa", raised_at: "2026-11-16T08:00:00.000Z", ask_kind: "credential" })]) }));
    const r = await readEngine(call, undefined, new Map(), NOW);
    expect(r).toMatchObject({ failed: false, more: false });
    expect(r.rows.map((x) => x.title)).toEqual(["acme-labs/gadgets", "acme-labs/widgets"]);
    expect(r.rows[0].sentence).toBe(ENGINE_KIND_WORDS.credential);
  });

  it("only watched repos are read, and no repo means no asks and no line", async () => {
    const { call, log } = fakeCall(engineRoutes([repo({ watch_enabled: false })], {}));
    expect(await readEngine(call, undefined, new Map(), NOW)).toEqual({ rows: [], failed: false, more: false });
    expect(engineLog(log)).toEqual(["GET " + ENGINE_REPOS_URL]);
  });

  it("a cloud without the engine routes (404 on the repo list) has no engine asks and no error", async () => {
    const { call } = fakeCall();
    expect(await readEngine(call, undefined, new Map(), NOW)).toEqual({ rows: [], failed: false, more: false });
  });

  it("asks are read open-only, 200 a page, and a page of the wrong shape is a failure", async () => {
    expect(engineAsksUrl(R1)).toBe("/api/v1/engine/repos/" + R1 + "/asks?state=open&limit=200");
    for (const bad of [null, {}, { items: "x", next_cursor: null }, { items: [], next_cursor: 5 }]) {
      const { call } = fakeCall(engineRoutes([repo()], { [R1]: bad }));
      expect(await readEngine(call, undefined, new Map(), NOW), JSON.stringify(bad)).toMatchObject({ rows: [], failed: true });
    }
  });

  it("follows the cursor, and says more are waiting after the page limit", async () => {
    let n = 0;
    const { call } = fakeCall({
      ["GET " + ENGINE_REPOS_URL]: listOf([repo()]),
      ["GET " + engineAsksUrl(R1)]: () => envelope([ask({ ask_id: "p" + n++ })], { next_cursor: "c" }),
      ["GET " + engineAsksUrl(R1) + "&cursor=c"]: () => envelope([ask({ ask_id: "p" + n++ })], { next_cursor: "c" }),
    });
    const r = await readEngine(call, undefined, new Map(), NOW);
    expect(r.rows).toHaveLength(3);
    expect(r.more).toBe(true);
  });

  it("more repos than the limit says more are waiting", async () => {
    const repos = Array.from({ length: ENGINE_MAX_REPOS + 1 }, (_, i) => repo({ repo_id: "id-" + i, full_name: "a/r" + i }));
    const { call } = fakeCall({ ["GET " + ENGINE_REPOS_URL]: listOf(repos), ...Object.fromEntries(repos.map((r) => ["GET " + engineAsksUrl(r.repo_id), envelope([])])) });
    expect((await readEngine(call, undefined, new Map(), NOW)).more).toBe(true);
  });

  it("a failed read of one repo is a failure, keeps that repo's last good rows, and leaves the other repo's rows", async () => {
    let second = false;
    const { call } = fakeCall({
      ["GET " + ENGINE_REPOS_URL]: listOf([repo(), repo({ repo_id: R2, full_name: "acme-labs/gadgets" })]),
      ["GET " + engineAsksUrl(R1)]: () => (second ? fail(500) : envelope([ask({ ask_id: "one" })])),
      ["GET " + engineAsksUrl(R2)]: () => envelope([ask({ ask_id: "two" })]),
    });
    const cache = new Map();
    expect((await readEngine(call, undefined, cache, NOW)).rows).toHaveLength(2);
    second = true;
    const r = await readEngine(call, undefined, cache, NOW + 60000);
    expect(r.failed).toBe(true);
    expect(r.rows.map((x) => x.id).sort()).toEqual(["engine-" + R1 + "-one", "engine-" + R2 + "-two"]);
  });

  it("a failed repo list is a failure and keeps the last good rows", async () => {
    let down = false;
    const { call } = fakeCall({ ["GET " + ENGINE_REPOS_URL]: () => (down ? fail(500) : listOf([repo()])), ["GET " + engineAsksUrl(R1)]: envelope([ask()]) });
    const cache = new Map();
    expect((await readEngine(call, undefined, cache, NOW)).rows).toHaveLength(1);
    down = true;
    expect(await readEngine(call, undefined, cache, NOW)).toMatchObject({ failed: true, rows: [{ kind: "engine" }] });
  });

  it("a repo that is no longer ticked (404) loses its rows without a line, and an unticked repo in the list loses them too", async () => {
    let gone = false;
    const { call } = fakeCall({ ["GET " + ENGINE_REPOS_URL]: listOf([repo()]), ["GET " + engineAsksUrl(R1)]: () => (gone ? fail(404) : envelope([ask()])) });
    const cache = new Map();
    expect((await readEngine(call, undefined, cache, NOW)).rows).toHaveLength(1);
    gone = true;
    expect(await readEngine(call, undefined, cache, NOW)).toEqual({ rows: [], failed: false, more: false });
  });

  it("a cancelled read cancels", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { call } = fakeCall({ ["GET " + ENGINE_REPOS_URL]: abort });
    await expect(readEngine(call, undefined, new Map(), NOW)).rejects.toBe(abort);
    const { call: call2 } = fakeCall({ ["GET " + ENGINE_REPOS_URL]: listOf([repo()]), ["GET " + engineAsksUrl(R1)]: abort });
    await expect(readEngine(call2, undefined, new Map(), NOW)).rejects.toBe(abort);
  });
});

describe("where engine rows sit in the list", () => {
  const rowOf = (kind, id) => ({ kind, id, workItemId: id, overdue: false, dueMs: NaN, sinceMs: NaN, raisedMs: 0 });
  it("after decisions, stalled items, people and sign-in rows, before merge rows and requests", () => {
    const rows = arrangeRows({ asks: [rowOf("ask", "a")], stalled: [rowOf("stalled", "s")], people: [rowOf("person", "p")], signIns: [rowOf("signin", "i")], engine: [rowOf("engine", "e")], merges: [rowOf("merge", "m")], requests: [rowOf("setup", "r")] });
    expect(rows.map((r) => r.kind)).toEqual(["ask", "stalled", "person", "signin", "engine", "merge", "setup"]);
  });
  it("insertEngine swaps the engine rows of an arranged list and keeps the rest in order", () => {
    const base = [rowOf("ask", "a"), rowOf("engine", "old"), rowOf("merge", "m"), rowOf("setup", "r")];
    expect(insertEngine(base, [rowOf("engine", "n1"), rowOf("engine", "n2")]).map((r) => r.id)).toEqual(["a", "n1", "n2", "m", "r"]);
    expect(insertEngine([rowOf("ask", "a")], [rowOf("engine", "n")]).map((r) => r.id)).toEqual(["a", "n"]);
    expect(insertEngine(base, []).map((r) => r.id)).toEqual(["a", "m", "r"]);
  });
});

describe("what a person hears when the engine asks change", () => {
  it("counts only, and nothing when nothing changed", () => {
    expect(engineChangeWords(["a"], ["a"], false, false)).toBe("");
    expect(engineChangeWords([], ["a"], false, false)).toBe("1 new engine ask.");
    expect(engineChangeWords([], ["a", "b"], false, false)).toBe("2 new engine asks.");
    expect(engineChangeWords(["a"], [], false, false)).toBe("1 engine ask cleared.");
    expect(engineChangeWords(["a", "b", "c"], ["c", "d"], false, false)).toBe("1 new engine ask. 2 engine asks cleared.");
  });
  it("a failure is said when it starts, not on every read that still fails", () => {
    expect(engineChangeWords([], [], false, true)).toBe(WORDS.engineError + ".");
    expect(engineChangeWords([], [], true, true)).toBe("");
    expect(engineChangeWords([], [], true, false)).toBe("");
  });
});

describe("the list with engine asks", () => {
  const routes = (asks, over = {}) => ({ ...engineRoutes([repo()], { [R1]: envelope(asks) }), ...over });
  async function loaded(r, extra = {}) {
    const f = fakeCall(r);
    const list = createNeedsYou({ call: f.call, now: () => NOW, ...extra });
    await list.load();
    return { ...f, list };
  }

  it("shows each open ask as a row of kind engine, with no buttons to answer it, and counts it", async () => {
    const { list } = await loaded(routes([ask({ pr: 7 }), ask({ ask_id: "fedcba9876543210", ask_kind: "budget" })]));
    const s = list.state;
    expect(s.status).toBe("ready");
    expect(s.rows.map((r) => r.kind)).toEqual(["engine", "engine"]);
    expect(s.engineFailed).toBe(false);
    for (const r of s.rows) {
      expect(r.id).not.toBe("");
      expect(r.options).toBeUndefined();
      expect(r.action).toBeUndefined();
    }
    expect(list.busyVerb(s.rows[0].id)).toBe("");
    await list.answer(s.rows[0].id, "approve"); // no answering yet: it is not an ask of the cloud's own, so nothing is sent
    expect(list.state.rows).toHaveLength(2);
  });

  it("the first read says nothing; a new ask and a cleared ask are each said once", async () => {
    let asks = [ask()];
    const { list } = await loaded(routes([], { ["GET " + engineAsksUrl(R1)]: () => envelope(asks) }));
    expect(list.state.announce).toBe("");
    asks = [ask(), ask({ ask_id: "fedcba9876543210" })];
    await list.load();
    expect(list.state.announce).toBe("1 new engine ask.");
    list.clearAnnounce();
    await list.load();
    expect(list.state.announce).toBe("");
    asks = [];
    await list.load();
    expect(list.state.announce).toBe("2 engine asks cleared.");
    expect(list.state.rows).toHaveLength(0);
  });

  it("a cleared ask leaves on the next read with no reload", async () => {
    let asks = [ask(), ask({ ask_id: "fedcba9876543210" })];
    const { list } = await loaded(routes([], { ["GET " + engineAsksUrl(R1)]: () => envelope(asks) }));
    expect(list.state.rows).toHaveLength(2);
    asks = [ask()];
    await list.load();
    expect(list.state.rows.map((r) => r.id)).toEqual(["engine-" + R1 + "-0123456789abcdef"]);
  });

  it("a failed engine read is one flag and one spoken line, and every other row stays", async () => {
    const merge = { work_item_id: "4b7e1c20-3d95-4a6f-8e12-7a9c5d0b3f81", title: "Add a retry to the export job", pr_number: 42, pr_url: "https://github.com/example-org/example-repo/pull/42", why: "w", since: "2026-10-22T15:30:00.000Z" };
    const { list } = await loaded({ ["GET " + MERGE_URL]: { items: [merge], not_shown: 0 }, ["GET " + ENGINE_REPOS_URL]: fail(500) });
    expect(list.state.status).toBe("ready");
    expect(list.state.engineFailed).toBe(true);
    expect(list.state.rows.map((r) => r.kind)).toEqual(["merge"]);
    expect(list.state.announce).toBe(WORDS.engineError + "."); // a failed first read is said; a first read that works is not
    expect(JSON.stringify(list.state)).not.toContain(SERVER_TEXT);
  });

  it("a list failure for the other reads still fails the list, and the engine's failure does not", async () => {
    const { list } = await loaded({ ["GET " + MERGE_URL]: fail(500) });
    expect(list.state.status).toBe("error");
  });

  it("a later failure keeps the rows of the last good read (their age shows how old they are) and is said once", async () => {
    let down = false;
    const { list } = await loaded(routes([ask()], { ["GET " + ENGINE_REPOS_URL]: () => (down ? fail(500) : listOf([repo()])) }));
    down = true;
    await list.load();
    expect(list.state.engineFailed).toBe(true);
    expect(list.state.rows).toHaveLength(1);
    expect(list.state.announce).toBe(WORDS.engineError + ".");
    list.clearAnnounce();
    await list.load();
    expect(list.state.announce).toBe("");
    down = false;
    await list.load();
    expect(list.state.engineFailed).toBe(false);
  });

  it("the engine read sits beside the others and its failure is the only thing it can do to the list", async () => {
    const f = fakeCall(routes([ask()]));
    const r = await readAll(f.call, undefined, new Map(), NOW);
    expect(r.rows.map((x) => x.kind)).toEqual(["engine"]);
    expect(r).toMatchObject({ engineFailed: false, engineMore: false });
  });
});

describe("engine.changed", () => {
  function started(asksNow) {
    const f = fakeCall({ ...engineRoutes([repo()], {}), ["GET " + engineAsksUrl(R1)]: () => envelope(asksNow()) });
    const handlers = new Map();
    const timers = [];
    const list = createNeedsYou({ call: f.call, now: () => NOW });
    const offs = { engine: vi.fn() };
    list.start({
      subscribe: () => () => {},
      listen: (type, fn) => {
        handlers.set(type, fn);
        return type === ENGINE_CHANGED ? offs.engine : () => {};
      },
      setTimer: () => 1,
      clearTimer: () => {},
      setDelay: (fn, ms) => {
        timers.push({ fn, ms, cleared: false });
        return timers.length - 1;
      },
      clearDelay: (id) => {
        timers[id].cleared = true;
      },
    });
    return { ...f, list, handlers, timers, offs };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("is a live event the list listens to", () => {
    expect(ENGINE_CHANGED).toBe("engine.changed");
    expect(started(() => []).handlers.has("engine.changed")).toBe(true);
  });

  it("reads only the engine asks, once, 1 s after the first event of a burst", async () => {
    let asks = [];
    const t = started(() => asks);
    await t.list.load();
    t.call.mockClear();
    asks = [ask()];
    for (let i = 0; i < 5; i += 1) t.handlers.get(ENGINE_CHANGED)({ type: ENGINE_CHANGED });
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0].ms).toBe(ENGINE_DEBOUNCE_MS);
    expect(t.call).not.toHaveBeenCalled();
    t.timers[0].fn();
    await flush();
    const paths = t.call.mock.calls.map((c) => c[1]);
    expect(paths).toEqual([ENGINE_REPOS_URL, engineAsksUrl(R1), "/api/v1/engine/repos/" + R1 + "/commands"]); // the new ask is looked up once for an answer that is already waiting
    expect(t.list.state.rows).toHaveLength(1);
    expect(t.list.state.announce).toBe("1 new engine ask.");
    // a second burst starts a new wait
    t.handlers.get(ENGINE_CHANGED)({ type: ENGINE_CHANGED });
    expect(t.timers).toHaveLength(2);
  });

  it("the engine rows change and the other rows are untouched by an engine read", async () => {
    let asks = [];
    const t = started(() => asks);
    await t.list.load();
    const before = t.list.state.rows;
    asks = [ask()];
    await t.list.loadEngine();
    expect(t.list.state.rows.map((r) => r.kind)).toEqual(["engine"]);
    expect(before).toEqual([]);
  });

  it("a full read that begins during an engine read wins", async () => {
    let asks = [];
    let release;
    let hold = false;
    const gate = new Promise((r) => (release = r));
    const f = fakeCall(engineRoutes([repo()], {}));
    const call = vi.fn(async (m, p, b, s) => {
      if (p === engineAsksUrl(R1) && hold) await gate;
      return p === engineAsksUrl(R1) ? envelope(asks) : f.call(m, p, b, s);
    });
    const list = createNeedsYou({ call, now: () => NOW });
    await list.load();
    asks = [ask()];
    hold = true;
    const slow = list.loadEngine(); // reads one ask, and waits at the gate
    await flush();
    hold = false;
    asks = [ask(), ask({ ask_id: "fedcba9876543210" })];
    await list.load(); // begins after the engine read began, and reads two
    release();
    await slow; // the engine read answers late with its one ask and is dropped
    expect(list.state.rows).toHaveLength(2);
  });

  it("stop() cancels a wait that has not fired and unsubscribes", async () => {
    const t = started(() => []);
    t.handlers.get(ENGINE_CHANGED)({ type: ENGINE_CHANGED });
    t.list.stop();
    expect(t.timers[0].cleared).toBe(true);
    expect(t.offs.engine).toHaveBeenCalledTimes(1);
    t.timers[0].fn(); // a timer that fires anyway reads nothing
    await flush();
    expect(engineLog(t.log)).toEqual([]);
  });

  it("an event during a full read is read after it, not in parallel", async () => {
    const t = started(() => []);
    const seen = [];
    t.call.mockImplementation(async (m, p) => {
      seen.push(p);
      if (p === engineAsksUrl(R1)) return envelope([]);
      if (p === ENGINE_REPOS_URL) return listOf([repo()]);
      if (p === "/api/cloud/auth/me") return { is_admin: true };
      if (p === ASKS_FIRST_URL) return { data: [], next_cursor: null };
      if (p === NEEDS_HUMAN_URL) return { data: [], next_cursor: null };
      if (p === LIST_URL) return { requests: [], truncated: false };
      return { items: [], not_shown: 0 };
    });
    await t.list.load();
    seen.length = 0;
    t.handlers.get("pr.opened")({ type: "pr.opened" }); // a full read starts
    t.handlers.get(ENGINE_CHANGED)({ type: ENGINE_CHANGED });
    t.timers[0].fn(); // the engine read is wanted while the full one is in flight
    await flush();
    await flush();
    const engineReads = seen.filter((p) => p === ENGINE_REPOS_URL).length;
    expect(engineReads).toBe(2); // the full read's own, and the engine-only one after it
  });
});

describe("the engine links say they open a new tab", () => {
  it("each link in an engine row carries visually hidden words, and the hidden style exists", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "needs-you");
    const line = readFileSync(join(dir, "needs-you-app.js"), "utf8").split("\n").find((l) => l.includes("ny-engine-link-"));
    expect(line).toContain("target: \"_blank\"");
    expect(line).toContain("class: \"ny-sr\"");
    expect(line).toContain("(opens in a new tab)");
    expect(readFileSync(join(dir, "needs-you-app.css"), "utf8")).toMatch(/\.ny-sr \{[^}]*clip-path: inset\(50%\)/);
  });
});
