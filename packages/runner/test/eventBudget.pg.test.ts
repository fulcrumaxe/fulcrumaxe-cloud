import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import type { ExecutionTargetRegistry } from "../src/executionTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * D#2 H09b2 (C10's revised criterion 6, H09.10): "There is one parent run
 * per work item and one child run per agent. The full fixture Feature
 * cycle records fewer than 2,000 events." A fixture Feature cycle here:
 * one parent run (the work item's own orchestration run) plus nine child
 * runs (PM + 5-seat panel + an acceptance-tester + 2 reviewers), each with
 * `parentRunId` set to the parent -- the shape `agent_runs.parent_run_id`
 * (0001_core.sql) already exists for. [pg]: real Postgres, zero model
 * tokens.
 */
describe("D#2 H09b2, H09.10: one parent run per work item, one child per agent, event budget [pg]", () => {
  const db = pgHarness();

  it("a 10-run fixture Feature cycle (1 parent + 9 children) records well under 2000 run_events rows", async () => {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId);

    const harness = createSandboxTargetHarness(db.runWriterPool);
    const registry: ExecutionTargetRegistry = { sandbox: new SandboxTarget(harness.deps) };

    function input(role: string, parentRunId?: string): StartAgentRunInput {
      return {
        accountId,
        repoId,
        workItemId,
        parentRunId,
        role,
        product: "team",
        roleCard: "rc",
        prompt: "p",
        model: "haiku-4.5",
        capUsd: 5,
        spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
      };
    }

    const parent = await startAgentRun(db.runWriterPool, registry, input("project-manager"));
    expect(parent.status).toBe("running");

    const childRoles = [
      "product-owner",
      "security-expert",
      "cost-analyst",
      "technical-architect",
      "researcher",
      "project-manager",
      "acceptance-tester",
      "code-reviewer",
      "security-reviewer",
    ];
    const children: string[] = [];
    for (const role of childRoles) {
      const child = await startAgentRun(db.runWriterPool, registry, input(role, parent.id));
      expect(child.status).toBe("running");
      children.push(child.id);
    }
    await sleep(20);

    // One parent per work item: exactly the ids we created share this
    // work_item_id, and exactly one of them has no parent_run_id.
    const rows = await db.admin.query(
      `SELECT id, parent_run_id FROM agent_runs WHERE work_item_id = $1`,
      [workItemId],
    );
    expect(rows.rows).toHaveLength(1 + childRoles.length);
    const roots = rows.rows.filter((r: { parent_run_id: string | null }) => r.parent_run_id === null);
    expect(roots).toHaveLength(1);
    expect(roots[0].id).toBe(parent.id);
    const childRows = rows.rows.filter((r: { parent_run_id: string | null }) => r.parent_run_id !== null);
    expect(childRows.every((r: { parent_run_id: string }) => r.parent_run_id === parent.id)).toBe(true);

    const eventRows = await db.admin.query(
      `SELECT run_id FROM run_events WHERE run_id = ANY($1::uuid[])`,
      [[parent.id, ...children]],
    );
    expect(eventRows.rows.length).toBeLessThan(2000);
  });
});
