import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type EphemeralPostgres } from "@fx/db/test/support/ephemeral-pg.js";
import {
  APP_USER_ENV,
  EVENTS_LISTEN_ENV,
  GH_PROXY_ENV,
  OPS4_STRAY_MEMBERS_SQL,
  PLATFORM_OPS_ENV,
  StartupGuardError,
  assertPlatformOpsHasNoMembers,
  assertPlatformOpsSession,
  assertRunnerLoginNotSuperuser,
  assertRunnerLoginRoles,
  createWorkerPools,
} from "../src/pools.js";
import { RUNNER_LOGIN_NAME } from "./support/scanRunnerLoginReaders.js";

/**
 * Every startup guard against the HOSTED owner shape: a database whose owner is
 * a non-superuser CREATEROLE login (as on Neon), which ran every migration, with
 * the runtime logins set up the way scripts/ops/staging-role-creds.mjs does it.
 * The other pools tests run against a database a superuser migrated, where
 * `platform_ops` has no member rows at all, so they could never see the rows a
 * hosted owner leaves behind (the guard once refused the real staging database
 * forever because of them).
 *
 * What a fake cannot reproduce: Neon's own superuser (cloud_admin) as the grantor
 * of the owner's ADMIN row. Here the grantor is this throwaway cluster's bootstrap
 * superuser, which is the same kind of row (a grant the owner cannot revoke).
 */
const OWNER = "fx_neon_owner";
const RUNNER = "fx_runner";
const DB = "fx_neon_guard";

/**
 * A pool with an error listener. When the throwaway cluster is stopped at the end, a backend can
 * still report the shutdown (57P01) to a client whose close has not finished; without a listener
 * that surfaces as an unhandled error in the test run.
 */
const quietPool = (connectionString: string): Pool => {
  const p = createPool(connectionString);
  p.on("error", () => undefined);
  return p;
};

describe("startup guards on the hosted owner shape [pg]", () => {
  let cluster: EphemeralPostgres;
  let superPool: Pool;
  const pools: Pool[] = [];

  const urlFor = (user: string): string => `postgres://${user}@127.0.0.1:${cluster.port}/${DB}`;
  const poolFor = (user: string): Pool => {
    const p = quietPool(urlFor(user));
    pools.push(p);
    return p;
  };
  /** The real guard over the real pools: platform_ops' own pool, and `runnerLogin`'s. */
  const ops4 = (runnerLogin = RUNNER): Promise<void> => assertPlatformOpsHasNoMembers(poolFor("platform_ops"), poolFor(runnerLogin));
  const refusedWith = async (p: Promise<unknown>): Promise<string> => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StartupGuardError);
    return (err as StartupGuardError).rule;
  };
  /** Runs `fn` with `grantSql` applied (as the cluster superuser), then always reverses it. */
  async function with_(grantSql: string, revokeSql: string, fn: () => Promise<void>): Promise<void> {
    await superPool.query(grantSql);
    try {
      await fn();
    } finally {
      await superPool.query(revokeSql);
    }
  }
  const memberRows = async (): Promise<unknown[][]> =>
    (
      await superPool.query(
        `SELECT pg_get_userbyid(member) AS m, admin_option AS a, pg_get_userbyid(grantor) AS g FROM pg_auth_members
          WHERE roleid = 'platform_ops'::regrole ORDER BY a DESC, m`,
      )
    ).rows.map((r) => [r.m, r.a, r.g]);

  beforeAll(async () => {
    cluster = await provisionEphemeralPostgres({ database: "fx_neon_scratch", tmpPrefix: "fx-worker-neon-pg-" });
    superPool = quietPool(cluster.url);
    // The owner a hosted database gives you: LOGIN CREATEROLE (and the rest that
    // neon_superuser carries), but not SUPERUSER.
    await superPool.query(`
      CREATE ROLE neon_superuser NOLOGIN CREATEDB CREATEROLE BYPASSRLS REPLICATION NOSUPERUSER;
      CREATE ROLE ${OWNER} LOGIN CREATEROLE BYPASSRLS CREATEDB REPLICATION NOSUPERUSER;
      GRANT neon_superuser TO ${OWNER};`);
    await superPool.query(`CREATE DATABASE ${DB} OWNER ${OWNER}`);
    const ownerPool = createPool(urlFor(OWNER));
    try {
      await runMigrations(ownerPool);
      // The runner login as the ops script creates it, by the owner.
      await ownerPool.query(`CREATE ROLE ${RUNNER} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT`);
      await ownerPool.query(`GRANT app_user, agent_run_writer TO ${RUNNER} WITH INHERIT TRUE`);
    } finally {
      await ownerPool.end();
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    await superPool?.end();
    cluster?.cleanup();
  });

  it("really has the hosted shape: a non-superuser owner holding exactly the two membership rows", async () => {
    const { rows } = await superPool.query(
      `SELECT r.rolsuper, pg_get_userbyid(d.datdba) AS owner FROM pg_database d, pg_roles r WHERE d.datname = $1 AND r.oid = d.datdba`,
      [DB],
    );
    expect(rows).toEqual([{ rolsuper: false, owner: OWNER }]);
    // Row 1: the ADMIN grant the creating login receives from a superuser, which it cannot revoke.
    // Row 2: the owner's own grant the migrations leave behind (INHERIT FALSE, SET TRUE).
    expect(await memberRows()).toEqual([
      [OWNER, true, "postgres"],
      [OWNER, false, OWNER],
    ]);
  });

  it("every guard passes: OPS-1, OPS-2, OPS-4, OPS-5 and CONFIG, through createWorkerPools itself", async () => {
    const platformOps = poolFor("platform_ops");
    const runner = poolFor(RUNNER);
    await expect(assertPlatformOpsSession(platformOps)).resolves.toBeUndefined(); // OPS-1
    await expect(assertRunnerLoginNotSuperuser(runner)).resolves.toBeUndefined(); // OPS-2
    await expect(assertRunnerLoginRoles(runner)).resolves.toBeUndefined(); // OPS-5
    await expect(assertPlatformOpsHasNoMembers(platformOps, runner)).resolves.toBeUndefined(); // OPS-4

    const worker = await createWorkerPools({ [RUNNER_LOGIN_NAME]: urlFor(RUNNER), [PLATFORM_OPS_ENV]: urlFor("platform_ops") }, { makePool: quietPool });
    await worker.close();
    // CONFIG still refuses a missing variable.
    expect(await refusedWith(createWorkerPools({ [PLATFORM_OPS_ENV]: urlFor("platform_ops") }, { makePool: quietPool }))).toBe("CONFIG");
  });

  it("refuses when app_user, the runner login or an events login is a member of platform_ops", async () => {
    await superPool.query("CREATE ROLE fx_events LOGIN NOSUPERUSER NOBYPASSRLS");
    try {
      for (const member of ["app_user", RUNNER, "fx_events"]) {
        await with_(`GRANT platform_ops TO ${member}`, `REVOKE platform_ops FROM ${member}`, async () => {
          expect(await refusedWith(ops4())).toBe("OPS-4");
        });
      }
      await expect(ops4()).resolves.toBeUndefined(); // each grant was reversed
    } finally {
      await superPool.query("DROP ROLE fx_events");
    }
  });

  it("refuses when those logins reach platform_ops only through an intermediate role", async () => {
    await superPool.query("CREATE ROLE fx_mid NOLOGIN; GRANT platform_ops TO fx_mid");
    try {
      for (const member of ["app_user", RUNNER, "fx_events_via_mid"]) {
        if (member === "fx_events_via_mid") await superPool.query(`CREATE ROLE ${member} LOGIN NOSUPERUSER NOBYPASSRLS`);
        await with_(`GRANT fx_mid TO ${member}`, `REVOKE fx_mid FROM ${member}`, async () => {
          expect(await refusedWith(ops4())).toBe("OPS-4");
        });
        if (member === "fx_events_via_mid") await superPool.query(`DROP ROLE ${member}`);
      }
    } finally {
      await superPool.query("DROP ROLE fx_mid");
    }
    await expect(ops4()).resolves.toBeUndefined();
  });

  it("refuses a login that reaches platform_ops through the OWNER role, which the member rows alone would not show", async () => {
    // Not the runner login itself: the owner created it, so the owner is already a member of it
    // and it cannot also be a member of the owner. A login made by someone else can be.
    await superPool.query("CREATE ROLE fx_other LOGIN NOSUPERUSER NOBYPASSRLS");
    try {
      await with_(`GRANT ${OWNER} TO fx_other`, `REVOKE ${OWNER} FROM fx_other`, async () => {
        // The member rows are unchanged (still exactly the owner's two)...
        expect(await memberRows()).toHaveLength(2);
        // ...so the stray-member half passes, and only the runtime-login half can refuse.
        expect((await poolFor("platform_ops").query(OPS4_STRAY_MEMBERS_SQL)).rows[0].v).toBe(0);
        expect(await refusedWith(ops4("fx_other"))).toBe("OPS-4");
      });
    } finally {
      await superPool.query("DROP ROLE fx_other");
    }
  });

  it("refuses when the owner itself is a runtime login", async () => {
    expect(await refusedWith(ops4(OWNER))).toBe("OPS-4");
  });

  describe("the web app's other database URLs", () => {
    const base = (): Record<string, string> => ({ [RUNNER_LOGIN_NAME]: urlFor(RUNNER), [PLATFORM_OPS_ENV]: urlFor("platform_ops") });
    const good = (): Record<string, string> => ({
      ...base(),
      [APP_USER_ENV]: urlFor("app_user"),
      [EVENTS_LISTEN_ENV]: urlFor("platform_ops"),
      [GH_PROXY_ENV]: urlFor("app_user"),
    });
    const start = async (env: Record<string, string>): Promise<void> => {
      const w = await createWorkerPools(env, { makePool: quietPool });
      await w.close();
    };

    it("passes when each is set to its proper login, and when none is set or they are blank", async () => {
      await expect(start(good())).resolves.toBeUndefined();
      await expect(start(base())).resolves.toBeUndefined();
      await expect(start({ ...base(), [APP_USER_ENV]: "", [EVENTS_LISTEN_ENV]: "  " })).resolves.toBeUndefined();
    });

    for (const name of [APP_USER_ENV, EVENTS_LISTEN_ENV, GH_PROXY_ENV]) {
      it(`refuses the worker when ${name} logs in as the database owner (the host's default connection string)`, async () => {
        expect(await refusedWith(createWorkerPools({ ...good(), [name]: urlFor(OWNER) }, { makePool: quietPool }))).toBe("OPS-4");
      });
    }

    it("refuses an events URL that is any login but platform_ops", async () => {
      expect(await refusedWith(createWorkerPools({ ...good(), [EVENTS_LISTEN_ENV]: urlFor("app_user") }, { makePool: quietPool }))).toBe("OPS-4");
    });

    it("a URL that is set but cannot be reached is DB-UNAVAILABLE, never a pass", async () => {
      const dead = `postgres://app_user@127.0.0.1:1/${DB}`;
      for (const name of [APP_USER_ENV, EVENTS_LISTEN_ENV, GH_PROXY_ENV]) {
        expect(await refusedWith(createWorkerPools({ ...good(), [name]: dead }, { makePool: quietPool }))).toBe("DB-UNAVAILABLE");
      }
    });
  });
});
