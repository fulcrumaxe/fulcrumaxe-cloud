import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { NextRequest } from "../../../apps/web/node_modules/next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { raiseAskMarked } from "@fx/core/src/decisions/raiseAskMarked.js";
import { setPendingHooks } from "@fx/core/src/pendingWork";
import { runAskWindowTick } from "../src/askWindowTick.js";
// The real cron handler and its fake of the Runtime Cache live in apps/web; their imports resolve from there.
import { makeRegion, storeOf, type FakeRegion } from "../../../apps/web/test/support/runtimeCacheFake";
import { COVER_MS, invariantSweepHandler, type InvariantSweepHandlerDeps } from "../../../apps/web/app/api/cron/invariant-sweep/handler";

/**
 * [pg] ASK-WIRE-1: an ask whose answer window has ended is acted on by the REAL cron handler through the REAL no-database gate, with nothing
 * calling the sweep directly. The ask is raised through the real raise path (which writes the marker), the window then ends, and the next tick
 * must open the gate on that marker, move the ask to `proceeded` and request its resume, then store the next window end as the new marker.
 * The worker here is the ask half of the real tick (`runAskWindowTick`) on a real receipt login; the run-writer half of the invariant sweep has
 * its own tests and is a no-op count here.
 */
const SECRET = "test-cron-secret";
const INVOKER_LOGIN = "fx_ask_cron_test";
const KEY = "pending:invariant-sweep";
const OPTIONS = [{ id: "apply", label: "Apply the change" }, { id: "skip", label: "Skip it" }];
const clock = { value: Date.now() };

describe("an ask window that ends on a quiet account is acted on by the cron [pg]", () => {
  let admin: Pool;
  let seeder: PoolClient;
  let receiptPool: Pool;
  let region: FakeRegion;
  let a: SeedRefs;

  beforeAll(async () => {
    admin = createPool(process.env.WORKER_DATABASE_URL!);
    seeder = await admin.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
  }, 180_000);
  afterAll(async () => {
    seeder?.release();
    for (const p of [receiptPool, admin]) await p?.end();
  });

  beforeEach(async () => {
    clock.value = Date.now();
    region = makeRegion(clock);
    setPendingHooks({ store: storeOf(region) });
    await admin.query("DELETE FROM run_action_requests");
    await admin.query("DELETE FROM decision_asks");
    a = await seedAccount(seeder, randomUUID());
  });
  afterEach(() => {
    setPendingHooks(null);
    vi.restoreAllMocks();
  });

  const marker = (): number | null => {
    const e = region.entries.get(KEY);
    return e ? (JSON.parse(e.json) as number) : null;
  };
  const raise = (minutes: number, onTimeout: "proceed_recommended" | "stop_and_flag"): Promise<string> =>
    withTenant(receiptPool, a.accountId, (c) => raiseAskMarked(c, {
      class: "human_over_the_loop", decisionType: "test_strategy_choice", workItemId: a.workItemId, runId: a.runId, options: OPTIONS, proposed: "apply",
      rationale: "because", quotedInputs: [{ trust: "trusted", storedBody: "x" }], policy: { answerWindowMinutes: minutes, onTimeout },
    }));
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
  const stateOf = async (id: string): Promise<string> => (await admin.query<{ state: string }>("SELECT state FROM decision_asks WHERE id = $1", [id])).rows[0]!.state;
  const dueOf = async (id: string): Promise<number> => (await admin.query<{ d: Date }>("SELECT answer_due_at AS d FROM decision_asks WHERE id = $1", [id])).rows[0]!.d.getTime();
  const resumes = async (id: string) => (await admin.query("SELECT 1 FROM run_action_requests WHERE kind = 'resume_decision' AND target_id = $1", [id])).rows;

  function setup() {
    const sweepInvariants = vi.fn(async () => ({ checked: 0, raised: {}, failed: 0, ...(await runAskWindowTick({ pool: receiptPool, warn: () => undefined })) }));
    const getWorker = vi.fn(async () => ({ sweepInvariants }));
    const deps: InvariantSweepHandlerDeps = { cronSecret: SECRET, getWorker, log: () => undefined, sleep: async () => undefined, paused: () => false, now: () => clock.value };
    // A recent last-connect at the tick time, so the backstop is never what opens the gate: only the marker can.
    const tick = () => (region.entries.set("lastrun:invariant-sweep", { json: JSON.stringify(clock.value), expiresAt: clock.value + 3_600_000 }), invariantSweepHandler(new NextRequest("https://example.test/api/cron/invariant-sweep", { method: "GET", headers: { authorization: `Bearer ${SECRET}` } }), deps));
    return { getWorker, tick };
  }
  /** The window ended two days ago in the database. The guard freezes both columns, so it is bypassed for this one admin statement only. */
  async function endWindow(id: string): Promise<void> {
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

  it("raising the ask dates the marker at the window end; the cron skips until then, and the first tick after it moves the ask and requests the resume", async () => {
    const id = await raise(20, "proceed_recommended");
    await settle();
    const due = await dueOf(id);
    expect(marker()).toBe(due);

    const s = setup();
    // Before the window ends: both passes end at the gate and open no connection.
    clock.value = due - 60_000;
    expect(await (await s.tick()).json()).toEqual({ configured: true, passes: [{ skipped: true }, { skipped: true }] });
    expect(s.getWorker).not.toHaveBeenCalled();
    expect(await stateOf(id)).toBe("open");

    // The window has ended (the database's copy of the time is moved back so the real clock agrees), and nothing else happened on the account.
    await endWindow(id);
    clock.value = due + 1_000;
    const res = await s.tick();
    expect(res.status).toBe(200);
    expect(s.getWorker).toHaveBeenCalled();
    expect(await stateOf(id)).toBe("proceeded");
    expect(await resumes(id)).toHaveLength(1);
    // The marker holds the window end for the handler's short cover after a completion; nothing else is open, so once it lapses no marker is left to wake the database again.
    clock.value = due + COVER_MS + 1_000;
    await s.tick();
    expect(marker()).toBeNull();
  });

  it("two asks: after the first window ends the marker moves to the second, which is then acted on too", async () => {
    const first = await raise(20, "proceed_recommended");
    const second = await raise(90, "stop_and_flag");
    await settle();
    const [d1, d2] = [await dueOf(first), await dueOf(second)];
    expect(marker()).toBe(d1);
    expect(d2).toBeGreaterThan(d1);

    const s = setup();
    await endWindow(first);
    clock.value = d1 + 1_000;
    await s.tick();
    expect(await stateOf(first)).toBe("proceeded");
    expect(await stateOf(second)).toBe("open");
    // The marker still holds the first window end, which the handler treats as a fresh completion and keeps for a short cover; the first tick after the cover hands it on.
    clock.value = d1 + COVER_MS + 1_000;
    await s.tick();
    expect(marker()).toBe(d2);

    await endWindow(second);
    clock.value = d2 + 1_000;
    await s.tick();
    expect(await stateOf(second)).toBe("overdue");
    clock.value = d2 + COVER_MS + 1_000;
    await s.tick();
    expect(marker()).toBeNull();
  });
});
