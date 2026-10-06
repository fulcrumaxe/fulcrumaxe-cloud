import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import {
  PLATFORM_OPS_ENV,
  StartupGuardError,
  assertRunnerLoginRoles,
  assertPlatformOpsHasNoMembers,
  assertPlatformOpsSession,
  assertRunnerLoginNotSuperuser,
  OPS2_UNSAFE_SQL,
  createWorkerPools,
} from "../src/pools.js";
import { RUNNER_LOGIN_NAME } from "./support/scanRunnerLoginReaders.js";

const RUNNER_URL = "postgres://runner-user:runner-secret-pw@db.internal:5432/app";
const OPS_URL = "postgres://ops-user:ops-secret-pw@db.internal:5432/app";

type Answers = { sessionUser: string; rolsuper: boolean; members: number; roles?: boolean; holds?: boolean };

/** A pool that answers the three guard queries from `answers`, by the SQL it is sent. */
function fakePool(answers: Answers, ended: string[] = [], name = "pool"): Pool {
  return {
    async query(sql: string) {
      if (/session_user::text/.test(sql)) return { rows: [{ v: answers.sessionUser }] };
      if (/rolsuper/.test(sql)) return { rows: [{ v: answers.rolsuper }] };
      if (/'platform_ops', 'MEMBER'/.test(sql)) return { rows: [{ v: answers.holds ?? false }] };
      if (/pg_auth_members/.test(sql)) return { rows: [{ v: answers.members }] };
      if (/pg_has_role\(session_user, 'app_user'/.test(sql)) return { rows: [{ v: answers.roles ?? true }] };
      throw new Error(`unexpected sql: ${sql}`);
    },
    async end() {
      ended.push(name);
    },
  } as unknown as Pool;
}

const GOOD: Answers = { sessionUser: "platform_ops", rolsuper: false, members: 0 };
const ENV = { [RUNNER_LOGIN_NAME]: RUNNER_URL, [PLATFORM_OPS_ENV]: OPS_URL };

async function refusal(promise: Promise<unknown>): Promise<StartupGuardError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StartupGuardError);
  return err as StartupGuardError;
}

describe("OPS-1: the platform_ops pool connects as exactly platform_ops", () => {
  it("passes for platform_ops", async () => {
    await expect(assertPlatformOpsSession(fakePool(GOOD))).resolves.toBeUndefined();
  });

  it("refuses a login that is only a member of platform_ops", async () => {
    const err = await refusal(assertPlatformOpsSession(fakePool({ ...GOOD, sessionUser: "some_member_login" })));
    expect(err.rule).toBe("OPS-1");
  });
});

describe("OPS-2: the runner login is not a superuser", () => {
  it("passes when rolsuper is false", async () => {
    await expect(assertRunnerLoginNotSuperuser(fakePool(GOOD))).resolves.toBeUndefined();
  });

  it("refuses a superuser, and a login whose role row cannot be read", async () => {
    expect((await refusal(assertRunnerLoginNotSuperuser(fakePool({ ...GOOD, rolsuper: true })))).rule).toBe("OPS-2");
    const noRow = { query: async () => ({ rows: [] }) } as unknown as Pool;
    expect((await refusal(assertRunnerLoginNotSuperuser(noRow))).rule).toBe("OPS-2");
  });
});

describe("OPS-2 covers every route to superuser or RLS bypass, and fails closed", () => {
  it("the check asks about session_user, current_user, rolbypassrls and membership in such a role", () => {
    const sql = OPS2_UNSAFE_SQL;
    expect(sql).toMatch(/rolname = session_user/);
    expect(sql).toMatch(/rolname = current_user/);
    expect(sql).toMatch(/rolsuper OR rolbypassrls/);
    expect(sql).toMatch(/pg_has_role\(session_user, r\.oid, 'MEMBER'\)/);
    expect(sql).toMatch(/pg_has_role\(current_user, r\.oid, 'MEMBER'\)/);
    // A missing role row must read as unsafe, not as "not a superuser".
    expect(sql.match(/COALESCE\(/g)).toHaveLength(2);
    expect(sql.match(/, true\)/g)).toHaveLength(2);
  });

  it("anything but a plain false refuses: true, null, undefined, a string", async () => {
    for (const v of [true, null, undefined, "f", 0]) {
      const pool = { query: async () => ({ rows: [{ v }] }) } as unknown as Pool;
      expect((await refusal(assertRunnerLoginNotSuperuser(pool))).rule).toBe("OPS-2");
    }
    expect((await refusal(assertRunnerLoginNotSuperuser({ query: async () => ({ rows: [] }) } as unknown as Pool))).rule).toBe("OPS-2");
  });
});

describe("OPS-4 / CARRY-7: no runtime login holds platform_ops (fake pools)", () => {
  it("passes with no stray member and a clean runner login", async () => {
    await expect(assertPlatformOpsHasNoMembers(fakePool(GOOD), fakePool(GOOD))).resolves.toBeUndefined();
  });

  it("refuses any stray member, naming the rule and no connection string", async () => {
    const err = await refusal(assertPlatformOpsHasNoMembers(fakePool({ ...GOOD, members: 1 }), fakePool(GOOD)));
    expect(err.rule).toBe("OPS-4");
    expect(err.message).toContain("OPS-4");
    expect(err.message).toContain("never grant any other role membership in platform_ops");
    expect(err.message).not.toMatch(/postgres:|secret-pw|db\.internal/);
  });

  it("refuses a runner login that holds platform_ops or is the database owner (the runner pool's answer), even with no stray member row", async () => {
    const err = await refusal(assertPlatformOpsHasNoMembers(fakePool(GOOD), fakePool({ ...GOOD, holds: true })));
    expect(err.rule).toBe("OPS-4");
    for (const v of [null, undefined, "f", 0]) {
      const odd = { query: async () => ({ rows: [{ v }] }) } as unknown as Pool;
      expect((await refusal(assertPlatformOpsHasNoMembers(fakePool(GOOD), odd))).rule).toBe("OPS-4");
    }
  });

  it("a failing query is a refusal too, and the driver's text (host, user) does not leak", async () => {
    const broken = {
      query: async () => {
        throw new Error("connect ECONNREFUSED db.internal:5432 for ops-user secret-pw");
      },
    } as unknown as Pool;
    const err = await refusal(assertPlatformOpsHasNoMembers(broken, broken));
    expect(err.message).not.toMatch(/db\.internal|ops-user|secret-pw/);
    expect(err.cause).toBeUndefined();
  });

  it("a database that cannot be reached has its own rule id on every guard, distinct from a misconfiguration verdict", async () => {
    const down = {
      query: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    } as unknown as Pool;
    for (const guard of [assertPlatformOpsSession, assertRunnerLoginNotSuperuser, (p: Pool) => assertPlatformOpsHasNoMembers(p, p)]) {
      const err = await refusal(guard(down));
      expect(err.rule).toBe("DB-UNAVAILABLE");
    }
    // ...including when only the runner pool's half is down.
    expect((await refusal(assertPlatformOpsHasNoMembers(fakePool(GOOD), down))).rule).toBe("DB-UNAVAILABLE");
    // ...while a reachable database with a bad answer still names the rule that failed.
    expect((await refusal(assertPlatformOpsHasNoMembers(fakePool({ ...GOOD, members: 3 }), fakePool(GOOD)))).rule).toBe("OPS-4");
  });
});

describe("createWorkerPools", () => {
  it("returns both pools once every guard passes, built from the two variables", async () => {
    const urls: string[] = [];
    const pools = await createWorkerPools(ENV, {
      makePool: (url) => {
        urls.push(url);
        return fakePool(GOOD);
      },
    });
    expect(urls).toEqual([RUNNER_URL, OPS_URL]);
    expect(pools.runnerPool).not.toBe(pools.platformOpsPool);
  });

  it("refuses and closes both pools when a guard fails", async () => {
    const ended: string[] = [];
    let n = 0;
    const err = await refusal(
      createWorkerPools(ENV, { makePool: () => fakePool({ ...GOOD, members: 2 }, ended, `p${n++}`) }),
    );
    expect(err.rule).toBe("OPS-4");
    expect(ended.sort()).toEqual(["p0", "p1"]);
  });

  it("closes the first pool when the second cannot be built", async () => {
    const ended: string[] = [];
    let n = 0;
    const err = await refusal(
      createWorkerPools(ENV, {
        makePool: () => {
          if (n++ === 1) throw new Error(`bad url ${OPS_URL}`);
          return fakePool(GOOD, ended, "first");
        },
      }),
    );
    expect(err.rule).toBe("CONFIG");
    expect(err.message).not.toContain("secret-pw");
    expect(ended).toEqual(["first"]);
  });

  it("refuses a missing variable without naming a value", async () => {
    const err = await refusal(createWorkerPools({ [PLATFORM_OPS_ENV]: OPS_URL }, { makePool: () => fakePool(GOOD) }));
    expect(err.rule).toBe("CONFIG");
    expect(err.message).not.toContain(OPS_URL);
  });
});

describe("OPS-5: the runner login is a member of app_user and agent_run_writer", () => {
  it("passes on a plain true; refuses a false, a null and a missing answer, naming the rule only", async () => {
    await expect(assertRunnerLoginRoles(fakePool(GOOD))).resolves.toBeUndefined();
    expect((await refusal(assertRunnerLoginRoles(fakePool({ ...GOOD, roles: false })))).rule).toBe("OPS-5");
    for (const v of [null, undefined, "t", 1]) {
      expect((await refusal(assertRunnerLoginRoles({ query: async () => ({ rows: [{ v }] }) } as unknown as Pool))).rule).toBe("OPS-5");
    }
    const err = await refusal(assertRunnerLoginRoles(fakePool({ ...GOOD, roles: false })));
    expect(err.message).toContain("app_user and agent_run_writer");
  });

  it("createWorkerPools refuses a runner login without the roles, before any run, and closes both pools", async () => {
    const ended: string[] = [];
    let n = 0;
    const err = await refusal(createWorkerPools(ENV, { makePool: () => fakePool({ ...GOOD, roles: false }, ended, `p${n++}`) }));
    expect(err.rule).toBe("OPS-5");
    expect(ended.sort()).toEqual(["p0", "p1"]);
  });
});

describe("OPS-5 [pg]: against real logins", () => {
  let admin: Pool;
  const pools: Pool[] = [];
  const loginUrl = (user: string): string => {
    const u = new URL(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    u.username = user;
    u.password = "";
    return u.toString();
  };
  const poolFor = (user: string): Pool => {
    const p = createPool(loginUrl(user));
    pools.push(p);
    return p;
  };

  beforeAll(async () => {
    admin = createPool(process.env.WORKER_DATABASE_URL!);
    for (const [name, members, inherit] of [
      ["fx_ops5_app_only", ["app_user"], "INHERIT"],
      ["fx_ops5_writer_only", ["agent_run_writer"], "INHERIT"],
      ["fx_ops5_noinherit", ["app_user", "agent_run_writer"], "NOINHERIT"],
    ] as const) {
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS ${inherit}; END IF; END $$`);
      await admin.query(`GRANT ${members.join(", ")} TO ${name}`);
    }
  });
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    await admin.end();
  });

  it("the real runner login (both roles) passes", async () => {
    const real = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    pools.push(real);
    await expect(assertRunnerLoginRoles(real)).resolves.toBeUndefined();
  });

  it("a login that is only an app_user member is refused", async () => {
    expect((await refusal(assertRunnerLoginRoles(poolFor("fx_ops5_app_only")))).rule).toBe("OPS-5");
  });

  it("a login that is a member of both but with NOINHERIT is refused: the runner never runs SET ROLE, so it would have neither role's privileges", async () => {
    expect((await refusal(assertRunnerLoginRoles(poolFor("fx_ops5_noinherit")))).rule).toBe("OPS-5");
  });

  it("a login that is only an agent_run_writer member is refused", async () => {
    expect((await refusal(assertRunnerLoginRoles(poolFor("fx_ops5_writer_only")))).rule).toBe("OPS-5");
  });
});
