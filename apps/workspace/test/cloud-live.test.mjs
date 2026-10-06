// apps/workspace/test/cloud-live.test.mjs
//
// D#37 WS-LV1 (correction C28): the shell live client, against a fake fetch
// stream, fake Web Locks, a fake BroadcastChannel and vitest's fake clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTHY_MS, HIDDEN_CLOSE_MS, backoffDelay, createLive, createSseParser, openStream, parseFrame, validId } from "../shell/core/cloud-live.js";

function target(extra = {}) {
  const h = new Map();
  return Object.assign(extra, {
    addEventListener: (t, f) => h.set(t, [...(h.get(t) || []), f]),
    removeEventListener: (t, f) => h.set(t, (h.get(t) || []).filter((x) => x !== f)),
    fire: (t) => (h.get(t) || []).forEach((f) => f({ type: t })),
  });
}

/** Everything a set of tabs shares: the server, the lock table and the channel bus. */
const hdr = (type) => ({ get: (k) => (k.toLowerCase() === "content-type" ? type : null) });
function world({ locks = true } = {}) {
  const w = { streams: [], calls: [], meStatus: 200, streamStatus: 200, streamType: "text/event-stream; charset=utf-8", maxOpen: 0, bus: new Set(), holder: null, queue: [] };
  const grant = () => {
    if (w.holder || !w.queue.length) return;
    const q = w.queue.shift();
    if (q.signal.aborted) return grant();
    w.holder = q;
    q.cb().then(() => { w.holder = null; grant(); });
  };
  w.locks = locks ? { request: (name, o, cb) => new Promise((res, rej) => {
    const q = { cb, signal: o.signal };
    o.signal.addEventListener("abort", () => { if (w.holder !== q) rej(new Error("aborted")); });
    w.queue.push(q); grant();
  }) } : undefined;
  w.fetch = async (url, init = {}) => {
    w.calls.push({ url, init, at: Date.now() });
    if (url === "/api/cloud/auth/me") return { status: w.meStatus, ok: w.meStatus < 300 };
    if (init.headers && init.headers.Accept === "application/json") {
      return { status: 200, ok: true, json: async () => ({ data: [{ id: "p", type: "polled", data: {} }], next_cursor: "cur-2" }) };
    }
    if (w.streamStatus !== 200) return { status: w.streamStatus, ok: w.streamStatus < 300, headers: hdr(w.streamType), body: w.streamStatus === 204 ? null : new ReadableStream() };
    let ctrl;
    const s = { closed: false, cancelled: false, push: (t) => ctrl.enqueue(typeof t === "string" ? new TextEncoder().encode(t) : t), close: () => { s.closed = true; try { ctrl.close(); } catch { /* aborted */ } } };
    const body = new ReadableStream({ start: (c) => { ctrl = c; }, cancel: () => { s.cancelled = true; s.closed = true; } });
    s.ctrl = ctrl; s.body = body; s.init = init;
    init.signal.addEventListener("abort", () => { s.closed = true; try { ctrl.error(new Error("abort")); } catch { /* closed */ } });
    w.streams.push(s);
    w.maxOpen = Math.max(w.maxOpen, w.open().length);
    return { status: 200, ok: true, headers: hdr(w.streamType), body };
  };
  w.tab = (over = {}) => {
    const doc = target({ visibilityState: "visible" });
    const win = target();
    class BC { constructor() { this.self = this; w.bus.add(this); } postMessage(m) { w.bus.forEach((b) => b !== this && b.onmessage && b.onmessage({ data: JSON.parse(JSON.stringify(m)) })); } close() { w.bus.delete(this); } }
    const ended = vi.fn();
    const refresh = vi.fn();
    const live = createLive({ win, doc, fetch: w.fetch, locks: w.locks, BroadcastChannel: BC, random: () => 0, getNamespace: () => "ns", signOut: ended, ...over });
    live.onRefresh(refresh);
    return { live, doc, win, ended, refresh, hide() { doc.visibilityState = "hidden"; doc.fire("visibilitychange"); }, show() { doc.visibilityState = "visible"; doc.fire("visibilitychange"); } };
  };
  w.open = () => w.streams.filter((s) => !s.closed);
  w.me = () => w.calls.filter((c) => c.url === "/api/cloud/auth/me").length;
  return w;
}
const ev = (type, id = "c1") => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ id: "e", type, created_at: "t", data: {} })}\n\n`;
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

describe("stream ownership (criterion 1)", () => {
  it("two tabs share one stream and both see its events", async () => {
    const w = world();
    const a = w.tab(), b = w.tab();
    const seenA = vi.fn(), seenB = vi.fn();
    a.live.on("pr.opened", seenA); b.live.on("pr.opened", seenB);
    a.live.start(); b.live.start(); await tick();
    expect(w.streams).toHaveLength(1);
    w.streams[0].push(ev("pr.opened")); await tick();
    expect(seenA).toHaveBeenCalledTimes(1);
    expect(seenB).toHaveBeenCalledTimes(1);
    expect(seenB.mock.calls[0][0]).toMatchObject({ type: "pr.opened", created_at: "t" });
  });

  it("a hidden leader closes within 10 s, releases the lock, and the visible tab takes over", async () => {
    const w = world();
    const a = w.tab(), b = w.tab();
    a.live.start(); await tick(); b.live.start(); await tick();
    expect(w.streams).toHaveLength(1);
    a.hide(); await tick(10_000);
    expect(w.streams[0].closed).toBe(true);
    expect(w.streams).toHaveLength(2);
    expect(w.open()).toHaveLength(1);
  });

  it("without Web Locks every tab opens its own stream", async () => {
    const w = world({ locks: false });
    const a = w.tab(), b = w.tab();
    a.live.start(); b.live.start(); await tick();
    expect(w.streams).toHaveLength(2);
  });

  it("is lazy: nothing is fetched before start(), and shutdown closes the stream", async () => {
    const w = world();
    const a = w.tab(); await tick(5000);
    expect(w.calls).toHaveLength(0);
    a.live.start(); await tick();
    expect(w.open()).toHaveLength(1);
    a.live.shutdown(); await tick();
    expect(w.open()).toHaveLength(0);
  });
});

describe("rules moved from Pipeline (criterion 3)", () => {
  it("idle closes the stream and input reopens it", async () => {
    const w = world(); const a = w.tab();
    a.live.start(); await tick();
    w.streams[0].push("event: idle\ndata: {}\n\n"); await tick();
    expect(w.open()).toHaveLength(0);
    await tick(120_000);
    expect(w.streams).toHaveLength(1);
    a.win.fire("pointerdown"); await tick();
    expect(w.open()).toHaveLength(1);
  });

  it("hidden closes within 10 s; visible reopens with Last-Event-ID and one refresh", async () => {
    const w = world(); const a = w.tab();
    a.live.start(); await tick();
    w.streams[0].push(ev("pr.opened", "cursor-9")); await tick();
    a.hide(); await tick(10_000);
    expect(w.open()).toHaveLength(0);
    a.refresh.mockClear();
    a.show(); await tick();
    expect(w.open()).toHaveLength(1);
    expect(w.calls.filter((c) => c.url === "/api/v1/events").at(-1).init.headers["Last-Event-ID"]).toBe("cursor-9");
    expect(a.refresh).toHaveBeenCalledTimes(1);
  });

  it("backs off 3 s to 60 s with jitter", async () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, 0))).toEqual([3000, 6000, 12000, 24000, 48000, 60000, 60000]);
    expect(backoffDelay(1, 0.99)).toBeLessThanOrEqual(3750);
    expect(backoffDelay(9, 0.99)).toBe(60000);
    const w = world(); w.streamStatus = 429;
    const a = w.tab(); a.live.start(); await tick();
    const stamps = () => w.calls.filter((c) => c.url === "/api/v1/events").map((c) => c.at);
    await tick(2999); expect(stamps()).toHaveLength(1);
    await tick(1); expect(stamps()).toHaveLength(2);
    await tick(6000); expect(stamps()).toHaveLength(3);
  });

  it("10 failures switch to a 60 s JSON poll, which ends when a stream opens", async () => {
    const w = world(); w.streamStatus = 429;
    const a = w.tab(), seen = vi.fn(); a.live.on("polled", seen); a.live.start();
    await tick(700_000);
    const polls = w.calls.filter((c) => c.init.headers && c.init.headers.Accept === "application/json");
    expect(polls.length).toBeGreaterThanOrEqual(1);
    expect(seen).toHaveBeenCalled();
    expect(polls.at(-1).url).toBe("/api/v1/events?cursor=cur-2");
    w.streamStatus = 200; await tick(60_000);
    await tick(10_000); w.open()[0].push(": heartbeat\n\n"); await tick(); // healthy: bytes after 10 s
    const before = w.calls.filter((c) => c.init.headers && c.init.headers.Accept === "application/json").length;
    expect(w.open()).toHaveLength(1);
    await tick(180_000);
    expect(w.calls.filter((c) => c.init.headers && c.init.headers.Accept === "application/json").length).toBe(before);
  });

  it("resync sends a refresh", async () => {
    const w = world(); const a = w.tab(); a.live.start(); await tick();
    w.streams[0].push("event: resync\ndata: {}\n\n"); await tick();
    expect(a.refresh).toHaveBeenCalledTimes(1);
  });

  it("50 s without bytes reconnects; heartbeats keep the stream alive", async () => {
    const w = world(); const a = w.tab(); a.live.start(); await tick();
    for (let i = 0; i < 4; i++) { await tick(25_000); w.streams[0].push(": heartbeat\n\n"); }
    expect(w.streams).toHaveLength(1);
    await tick(50_000);
    expect(w.streams[0].closed).toBe(true);
    await tick(4000);
    expect(w.open()).toHaveLength(1);
  });

  it("soak: one active hour with the server closing at 780 s stays within 5 reconnects", async () => {
    const w = world(); const a = w.tab(); a.live.start(); await tick();
    for (let t = 0; t < 3600; t += 25) {
      await tick(25_000);
      if (t % 775 < 25 && t > 0) w.open().forEach((s) => s.close()); else w.open().forEach((s) => s.push(": heartbeat\n\n"));
    }
    expect(w.streams.length - 1).toBeLessThanOrEqual(5);
    expect(w.streams.length).toBeGreaterThan(1);
  });
});

describe("the server decides (criterion 4)", () => {
  it("a revoked frame asks auth/me once; a 401 ends the session with no signout POST of our own", async () => {
    const w = world(); const a = w.tab(); a.live.start(); await tick();
    w.meStatus = 401;
    w.streams[0].push("event: revoked\ndata: {}\n\n"); await tick();
    expect(w.me()).toBe(1);
    expect(a.ended).toHaveBeenCalledWith({ serverEnded: true });
    expect(w.calls.some((c) => c.url === "/api/auth/signout")).toBe(false);
    expect(w.open()).toHaveLength(0);
  });

  it("a 200 reconnects with a refresh and no cleanup", async () => {
    const w = world(); const a = w.tab(); a.live.start(); await tick();
    w.streams[0].push("event: revoked\ndata: {}\n\n"); await tick();
    expect(w.me()).toBe(1);
    expect(a.ended).not.toHaveBeenCalled();
    expect(a.refresh).toHaveBeenCalledTimes(1);
    expect(w.open()).toHaveLength(1);
  });

  it("a 401 through apiFetch asks auth/me exactly once", async () => {
    const w = world(); const a = w.tab(); a.live.start(); await tick();
    w.meStatus = 401;
    const orig = w.fetch;
    const b = w.tab({ fetch: async (u, i) => (u === "/api/v1/tokens" ? { status: 401, ok: false } : orig(u, i)) });
    await Promise.all([b.live.apiFetch("/api/v1/tokens"), b.live.apiFetch("/api/v1/tokens")]);
    await tick();
    expect(w.me()).toBe(1);
    expect(b.ended).toHaveBeenCalledTimes(1);
  });

  it("a forged session-ended message is confirmed first and clears nothing while auth/me says 200", async () => {
    const w = world(); const a = w.tab(), b = w.tab();
    a.live.start(); b.live.start(); await tick();
    const forged = [...w.bus][0];
    forged.onmessage({ data: { type: "session-ended" } }); await tick();
    expect(w.me()).toBeGreaterThanOrEqual(1);
    expect(a.ended).not.toHaveBeenCalled();
    expect(b.ended).not.toHaveBeenCalled();
  });

  it("a real session-ended (401) is broadcast, and the other tab confirms before clearing", async () => {
    const w = world(); const a = w.tab(), b = w.tab();
    a.live.start(); b.live.start(); await tick();
    w.meStatus = 401;
    a.live.confirmSession("revoked"); await tick();
    expect(a.ended).toHaveBeenCalled();
    expect(b.ended).toHaveBeenCalled();
    expect(w.me()).toBe(2);
  });

  it("drops malformed channel messages", async () => {
    const w = world(); const a = w.tab(), b = w.tab(), seen = vi.fn();
    a.live.start(); b.live.start(); b.live.on("x", seen); await tick();
    const chan = [...w.bus].find((c) => c.onmessage);
    for (const data of ["text", 7, null, [], { type: "nope" }, { type: "event", event: "no" }, { type: "session-ended", pad: "x".repeat(5000) }, { type: "event", event: { type: "x", pad: "y".repeat(5000) } }]) chan.onmessage({ data });
    await tick();
    expect(seen).not.toHaveBeenCalled();
    expect(w.me()).toBe(0);
  });
});

describe("backstop (criterion 5) and subscribers (criterion 6)", () => {
  it("five triggers within 10 s send one refresh and one auth/me; the next window sends one more", async () => {
    const w = world(); const a = w.tab(); a.live.start(); await tick();
    a.refresh.mockClear();
    a.hide(); a.show(); a.win.fire("focus"); a.win.fire("online"); a.show(); await tick(1000);
    expect(a.refresh).toHaveBeenCalledTimes(1);
    expect(w.me()).toBe(1);
    await tick(10_000); a.win.fire("focus"); await tick();
    expect(a.refresh).toHaveBeenCalledTimes(2);
    expect(w.me()).toBe(2);
  });

  it("on and onRefresh return unsubscribes; a throwing handler stops nobody and logs no secret", async () => {
    const w = world(); const a = w.tab(); const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = vi.fn();
    a.live.on("t", () => { throw new Error("secret fxat_123"); });
    const off = a.live.on("t", ok);
    a.live.start(); await tick();
    w.streams[0].push(ev("t")); await tick();
    expect(ok).toHaveBeenCalledWith({ id: "e", type: "t", created_at: "t", data: {} });
    expect(JSON.stringify(err.mock.calls)).not.toContain("fxat_");
    off(); w.streams[0].push(ev("t")); await tick();
    expect(ok).toHaveBeenCalledTimes(1);
    const offRefresh = a.live.onRefresh(() => {});
    const n = a.live.subscriberCount(); offRefresh();
    expect(a.live.subscriberCount()).toBe(n - 1);
    err.mockRestore();
  });
});

describe("security (criterion 7)", () => {
  it("the stream request is the bare relative URL, cookie auth only, and the channel carries only {type, event}", async () => {
    const w = world(); const a = w.tab(), b = w.tab(); b.live.on("pr.opened", () => {});
    a.live.start(); b.live.start(); await tick();
    const call = w.calls[0];
    expect(call.url).toBe("/api/v1/events");
    expect(call.init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", headers: { Accept: "text/event-stream" } });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(call.init.headers)).toEqual(["Accept"]);
    const sent = [];
    [...w.bus][1].onmessage = (m) => sent.push(m.data);
    w.streams[0].push(ev("pr.opened")); await tick();
    expect(sent.every((m) => Object.keys(m).sort().join() === "event,type")).toBe(true);
  });

  it("parseFrame reads id, event and multi-line data, and ignores comments", () => {
    expect(parseFrame(": heartbeat")).toBeNull();
    expect(parseFrame("id: a\nevent: x\ndata: 1\ndata: 2")).toEqual({ id: "a", event: "x", data: "1\n2" });
  });
});

// ── C29 criterion 13: the parser and the transport ─────────────────────────
const enc = (t) => new TextEncoder().encode(t);
const parseAll = (chunks) => {
  const out = [];
  const p = createSseParser((f) => out.push(f));
  for (const c of chunks) p.push(typeof c === "string" ? enc(c) : c);
  return out;
};
const streamCalls = (w) => w.calls.filter((c) => c.url === "/api/v1/events" && c.init.headers.Accept === "text/event-stream");

describe("13(a) line endings and fields", () => {
  const expected = [{ id: "7", event: "x", data: "a\nb" }, { id: undefined, event: "message", data: "z" }];
  const lines = ["id: 7", "event: x", "data: a", "data: b", "", ": comment", "retry: 5", "unknown: 1", "data: z", "", ""];
  it.each([["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]])("parses %s line endings", (_n, eol) => {
    expect(parseAll([lines.join(eol)])).toEqual(expected);
  });
  it("parses mixed line endings, and a CRLF split between the CR and the LF", () => {
    expect(parseAll(["id: 7\r\nevent: x\ndata: a\rdata: b\r\r\n: c\n", "data: z\n\n"])).toEqual(expected);
    expect(parseAll(["id: 7\revent: x\rdata: a\rdata: b\r", "\n", "\r", "\ndata: z\r\n\r\n"])).toEqual(expected);
  });
  it("ignores retry and unknown fields and reads a comment-only block as nothing", () => {
    expect(parseAll(["retry: 1\nfoo: bar\n\n: heartbeat\n\n"])).toEqual([]);
  });
});

describe("13(b) a frame split at every byte offset", () => {
  it("parses the same as the unsplit frame, including a multi-byte UTF-8 character", () => {
    const text = "id: c-1\r\nevent: pr.opened\r\ndata: {\"t\":\"café € 😀\"}\r\n\r\n";
    const bytes = enc(text);
    const whole = parseAll([bytes]);
    expect(whole).toHaveLength(1);
    expect(whole[0].data).toContain("café € 😀");
    for (let i = 0; i <= bytes.length; i++) expect(parseAll([bytes.slice(0, i), bytes.slice(i)])).toEqual(whole);
  });
});

describe("13(c) the 64 KiB cap is on bytes, and an abort leaves nothing open", () => {
  it("the parser refuses a buffer over 64 KiB of bytes, even when the character count is far below it", () => {
    expect(() => createSseParser(() => {}).push(enc("data: " + "a".repeat(64 * 1024 - 6)))).not.toThrow();
    expect(() => createSseParser(() => {}).push(enc("data: " + "a".repeat(64 * 1024 - 5)))).toThrow();
    const twoByte = "é".repeat(33_000); // 33 000 characters, 66 000 bytes
    expect(twoByte.length).toBeLessThan(64 * 1024);
    expect(() => createSseParser(() => {}).push(enc(twoByte))).toThrow();
  });
  it("counts what is already pending plus the next chunk, before draining", () => {
    const p = createSseParser(() => {});
    p.push(enc("data: " + "a".repeat(40_000)));
    expect(() => p.push(enc("b".repeat(30_000) + "\n\n"))).toThrow();
  });
  it("an oversize event aborts the fetch and cancels the reader, then reconnects with backoff, never two streams", async () => {
    const w = world(); const a = w.tab(); a.live.start(); await tick();
    w.streams[0].push("data: " + "x".repeat(70_000)); await tick();
    expect(w.streams[0].closed).toBe(true);
    expect(w.streams[0].cancelled).toBe(true);
    expect(w.streams[0].init.signal.aborted).toBe(true);
    expect(w.streams[0].body.locked).toBe(false);
    expect(w.open()).toHaveLength(0);
    await tick(2999); expect(w.streams).toHaveLength(1);
    await tick(1); expect(w.streams).toHaveLength(2);
    expect(w.open()).toHaveLength(1);
    expect(w.maxOpen).toBe(1);
  });
  it("a read error aborts, cancels and releases, then reconnects with backoff", async () => {
    const w = world(); const a = w.tab(); a.live.start(); await tick();
    w.streams[0].ctrl.error(new Error("network reset")); await tick();
    expect(w.streams[0].init.signal.aborted).toBe(true);
    expect(w.streams[0].body.locked).toBe(false);
    expect(w.open()).toHaveLength(0);
    await tick(3000);
    expect(w.streams).toHaveLength(2);
    expect(w.maxOpen).toBe(1);
  });
  it("no lease leak: every stream that ends is closed and unlocked, and at most one is ever open, across failures", async () => {
    const w = world(); const a = w.tab(); a.live.start(); await tick();
    for (let i = 0; i < 3; i++) {
      w.open()[0].push("data: " + "x".repeat(70_000)); await tick(70_000);
    }
    w.streams.slice(0, -1).forEach((s) => { expect(s.closed).toBe(true); expect(s.body.locked).toBe(false); });
    expect(w.open()).toHaveLength(1);
    expect(w.maxOpen).toBe(1);
    a.live.close(); await tick();
    expect(w.open()).toHaveLength(0);
  });
});

describe("13(d) exactly 200 and text/event-stream", () => {
  it.each([
    ["a text/html 200", 200, "text/html; charset=utf-8"],
    ["a 200 with no content type", 200, ""],
    ["a 204", 204, "text/event-stream"],
    ["a 500", 500, "text/html"],
  ])("%s is never parsed, is aborted and backs off", async (_n, status, type) => {
    const w = world(); w.streamStatus = status; w.streamType = type;
    const a = w.tab(); const fn = vi.fn(); a.live.on("pr.opened", fn); a.live.start(); await tick();
    expect(fn).not.toHaveBeenCalled();
    expect(a.refresh).not.toHaveBeenCalled();
    expect(streamCalls(w)).toHaveLength(1);
    await tick(2999); expect(streamCalls(w)).toHaveLength(1);
    await tick(1); expect(streamCalls(w)).toHaveLength(2);
    await tick(6000); expect(streamCalls(w)).toHaveLength(3);
    expect(w.open()).toHaveLength(0);
  });
  it("a text/html 200 is refused before its body is read: the body is cancelled, no frame is dispatched", async () => {
    const w = world(); w.streamType = "text/html";
    const a = w.tab(); const fn = vi.fn(); a.live.on("pr.opened", fn); a.live.start(); await tick();
    expect(w.streams[0].cancelled).toBe(true);
    expect(w.streams[0].body.locked).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
  it("a content type is matched by prefix, case-insensitively", async () => {
    const w = world(); w.streamType = "Text/Event-Stream;charset=UTF-8";
    const a = w.tab(); const fn = vi.fn(); a.live.on("pr.opened", fn); a.live.start(); await tick();
    w.streams[0].push(ev("pr.opened")); await tick();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("a 401 takes the auth/me path exactly once and a 401 there ends the session", async () => {
    const w = world(); w.streamStatus = 401; w.meStatus = 401;
    const a = w.tab(); a.live.start(); await tick(20_000);
    expect(w.me()).toBe(1);
    expect(a.ended).toHaveBeenCalledWith({ serverEnded: true });
    expect(streamCalls(w)).toHaveLength(1);
  });
  it("a 429 and a cross-site 403 back off like any other failure and do not loop", async () => {
    for (const status of [429, 403]) {
      const w = world(); w.streamStatus = status;
      const a = w.tab(); a.live.start(); await tick(3000 + 6000 + 12_000);
      expect(streamCalls(w)).toHaveLength(4);
      a.live.close();
    }
  });
});

describe("13(e) close()", () => {
  it("openStream's close() aborts the fetch and releases the reader", async () => {
    const w = world();
    const frames = [];
    const h = openStream(w.fetch, { onFrame: (f) => frames.push(f) });
    await tick();
    const s = w.streams[0];
    expect(s.body.locked).toBe(true);
    h.close();
    const res = await h.done;
    expect(res.opened).toBe(true);
    expect(s.init.signal.aborted).toBe(true);
    expect(s.cancelled).toBe(true);
    expect(s.body.locked).toBe(false);
    expect(frames).toEqual([]);
  });
  it("close() before the response arrives leaves no open reader", async () => {
    const w = world();
    const h = openStream(w.fetch, {});
    h.close(); await h.done; await tick();
    expect(w.open()).toHaveLength(0);
  });
  it("the live client's close() ends the stream and every timer", async () => {
    const w = world(); const a = w.tab(); a.live.start(); await tick();
    a.live.close(); await tick(200_000);
    expect(w.streams).toHaveLength(1);
    expect(w.streams[0].body.locked).toBe(false);
    expect(w.open()).toHaveLength(0);
  });
});

describe("request shape (criterion 7)", () => {
  it("sends Last-Event-ID on a reopen, and only a valid, short id is ever used as one", async () => {
    expect(validId("cur-9_A.b~")).toBe(true);
    for (const bad of ["", "a b", "a\nb", "x".repeat(257), "é", 7, undefined]) expect(validId(bad)).toBe(false);
    const w = world(); const a = w.tab(); a.live.start(); await tick();
    expect(streamCalls(w)[0].init.headers["Last-Event-ID"]).toBeUndefined();
    w.streams[0].push(ev("t", "good-1")); w.streams[0].push(ev("t", "x".repeat(300))); w.streams[0].push(ev("t", "has space")); await tick();
    w.streams[0].close(); await tick(3000);
    expect(streamCalls(w)).toHaveLength(2);
    expect(streamCalls(w)[1].init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(streamCalls(w)[1].init.headers).toEqual({ Accept: "text/event-stream", "Last-Event-ID": "good-1" });
    expect(streamCalls(w)[1].url).toBe("/api/v1/events");
  });
});

describe("backoff on 200-then-close", () => {
  it("escalates instead of resetting, so a server that opens and drops bounds the rate", async () => {
    const w = world(); const a = w.tab(); a.live.start();
    for (let t = 0; t < 3200; t++) { await tick(100); w.open().forEach((s) => s.close()); }
    const at = streamCalls(w).map((c) => c.at);
    const gaps = at.slice(1).map((v, i) => v - at[i]);
    expect(gaps.slice(0, 5).map((g) => Math.floor(g / 1000))).toEqual([3, 6, 12, 24, 48]);
    expect(at.length).toBeLessThanOrEqual(10);
  });
  it("resets only after a stream has stayed up and received bytes", async () => {
    const w = world(); w.streamStatus = 500; const a = w.tab(); a.live.start(); await tick(3000 + 6000);
    expect(streamCalls(w)).toHaveLength(3);
    w.streamStatus = 200;
    await tick(12_000); // the third failure's delay
    expect(w.open()).toHaveLength(1);
    await tick(12_000); w.open()[0].push(": heartbeat\n\n"); // 12 s in, a heartbeat: healthy
    await tick(); w.open()[0].close(); await tick();
    expect(streamCalls(w)).toHaveLength(5); // reopened at once, no 3 s wait
    expect(w.open()).toHaveLength(1);
  });
  it("a stream that stays silent past 10 s is not healthy", async () => {
    const w = world(); const a = w.tab(); a.live.start(); await tick(15_000);
    w.open()[0].close(); await tick();
    expect(w.open()).toHaveLength(0); // failures went up: the next attempt waits
    await tick(3000);
    expect(w.open()).toHaveLength(1);
  });
});

describe("visible() accessor (WS-F2b-POLISH): the state onHidden subscribers were last told", () => {
  it("is true at start, still true through the 5 s grace, false once the timer fires, true again on return", async () => {
    const w = world(); const a = w.tab(); const seen = vi.fn();
    a.live.onHidden(seen); a.live.start(); await tick();
    expect(a.live.visible()).toBe(true);
    a.hide(); await tick(HIDDEN_CLOSE_MS - 1);
    expect(a.live.visible()).toBe(true); // raw visibilityState is already hidden here; the accessor is not
    await tick(1);
    expect(a.live.visible()).toBe(false);
    expect(seen).toHaveBeenLastCalledWith(true);
    a.show(); await tick();
    expect(a.live.visible()).toBe(true);
    expect(seen).toHaveBeenLastCalledWith(false);
  });
  it("exports the one HEALTHY_MS the run stream shares", () => { expect(HEALTHY_MS).toBe(10000); });
});

describe("onHidden hook (WS-F2b): the account stream is unchanged", () => {
  const hiddenClose = async (withHook) => {
    const w = world(); const a = w.tab(); const seen = vi.fn();
    if (withHook) a.live.onHidden(seen);
    a.live.start(); await tick();
    w.streams[0].push(ev("pr.opened", "cursor-7")); await tick();
    a.hide();
    await tick(HIDDEN_CLOSE_MS - 1);
    const openBefore = w.open().length;
    await tick(1);
    const closedAt = w.open().length;
    a.show(); await tick();
    const reopen = w.calls.filter((c) => c.url === "/api/v1/events").at(-1);
    return { openBefore, closedAt, reopenId: reopen.init.headers["Last-Event-ID"], reopened: w.open().length, seen, refreshes: a.refresh.mock.calls.length };
  };
  it("closes at exactly HIDDEN_CLOSE_MS (5 s, within the 10 s rule) and reconnects with Last-Event-ID, with or without a subscriber", async () => {
    expect(HIDDEN_CLOSE_MS).toBe(5000);
    const bare = await hiddenClose(false);
    const hooked = await hiddenClose(true);
    expect(bare).toMatchObject({ openBefore: 1, closedAt: 0, reopenId: "cursor-7", reopened: 1 });
    expect({ ...hooked, seen: 0 }).toEqual({ ...bare, seen: 0 });
  });
  it("tells subscribers true when the hidden timer fires and false on each return to visible; unsubscribe and a throwing subscriber are safe", async () => {
    const w = world(); const a = w.tab(); const seen = vi.fn();
    const off = a.live.onHidden(seen);
    a.live.onHidden(() => { throw new Error("boom"); });
    a.live.start(); await tick();
    expect(a.live.subscriberCount()).toBe(3); // the refresh handler and both hooks
    a.hide(); await tick(HIDDEN_CLOSE_MS - 1);
    expect(seen).not.toHaveBeenCalled();
    await tick(1);
    expect(seen.mock.calls).toEqual([[true]]);
    expect(w.open()).toHaveLength(0);
    a.show(); await tick();
    expect(seen.mock.calls).toEqual([[true], [false]]);
    a.hide(); a.show(); await tick(HIDDEN_CLOSE_MS); // back before the timer: no true
    expect(seen.mock.calls).toEqual([[true], [false], [false]]);
    off();
    expect(a.live.subscriberCount()).toBe(2);
  });
});
