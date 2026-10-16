import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import {
  PLATFORM_OPS_ENV,
  StartupGuardError,
  assertReceiptLoginIsolated,
  assertReceiptLoginRoles,
  assertRunnerLoginCannotWriteReceipts,
  createWorkerPools,
} from "../src/pools.js";
import { RUNNER_LOGIN_NAME } from "./support/scanRunnerLoginReaders.js";
import { RECEIPT_LOGIN_NAME } from "./support/scanReceiptLoginReaders.js";

/**
 * [pg] D#7 DP4b-1 (R-7-DP4b-5): the receipt-login startup guards RCPT-1, RCPT-2 and RCPT-3 against real logins with real role memberships, and the
 * whole `createWorkerPools` start with them. Each refusal names its rule and nothing else: no URL, no user name.
 */
describe("receipt login startup guards [pg]", () => {
  let admin: Pool;
  const pools: Pool[] = [];
  const created: string[] = [];

  /** The URL of login `user` on the test cluster (these test logins have no password; the cluster trusts the loopback). */
  const urlOf = (user: string): string => {
    const u = new URL(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    u.username = user;
    u.password = "";
    return u.toString();
  };
  const poolFor = (user: string): Pool => {
    const p = createPool(urlOf(user));
    pools.push(p);
    return p;
  };

  /** Creates `name` with `attrs` and the given memberships. */
  async function login(name: string, memberships: readonly string[], attrs = "NOSUPERUSER NOBYPASSRLS INHERIT"): Promise<string> {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${name} LOGIN ${attrs}; END IF; END $$`);
    await admin.query(`ALTER ROLE ${name} ${attrs}`);
    if (memberships.length > 0) await admin.query(`GRANT ${memberships.join(", ")} TO ${name}`);
    created.push(name);
    return name;
  }

  const GOOD = "fx_rcpt_good";
  const ENV = (receiptUser: string, runnerUrl = process.env.WORKER_DATABASE_URL_RUN_WRITER!): Record<string, string> => ({
    [RUNNER_LOGIN_NAME]: runnerUrl,
    [PLATFORM_OPS_ENV]: process.env.WORKER_DATABASE_URL_PLATFORM_OPS!,
    [RECEIPT_LOGIN_NAME]: urlOf(receiptUser),
  });

  async function refusal(promise: Promise<unknown>): Promise<StartupGuardError> {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StartupGuardError);
    return err as StartupGuardError;
  }

  beforeAll(async () => {
    admin = createPool(process.env.WORKER_DATABASE_URL!);
    await login(GOOD, ["app_user", "receipt_writer_invoker"]);
  });
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    await admin.end();
  });

  it("the production shape (a member of app_user and receipt_writer_invoker, nothing else) passes all three guards and the whole start", async () => {
    await expect(assertReceiptLoginRoles(poolFor(GOOD))).resolves.toBeUndefined();
    await expect(assertReceiptLoginIsolated(poolFor(GOOD))).resolves.toBeUndefined();
    await expect(assertRunnerLoginCannotWriteReceipts(createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!))).resolves.toBeUndefined();
    const started = await createWorkerPools(ENV(GOOD));
    try {
      expect(started.receiptPool).not.toBe(started.runnerPool);
      const { rows } = await started.receiptPool.query<{ u: string }>("SELECT session_user::text AS u");
      expect(rows[0]!.u).toBe(GOOD);
    } finally {
      await started.close();
    }
  });

  it("RCPT-1: a login missing app_user, missing receipt_writer_invoker, or holding both with NOINHERIT is refused", async () => {
    const onlyApp = await login("fx_rcpt1_app_only", ["app_user"]);
    const onlyInvoker = await login("fx_rcpt1_invoker_only", ["receipt_writer_invoker"]);
    const noInherit = await login("fx_rcpt1_noinherit", ["app_user", "receipt_writer_invoker"], "NOSUPERUSER NOBYPASSRLS NOINHERIT");
    for (const user of [onlyApp, onlyInvoker, noInherit]) {
      expect((await refusal(assertReceiptLoginRoles(poolFor(user)))).rule, user).toBe("RCPT-1");
      const err = await refusal(createWorkerPools(ENV(user)));
      expect(err.rule, user).toBe("RCPT-1");
      expect(err.message).not.toMatch(new RegExp(`${user}|postgres:|@|localhost|127\\.0\\.0\\.1`));
    }
  });

  it("RCPT-2: a superuser or bypassrls login, or one that is a member of agent_run_writer, receipt_writer or platform_ops, is refused", async () => {
    await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fx_rcpt2_bypass_role') THEN CREATE ROLE fx_rcpt2_bypass_role NOLOGIN; END IF; END $$");
    await admin.query("ALTER ROLE fx_rcpt2_bypass_role NOLOGIN BYPASSRLS");
    const cases: [string, readonly string[], string][] = [
      ["fx_rcpt2_bypass", ["app_user", "receipt_writer_invoker"], "NOSUPERUSER BYPASSRLS INHERIT"],
      ["fx_rcpt2_super", ["app_user", "receipt_writer_invoker"], "SUPERUSER INHERIT"],
      ["fx_rcpt2_via_bypass_role", ["app_user", "receipt_writer_invoker", "fx_rcpt2_bypass_role"], "NOSUPERUSER NOBYPASSRLS INHERIT"],
      ["fx_rcpt2_run_writer", ["app_user", "receipt_writer_invoker", "agent_run_writer"], "NOSUPERUSER NOBYPASSRLS INHERIT"],
      ["fx_rcpt2_receipt_writer", ["app_user", "receipt_writer_invoker", "receipt_writer"], "NOSUPERUSER NOBYPASSRLS INHERIT"],
      // Last, and revoked at once: a stray platform_ops member trips OPS-4 for every later start on this cluster.
      ["fx_rcpt2_platform_ops", ["app_user", "receipt_writer_invoker", "platform_ops"], "NOSUPERUSER NOBYPASSRLS INHERIT"],
    ];
    for (const [user, memberships, attrs] of cases) {
      await login(user, memberships, attrs);
      try {
        // RCPT-1 passes for all of them: it is RCPT-2 that refuses.
        await expect(assertReceiptLoginRoles(poolFor(user)), user).resolves.toBeUndefined();
        expect((await refusal(assertReceiptLoginIsolated(poolFor(user)))).rule, user).toBe("RCPT-2");
        const err = await refusal(createWorkerPools(ENV(user)));
        // The platform_ops member is also a stray member OPS-4 sees first; every other case reaches RCPT-2.
        expect(err.rule, user).toBe(user === "fx_rcpt2_platform_ops" ? "OPS-4" : "RCPT-2");
        expect(err.message).not.toMatch(new RegExp(`${user}|postgres:|@|localhost|127\\.0\\.0\\.1`));
      } finally {
        if (user === "fx_rcpt2_platform_ops") await admin.query(`REVOKE platform_ops FROM ${user}`);
      }
    }
  });

  it("RCPT-3: a runner login that is a member of receipt_writer_invoker is refused, naming the rule only", async () => {
    const runner = await login("fx_rcpt3_runner", ["app_user", "agent_run_writer", "receipt_writer_invoker"]);
    await expect(assertRunnerLoginCannotWriteReceipts(poolFor(runner))).rejects.toMatchObject({ rule: "RCPT-3" });
    const err = await refusal(createWorkerPools(ENV(GOOD, urlOf(runner))));
    expect(err.rule).toBe("RCPT-3");
    expect(err.message).not.toMatch(new RegExp(`${runner}|postgres:|@|localhost|127\\.0\\.0\\.1`));
  });

  it("RCPT-3 also catches the membership reached through another role", async () => {
    await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fx_rcpt3_hop') THEN CREATE ROLE fx_rcpt3_hop NOLOGIN; END IF; END $$");
    await admin.query("GRANT receipt_writer_invoker TO fx_rcpt3_hop");
    const runner = await login("fx_rcpt3_hop_runner", ["app_user", "agent_run_writer", "fx_rcpt3_hop"]);
    expect((await refusal(assertRunnerLoginCannotWriteReceipts(poolFor(runner)))).rule).toBe("RCPT-3");
  });

  it("the real runner login of this cluster is not a member of receipt_writer_invoker (the test stand-in matches production)", async () => {
    const { rows } = await admin.query<{ m: boolean }>("SELECT pg_has_role($1, 'receipt_writer_invoker', 'MEMBER') AS m", [new URL(process.env.WORKER_DATABASE_URL_RUN_WRITER!).username]);
    expect(rows[0]!.m).toBe(false);
  });

  it("a database that cannot be reached is DB-UNAVAILABLE on the receipt guards too, with no driver text", async () => {
    const down = { query: async () => { throw new Error("connect ECONNREFUSED db.internal:5432 for receipt-user secret-pw"); } } as unknown as Pool;
    for (const guard of [assertReceiptLoginRoles, assertReceiptLoginIsolated, assertRunnerLoginCannotWriteReceipts]) {
      const err = await refusal(guard(down));
      expect(err.rule).toBe("DB-UNAVAILABLE");
      expect(err.message).not.toMatch(/db\.internal|receipt-user|secret-pw/);
      expect(err.cause).toBeUndefined();
    }
  });
});
