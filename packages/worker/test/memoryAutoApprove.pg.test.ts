import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { ingestRunMemoryProposals } from "../src/memoryIntake.js";

/**
 * D#601 MEM-10 [pg]: the worker hands the intake the run's repository, so a raised `memory_auto_approve` dial approves a fact or command in the same
 * transaction, through the run-writer login the stage driver really uses. A repository nobody raised, and a run on a person's machine, are untouched.
 */
describe("run memory intake with the auto-approve dial [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let a: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    a = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  async function run(runtime = "production", status = "succeeded"): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1,$2,$3,'executor',$4,$5)`, [id, a.accountId, a.workItemId, runtime, status]);
    return id;
  }
  const envelope = (body: string) => ({ verdict: "done", memory_proposals: [{ scope: "item", kind: "command", body }] });
  const ingest = (runId: string, body: string) => ingestRunMemoryProposals({ pool: writerPool, accountId: a.accountId, runId, envelope: envelope(body) });
  const state = async (body: string) => (await admin.query(`SELECT status, approved_by, author_kind FROM memory_entries WHERE account_id = $1 AND body = $2`, [a.accountId, body])).rows[0];
  const receipts = async () => (await admin.query(`SELECT actor, dial_version, chosen FROM decision_receipts WHERE account_id = $1 AND decision_type = 'memory_auto_approve'`, [a.accountId])).rows;
  const dial = (disposition: string, version: number) =>
    admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'memory_auto_approve', $3, NULL, $4, $5)`, [a.accountId, a.repoId, disposition, version, a.userId]);

  it("leaves a proposal waiting while the repository has no dial row, and approves the same kind of proposal once it is raised, with one policy receipt", async () => {
    await ingest(await run(), "waits while unset");
    expect(await state("waits while unset")).toMatchObject({ status: "proposed", approved_by: null });
    expect(await receipts()).toEqual([]);
    await dial("announce", 1);
    const runId = await run();
    expect((await ingest(runId, "approved when raised")).status).toBe("ingested");
    expect(await state("approved when raised")).toMatchObject({ status: "approved", approved_by: null, author_kind: "agent" });
    expect(await receipts()).toEqual([{ actor: "policy", dial_version: 1, chosen: "announce" }]);
    expect((await admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'memory.proposals'`, [runId])).rows[0].payload.stored[0].auto).toBe("approved");
    expect(await ingest(runId, "approved when raised")).toEqual({ status: "already_ingested" });
    expect(await receipts()).toHaveLength(1);
  });

  it("a failed run's proposals wait for a person while the dial is raised; the same kind of proposal from a succeeded run is approved", async () => {
    // The first test left the dial raised (version 1) for this account.
    await ingest(await run("production", "failed"), "from a failed run");
    expect(await state("from a failed run")).toMatchObject({ status: "proposed", approved_by: null });
    const before = (await receipts()).length;
    await ingest(await run(), "from a succeeded run");
    expect(await state("from a succeeded run")).toMatchObject({ status: "approved", approved_by: null });
    expect(await receipts()).toHaveLength(before + 1);
  });

  it("does not read a run on a person's machine, raised or not", async () => {
    await ingest(await run("runner"), "from a runner run");
    expect(await state("from a runner run")).toBeUndefined();
  });
});
