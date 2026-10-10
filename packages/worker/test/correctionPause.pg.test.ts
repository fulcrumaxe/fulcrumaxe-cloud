import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkItemHaltedError, startAgentRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { acceptCorrection } from "@fx/core/src/corrections/accept.js";
import { createCorrection } from "@fx/core/src/corrections/index.js";
import { createRecordingRunActionSignal } from "@fx/core/src/runActions/index.js";
import { createRunActionFacade } from "../src/runActions.js";

/**
 * [pg] D#597 CC-2a: accepting a pause correction asks for the existing halt (cancel_work_item). Run through the real definer and
 * the real halt writer, the item is marked halted and the database refuses the next run's insert (HX409). Nothing in the
 * accept path clears the marker.
 */
describe("pause correction [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  it("accepting a pause sets halted_at, and the next agent_run_create raises HX409", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'triaged', 7001)", [wi, a.accountId, a.repoId]);
    const ctx = { pool: appPool, principal: { accountId: a.accountId, userId: a.userId } };
    const c = await createCorrection(ctx, { workItemId: wi, kind: "pause", body: "Stop: wrong branch." });
    const signal = createRecordingRunActionSignal();
    const res = await acceptCorrection(ctx, { id: c.id, via: "workspace" }, { signal, itemKinds: [], createItem: async () => undefined });
    expect(res.outcome).toBe("decided");
    expect(res.correction.status).toBe("applied");
    expect(signal.sent).toHaveLength(1);

    // Not halted until the worker performs the request.
    expect((await admin.query("SELECT halted_at FROM work_items WHERE id = $1", [wi])).rows[0].halted_at).toBeNull();
    const facade = createRunActionFacade(writerPool, {} as ExecutionTargetRegistry);
    const actionId = signal.sent[0]!.actionId;
    expect(await facade.claimRunAction(actionId, 600)).not.toBeNull();
    expect(await facade.performCancelWorkItem(actionId)).toMatchObject({ outcome: { halted: true } });
    expect((await admin.query("SELECT halted_at FROM work_items WHERE id = $1", [wi])).rows[0].halted_at).not.toBeNull();

    const input = { accountId: a.accountId, repoId: a.repoId, workItemId: wi, role: "project-manager", product: "team", prompt: "p", idempotency: { key: `k:${wi}`, requestHash: "r".repeat(64) } } as unknown as StartAgentRunInput;
    const calls = { admit: 0 };
    const reg = { sandbox: { runtime: "production", admit: async () => (calls.admit++, { admitted: false }) } } as unknown as ExecutionTargetRegistry;
    await expect(startAgentRun(writerPool, reg, input)).rejects.toBeInstanceOf(WorkItemHaltedError);
    expect(calls.admit).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1", [wi])).rows[0].n).toBe(0);
  });
});
