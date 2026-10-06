import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { checkOwnerShape } from "@fx/db/src/ownerShape";
import { migrateOnBuild, MigrateOnBuildError } from "../scripts/migrate-on-build.mjs";

/** The child's environment, built from a small explicit allowlist plus what the test sets: the whole environment is never passed on. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...extra } as unknown as NodeJS.ProcessEnv;
}

type RunOptions = { env?: Record<string, string | undefined>; log?: (line: string) => void; load?: unknown };
const run = migrateOnBuild as (options: RunOptions) => Promise<{ status: string; applied?: string[] }>;

/**
 * Staging migrate-on-build: flag-gated, owner-shape checked, quiet about its
 * credentials. The real runner and a real Neon-shaped role are exercised by
 * packages/db/scripts/test-neon-shape.sh; this file pins the build script's own
 * contract with injected fakes plus two real child-process runs.
 */
const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const PASSWORD = "Sup3r-S3cret-Pw";
const FAKE_URL = `postgres://owner_user:${PASSWORD}@db.fake-host.example:5432/appdb?sslmode=require`;

const GOOD_ROW = {
  rolcanlogin: true,
  rolcreaterole: true,
  rolbypassrls: true,
  rolsuper: false,
  rolcreatedb: false,
  rolreplication: false,
  owns_db: true,
};

function harness(row: Record<string, boolean> | null = GOOD_ROW, applied: string[][] = [["0001_core.sql"]]) {
  const query = vi.fn(async () => ({ rows: row ? [row] : [] }));
  const pool = { query, end: vi.fn(async () => {}), on: vi.fn() };
  const runMigrations = vi.fn(async () => ({ applied: applied.shift() ?? [] }));
  const createPool = vi.fn(() => pool);
  const load = vi.fn(async () => ({ createPool, runMigrations, checkOwnerShape }));
  const out: string[] = [];
  const log = (line: string) => out.push(line);
  return { pool, query, runMigrations, createPool, load, out, log };
}

describe("migrate-on-build: flag off", () => {
  it("unset, empty or 0: no database code is loaded and no connection is attempted", async () => {
    for (const value of [undefined, "", "0"]) {
      const h = harness();
      const env = { DATABASE_URL_UNPOOLED: FAKE_URL, ...(value === undefined ? {} : { FX_MIGRATE_ON_BUILD: value }) };
      const result = await run({ env, log: h.log, load: h.load });
      expect(result).toEqual({ status: "skipped" });
      expect(h.load).not.toHaveBeenCalled();
      expect(h.createPool).not.toHaveBeenCalled();
      expect(h.out).toEqual([]);
    }
  });

  it("as a real build step: exits 0 and prints nothing, even with an unreachable URL set", () => {
    const env = childEnv({ DATABASE_URL_UNPOOLED: "postgres://u:pw@127.0.0.1:1/db" });
    delete env.FX_MIGRATE_ON_BUILD;
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/migrate-on-build.mjs"], { env, cwd: WEB_DIR, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });
});

describe("migrate-on-build: flag on", () => {
  it("fails with a clear message when the direct URL is missing, touching nothing", async () => {
    const h = harness();
    await expect(run({ env: { FX_MIGRATE_ON_BUILD: "1" }, log: h.log, load: h.load })).rejects.toThrow(/DATABASE_URL_UNPOOLED is not set/);
    expect(h.load).not.toHaveBeenCalled();
  });

  it("rejects a value other than 1", async () => {
    const h = harness();
    await expect(run({ env: { FX_MIGRATE_ON_BUILD: "true", DATABASE_URL_UNPOOLED: FAKE_URL }, load: h.load })).rejects.toBeInstanceOf(MigrateOnBuildError);
    expect(h.createPool).not.toHaveBeenCalled();
  });

  it("refuses a pooled host (-pooler) and an unparseable URL, touching nothing", async () => {
    for (const bad of ["postgres://u:pw@ep-cool-123-pooler.eu.neon.tech/db", "not a url"]) {
      const h = harness();
      await expect(run({ env: { FX_MIGRATE_ON_BUILD: "1", DATABASE_URL_UNPOOLED: bad }, load: h.load })).rejects.toThrow(/pooled host/);
      expect(h.load).not.toHaveBeenCalled();
    }
  });

  it("on Vercel, only a Production build may migrate; Preview and Development are refused before any database code loads", async () => {
    for (const vercelEnv of ["preview", "development", undefined]) {
      const h = harness();
      const env = { FX_MIGRATE_ON_BUILD: "1", DATABASE_URL_UNPOOLED: FAKE_URL, VERCEL: "1", ...(vercelEnv ? { VERCEL_ENV: vercelEnv } : {}) };
      await expect(run({ env, load: h.load }), String(vercelEnv)).rejects.toThrow(/only honoured on a Vercel Production build/);
      expect(h.load).not.toHaveBeenCalled();
    }
    const h = harness();
    const env = { FX_MIGRATE_ON_BUILD: "1", DATABASE_URL_UNPOOLED: FAKE_URL, VERCEL: "1", VERCEL_ENV: "production" };
    expect((await run({ env, log: h.log, load: h.load })).status).toBe("migrated");
  });

  it("owner-role shape check: the real Neon owner (CREATEDB + REPLICATION) is accepted", async () => {
    const h = harness({ ...GOOD_ROW, rolcreatedb: true, rolreplication: true });
    const env = { FX_MIGRATE_ON_BUILD: "1", DATABASE_URL_UNPOOLED: FAKE_URL };
    expect((await run({ env, log: h.log, load: h.load })).status).toBe("migrated");
    expect(h.runMigrations).toHaveBeenCalled();
  });

  it("owner-role shape check: every wrong attribute fails the build and no migration runs", async () => {
    const wrong: Array<[string, Record<string, boolean>, RegExp]> = [
      ["superuser", { ...GOOD_ROW, rolsuper: true }, /superuser/],
      ["no login", { ...GOOD_ROW, rolcanlogin: false }, /cannot log in/],
      ["no createrole", { ...GOOD_ROW, rolcreaterole: false }, /CREATEROLE/],
      ["no bypassrls", { ...GOOD_ROW, rolbypassrls: false }, /BYPASSRLS/],
      ["not db owner", { ...GOOD_ROW, owns_db: false }, /does not own the database/],
    ];
    for (const [label, row, message] of wrong) {
      const h = harness(row);
      await expect(run({ env: { FX_MIGRATE_ON_BUILD: "1", DATABASE_URL_UNPOOLED: FAKE_URL }, log: h.log, load: h.load }), label).rejects.toThrow(message);
      expect(h.runMigrations, label).not.toHaveBeenCalled();
      expect(h.pool.end, label).toHaveBeenCalled();
    }
  });

  it("fails closed when the role cannot be read from the catalog", async () => {
    const h = harness(null);
    await expect(run({ env: { FX_MIGRATE_ON_BUILD: "1", DATABASE_URL_UNPOOLED: FAKE_URL }, load: h.load })).rejects.toThrow(/could not be read/);
    expect(h.runMigrations).not.toHaveBeenCalled();
  });

  it("right shape: runs the existing runner once; a second run applies nothing", async () => {
    const h = harness(GOOD_ROW, [["0001_core.sql", "0002_x.sql"], []]);
    const env = { FX_MIGRATE_ON_BUILD: "1", DATABASE_URL_UNPOOLED: FAKE_URL };
    expect(await run({ env, log: h.log, load: h.load })).toEqual({ status: "migrated", applied: ["0001_core.sql", "0002_x.sql"] });
    expect(await run({ env, log: h.log, load: h.load })).toEqual({ status: "migrated", applied: [] });
    expect(h.createPool).toHaveBeenCalledWith(FAKE_URL);
    expect(h.out[1]).toMatch(/already up to date/);
  });

  it("never prints the URL or any part of the password, including from a failing step", async () => {
    const leaky = `connection to ${FAKE_URL} failed for owner_user with password ${PASSWORD} on db.fake-host.example`;
    const cases: Array<() => ReturnType<typeof harness>> = [
      () => {
        const h = harness();
        h.runMigrations.mockRejectedValueOnce(new Error(leaky));
        return h;
      },
      () => {
        const h = harness();
        h.query.mockRejectedValueOnce(new Error(leaky));
        return h;
      },
      () => harness({ ...GOOD_ROW, rolsuper: true }),
      () => harness(),
    ];
    for (const make of cases) {
      const h = make();
      let text = "";
      try {
        await run({ env: { FX_MIGRATE_ON_BUILD: "1", DATABASE_URL_UNPOOLED: FAKE_URL }, log: h.log, load: h.load });
      } catch (err) {
        text += (err as Error).message;
      }
      text += h.out.join("\n");
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(FAKE_URL);
      expect(text).not.toContain("fake-host");
    }
  });

  it("scrubs a percent-encoded username in its decoded form too", async () => {
    const url = "postgres://own%3Aer%40x:pw123@db.fake-host.example/appdb";
    const h = harness();
    h.query.mockRejectedValueOnce(new Error("password authentication failed for user own:er@x"));
    let text = "";
    try {
      await run({ env: { FX_MIGRATE_ON_BUILD: "1", DATABASE_URL_UNPOOLED: url }, log: h.log, load: h.load });
    } catch (err) {
      text = (err as Error).message;
    }
    expect(text).toContain("could not read");
    expect(text).not.toContain("own:er@x");
    expect(text).not.toContain("own%3Aer%40x");
  });

  it("as a real build step with a percent-encoded username: the decoded form never appears in the output", () => {
    const url = "postgres://own%3Aer%40x:pw123@127.0.0.1:1/appdb";
    const env = childEnv({ FX_MIGRATE_ON_BUILD: "1", DATABASE_URL_UNPOOLED: url });
    delete env.VERCEL;
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/migrate-on-build.mjs"], { env, cwd: WEB_DIR, encoding: "utf8" });
    const output = r.stdout + r.stderr;
    expect(r.status).toBe(1);
    expect(output).not.toContain("own:er@x");
    expect(output).not.toContain("own%3Aer%40x");
  });

  it("as a real build step: a connection failure exits non-zero and the output carries no URL or password", () => {
    const url = `postgres://owner_user:${PASSWORD}@127.0.0.1:1/appdb`;
    const env = childEnv({ FX_MIGRATE_ON_BUILD: "1", DATABASE_URL_UNPOOLED: url });
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/migrate-on-build.mjs"], { env, cwd: WEB_DIR, encoding: "utf8" });
    const output = r.stdout + r.stderr;
    expect(r.status).toBe(1);
    expect(output).toContain("migrate-on-build: FAILED");
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain(url);
  });
});
