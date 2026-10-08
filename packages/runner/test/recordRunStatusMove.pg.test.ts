import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { insertAgentRun, recordRunStatusMove, writeRunStatus } from "../src/runStatusWriter.js";
import { IllegalRunTransitionError } from "../src/statusTransitions.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#6 R2b-3h [pg]: `recordRunStatusMove` writes the events of a move the database function made, so it must refuse a move that
 * is not on the status graph before it writes anything. Without the check, a caller's wrong `from`/`to` would leave a
 * `run.status_changed` row and a domain event for a transition that never happened.
 */
describe("recordRunStatusMove [pg]", () => {
  const db = pgHarness();

  async function succeededRun(): Promise<{ accountId: string; runId: string }> {
    const accountId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, randomUUID());
    const { id } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId, role: "executor", runtime: "production" });
    await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "pending", to: "running" });
    await writeRunStatus(db.runWriterPool, { accountId, runId: id, from: "running", to: "succeeded" });
    return { accountId, runId: id };
  }
  const eventCount = async (runId: string): Promise<number> => (await db.admin.query("SELECT count(*)::int AS n FROM run_events WHERE run_id = $1", [runId])).rows[0].n as number;
  const domainCount = async (runId: string): Promise<number> => (await db.admin.query("SELECT count(*)::int AS n FROM domain_events WHERE subject_id = $1", [runId])).rows[0].n as number;

  it("succeeded -> running throws IllegalRunTransitionError and writes no run event and no domain event", async () => {
    const { accountId, runId } = await succeededRun();
    const before = { events: await eventCount(runId), domain: await domainCount(runId) };
    await expect(withTenant(db.runWriterPool, accountId, (client) => recordRunStatusMove(client, { accountId, runId, from: "succeeded", to: "running" }))).rejects.toBeInstanceOf(IllegalRunTransitionError);
    expect({ events: await eventCount(runId), domain: await domainCount(runId) }).toEqual(before);
  });

  it("a move on the graph (pending -> cancelled) writes its run event and its domain event, and no more", async () => {
    const accountId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, randomUUID());
    const { id } = await insertAgentRun(db.runWriterPool, { id: randomUUID(), accountId, role: "executor", runtime: "production" });
    const before = { events: await eventCount(id), domain: await domainCount(id) };
    await withTenant(db.runWriterPool, accountId, (client) => recordRunStatusMove(client, { accountId, runId: id, from: "pending", to: "cancelled", failureReason: "execution_mode_changed" }));
    expect({ events: await eventCount(id), domain: await domainCount(id) }).toEqual({ events: before.events + 1, domain: before.domain + 1 });
  });
});
