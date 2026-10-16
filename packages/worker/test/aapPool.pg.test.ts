import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { PLATFORM_OPS_ENV, StartupGuardError, createWorkerPools } from "../src/pools.js";
import { purgeAap } from "../src/aapPurge.js";
import { RUNNER_LOGIN_NAME } from "./support/scanRunnerLoginReaders.js";
import { RECEIPT_LOGIN_NAME } from "./support/scanReceiptLoginReaders.js";

/**
 * [pg] AAP-d1-ii: the approval-request login checks against real logins with real memberships. AAP-1 only flags (a worker without the grant still
 * starts, and says so on every tick); AAP-2 refuses a runner login that is a member of aap_invoker. The purge is run for real as a member and as a
 * non-member, so the "not permitted" line is what a missing grant actually produces.
 */
describe("approval-request logins [pg]", () => {
  let admin: Pool;
  const pools: Pool[] = [];

  const urlOf = (user: string): string => {
    const u = new URL(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    u.username = user;
    u.password = "";
    return u.toString();
  };
  async function login(name: string, memberships: readonly string[]): Promise<string> {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS INHERIT; END IF; END $$`);
    await admin.query(`GRANT ${memberships.join(", ")} TO ${name}`);
    return name;
  }
  const env = (receiptUser: string, runnerUrl = process.env.WORKER_DATABASE_URL_RUN_WRITER!): Record<string, string> => ({
    [RUNNER_LOGIN_NAME]: runnerUrl,
    [PLATFORM_OPS_ENV]: process.env.WORKER_DATABASE_URL_PLATFORM_OPS!,
    [RECEIPT_LOGIN_NAME]: urlOf(receiptUser),
  });

  beforeAll(async () => {
    admin = createPool(process.env.WORKER_DATABASE_URL!);
  });
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    await admin.end();
  });

  it("a receipt login that is a member of aap_sweeper starts ready, and the purge runs for real", async () => {
    const user = await login("fx_aap1_member", ["app_user", "receipt_writer_invoker", "aap_sweeper"]);
    const started = await createWorkerPools(env(user));
    try {
      expect(started.aapReady).toBe(true);
      const lines: string[] = [];
      const result = await purgeAap({ pool: started.receiptPool, ready: started.aapReady, warn: (l) => lines.push(l) });
      expect(result.failed).toBe(false);
      expect(lines.every((l) => JSON.parse(l).event === "aap.purged")).toBe(true);
    } finally {
      await started.close();
    }
  });

  it("without the grant the worker still starts, aapReady is false, and every tick says so without calling the database", async () => {
    const user = await login("fx_aap1_missing", ["app_user", "receipt_writer_invoker"]);
    const started = await createWorkerPools(env(user));
    try {
      expect(started.aapReady).toBe(false);
      const lines: string[] = [];
      for (let tick = 0; tick < 2; tick++) {
        expect((await purgeAap({ pool: started.receiptPool, ready: started.aapReady, warn: (l) => lines.push(l) })).failed).toBe(true);
      }
      expect(lines.map((l) => JSON.parse(l).event)).toEqual(["aap.purge_blocked_no_membership", "aap.purge_blocked_no_membership"]);
      // Had the check not run, the real database refuses by privilege, which has its own fixed line.
      const direct: string[] = [];
      await purgeAap({ pool: started.receiptPool, warn: (l) => direct.push(l) });
      expect(direct.map((l) => JSON.parse(l).event)).toEqual(["aap.purge_not_permitted"]);
      expect(direct.join("")).not.toMatch(/fx_aap1_missing|postgres:|@|127\.0\.0\.1/);
    } finally {
      await started.close();
    }
  });

  it("AAP-2: a runner login that is a member of aap_invoker or aap_sweeper is refused, naming the rule only", async () => {
    const good = await login("fx_aap2_receipt", ["app_user", "receipt_writer_invoker", "aap_sweeper"]);
    for (const role of ["aap_invoker", "aap_sweeper"]) {
      const runner = await login(`fx_aap2_runner_${role}`, ["app_user", "agent_run_writer", role]);
      const err = await createWorkerPools(env(good, urlOf(runner))).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, role).toBeInstanceOf(StartupGuardError);
      expect((err as StartupGuardError).rule, role).toBe("AAP-2");
      expect((err as StartupGuardError).message).not.toMatch(/fx_aap2|postgres:|@|127\.0\.0\.1/);
    }
  });
});
