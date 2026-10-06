import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { UnsupportedFundingError } from "../src/funding.js";
import type { ExecutionTargetRegistry } from "../src/executionTarget.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

describe("D#2 H09b2, correction C16: the run-funding seam [pg]", () => {
  const db = pgHarness();

  async function seedRepoFixture(): Promise<{ accountId: string; repoId: string }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, repoId };
  }

  function baseInput(accountId: string, repoId: string): StartAgentRunInput {
    return {
      accountId,
      repoId,
      role: "code-reviewer",
      product: "team",
      roleCard: "fake role card",
      prompt: "fake prompt",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
  }

  it("C16.1: funding omitted and {kind:'self'} produce identical, self-account behavior", async () => {
    for (const funding of [undefined, { kind: "self" as const }]) {
      const { accountId, repoId } = await seedRepoFixture();
      const harness = createSandboxTargetHarness(db.runWriterPool);
      const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };

      const result = await startAgentRun(db.runWriterPool, registry, { ...baseInput(accountId, repoId), funding });
      expect(result.status).toBe("running");

      const reservations = await db.admin.query(`SELECT account_id FROM spend_reservations WHERE run_id = $1`, [
        result.id,
      ]);
      expect(reservations.rows.every((r: { account_id: string }) => r.account_id === accountId)).toBe(true);
    }
  });

  it("C16.3: a {kind:'claim'} run throws UnsupportedFundingError before any reservation, sandbox, or agent_runs row is created", async () => {
    const { accountId, repoId } = await seedRepoFixture();
    const harness = createSandboxTargetHarness(db.runWriterPool);
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };

    const input: StartAgentRunInput = {
      ...baseInput(accountId, repoId),
      funding: { kind: "claim", payerAccountId: randomUUID(), fundingId: randomUUID() },
    };

    await expect(startAgentRun(db.runWriterPool, registry, input)).rejects.toThrow(UnsupportedFundingError);

    expect(harness.fakeSandbox.state.created).toHaveLength(0);
    const runs = await db.admin.query(`SELECT 1 FROM agent_runs WHERE account_id = $1`, [accountId]);
    expect(runs.rows).toHaveLength(0);
    const reservations = await db.admin.query(`SELECT 1 FROM spend_reservations WHERE account_id = $1`, [accountId]);
    expect(reservations.rows).toHaveLength(0);
  });
});
