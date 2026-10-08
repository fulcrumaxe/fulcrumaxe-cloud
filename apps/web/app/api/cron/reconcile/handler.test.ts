import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { RECONCILE_JOBS, type JobContext, type TickDeps, type TickSummary } from "@fx/reconcile";
import { reportError } from "@fx/telemetry";
import { defaultReconcileDeps, modelKeyHealthJobFromEnv, reconcileHandler, stripeSubscriptionsJobFromEnv, type ReconcileHandlerDeps } from "./handler";
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
    const runTickFn = vi.fn(async (_deps: TickDeps) => summary);
    const deps = fakeDeps();
    const res = await reconcileHandler(requestWithAuth(`Bearer ${SECRET}`), deps, runTickFn);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
    const tick = runTickFn.mock.calls[0]![0];
    expect(tick).toMatchObject({ pool: deps.platformOpsPool, enabled: true, reportError: deps.reportError });
    // The fixed jobs first, then the GitHub, Stripe and model-key jobs, which the route builds from its environment.
    expect(tick.jobs.map((job) => job.name)).toEqual([
      ...RECONCILE_JOBS.map((job) => job.name),
      "github_installations",
      "stripe_subscriptions",
      "model_key_health",
    ]);
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

describe("the Stripe job's key", () => {
  const withKey = async (key: string | undefined, secret: string | undefined, fn: () => Promise<void>) => {
    const saved = { key: process.env.STRIPE_RECONCILE_KEY, secret: process.env.STRIPE_SECRET_KEY };
    const set = (name: string, value: string | undefined) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
    set("STRIPE_RECONCILE_KEY", key);
    set("STRIPE_SECRET_KEY", secret);
    try {
      await fn();
    } finally {
      set("STRIPE_RECONCILE_KEY", saved.key);
      set("STRIPE_SECRET_KEY", saved.secret);
    }
  };
  const ctx = (query: ReturnType<typeof vi.fn>): JobContext =>
    ({ pool: { query } as never, cursor: null, signal: new AbortController().signal, calls: { limit: 50, used: 0, take: () => true }, msLeft: () => 60_000, checkpoint: () => undefined });

  it.each([
    ["no STRIPE_RECONCILE_KEY", undefined, "sk_test_secret_is_never_a_fallback"],
    ["a secret key in STRIPE_RECONCILE_KEY", "sk_test_not_restricted", "sk_test_secret_is_never_a_fallback"],
  ])("records not_configured and touches neither the database nor Stripe with %s", async (_label, key, secret) => {
    await withKey(key, secret, async () => {
      const query = vi.fn();
      const job = stripeSubscriptionsJobFromEnv({ query } as never, () => undefined);
      expect(job.name).toBe("stripe_subscriptions");
      expect(await job.run(ctx(query))).toEqual({ cursor: null, wrapped: false, code: "not_configured" });
      expect(query).not.toHaveBeenCalled();
    });
  });

  it("with a restricted key the job reads accounts (and would call Stripe)", async () => {
    await withKey("rk_test_restricted_read_only", "sk_test_unused", async () => {
      const query = vi.fn(async () => ({ rows: [] }));
      const job = stripeSubscriptionsJobFromEnv({ query } as never, () => undefined);
      expect(await job.run(ctx(query))).toEqual({ cursor: null, wrapped: true });
      expect(query).toHaveBeenCalledTimes(1);
    });
  });
});

describe("the model-key health job's environment", () => {
  const ctx = (query: ReturnType<typeof vi.fn>): JobContext =>
    ({ pool: { query } as never, cursor: null, signal: new AbortController().signal, calls: { limit: 50, used: 0, take: () => true }, msLeft: () => 60_000, checkpoint: () => undefined });
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
    const set = (name: string, value: string | undefined) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
    for (const [name, value] of Object.entries(env)) set(name, value);
    try {
      await fn();
    } finally {
      for (const [name, value] of Object.entries(saved)) set(name, value);
    }
  };

  it.each([
    ["no app database URL", { DATABASE_URL_APP_USER: undefined, FX_KEK_CURRENT_VERSION: undefined, FX_KEK_V1: "A".repeat(43) + "=" }],
    ["no key-encryption key", { DATABASE_URL_APP_USER: "postgres://app_user@127.0.0.1:1/none", FX_KEK_CURRENT_VERSION: undefined, FX_KEK_V1: undefined }],
    ["a current version below 1 (envKekSource throws on it)", { DATABASE_URL_APP_USER: "postgres://app_user@127.0.0.1:1/none", FX_KEK_CURRENT_VERSION: "0", FX_KEK_V0: "A".repeat(43) + "=", FX_KEK_V1: "A".repeat(43) + "=" }],
  ])("records not_configured and reads nothing with %s", async (_label, env) => {
    await withEnv(env, async () => {
      const query = vi.fn();
      const job = modelKeyHealthJobFromEnv({ query } as never, () => undefined);
      expect(job.name).toBe("model_key_health");
      expect(await job.run(ctx(query))).toEqual({ cursor: null, wrapped: false, code: "not_configured" });
      expect(query).not.toHaveBeenCalled();
    });
  });

  it("when configured it lists the connections (and opens no pool when there are none)", async () => {
    await withEnv({ DATABASE_URL_APP_USER: "postgres://app_user@127.0.0.1:1/none", FX_KEK_CURRENT_VERSION: undefined, FX_KEK_V1: "A".repeat(43) + "=" }, async () => {
      const query = vi.fn(async () => ({ rows: [] }));
      const job = modelKeyHealthJobFromEnv({ query } as never, () => undefined);
      expect(await job.run(ctx(query))).toEqual({ cursor: null, wrapped: true });
      expect(query).toHaveBeenCalledTimes(1);
    });
  });
});

describe("the schedule", () => {
  it("vercel.json has the reconcile cron at 7 */6 * * * next to the sweeps at their gated cadence (see vercel-crons.test.ts)", () => {
    const config = JSON.parse(readFileSync(path.join(__dirname, "../../../../vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(config.crons).toEqual([
      { path: "/api/cron/api-sweep", schedule: "*/5 * * * *" },
      { path: "/api/cron/run-action-sweep", schedule: "*/5 * * * *" },
      { path: "/api/cron/compute-settle-sweep", schedule: "*/10 * * * *" },
      { path: "/api/cron/runner-sweeper", schedule: "*/5 * * * *" },
      { path: "/api/cron/reconcile", schedule: "7 */6 * * *" },
    ]);
  });

  it("the route allows 300 s, above the tick's 240 s budget", () => {
    expect(maxDuration).toBe(300);
  });
});
