import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, type StartAgentRunInput } from "@fx/runner";
import { markBuildNeedsHuman, startBuildForItem } from "@fx/pipeline";
import { setExecutionMode } from "@fx/runner-cloud";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createAdvanceModule } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * D#6 R2b-3h [pg], end to end: the REAL advance workflow (apps/web/workflows/workItemAdvance.ts) over the REAL advance module, the
 * pipeline's real build and build-failed steps and a real database, with no stubbed advance step. A build run waits on a runner;
 * while the workflow polls it, the owner switches the repo off `runner_local` through the real route code; the switch cancels the
 * run, the workflow sees `cancelled`, and the item ends at Needs human with `run_cancelled` named in the move. The only seams are
 * the Workflow service's `sleep` (the test switches the mode inside it) and the run starter, which creates the pending runner run
 * through the real insert (there is no runner to claim it).
 */
const world = vi.hoisted(() => ({ onSleep: null as null | (() => Promise<void>), sleeps: 0 }));
vi.mock("../../../apps/web/node_modules/workflow/dist/index.js", () => ({
  sleep: vi.fn(async () => {
    world.sleeps += 1;
    await world.onSleep?.();
  }),
}));
vi.mock("../../../apps/web/node_modules/workflow/dist/api.js", () => ({ resumeHook: vi.fn(), start: vi.fn() }));

// apps/web is compiled by its own tsconfig (bundler resolution); this package's `tsc` must not follow into it. The paths are variables, so it does not.
const WEB_WORKER = "../../../apps/web/lib/worker";
const WEB_WORKFLOW = "../../../apps/web/workflows/workItemAdvance";
const { setWorkerWiringForTests } = (await import(/* @vite-ignore */ WEB_WORKER)) as { setWorkerWiringForTests: (wiring?: { provider?: () => unknown; createWorker?: () => Promise<unknown> }) => void };
const { workItemAdvanceWorkflow } = (await import(/* @vite-ignore */ WEB_WORKFLOW)) as { workItemAdvanceWorkflow: (args: { accountId: string; userId: string; workItemId: string; actionId: string; haltEpoch: number }) => Promise<{ status: string; detail?: string }> };

const SEAT: SeatResult = {
  ok: true,
  seat: {
    repoId: "unused",
    product: "team",
    roleCard: "card",
    model: "haiku-4.5",
    capUsd: 5,
    spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
    limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
    timeoutMs: 40 * 60_000,
    maxExtensions: 3,
  } as never,
};

describe("a repo switched off a runner, through the real advance workflow [pg]", { timeout: 60_000 }, () => {
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
    setWorkerWiringForTests();
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  async function specReadyItem(a: SeedRefs): Promise<string> {
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'runner_local' WHERE id = $1", [a.repoId]);
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'spec_ready', 7001)", [id, a.accountId, a.repoId]);
    const d = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, 9001, 'feature', 't', $3, 'internal', 'user')", [d, a.accountId, id]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, id]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system', '{\"acceptance_files\":[\"src/**\"]}'::jsonb)", [a.accountId, id]);
    return id;
  }

  it("the pending build run is cancelled by the switch and the item ends needs_human with run_cancelled", async () => {
    const a = await seedAccount(admin, randomUUID());
    const wi = await specReadyItem(a);
    const created: string[] = [];
    const starter: RunStarter = {
      async start(input: StartAgentRunInput) {
        const { id } = await insertAgentRun(writerPool, {
          id: randomUUID(),
          accountId: a.accountId,
          workItemId: input.workItemId!,
          role: "executor",
          runtime: "runner",
          executionMode: "runner_local",
          dispatchRepoId: a.repoId,
          idempotency: input.idempotency,
        });
        created.push(id);
        return { runId: id };
      },
    };
    const module = createAdvanceModule(writerPool, { starter, resolveRunSeat: async () => SEAT, startAdvance: async () => undefined, triage: null, build: startBuildForItem, buildFailed: markBuildNeedsHuman } as never);
    setWorkerWiringForTests({ provider: () => ({}) as never, createWorker: async () => module as never });

    const switched: unknown[] = [];
    world.sleeps = 0;
    world.onSleep = async () => {
      if (switched.length > 0) return;
      const res = await setExecutionMode({ appUserPool: appPool, origin: "https://runner.example.test", failRunnerLeases: null }, { accountId: a.accountId, userId: a.userId }, a.repoId, { mode: "sandbox", confirm_repo: "acme/widgets" });
      switched.push(res);
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const out = await workItemAdvanceWorkflow({ accountId: a.accountId, userId: a.userId, workItemId: wi, actionId: randomUUID(), haltEpoch: 0 });
      expect(out).toEqual({ status: "failed", detail: "build_cancelled" });
    } finally {
      info.mockRestore();
      world.onSleep = null;
    }
    expect(switched).toHaveLength(1);
    expect(switched[0]).toMatchObject({ status: 200, body: { execution_mode: "sandbox", cancelled_runs: 1 } });
    expect(created).toHaveLength(1);
    expect((await admin.query("SELECT status FROM agent_runs WHERE id = $1", [created[0]])).rows[0].status).toBe("cancelled");
    expect((await admin.query("SELECT stage FROM work_items WHERE id = $1", [wi])).rows[0].stage).toBe("needs_human");
    const moved = (await admin.query("SELECT source_ref FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'needs_human'", [wi])).rows;
    expect(moved.map((r) => r.source_ref)).toEqual([`build_failed:run_cancelled:${created[0]}`]);
  });
});
