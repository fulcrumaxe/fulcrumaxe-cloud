// apps/workspace/test/features-fail-closed.test.mjs
//
// D#37 WS-B, PR #100 review round: core/features.js's fetchFeatures() used
// to resolve to `{}` on ANY /api/mode read failure (reject or non-2xx).
// Every gated consumer checks `features.X === false`, so `undefined` reads
// as "enabled" -- a failed read opened every gated socket/poll instead of
// closing them. These tests fail on PR #100's reviewed head
// (90ec19f30a082d371bde28ac85dfef64a800afdb) and pass once
// core/features.js fails CLOSED (explicit `false` for every gated flag on
// any read failure).
//
// No jsdom/happy-dom dependency: these four core/*.js modules are plain
// browser globals (document/window/location/WebSocket/sessionStorage), not
// framework components, so a minimal hand-rolled stub is enough to load
// them and observe whether they open a socket or issue a poll -- see
// `fakeElement`/`installFakeBrowser` below. Each test resets the module
// registry (`vi.resetModules()`) so core/features.js's own module-level
// cache (`cached`/`pending`) never leaks between tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Minimal browser stubs -- just enough surface for these five modules to
// load and run without throwing, nothing framework-shaped.
// ---------------------------------------------------------------------------

function fakeElement(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: "",
    className: "",
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    textContent: "",
    innerHTML: "",
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    insertBefore(child) {
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      return child;
    },
    remove() {},
    setAttribute(k, v) {
      el.attributes[k] = v;
    },
    getAttribute(k) {
      return k in el.attributes ? el.attributes[k] : null;
    },
    removeAttribute(k) {
      delete el.attributes[k];
    },
    addEventListener(type, cb) {
      (listeners[type] || (listeners[type] = [])).push(cb);
    },
    removeEventListener(type, cb) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((c) => c !== cb);
    },
    dispatchEvent() {
      return true;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    matches() {
      return false;
    },
    contains() {
      return false;
    },
    focus() {},
    blur() {},
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    get firstChild() {
      return el.children[0] || null;
    },
  };
  return el;
}

// Installs a fresh, minimal document/window/location/sessionStorage/fetch/
// WebSocket on the Node global object and returns the spies a test asserts
// against. `getElementById` auto-vivifies any id it's asked for (always
// truthy) so `if (!taskbar) return;`-style early guards in these modules
// never short-circuit the code path under test.
function installFakeBrowser({ fetchImpl }) {
  const elementsById = new Map();
  const body = fakeElement("body");
  const docListeners = {};

  const document_ = {
    readyState: "complete",
    body,
    getElementById(id) {
      if (!elementsById.has(id)) elementsById.set(id, fakeElement("div"));
      return elementsById.get(id);
    },
    createElement(tag) {
      return fakeElement(tag);
    },
    addEventListener(type, cb) {
      (docListeners[type] || (docListeners[type] = [])).push(cb);
    },
    removeEventListener() {},
  };

  const windowListeners = {};
  const window_ = {
    addEventListener(type, cb) {
      (windowListeners[type] || (windowListeners[type] = [])).push(cb);
    },
    removeEventListener() {},
  };

  const sessionStorageBacking = new Map();
  const sessionStorage_ = {
    getItem(k) {
      return sessionStorageBacking.has(k) ? sessionStorageBacking.get(k) : null;
    },
    setItem(k, v) {
      sessionStorageBacking.set(k, String(v));
    },
    removeItem(k) {
      sessionStorageBacking.delete(k);
    },
  };

  const WebSocketSpy = vi.fn(function FakeWebSocket(url) {
    this.url = url;
    this.readyState = 0;
  });
  WebSocketSpy.OPEN = 1;
  WebSocketSpy.CONNECTING = 0;
  WebSocketSpy.CLOSING = 2;
  WebSocketSpy.CLOSED = 3;

  const fetchSpy = vi.fn(fetchImpl);

  global.document = document_;
  global.window = window_;
  global.location = { protocol: "https:", host: "example.test", hostname: "example.test" };
  global.sessionStorage = sessionStorage_;
  global.WebSocket = WebSocketSpy;
  global.fetch = fetchSpy;
  // A couple of these modules read `window.FULCApps`/`window.FULCWM` --
  // absent is fine, every read is optional-chained or existence-checked.

  return { fetchSpy, WebSocketSpy, window_, document_ };
}

function uninstallFakeBrowser() {
  delete global.document;
  delete global.window;
  delete global.location;
  delete global.sessionStorage;
  delete global.WebSocket;
  delete global.fetch;
}

// A fetch stub that fails every /api/mode read the given way, and 200s
// with an empty JSON body for anything else (REST endpoints these modules
// call unconditionally before their gate check, e.g. entitlements' own
// REST_URL) so those calls don't themselves throw and mask what's under
// test.
function fetchFailingMode(mode) {
  return function (url) {
    const u = String(url);
    if (u.indexOf("/api/mode") !== -1) {
      if (mode === "reject") return Promise.reject(new Error("network error"));
      if (mode === "500") {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      }
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };
}

async function flushMicrotasks(times = 6) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  uninstallFakeBrowser();
  vi.restoreAllMocks();
  // taskbar.js and tray-update-indicator.js both register a real
  // setInterval unconditionally at import time (the *poll inside* it is
  // what's gated, not the timer registration itself) -- fake timers in the
  // two describes below keep those handles from outliving the test.
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// core/features.js itself
// ---------------------------------------------------------------------------

describe("core/features.js getFeatures() fails CLOSED", () => {
  it("resolves every gated flag to explicit false when fetch rejects", async () => {
    installFakeBrowser({ fetchImpl: fetchFailingMode("reject") });
    const { FULCFeatures } = await import("../shell/core/features.js");
    const features = await FULCFeatures.get();
    expect(features).toEqual({
      presence: false,
      liveEntitlements: false,
      messages: false,
      updates: false,
    });
  });

  it("resolves every gated flag to explicit false when /api/mode returns 500", async () => {
    installFakeBrowser({ fetchImpl: fetchFailingMode("500") });
    const { FULCFeatures } = await import("../shell/core/features.js");
    const features = await FULCFeatures.get();
    expect(features).toEqual({
      presence: false,
      liveEntitlements: false,
      messages: false,
      updates: false,
    });
  });
});

// ---------------------------------------------------------------------------
// core/presence.js -- must construct no WebSocket when the mode read fails
// ---------------------------------------------------------------------------

describe.each(["reject", "500"])("core/presence.js, /api/mode %s", (mode) => {
  it("opens no WebSocket", async () => {
    const { WebSocketSpy } = installFakeBrowser({ fetchImpl: fetchFailingMode(mode) });
    await import("../shell/core/presence.js");
    await flushMicrotasks();
    expect(WebSocketSpy).not.toHaveBeenCalled();
  });
});

describe("core/presence.js control: opens a WebSocket when features are healthy", () => {
  it("constructs a WebSocket when /api/mode succeeds with presence enabled", async () => {
    const { WebSocketSpy } = installFakeBrowser({
      fetchImpl: function (url) {
        const u = String(url);
        if (u.indexOf("/api/mode") !== -1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ mode: "cloud", features: { presence: true } }),
          });
        }
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      },
    });
    await import("../shell/core/presence.js");
    await flushMicrotasks();
    expect(WebSocketSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// core/entitlements.js -- must open no WebSocket when the mode read fails
// ---------------------------------------------------------------------------

describe.each(["reject", "500"])("core/entitlements.js, /api/mode %s", (mode) => {
  it("opens no WebSocket", async () => {
    const { WebSocketSpy, window_ } = installFakeBrowser({ fetchImpl: fetchFailingMode(mode) });
    // entitlements.js attaches itself to `window.FULCEntitlements` at
    // import time but does not auto-init -- call init() explicitly, same
    // as core/boot.js does in the real app.
    await import("../shell/core/entitlements.js");
    await window_.FULCEntitlements.init();
    await flushMicrotasks();
    expect(WebSocketSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// core/taskbar.js -- updateBadge() must issue no poll when the mode read fails
// ---------------------------------------------------------------------------

describe.each(["reject", "500"])("core/taskbar.js, /api/mode %s", (mode) => {
  it("updateBadge() makes no /api/messages/unread request", async () => {
    // taskbar.js registers `setInterval(updateBadge, 30000)` unconditionally
    // at import time -- only the poll *inside* updateBadge is gated. Fake
    // timers keep that real 30s handle from outliving this test.
    vi.useFakeTimers();
    const { fetchSpy, window_ } = installFakeBrowser({ fetchImpl: fetchFailingMode(mode) });
    await import("../shell/core/taskbar.js");
    await flushMicrotasks();
    await window_.FULCTaskbar.updateBadge();
    await flushMicrotasks();
    const unreadCalls = fetchSpy.mock.calls.filter((args) => String(args[0]).indexOf("/api/messages/unread") !== -1);
    expect(unreadCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// core/tray-update-indicator.js -- start() must open no interval/poll
// ---------------------------------------------------------------------------

describe.each(["reject", "500"])("core/tray-update-indicator.js, /api/mode %s", (mode) => {
  it("opens no poll interval and makes no /api/updates/status request", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const { fetchSpy } = installFakeBrowser({ fetchImpl: fetchFailingMode(mode) });
    const { FULCTrayUpdateIndicator } = await import("../shell/core/tray-update-indicator.js");
    // The module auto-starts on import (its tray container always exists
    // in this stub), but await it explicitly too so the assertions below
    // never race a still-pending gate check.
    await FULCTrayUpdateIndicator.start();
    await flushMicrotasks();

    const statusCalls = fetchSpy.mock.calls.filter((args) => String(args[0]).indexOf("/api/updates/status") !== -1);
    expect(statusCalls).toEqual([]);

    const pollIntervalCalls = setIntervalSpy.mock.calls.filter((args) => args[1] === 30_000);
    expect(pollIntervalCalls).toEqual([]);
  });
});
