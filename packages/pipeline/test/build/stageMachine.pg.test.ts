import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExecutionTargetRegistry } from "@fx/runner";
import { dispatchDebaterIfNeeded, dispatchReviewers } from "../../src/build/stageMachine.js";
import { createFakeExecutionTarget } from "./helpers/fakeExecutionTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/** D#2 H14a, criterion 1's reviewer-dispatch half: which roles get
 * dispatched for a PR, and the debater's Feature/Critical gate. */
describe("H14a stage machine: reviewer dispatch [pg]", () => {
  const db = pgHarness();

  function buildInput() {
    return {
      pr: 3,
      product: "team" as const,
      roleCard: "fixture role card",
      prompt: "fixture prompt",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const },
    };
  }

  async function seedFixture(): Promise<{ accountId: string; repoId: string; workItemId: string; registry: ExecutionTargetRegistry }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 3 });
    const { target } = createFakeExecutionTarget();
    return { accountId, repoId, workItemId, registry: { sandbox: target } };
  }

  it("dispatches code-reviewer and acceptance-tester, but not security-reviewer, for a small item with no diff trigger", async () => {
    const { accountId, repoId, workItemId, registry } = await seedFixture();
    const dispatched = await dispatchReviewers(db.runWriterPool, registry, {
      accountId,
      workItemId,
      headSha: "sha-small",
      tier: "small",
      securityDiffTriggerFired: false,
      buildInput: () => ({ repoId, ...buildInput() }),
    });
    const roles = dispatched.map((d) => d.role).sort();
    expect(roles).toEqual(["acceptance-tester", "code-reviewer"]);
    for (const d of dispatched) {
      expect(d.result.status).toBe("running");
    }
  });

  it("dispatches security-reviewer too for a critical item, each with the same head SHA", async () => {
    const { accountId, repoId, workItemId, registry } = await seedFixture();
    const dispatched = await dispatchReviewers(db.runWriterPool, registry, {
      accountId,
      workItemId,
      headSha: "sha-critical",
      tier: "critical",
      securityDiffTriggerFired: false,
      buildInput: () => ({ repoId, ...buildInput() }),
    });
    expect(dispatched.map((d) => d.role).sort()).toEqual(["acceptance-tester", "code-reviewer", "security-reviewer"]);

    const { rows } = await db.admin.query<{ role: string; head_sha: string }>(
      `SELECT role, head_sha FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 ORDER BY role`,
      [accountId, workItemId],
    );
    expect(rows.every((r) => r.head_sha === "sha-critical")).toBe(true);
  });

  it("dispatches the debater for a Feature item when enabled", async () => {
    const { accountId, repoId, workItemId, registry } = await seedFixture();
    const result = await dispatchDebaterIfNeeded(db.runWriterPool, registry, {
      accountId,
      workItemId,
      headSha: "sha-feature",
      tier: "feature",
      enabled: true,
      buildInput: () => ({ repoId, ...buildInput() }),
    });
    expect(result?.status).toBe("running");
  });

  it("never dispatches the debater for a Small item, even when enabled", async () => {
    const { accountId, repoId, workItemId, registry } = await seedFixture();
    const result = await dispatchDebaterIfNeeded(db.runWriterPool, registry, {
      accountId,
      workItemId,
      headSha: "sha-small-2",
      tier: "small",
      enabled: true,
      buildInput: () => ({ repoId, ...buildInput() }),
    });
    expect(result).toBeUndefined();
  });

  it("never dispatches the debater when disabled, even for a Critical item", async () => {
    const { accountId, repoId, workItemId, registry } = await seedFixture();
    const result = await dispatchDebaterIfNeeded(db.runWriterPool, registry, {
      accountId,
      workItemId,
      headSha: "sha-critical-2",
      tier: "critical",
      enabled: false,
      buildInput: () => ({ repoId, ...buildInput() }),
    });
    expect(result).toBeUndefined();
  });
});
