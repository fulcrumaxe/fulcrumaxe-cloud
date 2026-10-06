import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool.js";

/**
 * D#2 H14c-3-1: the worker's two database pools and the startup guards that
 * refuse to run on a mis-provisioned login.
 *
 * THIS IS THE ONLY FILE THAT READS THE RUNNER LOGIN (CARRY-8). It is a member
 * of `app_user` and `agent_run_writer`, the only login that can write
 * `agent_runs`. The variable's name is module-private, and neither the package
 * entry nor the `Worker` object hands out a pool, so no other module can read
 * the variable or reach the pool. Nothing under `apps/web/app/**` may name it
 * (test/runnerLoginReader.test.ts scans every source file for the name, ways to
 * spell it, and any import of this module from outside the package).
 *
 * Errors here carry a fixed rule id and message only: never a connection
 * string, a role's password, the driver's message or its `cause`.
 */

/** The runner login's connection string (`app_user` + `agent_run_writer`). */
const RUNNER_LOGIN_ENV = "FX_RUNNER_LOGIN_URL";
/** The `platform_ops` connection string (already used by apps/web). */
export const PLATFORM_OPS_ENV = "DATABASE_URL_PLATFORM_OPS";

export type StartupRule = "OPS-1" | "OPS-2" | "OPS-4" | "OPS-5" | "CONFIG" | "DB-UNAVAILABLE";

const RULE_TEXT: Readonly<Record<StartupRule, string>> = {
  "OPS-1": "the platform_ops pool must connect as exactly platform_ops (session_user), not a member of it",
  "OPS-2":
    "the runner login must not be a superuser or able to bypass row-level security, directly, as its current role, or through a role it is a member of",
  "OPS-4":
    "no runtime login may hold platform_ops, directly or through another role; only the database owner may be a member of it, and the owner must not be a runtime login; never grant any other role membership in platform_ops",
  "OPS-5": "the runner login must be a member of both app_user and agent_run_writer, or a run fails with a permission error after its money is reserved",
  "DB-UNAVAILABLE":
    "a guard query could not be run (database unreachable or the query failed), so nothing was verified and the worker will not start",
  CONFIG: "a required worker connection variable is not set, or a pool could not be built",
};

/** The worker refused to start. `rule` names which guard; nothing else leaks. */
export class StartupGuardError extends Error {
  constructor(public readonly rule: StartupRule) {
    super(`worker startup refused (${rule}): ${RULE_TEXT[rule]}`);
    this.name = "StartupGuardError";
  }
}

type Queryable = Pick<Pool, "query">;

async function scalar(pool: Queryable, sql: string): Promise<unknown> {
  try {
    const { rows } = await pool.query(sql);
    return (rows[0] as Record<string, unknown> | undefined)?.v;
  } catch {
    // Fails closed, but under its own id so ops can tell "database down" from
    // "misconfigured". The driver's message can carry the host or user; the
    // rule id is enough.
    throw new StartupGuardError("DB-UNAVAILABLE");
  }
}

/** OPS-1: `session_user` on the platform_ops pool is exactly `platform_ops`. */
export async function assertPlatformOpsSession(pool: Queryable): Promise<void> {
  if ((await scalar(pool, "SELECT session_user::text AS v")) !== "platform_ops") throw new StartupGuardError("OPS-1");
}

/**
 * OPS-2: the runner login is neither a superuser nor able to bypass row-level
 * security, by any route: as `session_user`, as `current_user` (a connection
 * string's `options=-c role=...` changes only the latter), or through
 * membership in a role that is. A missing role row counts as unsafe, and so
 * does any answer but a plain false.
 */
export const OPS2_UNSAFE_SQL = `SELECT (
  COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = session_user), true)
  OR COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), true)
  OR EXISTS (SELECT 1 FROM pg_roles r WHERE (r.rolsuper OR r.rolbypassrls)
             AND (pg_has_role(session_user, r.oid, 'MEMBER') OR pg_has_role(current_user, r.oid, 'MEMBER')))
) AS v`;

export async function assertRunnerLoginNotSuperuser(pool: Queryable): Promise<void> {
  if ((await scalar(pool, OPS2_UNSAFE_SQL)) !== false) throw new StartupGuardError("OPS-2");
}

/** OPS-5: the runner login has the privileges of `app_user` AND `agent_run_writer` without SET ROLE (USAGE, not mere MEMBER: the runner never runs SET ROLE, so a NOINHERIT grant would not help it) (a plain true; anything else, a missing role included, refuses). */
export async function assertRunnerLoginRoles(pool: Queryable): Promise<void> {
  const ok = await scalar(pool, "SELECT (pg_has_role(session_user, 'app_user', 'USAGE') AND pg_has_role(session_user, 'agent_run_writer', 'USAGE')) AS v");
  if (ok !== true) throw new StartupGuardError("OPS-5");
}

/**
 * OPS-4 / CARRY-7, part 1: no role is a member of `platform_ops` except the
 * database owner (`pg_database.datdba`).
 *
 * The owner is the one exception because the migrations leave it in: on a
 * hosted database the owner is not a superuser, so the role that creates
 * `platform_ops` is given the ADMIN option by the host's own superuser (which
 * the owner cannot revoke, and the migrations need), and the migrations then
 * keep a self grant (INHERIT FALSE, SET TRUE) to re-own functions. Both rows
 * name the owner. `IS DISTINCT FROM` so a missing owner row counts every row
 * (fails closed) instead of comparing to NULL and counting none.
 */
export const OPS4_STRAY_MEMBERS_SQL = `SELECT count(*)::int AS v FROM pg_auth_members m
  WHERE m.roleid = 'platform_ops'::regrole
    AND m.member IS DISTINCT FROM (SELECT datdba FROM pg_database WHERE datname = current_database())`;

/**
 * OPS-4 / CARRY-7, part 2, run as the runner login: it holds no `platform_ops`
 * privileges, as `session_user` or `current_user` (a connection string's
 * `options=-c role=...` changes only the latter), directly or through any role
 * it is a member of (MEMBER is true for any direct or indirect membership,
 * whatever INHERIT or SET say), and it is not the database owner. The owner
 * may be a member of `platform_ops`, so a runtime login that is the owner, or
 * a member of the owner, would hold it. Anything but a plain false refuses.
 */
export const OPS4_RUNTIME_HOLDS_SQL = `SELECT (
  pg_has_role(session_user, 'platform_ops', 'MEMBER')
  OR pg_has_role(current_user, 'platform_ops', 'MEMBER')
  OR session_user::regrole::oid IS NOT DISTINCT FROM (SELECT datdba FROM pg_database WHERE datname = current_database())
  OR current_user::regrole::oid IS NOT DISTINCT FROM (SELECT datdba FROM pg_database WHERE datname = current_database())
) AS v`;

/**
 * OPS-4 / CARRY-7: no login the app or worker connects with holds
 * `platform_ops`, except the platform_ops pool's own login (OPS-1 pins that
 * to `platform_ops` itself). Part 1 runs on the platform_ops pool, part 2 on
 * the runner pool.
 */
export async function assertPlatformOpsHasNoMembers(platformOpsPool: Queryable, runnerPool: Queryable): Promise<void> {
  if ((await scalar(platformOpsPool, OPS4_STRAY_MEMBERS_SQL)) !== 0) throw new StartupGuardError("OPS-4");
  if ((await scalar(runnerPool, OPS4_RUNTIME_HOLDS_SQL)) !== false) throw new StartupGuardError("OPS-4");
}

/**
 * The other runtime database URLs the web app connects with, beyond the two the worker
 * pools use. Each is checked when set (blank counts as unset): `DATABASE_URL_APP_USER` and
 * `DATABASE_URL_GH_PROXY` must not log in as the owner or hold `platform_ops`;
 * `DATABASE_URL_EVENTS_LISTEN` is meant to be the platform_ops login, so it must satisfy
 * OPS-1 instead. Not listed, on purpose: `DATABASE_URL_UNPOOLED` (the build-time migration
 * login, which is the owner by design and is never a runtime connection) and the tooling-only
 * `DATABASE_URL` / `BENCH_*` URLs.
 */
export const APP_USER_ENV = "DATABASE_URL_APP_USER";
export const EVENTS_LISTEN_ENV = "DATABASE_URL_EVENTS_LISTEN";
export const GH_PROXY_ENV = "DATABASE_URL_GH_PROXY";

/**
 * OPS-4, part 3: the same test as part 2 on each other runtime URL that is set, through a
 * short-lived pool closed on success and on refusal. An unreachable URL gives
 * DB-UNAVAILABLE (inside `scalar`), never a pass; a URL a pool cannot be built from is CONFIG.
 */
export async function assertOtherRuntimeUrlsHoldNothing(
  env: Readonly<Record<string, string | undefined>>,
  makePool: (connectionString: string) => Pool,
): Promise<void> {
  const checks: Array<[string, (pool: Queryable) => Promise<void>]> = [
    [APP_USER_ENV, assertRuntimeLoginHoldsNoPlatformOps],
    [EVENTS_LISTEN_ENV, assertEventsLoginIsPlatformOps],
    [GH_PROXY_ENV, assertRuntimeLoginHoldsNoPlatformOps],
  ];
  for (const [name, check] of checks) {
    const url = env[name]?.trim();
    if (!url) continue;
    let pool: Pool;
    try {
      pool = makePool(url);
    } catch {
      throw new StartupGuardError("CONFIG");
    }
    try {
      await check(pool);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
}

/** What OPS-1 requires of the platform_ops pool, refused here under OPS-4: the events login is exactly `platform_ops`, so never the owner. */
async function assertEventsLoginIsPlatformOps(pool: Queryable): Promise<void> {
  if ((await scalar(pool, "SELECT session_user::text AS v")) !== "platform_ops") throw new StartupGuardError("OPS-4");
}

async function assertRuntimeLoginHoldsNoPlatformOps(pool: Queryable): Promise<void> {
  if ((await scalar(pool, OPS4_RUNTIME_HOLDS_SQL)) !== false) throw new StartupGuardError("OPS-4");
}

/** Package-private: the compositionRoot builds these and never hands them out. */
export interface WorkerPools {
  /** The runner login: the only pool that may write `agent_runs`. */
  runnerPool: Pool;
  platformOpsPool: Pool;
  close(): Promise<void>;
}

export interface CreateWorkerPoolsDeps {
  /** Test seam; defaults to `pg`'s pool. */
  makePool?: (connectionString: string) => Pool;
}

/** Builds both pools from `env` and runs every guard; on any refusal the pools are closed and the guard error thrown. */
export async function createWorkerPools(
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateWorkerPoolsDeps = {},
): Promise<WorkerPools> {
  const runnerUrl = env[RUNNER_LOGIN_ENV];
  const opsUrl = env[PLATFORM_OPS_ENV];
  if (!runnerUrl || !opsUrl) throw new StartupGuardError("CONFIG");
  const makePool = deps.makePool ?? ((url: string) => createPool(url));
  const runnerPool = makePool(runnerUrl);
  let platformOpsPool: Pool;
  try {
    platformOpsPool = makePool(opsUrl);
  } catch {
    await runnerPool.end().catch(() => undefined);
    throw new StartupGuardError("CONFIG");
  }
  const close = async (): Promise<void> => {
    await Promise.allSettled([runnerPool.end(), platformOpsPool.end()]);
  };
  try {
    await assertPlatformOpsSession(platformOpsPool);
    await assertRunnerLoginNotSuperuser(runnerPool);
    await assertRunnerLoginRoles(runnerPool);
    await assertPlatformOpsHasNoMembers(platformOpsPool, runnerPool);
    await assertOtherRuntimeUrlsHoldNothing(env, makePool);
  } catch (err) {
    await close();
    throw err;
  }
  return { runnerPool, platformOpsPool, close };
}
