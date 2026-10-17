import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { FIRST_RUN_ROLE, firstRunReservationUsd } from "@fx/pipeline/estimate";
import { envelopeRunUsd } from "@fx/spend";
import { createSeatResolver } from "../src/seat.js";

/**
 * D#483 S5-e1 [pg]: the floor under every envelope write (`firstRunReservationUsd`) is exactly what the seat resolver reserves for the item's first run, so
 * "a limit below the first run's reservation is refused" means the item could not have started. Both are computed from the role's own resolved limits.
 */
describe("the first run's reservation is the seat's own [pg]", () => {
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

  it.each([
    ["the defaults", null],
    ["a role override of the cap and the run time", { per_run_usd: 12.5, max_run_minutes: 20, max_extensions: 1 }],
  ])("%s", async (_name, limits) => {
    const refs = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [refs.accountId]);
    if (limits) await admin.query("INSERT INTO run_limits (account_id, role, per_run_usd, max_run_minutes, max_extensions) VALUES ($1, $2, $3, $4, $5)", [refs.accountId, FIRST_RUN_ROLE, limits.per_run_usd, limits.max_run_minutes, limits.max_extensions]);
    const seated = await createSeatResolver({ pool: writerPool })({ accountId: refs.accountId, role: FIRST_RUN_ROLE, workItemId: refs.workItemId });
    if (!seated.ok) throw new Error(`seat refused: ${seated.reason}`);
    // What reserve() counts against an envelope for this run: its model cap plus its compute.
    const reserved = envelopeRunUsd(seated.seat.spend);
    expect(reserved).not.toBeNull();
    const floor = await withTenant(writerPool, refs.accountId, (c) => firstRunReservationUsd(c, { accountId: refs.accountId, repoId: refs.repoId }));
    expect(floor).toBe(Math.ceil(reserved! * 1e4 - 1e-9) / 1e4);
  });
});
