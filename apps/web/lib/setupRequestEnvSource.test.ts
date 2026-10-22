import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPendingHooks } from "@fx/core/src/pendingWork";

vi.mock("@fx/api/src/sse/pools.js", () => ({
  appUserPool: () => {
    if (!process.env.DATABASE_URL_APP_USER) throw new Error("DATABASE_URL_APP_USER must be set");
    return {};
  },
}));

/** D#598 P8d-2: the production env-name source reads the account's own sealed token, so it is able to answer only where the database and the platform key are set. */
describe("productionVercelEnvSource", () => {
  const saved = { db: process.env.DATABASE_URL_APP_USER, kek: process.env.FX_KEK_V1, version: process.env.FX_KEK_CURRENT_VERSION };
  const restore = (name: string, value: string | undefined) => (value === undefined ? vi.unstubAllEnvs() : vi.stubEnv(name, value));
  beforeEach(() => {
    vi.resetModules();
    setPendingHooks(null);
    delete process.env.DATABASE_URL_APP_USER;
    delete process.env.FX_KEK_V1;
    delete process.env.FX_KEK_CURRENT_VERSION;
  });
  afterEach(() => {
    restore("DATABASE_URL_APP_USER", saved.db);
    restore("FX_KEK_V1", saved.kek);
    restore("FX_KEK_CURRENT_VERSION", saved.version);
    setPendingHooks(null);
  });

  it("importing it needs neither a database nor a key, and with neither it cannot answer", async () => {
    const { productionVercelEnvSource } = await import("./setupRequestEnvSource");
    expect(productionVercelEnvSource.available).toBe(false);
    expect(await productionVercelEnvSource.listEnvNames({ accountId: "11111111-1111-4111-8111-111111111111", project: "cloud-staging" })).toEqual({ ok: false });
  });

  it("a database alone, or a key alone, or a malformed key does not make it able to answer; both together do", async () => {
    vi.stubEnv("DATABASE_URL_APP_USER", "postgres://unused");
    expect((await import("./setupRequestEnvSource")).productionVercelEnvSource.available).toBe(false);
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("FX_KEK_V1", randomBytes(32).toString("base64"));
    expect((await import("./setupRequestEnvSource")).productionVercelEnvSource.available).toBe(false);
    vi.resetModules();
    vi.stubEnv("DATABASE_URL_APP_USER", "postgres://unused");
    vi.stubEnv("FX_KEK_V1", "too-short");
    expect((await import("./setupRequestEnvSource")).productionVercelEnvSource.available).toBe(false);
    vi.resetModules();
    vi.stubEnv("FX_KEK_V1", randomBytes(32).toString("base64"));
    expect((await import("./setupRequestEnvSource")).productionVercelEnvSource.available).toBe(true);
  });
});
