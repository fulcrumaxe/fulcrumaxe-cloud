import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SandboxBusyError, type SandboxHandle, type SandboxPort } from "../src/sandboxPort.js";
import { DispatchFailedError } from "../src/executionTarget.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";

/**
 * A fresh executor build whose persistent sandbox is in use by another session is refused with the fixed reason
 * `sandbox_busy`, and the other session's sandbox is never stopped, measured or deleted by the failed build. [pg]
 */
describe("a build refused because its sandbox is busy [pg]", () => {
  const db = pgHarness();

  async function scenario(): Promise<StartAgentRunInput> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, randomUUID());
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 64 });
    return {
      accountId,
      repoId,
      workItemId,
      role: "executor",
      product: "team",
      roleCard: "rc",
      prompt: "p",
      model: "haiku-4.5",
      capUsd: 5,
      pr: 64,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
  }

  it("fails the run with sandbox_busy and leaves the other session's sandbox alone", async () => {
    const input = await scenario();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const touched: string[] = [];
    const busyPort: SandboxPort = {
      ...h.deps.sandboxPort,
      async createSandbox(opts): Promise<SandboxHandle> {
        throw new SandboxBusyError(opts.sandboxName);
      },
      async stop(handle) {
        touched.push(`stop:${handle.sandboxName}`);
      },
      async measure(handle) {
        touched.push(`measure:${handle.sandboxName}`);
        return [];
      },
      async deleteSandbox(handle) {
        touched.push(`delete:${handle.sandboxName}`);
      },
    };
    const target = new SandboxTarget({ ...h.deps, sandboxPort: busyPort });

    const failure = await startAgentRun(db.runWriterPool, { sandbox: target }, input).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(DispatchFailedError);
    expect((failure as DispatchFailedError).failureReason).toBe("sandbox_busy");
    const runId = (failure as DispatchFailedError).runId;
    expect((await db.admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status).toBe("failed");
    const event = await db.admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'failed'`, [runId]);
    expect(event.rows[0]?.payload.failureReason).toBe("sandbox_busy");
    expect(touched).toEqual([]);
    // The model money the refused build held is given back; its compute row is settled later by the sweep, as for any launch that never produced a session.
    const open = await db.admin.query(`SELECT 1 FROM spend_reservations WHERE run_id = $1 AND state = 'open' AND budget = 'model'`, [runId]);
    expect(open.rows).toHaveLength(0);
  });
});
