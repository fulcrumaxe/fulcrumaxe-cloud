import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { ingestRunMemoryProposals, ingestRunnerMemoryProposals, MEM_PROPOSAL_CAPABILITY } from "../src/memoryIntake.js";
import { createRunnerMemoryProposalsFacade } from "../src/runnerMemoryProposals.js";

// Built from pieces so the source holds no token-shaped literal.
const LIVE = ["opaque", "runner", "live", "token", "5d83a1c0f7"].join("-"); // gitleaks:allow

/**
 * D#601 MEM-6 [pg]: the cloud half of a runner's memory-proposal upload, through the run-writer login the worker's intake uses. The run, its owner, its state and its
 * repository are read from our rows; the same intake as any proposal runs, with the author kind `runner_agent`, and nothing is approved.
 */
describe("a runner's consented memory proposals in the worker [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let runner: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    runner = await insertRunner(admin, a.accountId, a.userId);
    await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [runner, a.accountId, [MEM_PROPOSAL_CAPABILITY]]);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  async function run(over: { runtime?: string; status?: string; runnerId?: string | null; account?: SeedRefs } = {}): Promise<string> {
    const id = randomUUID();
    const acct = over.account ?? a;
    const owner = over.runnerId === undefined ? runner : over.runnerId;
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, runner_id) VALUES ($1,$2,$3,'executor',$4,$5,$6)`, [id, acct.accountId, acct.workItemId, over.runtime ?? "runner", over.status ?? "succeeded", owner]);
    return id;
  }
  const propose = (runId: string, ...bodies: string[]) => ingestRunnerMemoryProposals({ pool: writerPool, accountId: a.accountId, runnerId: runner, runId, proposals: bodies.map((body) => ({ scope: "item", kind: "command", body })), liveSecrets: () => [LIVE] });
  const rows = async (runId: string) => (await admin.query(`SELECT body, status, author_kind, provenance FROM memory_entries WHERE account_id = $1 AND provenance->>'source_run_id' = $2 ORDER BY created_at, id`, [a.accountId, runId])).rows;
  const events = async (runId: string) => (await admin.query(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'memory.proposals'`, [runId])).rows;

  it("stores a finished runner run's proposals as pending runner_agent entries, leaves one event with indexes and reasons only, and never approves", async () => {
    const runId = await run();
    expect(await propose(runId, "use pnpm, not npm", "tests live under test/")).toEqual({ kind: "ingested", stored: 2, refused: 0 });
    expect(await rows(runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: "use pnpm, not npm", status: "proposed", author_kind: "runner_agent" }),
        expect.objectContaining({ body: "tests live under test/", status: "proposed", author_kind: "runner_agent" }),
      ]),
    );
    expect(await rows(runId)).toHaveLength(2);
    const ev = await events(runId);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ source: "runner_agent", refused: [] });
    expect(JSON.stringify(ev[0].payload)).not.toContain("use pnpm");
  });

  it("runs the same checks as any proposal: a live token value, a credential shape, a fourth proposal, a duplicate and the account scope are refused with the intake's own reasons", async () => {
    const runId = await run();
    const outcome = await ingestRunnerMemoryProposals({
      pool: writerPool, accountId: a.accountId, runnerId: runner, runId, liveSecrets: () => [LIVE],
      proposals: [{ scope: "item", kind: "fact", body: `deploy with token ${LIVE}` }, { scope: "account", kind: "fact", body: "everyone uses tabs" }, { scope: "item", kind: "fact", body: "the build lives in build/" }, { scope: "item", kind: "fact", body: "a fourth one" }],
    });
    // The wire caps a message at three; the worker still refuses a fourth rather than trusting the route.
    expect(outcome).toEqual({ kind: "ingested", stored: 1, refused: 3 });
    const ev = (await events(runId))[0]!.payload as { refused: Array<{ index: number; reason: string }> };
    expect(ev.refused).toEqual([{ index: 0, reason: "secret_detected" }, { index: 1, reason: "account_scope_person_only" }, { index: 3, reason: "over_run_limit" }]);
    expect(JSON.stringify(await rows(runId))).not.toContain(LIVE);
    const again = await run();
    expect(await propose(again, "the build lives in build/")).toEqual({ kind: "ingested", stored: 0, refused: 1 });
    expect(((await events(again))[0]!.payload as { refused: Array<{ reason: string }> }).refused).toEqual([{ index: 0, reason: "duplicate" }]);
  });

  it("takes a run's proposals in once: a second upload for the same run writes nothing", async () => {
    const runId = await run();
    expect(await propose(runId, "first sentence")).toMatchObject({ kind: "ingested", stored: 1 });
    expect(await propose(runId, "second sentence")).toEqual({ kind: "already_ingested", stored: 0, refused: 0 });
    expect(await rows(runId)).toHaveLength(1);
  });

  it("refuses a run that is not this runner's, in this account, or a runner run: run_not_yours, with nothing written", async () => {
    const other = await insertRunner(admin, a.accountId, a.userId);
    const theirs = await run({ runnerId: other });
    const unowned = await run({ runnerId: null });
    const hosted = await run({ runtime: "production", runnerId: null });
    const foreign = await run({ account: b, runnerId: null });
    for (const runId of [theirs, unowned, hosted, foreign, randomUUID()]) {
      expect(await propose(runId, "should not land")).toEqual({ kind: "run_not_yours" });
      expect(await rows(runId)).toHaveLength(0);
      expect(await events(runId)).toHaveLength(0);
    }
    // Another account's runner id with this account's run is the same fixed answer.
    const stranger = await ingestRunnerMemoryProposals({ pool: writerPool, accountId: b.accountId, runnerId: runner, runId: await run(), proposals: [{ scope: "item", kind: "fact", body: "x" }] });
    expect(stranger).toEqual({ kind: "run_not_yours" });
  });

  it("refuses a run that has not ended (run_not_finished) and a runner that never listed the capability (capability_missing)", async () => {
    for (const status of ["running", "pending", "cancelled"]) expect(await propose(await run({ status }), "too early"), status).toEqual({ kind: "run_not_finished" });
    const bare = await insertRunner(admin, a.accountId, a.userId);
    await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [bare, a.accountId, ["tip_publish_v1"]]);
    const mine = await run({ runnerId: bare });
    expect(await ingestRunnerMemoryProposals({ pool: writerPool, accountId: a.accountId, runnerId: bare, runId: mine, proposals: [{ scope: "item", kind: "fact", body: "no capability" }] })).toEqual({ kind: "capability_missing" });
    expect(await rows(mine)).toHaveLength(0);
    // A runner with no capability row at all (an old runner) is the same.
    const old = await insertRunner(admin, a.accountId, a.userId);
    expect(await ingestRunnerMemoryProposals({ pool: writerPool, accountId: a.accountId, runnerId: old, runId: await run({ runnerId: old }), proposals: [{ scope: "item", kind: "fact", body: "old runner" }] })).toEqual({ kind: "capability_missing" });
  });

  it("a repository proposal whose repository has no stored node id is refused scope_unresolved: the key is never the runner's", async () => {
    const runId = await run();
    const out = await ingestRunnerMemoryProposals({ pool: writerPool, accountId: a.accountId, runnerId: runner, runId, proposals: [{ scope: "repo", kind: "fact", body: "repo-wide note" }], liveSecrets: () => [] });
    expect(out).toEqual({ kind: "ingested", stored: 0, refused: 1 });
    expect(((await events(runId))[0]!.payload as { refused: Array<{ reason: string }> }).refused).toEqual([expect.objectContaining({ reason: "scope_unresolved" })]);
  });

  it("a role proposal sent before the item is done is refused for good (item_not_terminal): a runner run has no later pass, so the runner never offers role lessons", async () => {
    const runId = await run();
    const out = await ingestRunnerMemoryProposals({ pool: writerPool, accountId: a.accountId, runnerId: runner, runId, proposals: [{ scope: "role", kind: "gotcha", body: "executors forget the lockfile" }], liveSecrets: () => [] });
    expect(out).toEqual({ kind: "ingested", stored: 0, refused: 1 });
    expect(((await events(runId))[0]!.payload as { refused: Array<{ reason: string }> }).refused).toEqual([expect.objectContaining({ reason: "item_not_terminal" })]);
  });

  it("the existing guard is unchanged: the stored envelope of a runner run is still never ingested, and the facade passes the runner pool through", async () => {
    const runId = await run();
    expect(await ingestRunMemoryProposals({ pool: writerPool, accountId: a.accountId, runId, envelope: { memory_proposals: [{ scope: "item", kind: "command", body: "from the envelope" }] } })).toEqual({ status: "skipped_runner" });
    expect(await rows(runId)).toHaveLength(0);
    const facade = createRunnerMemoryProposalsFacade(writerPool);
    expect(await facade.memoryProposals({ accountId: a.accountId, runnerId: runner, runId, proposals: [{ scope: "item", kind: "command", body: "through the facade" }] })).toEqual({ kind: "ingested", stored: 1, refused: 0 });
  });
});
