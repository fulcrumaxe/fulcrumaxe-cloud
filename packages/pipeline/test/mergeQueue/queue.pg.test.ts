import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import {
  MAX_CONFLICT_ROUNDS,
  MERGE_QUEUE_LEASE_SECONDS,
  cancelRepoEntries,
  cancelWorkItemEntry,
  countAhead,
  enqueueEntry,
  finishWork,
  getEntry,
  markMerged,
  readQueue,
  recordHeadRefresh,
  releaseForWork,
  releaseToQueue,
  renewSlot,
  returnToReview,
  settlePullRequest,
  stopEntry,
  sweepMergeQueue,
  listMergeQueueSweepTargets,
  takeSlot,
  reclaimExpiredLeases,
  type MergeQueueEntry,
  type PrFacts,
} from "../../src/mergeQueue/index.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#519 MQ2: the queue core against real Postgres, through a plain `app_user` pool (row security and column grants in force). Covers
 * acceptance 8 to 13 and the undo paths of the Spec's table that the core owns.
 */
const T0 = new Date("2026-10-15T10:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const sha = (c: string) => c.repeat(40);

describe("D#519 MQ2 merge queue core [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn);

  interface World {
    accountId: string;
    repoId: string;
  }

  async function world(): Promise<World> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, repoId };
  }

  /** Enqueues a PR as its own work item. `approvedAfter` is seconds after T0. */
  async function enqueue(w: World, prNumber: number, approvedAfter: number, over: { dependsOn?: number; head?: string } = {}): Promise<MergeQueueEntry> {
    const workItemId = randomUUID();
    await seedWorkItem(db.admin, w.accountId, workItemId, w.repoId, { ghNumber: prNumber });
    const { entry, outcome } = await tenant(w.accountId, (c) =>
      enqueueEntry(c, {
        accountId: w.accountId,
        repoId: w.repoId,
        workItemId,
        prNumber,
        headSha: over.head ?? sha("a"),
        dependsOnPrNumber: over.dependsOn ?? null,
        approvedAt: at(approvedAfter),
      }),
    );
    expect(outcome).toBe("created");
    return entry;
  }

  const open: PrFacts = { open: true, draft: false };
  const factsFor = (entries: Array<{ id: string }>) => new Map(entries.map((e) => [e.id, open] as const));
  const take = (w: World, holder: string, facts: ReadonlyMap<string, PrFacts>, now: Date = T0) =>
    tenant(w.accountId, (c) => takeSlot(c, { accountId: w.accountId, repoId: w.repoId, holder, facts, now }));
  const row = async (id: string) =>
    (await db.admin.query(`SELECT * FROM merge_queue_entries WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
  const inFlight = async (w: World) =>
    (await db.admin.query<{ id: string; slot_holder: string }>(`SELECT id, slot_holder FROM merge_queue_entries WHERE account_id = $1 AND repo_id = $2 AND state = 'in_flight'`, [w.accountId, w.repoId])).rows;

  /** An open tenant transaction on its own connection, so a test can interleave two transactions by hand. */
  async function openTx(pool: Pool, accountId: string): Promise<PoolClient> {
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
    return client;
  }
  const finish = async (client: PoolClient, how: "COMMIT" | "ROLLBACK") => {
    try {
      await client.query(how);
    } finally {
      client.release();
    }
  };

  /** Polls until some session is actually waiting on a lock, so an interleave is proven, not assumed. */
  async function waitForLockWait(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const { rows } = await db.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
      );
      if (rows[0]!.n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no session started waiting on a lock");
  }

  // ---- 8 ---------------------------------------------------------------------------------------------------------------------

  describe("acceptance 8: one holder per repo, enforced by the database", () => {
    it("two concurrent attempts on separate connections: exactly one holds the slot", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const b = await enqueue(w, 2, 1);
      const facts = factsFor([a, b]);
      const results = await Promise.all([take(w, "tick-1", facts), take(w, "tick-2", facts)]);
      expect(results.filter((r) => r.taken)).toHaveLength(1);
      expect(results.find((r) => !r.taken)?.skipped).toMatch(/^(lost_race|slot_busy)$/);
      expect(await inFlight(w)).toHaveLength(1);
    });

    it("two attempts that choose different entries: the partial unique index rejects the second", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const b = await enqueue(w, 2, 1);
      // Each attempt is told only one entry is eligible, so both pass the "nobody holds it" read and race to the write.
      const first = await openTx(db.pureAppUserPool, w.accountId);
      const second = await openTx(db.pureAppUserPool, w.accountId);
      try {
        const t1 = await takeSlot(first, { accountId: w.accountId, repoId: w.repoId, holder: "tick-1", facts: factsFor([a]), now: T0 });
        expect(t1.taken?.id).toBe(a.id);
        const pending = takeSlot(second, { accountId: w.accountId, repoId: w.repoId, holder: "tick-2", facts: factsFor([b]), now: T0 });
        await waitForLockWait(); // the second write is blocked on the first one's uncommitted index entry
        await finish(first, "COMMIT");
        const t2 = await pending;
        expect(t2.taken).toBeNull();
        expect(t2.skipped).toBe("slot_busy");
        await finish(second, "COMMIT");
      } catch (err) {
        first.release();
        second.release();
        throw err;
      }
      const held = await inFlight(w);
      expect(held).toEqual([{ id: a.id, slot_holder: "tick-1" }]);
    });

    it("the index itself refuses a second in-flight row for a repo (a direct write, not this code)", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const b = await enqueue(w, 2, 1);
      const set = (id: string) =>
        db.admin.query(
          `UPDATE merge_queue_entries SET state = 'in_flight', slot_holder = 'x', slot_taken_at = now(), lease_until = now() + interval '5 minutes' WHERE id = $1`,
          [id],
        );
      await set(a.id);
      await expect(set(b.id)).rejects.toMatchObject({ code: "23505", constraint: "merge_queue_one_in_flight" });
    });

    it("different repos each have their own slot", async () => {
      const w = await world();
      const otherRepo = randomUUID();
      await seedRepo(db.admin, w.accountId, otherRepo);
      const a = await enqueue(w, 1, 0);
      const b = await enqueue({ ...w, repoId: otherRepo }, 1, 0);
      expect((await take(w, "h1", factsFor([a]))).taken?.id).toBe(a.id);
      expect((await take({ ...w, repoId: otherRepo }, "h2", factsFor([b]))).taken?.id).toBe(b.id);
    });
  });

  // ---- 9 ---------------------------------------------------------------------------------------------------------------------

  describe("acceptance 9: order", () => {
    it("the slot goes to the earliest approved_at, then the lowest PR number", async () => {
      const w = await world();
      const late = await enqueue(w, 3, 30);
      const tieHigh = await enqueue(w, 9, 10);
      const tieLow = await enqueue(w, 7, 10);
      const facts = factsFor([late, tieHigh, tieLow]);
      const order: number[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await take(w, `h${i}`, facts);
        order.push(r.taken!.prNumber);
        await tenant(w.accountId, (c) => markMerged(c, { accountId: w.accountId, entryId: r.taken!.id, mergedBy: "gate", holder: `h${i}` }));
      }
      expect(order).toEqual([7, 9, 3]);
    });

    it("an ineligible earlier entry does not stop a later eligible one", async () => {
      const w = await world();
      const draft = await enqueue(w, 1, 0);
      const ready = await enqueue(w, 2, 5);
      const facts = new Map<string, PrFacts>([
        [draft.id, { open: true, draft: true }],
        [ready.id, open],
      ]);
      const r = await take(w, "h", facts);
      expect(r.taken?.id).toBe(ready.id);
      expect((await row(draft.id)).state).toBe("queued");
    });

    it("a fix round and an entry in review are not eligible, and keep their place", async () => {
      const w = await world();
      const first = await enqueue(w, 1, 0);
      const second = await enqueue(w, 2, 5);
      const taken = await take(w, "h", factsFor([first, second]));
      expect(taken.taken?.id).toBe(first.id);
      const released = await tenant(w.accountId, (c) => releaseForWork(c, { accountId: w.accountId, entryId: first.id, holder: "h", kind: "conflict" }));
      expect(released.ok).toBe(true);
      expect((await take(w, "h2", factsFor([first, second]))).taken?.id).toBe(second.id);
      await tenant(w.accountId, (c) => releaseToQueue(c, { accountId: w.accountId, entryId: second.id, holder: "h2" }));
      // The fix round finishes: the first entry is ahead of the second again, at its original position.
      await tenant(w.accountId, (c) => finishWork(c, { accountId: w.accountId, entryId: first.id }));
      expect((await take(w, "h3", factsFor([first, second]))).taken?.id).toBe(first.id);
    });

    it("counts how many entries are ahead, computed from the rows", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const b = await enqueue(w, 2, 5);
      const c3 = await enqueue(w, 3, 9);
      expect(await tenant(w.accountId, (c) => countAhead(c, w.accountId, c3.id))).toBe(2);
      await take(w, "h", factsFor([a, b, c3]));
      expect(await tenant(w.accountId, (c) => countAhead(c, w.accountId, a.id))).toBe(0);
      expect(await tenant(w.accountId, (c) => countAhead(c, w.accountId, b.id))).toBe(1);
      expect(await tenant(w.accountId, (c) => countAhead(c, w.accountId, c3.id))).toBe(2);
    });
  });

  // ---- 10 --------------------------------------------------------------------------------------------------------------------

  describe("acceptance 10: stacked children", () => {
    it("a child waits until its parent's entry is merged", async () => {
      const w = await world();
      const child = await enqueue(w, 21, 0, { dependsOn: 20 });
      const parent = await enqueue(w, 20, 50);
      const facts = factsFor([child, parent]);
      // The child is earlier in the queue but its parent is not merged: the parent goes first.
      const first = await take(w, "h1", facts);
      expect(first.taken?.id).toBe(parent.id);
      await tenant(w.accountId, (c) => markMerged(c, { accountId: w.accountId, entryId: parent.id, mergedBy: "gate", holder: "h1" }));
      const second = await take(w, "h2", facts);
      expect(second.taken?.id).toBe(child.id);
    });

    it("a child whose parent has no entry yet waits", async () => {
      const w = await world();
      const child = await enqueue(w, 21, 0, { dependsOn: 20 });
      const r = await take(w, "h", factsFor([child]));
      expect(r).toMatchObject({ taken: null, skipped: "nothing_eligible" });
      expect((await row(child.id)).state).toBe("queued");
    });

    it("a parent closed without merging sends the child to merge_dependency_closed", async () => {
      const w = await world();
      const parent = await enqueue(w, 20, 0);
      const child = await enqueue(w, 21, 1, { dependsOn: 20 });
      await tenant(w.accountId, (c) => settlePullRequest(c, { accountId: w.accountId, repoId: w.repoId, prNumber: 20, merged: false }));
      const r = await take(w, "h", factsFor([parent, child]));
      expect(r.taken).toBeNull();
      expect(r.stopped.map((e) => e.id)).toEqual([child.id]);
      expect(await row(child.id)).toMatchObject({ state: "stopped", reason: "merge_dependency_closed" });
    });

    it("a parent whose item was cancelled stops the child the same way", async () => {
      const w = await world();
      const parent = await enqueue(w, 20, 0);
      const child = await enqueue(w, 21, 1, { dependsOn: 20 });
      await tenant(w.accountId, (c) => cancelWorkItemEntry(c, { accountId: w.accountId, workItemId: parent.workItemId! }));
      await take(w, "h", factsFor([parent, child]));
      expect(await row(child.id)).toMatchObject({ state: "stopped", reason: "merge_dependency_closed" });
    });

    it("a parent merged by a person outside the queue releases the child", async () => {
      const w = await world();
      const parent = await enqueue(w, 20, 0);
      const child = await enqueue(w, 21, 1, { dependsOn: 20 });
      const merged = await tenant(w.accountId, (c) => settlePullRequest(c, { accountId: w.accountId, repoId: w.repoId, prNumber: 20, merged: true }));
      expect(merged).toMatchObject({ state: "merged", mergedBy: "person" });
      expect((await take(w, "h", factsFor([parent, child]))).taken?.id).toBe(child.id);
    });

    it("readQueue keeps a final parent only while a live child names it", async () => {
      const w = await world();
      const parent = await enqueue(w, 20, 0);
      const child = await enqueue(w, 21, 1, { dependsOn: 20 });
      await tenant(w.accountId, (c) => settlePullRequest(c, { accountId: w.accountId, repoId: w.repoId, prNumber: 20, merged: true }));
      expect((await tenant(w.accountId, (c) => readQueue(c, w.accountId, w.repoId))).map((e) => e.prNumber)).toEqual([20, 21]);
      await tenant(w.accountId, (c) => cancelWorkItemEntry(c, { accountId: w.accountId, workItemId: child.workItemId! }));
      expect(await tenant(w.accountId, (c) => readQueue(c, w.accountId, w.repoId))).toEqual([]);
      expect(parent.id).toBeTruthy();
    });
  });

  // ---- 11 --------------------------------------------------------------------------------------------------------------------

  describe("acceptance 11: leases", () => {
    const sweep = (w: World, now: Date) => {
      const seen = new Set<string>();
      return sweepMergeQueue({
        listTargets: async (n, limit) => (await listMergeQueueSweepTargets(db.runWriterPool, n, limit)).filter((t) => t.accountId === w.accountId && !seen.has(t.repoId)),
        inTenant: (accountId, fn) => withTenant(db.pureAppUserPool, accountId, fn),
        now,
      });
    };

    it("the sweep reclaims an expired lease and the entry is eligible again at its original position", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const b = await enqueue(w, 2, 5);
      const facts = factsFor([a, b]);
      expect((await take(w, "crashed", facts, T0)).taken?.id).toBe(a.id);

      // Still inside the lease: the sweep leaves the holder alone.
      const early = await sweep(w, at(MERGE_QUEUE_LEASE_SECONDS - 1));
      expect(early.reclaimed).toBe(0);
      expect((await inFlight(w)).map((r) => r.id)).toEqual([a.id]);

      const late = await sweep(w, at(MERGE_QUEUE_LEASE_SECONDS));
      expect(late.reclaimed).toBe(1);
      expect(await inFlight(w)).toEqual([]);
      expect(await row(a.id)).toMatchObject({ state: "queued", slot_holder: null, lease_until: null });
      // a is still ahead of b.
      expect((await take(w, "next", facts, at(MERGE_QUEUE_LEASE_SECONDS + 1))).taken?.id).toBe(a.id);
    });

    it("a take reclaims a lapsed lease itself, so a stuck repo does not wait for the sweep", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await take(w, "crashed", factsFor([a]), T0);
      const r = await take(w, "next", factsFor([a]), at(MERGE_QUEUE_LEASE_SECONDS + 5));
      expect(r.reclaimed.map((e) => e.id)).toEqual([a.id]);
      expect(r.taken?.slotHolder).toBe("next");
    });

    it("a late renewal never revives a lapsed lease", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await take(w, "slow", factsFor([a]), T0);
      const renewed = await tenant(w.accountId, (c) => renewSlot(c, { accountId: w.accountId, entryId: a.id, holder: "slow", phase: "ci", now: at(60) }));
      expect(renewed?.phase).toBe("ci");
      expect(renewed!.leaseUntil!.getTime()).toBe(at(60 + MERGE_QUEUE_LEASE_SECONDS).getTime());
      const late = await tenant(w.accountId, (c) => renewSlot(c, { accountId: w.accountId, entryId: a.id, holder: "slow", now: at(60 + MERGE_QUEUE_LEASE_SECONDS) }));
      expect(late).toBeNull();
      const stranger = await tenant(w.accountId, (c) => renewSlot(c, { accountId: w.accountId, entryId: a.id, holder: "someone-else", now: at(61) }));
      expect(stranger).toBeNull();
    });

    it("a tick racing the sweep never ends with two holders (the sweep reclaims first)", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await take(w, "crashed", factsFor([a]), T0);
      const now = at(MERGE_QUEUE_LEASE_SECONDS + 10);

      const sweepTx = await openTx(db.pureAppUserPool, w.accountId);
      try {
        const reclaimed = await reclaimExpiredLeases(sweepTx, { accountId: w.accountId, repoId: w.repoId, now });
        expect(reclaimed).toHaveLength(1);
        // The tick starts while the sweep's change is uncommitted: its own reclaim waits on the row.
        const tick = take(w, "tick", factsFor([a]), now);
        await waitForLockWait();
        await finish(sweepTx, "COMMIT");
        const result = await tick;
        expect(result.taken?.slotHolder).toBe("tick");
      } catch (err) {
        sweepTx.release();
        throw err;
      }
      expect(await inFlight(w)).toEqual([{ id: a.id, slot_holder: "tick" }]);
    });

    it("a tick racing the sweep never ends with two holders (the tick takes first)", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await take(w, "crashed", factsFor([a]), T0);
      const now = at(MERGE_QUEUE_LEASE_SECONDS + 10);

      const tickTx = await openTx(db.pureAppUserPool, w.accountId);
      try {
        const t = await takeSlot(tickTx, { accountId: w.accountId, repoId: w.repoId, holder: "tick", facts: factsFor([a]), now });
        expect(t.taken?.slotHolder).toBe("tick");
        // The sweep, a moment later in wall time but with the same instant, runs while the tick's take is uncommitted.
        const sweeping = withTenant(db.pureAppUserPool, w.accountId, (c) => reclaimExpiredLeases(c, { accountId: w.accountId, repoId: w.repoId, now }));
        await waitForLockWait();
        await finish(tickTx, "COMMIT");
        // The row now carries a fresh lease, so the sweep finds nothing to reclaim.
        expect(await sweeping).toEqual([]);
      } catch (err) {
        tickTx.release();
        throw err;
      }
      expect(await inFlight(w)).toEqual([{ id: a.id, slot_holder: "tick" }]);
    });

    it("the sweep lists only repos that need a tick, and hands each to the tick after reclaiming", async () => {
      const w = await world();
      const quiet = randomUUID();
      await seedRepo(db.admin, w.accountId, quiet);
      const a = await enqueue(w, 1, 0);
      await enqueue({ ...w, repoId: quiet }, 1, 0);
      await take({ ...w, repoId: quiet }, "live", factsFor([{ id: (await tenant(w.accountId, (c) => readQueue(c, w.accountId, quiet)))[0]!.id }]), T0);
      await take(w, "crashed", factsFor([a]), T0);

      const ticked: string[] = [];
      const now = at(MERGE_QUEUE_LEASE_SECONDS - 1); // the `quiet` repo's lease is live; so is the first repo's
      const mine = (t: { accountId: string }) => t.accountId === w.accountId;
      const noneYet = await sweepMergeQueue({
        listTargets: async (n, l) => (await listMergeQueueSweepTargets(db.runWriterPool, n, l)).filter(mine),
        inTenant: (id, fn) => withTenant(db.pureAppUserPool, id, fn),
        tick: async (t) => void ticked.push(t.repoId),
        now,
      });
      expect(noneYet).toMatchObject({ listed: 0, reclaimed: 0, ticked: 0 });

      const expired = await sweepMergeQueue({
        listTargets: async (n, l) => (await listMergeQueueSweepTargets(db.runWriterPool, n, l)).filter(mine),
        inTenant: (id, fn) => withTenant(db.pureAppUserPool, id, fn),
        tick: async (t) => void ticked.push(t.repoId),
        now: at(MERGE_QUEUE_LEASE_SECONDS + 1),
      });
      expect(expired).toMatchObject({ listed: 2, reclaimed: 2, ticked: 2, failed: 0 });
      expect(ticked.sort()).toEqual([w.repoId, quiet].sort());
    });

    it("lists a repo with a queued entry and nobody holding the slot (a lost tick)", async () => {
      const w = await world();
      await enqueue(w, 1, 0);
      const targets = (await listMergeQueueSweepTargets(db.runWriterPool, T0, 200)).filter((t) => t.accountId === w.accountId);
      expect(targets).toEqual([{ accountId: w.accountId, repoId: w.repoId }]);
    });

    it("clamps the lister's limit to 1..200", async () => {
      const w = await world();
      await db.admin.query(
        `INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode)
         SELECT gen_random_uuid(), $1, 7000000000 + g, 'team', 'sandbox' FROM generate_series(1, 205) g`,
        [w.accountId],
      );
      await db.admin.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number)
         SELECT gen_random_uuid(), account_id, id, 'feature', 'running', 'internal', 1 FROM repos WHERE account_id = $1`,
        [w.accountId],
      );
      await db.admin.query(
        `INSERT INTO merge_queue_entries (account_id, repo_id, work_item_id, pr_number, head_sha, approved_at)
         SELECT account_id, repo_id, id, 1, repeat('a', 40), now() FROM work_items WHERE account_id = $1`,
        [w.accountId],
      );
      const n = async (limit: number) => (await listMergeQueueSweepTargets(db.runWriterPool, undefined, limit)).length;
      expect(await n(0)).toBe(1);
      expect(await n(-5)).toBe(1);
      expect(await n(1)).toBe(1);
      expect(await n(7)).toBe(7);
      expect(await n(200)).toBe(200);
      expect(await n(201)).toBe(200);
      expect(await n(100000)).toBe(200);
    });

    it("the lister is for the run-writer login only, and answers ids and nothing else", async () => {
      await expect(db.pureAppUserPool.query(`SELECT * FROM merge_queue_sweep_targets(now(), 10)`)).rejects.toMatchObject({ code: "42501" });
      const { fields } = await db.runWriterPool.query(`SELECT * FROM merge_queue_sweep_targets(now(), 1)`);
      expect(fields.map((f) => f.name)).toEqual(["account_id", "repo_id"]);
    });
  });

  // ---- 12 --------------------------------------------------------------------------------------------------------------------

  describe("acceptance 12: restart", () => {
    it("a fresh process reloads the entries and the holder from Postgres alone and continues the same order", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const b = await enqueue(w, 2, 5);
      const c3 = await enqueue(w, 3, 9);
      const facts = factsFor([a, b, c3]);
      expect((await take(w, "proc-1", facts)).taken?.id).toBe(a.id);
      await tenant(w.accountId, (c) => renewSlot(c, { accountId: w.accountId, entryId: a.id, holder: "proc-1", phase: "gate", now: at(30) }));

      // "Restart": a brand new pool, with nothing carried over but the database.
      const fresh = createPool(process.env.PIPELINE_DATABASE_URL_APP_USER!);
      try {
        const queue = await withTenant(fresh, w.accountId, (c) => readQueue(c, w.accountId, w.repoId));
        expect(queue.map((e) => [e.prNumber, e.state])).toEqual([[1, "in_flight"], [2, "queued"], [3, "queued"]]);
        expect(queue[0]).toMatchObject({ slotHolder: "proc-1", phase: "gate" });
        expect(queue[0]!.approvedAt.getTime()).toBe(a.approvedAt.getTime());

        // The holder finishes; the new process's tick takes the next entry in the same order.
        const merged = await withTenant(fresh, w.accountId, (c) => markMerged(c, { accountId: w.accountId, entryId: a.id, mergedBy: "gate", holder: "proc-1" }));
        expect(merged?.state).toBe("merged");
        const next = await withTenant(fresh, w.accountId, (c) => takeSlot(c, { accountId: w.accountId, repoId: w.repoId, holder: "proc-2", facts, now: at(40) }));
        expect(next.taken?.id).toBe(b.id);
      } finally {
        await fresh.end();
      }
    });
  });

  // ---- 13 --------------------------------------------------------------------------------------------------------------------

  describe("acceptance 13: starting an agent run releases the slot in the same transaction", () => {
    it("the slot and the recorded round change together, and only when the transaction commits", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const b = await enqueue(w, 2, 5);
      await take(w, "h", factsFor([a, b]));
      const runId = randomUUID();

      const tx = await openTx(db.pureAppUserPool, w.accountId);
      try {
        const r = await releaseForWork(tx, { accountId: w.accountId, entryId: a.id, holder: "h", kind: "conflict", runId });
        expect(r.ok).toBe(true);
        // Seen from another connection, before the commit: nothing has changed yet, in either half.
        expect(await row(a.id)).toMatchObject({ state: "in_flight", slot_holder: "h", work_kind: null, work_run_id: null, conflict_rounds: 0 });
        await finish(tx, "COMMIT");
      } catch (err) {
        tx.release();
        throw err;
      }
      // After the commit, both halves at once: the run is recorded and the slot is free, while the run has not finished.
      expect(await row(a.id)).toMatchObject({ state: "awaiting_work", slot_holder: null, lease_until: null, work_kind: "conflict", work_run_id: runId, conflict_rounds: 1 });
      expect(await inFlight(w)).toEqual([]);
      expect((await take(w, "other", factsFor([a, b]))).taken?.id).toBe(b.id);
    });

    it("a rolled-back start leaves the slot held and no round recorded", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await take(w, "h", factsFor([a]));
      const tx = await openTx(db.pureAppUserPool, w.accountId);
      try {
        await releaseForWork(tx, { accountId: w.accountId, entryId: a.id, holder: "h", kind: "renumber", runId: randomUUID() });
        await finish(tx, "ROLLBACK");
      } catch (err) {
        tx.release();
        throw err;
      }
      expect(await row(a.id)).toMatchObject({ state: "in_flight", slot_holder: "h", work_kind: null, conflict_rounds: 0 });
    });

    it("only the holder can release for work, and a third conflict or renumber round is refused", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await take(w, "h", factsFor([a]));
      const stranger = await tenant(w.accountId, (c) => releaseForWork(c, { accountId: w.accountId, entryId: a.id, holder: "nope", kind: "delta_review" }));
      expect(stranger).toEqual({ ok: false, reason: "slot_lost" });

      // Conflict and renumber rounds share the bound; each round ends (finishWork) and the entry takes the slot again.
      const kinds = ["conflict", "renumber"] as const;
      let holder = "h";
      for (let round = 0; round < MAX_CONFLICT_ROUNDS; round++) {
        const r = await tenant(w.accountId, (c) => releaseForWork(c, { accountId: w.accountId, entryId: a.id, holder, kind: kinds[round]! }));
        expect(r.ok).toBe(true);
        await tenant(w.accountId, (c) => finishWork(c, { accountId: w.accountId, entryId: a.id }));
        holder = `r${round + 1}`;
        expect((await take(w, holder, factsFor([a]))).taken?.id).toBe(a.id);
      }
      const third = await tenant(w.accountId, (c) => releaseForWork(c, { accountId: w.accountId, entryId: a.id, holder, kind: "conflict" }));
      expect(third).toEqual({ ok: false, reason: "rounds_exhausted" });
      expect(await row(a.id)).toMatchObject({ state: "in_flight", conflict_rounds: MAX_CONFLICT_ROUNDS });
      const delta = await tenant(w.accountId, (c) => releaseForWork(c, { accountId: w.accountId, entryId: a.id, holder, kind: "delta_review" }));
      expect(delta.ok).toBe(true);
    });

    it("finishWork can carry the head the work produced", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await take(w, "h", factsFor([a]));
      await tenant(w.accountId, (c) => releaseForWork(c, { accountId: w.accountId, entryId: a.id, holder: "h", kind: "delta_review" }));
      const done = await tenant(w.accountId, (c) => finishWork(c, { accountId: w.accountId, entryId: a.id, headSha: sha("b") }));
      expect(done).toMatchObject({ state: "queued", headSha: sha("b"), workKind: null });
      expect(await tenant(w.accountId, (c) => finishWork(c, { accountId: w.accountId, entryId: a.id }))).toBeNull();
    });
  });

  // ---- enqueue, undo paths, guards --------------------------------------------------------------------------------------------

  describe("enqueue and the undo paths", () => {
    it("enqueue is idempotent per work item and keeps approved_at when the item comes back", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const again = await tenant(w.accountId, (c) =>
        enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId: a.workItemId!, prNumber: 1, headSha: sha("a"), approvedAt: at(999) }),
      );
      expect(again.outcome).toBe("unchanged");

      await take(w, "h", factsFor([a]));
      const back = await tenant(w.accountId, (c) => returnToReview(c, { accountId: w.accountId, entryId: a.id }));
      expect(back).toMatchObject({ state: "in_review", slotHolder: null });
      expect(back!.approvedAt.getTime()).toBe(a.approvedAt.getTime());

      // Reviewed again on a new head, much later: back in the queue at the ORIGINAL position.
      const requeued = await tenant(w.accountId, (c) =>
        enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId: a.workItemId!, prNumber: 1, headSha: sha("c"), approvedAt: at(5000) }),
      );
      expect(requeued.outcome).toBe("requeued");
      expect(requeued.entry).toMatchObject({ state: "queued", headSha: sha("c") });
      expect(requeued.entry.approvedAt.getTime()).toBe(a.approvedAt.getTime());
    });

    it("a new reviewed head while the entry holds the slot releases the slot", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await take(w, "h", factsFor([a]));
      const r = await tenant(w.accountId, (c) =>
        enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId: a.workItemId!, prNumber: 1, headSha: sha("d"), approvedAt: at(1) }),
      );
      expect(r.outcome).toBe("requeued");
      expect(await inFlight(w)).toEqual([]);
    });

    it("a final entry is never re-enqueued, and a different PR for the same item is refused", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await tenant(w.accountId, (c) => settlePullRequest(c, { accountId: w.accountId, repoId: w.repoId, prNumber: 1, merged: true }));
      const r = await tenant(w.accountId, (c) =>
        enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId: a.workItemId!, prNumber: 1, headSha: sha("e"), approvedAt: at(1) }),
      );
      expect(r.outcome).toBe("final");
      await expect(
        tenant(w.accountId, (c) => enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId: a.workItemId!, prNumber: 2, headSha: sha("e"), approvedAt: at(1) })),
      ).rejects.toMatchObject({ code: "entry_pr_mismatch" });
    });

    it("cancelling the item ends its entry and frees the slot", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await take(w, "h", factsFor([a]));
      const c1 = await tenant(w.accountId, (c) => cancelWorkItemEntry(c, { accountId: w.accountId, workItemId: a.workItemId! }));
      expect(c1).toMatchObject({ state: "cancelled", reason: "work_item_cancelled", slotHolder: null });
      expect(await inFlight(w)).toEqual([]);
    });

    it("a PR closed by a person ends its entry; one merged by a person is recorded as such", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const b = await enqueue(w, 2, 1);
      await take(w, "h", factsFor([a, b]));
      const closed = await tenant(w.accountId, (c) => settlePullRequest(c, { accountId: w.accountId, repoId: w.repoId, prNumber: 1, merged: false }));
      expect(closed).toMatchObject({ state: "closed", slotHolder: null });
      const merged = await tenant(w.accountId, (c) => settlePullRequest(c, { accountId: w.accountId, repoId: w.repoId, prNumber: 2, merged: true }));
      expect(merged).toMatchObject({ state: "merged", mergedBy: "person" });
      expect(await tenant(w.accountId, (c) => settlePullRequest(c, { accountId: w.accountId, repoId: w.repoId, prNumber: 2, merged: true }))).toBeNull();
    });

    it("a disconnected repo cancels every live entry", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const b = await enqueue(w, 2, 1);
      await take(w, "h", factsFor([a, b]));
      const out = await tenant(w.accountId, (c) => cancelRepoEntries(c, { accountId: w.accountId, repoId: w.repoId }));
      expect(out.map((e) => [e.prNumber, e.state, e.reason])).toEqual(
        expect.arrayContaining([[1, "cancelled", "repo_disconnected"], [2, "cancelled", "repo_disconnected"]]),
      );
      expect(await inFlight(w)).toEqual([]);
    });

    it("a stop releases the slot and records a fixed code; the code must be a plain snake_case word", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await take(w, "h", factsFor([a]));
      await expect(tenant(w.accountId, (c) => stopEntry(c, { accountId: w.accountId, entryId: a.id, reason: "Not a code!", holder: "h" }))).rejects.toMatchObject({ code: "bad_input" });
      expect(await tenant(w.accountId, (c) => stopEntry(c, { accountId: w.accountId, entryId: a.id, reason: "branch_behind", holder: "intruder" }))).toBeNull();
      const stopped = await tenant(w.accountId, (c) => stopEntry(c, { accountId: w.accountId, entryId: a.id, reason: "branch_behind", holder: "h" }));
      expect(stopped).toMatchObject({ state: "stopped", reason: "branch_behind", slotHolder: null });
      // Same head again: the stop stands. A new reviewed head clears it.
      const same = await tenant(w.accountId, (c) =>
        enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId: a.workItemId!, prNumber: 1, headSha: sha("a"), approvedAt: at(1) }),
      );
      expect(same.outcome).toBe("unchanged");
      const fresh = await tenant(w.accountId, (c) =>
        enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId: a.workItemId!, prNumber: 1, headSha: sha("f"), approvedAt: at(1) }),
      );
      expect(fresh.entry).toMatchObject({ state: "queued", reason: null });
    });

    it("only the holder can mark a gate merge", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await take(w, "h", factsFor([a]));
      expect(await tenant(w.accountId, (c) => markMerged(c, { accountId: w.accountId, entryId: a.id, mergedBy: "gate", holder: "intruder" }))).toBeNull();
      await expect(tenant(w.accountId, (c) => markMerged(c, { accountId: w.accountId, entryId: a.id, mergedBy: "gate" }))).rejects.toMatchObject({ code: "bad_input" });
      const done = await tenant(w.accountId, (c) => markMerged(c, { accountId: w.accountId, entryId: a.id, mergedBy: "gate", holder: "h" }));
      expect(done).toMatchObject({ state: "merged", mergedBy: "gate", slotHolder: null });
    });

    it("records a verified refresh once, counts it, and only for the holder", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const args = { accountId: w.accountId, entryId: a.id, fromSha: sha("a"), toSha: sha("b"), baseSha: sha("c") };
      expect(await tenant(w.accountId, (c) => recordHeadRefresh(c, { ...args, holder: "h" }))).toEqual({ recorded: false, reason: "not_holder" });
      await take(w, "h", factsFor([a]));
      expect(await tenant(w.accountId, (c) => recordHeadRefresh(c, { ...args, holder: "intruder" }))).toEqual({ recorded: false, reason: "not_holder" });
      const first = await tenant(w.accountId, (c) => recordHeadRefresh(c, { ...args, holder: "h" }));
      expect(first).toMatchObject({ recorded: true, entry: { refreshCount: 1 } });
      expect(await tenant(w.accountId, (c) => recordHeadRefresh(c, { ...args, holder: "h" }))).toEqual({ recorded: false, reason: "duplicate" });
      const second = await tenant(w.accountId, (c) => recordHeadRefresh(c, { ...args, toSha: sha("d"), fromSha: sha("b"), holder: "h" }));
      expect(second).toMatchObject({ recorded: true, entry: { refreshCount: 2 } });
      const rows = (await db.admin.query(`SELECT from_sha, to_sha, base_sha, work_item_id FROM head_refreshes WHERE entry_id = $1 ORDER BY created_at, to_sha`, [a.id])).rows;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ from_sha: sha("a"), to_sha: sha("b"), base_sha: sha("c"), work_item_id: a.workItemId });
    });
  });

  describe("what the database refuses", () => {
    it("identity and approved_at never change", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      for (const set of [`approved_at = approved_at + interval '1 hour'`, `pr_number = 99`, `work_item_id = gen_random_uuid()`, `created_at = now() - interval '1 day'`]) {
        await expect(tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET ${set} WHERE id = $1`, [a.id])), set).rejects.toBeTruthy();
      }
    });

    it("a final entry cannot change, and the counters only go up", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET refresh_count = 3 WHERE id = $1`, [a.id]));
      await expect(tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET refresh_count = 2 WHERE id = $1`, [a.id]))).rejects.toMatchObject({ code: "23514" });
      await tenant(w.accountId, (c) => settlePullRequest(c, { accountId: w.accountId, repoId: w.repoId, prNumber: 1, merged: false }));
      await expect(tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET state = 'queued' WHERE id = $1`, [a.id]))).rejects.toMatchObject({ code: "23514" });
    });

    it("a final entry refuses an edit that keeps its state (merged and cancelled alike)", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const b = await enqueue(w, 2, 1);
      await tenant(w.accountId, (c) => settlePullRequest(c, { accountId: w.accountId, repoId: w.repoId, prNumber: 1, merged: true }));
      await tenant(w.accountId, (c) => cancelWorkItemEntry(c, { accountId: w.accountId, workItemId: b.workItemId! }));
      for (const id of [a.id, b.id]) {
        // These pass every CHECK, so only the final-row guard can refuse them.
        await expect(tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET head_sha = $2 WHERE id = $1`, [id, sha("9")]))).rejects.toMatchObject({ code: "23514" });
        await expect(tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET refresh_count = refresh_count + 1 WHERE id = $1`, [id]))).rejects.toMatchObject({ code: "23514" });
      }
      expect((await row(a.id)).head_sha).toBe(sha("a"));
    });

    it("refuses a state move off the table and a slot that does not match its state", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await expect(tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET state = 'awaiting_work', work_kind = 'conflict' WHERE id = $1`, [a.id]))).rejects.toMatchObject({ code: "23514" });
      await expect(tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET slot_holder = 'x' WHERE id = $1`, [a.id]))).rejects.toMatchObject({ code: "23514" });
      await expect(tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET state = 'in_flight' WHERE id = $1`, [a.id]))).rejects.toMatchObject({ code: "23514" });
      await expect(tenant(w.accountId, (c) => c.query(`UPDATE merge_queue_entries SET state = 'stopped' WHERE id = $1`, [a.id]))).rejects.toMatchObject({ code: "23514" });
    });

    it("keeps one entry per work item and one per pull request", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const other = randomUUID();
      await seedWorkItem(db.admin, w.accountId, other, w.repoId, { ghNumber: 1 });
      await expect(
        tenant(w.accountId, (c) => enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId: other, prNumber: 1, headSha: sha("a"), approvedAt: T0 })),
      ).rejects.toMatchObject({ code: "23505" });
      expect(a.id).toBeTruthy();
    });

    it("isolates tenants: another account sees nothing and cannot write into this one", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      const stranger = await world();
      expect(await tenant(stranger.accountId, (c) => getEntry(c, stranger.accountId, a.id))).toBeNull();
      expect((await tenant(stranger.accountId, (c) => c.query(`SELECT 1 FROM merge_queue_entries WHERE id = $1`, [a.id]))).rowCount).toBe(0);
      await expect(
        tenant(stranger.accountId, (c) =>
          c.query(
            `INSERT INTO merge_queue_entries (account_id, repo_id, work_item_id, pr_number, head_sha, approved_at) VALUES ($1, $2, $3, 5, $4, now())`,
            [w.accountId, w.repoId, randomUUID(), sha("a")],
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const upd = await tenant(stranger.accountId, (c) => c.query(`UPDATE merge_queue_entries SET phase = NULL WHERE id = $1`, [a.id]));
      expect(upd.rowCount).toBe(0);
    });

    it("nobody deletes a queue row through app_user, and head_refreshes is append-only", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await expect(tenant(w.accountId, (c) => c.query(`DELETE FROM merge_queue_entries WHERE id = $1`, [a.id]))).rejects.toMatchObject({ code: "42501" });
      await expect(tenant(w.accountId, (c) => c.query(`UPDATE head_refreshes SET base_sha = base_sha`))).rejects.toMatchObject({ code: "42501" });
      await expect(tenant(w.accountId, (c) => c.query(`DELETE FROM head_refreshes`))).rejects.toMatchObject({ code: "42501" });
    });

    it("deleting the work item removes its entry and its refresh rows", async () => {
      const w = await world();
      const a = await enqueue(w, 1, 0);
      await take(w, "h", factsFor([a]));
      await tenant(w.accountId, (c) => recordHeadRefresh(c, { accountId: w.accountId, entryId: a.id, holder: "h", fromSha: sha("a"), toSha: sha("b"), baseSha: sha("c") }));
      await db.admin.query(`DELETE FROM work_items WHERE id = $1`, [a.workItemId]);
      expect((await db.admin.query(`SELECT 1 FROM merge_queue_entries WHERE id = $1`, [a.id])).rowCount).toBe(0);
      expect((await db.admin.query(`SELECT 1 FROM head_refreshes WHERE entry_id = $1`, [a.id])).rowCount).toBe(0);
    });
  });
});
