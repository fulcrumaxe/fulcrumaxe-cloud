import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { getWorkItemActivity } from "@fx/core/src/work-items/activity.js";
import { CONTINUATION_UNKNOWN_SENTENCE, MONTHLY_BUDGET_PARK_SENTENCE, MONTHLY_BUDGET_PARKED_STOP, RUN_LIMIT_PARKED_STOP, RUN_LIMIT_PARK_SENTENCE, continuationStopSentence } from "@fx/core/src/work-items/continuationStops.js";
import { REFUSED_BY_CODES } from "@fx/pipeline";

/** [pg] D#2 H14c-3-3b-2 (C88 section 3): each stop code of a build parked at a run limit shows its fixed sentence on the work item's activity read, and nothing else. */
describe("the card sentences for a build parked at a run limit [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  async function parkedItem(): Promise<SeedRefs> {
    const a = await seedAccount(admin, randomUUID());
    await withTenant(writerPool, a.accountId, async (c) => {
      for (const toStage of ["spec_ready", "in_progress", "needs_human"] as const) await recordStage(c, { workItemId: a.workItemId, toStage, at: new Date(), source: "control_plane", sourceRef: `seed-${toStage}` });
    });
    // The executor's own summary must never reach these sentences.
    await admin.query("UPDATE agent_runs SET status = 'timed_out', envelope = $2::jsonb WHERE id = $1", [a.runId, JSON.stringify({ summary: "SECRET-RUN-TEXT" })]);
    return a;
  }
  async function stop(a: SeedRefs, code: string, reasons: string[]): Promise<void> {
    await withTenant(writerPool, a.accountId, (c) => recordDriverEvent(c, a.accountId, { workItemId: a.workItemId, kind: "stopped", dedupeKey: `build:${a.runId}`, code, reasons, runId: a.runId }));
  }
  const noticeOf = async (a: SeedRefs) => (await getWorkItemActivity({ pool: adminPool, principal: { accountId: a.accountId, userId: a.userId } }, a.workItemId)).notice;

  it("the sentence table has exactly one sentence per refused_by the library can return", () => {
    expect(Object.keys(RUN_LIMIT_PARK_SENTENCE).sort()).toEqual([...REFUSED_BY_CODES].sort());
  });

  it.each([...REFUSED_BY_CODES])("run_limit_parked [%s] shows its own sentence as a Needs a person notice", async (refusedBy) => {
    const a = await parkedItem();
    await stop(a, RUN_LIMIT_PARKED_STOP, [refusedBy]);
    expect(await noticeOf(a)).toEqual({ kind: "needs_human", reason: RUN_LIMIT_PARK_SENTENCE[refusedBy] });
  });

  it("monthly_budget_parked shows the monthly budget sentence", async () => {
    const a = await parkedItem();
    await stop(a, MONTHLY_BUDGET_PARKED_STOP, []);
    expect(await noticeOf(a)).toEqual({ kind: "needs_human", reason: MONTHLY_BUDGET_PARK_SENTENCE });
  });

  it("an unknown refused_by, or none, shows \"Needs your attention\": never the raw code, never null or undefined", async () => {
    for (const reasons of [["platform_budget"], []]) {
      const a = await parkedItem();
      await stop(a, RUN_LIMIT_PARKED_STOP, reasons);
      const notice = await noticeOf(a);
      expect(notice).toEqual({ kind: "needs_human", reason: CONTINUATION_UNKNOWN_SENTENCE });
      expect(JSON.stringify(notice)).not.toMatch(/platform_budget|undefined|null|SECRET-RUN-TEXT/);
    }
  });

  it("none of the sentences holds a raw code, a button name, a placeholder or anything of the run", () => {
    for (const sentence of [...Object.values(RUN_LIMIT_PARK_SENTENCE), MONTHLY_BUDGET_PARK_SENTENCE, CONTINUATION_UNKNOWN_SENTENCE]) {
      expect(sentence).not.toMatch(/[a-z]+_[a-z_]+|undefined|null|\{|\}|Continue|Retry/);
    }
    expect(continuationStopSentence("run_limit_parked", ["constructor"])).toBe(CONTINUATION_UNKNOWN_SENTENCE); // a name from Object.prototype is not a code
    expect(continuationStopSentence("build_run_timed_out", ["spend"])).toBeNull();
    expect(continuationStopSentence(null, null)).toBeNull();
  });
});
