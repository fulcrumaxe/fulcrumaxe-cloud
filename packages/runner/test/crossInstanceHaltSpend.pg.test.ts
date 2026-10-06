import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startAgentRun } from "../src/startAgentRun.js";
import { cancelRun } from "../src/cancelRun.js";
import { createFakeSandbox } from "../src/fakeSandbox.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { AgentRuntime, NormalizedEvent } from "../src/types.js";
import { seedAccount, seedMember, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000, setup = true): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(setup ? `test setup: ${what} never happened within ${timeoutMs}ms` : `${what} (waited ${timeoutMs}ms)`);
    await sleep(10);
  }
}

// Id-less usage lines are priced as they come: 1M input tokens on haiku-4.5 prices at $1.10 each.
function usageEvent(seq: number): NormalizedEvent {
  return {
    runId: "placeholder",
    role: "code-reviewer",
    seq,
    type: "assistant",
    ts: new Date().toISOString(),
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
  };
}

const spend = {
  plan: "starter" as const,
  estimateComputeUsd: 1,
  trigger: "foreground" as const,
  estimateModelUsd: 0.5,
  monthlyModelBudgetUsd: 1000,
  perSpawnCapUsd: 50,
};

/**
 * A halt that lands on a different process than the one streaming the run.
 * The running model total lives in the streaming instance's memory
 * (`bk.cumulativeModelUsd`), so the halting instance sees none of it. These
 * tests pin what the ledger holds afterwards. [pg]: real Postgres, fake sandbox,
 * no provider and no key.
 */
describe("cross-instance halt keeps the metered model spend [pg]", () => {
  const db = pgHarness();

  async function setup() {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId);

    // Instance A streams: one usage line at once, the next only when the test lets it through.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let firstSent = false;
    const runtime: AgentRuntime = {
      async start(opts) {
        await opts.onEvent(usageEvent(1));
        firstSent = true;
        await gate; // the in-flight model call
        await opts.onEvent(usageEvent(2));
        return { handle: { runId: opts.runId } };
      },
      async stop() {},
      async resume(handle) {
        return { handle };
      },
    };
    const base = createSandboxTargetHarness(db.runWriterPool);
    // The real wiring: the target finalizes before it wakes the workflow.
    const depsA = { ...base.deps, sandboxPort: createFakeSandbox(runtime).port, finalizeBeforeResume: true };
    const targetA = new SandboxTarget(depsA);
    // Instance B: a fresh process, same database, never saw a metered event.
    const targetB = new SandboxTarget({ ...createSandboxTargetHarness(db.runWriterPool).deps, finalizeBeforeResume: true });

    const started = await startAgentRun(db.runWriterPool, { sandbox: targetA }, {
      accountId,
      repoId,
      role: "code-reviewer",
      product: "team",
      roleCard: "fake role card",
      prompt: "fake prompt",
      model: "haiku-4.5",
      capUsd: 50,
      spend,
    });
    if (started.status !== "running") throw new Error(`test setup: expected "running", got "${started.status}"`);
    await waitFor(() => firstSent, "the first usage line");
    // Metering is asynchronous after the line; give the first priced raise time to land in A's memory.
    await sleep(100);
    return { accountId, userId, runId: started.id, targetA, targetB, release, hooks: base.hooks };
  }

  async function modelLedger(accountId: string, runId: string): Promise<number[]> {
    const { rows } = await db.admin.query(`SELECT usd FROM ledger WHERE account_id = $1 AND run_id = $2 AND budget = 'model'`, [accountId, runId]);
    return rows.map((r: { usd: string }) => Number(r.usd));
  }

  async function openReservations(runId: string): Promise<number> {
    const { rows } = await db.admin.query(`SELECT 1 FROM spend_reservations WHERE run_id = $1 AND state = 'open'`, [runId]);
    return rows.length;
  }

  it("instance B halts a run instance A is streaming: the accrued model spend reaches the ledger and nothing stays reserved", async () => {
    const { accountId, userId, runId, targetB, release } = await setup();

    const halted = await cancelRun({ pool: db.runWriterPool, principal: { accountId, userId } }, runId, { sandbox: targetB });
    expect(halted.status).toBe("cancelled");

    // A's in-flight model call completes after the halt; A then ends its stream.
    release();
    await waitFor(async () => (await modelLedger(accountId, runId)).length > 0, "model spend was not booked after a cross-instance halt", 5000, false);
    await sleep(200); // anything further A writes would land by now

    const rows = await modelLedger(accountId, runId);
    expect(rows).toHaveLength(1);
    // Both lines were metered by A; a total of 0 would be the lost-spend bug.
    expect(rows[0]).toBeCloseTo(2.2, 4); // two metered lines of $1.10 each: neither lost nor double-counted
    expect(await openReservations(runId)).toBe(0);
    // Compute is settled, never released: it has its own ledger row.
    const { rows: compute } = await db.admin.query(`SELECT 1 FROM ledger WHERE run_id = $1 AND budget <> 'model'`, [runId]);
    expect(compute.length).toBeGreaterThan(0);
    const { rows: status } = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId]);
    expect(status[0].status).toBe("cancelled");
  });

  it("the halt alone, before A's in-flight call completes, leaves no open reservation", async () => {
    const { accountId, userId, runId, targetB, release } = await setup();
    await cancelRun({ pool: db.runWriterPool, principal: { accountId, userId } }, runId, { sandbox: targetB });
    expect(await openReservations(runId)).toBe(0);
    // Compute is settled, never released: it has a ledger row.
    const { rows } = await db.admin.query(`SELECT 1 FROM ledger WHERE run_id = $1 AND budget <> 'model'`, [runId]);
    expect(rows.length).toBeGreaterThan(0);
    release();
    await sleep(300);
  });
});
