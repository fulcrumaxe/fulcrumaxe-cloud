import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { RateLimitStore } from "@fx/api/src/ratelimit/store.js";
import { RateLimitedError } from "@fx/api/src/errors.js";
import { SESSION_LIMITS } from "@fx/api/src/ratelimit/session.js";
import { CLIENT_ERROR_CODES, CLIENT_WINDOW_IDS } from "@fx/telemetry";
import { captureReports } from "../../../test/captureReports";
import { handleRumPost, type RumDeps } from "./handler";

function req(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): NextRequest {
  return new NextRequest("https://example.test/api/rum", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * Always-allow fake store. Every test in the first describe below is
 * about body/schema handling, not rate limiting (that gets its own
 * describe further down, with a store built to order per test) -- none
 * of them may touch a real Postgres connection.
 */
function allowAllDeps(): RumDeps {
  return {
    rateLimitStore: { checkAndIncrement: async () => ({ allowed: true, retryAfterSeconds: 60 }) },
    clientIp: () => "203.0.113.1",
  };
}

describe("POST /api/rum (D#37 WS-D criterion 5)", () => {
  it("accepts a valid boot:signin-visible mark and returns 204 with no body", async () => {
    const res = await handleRumPost(
      req({ marks: [{ name: "boot:signin-visible", startTime: 812.4 }], viewport: "desktop", connection: "4g" }),
      allowAllDeps(),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("logs one structured line carrying only the mark, viewport class and connection type", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleRumPost(
      req({ marks: [{ name: "boot:desktop-ready", startTime: 1901.2 }], viewport: "phone", connection: "4g" }),
      allowAllDeps(),
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(logged).toEqual({
      event: "boot_rum",
      marks: [{ name: "boot:desktop-ready", startTime: 1901.2 }],
      viewport: "phone",
      connection: "4g",
    });
    logSpy.mockRestore();
  });

  it("drops a mark name that isn't one of the two boot marks (no PII / no arbitrary marks)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleRumPost(req({ marks: [{ name: "totally-unrelated-mark", startTime: 1 }], viewport: "desktop" }), allowAllDeps());
    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(logged.marks).toEqual([]);
    logSpy.mockRestore();
  });

  it("defaults viewport to desktop and connection to unknown when absent or malformed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleRumPost(req({ marks: [] }), allowAllDeps());
    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(logged.viewport).toBe("desktop");
    expect(logged.connection).toBe("unknown");
    logSpy.mockRestore();
  });

  it("a malformed body never throws -- still answers 204", async () => {
    const res = await handleRumPost(req("{not json"), allowAllDeps());
    expect(res.status).toBe(204);
  });

  it("rejects a body over 4 KB via Content-Length with 413", async () => {
    const res = await handleRumPost(
      req("x", { "content-type": "application/json", "content-length": String(5 * 1024) }),
      allowAllDeps(),
    );
    expect(res.status).toBe(413);
  });

  it("rejects an oversized body with no Content-Length header at all (streamed byte-limit)", async () => {
    const oversized = "x".repeat(8 * 1024);
    const request = req(oversized);
    expect(request.headers.get("content-length")).toBeNull();
    const res = await handleRumPost(request, allowAllDeps());
    expect(res.status).toBe(413);
  });

  it("rejects a non-JSON content type with 415", async () => {
    const res = await handleRumPost(req("marks=1", { "content-type": "text/plain" }), allowAllDeps());
    expect(res.status).toBe(415);
  });

  it("carries the criterion-13 security headers", async () => {
    const res = await handleRumPost(req({ marks: [] }), allowAllDeps());
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("POST /api/rum rate limiting (D#37 WS-D fix round 1, MUST 1)", () => {
  it("returns 429 with an integer Retry-After when the store reports the caller is over its cap, and writes nothing (no console.log)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const store: RateLimitStore = {
      checkAndIncrement: async () => ({ allowed: false, retryAfterSeconds: 42 }),
    };
    const res = await handleRumPost(req({ marks: [{ name: "boot:signin-visible", startTime: 1 }] }), {
      rateLimitStore: store,
      clientIp: () => "203.0.113.9",
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("carries the criterion-13 security headers on a 429 too", async () => {
    const store: RateLimitStore = { checkAndIncrement: async () => ({ allowed: false, retryAfterSeconds: 1 }) };
    const res = await handleRumPost(req({ marks: [] }), { rateLimitStore: store, clientIp: () => "203.0.113.9" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keys the store call on \"anon:rum:<ip>\" using the client IP the injected resolver returns, and still answers 204 when allowed", async () => {
    let calledWithKey: string | undefined;
    let calledWithLimit: number | undefined;
    const store: RateLimitStore = {
      checkAndIncrement: async (bucketKey, limit) => {
        calledWithKey = bucketKey;
        calledWithLimit = limit;
        return { allowed: true, retryAfterSeconds: 60 };
      },
    };
    const res = await handleRumPost(req({ marks: [] }), { rateLimitStore: store, clientIp: () => "203.0.113.9" });
    expect(res.status).toBe(204);
    expect(calledWithKey).toBe("anon:rum:203.0.113.9");
    expect(calledWithLimit).toBe(60);
  });

  it("a burst above the bound gets 429s -- requests within the bound still succeed", async () => {
    const LIMIT = 3;
    let count = 0;
    const store: RateLimitStore = {
      checkAndIncrement: async () => {
        count += 1;
        return { allowed: count <= LIMIT, retryAfterSeconds: 5 };
      },
    };
    const deps: RumDeps = { rateLimitStore: store, clientIp: () => "203.0.113.9" };
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 2; i++) {
      const res = await handleRumPost(req({ marks: [] }), deps);
      statuses.push(res.status);
    }
    expect(statuses).toEqual([204, 204, 204, 429, 429]);
  });

  it("the beacon's real traffic (one POST per page load) is far below the bound: 5 requests from one IP all succeed against the real 60/minute limit", async () => {
    // Same allow-everything-under-60 shape the real `rate_limit_check`
    // enforces for the "anon:rum:<ip>" bucket -- the live-Postgres proof
    // that the 60/minute cap itself works, including the IPv6 /64
    // grouping, lives in packages/api/test/ratelimit.test.ts (this file
    // has no DB access). This confirms only the route's own wiring: it
    // never trips its own cap under a load far below what a real page
    // load generates (exactly one POST per load).
    let count = 0;
    const store: RateLimitStore = {
      checkAndIncrement: async (_key, limit) => {
        count += 1;
        return { allowed: count <= limit, retryAfterSeconds: 60 };
      },
    };
    const deps: RumDeps = { rateLimitStore: store, clientIp: () => "203.0.113.9" };
    for (let i = 0; i < 5; i++) {
      const res = await handleRumPost(req({ marks: [{ name: "boot:signin-visible", startTime: 1 }] }), deps);
      expect(res.status, `request ${i + 1}`).toBe(204);
    }
  });
});

describe("POST /api/rum: the client-error kind (H1c)", () => {
  const SUBJECT = { accountId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
  const SECRET = "alice-h1c-canary@example.com";

  function deps(over: Partial<RumDeps> = {}): RumDeps {
    return { ...allowAllDeps(), resolveSession: async () => SUBJECT, limitSession: async () => undefined, ...over };
  }
  const report = (code: unknown, window: unknown, extra: Record<string, unknown> = {}) => req({ kind: "client_error", code, window, ...extra });

  it("a signed-in report picks a listed code and window and is stored as that class, with route /api/rum", async () => {
    const reports = captureReports();
    const res = await handleRumPost(report("client.render_failed", "model-key"), deps());
    expect(res.status).toBe(204);
    expect(reports.classes).toEqual([{ service: "test", route: "/api/rum", stage: "client.model_key", code: "client.render_failed" }]);
  });

  it("every listed code and window is accepted, and every one stores a valid label", async () => {
    const reports = captureReports();
    for (const window of CLIENT_WINDOW_IDS) {
      for (const code of CLIENT_ERROR_CODES) expect((await handleRumPost(report(code, window), deps())).status, `${code} ${window}`).toBe(204);
    }
    expect(reports.classes).toHaveLength(CLIENT_WINDOW_IDS.length * CLIENT_ERROR_CODES.length);
    for (const c of reports.classes) expect(c.stage).toMatch(/^client\.[a-z_]+$/);
  });

  it("refuses a code or window that is not on the lists with 400 and stores nothing", async () => {
    const reports = captureReports();
    for (const [code, window] of [
      ["client.made_up", "model-key"],
      ["render_failed", "model-key"],
      ["client.render_failed", "not-a-window"],
      ["client.render_failed", "model_key"],
      [SECRET, "runs"],
      ["client.render_failed", SECRET],
      [undefined, undefined],
      [5, {}],
    ] as const) {
      const res = await handleRumPost(report(code, window), deps());
      expect(res.status, `${String(code)} ${String(window)}`).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_client_error" });
    }
    expect(reports.classes).toEqual([]);
    expect(reports.everything()).not.toContain(SECRET);
  });

  it("counts a signed-in report against the account budget before it checks the fields", async () => {
    captureReports();
    const limitSession = vi.fn(async () => undefined);
    await handleRumPost(report("client.nope", "nope"), deps({ limitSession }));
    expect(limitSession).toHaveBeenCalledWith(SUBJECT);
  });

  it("answers 429 with Retry-After over the account budget and stores nothing", async () => {
    const reports = captureReports();
    const limitSession = async () => {
      throw new RateLimitedError(7);
    };
    const res = await handleRumPost(report("client.render_failed", "runs"), deps({ limitSession }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(reports.classes).toEqual([]);
  });

  it("a limiter that cannot run fails the request instead of serving the caller unlimited", async () => {
    captureReports();
    const limitSession = async () => {
      throw new Error("store down");
    };
    await expect(handleRumPost(report("client.render_failed", "runs"), deps({ limitSession }))).rejects.toThrow("store down");
  });

  it("the account budget is 30 a minute, through the same limiter the other session routes use", () => {
    expect(SESSION_LIMITS.rumClientError.account).toEqual([{ limit: 30, seconds: 60 }]);
  });

  it("an anonymous caller chooses nothing: one class, route /, whatever the body says, and no budget is spent", async () => {
    const reports = captureReports();
    const limitSession = vi.fn(async () => undefined);
    const bodies = [
      { code: "client.render_failed", window: "runs" },
      { code: SECRET, window: SECRET, route: `/api/${SECRET}`, message: SECRET, stack: SECRET },
      {},
    ];
    for (const extra of bodies) {
      const res = await handleRumPost(req({ kind: "client_error", ...extra }), deps({ resolveSession: async () => null, limitSession }));
      expect(res.status).toBe(204);
    }
    expect(reports.classes).toEqual([
      { service: "test", route: "/", stage: "client", code: "client.anonymous" },
      { service: "test", route: "/", stage: "client", code: "client.anonymous" },
      { service: "test", route: "/", stage: "client", code: "client.anonymous" },
    ]);
    expect(reports.everything()).not.toContain(SECRET);
    expect(limitSession).not.toHaveBeenCalled();
  });

  it("a request with no session cookie is anonymous without any database or setting", async () => {
    const reports = captureReports();
    const res = await handleRumPost(report("client.render_failed", "runs"), { ...allowAllDeps() });
    expect(res.status).toBe(204);
    expect(reports.classes).toEqual([{ service: "test", route: "/", stage: "client", code: "client.anonymous" }]);
  });

  it("a session check that fails leaves the caller anonymous and counts the failure by stage", async () => {
    const reports = captureReports();
    const resolveSession = async () => {
      throw Object.assign(new Error(`db said ${SECRET}`), { code: "ECONNRESET" });
    };
    const res = await handleRumPost(report("client.render_failed", "runs"), deps({ resolveSession }));
    expect(res.status).toBe(204);
    expect(reports.classes).toEqual([
      { service: "test", route: "/api/rum", stage: "rum.session", code: "ECONNRESET" },
      { service: "test", route: "/", stage: "client", code: "client.anonymous" },
    ]);
    expect(reports.everything()).not.toContain(SECRET);
  });

  it("the boot-timing kind still logs its own line and stores no class", async () => {
    const reports = captureReports();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleRumPost(req({ marks: [{ name: "boot:desktop-ready", startTime: 5 }] }), deps());
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(reports.classes).toEqual([]);
    logSpy.mockRestore();
  });
});
