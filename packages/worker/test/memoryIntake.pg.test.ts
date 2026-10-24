import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdvanceModule } from "../src/advance.js";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { InstallationTokenCache, liveInstallationTokens } from "@fx/github";
import { createMemoryPort } from "@fx/pipeline";
import { ingestRunMemoryProposals } from "../src/memoryIntake.js";

// Built from pieces so the source holds no token-shaped literal.
const MINTED = ["opaque", "install", "token", "e91c4b7d2a"].join("-"); // gitleaks:allow

/** D#601 MEM-2 [pg]: the worker's half of the proposal intake, through the run-writer login the stage driver uses and the real run-event writer. */
describe("run memory intake in the worker [pg]", { timeout: 60_000 }, () => {
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

  async function run(runtime: string, status = "succeeded"): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1,$2,$3,'executor',$4,$5)`, [id, a.accountId, a.workItemId, runtime, status]);
    return id;
  }
  const envelope = (...bodies: string[]) => ({ verdict: "done", memory_proposals: bodies.map((body) => ({ scope: "item", kind: "command", body })) });
  const ingest = (runId: string, env: Record<string, unknown> | null) => ingestRunMemoryProposals({ pool: writerPool, accountId: a.accountId, runId, envelope: env });
  const rows = async (runId: string) => (await admin.query(`SELECT body, status, author_kind, provenance FROM memory_entries WHERE account_id = $1 AND provenance->>'source_run_id' = $2`, [a.accountId, runId])).rows;
  const events = async (runId: string) => (await admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'memory.proposals'`, [runId])).rows;

  it("stores a finished sandbox run's proposals as pending agent entries and leaves one event on the run", async () => {
    const runId = await run("production");
    expect(await ingest(runId, envelope("use pnpm, not npm", "tests live under test/"))).toMatchObject({ status: "ingested" });
    expect(await rows(runId)).toEqual([
      expect.objectContaining({ body: "use pnpm, not npm", status: "proposed", author_kind: "agent" }),
      expect.objectContaining({ body: "tests live under test/", status: "proposed", author_kind: "agent" }),
    ]);
    const ev = await events(runId);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ source: "agent", refused: [] });
    expect(await ingest(runId, envelope("use pnpm, not npm"))).toEqual({ status: "already_ingested" });
  });

  it("never reads a run on a person's machine: its transcript leaves the machine only after the person's yes", async () => {
    const runId = await run("runner");
    expect(await ingest(runId, envelope("from a runner run"))).toEqual({ status: "skipped_runner" });
    expect(await rows(runId)).toHaveLength(0);
    expect(await events(runId)).toHaveLength(0);
  });

  it("ignores a run that did not end succeeded or failed, a missing run, and an envelope with no proposals", async () => {
    expect((await ingest(await run("production", "cancelled"), envelope("cancelled run"))).status).toBe("none");
    expect((await ingest(randomUUID(), envelope("no such run"))).status).toBe("none");
    expect((await ingest(await run("production"), { verdict: "done" })).status).toBe("none");
    expect((await ingest(await run("production"), null)).status).toBe("none");
  });

  it("scans against the installation tokens this process has cached, with no value passed in", async () => {
    new InstallationTokenCache().set(1, "team", "executor", { repositories: ["r"], permissions: { contents: "read" } } as never, MINTED, Date.now() + 60_000);
    expect(liveInstallationTokens()).toContain(MINTED);
    const runId = await run("production");
    expect(await ingest(runId, envelope(`push with ${MINTED}`))).toMatchObject({ refused: [{ index: 0, reason: "secret_detected" }], stored: [] });
    expect(JSON.stringify((await admin.query(`SELECT payload FROM run_events WHERE run_id = $1`, [runId])).rows)).not.toContain(MINTED);
    expect(liveInstallationTokens(Date.now() + 400_000)).not.toContain(MINTED);
  });

  it("ingests a failed run's proposals too (the work happened; a person still decides)", async () => {
    const runId = await run("local", "failed");
    expect((await ingest(runId, envelope("learned the hard way"))).status).toBe("ingested");
  });

  it("is reached through the driver's own read of a finished run, which answers exactly what it did before", async () => {
    const m = createAdvanceModule(writerPool, { starter: null, resolveRunSeat: async () => ({ ok: false, reason: "unused" }) as never, startAdvance: async () => undefined, triage: null });
    const runId = await run("production");
    const env = envelope("found through the driver");
    await admin.query("UPDATE agent_runs SET envelope = $2::jsonb WHERE id = $1", [runId, JSON.stringify(env)]);
    expect(await m.advanceRunOutcome(a.accountId, runId)).toEqual({ status: "succeeded", done: true, envelope: env, runtime: "production", tailRunId: runId, failureReason: null });
    expect((await rows(runId)).map((r) => r.body)).toEqual(["found through the driver"]);
    // Polled again, as the driver does: nothing more is written.
    await m.advanceRunOutcome(a.accountId, runId);
    expect(await rows(runId)).toHaveLength(1);
    expect(await events(runId)).toHaveLength(1);
  });
  describe("repo-scope proposals (D#601 MEM-3w)", () => {
    const repoEnvelope = (body: string) => ({ verdict: "done", memory_proposals: [{ scope: "repo", kind: "command", body }] });
    const setNodeId = (id: string | null) => admin.query("UPDATE repos SET gh_node_id = $2 WHERE id = $1", [a.repoId, id]);
    const ghInstallation = async () => Number((await admin.query("SELECT gh_installation_id FROM installations WHERE id = $1", [a.installationId])).rows[0].gh_installation_id);

    it("is refused scope_unresolved, with nothing stored, while the repository has no node id (no fallback key)", async () => {
      await setNodeId(null);
      const runId = await run("production");
      expect(await ingest(runId, repoEnvelope("use pnpm, not npm"))).toMatchObject({ stored: [], refused: [{ index: 0, reason: "scope_unresolved" }] });
      expect(await rows(runId)).toHaveLength(0);
    });

    it("is refused scope_unresolved when the repository is detached from its installation, even with a node id", async () => {
      await setNodeId("R_kgDOWorkerDetached");
      await admin.query("UPDATE repos SET installation_id = NULL WHERE id = $1", [a.repoId]);
      try {
        const runId = await run("production");
        expect(await ingest(runId, repoEnvelope("detached repo note"))).toMatchObject({ stored: [], refused: [{ index: 0, reason: "scope_unresolved" }] });
      } finally {
        await admin.query("UPDATE repos SET installation_id = $2 WHERE id = $1", [a.repoId, a.installationId]);
      }
    });

    it("after the node id is stored, the proposal lands at the key MEM-3 recalls from, and once approved it is recalled for that repository", async () => {
      const nodeId = "R_kgDOWorkerRecall";
      await setNodeId(nodeId);
      const runId = await run("production");
      expect(await ingest(runId, repoEnvelope("run the linter before the tests"))).toMatchObject({ refused: [], stored: [{ index: 0, scope: "repo" }] });
      const key = `${nodeId}@${await ghInstallation()}`;
      const stored = (await admin.query("SELECT id, scope_ref FROM memory_entries WHERE account_id = $1 AND provenance->>'source_run_id' = $2", [a.accountId, runId])).rows;
      expect(stored).toEqual([{ id: expect.any(String), scope_ref: key }]);
      const port = createMemoryPort(writerPool, { liveSecrets: () => [] });
      const recall = () => port.recall({ accountId: a.accountId, repoId: a.repoId, role: "executor", slot: "stable" } as never);
      expect(await recall()).toEqual([]); // proposed: never injected
      await admin.query("UPDATE memory_entries SET status = 'approved' WHERE id = $1", [stored[0].id]);
      expect((await recall()).map((e) => e.id)).toEqual([stored[0].id]);
    });

    it("keys the proposal to the work item's repository when the run was dispatched against a different one (work item wins)", async () => {
      const otherRepo = randomUUID();
      await admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, gh_node_id, product) VALUES ($1,$2,$3,2,'R_kgDOWorkerDispatchOther','team')", [otherRepo, a.accountId, a.installationId]);
      const workNodeId = "R_kgDOWorkerWorkItemWins";
      await setNodeId(workNodeId);
      const runId = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, dispatch_repo_id) VALUES ($1,$2,$3,'executor','production','succeeded',$4)`, [runId, a.accountId, a.workItemId, otherRepo]);
      expect(await ingest(runId, repoEnvelope("work item repo wins"))).toMatchObject({ refused: [], stored: [{ index: 0, scope: "repo" }] });
      const scopeRefs = (await admin.query("SELECT scope_ref FROM memory_entries WHERE account_id = $1 AND provenance->>'source_run_id' = $2", [a.accountId, runId])).rows;
      expect(scopeRefs).toEqual([{ scope_ref: `${workNodeId}@${await ghInstallation()}` }]);
    });

    it("uses the dispatch repository only when the run has no work item", async () => {
      const dispatchRepo = randomUUID();
      const dispatchNodeId = "R_kgDOWorkerDispatchOnly";
      await admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, gh_node_id, product) VALUES ($1,$2,$3,3,$4,'team')", [dispatchRepo, a.accountId, a.installationId, dispatchNodeId]);
      const runId = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, dispatch_repo_id) VALUES ($1,$2,'executor','production','succeeded',$3)`, [runId, a.accountId, dispatchRepo]);
      expect(await ingest(runId, repoEnvelope("dispatch only"))).toMatchObject({ refused: [], stored: [{ index: 0, scope: "repo" }] });
      const scopeRefs = (await admin.query("SELECT scope_ref FROM memory_entries WHERE account_id = $1 AND provenance->>'source_run_id' = $2", [a.accountId, runId])).rows;
      expect(scopeRefs).toEqual([{ scope_ref: `${dispatchNodeId}@${await ghInstallation()}` }]);
    });

    it("never resolves to another account's repository when both accounts' repositories carry the same node id", async () => {
      const b = await seedAccount(admin, randomUUID());
      const sharedNodeId = "R_kgDOWorkerSharedAcrossAccounts";
      await setNodeId(sharedNodeId);
      await admin.query("UPDATE repos SET gh_node_id = $2 WHERE id = $1", [b.repoId, sharedNodeId]);
      const bInstallation = Number((await admin.query("SELECT gh_installation_id FROM installations WHERE id = $1", [b.installationId])).rows[0].gh_installation_id);
      const aInstallation = await ghInstallation();
      expect(bInstallation).not.toBe(aInstallation);
      // Same node id on both sides: each account's run keys to its own installation, never the other's.
      const runA = await run("production");
      expect(await ingest(runA, repoEnvelope("account A note"))).toMatchObject({ refused: [], stored: [{ index: 0, scope: "repo" }] });
      const refA = (await admin.query("SELECT scope_ref FROM memory_entries WHERE account_id = $1 AND provenance->>'source_run_id' = $2", [a.accountId, runA])).rows;
      expect(refA).toEqual([{ scope_ref: `${sharedNodeId}@${aInstallation}` }]);
      expect((await admin.query("SELECT 1 FROM memory_entries WHERE account_id = $1", [b.accountId])).rowCount).toBe(0); // A's run stored nothing for B
      // The other account is symmetric. (The database itself refuses a dispatch repo id from another account, so the join guard is the second line.)
      const runB = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1,$2,$3,'executor','production','succeeded')`, [runB, b.accountId, b.workItemId]);
      expect(await ingestRunMemoryProposals({ pool: writerPool, accountId: b.accountId, runId: runB, envelope: repoEnvelope("account B note") })).toMatchObject({ refused: [], stored: [{ index: 0, scope: "repo" }] });
      const refB = (await admin.query("SELECT scope_ref FROM memory_entries WHERE account_id = $1", [b.accountId])).rows;
      expect(refB).toEqual([{ scope_ref: `${sharedNodeId}@${bInstallation}` }]);
    });
  });
});
