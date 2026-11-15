// apps/workspace/test/client-errors.test.mjs
//
// The shell's browser-error reporter: one bounded class report per throttle window, nothing of the error in it.

import { describe, expect, it } from "vitest";
import { MAX_PER_MINUTE, MINUTE_MS, installClientErrors, windowIdFor } from "../shell/core/boot-metrics.js";

function rig() {
  const handlers = new Map();
  const win = {
    addEventListener: (t, f) => handlers.set(t, f),
    removeEventListener: (t) => handlers.delete(t),
  };
  const calls = [];
  const clock = { t: 1_000_000 };
  const fetch = (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: true });
  };
  const remove = installClientErrors(win, { fetch, now: () => clock.t });
  return { handlers, calls, clock, remove, fire: (t, ev) => handlers.get(t)(ev) };
}

describe("client error reporter", () => {
  it("sends exactly one report for a repeated error, and only the class and window", () => {
    const r = rig();
    const ev = { filename: "https://app.example/apps/runs/runs-app.js", message: "token ghp_SECRET at /home/u", error: new Error("ghp_SECRET") };
    for (let i = 0; i < 50; i++) r.fire("error", ev);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toBe("/api/rum");
    expect(r.calls[0].init.method).toBe("POST");
    expect(r.calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(r.calls[0].body).toEqual({ kind: "client_error", code: "client.script_error", window: "runs" });
    expect(r.calls[0].init.body).not.toContain("SECRET");
  });

  it("reports an unhandled rejection under its own code, never sending the reason", () => {
    const r = rig();
    r.fire("unhandledrejection", { reason: new Error("secret cookie=abc") });
    expect(r.calls.map((c) => c.body)).toEqual([{ kind: "client_error", code: "client.unhandled_rejection", window: "shell" }]);
    expect(r.calls[0].init.body).not.toContain("cookie");
  });

  it("names the app from a rejection's stack", () => {
    const r = rig();
    const err = new Error("x");
    err.stack = "Error: x\n    at f (https://app.example/apps/kanban/board.js:1:2)";
    r.fire("unhandledrejection", { reason: err });
    expect(r.calls[0].body.window).toBe("kanban");
  });

  it("sends again for the same class after a minute, and caps all classes at the per-minute limit", () => {
    const r = rig();
    r.fire("error", { filename: "/apps/runs/a.js" });
    r.clock.t += MINUTE_MS;
    r.fire("error", { filename: "/apps/runs/a.js" });
    expect(r.calls).toHaveLength(2);
    r.clock.t += MINUTE_MS;
    const ids = ["runs", "kanban", "agents", "roles", "repos", "themes", "vercel", "memory"];
    for (const id of ids) r.fire("error", { filename: `/apps/${id}/a.js` });
    expect(r.calls).toHaveLength(2 + MAX_PER_MINUTE);
  });

  it("falls back to shell for a file outside an app, a hostile name or no name", () => {
    for (const f of [undefined, "", "not a url", "https://x/core/boot.js", "https://x/apps/../etc/a.js", "https://x/apps/<script>/a.js", "javascript:alert(1)"]) {
      expect(windowIdFor(f), String(f)).toBe("shell");
    }
  });

  it("never throws into the page when fetch or the event is broken", () => {
    const handlers = new Map();
    installClientErrors({ addEventListener: (t, f) => handlers.set(t, f), removeEventListener() {} }, { fetch: () => { throw new Error("boom"); }, now: () => 0 });
    expect(() => handlers.get("error")(null)).not.toThrow();
    expect(() => handlers.get("unhandledrejection")({ get reason() { throw new Error("x"); } })).not.toThrow();
  });

  it("stops listening when removed", () => {
    const r = rig();
    r.remove();
    expect(r.handlers.size).toBe(0);
  });
});
