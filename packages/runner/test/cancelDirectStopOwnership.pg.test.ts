import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startAgentRun } from "../src/startAgentRun.js";
import { cancelRun } from "../src/cancelRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { SandboxPort } from "../src/sandboxPort.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const spend = { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const };

function wrap(port: SandboxPort, log: string[]): SandboxPort {
  return {
    ...port,
    async createSandbox(opts) {
      log.push(`create:${opts.sandboxName}`);
      return port.createSandbox(opts);
    },
    startDetached(handle, opts) {
      log.push(`start:${handle.sandboxName}`);
      return port.startDetached(handle, opts);
    },
    async stop(handle) {
      log.push(`stop:${handle.sandboxName}`);
      return port.stop(handle);
    },
    async deleteSandbox(handle) {
      log.push(`delete:${handle.sandboxName}`);
      return port.deleteSandbox(handle);
    },
  };
}

/**
 * PR #85 fix round 4, must-fix 1 (security re-review of a12153d; CWE-
 * 672/664): fix round 3's direct-stop path gated only on `bk.started`,
 * which nothing ever cleared -- so a `cancel()` on an already-finished
 * executor run stopped the live PERSISTENT sandbox of a NEWER run on the
 * same PR (the shared `ex-{account}-{repo}-{pr}` name), while that
 * newer run's own row still said `running`. `SandboxTarget.cancel` now
 * gates the direct stop on `stillOwnsSandbox`: the run's own durable
 * status must not already be `succeeded`/`failed`, and for a persistent
 * role no newer `pending`/`running` run on the same account/repo/PR may
 * have been created since.
 */
describe("PR #85 fix round 4, must-fix 1: direct-stop targets only the run that still owns the sandbox [pg]", () => {
  const db = pgHarness();

  it("a finished R1 does not stop a live newer R2 on the same PR, and R2 stays running", async () => {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 5 });

    const log: string[] = [];
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget({ ...harness.deps, sandboxPort: wrap(harness.deps.sandboxPort, log) });
    const input = {
      accountId,
      repoId,
      workItemId,
      role: "executor" as const,
      product: "team" as const,
      pr: 5,
      roleCard: "r",
      prompt: "p",
      model: "haiku-4.5",
      capUsd: 5,
      spend,
    };

    const r1 = await startAgentRun(db.runWriterPool, { sandbox: target }, input);
    if (r1.status !== "running") {
      throw new Error(`test setup: expected r1 to reach "running", got "${r1.status}"`);
    }

    // R1 finishes on its own -- exactly as a terminal writer (H09b2, not
    // built here) would leave it: a terminal status this SAME cancel
    // call did not just write, and its reservation already released.
    await db.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE id = $1`, [r1.id]);
    await db.admin.query(
      `UPDATE spend_reservations SET state = 'released' WHERE run_id = $1 AND state = 'open'`,
      [r1.id],
    );

    const r2 = await startAgentRun(db.runWriterPool, { sandbox: target }, input);
    if (r2.status !== "running") {
      throw new Error(`test setup: expected r2 to reach "running", got "${r2.status}"`);
    }

    const beforeCancel = log.length;
    await cancelRun({ pool: db.runWriterPool, principal: { accountId, userId } }, r1.id, { sandbox: target });
    const sideEffects = log.slice(beforeCancel);

    expect(sideEffects.filter((line) => line.startsWith("stop") || line.startsWith("delete"))).toHaveLength(0);

    const { rows: r1Rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [r1.id]);
    const { rows: r2Rows } = await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [r2.id]);
    expect(r1Rows[0].status).toBe("succeeded");
    expect(r2Rows[0].status).toBe("running");
  });

  /**
   * PR #85 fix round 4, should-fix (CWE-401/770): `SandboxTarget.runs`
   * used to grow by one entry per run for the life of the instance --
   * nothing ever removed one. `cancel()` now prunes its own run's entry
   * once it has computed that run's final result (see its own comment).
   * `role: "code-reviewer"` (non-persistent) keeps this test focused on
   * the bookkeeping map itself, not the shared-name behavior the test
   * above already covers. Each run is a chain of Postgres round trips; 100 of them took 7 s to over 20 s on a loaded
   * machine against vitest's 20 s test timeout (1 s unloaded), so the test runs 20: a leak of one entry per run
   * still leaves a map of 20, not 0.
   */
  it("should-fix: SandboxTarget.runs does not grow across 20 completed (dispatch-then-cancel) runs", async () => {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 9 });

    const harness = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget(harness.deps);

    for (let i = 0; i < 20; i++) {
      const run = await startAgentRun(db.runWriterPool, { sandbox: target }, {
        accountId,
        repoId,
        workItemId,
        role: "code-reviewer",
        product: "team",
        roleCard: "r",
        prompt: "p",
        model: "haiku-4.5",
        capUsd: 5,
        spend,
      });
      if (run.status !== "running") {
        throw new Error(`test setup: expected run ${i} to reach "running", got "${run.status}"`);
      }
      await cancelRun({ pool: db.runWriterPool, principal: { accountId, userId } }, run.id, { sandbox: target });
    }

    expect((target as unknown as { runs: Map<string, unknown> }).runs.size).toBe(0);
  });
});
