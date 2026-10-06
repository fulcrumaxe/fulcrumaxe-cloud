import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount } from "../build/helpers/seed.js";
import { runSpecStep, type SpecReadyEvent, type SpecStepDeps } from "../../src/plan/spec.js";
import { discussingItem, FixtureRunner, FixtureWriter } from "./helpers/panelFixtures.js";

const h = pgHarness();
const TEXT = { title: "Rotate the credentials store", body: "Store the secret token on the cloud server.", category: "critical" as const };

/** A regression here is a deadlock, so the bound must turn a hang into a failure. */
const BUDGET_MS = 25_000;

async function withSmallPool(max: number, run: (pool: ReturnType<typeof createPool>) => Promise<void>): Promise<void> {
  const pool = createPool(process.env.PIPELINE_DATABASE_URL_RUN_WRITER!, { max });
  try {
    await run(pool);
  } finally {
    // A hung run leaves clients checked out; do not let `end()` wait on them.
    pool.end().catch(() => {});
  }
}

describe("Spec publish lock on a small connection pool", () => {
  it("pool of 3: 8 distinct items plus a 6-run burst on one item all publish, none hangs, one trigger per item", async () => {
    await withSmallPool(3, async (pool) => {
      const events: SpecReadyEvent[] = [];
      const trigger = async (e: SpecReadyEvent): Promise<void> => {
        events.push(e);
      };
      const mk = async (): Promise<{ deps: SpecStepDeps; workItemId: string }> => {
        const accountId = randomUUID();
        await seedAccount(h.admin, accountId);
        const { workItemId } = await discussingItem(h.runWriterPool, accountId, TEXT);
        return { workItemId, deps: { pool, accountId, runner: new FixtureRunner(h.admin, accountId), writer: new FixtureWriter(h.admin, accountId), trigger } };
      };
      const distinct = await Promise.all(Array.from({ length: 8 }, mk));
      const burstItem = await mk();

      const runs = [...distinct, ...Array.from({ length: 6 }, () => burstItem)].map((s) => runSpecStep(s.deps, { workItemId: s.workItemId }));
      const all = Promise.allSettled(runs);
      const outcome = await Promise.race([all, new Promise<"HUNG">((r) => setTimeout(() => r("HUNG"), BUDGET_MS))]);
      expect(outcome).not.toBe("HUNG");
      if (outcome === "HUNG") return;

      expect(outcome.filter((o) => o.status === "rejected")).toEqual([]);
      const ids = [...distinct, burstItem].map((s) => s.workItemId);
      const { rows } = await h.admin.query<{ work_item_id: string; n: number }>(
        `SELECT work_item_id, count(*)::int AS n FROM spec_versions WHERE work_item_id = ANY($1) GROUP BY work_item_id`,
        [ids],
      );
      expect(rows).toHaveLength(ids.length);
      for (const r of rows) expect(r.n, `Spec versions for ${r.work_item_id}`).toBe(1);
      const { rows: transitions } = await h.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM work_item_transitions WHERE work_item_id = ANY($1) AND to_stage = 'spec_ready'`,
        [ids],
      );
      expect(transitions[0]!.n).toBe(ids.length);
      // Every item, including the 6-run burst, fires the same single trigger key.
      expect(new Set(events.map((e) => e.idempotencyKey)).size).toBe(ids.length);
    });
  }, 60_000);
});
