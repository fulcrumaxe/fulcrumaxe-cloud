import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { claimWithinHeadroom, enqueueForCapacity, markStarted, readCapacityState } from "../src/advance/capacityQueue.js";

/**
 * [pg] D#483 S5-k3b-h (migration 0958): the two definer tie-ins, as the real roles. `capacity_enqueue` refuses an item that is not on the repository it names, and
 * `capacity_mark_started` records only a sandbox run. The 0941 and 0943 suites (capacityQueue.pg, capacityQueueReads.pg) run unchanged beside this one.
 */
const h = pgHarness();

async function account(): Promise<{ accountId: string; repoId: string; otherRepoId: string; item: string; otherItem: string }> {
  const accountId = randomUUID();
  const refs = await seedAccount(h.admin, accountId);
  await h.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE account_id = $1`, [accountId]);
  // a second repository of the SAME account, and an item on it
  const otherRepoId = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) SELECT $1, account_id, installation_id, gh_repo_id + 100, product FROM repos WHERE id = $2`, [otherRepoId, refs.repoId]);
  const otherItem = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [otherItem, accountId, otherRepoId]);
  return { accountId, repoId: refs.repoId, otherRepoId, item: refs.workItemId, otherItem };
}
const asks = (accountId: string, item: string) =>
  h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, stage, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'waiting_for_capacity', 'build', $3)`, [accountId, item, randomUUID()]);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? "no code");

beforeEach(async () => {
  await h.admin.query(`DELETE FROM capacity_queue`);
});

describe("migration 0958: the definer tie-ins [pg]", () => {
  it("C27-k3h-4: capacity_enqueue refuses an item of another repository in the same account (foreign_key_violation) and writes nothing; the item's own repository queues it", async () => {
    const a = await account();
    expect(await refusal(enqueueForCapacity(h.runWriterPool, a.accountId, { repoId: a.repoId, workItemId: a.otherItem, runKind: "build" }))).toBe("23503");
    expect(await refusal(enqueueForCapacity(h.runWriterPool, a.accountId, { repoId: a.otherRepoId, workItemId: a.item, runKind: "build" }))).toBe("23503");
    // an item id that is no item at all is refused the same way
    expect(await refusal(enqueueForCapacity(h.runWriterPool, a.accountId, { repoId: a.repoId, workItemId: randomUUID(), runKind: "build" }))).toBe("23503");
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM capacity_queue WHERE account_id = $1`, [a.accountId])).rows[0].n).toBe(0);
    const ok = await enqueueForCapacity(h.runWriterPool, a.accountId, { repoId: a.otherRepoId, workItemId: a.otherItem, runKind: "build" });
    expect(ok.entry.created).toBe(true);
  });

  it("C27-k3h-4: capacity_mark_started answers false for a runner run of the entry's own item and records nothing; a sandbox run of it is recorded", async () => {
    const a = await account();
    await enqueueForCapacity(h.runWriterPool, a.accountId, { repoId: a.repoId, workItemId: a.item, runKind: "build" });
    await asks(a.accountId, a.item);
    const { slotsInUse } = await readCapacityState(h.runWriterPool, () => 0);
    const { claimed } = await claimWithinHeadroom(h.runWriterPool, () => slotsInUse + 1);
    const entry = claimed.find((c) => c.workItemId === a.item)!;
    expect(entry).toBeDefined();
    const run = async (mode: string, runtime: string) => {
      const id = randomUUID();
      await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode) VALUES ($1, $2, $3, 'executor', $4, 'pending', $5)`, [id, a.accountId, a.item, runtime, mode]);
      return id;
    };
    for (const mode of ["runner_local", "runner_verified"]) expect(await markStarted(h.runWriterPool, entry, await run(mode, "runner")), mode).toBe(false);
    expect((await h.admin.query(`SELECT started_run_id FROM capacity_queue WHERE id = $1`, [entry.id])).rows[0].started_run_id).toBeNull();
    const sandbox = await run("sandbox", "production");
    expect(await markStarted(h.runWriterPool, entry, sandbox)).toBe(true);
    expect((await h.admin.query(`SELECT started_run_id FROM capacity_queue WHERE id = $1`, [entry.id])).rows[0].started_run_id).toBe(sandbox);
  });

  it("C27-k3h-6: the replaced definers keep 0941's bracket, and the definer role reads exactly one more column", async () => {
    const { rows } = await h.admin.query(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              array_agg(DISTINCT pg_get_userbyid(a.grantee) ORDER BY pg_get_userbyid(a.grantee)) FILTER (WHERE a.grantee <> p.proowner AND a.grantee <> 0) AS grantees,
              coalesce(bool_or(a.grantee = 0), false) AS public
         FROM pg_proc p LEFT JOIN LATERAL aclexplode(p.proacl) a ON true
        WHERE p.proname IN ('capacity_enqueue', 'capacity_mark_started') GROUP BY p.proname, p.proowner, p.prosecdef, p.proconfig ORDER BY p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(["capacity_enqueue", "capacity_mark_started"]);
    for (const r of rows) expect(r, r.proname).toMatchObject({ owner: "capacity_queue_definer", definer: true, config: ["search_path=pg_catalog, public, pg_temp"], grantees: "{agent_run_writer}", public: false });
    const cols = await h.admin.query(`SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'capacity_queue_definer' AND table_name = 'work_items' AND privilege_type = 'SELECT' ORDER BY column_name`);
    expect(cols.rows.map((r) => r.column_name)).toEqual(["account_id", "halted_at", "id", "repo_id", "stage"]);
  });
});
