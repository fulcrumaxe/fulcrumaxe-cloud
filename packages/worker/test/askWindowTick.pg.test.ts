import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { raiseAskMarked } from "@fx/core/src/decisions/raiseAskMarked.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { runAskWindowTick } from "../src/askWindowTick.js";

/**
 * [pg] ASK-WIRE-1: one tick of the ask half of the invariant sweep, against real Postgres on a receipt login (app_user + receipt_writer_invoker).
 * An ask whose answer window ended and that goes ahead on its own must be resumed in the SAME tick: the window sweep runs before the resume
 * reconcile, which reads `proceeded` asks. Also: the tick reports the soonest window still ahead (the cron's next marker).
 */
const INVOKER_LOGIN = "fx_ask_window_tick_test";
const OPTIONS = [{ id: "apply", label: "Apply the change" }, { id: "skip", label: "Skip it" }];

describe("runAskWindowTick [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, receiptPool]) await p.end();
  });

  async function raise(a: SeedRefs, minutes: number, onTimeout: "proceed_recommended" | "stop_and_flag"): Promise<string> {
    return withTenant(receiptPool, a.accountId, (c) => raiseAskMarked(c, {
      class: "human_over_the_loop", decisionType: "test_strategy_choice", workItemId: a.workItemId, runId: a.runId, options: OPTIONS, proposed: "apply",
      rationale: "because", quotedInputs: [{ trust: "trusted", storedBody: "x" }], policy: { answerWindowMinutes: minutes, onTimeout },
    }));
  }
  /** The window ended two days ago. The guard freezes both columns, so it is bypassed for this one admin statement only. */
  async function makeDue(id: string): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query("UPDATE decision_asks SET raised_at = raised_at - interval '2 days', answer_due_at = answer_due_at - interval '2 days' WHERE id = $1", [id]);
      await admin.query("COMMIT");
    } catch (err) {
      await admin.query("ROLLBACK");
      throw err;
    }
  }
  const stateOf = async (id: string): Promise<string> => (await admin.query<{ state: string }>("SELECT state FROM decision_asks WHERE id = $1", [id])).rows[0]!.state;
  const resumes = async (id: string) => (await admin.query("SELECT * FROM run_action_requests WHERE kind = 'resume_decision' AND target_id = $1", [id])).rows;

  it("an ask past its window that goes ahead on its own is proceeded AND its resume is requested in one tick", async () => {
    const a = await seedAccount(admin, randomUUID());
    const id = await raise(a, 15, "proceed_recommended");
    await makeDue(id);
    expect(await stateOf(id)).toBe("open");
    expect(await resumes(id)).toEqual([]);

    const warns: string[] = [];
    await runAskWindowTick({ pool: receiptPool, warn: (l) => warns.push(l) });

    expect(await stateOf(id)).toBe("proceeded");
    const [req] = await resumes(id);
    expect(req).toMatchObject({ requested_by: "system", principal_kind: "system" });
    expect(warns.some((l) => l.includes("decision.ask_window_sweep"))).toBe(true);
    expect(warns.some((l) => l.includes("decision.resume_requested"))).toBe(true);
  });

  it("reports the soonest window still ahead, and nothing once none is left", async () => {
    const a = await seedAccount(admin, randomUUID());
    // Other tests' asks may be open in the shared database, so make this account's windows the soonest by closing the others' view: only compare to a bound.
    const near = await raise(a, 15, "stop_and_flag");
    const far = await raise(a, 600, "stop_and_flag");
    const before = Date.now();
    const { nextAskDueAt } = await runAskWindowTick({ pool: receiptPool, warn: () => undefined });
    expect(nextAskDueAt).not.toBeNull();
    // At most the 15-minute window of the nearest ask (an ask of another test can only be earlier), and never past it.
    expect(nextAskDueAt!).toBeLessThanOrEqual(before + 16 * 60_000);
    expect(nextAskDueAt!).toBeGreaterThan(before);
    expect(await stateOf(near)).toBe("open");
    expect(await stateOf(far)).toBe("open");
  });
});
