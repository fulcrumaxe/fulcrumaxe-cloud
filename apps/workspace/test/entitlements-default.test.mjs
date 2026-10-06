// apps/workspace/test/entitlements-default.test.mjs
//
// D#37 WS-C2 bugfix, found while verifying criterion 15 against a real
// apps/web server: the real GET /api/entitlements/me (WS-C1 criterion 4,
// apps/web/lib/shell/session-routes.ts) answers
// `{"entitlements":{},"default":"allow"}`. core/entitlements.js used to
// read only `data.decisions` (always undefined against that shape) and
// fell back to a hardcoded Deny for every capability not explicitly
// listed -- which locked every app, including Themes, behind the
// upgrade modal on every real sign-in. This pins the fix: `decision()`
// and `can()` honour the real route's `default` field for any
// capability neither `entitlements` nor `decisions` lists.

import { afterEach, describe, expect, it, vi } from "vitest";

function fakeElement() {
  const el = {
    children: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return el;
}

function installFakeBrowser(entitlementsResponse) {
  const elementsById = new Map();
  const document_ = {
    readyState: "complete",
    body: fakeElement(),
    getElementById(id) {
      if (!elementsById.has(id)) elementsById.set(id, fakeElement());
      return elementsById.get(id);
    },
    createElement: () => fakeElement(),
    addEventListener() {},
    removeEventListener() {},
  };
  const window_ = { addEventListener() {}, removeEventListener() {} };

  global.document = document_;
  global.window = window_;
  global.location = { protocol: "https:", host: "example.test", hostname: "example.test" };
  global.WebSocket = vi.fn(function FakeWebSocket() {
    this.readyState = 0;
  });
  global.fetch = vi.fn((url) => {
    const u = String(url);
    if (u.indexOf("/api/entitlements/me") !== -1) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(entitlementsResponse) });
    }
    if (u.indexOf("/api/mode") !== -1) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ mode: "cloud", features: { liveEntitlements: false } }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });

  return { window_ };
}

function uninstallFakeBrowser() {
  delete global.document;
  delete global.window;
  delete global.location;
  delete global.WebSocket;
  delete global.fetch;
}

afterEach(() => {
  uninstallFakeBrowser();
  vi.resetModules();
});

describe("core/entitlements.js: default field from the real /api/entitlements/me shape", () => {
  it('{"entitlements":{},"default":"allow"} -> can() is true for an unlisted capability', async () => {
    const { window_ } = installFakeBrowser({ entitlements: {}, default: "allow" });
    await import("../shell/core/entitlements.js");
    await window_.FULCEntitlements.init();
    expect(window_.FULCEntitlements.can("app.themes")).toBe(true);
    expect(window_.FULCEntitlements.decision("app.themes")).toEqual({ type: "Allow", reason: "default" });
  });

  it('{"entitlements":{},"default":"deny"} -> can() is false for an unlisted capability', async () => {
    const { window_ } = installFakeBrowser({ entitlements: {}, default: "deny" });
    await import("../shell/core/entitlements.js");
    await window_.FULCEntitlements.init();
    expect(window_.FULCEntitlements.can("app.themes")).toBe(false);
  });

  it("an explicit per-app entitlement still wins over the default", async () => {
    const { window_ } = installFakeBrowser({
      entitlements: { "app.themes": { type: "Deny", reason: "plan" } },
      default: "allow",
    });
    await import("../shell/core/entitlements.js");
    await window_.FULCEntitlements.init();
    expect(window_.FULCEntitlements.can("app.themes")).toBe(false);
    expect(window_.FULCEntitlements.decision("app.themes")).toEqual({ type: "Deny", reason: "plan" });
  });

  it("no default field at all (fetch never succeeded) keeps the old safe-default: Deny", async () => {
    const { window_ } = installFakeBrowser(undefined);
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    await import("../shell/core/entitlements.js");
    await window_.FULCEntitlements.init();
    expect(window_.FULCEntitlements.can("app.themes")).toBe(false);
    expect(window_.FULCEntitlements.decision("app.themes")).toEqual({ type: "Deny", reason: "unknown" });
  });

  it("still accepts the older {decisions:{...}} shape (backward compatible)", async () => {
    const { window_ } = installFakeBrowser({ decisions: { "app.themes": { type: "Allow" } } });
    await import("../shell/core/entitlements.js");
    await window_.FULCEntitlements.init();
    expect(window_.FULCEntitlements.can("app.themes")).toBe(true);
  });
});
