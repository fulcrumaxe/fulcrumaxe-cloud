import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { plannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import { createAdvanceModule, type AdvanceModuleDeps } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * [pg] D#483 S5-b2c-3: two children of one parent both dispatch on the parent's issue number (the build and the sandbox are keyed on it), so the database's one-live-executor-per-pull-request
 * index (0625) lets only one of them run at a time. When two start at once the second is refused `already_running` by that index: not corruption. The first child's run and its recorded
 * branch are untouched, and the second child has no run and no binding. The starter below writes the run row with the real `insertAgentRun`, which raises the real duplicate error.
 */
describe("two children of one parent starting at once [pg]", { timeout: 60_000 }, () => {
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

  const SEAT: SeatResult = {
    ok: true,
    seat: {
      repoId: "unused", product: "team", roleCard: "card", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
      limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 }, timeoutMs: 40 * 60_000, maxExtensions: 3,
    } as never,
  };
  const PARENT_NUMBER = 41;
  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;

  it("the second start is refused already_running; the first run and its branch record are untouched; nothing is half written for the second", async () => {
    const f = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'sandbox' WHERE id = $1", [f.t.repoId]);
    await admin.query("UPDATE work_items SET gh_number = $2 WHERE id = $1", [f.parent, PARENT_NUMBER]);
    await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE account_id = $1 AND status IN ('pending', 'running')", [f.t.accountId]);
    const starter = {
      async start(input: { accountId: string; workItemId: string; repoId: string; pr?: number; idempotency?: { key: string; requestHash: string } }) {
        const { id } = await insertAgentRun(writerPool, {
          id: randomUUID(), accountId: input.accountId, workItemId: input.workItemId, specVersionId: f.specV1, role: "executor", runtime: "production", executionMode: "sandbox",
          dispatchRepoId: input.repoId, dispatchPrNumber: input.pr ?? null, ...(input.idempotency ? { idempotency: input.idempotency } : {}),
        });
        return { runId: id };
      },
    } as unknown as RunStarter;
    const deps: AdvanceModuleDeps = { starter, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, registry };
    const module = createAdvanceModule(writerPool, deps);
    const start = (child: string, step: string) =>
      module.advanceStartRun({ accountId: f.t.accountId, workItemId: child, haltEpoch: 0, step, role: "executor", prompt: "Build the planned PR.", clone: true, pr: PARENT_NUMBER, exclusive: true, expectedExecutionMode: "sandbox" } as never);

    const first = await start(f.kids.api!, "build:api");
    expect(first.ok).toBe(true);
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 900, 'child.binding', $3::jsonb)`, [f.t.accountId, (first as { runId: string }).runId, JSON.stringify({ branch: "fx/41-api" })]);

    const second = await start(f.kids.ui!, "build:ui");
    expect(second).toEqual({ ok: false, reason: "already_running" });

    const live = (await admin.query<{ work_item_id: string }>("SELECT work_item_id FROM agent_runs WHERE account_id = $1 AND role = 'executor' AND status IN ('pending', 'running')", [f.t.accountId])).rows;
    expect(live).toEqual([{ work_item_id: f.kids.api }]);
    const bindings = (await admin.query<{ branch: string; work_item_id: string }>("SELECT e.payload->>'branch' AS branch, r.work_item_id FROM run_events e JOIN agent_runs r ON r.account_id = e.account_id AND r.id = e.run_id WHERE e.account_id = $1 AND e.kind = 'child.binding'", [f.t.accountId])).rows;
    expect(bindings).toEqual([{ branch: "fx/41-api", work_item_id: f.kids.api }]);
    expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1", [f.kids.ui])).rows[0].n).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS n FROM agent_run_idempotency_keys k JOIN agent_runs r ON r.account_id = k.account_id AND r.id = k.run_id WHERE r.work_item_id = $1", [f.kids.ui])).rows[0].n).toBe(0);
  });
});
