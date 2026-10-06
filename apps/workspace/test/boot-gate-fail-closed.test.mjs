// apps/workspace/test/boot-gate-fail-closed.test.mjs
//
// D#37 WS-L1 fix round 1, should-fix S1: core/boot.js gated the desktop
// behind `cloudSession.workspace_access && cloudSession.workspace_access
// !== 'open'`, which falls through to showDesktop() whenever the field is
// missing or empty -- fails OPEN. The server always sends the field today
// (see subscription-gate.spec.ts's "auth/me keys are exactly ..." check),
// so this never fires live, but the gate's own contract ("anything other
// than 'open' shows the gate") should hold for a missing field too, the
// same way core/features.js fails closed on a bad /api/mode read (see
// features-fail-closed.test.mjs, same harness style).
//
// No jsdom/happy-dom: core/boot.js is a plain browser-global IIFE, so a
// minimal hand-rolled stub is enough to run it and observe whether it
// calls FULCSubscriptionGate.render() or showDesktop().

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function fakeElement(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: "",
    className: "",
    style: {},
    children: [],
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
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
  };
  return el;
}

// Installs just enough of document/window/performance/MutationObserver/
// fetch for core/boot.js's runBoot() to execute end to end: fetchBranding()
// succeeds, fetchModeOrNull() resolves to a "cloud" mode, and
// checkCloudSession() resolves to `authMeBody` (standing in for a real
// GET /api/cloud/auth/me response).
function installBootFakeBrowser({ authMeBody }) {
  const elementsById = new Map();

  const document_ = {
    cookie: "fx_has_session=1",
    documentElement: fakeElement("html"),
    body: fakeElement("body"),
    title: "",
    getElementById(id) {
      if (!elementsById.has(id)) elementsById.set(id, fakeElement("div"));
      return elementsById.get(id);
    },
    createElement(tag) {
      return fakeElement(tag);
    },
    querySelectorAll() {
      return [];
    },
  };

  const window_ = {};

  global.document = document_;
  global.window = window_;
  global.location = { protocol: "https:", host: "example.test", hostname: "example.test" };
  global.performance = { now: () => 0, timing: { navigationStart: 0 } };
  global.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  global.fetch = vi.fn((url) => {
    const u = String(url);
    if (u.indexOf("/api/branding") !== -1) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
    if (u.indexOf("/api/mode") !== -1) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ mode: "cloud", profile: "cloud" }),
      });
    }
    if (u.indexOf("/api/cloud/auth/me") !== -1) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(authMeBody) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });

  return { window_ };
}

function uninstallBootFakeBrowser() {
  delete global.document;
  delete global.window;
  delete global.location;
  delete global.performance;
  delete global.MutationObserver;
  delete global.fetch;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  uninstallBootFakeBrowser();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("core/boot.js gate fails CLOSED when workspace_access is missing", () => {
  it("shows the subscription gate, not the desktop, when auth/me omits workspace_access", async () => {
    const { window_ } = installBootFakeBrowser({
      authMeBody: { username: "no-field-user", email: "no-field@example.test" },
    });
    window_.showDesktop = vi.fn();
    window_.FULCSubscriptionGate = { render: vi.fn() };

    await import("../shell/core/boot.js");
    // Flushes the boot animation's sequential setTimeout delays (8 lines
    // at 300-500ms each, plus a trailing 1000ms) without waiting on wall
    // clock time.
    await vi.advanceTimersByTimeAsync(8000);

    expect(window_.FULCSubscriptionGate.render).toHaveBeenCalledTimes(1);
    expect(window_.showDesktop).not.toHaveBeenCalled();
  });

  it("control: still shows the desktop when workspace_access is 'open'", async () => {
    const { window_ } = installBootFakeBrowser({
      authMeBody: { username: "open-user", workspace_access: "open" },
    });
    window_.showDesktop = vi.fn();
    window_.FULCSubscriptionGate = { render: vi.fn() };

    await import("../shell/core/boot.js");
    await vi.advanceTimersByTimeAsync(8000);

    expect(window_.showDesktop).toHaveBeenCalledTimes(1);
    expect(window_.FULCSubscriptionGate.render).not.toHaveBeenCalled();
  });
});
