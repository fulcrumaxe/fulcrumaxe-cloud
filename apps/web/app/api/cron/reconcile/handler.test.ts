import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { effectiveSandboxReapMode, RECONCILE_JOBS, type JobContext, type SandboxReapDbSetting, type SandboxReapSweepInput, type SandboxReapWorker, type TickDeps, type TickSummary } from "@fx/reconcile";
import { reportError } from "@fx/telemetry";
import { defaultReconcileDeps, modelKeyHealthJobFromEnv, readSandboxReapDbMode, reconcileHandler, stripeSubscriptionsJobFromEnv, type ReconcileHandlerDeps } from "./handler";
import { maxDuration } from "./route";
import { getWorker } from "../../../../lib/worker";

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
    // The fixed jobs first, then the sandbox reaper's (built over the worker), then the GitHub, Stripe and model-key jobs, which the route builds from its environment.
    expect(tick.jobs.map((job) => job.name)).toEqual([
      ...RECONCILE_JOBS.map((job) => job.name),
      "sandbox_reap_terminal",
      "sandbox_reap_ephemeral",
      "sandbox_reap_idle",
      "sandbox_inventory",
      "github_installations",
      "github_repos",
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
      expect(deps.getWorker).toBe(getWorker);
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
  it("vercel.json has the reconcile cron every 15 minutes (7,22,37,52) next to the sweeps at their gated cadence (see vercel-crons.test.ts)", () => {
    const config = JSON.parse(readFileSync(path.join(__dirname, "../../../../vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(config.crons).toEqual([
      { path: "/api/cron/api-sweep", schedule: "*/5 * * * *" },
      { path: "/api/cron/run-action-sweep", schedule: "*/5 * * * *" },
      { path: "/api/cron/compute-settle-sweep", schedule: "*/10 * * * *" },
      { path: "/api/cron/runner-sweeper", schedule: "*/5 * * * *" },
      { path: "/api/cron/reconcile", schedule: "7,22,37,52 * * * *" },
    ]);
  });

  it("the route allows 300 s, above the tick's 240 s budget", () => {
    expect(maxDuration).toBe(300);
  });
});

describe("the sandbox reaper's wiring (C82 sections 2 and 3)", () => {
  const SANDBOX_JOBS = ["sandbox_reap_terminal", "sandbox_reap_ephemeral", "sandbox_reap_idle", "sandbox_inventory"];
  const ctx = (): JobContext => ({ pool: {} as never, cursor: null, signal: new AbortController().signal, calls: { limit: 60, used: 0, take: () => true }, msLeft: () => 60_000, checkpoint: () => undefined });

  function worker() {
    const sweeps: SandboxReapSweepInput[] = [];
    const inventories: { now: number }[] = [];
    const w: SandboxReapWorker = {
      sweepSandboxReap: async (input) => (sweeps.push(input), { cursor: null, wrapped: true, callsUsed: 0, deleted: 0, stopped: 0, skipped: 0, candidates: [], alerts: [], orphans: 0 }),
      sandboxInventory: async (input) => (inventories.push(input), { accounts: 0, live: 0, stoppedExecutor: 0, stoppedEphemeral: 0, orphans: 0, alerts: [] }),
    };
    return { w, sweeps, inventories };
  }
  /** Runs the handler once with a captured tick, then runs each sandbox job the handler built. */
  async function drive(over: Partial<ReconcileHandlerDeps>, reports: { code?: string }[] = []) {
    const runTickFn = vi.fn(async (_deps: TickDeps) => summary);
    const deps = fakeDeps({ reportError: (_err, c) => void reports.push({ code: c.code }), ...over });
    const res = await reconcileHandler(requestWithAuth(`Bearer ${SECRET}`), deps, runTickFn);
    expect(res.status).toBe(200);
    const jobs = runTickFn.mock.calls[0]![0].jobs.filter((j) => SANDBOX_JOBS.includes(j.name));
    const results = [];
    for (const job of jobs) results.push([job.name, (await job.run(ctx())).code ?? "ran"]);
    return results;
  }

  it.each([
    ["unset", undefined, "dry_run"],
    ["dry_run", "dry_run", "dry_run"],
    ["on", "on", "on"],
  ])("FX_SANDBOX_REAP_MODE %s: the worker is asked for once and the passes run with mode %s", async (_label, raw, mode) => {
    const { w, sweeps, inventories } = worker();
    const getWorkerSpy = vi.fn(async () => w);
    expect(await drive({ sandboxReapMode: raw, getWorker: getWorkerSpy })).toEqual(SANDBOX_JOBS.map((n) => [n, "ran"]));
    expect(getWorkerSpy).toHaveBeenCalledTimes(1);
    expect(sweeps.map((s) => [s.pass, s.mode])).toEqual([["terminal", mode], ["ephemeral", mode], ["idle", mode]]);
    expect(inventories).toHaveLength(1);
  });

  it.each([
    ["off", "off"],
    ["an invalid value", "ON"],
    ["a typo", "dry-run"],
  ])("%s: the worker is never even asked for, the jobs answer disabled, and an invalid value is reported", async (_label, raw) => {
    const { w, sweeps, inventories } = worker();
    const getWorkerSpy = vi.fn(async () => w);
    const reports: { code?: string }[] = [];
    expect(await drive({ sandboxReapMode: raw, getWorker: getWorkerSpy }, reports)).toEqual(SANDBOX_JOBS.map((n) => [n, "disabled"]));
    expect(getWorkerSpy).not.toHaveBeenCalled();
    expect(sweeps).toEqual([]);
    expect(inventories).toEqual([]);
    expect(reports.filter((r) => r.code === "sandbox_reap_mode_invalid")).toHaveLength(raw === "off" ? 0 : SANDBOX_JOBS.length);
  });

  it("FX_RECONCILE_ENABLED=0: the worker is not asked for either", async () => {
    const getWorkerSpy = vi.fn(async () => worker().w);
    await drive({ enabled: false, sandboxReapMode: "on", getWorker: getWorkerSpy });
    expect(getWorkerSpy).not.toHaveBeenCalled();
  });

  it("a null worker (not configured): each sandbox job reports sandbox_reap_unconfigured, and the tick still runs", async () => {
    const reports: { code?: string }[] = [];
    expect(await drive({ sandboxReapMode: "on", getWorker: async () => null }, reports)).toEqual(SANDBOX_JOBS.map((n) => [n, "not_configured"]));
    expect(reports.filter((r) => r.code === "sandbox_reap_unconfigured")).toHaveLength(SANDBOX_JOBS.length);
  });

  it("a worker that fails to build costs the sandbox jobs their run and nothing else: the tick still runs, the failure is reported", async () => {
    const stages: string[] = [];
    const runTickFn = vi.fn(async (_deps: TickDeps) => summary);
    const deps = fakeDeps({ sandboxReapMode: "on", getWorker: async () => { throw new Error("pools guard refused"); }, reportError: (_e, c) => void stages.push(c.stage) });
    const res = await reconcileHandler(requestWithAuth(`Bearer ${SECRET}`), deps, runTickFn);
    expect(res.status).toBe(200);
    expect(runTickFn).toHaveBeenCalledTimes(1);
    expect(stages).toContain("reconcile.sandbox_worker");
  });

  it("no worker dependency given at all (a test double) behaves as unconfigured", async () => {
    expect(await drive({ sandboxReapMode: "on" })).toEqual(SANDBOX_JOBS.map((n) => [n, "not_configured"]));
  });

  it("an unauthenticated call never builds the worker", async () => {
    const getWorkerSpy = vi.fn(async () => worker().w);
    const res = await reconcileHandler(requestWithAuth("Bearer wrong"), fakeDeps({ getWorker: getWorkerSpy }), vi.fn());
    expect(res.status).toBe(401);
    expect(getWorkerSpy).not.toHaveBeenCalled();
  });
});

describe("the reaper's kill switch also reads a database setting (C85)", () => {
  const SANDBOX_JOBS = ["sandbox_reap_terminal", "sandbox_reap_ephemeral", "sandbox_reap_idle", "sandbox_inventory"];
  const REAP_JOBS = SANDBOX_JOBS.slice(0, 3);
  const ctx = (): JobContext => ({ pool: {} as never, cursor: null, signal: new AbortController().signal, calls: { limit: 60, used: 0, take: () => true }, msLeft: () => 60_000, checkpoint: () => undefined });
  const sweeps = (): { w: SandboxReapWorker; seen: string[]; inventories: number[] } => {
    const seen: string[] = [];
    const inventories: number[] = [];
    const w: SandboxReapWorker = {
      sweepSandboxReap: async (input) => (seen.push(`${input.pass}:${input.mode}`), { cursor: null, wrapped: true, callsUsed: 0, deleted: 0, stopped: 0, skipped: 0, candidates: [], alerts: [], orphans: 0 }),
      sandboxInventory: async () => (inventories.push(1), { accounts: 0, live: 0, stoppedExecutor: 0, stoppedEphemeral: 0, orphans: 0, alerts: [] }),
    };
    return { w, seen, inventories };
  };
  /** One request to the handler, then each sandbox job it built, in order. */
  async function pass(deps: ReconcileHandlerDeps): Promise<Record<string, string>> {
    const runTickFn = vi.fn(async (_deps: TickDeps) => summary);
    const res = await reconcileHandler(requestWithAuth(`Bearer ${SECRET}`), deps, runTickFn);
    expect(res.status).toBe(200);
    const out: Record<string, string> = {};
    for (const job of runTickFn.mock.calls[0]![0].jobs.filter((j) => SANDBOX_JOBS.includes(j.name))) out[job.name] = (await job.run(ctx())).code ?? "ran";
    return out;
  }

  // Written out by hand, not computed: the stricter of the two, off < dry_run < on; a database NULL leaves the environment alone.
  const ENVS: [string, string | undefined][] = [["unset", undefined], ["off", "off"], ["dry_run", "dry_run"], ["on", "on"], ["invalid", "ON"]];
  const DBS: SandboxReapDbSetting[] = [null, "off", "dry_run", "on"];
  const EXPECTED: Record<string, ("off" | "dry_run" | "on")[]> = {
    unset: ["dry_run", "off", "dry_run", "dry_run"],
    off: ["off", "off", "off", "off"],
    dry_run: ["dry_run", "off", "dry_run", "dry_run"],
    on: ["on", "off", "dry_run", "on"],
    invalid: ["off", "off", "off", "off"],
  };
  const CELLS = ENVS.flatMap(([label, raw]) => DBS.map((db, i) => [label, raw, db, EXPECTED[label]![i]!] as const));

  it("the full matrix: 5 environment values times 4 database values is the stricter one in all 20 cells", () => {
    expect(CELLS).toHaveLength(20);
    for (const [label, raw, db, want] of CELLS) expect(effectiveSandboxReapMode(raw, db).mode, `${label} x ${String(db)}`).toBe(want);
  });

  it.each(CELLS)("through the handler, env %s (%s) with database %s: the passes run as %s", async (_label, raw, db, want) => {
    const { w, seen, inventories } = sweeps();
    const out = await pass(fakeDeps({ sandboxReapMode: raw, getWorker: async () => w, readSandboxReapDbMode: async () => db }));
    if (want === "off") {
      for (const name of REAP_JOBS) expect(out[name]).toBe("disabled");
      expect(seen).toEqual([]);
    } else {
      expect(seen).toEqual([`terminal:${want}`, `ephemeral:${want}`, `idle:${want}`]);
    }
    // The inventory deletes nothing and is not gated by the database setting: it goes by the environment alone.
    const envOff = raw !== undefined && raw !== "dry_run" && raw !== "on";
    expect(inventories).toHaveLength(envOff ? 0 : 1);
  });

  it("no redeploy: in one handler instance with the environment fixed at on, a database off stops the next pass at zero worker calls, and a NULL lets it delete again", async () => {
    const { w, seen } = sweeps();
    let db: SandboxReapDbSetting = null;
    const reports: string[] = [];
    const deps = fakeDeps({ sandboxReapMode: "on", getWorker: async () => w, readSandboxReapDbMode: async () => db, reportError: (_e, c) => void reports.push(c.code ?? "") });
    expect(await pass(deps)).toMatchObject({ sandbox_reap_terminal: "ran" });
    expect(seen).toEqual(["terminal:on", "ephemeral:on", "idle:on"]);
    db = "off";
    seen.length = 0;
    const second = await pass(deps);
    expect(REAP_JOBS.map((n) => second[n])).toEqual(["disabled", "disabled", "disabled"]);
    expect(seen).toEqual([]);
    db = null;
    expect(await pass(deps)).toMatchObject({ sandbox_reap_terminal: "ran" });
    expect(seen).toEqual(["terminal:on", "ephemeral:on", "idle:on"]);
    expect(reports).toEqual([]);
  });

  it("the setting is read before each pass, not once per tick: a change between two jobs of one tick reaches the second", async () => {
    const { w, seen } = sweeps();
    let reads = 0;
    const runTickFn = vi.fn(async (_deps: TickDeps) => summary);
    const deps = fakeDeps({ sandboxReapMode: "on", getWorker: async () => w, readSandboxReapDbMode: async () => (++reads === 1 ? null : "off") });
    await reconcileHandler(requestWithAuth(`Bearer ${SECRET}`), deps, runTickFn);
    const jobs = runTickFn.mock.calls[0]![0].jobs.filter((j) => REAP_JOBS.includes(j.name));
    expect((await jobs[0]!.run(ctx())).code).toBeUndefined();
    expect((await jobs[1]!.run(ctx())).code).toBe("disabled");
    expect(seen).toEqual(["terminal:on"]);
    expect(reads).toBe(2);
  });

  it("a failed read is off: zero worker calls and one sandbox_reap_mode_unreadable report for each reap pass", async () => {
    const { w, seen } = sweeps();
    const reports: string[] = [];
    const out = await pass(fakeDeps({ sandboxReapMode: "on", getWorker: async () => w, readSandboxReapDbMode: async () => "unreadable", reportError: (_e, c) => void reports.push(c.code ?? "") }));
    expect(REAP_JOBS.map((n) => out[n])).toEqual(["disabled", "disabled", "disabled"]);
    expect(seen).toEqual([]);
    expect(reports.filter((c) => c === "sandbox_reap_mode_unreadable")).toHaveLength(3);
  });

  it("a reader that throws is read as unreadable too", async () => {
    const { w, seen } = sweeps();
    const reports: string[] = [];
    const out = await pass(fakeDeps({ sandboxReapMode: "on", getWorker: async () => w, readSandboxReapDbMode: async () => { throw new Error("boom"); }, reportError: (_e, c) => void reports.push(c.code ?? "") }));
    expect(out.sandbox_reap_terminal).toBe("disabled");
    expect(seen).toEqual([]);
    expect(reports.filter((c) => c === "sandbox_reap_mode_unreadable")).toHaveLength(3);
  });

  describe("readSandboxReapDbMode", () => {
    const poolOf = (rows: { mode: string | null }[] | Error) => ({ query: async () => { if (rows instanceof Error) throw rows; return { rows }; } }) as never;
    it.each([
      [[{ mode: null }], null],
      [[{ mode: "off" }], "off"],
      [[{ mode: "dry_run" }], "dry_run"],
      [[{ mode: "on" }], "on"],
      [[], "unreadable"],
      [[{ mode: "on" }, { mode: "off" }], "unreadable"],
      [[{ mode: "ON" }], "unreadable"],
      [new Error("permission denied"), "unreadable"],
    ])("%j reads as %s", async (rows, want) => {
      expect(await readSandboxReapDbMode(poolOf(rows as never))).toBe(want);
    });
  });
});
