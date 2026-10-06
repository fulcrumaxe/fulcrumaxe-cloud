import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { RECONCILE_JOBS, type TickDeps, type TickSummary } from "@fx/reconcile";
import { reportError } from "@fx/telemetry";
import { defaultReconcileDeps, reconcileHandler, type ReconcileHandlerDeps } from "./handler";
import { maxDuration } from "./route";

/**
 * Route-layer test only, like the other cron handlers: no real Postgres, a fake tick in its place. The lease, budget,
 * cursor and lap-time behaviour is packages/reconcile's own real-Postgres suite.
 */
const SECRET = "test-cron-secret-that-is-long-enough-0123";

function fakeDeps(overrides: Partial<ReconcileHandlerDeps> = {}): ReconcileHandlerDeps {
  return { cronSecret: SECRET, enabled: true, platformOpsPool: {} as never, reportError: () => undefined, ...overrides };
}

function requestWithAuth(authorization: string | null): NextRequest {
  const headers = new Headers();
  if (authorization !== null) headers.set("authorization", authorization);
  return new NextRequest("https://example.test/api/cron/reconcile", { method: "GET", headers });
}

const summary: TickSummary = { enabled: true, results: [{ job: "error_events_prune", result: "ok" }] };

describe("GET /api/cron/reconcile: who may call it", () => {
  it.each([
    ["no Authorization header", null],
    ["a wrong secret", "Bearer wrong-secret"],
    ["a customer API token", "Bearer fxat_notarealcronsecretatall000000000000000"],
  ])("answers 401 and runs nothing with %s", async (_label, header) => {
    const runTickFn = vi.fn();
    const res = await reconcileHandler(requestWithAuth(header), fakeDeps(), runTickFn);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(runTickFn).not.toHaveBeenCalled();
  });

  it("answers 401 when CRON_SECRET is not configured, even for a header that looks like a match", async () => {
    const runTickFn = vi.fn();
    const res = await reconcileHandler(requestWithAuth("Bearer "), fakeDeps({ cronSecret: "" }), runTickFn);
    expect(res.status).toBe(401);
    expect(runTickFn).not.toHaveBeenCalled();
  });

  it("answers 401 without opening a database pool when no deps are injected and no secret is set", async () => {
    const before = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const res = await reconcileHandler(requestWithAuth(`Bearer ${SECRET}`));
      expect(res.status).toBe(401);
    } finally {
      if (before !== undefined) process.env.CRON_SECRET = before;
    }
  });
});

describe("GET /api/cron/reconcile: the tick", () => {
  it("runs every registered job once with the secret and returns the tick summary", async () => {
    const runTickFn = vi.fn(async () => summary);
    const deps = fakeDeps();
    const res = await reconcileHandler(requestWithAuth(`Bearer ${SECRET}`), deps, runTickFn);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
    expect(runTickFn).toHaveBeenCalledWith({ pool: deps.platformOpsPool, jobs: RECONCILE_JOBS, enabled: true, reportError: deps.reportError });
  });

  it("passes the kill switch through: a switched-off run is still answered 200 with the disabled summary", async () => {
    const off: TickSummary = { enabled: false, results: [{ job: "error_events_prune", result: "disabled" }] };
    const runTickFn = vi.fn(async (_deps: TickDeps) => off);
    const res = await reconcileHandler(requestWithAuth(`Bearer ${SECRET}`), fakeDeps({ enabled: false }), runTickFn);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(off);
    expect(runTickFn.mock.calls[0]![0]).toMatchObject({ enabled: false });
  });
});

describe("the real dependencies", () => {
  it("report failures through the shared reportError, and the kill switch reads FX_RECONCILE_ENABLED", () => {
    const saved = { url: process.env.DATABASE_URL_PLATFORM_OPS, on: process.env.FX_RECONCILE_ENABLED };
    process.env.DATABASE_URL_PLATFORM_OPS = "postgres://platform_ops@127.0.0.1:1/none";
    try {
      process.env.FX_RECONCILE_ENABLED = "0";
      expect(defaultReconcileDeps().enabled).toBe(false);
      delete process.env.FX_RECONCILE_ENABLED;
      const deps = defaultReconcileDeps();
      expect(deps.enabled).toBe(true);
      expect(deps.reportError).toBe(reportError);
    } finally {
      if (saved.url === undefined) delete process.env.DATABASE_URL_PLATFORM_OPS; else process.env.DATABASE_URL_PLATFORM_OPS = saved.url;
      if (saved.on === undefined) delete process.env.FX_RECONCILE_ENABLED; else process.env.FX_RECONCILE_ENABLED = saved.on;
    }
  });
});

describe("the schedule", () => {
  it("vercel.json has the reconcile cron at 7 */6 * * * next to the three sweeps at their gated cadence (see vercel-crons.test.ts)", () => {
    const config = JSON.parse(readFileSync(path.join(__dirname, "../../../../vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(config.crons).toEqual([
      { path: "/api/cron/api-sweep", schedule: "*/5 * * * *" },
      { path: "/api/cron/run-action-sweep", schedule: "*/5 * * * *" },
      { path: "/api/cron/compute-settle-sweep", schedule: "*/10 * * * *" },
      { path: "/api/cron/reconcile", schedule: "7 */6 * * *" },
    ]);
  });

  it("the route allows 300 s, above the tick's 240 s budget", () => {
    expect(maxDuration).toBe(300);
  });
});
