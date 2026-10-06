import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { insertAgentRun, writeRunStatus } from "@fx/runner";
import { ForeignSessionError, ResumeBackendError, lookupOwnedExecutorSession } from "../../src/build/resumeOwnership.js";
import { resumeAgentRun } from "../../src/build/resumeAgentRun.js";
import type { ExecutionTargetRegistry } from "@fx/runner";
import { pgHarness } from "../helpers/pgHarness.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";

/**
 * D#2 H14a, criterion 2 and the #171 security review's forward-looking
 * note: "whoever builds the real caller must verify the `cc_session_id`
 * it reads came from a row belonging to the requesting tenant's own
 * account before calling `resume()`." "Test it: a foreign session id is
 * refused" (this task's brief).
 */
describe("H14a resumeOwnership [pg]", () => {
  const db = pgHarness();

  async function seedExecutorRunWithSession(
    accountId: string,
    workItemId: string,
    repoId: string,
    sessionId: string,
  ): Promise<string> {
    const { id } = await insertAgentRun(db.runWriterPool, {
      id: randomUUID(),
      accountId,
      workItemId,
      role: "executor",
      runtime: "production",
      executionMode: "sandbox",
      dispatchRepoId: repoId,
      dispatchPrNumber: 7,
    });
    await writeRunStatus(db.runWriterPool, {
      accountId,
      runId: id,
      from: "pending",
      to: "running",
      result: { sessionId },
    });
    return id;
  }

  it("returns the session id for a run in the SAME tenant, work item and role", async () => {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId);
    const runId = await seedExecutorRunWithSession(accountId, workItemId, repoId, "cc-session-owned");

    const owned = await withTenant(db.runWriterPool, accountId, (client) =>
      lookupOwnedExecutorSession(client, { accountId, workItemId }),
    );
    expect(owned).toEqual({ runId, sessionId: "cc-session-owned", backend: "claude-code" });
  });

  it("refuses a foreign session: a different tenant's row is invisible even when its workItemId is guessed", async () => {
    const accountA = randomUUID();
    const accountB = randomUUID();
    const repoB = randomUUID();
    const workItemB = randomUUID();
    await seedAccount(db.admin, accountA);
    await seedAccount(db.admin, accountB);
    await seedRepo(db.admin, accountB, repoB);
    await seedWorkItem(db.admin, accountB, workItemB, repoB);
    await seedExecutorRunWithSession(accountB, workItemB, repoB, "cc-session-belongs-to-b");

    // A caller scoped to tenant A, asking for tenant B's real work item id
    // (e.g. a bug, or a spoofed request) must be refused, not handed B's
    // session -- RLS makes B's row invisible under A's withTenant scope.
    await expect(
      withTenant(db.runWriterPool, accountA, (client) =>
        lookupOwnedExecutorSession(client, { accountId: accountA, workItemId: workItemB }),
      ),
    ).rejects.toBeInstanceOf(ForeignSessionError);
  });

  it("refuses a foreign session: a different work item in the SAME tenant is never returned", async () => {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemA = randomUUID();
    const workItemC = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemA, repoId);
    await seedWorkItem(db.admin, accountId, workItemC, repoId);
    await seedExecutorRunWithSession(accountId, workItemC, repoId, "cc-session-belongs-to-c");

    // Same tenant (RLS lets this SELECT run at all), but workItemA has no
    // executor session of its own -- workItemC's session must never leak
    // across work items within one tenant.
    await expect(
      withTenant(db.runWriterPool, accountId, (client) =>
        lookupOwnedExecutorSession(client, { accountId, workItemId: workItemA }),
      ),
    ).rejects.toBeInstanceOf(ForeignSessionError);
  });

  it("refuses when no executor run exists yet for this work item", async () => {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId);

    await expect(
      withTenant(db.runWriterPool, accountId, (client) => lookupOwnedExecutorSession(client, { accountId, workItemId })),
    ).rejects.toBeInstanceOf(ForeignSessionError);
  });

  it("never returns a REVIEWER role's session, even for the same work item", async () => {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId);
    const { id: reviewerRunId } = await insertAgentRun(db.runWriterPool, {
      id: randomUUID(),
      accountId,
      workItemId,
      role: "code-reviewer",
      runtime: "production",
      executionMode: "sandbox",
    });
    await writeRunStatus(db.runWriterPool, {
      accountId,
      runId: reviewerRunId,
      from: "pending",
      to: "running",
      result: { sessionId: "cc-session-reviewer-not-resumable" },
    });

    await expect(
      withTenant(db.runWriterPool, accountId, (client) => lookupOwnedExecutorSession(client, { accountId, workItemId })),
    ).rejects.toBeInstanceOf(ForeignSessionError);
  });
  // D#221 R1b: a fix round continues on the backend the session started on, or not at all.
  it("refuses a round that asks for a different backend, before any run row or target call", async () => {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 7 });
    await seedExecutorRunWithSession(accountId, workItemId, repoId, "cc-session-owned");
    const before = await db.admin.query(`SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1`, [accountId]);
    // An empty registry: if the check did not stop the round first, resolving the target would throw something else.
    const registry = {} as ExecutionTargetRegistry;
    const base = { accountId, repoId, workItemId, pr: 7, role: "executor" as const, product: "team" as const, roleCard: "c", prompt: "p", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter" as const, estimateComputeUsd: 1, trigger: "foreground" as const } };
    for (const backend of ["codex", "", "Claude-Code"]) {
      await expect(resumeAgentRun(db.runWriterPool, registry, { ...base, backend }), backend).rejects.toMatchObject({ name: "ResumeBackendError", reason: "different" });
    }
    const after = await db.admin.query(`SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1`, [accountId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("fails closed when the run being continued has no backend on record", async () => {
    for (const backend of [null, ""]) {
      const client = { query: async () => ({ rows: [{ id: "r1", cc_session_id: "s1", backend }] }) };
      await expect(lookupOwnedExecutorSession(client as never, { accountId: "a", workItemId: "w" })).rejects.toBeInstanceOf(ResumeBackendError);
    }
  });
});
