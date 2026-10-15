import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdvanceModule } from "../src/advance.js";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { InstallationTokenCache, liveInstallationTokens } from "@fx/github";
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
});
