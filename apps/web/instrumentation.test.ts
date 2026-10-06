import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// register() installs the process-wide error reporter once. The Postgres pool is the only thing replaced here:
// the reporter, the sink and the definer-function call are the real modules.
const pool = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [] })), on: vi.fn() }));
const createPool = vi.hoisted(() => vi.fn((..._args: unknown[]) => pool));

vi.mock("@fx/billing", () => ({ assertStripePriceIdsConfigured: () => undefined }));
vi.mock("@fx/db/src/pool.js", () => ({ createPool }));

import { configureErrorReporter, reportError } from "@fx/telemetry";
import { getPendingHooks, setPendingHooks } from "@fx/core/src/pendingWork";
import { register } from "./instrumentation";

const ENV = ["NEXT_RUNTIME", "DATABASE_URL_APP_USER"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.NEXT_RUNTIME = "nodejs";
  pool.query.mockClear();
  pool.on.mockClear();
  createPool.mockClear();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  configureErrorReporter({ service: "app" });
  setPendingHooks(null);
  vi.restoreAllMocks();
});

describe("instrumentation register(): the error reporter", () => {
  it("with the app_user login set, installs a sink on a one-connection pool that connects only when an error is reported", async () => {
    process.env.DATABASE_URL_APP_USER = "postgres://app_user@db.example/fx";
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await register();
    expect(createPool).toHaveBeenCalledTimes(1);
    expect(createPool.mock.calls[0]![0]).toBe("postgres://app_user@db.example/fx");
    expect(createPool.mock.calls[0]![1]).toMatchObject({ max: 1 });
    expect(pool.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(pool.query).not.toHaveBeenCalled(); // nothing is sent at start-up

    reportError(Object.assign(new Error("boom octo/repo"), { code: "ECONNRESET" }), { stage: "sync", route: "/api/v1/runs" });
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalledTimes(1));
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("error_event_record"), ["web", "/api/v1/runs", "sync", "ECONNRESET", 1]);
    expect(String(out.mock.calls[0]![0])).toContain('"event":"error.reported"');
    expect(String(out.mock.calls[0]![0])).toContain('"service":"web"');
  });

  it("without it, reports stay on stdout and no pool is made", async () => {
    delete process.env.DATABASE_URL_APP_USER;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await register();
    reportError(new Error("boom"), { stage: "sync", route: "/api/v1/runs" });
    expect(createPool).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(out).toHaveBeenCalledTimes(1);
  });

  it("installs the work-pending marker with or without the app_user login (the reporter block returns early without it)", async () => {
    for (const url of [undefined, "postgres://app_user@db.example/fx"]) {
      setPendingHooks(null);
      if (url === undefined) delete process.env.DATABASE_URL_APP_USER;
      else process.env.DATABASE_URL_APP_USER = url;
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await register();
      expect(getPendingHooks(), `DATABASE_URL_APP_USER=${url ?? "unset"}`).not.toBeNull();
      expect(getPendingHooks()?.reportError).toEqual(expect.any(Function));
    }
  });

  it("does nothing outside the Node runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    process.env.DATABASE_URL_APP_USER = "postgres://app_user@db.example/fx";
    await register();
    expect(createPool).not.toHaveBeenCalled();
  });
});
