import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { RateLimitedError } from "@fx/api/src/errors.js";
import { middleware } from "../../../../../middleware";
import { digestHandler, parseWindowHours, type DigestDeps, type DigestRead } from "./handler";
import { GET } from "./route";

/**
 * D#454 H1f at the HTTP layer. The digest rules are @fx/telemetry's suite and the two SQL calls are @fx/db's real-Postgres suite;
 * this covers the door: fail closed with no token, the token compared and nothing else accepted, the failed-auth limit for
 * strangers and the digest's own hourly budget for the operator, and that no database is reached before the header matches.
 */
const TOKEN = "digest-token-that-is-long-enough-0123456789";
// Built at runtime so no secret-shaped literal sits in the source.
const CRON = "cron-secret-" + "x".repeat(33);
const URL_ = "https://example.test/api/internal/errors/digest";
const NOW = Date.UTC(2026, 9, 8, 10, 30);

afterEach(() => vi.unstubAllEnvs());

const req = (auth: string | null, query = "", headers: Record<string, string> = {}) =>
  new Request(`${URL_}${query}`, { method: "GET", headers: { ...(auth ? { authorization: auth } : {}), ...headers } });

const emptyRead: DigestRead = { now: NOW, rows: [], laps: [] };

function deps(over: Partial<DigestDeps> = {}) {
  const calls = { failedAuth: [] as string[], takeSlot: 0, read: [] as number[] };
  const d: DigestDeps = {
    token: TOKEN,
    failedAuth: async (ip) => void calls.failedAuth.push(ip),
    takeSlot: async () => (calls.takeSlot++, { allowed: true, retryAfterSeconds: 1 }),
    read: async (w) => (calls.read.push(w), emptyRead),
    ...over,
  };
  return { d, calls };
}

describe("the digest door", () => {
  it("answers 503 digest_disabled and touches nothing when the token is unset or shorter than 32 characters, whatever the header", async () => {
    for (const token of [undefined, "", "too-short-0123456789"]) {
      const { d, calls } = deps({ token });
      for (const auth of [null, "Bearer ", `Bearer ${TOKEN}`, `Bearer ${token ?? ""}`]) {
        const res = await digestHandler(req(auth), d);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "digest_disabled" });
      }
      expect(calls).toEqual({ failedAuth: [], takeSlot: 0, read: [] });
    }
  });

  it("answers 401 for a missing or wrong header, the cron secret, or the token without Bearer, and reads nothing", async () => {
    const { d, calls } = deps();
    for (const auth of [null, "Bearer wrong", `Bearer ${CRON}`, TOKEN, `bearer ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer  ${TOKEN}`]) {
      const res = await digestHandler(req(auth, "", { "x-forwarded-for": "203.0.113.7" }), d);
      expect(res.status, String(auth)).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    }
    expect(calls.failedAuth).toHaveLength(7);
    expect(new Set(calls.failedAuth)).toEqual(new Set(["203.0.113.7"]));
    expect(calls.takeSlot).toBe(0);
    expect(calls.read).toEqual([]);
  });

  it("charges a stranger to the failed-auth limit only, and answers 429 with Retry-After once over it", async () => {
    const { d, calls } = deps({
      failedAuth: async () => {
        throw new RateLimitedError(41);
      },
    });
    const res = await digestHandler(req("Bearer wrong"), d);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("41");
    expect(calls.takeSlot).toBe(0); // the operator's budget is not touched
  });

  it("fails closed when the failed-auth limiter itself breaks: the error propagates, no 401 is invented", async () => {
    const { d } = deps({
      failedAuth: async () => {
        throw new Error("store down");
      },
    });
    await expect(digestHandler(req("Bearer wrong"), d)).rejects.toThrow("store down");
  });

  it("serves the digest for the right header: never charged to the failed-auth limit, charged once to the hourly budget", async () => {
    const { d, calls } = deps({
      read: async (w) => ({
        now: (calls.read.push(w), NOW),
        rows: [{ service: "web", route: "/api/x", stage: "sync", code: "mint_failed", count: 3, bucket: new Date(Date.UTC(2026, 9, 8, 10)), firstSeenAt: new Date(NOW - 60_000), lastSeenAt: new Date(NOW) }],
        laps: [{ name: "github_repos", intervalSeconds: 21_600, lapSeconds: 90_000, neverCompleted: false, breach: true }],
      }),
    });
    const res = await digestHandler(req(`Bearer ${TOKEN}`), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { classes: Record<string, unknown>[]; newClasses: unknown[]; alerts: { kind: string }[] };
    expect(body).toMatchObject({ windowHours: 24, totalCount: 3, classTotal: 1 });
    expect(body.classes[0]).toMatchObject({ service: "web", route: "/api/x", stage: "sync", code: "mint_failed", count: 3 });
    expect(body.newClasses).toHaveLength(1);
    expect(body.alerts.map((a) => a.kind).sort()).toEqual(["lap_breach", "new_class"]);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(calls).toEqual({ failedAuth: [], takeSlot: 1, read: [24] });
  });

  it("answers 429 with Retry-After when the hourly budget is spent, and reads nothing", async () => {
    const { d, calls } = deps({ takeSlot: async () => ({ allowed: false, retryAfterSeconds: 1234 }) });
    const res = await digestHandler(req(`Bearer ${TOKEN}`), d);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1234");
    expect(calls.read).toEqual([]);
  });

  it("reads the window from window_hours, and refuses anything but 1 to 48 plain digits (after charging the call)", async () => {
    const { d, calls } = deps();
    expect((await digestHandler(req(`Bearer ${TOKEN}`, "?window_hours=6"), d)).status).toBe(200);
    expect(calls.read).toEqual([6]);
    for (const bad of ["0", "49", "100", "abc", "1.5", "-1", "6h", "%205", ""]) {
      const res = await digestHandler(req(`Bearer ${TOKEN}`, `?window_hours=${bad}`), d);
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_window" });
    }
    expect(calls.read).toEqual([6]);
    expect(calls.takeSlot).toBe(1 + 9);
  });

  it("parseWindowHours: default when absent, the number when 1 to 48", () => {
    expect(parseWindowHours(null)).toBe(24);
    expect(parseWindowHours("1")).toBe(1);
    expect(parseWindowHours("48")).toBe(48);
    expect(parseWindowHours("49")).toBeNull();
    expect(parseWindowHours("0")).toBeNull();
  });

  it("a failed read answers 500 with no detail, never partial data and never the error text", async () => {
    const { d } = deps({
      read: async () => {
        throw new Error("password authentication failed for user platform_ops at db.internal.example");
      },
    });
    const res = await digestHandler(req(`Bearer ${TOKEN}`), d);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "internal_error" }));
  });

  it("a failed budget write answers 500 and serves nothing", async () => {
    const { d, calls } = deps({
      takeSlot: async () => {
        throw new Error("rate_limit_windows unavailable");
      },
    });
    expect((await digestHandler(req(`Bearer ${TOKEN}`), d)).status).toBe(500);
    expect(calls.read).toEqual([]);
  });
});

describe("/api/internal/errors/digest as deployed", () => {
  it("answers 503 and reaches no database when FX_OPS_DIGEST_TOKEN is unset", async () => {
    vi.stubEnv("FX_OPS_DIGEST_TOKEN", "");
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", ""); // a pool built here would throw "must be set"
    vi.stubEnv("DATABASE_URL_APP_USER", "");
    for (const auth of [null, `Bearer ${TOKEN}`]) expect((await GET(req(auth))).status).toBe(503);
  });

  it("does not accept CRON_SECRET in place of the token", async () => {
    vi.stubEnv("FX_OPS_DIGEST_TOKEN", TOKEN);
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("DATABASE_URL_APP_USER", ""); // the failed-auth limiter needs it: reaching it proves this was judged a stranger
    await expect(GET(req(`Bearer ${CRON}`))).rejects.toThrow("DATABASE_URL_APP_USER must be set");
  });

  it("a right header reaches the budget (and so the platform_ops pool) and nothing before it", async () => {
    vi.stubEnv("FX_OPS_DIGEST_TOKEN", TOKEN);
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "");
    vi.stubEnv("DATABASE_URL_APP_USER", "");
    const res = await GET(req(`Bearer ${TOKEN}`));
    expect(res.status).toBe(500); // the missing database setting, reported and not shown
    expect(await res.json()).toEqual({ error: "internal_error" });
  });

  it("the middleware lets a bearer GET with no cookie through untouched", async () => {
    const res = await middleware(new NextRequest(URL_, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});
