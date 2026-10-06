// apps/workspace/test/stream.test.mjs
//
// D#37 WS-F2b: the per-run stream client (apps/_lib/stream.js) against a fake
// fetch that serves SSE bodies and counts the streams that are open, a real
// createLive() for the hidden-tab hook, and vitest's fake clock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDDEN_CLOSE_MS, createLive } from "../shell/core/cloud-live.js";
import { openRunStream } from "../apps/_lib/stream.js";

const RUN = "3f2b8c1e-0000-4000-8000-000000000001";
const URL_ = `/api/v1/runs/${RUN}/events`;

function target(extra = {}) {
  const h = new Map();
  return Object.assign(extra, {
    addEventListener: (t, f) => h.set(t, [...(h.get(t) || []), f]),
    removeEventListener: (t, f) => h.set(t, (h.get(t) || []).filter((x) => x !== f)),
    fire: (t) => (h.get(t) || []).forEach((f) => f({ type: t })),
    listeners: () => [...h.values()].reduce((n, l) => n + l.length, 0),
  });
}

/** A fake server: every stream fetch is logged; `status` forces a non-200 reply. */
function world() {
  const w = { calls: [], streams: [], status: 200, maxOpen: 0 };
  w.open = () => w.streams.filter((s) => !s.closed);
  w.fetch = async (url, init = {}) => {
    if (url === "/api/v1/events") return { status: 200, headers: { get: () => "text/event-stream" }, body: new ReadableStream() }; // the account stream: silent, not counted
    w.calls.push({ url, headers: init.headers, at: Date.now() });
    const type = { get: (k) => (k.toLowerCase() === "content-type" ? "text/event-stream" : null) };
    if (w.status !== 200) return { status: w.status, headers: type, body: new ReadableStream() };
    let ctrl;
    const s = { closed: false, push: (t) => ctrl.enqueue(new TextEncoder().encode(t)), end: () => { s.closed = true; try { ctrl.close(); } catch { /* gone */ } } };
    const body = new ReadableStream({ start: (c) => { ctrl = c; }, cancel: () => { s.closed = true; } });
    init.signal.addEventListener("abort", () => { s.closed = true; try { ctrl.error(new Error("abort")); } catch { /* closed */ } });
    w.streams.push(s);
    w.maxOpen = Math.max(w.maxOpen, w.open().length);
    return { status: 200, headers: type, body };
  };
  return w;
}
const runEvent = (seq, extra = {}) => `id: ${seq}\nevent: run_event\ndata: ${JSON.stringify({ seq, kind: "agent.output", at: "2026-09-18T12:00:00.000Z", payload: { text: "t" + seq }, ...extra })}\n\n`;
const frame = (event, data = {}) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** A stream over a fake world, with its own live client (visibility target included). */
function setup(over = {}) {
  const w = world();
  const doc = target({ visibilityState: "visible" });
  const win = target();
  const live = createLive({ win, doc, fetch: w.fetch, locks: undefined, BroadcastChannel: undefined, random: () => 0, ...over.live });
  live.start();
  const got = [], ended = vi.fn();
  const open = (id = RUN, o = {}) => openRunStream(id, { onEvent: (e) => got.push(e.seq), onEnd: ended, env: { fetch: w.fetch, win, live, random: () => 0 }, ...o });
  return { w, doc, win, live, got, ended, open, hide() { doc.visibilityState = "hidden"; doc.fire("visibilitychange"); }, show() { doc.visibilityState = "visible"; doc.fire("visibilitychange"); } };
}

const streamCalls = (w) => w.calls.filter((c) => c.url === URL_);
let opened = [];
beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => { opened.forEach((h) => h.close()); opened = []; vi.useRealTimers(); });
const track = (h) => (opened.push(h), h);

describe("opening (criteria 1 and 3)", () => {
  it("GETs the run's events as an event stream with Last-Event-ID = the last replayed seq", async () => {
    const t = setup(); track(t.open(RUN, { lastSeq: 9 })); await tick();
    expect(streamCalls(t.w)).toHaveLength(1);
    expect(streamCalls(t.w)[0].headers).toEqual({ Accept: "text/event-stream", "Last-Event-ID": "9" });
  });
  it("sends no Last-Event-ID when nothing was replayed", async () => {
    const t = setup(); track(t.open()); await tick();
    expect(streamCalls(t.w)[0].headers).toEqual({ Accept: "text/event-stream" });
  });
  it("hands each run_event over in order", async () => {
    const t = setup(); track(t.open(RUN, { lastSeq: 2 })); await tick();
    t.w.streams[0].push(runEvent(3) + runEvent(4)); await tick();
    expect(t.got).toEqual([3, 4]);
  });
});

describe("dedupe by seq (criterion 3)", () => {
  it("drops frames at or below the last replayed seq (overlapping frames)", async () => {
    const t = setup(); track(t.open(RUN, { lastSeq: 5 })); await tick();
    t.w.streams[0].push(runEvent(4) + runEvent(5) + runEvent(6)); await tick();
    expect(t.got).toEqual([6]);
  });
  it("drops a frame repeated within the stream, and one that goes backwards", async () => {
    const t = setup(); track(t.open()); await tick();
    t.w.streams[0].push(runEvent(1) + runEvent(2) + runEvent(2) + runEvent(1) + runEvent(3)); await tick();
    expect(t.got).toEqual([1, 2, 3]);
  });
  it("after a reconnect resumes from the last seq received and drops a replay that overlaps", async () => {
    const t = setup(); track(t.open()); await tick();
    t.w.streams[0].push(runEvent(1) + runEvent(2)); await tick();
    t.w.streams[0].end(); await tick(3000);
    expect(streamCalls(t.w)[1].headers["Last-Event-ID"]).toBe("2");
    t.w.streams[1].push(runEvent(2) + runEvent(3)); await tick();
    expect(t.got).toEqual([1, 2, 3]);
  });
  it("ignores a frame with no usable seq", async () => {
    const t = setup(); track(t.open()); await tick();
    t.w.streams[0].push(runEvent("x") + runEvent(1.5) + "event: run_event\ndata: {oops\n\n" + runEvent(1)); await tick();
    expect(t.got).toEqual([1]);
  });
});

describe("end, revoked, idle, error, 429 (criterion 1)", () => {
  it("end is terminal: onEnd(status), the stream closes and it never reconnects", async () => {
    const t = setup(); track(t.open()); await tick();
    t.w.streams[0].push(runEvent(1) + frame("end", { status: "succeeded" })); await tick();
    expect(t.ended).toHaveBeenCalledWith("succeeded");
    expect(t.w.open()).toHaveLength(0);
    await tick(120_000);
    expect(streamCalls(t.w)).toHaveLength(1);
  });
  it("revoked stops for good and asks the shell (its D4 path) whether the session ended", async () => {
    const confirm = vi.fn();
    const t = setup(); t.live.confirmSession = confirm;
    track(t.open()); await tick();
    t.w.streams[0].push(frame("revoked", { reason: "principal" })); await tick(120_000);
    expect(confirm).toHaveBeenCalledWith("revoked");
    expect(streamCalls(t.w)).toHaveLength(1);
    expect(t.w.open()).toHaveLength(0);
  });
  it("idle closes without reconnecting; input reopens with Last-Event-ID", async () => {
    const t = setup(); track(t.open()); await tick();
    t.w.streams[0].push(runEvent(1) + frame("idle")); await tick(60_000);
    expect(t.w.open()).toHaveLength(0);
    expect(streamCalls(t.w)).toHaveLength(1);
    t.win.fire("pointerdown"); await tick();
    expect(streamCalls(t.w)).toHaveLength(2);
    expect(streamCalls(t.w)[1].headers["Last-Event-ID"]).toBe("1");
  });
  it("idle also reopens on focus and on a return to a visible tab", async () => {
    for (const wake of [(t) => t.win.fire("focus"), (t) => t.win.fire("keydown"), (t) => { t.hide(); t.show(); }]) {
      const t = setup(); track(t.open()); await tick();
      t.w.streams[0].push(frame("idle")); await tick();
      wake(t); await tick();
      expect(streamCalls(t.w)).toHaveLength(2);
    }
  });
  it("an error frame closes the attempt and backs off (3 s, then 6 s) instead of reconnecting at once", async () => {
    const t = setup(); track(t.open()); await tick();
    t.w.streams[0].push(frame("error", { code: "internal_error" })); await tick(2999);
    expect(streamCalls(t.w)).toHaveLength(1);
    await tick(1);
    expect(streamCalls(t.w)).toHaveLength(2);
    t.w.streams[1].push(frame("error")); await tick(5999);
    expect(streamCalls(t.w)).toHaveLength(2);
    await tick(1);
    expect(streamCalls(t.w)).toHaveLength(3);
  });
  it("a 429 backs off with doubling delays and never loops", async () => {
    const t = setup(); t.w.status = 429; track(t.open()); await tick(2999);
    expect(streamCalls(t.w)).toHaveLength(1);
    await tick(1); expect(streamCalls(t.w)).toHaveLength(2);
    await tick(5999); expect(streamCalls(t.w)).toHaveLength(2);
    await tick(1); expect(streamCalls(t.w)).toHaveLength(3);
    await tick(11_999); expect(streamCalls(t.w)).toHaveLength(3);
  });
  it("a stream that opens and closes at once still backs off", async () => {
    const t = setup(); track(t.open()); await tick();
    t.w.streams[0].end(); await tick(2999);
    expect(streamCalls(t.w)).toHaveLength(1);
    await tick(1); expect(streamCalls(t.w)).toHaveLength(2);
  });
});

describe("one run stream per tab (criterion 2)", () => {
  it("opening another run closes the first before it opens: never two open streams", async () => {
    const t = setup(); const other = "3f2b8c1e-0000-4000-8000-000000000002";
    track(t.open(RUN)); await tick();
    track(t.open(other)); await tick();
    expect(t.w.maxOpen).toBe(1);
    expect(t.w.streams[0].closed).toBe(true);
    expect(t.w.open()).toHaveLength(1);
    expect(t.w.calls.at(-1).url).toBe(`/api/v1/runs/${other}/events`);
  });
  it("the closed first stream neither delivers nor reconnects", async () => {
    const t = setup(); track(t.open(RUN)); await tick();
    track(t.open("3f2b8c1e-0000-4000-8000-000000000002")); await tick(120_000);
    expect(t.w.calls.filter((c) => c.url === URL_)).toHaveLength(1);
    expect(t.w.maxOpen).toBe(1);
  });
});

describe("hidden tab and unsubscribe (criteria 1 and 6)", () => {
  it("closes within 10 s of the tab being hidden through the shell's hook, and reopens on return", async () => {
    const t = setup(); track(t.open()); await tick();
    t.w.streams[0].push(runEvent(1)); await tick();
    t.hide(); await tick(HIDDEN_CLOSE_MS);
    expect(t.w.open()).toHaveLength(0);
    await tick(120_000);
    expect(streamCalls(t.w)).toHaveLength(1); // no reconnect while hidden
    t.show(); await tick();
    expect(t.w.open()).toHaveLength(1);
    expect(streamCalls(t.w)[1].headers["Last-Event-ID"]).toBe("1");
  });
  it("a tab hidden and shown again inside the shell's window keeps the same stream", async () => {
    const t = setup(); track(t.open()); await tick();
    t.hide(); await tick(1000); t.show(); await tick(HIDDEN_CLOSE_MS);
    expect(streamCalls(t.w)).toHaveLength(1);
    expect(t.w.open()).toHaveLength(1);
  });
  it("20 open/close cycles leave the live client's subscriberCount at baseline, no reader open and no window listener", async () => {
    const t = setup(); const base = t.live.subscriberCount(); const listeners = t.win.listeners();
    for (let i = 0; i < 20; i++) {
      const h = t.open(); await tick();
      expect(t.live.subscriberCount()).toBe(base + 1);
      h.close();
      expect(t.live.subscriberCount()).toBe(base);
    }
    expect(t.w.open()).toHaveLength(0);
    expect(t.w.streams).toHaveLength(20);
    expect(t.win.listeners()).toBe(listeners);
  });
  it("close() cancels a pending reconnect", async () => {
    const t = setup(); t.w.status = 500; const h = t.open(); await tick();
    h.close(); await tick(120_000);
    expect(streamCalls(t.w)).toHaveLength(1);
  });
});

describe("no second implementation (criterion 1)", () => {
  it("stream.js has no EventSource and keeps no visibility constant or listener of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../apps/_lib/stream.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/EventSource/);
    expect(src).not.toMatch(/visibilitychange|visibilityState|5000/);
    expect(src).toMatch(/onHidden/);
  });
  it("stream.js imports HEALTHY_MS from the shell instead of keeping a numeric copy", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../apps/_lib/stream.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/HEALTHY_MS\s*=\s*\d/);
    expect(src).not.toMatch(/\b10_?000\b/);
    expect(src).toMatch(/import[^;]*\bHEALTHY_MS\b[^;]*cloud-live\.js/);
  });
});

describe("a stream opened into an already-hidden tab (WS-F2b-POLISH)", () => {
  /** The real setup, but live.visible() and onHidden are driven by hand. */
  function fakeLive(t, visible) {
    let cb = null;
    const lv = { visible: vi.fn(() => visible), onHidden: (f) => { cb = f; return () => { cb = null; }; }, apiFetch: (...a) => t.live.apiFetch(...a), confirmSession: () => {} };
    return { lv, fire: (h) => cb && cb(h) };
  }
  it("makes no fetch while live.visible() is false, then exactly one after onHidden(false)", async () => {
    const t = setup(); const f = fakeLive(t, false);
    t.open(RUN, { env: { fetch: t.w.fetch, win: t.win, live: f.lv, random: () => 0 } }); await tick(60_000);
    expect(streamCalls(t.w)).toHaveLength(0);
    expect(f.lv.visible).toHaveBeenCalledTimes(1);
    f.fire(false); await tick();
    expect(streamCalls(t.w)).toHaveLength(1);
  });
  it("connects at once when live.visible() is true", async () => {
    const t = setup(); const f = fakeLive(t, true);
    t.open(RUN, { env: { fetch: t.w.fetch, win: t.win, live: f.lv, random: () => 0 } }); await tick();
    expect(streamCalls(t.w)).toHaveLength(1);
    expect(f.lv.visible).toHaveBeenCalledTimes(1);
  });
  it("with the real client: a stream opened after the hidden timer fired waits for the tab to return", async () => {
    const t = setup(); t.hide(); await tick(HIDDEN_CLOSE_MS);
    t.open(); await tick(30_000);
    expect(streamCalls(t.w)).toHaveLength(0);
    t.show(); await tick();
    expect(streamCalls(t.w)).toHaveLength(1);
  });
});
