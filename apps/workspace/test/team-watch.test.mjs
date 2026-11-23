// apps/workspace/test/team-watch.test.mjs
//
// The Team app's live view (the live view in team-runners.js, D#845 ON-25b), with no DOM. The page, the stream against a real server and the layouts are driven in e2e/team-watch.spec.ts.
// Pinned here: the "Live" rule one condition at a time, every state's exact words, that nothing is sent on its own at the cap, the 5-minute renewal and what it says about input,
// release on hide, the stream's failures and "Updating every minute", "Load older", and the held-lines sentence through the whole model.
import { describe, expect, it, vi } from "vitest";
import { api } from "../apps/_lib/api.js";
import { HEALTHY_MS } from "../shell/core/cloud-live.js";
import { REPOS_URL, SETTINGS_URL, createTeam, createTeamApi, describe as describeState, panelUrl, watchUrl } from "../apps/team/team-model.js";
import { FAILED_ATTEMPTS, HIDE_RELEASE_MS, INGEST_LIVE_S, CONFIRM_MS, POLL_MS, REPOST_MS, TICK_MS, WATCH_WORDS, createWatch, updatedWords, watchView } from "../apps/team/team-runners.js";
import { REPO_A, REPO_B, makeFixtures } from "./fixtures/team/fixtures.mjs";

const T0 = Date.parse("2026-11-16T15:00:00.000Z");
const F = makeFixtures(T0);
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const LEASE = "5a1f3c52-7a0e-4c1a-9a53-0b1d2e3f4a55";
const answer = (over = {}) => ({ lease_id: LEASE, expires_at: new Date(T0 + 90_000).toISOString(), session_ends_at: new Date(T0 + 4 * 3600_000).toISOString(), limits: { per_repo: 2, per_account: 4 }, command: "issued", machine: "online", last_seen: new Date(T0).toISOString(), detail_as_of: null, ...over });
const failure = (status, code, extra = {}) => Object.assign(new Error("server text that must never be shown"), { status, code, ...extra });

/** A clock and timers the test moves by hand; advance() runs every timer that falls due, in order, at its own time. */
function sched() {
  let time = T0, id = 0;
  const timers = new Map();
  const s = {
    now: () => time,
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: time + Math.max(0, ms) }); return id; },
    clearTimer: (i) => timers.delete(i),
    count: () => timers.size,
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        time = Math.max(time, next[1].at);
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      time = end;
      await flush();
    },
  };
  return s;
}

/** The controller on a tiny state container, a fake client, a fake stream and a fake page. */
/** A cloud that keeps one lease per browser, and drops it whenever a stream that carries it is closed from the client's side (packages/api/src/sse/stream.ts) or the route's DELETE arrives. */
function leaseServer() {
  let n = 0, lease = null;
  return {
    get lease() { return lease; },
    post: async (body) => {
      if (!lease) {
        if (!body.active) throw failure(409, "watch_ended");
        lease = "00000000-0000-4000-8000-" + String(++n).padStart(12, "0");
      }
      return answer({ lease_id: lease });
    },
    dropIf: (id) => { if (lease === id) lease = null; },
    drop: () => { lease = null; },
  };
}
/** Tabs of one browser: a message posted by one reaches the others. */
function bus() {
  const members = [];
  return () => {
    const me = { onmessage: null, postMessage: (m) => { for (const o of members) if (o !== me && o.onmessage) o.onmessage({ data: m }); }, close: () => {} };
    members.push(me);
    return me;
  };
}
function harness({ post = async () => answer(), repoId = REPO_A, server = null, channel = null } = {}) {
  const s = sched();
  let st = { selectedId: repoId, watch: null };
  const sends = [];
  const client = {
    watch: vi.fn(async (id, body) => { sends.push(["POST", id, body]); return server ? server.post(body) : post(body, sends.filter((x) => x[0] === "POST").length); }),
    unwatch: vi.fn(async (id, browser) => { sends.push(["DELETE", id, browser]); if (server) server.drop(); return { released: true }; }),
  };
  const streams = [];
  const open = (doFetch, o) => {
    let finish;
    const done = new Promise((r) => { finish = r; });
    const lease = new URL(o.url, "http://x").searchParams.get("watch");
    const x = { o, lease, closed: false, close: () => { x.closed = true; if (server) server.dropIf(lease); finish({ status: 200, opened: true }); }, end: () => finish({ status: 200, opened: true }), drop: () => { if (server) server.dropIf(lease); finish({ status: 200, opened: true }); } };
    streams.push(x);
    return { done, close: x.close };
  };
  const doc = new EventTarget();
  doc.hidden = false;
  const refresh = vi.fn();
  const w = createWatch({ client, get: () => st, set: (p) => { st = { ...st, ...p }; }, refresh, now: s.now, setTimer: s.setTimer, clearTimer: s.clearTimer, open, doc, store: null, rand: () => 0.5, channel });
  const hide = async (hidden) => { doc.hidden = hidden; doc.dispatchEvent(new Event("visibilitychange")); await flush(); };
  const view = (lastHeardAgoS = 20) => watchView(st.watch, { lastHeard: new Date(s.now() - lastHeardAgoS * 1000).toISOString() }, s.now());
  return { w, s, sends, posts: () => sends.filter((x) => x[0] === "POST"), streams, doc, hide, view, refresh, state: () => st };
}
/** Opens the stream, gives it bytes and lets it live long enough to count as healthy. */
async function healthy(h, i = h.streams.length - 1) {
  const x = h.streams[i];
  x.o.onOpen();
  x.o.onBytes(new Uint8Array([58]));
  await h.s.advance(HEALTHY_MS);
}

describe("watchView: the Live rule, one condition at a time", () => {
  const base = () => ({ repoId: REPO_A, leaseId: LEASE, leaseUntil: T0 + 60_000, startedAt: T0 - 200_000, leaseOk: true, posting: false, command: "issued", machine: "online", postedAt: T0 - 100_000, cap: null, ended: false, summary: false, streamOpen: true, streamHealthy: true, polling: false, older: "" });
  const repo = (agoS = 20) => ({ lastHeard: new Date(T0 - agoS * 1000).toISOString() });
  const view = (over = {}, r = repo()) => watchView({ ...base(), ...over }, r, T0);

  it("all four hold: the lease is held, the watch is streaming, the repo was heard from under 90 s ago, the stream is healthy", () => {
    expect(view()).toMatchObject({ state: "live", pill: "Live" });
    expect(view({ command: "held" })).toMatchObject({ state: "live" });
  });
  it("each condition missing on its own is not Live, and says Updated <time> (or, while it gets going, Connecting)", () => {
    expect(view({ leaseId: "" }).pill).not.toBe("Live");
    expect(view({ leaseUntil: T0 - 1, streamOpen: false })).toMatchObject({ state: "summary", pill: "Updated just now" });
    expect(view({ command: "" })).toMatchObject({ state: "connecting", pill: "Connecting to the machine…" }); // no watch command taken yet
    expect(view({ command: "throttled" }).state).toBe("live"); // a recent command already covers the watch, as with held
    expect(view({ command: "issued", startedAt: T0 + 1000 }, repo(500))).toMatchObject({ state: "connecting" }); // nothing heard since the view began
    expect(view({}, repo(INGEST_LIVE_S))).toMatchObject({ state: "summary", pill: "Updated 1 min ago" }); // heard 90 s ago: no longer under 90
    expect(view({}, repo(INGEST_LIVE_S - 1)).state).toBe("live");
    expect(view({ streamHealthy: false })).toMatchObject({ state: "summary", pill: "Updated just now" });
    for (const state of [view({ leaseId: "" }), view({ command: "" }), view({}, repo(300)), view({ streamHealthy: false })]) expect(state.pill).not.toBe("Live");
  });
  it("a repo never heard from is not Live, and reads Not updated yet", () => {
    expect(watchView({ ...base(), command: "held" }, { lastHeard: "" }, T0)).toMatchObject({ state: "summary", pill: WATCH_WORDS.noData });
  });
  it("offline: the exact banner, no Live, and the machine being heard again clears it", () => {
    const v = view({ machine: "offline" }, repo(600));
    expect(v).toMatchObject({ state: "offline", banner: "The machine is offline. Details appear when it reconnects." });
    expect(v.pill).toBe("Updated 10 min ago");
    expect(view({ machine: "offline", postedAt: T0 - 400_000 }, repo(20)).state).not.toBe("offline");
  });
  it("at the cap: the exact sentence with both numbers, and Try again", () => {
    const v = view({ cap: { cap: "repo", limit: 2, inUse: 2 }, leaseId: "" });
    expect(v).toMatchObject({ state: "cap", banner: "Live view is in use by 2 people on this repo (your plan allows 2). You're seeing the summary; it refreshes every 2 minutes.", retry: "Try again" });
    expect(view({ cap: { cap: "account", limit: 4, inUse: 4 }, leaseId: "" }).banner).toBe("Your account has 4 live views open (your plan allows 4). You're seeing the summary; it refreshes every 2 minutes.");
  });
  it("connecting while the first answer is out, Updating every minute after the stream gave up, and an ended view says so", () => {
    expect(view({ leaseId: "", posting: true })).toMatchObject({ state: "connecting", pill: "Connecting to the machine…" });
    expect(view({ polling: true, streamOpen: false, streamHealthy: false })).toMatchObject({ state: "polling", pill: "Updating every minute" });
    expect(view({ ended: true, leaseId: "" })).toMatchObject({ state: "ended", banner: WATCH_WORDS.ended, retry: "Try again" });
    expect(view({ command: "runner_too_old" })).toMatchObject({ state: "summary", banner: WATCH_WORDS.tooOld });
  });
  it("no view of anything but a repo with a watch", () => {
    expect(watchView(null, repo(), T0)).toBeNull();
    expect(watchView({ ...base(), repoId: "" }, repo(), T0)).toBeNull();
    expect(watchView(base(), null, T0)).toBeNull();
  });
  it("updatedWords: just now, minutes, hours, and a missing time", () => {
    expect(updatedWords(new Date(T0 - 30_000).toISOString(), T0)).toBe("Updated just now");
    expect(updatedWords(new Date(T0 - 7 * 60_000).toISOString(), T0)).toBe("Updated 7 min ago");
    expect(updatedWords(new Date(T0 - 3 * 3600_000).toISOString(), T0)).toBe("Updated 3 h ago");
    expect(updatedWords("", T0)).toBe("Not updated yet");
    expect(updatedWords("not a time", T0)).toBe("Not updated yet");
  });
});

describe("the controller: opening, renewing and releasing a view", () => {
  it("opening a repo asks for a view with real input (active true) and opens the stream carrying the lease", async () => {
    const h = harness();
    h.w.sync(REPO_A);
    await flush();
    expect(h.posts()).toHaveLength(1);
    expect(h.posts()[0][2]).toMatchObject({ active: true });
    expect(h.posts()[0][2].browser_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.state().watch).toMatchObject({ repoId: REPO_A, leaseId: LEASE, command: "issued", machine: "online" });
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0].o.url).toBe("/api/v1/events?watch=" + LEASE);
  });
  it("a second read of the same repo asks for nothing more; another repo moves the view (release, then start)", async () => {
    const h = harness();
    h.w.sync(REPO_A);
    await flush();
    h.w.sync(REPO_A);
    await flush();
    expect(h.posts()).toHaveLength(1);
    h.w.sync(REPO_B);
    await flush();
    expect(h.sends.map((x) => x[0] + " " + x[1])).toEqual(["POST " + REPO_A, "DELETE " + REPO_A, "POST " + REPO_B]);
    expect(h.streams[0].closed).toBe(true);
    h.w.sync("");
    await flush();
    expect(h.state().watch).toBeNull();
  });
  it("the renewal goes about every 5 minutes: active true only when the person did something since the last one", async () => {
    const h = harness();
    h.w.sync(REPO_A);
    await flush();
    await h.s.advance(REPOST_MS);
    expect(h.posts()).toHaveLength(2);
    expect(h.posts()[1][2].active).toBe(false); // nobody touched it
    h.w.touch();
    await h.s.advance(REPOST_MS);
    expect(h.posts()[2][2].active).toBe(true);
    await h.s.advance(REPOST_MS);
    expect(h.posts()[3][2].active).toBe(false); // the input was spent by the last renewal
    expect(h.posts().map((p) => p[2].before)).toEqual([undefined, undefined, undefined, undefined]);
  });
  it("a renewal that finds the view ended (409 watch_ended) stops asking and says so; Try again starts one with input", async () => {
    const h = harness({ post: async (body, n) => { if (n === 2) throw failure(409, "watch_ended"); return answer(); } });
    h.w.sync(REPO_A);
    await flush();
    await h.s.advance(REPOST_MS);
    expect(h.view()).toMatchObject({ state: "ended", retry: "Try again" });
    await h.s.advance(3 * REPOST_MS);
    expect(h.posts()).toHaveLength(2); // nothing on its own
    h.w.again();
    await flush();
    expect(h.posts()).toHaveLength(3);
    expect(h.posts()[2][2].active).toBe(true);
    expect(h.state().watch.ended).toBe(false);
  });
  it("the tab hidden: the stream closes and the slot is released after 5 s, never before; shown again, a new view starts with input and is not Live at once", async () => {
    const h = harness();
    h.w.sync(REPO_A);
    await flush();
    await healthy(h);
    expect(h.view(5)).toMatchObject({ state: "live" });
    await h.hide(true);
    await h.s.advance(HIDE_RELEASE_MS - 1);
    expect(h.sends.filter((x) => x[0] === "DELETE")).toHaveLength(0);
    await h.s.advance(1);
    expect(h.sends.filter((x) => x[0] === "DELETE")).toHaveLength(1);
    expect(h.streams[0].closed).toBe(true);
    expect(h.state().watch).toBeNull();
    await h.s.advance(10 * REPOST_MS);
    expect(h.posts()).toHaveLength(1); // a hidden tab asks for nothing
    await h.hide(false);
    expect(h.posts()).toHaveLength(2);
    expect(h.posts()[1][2].active).toBe(true);
    expect(h.view(20).state).not.toBe("live"); // the stream is new and has lived no time: whatever the old as-of said, the pill is never Live yet
    expect(h.view(20).pill).not.toBe("Live");
  });
  it("a tab hidden and shown again inside the 5 s keeps its view", async () => {
    const h = harness();
    h.w.sync(REPO_A);
    await flush();
    await h.hide(true);
    await h.s.advance(3000);
    await h.hide(false);
    await h.s.advance(HIDE_RELEASE_MS);
    expect(h.sends.filter((x) => x[0] === "DELETE")).toHaveLength(0);
    expect(h.posts()).toHaveLength(1);
  });
  it("the page is told the time has moved every 15 s, so a quiet repo drops Live without a read", async () => {
    const h = harness();
    h.w.sync(REPO_A);
    await flush();
    const first = h.state().watch.tickAt;
    await h.s.advance(TICK_MS);
    const second = h.state().watch.tickAt;
    expect(second).toBeGreaterThan(first);
    await h.s.advance(TICK_MS);
    expect(h.state().watch.tickAt).toBeGreaterThan(second);
  });
  it("destroy frees the slot and stops every timer", async () => {
    const h = harness();
    h.w.sync(REPO_A);
    await flush();
    h.w.destroy();
    await flush();
    expect(h.sends.filter((x) => x[0] === "DELETE")).toHaveLength(1);
    expect(h.streams[0].closed).toBe(true);
    expect(h.s.count()).toBe(0);
  });
});

describe("at the cap: nothing is sent without a click", () => {
  const capped = () => harness({ post: async (body, n) => { if (n === 1) throw failure(429, "watch_limit", { limit: { cap: "repo", limit: 2, inUse: 2 } }); return answer(); } });
  it("the 429 shows the summary and the exact words, opens no stream, and then no request goes out for an hour (no timer, no retry)", async () => {
    const h = capped();
    h.w.sync(REPO_A);
    await flush();
    expect(h.view()).toMatchObject({ state: "cap", retry: "Try again", banner: "Live view is in use by 2 people on this repo (your plan allows 2). You're seeing the summary; it refreshes every 2 minutes." });
    expect(h.streams).toHaveLength(0);
    await h.s.advance(3600_000);
    h.w.sync(REPO_A); // a read arrives: still no start
    await h.s.advance(REPOST_MS);
    expect(h.posts()).toHaveLength(1);
    expect(h.sends.filter((x) => x[0] === "DELETE")).toHaveLength(0); // no lease was ever held, so none is released
  });
  it("Try again is one new start with input; once a slot is free the view opens and the cap words are gone", async () => {
    const h = capped();
    h.w.sync(REPO_A);
    await flush();
    h.w.again();
    await flush();
    expect(h.posts()).toHaveLength(2);
    expect(h.posts()[1][2].active).toBe(true);
    expect(h.state().watch).toMatchObject({ cap: null, leaseId: LEASE });
    expect(h.view().state).not.toBe("cap");
    expect(h.streams).toHaveLength(1);
  });
  it("a refusal that is not the cap (a server error, no network) leaves the summary and asks again only at the next renewal", async () => {
    const h = harness({ post: async (body, n) => { if (n === 1) throw failure(500, "server_error"); return answer(); } });
    h.w.sync(REPO_A);
    await flush();
    expect(h.view()).toMatchObject({ state: "summary" });
    expect(h.view().pill).toMatch(/^Updated/);
    expect(h.posts()).toHaveLength(1);
    await h.s.advance(REPOST_MS);
    expect(h.posts()).toHaveLength(2);
    expect(h.state().watch.leaseId).toBe(LEASE);
  });
});

describe("the stream: health, failures and Updating every minute", () => {
  it("healthy only after it has lived 10 s with bytes; a rolled stream that was healthy reconnects at once", async () => {
    const h = harness();
    h.w.sync(REPO_A);
    await flush();
    h.streams[0].o.onOpen();
    expect(h.state().watch.streamHealthy).toBe(false);
    h.streams[0].o.onBytes(new Uint8Array([58]));
    await h.s.advance(HEALTHY_MS - 1);
    expect(h.state().watch.streamHealthy).toBe(false);
    await h.s.advance(1);
    expect(h.state().watch.streamHealthy).toBe(true);
    h.streams[0].end();
    await flush();
    await h.s.advance(0);
    expect(h.state().watch.streamHealthy).toBe(false);
    expect(h.streams).toHaveLength(2);
  });
  it("a stream that never gets going backs off, and after 10 failed attempts the view says Updating every minute and reads the panels once a minute", async () => {
    const h = harness();
    h.w.sync(REPO_A);
    await flush();
    for (let i = 0; i < FAILED_ATTEMPTS; i++) {
      expect(h.streams).toHaveLength(i + 1);
      h.streams[i].end(); // refused before any byte
      await flush();
      await h.s.advance(i === FAILED_ATTEMPTS - 1 ? 1000 : 70_000);
    }
    expect(h.streams).toHaveLength(FAILED_ATTEMPTS);
    expect(h.view()).toMatchObject({ state: "polling", pill: "Updating every minute" });
    const before = h.refresh.mock.calls.length;
    await h.s.advance(POLL_MS);
    expect(h.refresh.mock.calls.length).toBe(before + 1);
    expect(h.streams.length).toBe(FAILED_ATTEMPTS + 1); // one attempt a minute, not a storm
    await healthy(h);
    expect(h.state().watch).toMatchObject({ polling: false, streamHealthy: true });
    expect(h.view().pill).not.toBe("Updating every minute");
  });
  it("a stream that is silent for 50 s is closed as dead", async () => {
    const h = harness();
    h.w.sync(REPO_A);
    await flush();
    h.streams[0].o.onOpen();
    await h.s.advance(50_000);
    expect(h.streams[0].closed).toBe(true);
  });
});

describe("the lease the server drops when a stream closes from the client's side", () => {
  it("a dropped stream is not Live; the lease is taken again, then the stream reconnects on a lease the server holds, and Live comes back", async () => {
    const server = leaseServer();
    const h = harness({ server });
    h.w.sync(REPO_A);
    await flush();
    await healthy(h);
    expect(h.view(5).state).toBe("live");
    h.streams[0].drop(); // a network drop: the server deletes the lease with the stream
    await flush();
    expect(server.lease).toBeNull();
    expect(h.view(5).state).not.toBe("live"); // a lease nobody has confirmed is not counted
    await h.s.advance(0);
    await flush();
    expect(h.posts()).toHaveLength(2);
    expect(h.posts()[1][2].active).toBe(true); // the person opened it a moment ago
    expect(server.lease).not.toBeNull();
    expect(h.streams).toHaveLength(2);
    expect(h.streams[1].lease).toBe(server.lease);
    await healthy(h);
    expect(h.view(5).state).toBe("live");
  });
  it("the old stream's cleanup deleting the lease AFTER the re-take: not Live until a confirming POST ten seconds on, which takes the lease again, even for an idle tab", async () => {
    const server = leaseServer();
    const h = harness({ server });
    h.w.sync(REPO_A);
    await flush();
    await healthy(h);
    for (let t = 0; t < REPOST_MS + 1000; t += 20_000) { h.streams[0].o.onBytes(new Uint8Array([58])); await h.s.advance(20_000); } // idle: no input for over 5 minutes
    const before = h.posts().length;
    h.streams[0].end(); // the server rolls the stream
    await flush();
    await h.s.advance(0);
    await flush();
    expect(h.posts()).toHaveLength(before + 1); // the re-take
    server.drop(); // ...and the old stream's by-id delete lands now
    await healthy(h); // the new stream lives 10 s with bytes
    expect(h.view(5).state).not.toBe("live"); // the confirming POST has not answered yet or has just found the lease gone
    await h.s.advance(CONFIRM_MS);
    await flush();
    expect(h.posts().map((p) => p[2].active).slice(before)).toEqual([false, false, true]); // re-take, confirm (409), confirm again with input
    expect(server.lease).not.toBeNull();
    expect(h.state().watch).toMatchObject({ leaseId: server.lease, leaseOk: true, ended: false });
    expect(h.streams[h.streams.length - 1].lease).toBe(server.lease);
    await healthy(h);
    expect(h.view(5).state).toBe("live");
  });
  it("a close the server made itself (it keeps the lease) is also followed by a renewal before the reconnect, and costs no new slot", async () => {
    const server = leaseServer();
    const h = harness({ server });
    h.w.sync(REPO_A);
    await flush();
    await healthy(h);
    const lease = server.lease;
    h.streams[0].end();
    await flush();
    await h.s.advance(0);
    await flush();
    expect(h.posts()).toHaveLength(2);
    expect(server.lease).toBe(lease);
    expect(h.streams[1].lease).toBe(lease);
  });
  it("after a drop with no input for a while the server refuses to start a view (409): it says the view ended instead of showing Live on a dead id", async () => {
    const server = leaseServer();
    const h = harness({ server });
    h.w.sync(REPO_A);
    await flush();
    await healthy(h);
    for (let t = 0; t < REPOST_MS + 1000; t += 20_000) { h.streams[0].o.onBytes(new Uint8Array([58])); await h.s.advance(20_000); } // the server's heartbeat keeps the stream alive
    h.streams[0].drop();
    await flush();
    await h.s.advance(0);
    await flush();
    expect(h.view(5)).toMatchObject({ state: "ended", retry: "Try again" });
    expect(h.view(5).pill).not.toBe("Live");
  });
  it("a renewal that answers with a different lease id reopens the stream on it", async () => {
    const server = leaseServer();
    const h = harness({ server });
    h.w.sync(REPO_A);
    await flush();
    await healthy(h);
    const first = server.lease;
    server.drop(); // gone on the server (another tab's release, say) while this stream still looks open
    h.w.touch();
    await h.s.advance(REPOST_MS);
    await flush();
    expect(server.lease).not.toBe(first);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[0].closed).toBe(true);
    expect(h.streams[1].lease).toBe(server.lease);
    expect(h.state().watch.leaseId).toBe(server.lease);
  });
  it("two tabs: hiding tab A frees the shared lease, and tab B takes it again on its own stream instead of staying Live on a deleted lease", async () => {
    const server = leaseServer();
    const mk = bus();
    const a = harness({ server, channel: mk() });
    const b = harness({ server, channel: mk() });
    a.w.sync(REPO_A);
    await flush();
    b.w.sync(REPO_A);
    await flush();
    await healthy(a);
    await healthy(b);
    expect(b.view(5).state).toBe("live");
    await a.hide(true);
    await a.s.advance(HIDE_RELEASE_MS);
    await flush();
    await b.s.advance(0);
    await flush();
    expect(b.posts().length).toBeGreaterThanOrEqual(2); // B took the lease again
    expect(server.lease).not.toBeNull();
    expect(b.state().watch.leaseId).toBe(server.lease);
    expect(b.streams[b.streams.length - 1].lease).toBe(server.lease);
    expect(b.view(5).state).not.toBe("live"); // its new stream has lived no time
    await healthy(b);
    expect(b.view(5).state).toBe("live");
  });
  it("two tabs: a tab B with no input for a while is told honestly that its view ended, never left Live", async () => {
    const server = leaseServer();
    const mk = bus();
    const a = harness({ server, channel: mk() });
    const b = harness({ server, channel: mk() });
    a.w.sync(REPO_A);
    b.w.sync(REPO_A);
    await flush();
    await healthy(b);
    await b.s.advance(REPOST_MS - 1000);
    await a.hide(true);
    await a.s.advance(HIDE_RELEASE_MS);
    await flush();
    await b.s.advance(REPOST_MS);
    await flush();
    expect(b.view(5).state).not.toBe("live");
  });
});

describe("Load older", () => {
  it("asks the machine for the lines before the lowest one the cloud holds, with input", async () => {
    const h = harness();
    h.w.sync(REPO_A);
    await flush();
    await h.w.older(41);
    expect(h.posts()[1][2]).toMatchObject({ active: true, before: 41 });
    expect(h.state().watch.older).toBe("");
  });
  it("with nothing uploaded yet there is nothing older: it says so and sends nothing; a too-recent ask and a refused cursor are said in words", async () => {
    const h = harness({ post: async (body) => { if (body.before === 5) throw failure(400, "invalid_request"); if (body.before === 6) return answer({ command: "throttled" }); return answer(); } });
    h.w.sync(REPO_A);
    await flush();
    await h.w.older(null);
    expect(h.posts()).toHaveLength(1);
    expect(h.state().watch.older).toBe(WATCH_WORDS.nothing);
    await h.w.older(5);
    expect(h.state().watch.older).toBe(WATCH_WORDS.nothing);
    await h.w.older(6);
    expect(h.state().watch.older).toBe(WATCH_WORDS.soon);
  });
});

describe("through the model: the held-lines sentence, the per-panel time and the requests", () => {
  const routes = (over = {}) => ({
    ["GET " + SETTINGS_URL]: F.settings(),
    ["GET " + REPOS_URL]: F.list([F.repo()]),
    ["GET " + panelUrl("agents", REPO_A)]: F.envelope([F.agent()]),
    ["GET " + panelUrl("lanes", REPO_A)]: F.envelope([F.lane()]),
    ["GET " + panelUrl("gates", REPO_A)]: F.envelope([F.gate()]),
    ["GET " + panelUrl("log", REPO_A)]: F.envelope([F.logLine()], { held_events: 3, oldest_seq: 41, as_of: F.iso(300) }),
    ["GET " + panelUrl("plan", REPO_A)]: F.plan(),
    ["GET " + panelUrl("stats", REPO_A)]: F.stats(),
    ["GET " + panelUrl("usage", REPO_A)]: F.usage(),
    ["POST " + watchUrl(REPO_A)]: () => answer(),
    ["DELETE " + watchUrl(REPO_A)]: () => ({ released: true }),
    ...over,
  });
  function model(over = {}, opts = {}) {
    const log = [];
    const r = routes(over);
    const call = vi.fn(async (method, path, body) => {
      const key = method + " " + path.split("?")[0];
      log.push([method, path, body]);
      const v = r[key] ?? r[method + " " + path];
      if (v === undefined) throw failure(404, "not_found");
      const out = typeof v === "function" ? v(body) : v;
      if (out instanceof Error) throw out;
      return out;
    });
    const t = createTeam({ client: createTeamApi(call), liveView: true, ...opts });
    return { t, log, call };
  }
  it("the opening read starts one live view; a refresh asks for nothing more", async () => {
    const { t, log } = model();
    await t.load();
    await flush();
    expect(log.filter(([m]) => m === "POST")).toHaveLength(1);
    expect(log.find(([m]) => m === "POST")[1]).toBe(watchUrl(REPO_A));
    expect(log.find(([m]) => m === "POST")[2]).toMatchObject({ active: true });
    await t.refresh();
    await flush();
    expect(log.filter(([m]) => m === "POST")).toHaveLength(1);
    t.stop();
  });
  it("without liveView (the default) the app only reads: no POST, no stream", async () => {
    const log = [];
    const call = vi.fn(async (method, path) => { log.push(method); if (method === "GET" && path === SETTINGS_URL) return F.settings(); if (method === "GET" && path === REPOS_URL) return F.list([F.repo()]); return F.envelope([]); });
    const t = createTeam({ client: createTeamApi(call) });
    await t.load();
    await flush();
    expect(log.filter((m) => m !== "GET")).toEqual([]);
  });
  it("a repo never connected asks for no view", async () => {
    const { t, log } = model({ ["GET " + REPOS_URL]: F.list([F.repo({ liveness: "never", last_heard_at: null })]) });
    await t.load();
    await flush();
    expect(log.filter(([m]) => m === "POST")).toHaveLength(0);
  });
  it("the log shows N older lines are on the machine and were not uploaded, with Load older; the click posts before = the oldest seq", async () => {
    const { t, log } = model();
    await t.load();
    await flush();
    const v = describeState(t.state, T0);
    expect(v.log.held).toMatchObject({ text: "3 older lines are on the machine and were not uploaded", button: "Load older", oldest: 41 });
    await t.watch.older(v.log.held.oldest);
    expect(log.filter(([m]) => m === "POST")[1][2]).toMatchObject({ before: 41, active: true });
    t.stop();
  });
  it("one held line reads in the singular; none shows no sentence at all", async () => {
    const one = model({ ["GET " + panelUrl("log", REPO_A)]: F.envelope([F.logLine()], { held_events: 1, oldest_seq: 2 }) });
    await one.t.load();
    await flush();
    expect(describeState(one.t.state, T0).log.held.text).toBe("1 older line is on the machine and was not uploaded");
    one.t.stop();
    const none = model({ ["GET " + panelUrl("log", REPO_A)]: F.envelope([F.logLine()]) });
    await none.t.load();
    await flush();
    expect(describeState(none.t.state, T0).log.held).toBeNull();
    none.t.stop();
  });
  it("each panel's own time is its envelope's as_of: the log is as of its own newest event, not the repo's", async () => {
    const { t } = model();
    await t.load();
    await flush();
    const v = describeState(t.state, T0);
    expect(v.log.asOf).toMatch(/^As of \d\d:\d\d \(5 min ago\)$/);
    expect(v.agents.asOf).toMatch(/^As of \d\d:\d\d \(0 min ago\)$/);
    t.stop();
  });
  it("the status word is Connecting until the view is going, then follows the repo's last-heard time and never says Live on a stale one", async () => {
    const { t } = model();
    await t.load();
    await flush();
    expect(describeState(t.state, T0 + 1000).watch.pill).not.toBe("Live"); // no stream has lived 10 s
    expect(describeState(t.state, T0 + 1000).watch.state).toBe("connecting"); // issued, nothing heard since the view began
    t.stop();
  });
  it("a 429 on opening reaches the page as the cap view; no further POST until Try again", async () => {
    const { t, log } = model({ ["POST " + watchUrl(REPO_A)]: () => failure(429, "watch_limit", { limit: { cap: "repo", limit: 2, inUse: 2 } }) });
    await t.load();
    await flush();
    const v = describeState(t.state, T0);
    expect(v.watch).toMatchObject({ state: "cap", retry: "Try again" });
    await t.refresh();
    await flush();
    expect(log.filter(([m]) => m === "POST")).toHaveLength(1);
    t.stop();
  });
  it("closing the app frees the slot (DELETE with this browser's id)", async () => {
    const { t, log } = model();
    await t.load();
    await flush();
    t.stop();
    await flush();
    const del = log.find(([m]) => m === "DELETE");
    expect(del[1]).toMatch(new RegExp("^" + watchUrl(REPO_A).replace(/[/.]/g, "\\$&") + "\\?browser_id=[0-9a-f-]{36}$"));
  });
});

describe("api(): what a 429 watch_limit carries to the page", () => {
  const reply = (body) => ({ ok: false, status: 429, headers: { get: () => "30" }, text: async () => JSON.stringify(body) });
  const run = async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(body)));
    try { return await api("POST", watchUrl(REPO_A), { browser_id: LEASE, active: true }).catch((e) => e); } finally { vi.unstubAllGlobals(); }
  };
  it("the cap, the limit and the count, as a word from a closed pair and two whole numbers", async () => {
    const e = await run({ error: { code: "watch_limit", message: "text", request_id: "r" }, data: { cap: "account", limit: 4, in_use: 4 } });
    expect(e.status).toBe(429);
    expect(e.limit).toEqual({ cap: "account", limit: 4, inUse: 4 });
  });
  it("anything else in `data` is ignored: no limit, so the page shows no cap sentence built from it", async () => {
    for (const data of [{ cap: "plan", limit: 2, in_use: 2 }, { cap: "repo", limit: "2", in_use: 2 }, { cap: "repo", limit: 2.5, in_use: 2 }, { cap: "repo", limit: 2 }, "x", null]) {
      const e = await run({ error: { code: "watch_limit", message: "text", request_id: "r" }, data });
      expect(e.limit, JSON.stringify(data)).toBeUndefined();
    }
  });
});
