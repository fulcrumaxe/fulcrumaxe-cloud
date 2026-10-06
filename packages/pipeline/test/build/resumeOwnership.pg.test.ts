import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { insertAgentRun, writeRunStatus } from "@fx/runner";
import { ForeignSessionError, lookupOwnedExecutorSession } from "../../src/build/resumeOwnership.js";
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
    expect(owned).toEqual({ runId, sessionId: "cc-session-owned" });
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
});
