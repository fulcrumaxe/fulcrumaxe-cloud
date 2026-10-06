// ── fulcrumaxe workspace live client ────────────────────────────────────────
// D#37 WS-LV1 (correction C28). The ONE account event stream for the whole
// browser: apps subscribe with on()/onRefresh() and never open
// /api/v1/events themselves. Signed-in only (started by the boot:desktop-ready
// mark, which the shell reaches only after /api/cloud/auth/me answered 200),
// one stream per browser (a Web Locks leader, other tabs get events over a
// BroadcastChannel), closed while hidden or idle, cookie auth only.
//
// The stream is read with fetch() rather than EventSource: EventSource cannot
// send Last-Event-ID on a reopen we start ourselves, cannot see the `:
// heartbeat` comment frames (needed for the 50 s dead-stream rule), and hides
// the HTTP status. The URL is the bare relative /api/v1/events, same-origin
// cookies, no query string and no token.
//
// The server decides a session has ended, never a message: a `revoked` frame,
// a 401 through apiFetch() or a `session-ended` message from another tab each
// trigger exactly one GET /api/cloud/auth/me, and only its 401 ends the session.

import { signOut } from "./cloud-signout.js";
import { getNamespace } from "./storage-ns.js";

const STREAM_URL = "/api/v1/events";
const ME_URL = "/api/cloud/auth/me";
export const HIDDEN_CLOSE_MS = 5000; // spec: closed within 10 s of the tab being hidden
const DEAD_STREAM_MS = 50000; // two missed 25 s heartbeats
const BACKSTOP_MS = 10000;
const BACKOFF_BASE_MS = 3000;
const BACKOFF_MAX_MS = 60000;
const POLL_AFTER_FAILURES = 10;
const POLL_MS = 60000;
const MAX_CHANNEL_BYTES = 4096;
const MAX_BUFFER_BYTES = 64 * 1024; // C29 13(c): a pending buffer or single event over 64 KiB of bytes aborts
export const HEALTHY_MS = 10000; // a stream is healthy once it has lived this long and received bytes
const MAX_ID_LENGTH = 256;
/** 3 s doubling to 60 s; `rand` in [0,1) adds up to 25% jitter, capped at 60 s. */
export function backoffDelay(failures, rand) {
  const base = BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1);
  return Math.min(BACKOFF_MAX_MS, Math.round(base * (1 + 0.25 * rand)));
}

/** One parsed SSE block -> {id, event, data} (comments and empty blocks -> null). */
export function parseFrame(block) {
  let id, event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":") || line === "") continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length || id !== undefined || event !== "message" ? { id, event, data: data.join("\n") } : null;
}

/** An `id:` value is only used as Last-Event-ID when it is short printable ASCII with no spaces. */
export function validId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH && /^[\x21-\x7e]+$/.test(id);
}

/**
 * Incremental SSE parser over bytes. push(Uint8Array) calls onFrame for each complete frame and
 * throws when the buffered bytes (pending buffer plus the incoming chunk) would pass maxBytes,
 * checked before anything is drained. CRLF and CR are normalised to LF, also across chunks.
 */
export function createSseParser(onFrame, maxBytes = MAX_BUFFER_BYTES) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "", skipLF = false;
  return {
    push(bytes) {
      if (encoder.encode(buf).length + bytes.byteLength > maxBytes) throw new Error("stream buffer over limit");
      let text = decoder.decode(bytes, { stream: true });
      if (text) {
        const drop = skipLF && text[0] === "\n"; // the LF half of a CRLF split across chunks
        if (drop) text = text.slice(1);
        if (text || drop) skipLF = text.endsWith("\r");
      }
      buf += text.replace(/\r\n?/g, "\n");
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const frame = parseFrame(buf.slice(0, cut));
        buf = buf.slice(cut + 2);
        if (frame) onFrame(frame);
      }
    },
  };
}

/**
 * The stream transport, shared by every live stream in the shell (one implementation, no EventSource).
 * Resolves `done` (never rejects) with {status, opened}: opened is true only for exactly status 200 with
 * a text/event-stream content type; anything else is refused unparsed. Any read or parse error, and
 * close(), abort the fetch AND cancel and release the reader, so no stream or lock outlives the attempt.
 */
export function openStream(doFetch, { url = STREAM_URL, lastId = "", onOpen, onBytes, onFrame, maxBytes } = {}) {
  const ac = new AbortController();
  let reader = null, closed = false;
  const dropBody = (body) => {
    try { const p = body && body.cancel(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* locked or gone */ }
  };
  const releaseReader = () => {
    const r = reader;
    reader = null;
    if (!r) return;
    try { const p = r.cancel(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* already closed */ }
    try { r.releaseLock(); } catch (e) { /* older engines throw with a read pending */ }
  };
  const close = () => { closed = true; releaseReader(); ac.abort(); }; // cancel first: an aborted body is already errored
  const done = (async () => {
    const out = { status: 0, opened: false };
    try {
      const headers = { Accept: "text/event-stream" };
      if (validId(lastId)) headers["Last-Event-ID"] = lastId;
      const res = await doFetch(url, { method: "GET", credentials: "same-origin", cache: "no-store", headers, signal: ac.signal });
      out.status = res.status;
      const type = String((res.headers && res.headers.get && res.headers.get("content-type")) || "").trim().toLowerCase();
      if (closed || res.status !== 200 || !res.body || !type.startsWith("text/event-stream")) {
        dropBody(res.body);
        return out;
      }
      out.opened = true;
      reader = res.body.getReader();
      const parser = createSseParser((f) => { if (!closed && onFrame) onFrame(f); }, maxBytes);
      if (onOpen) onOpen();
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end || closed) break;
        if (onBytes) onBytes(value);
        parser.push(value);
      }
    } catch (e) { /* aborted, refused, dropped or over the limit: the caller sees opened/status */ }
    finally { close(); }
    return out;
  })();
  return { done, close };
}

export function createLive(env = {}) {
  const win = env.win || globalThis.window || globalThis;
  const doc = env.doc || globalThis.document;
  const doFetch = env.fetch || ((...a) => globalThis.fetch(...a));
  const locks = "locks" in env ? env.locks : globalThis.navigator && globalThis.navigator.locks;
  const BC = "BroadcastChannel" in env ? env.BroadcastChannel : globalThis.BroadcastChannel;
  const rand = env.random || Math.random;
  const endSession = env.signOut || signOut;
  const nsOf = env.getNamespace || getNamespace;
  const onLine = env.onLine || (() => !(globalThis.navigator && globalThis.navigator.onLine === false));

  const subs = new Map(); // type -> Set(handler)
  const refreshSubs = new Set();
  const hiddenSubs = new Set(); // onHidden(): true when the hidden timer fires, false on each return to visible
  let started = false, active = false, idleWait = false, ctl = null, releaseLock = null, lockAbort = null;
  let hiddenTimer = null, deadTimer = null, retryTimer = null, pollTimer = null;
  let failures = 0, lastId = "", lastBackstop = -Infinity, confirming = null, opened = 0, channel = null;

  const visible = () => !doc || doc.visibilityState !== "hidden";
  const timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) };

  let toldHidden = false; // the state onHidden subscribers were last told (visible() reads it)
  const tellHidden = (hidden) => { toldHidden = hidden; for (const h of [...hiddenSubs]) safeCall(h, hidden); };
  function safeCall(handler, arg) {
    try { handler(arg); } catch (e) { console.error("cloud-live: a subscriber threw"); }
  }
  function dispatch(dto) {
    for (const h of [...(subs.get(dto.type) || [])]) safeCall(h, dto);
  }
  function emitRefresh() {
    for (const h of [...refreshSubs]) safeCall(h);
  }
  function post(msg) {
    try { if (channel) channel.postMessage(msg); } catch (e) { /* best-effort */ }
  }

  // ── session authority (D4) ────────────────────────────────────────────
  function confirmSession(reason) {
    if (confirming) return confirming;
    confirming = (async () => {
      try {
        const res = await doFetch(ME_URL, { credentials: "include" });
        if (res.status === 401) {
          post({ type: "session-ended" });
          shutdown();
          await endSession({ serverEnded: true });
        } else if (res.ok && reason === "revoked" && started) {
          failures = 0;
          emitRefresh();
          wake();
          if (active && !ctl) { idleWait = false; timers.clear(retryTimer); connect(); }
        }
      } catch (e) { /* offline: the next trigger asks again */ }
      finally { confirming = null; }
    })();
    return confirming;
  }

  // ── offline bar (H4b) ─────────────────────────────────────────────────
  // One fixed bar for the whole desktop. It shows when the browser says it is offline or a request could
  // not reach the server, and goes away when the browser is back online or any response arrives.
  const OFFLINE_BAR_ID = "fx-offline-bar";
  const OFFLINE_BAR_TEXT = "You're offline, retrying when you're back";
  let offline = false, bar = null;
  function setOffline(next) {
    if (next === offline) return;
    offline = next;
    if (!doc || !doc.body || typeof doc.createElement !== "function") return;
    if (next) {
      if (!bar) {
        bar = doc.createElement("div");
        bar.id = OFFLINE_BAR_ID;
        bar.setAttribute("role", "status");
        bar.setAttribute("aria-live", "polite");
        bar.textContent = OFFLINE_BAR_TEXT;
        bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483000;padding:6px 16px;text-align:center;font:13px/1.4 system-ui,sans-serif;background:#7a4b00;color:#fff;";
      }
      doc.body.appendChild(bar);
    } else if (bar && bar.parentNode) {
      bar.parentNode.removeChild(bar);
    }
  }
  function onOffline() { setOffline(true); }
  function onOnline() {
    if (offline) lastBackstop = -Infinity; // coming back from offline always refreshes, once: the backstop in onWake emits it
    setOffline(false);
    onWake();
  }

  /** fetch() for apps: a 401 from any /api/ call asks the server whether the session ended. */
  async function apiFetch(input, init) {
    let res;
    try {
      res = await doFetch(input, init);
    } catch (e) {
      if (!(e && e.name === "AbortError")) setOffline(true); // an abort is a deadline or a caller, not the network
      throw e;
    }
    setOffline(false); // any answer at all means the server is reachable
    if (res.status === 401) confirmSession("401");
    return res;
  }

  // ── backstop (D5) ─────────────────────────────────────────────────────
  function backstop() {
    const now = Date.now();
    if (now - lastBackstop < BACKSTOP_MS) return;
    lastBackstop = now;
    emitRefresh();
    confirmSession("backstop");
  }

  // ── the stream ────────────────────────────────────────────────────────
  function handleFrame(f) {
    if (validId(f.id)) lastId = f.id;
    if (f.event === "revoked") return void confirmSession("revoked");
    if (f.event === "idle") { // close now, reopen on input, focus or visibility
      idleWait = true;
      failures = 0;
      if (ctl) { const c = ctl; ctl = null; c.close(); }
      timers.clear(deadTimer);
      return;
    }
    if (f.event === "resync") return void emitRefresh();
    if (f.event === "error") return void (ctl && ctl.close());
    let dto;
    try { dto = JSON.parse(f.data); } catch (e) { return; }
    if (!dto || typeof dto !== "object" || typeof dto.type !== "string") return;
    if (locks) post({ type: "event", event: dto });
    dispatch(dto);
  }

  function armDeadTimer(mine) {
    timers.clear(deadTimer);
    deadTimer = timers.set(() => { if (ctl === mine) mine.close(); }, DEAD_STREAM_MS);
  }

  async function connect() {
    if (!active || ctl) return;
    const startedAt = Date.now();
    const first = opened++ === 0;
    let gotBytes = false, healthy = false, healthyTimer = null;
    // Failures reset only once a stream has stayed up: 200-then-close must still back off.
    const markHealthy = () => { if (healthy) return; healthy = true; failures = 0; clearPoll(); };
    const mine = openStream(doFetch, {
      lastId,
      onOpen: () => {
        setOffline(false);
        armDeadTimer(mine);
        if (!first) backstop();
        healthyTimer = timers.set(() => { if (gotBytes) markHealthy(); }, HEALTHY_MS);
      },
      onBytes: () => {
        gotBytes = true;
        armDeadTimer(mine);
        if (Date.now() - startedAt >= HEALTHY_MS) markHealthy();
      },
      onFrame: (f) => { if (ctl === mine) handleFrame(f); },
    });
    ctl = mine;
    const res = await mine.done;
    timers.clear(healthyTimer);
    if (res.status === 401) confirmSession("401");
    if (ctl !== mine) return; // stop() or a newer stream owns the state now
    timers.clear(deadTimer);
    ctl = null;
    // A stream that lived a while and ended cleanly (the server's 12 to 13 minute
    // roll) reconnects at once; anything else backs off.
    if (healthy || (res.opened && gotBytes && Date.now() - startedAt >= HEALTHY_MS)) failures = 0;
    else failures++;
    if (active) scheduleReconnect();
  }

  function scheduleReconnect() {
    timers.clear(retryTimer);
    if (failures >= POLL_AFTER_FAILURES) return startPoll();
    retryTimer = timers.set(connect, failures ? backoffDelay(failures, rand()) : 0);
  }

  function clearPoll() { timers.clear(pollTimer); pollTimer = null; }
  function startPoll() {
    if (pollTimer) return;
    const tick = async () => {
      pollTimer = timers.set(tick, POLL_MS);
      try {
        const res = await doFetch(STREAM_URL + (lastId ? "?cursor=" + encodeURIComponent(lastId) : ""), {
          headers: { Accept: "application/json" }, cache: "no-store",
        });
        if (res.status === 401) confirmSession("401");
        if (res.ok) {
          const page = await res.json();
          if (validId(page.next_cursor)) lastId = page.next_cursor;
          if (page.resync) emitRefresh();
          for (const dto of Array.isArray(page.data) ? page.data : []) if (dto && typeof dto.type === "string") dispatch(dto);
        }
      } catch (e) { /* next tick */ }
      if (active && !ctl) connect(); // one stream attempt a minute; success ends the poll
    };
    pollTimer = timers.set(tick, POLL_MS);
  }

  // ── leadership (D3) and lifecycle ─────────────────────────────────────
  function lead(release) {
    releaseLock = release;
    active = true;
    connect();
  }
  function wake() {
    if (!started || !visible()) return;
    if (active) { if (idleWait) { idleWait = false; connect(); } return; }
    if (!locks) return lead(null);
    if (lockAbort) return;
    lockAbort = new AbortController();
    locks.request("fx-live:" + (nsOf() || "default"), { signal: lockAbort.signal }, () => new Promise((release) => lead(release)))
      .catch(() => {}).finally(() => { lockAbort = null; });
  }
  /** Close the stream and give up leadership (hidden tab, idle stream, session ended). */
  function stop() {
    active = false;
    idleWait = false;
    if (ctl) { const c = ctl; ctl = null; c.close(); }
    for (const t of [deadTimer, retryTimer, hiddenTimer]) timers.clear(t);
    clearPoll();
    if (lockAbort) { lockAbort.abort(); lockAbort = null; }
    if (releaseLock) { const r = releaseLock; releaseLock = null; r(); }
  }

  function onChannel(m) {
    const msg = m && m.data;
    let size = 0;
    try { size = JSON.stringify(msg).length; } catch (e) { return; }
    if (!msg || typeof msg !== "object" || size > MAX_CHANNEL_BYTES) return;
    if (msg.type === "session-ended") return void confirmSession("channel");
    if (msg.type === "event" && msg.event && typeof msg.event === "object" && typeof msg.event.type === "string") dispatch(msg.event);
  }

  function onVisibility() {
    if (!visible()) {
      timers.clear(hiddenTimer);
      hiddenTimer = timers.set(() => { stop(); tellHidden(true); }, HIDDEN_CLOSE_MS);
      if (lockAbort) { lockAbort.abort(); lockAbort = null; }
      return;
    }
    timers.clear(hiddenTimer);
    tellHidden(false);
    wake();
    backstop();
  }
  function onWake() { wake(); backstop(); }

  function start() {
    if (started) return;
    started = true;
    if (BC) {
      try { channel = new BC("fx-live-" + (nsOf() || "default")); channel.onmessage = onChannel; } catch (e) { channel = null; }
    }
    doc && doc.addEventListener("visibilitychange", onVisibility);
    win.addEventListener("focus", onWake);
    win.addEventListener("online", onOnline);
    win.addEventListener("offline", onOffline);
    for (const ev of ["pointerdown", "keydown"]) win.addEventListener(ev, wake, { passive: true });
    if (!onLine()) setOffline(true);
    wake();
  }
  function shutdown() {
    started = false;
    stop();
    doc && doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("focus", onWake);
    win.removeEventListener("online", onOnline);
    win.removeEventListener("offline", onOffline);
    setOffline(false);
    for (const ev of ["pointerdown", "keydown"]) win.removeEventListener(ev, wake);
    if (channel) { channel.close(); channel = null; }
  }

  // ── subscriber API ────────────────────────────────────────────────────
  function on(type, handler) {
    if (!subs.has(type)) subs.set(type, new Set());
    subs.get(type).add(handler);
    return () => subs.get(type).delete(handler);
  }
  function onRefresh(handler) {
    refreshSubs.add(handler);
    return () => refreshSubs.delete(handler);
  }
  function onHidden(handler) {
    hiddenSubs.add(handler);
    return () => hiddenSubs.delete(handler);
  }
  function subscriberCount() {
    let n = refreshSubs.size + hiddenSubs.size;
    for (const s of subs.values()) n += s.size;
    return n;
  }

  return { start, shutdown, close: shutdown, on, onRefresh, apiFetch, subscriberCount, confirmSession, onHidden, visible: () => !toldHidden, offline: () => offline };
}

const live = createLive();
export const { on, onRefresh, apiFetch, subscriberCount } = live;
export default live;

// Start once the desktop is up (D2). boot-metrics.js marks boot:desktop-ready
// only on the signed-in path, after /api/cloud/auth/me answered 200.
if (typeof PerformanceObserver === "function" && typeof performance !== "undefined") {
  const go = () => live.start();
  if (performance.getEntriesByName("boot:desktop-ready").length) go();
  else {
    try {
      const po = new PerformanceObserver((list) => {
        if (list.getEntries().some((e) => e.name === "boot:desktop-ready")) { po.disconnect(); go(); }
      });
      po.observe({ type: "mark", buffered: true });
    } catch (e) { /* no mark observer: no live client, the focus re-fetch is unavailable too */ }
  }
}
