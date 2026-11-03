import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { runMergeGate, type MergeGateDeps, type MergeGateInput } from "../../src/build/mergeGate.js";
import { acquireMergeLease, hasLiveMergeLease, holdLeaseForHostQueue, lockRepoMerge, orderHolder, reapLapsedHostHold, releaseHostQueueLease, releaseMergeLease, type HostQueueEntryState } from "../../src/mergeQueue/mergeLease.js";
import { MERGE_QUEUE_LEASE_SECONDS } from "../../src/mergeQueue/policy.js";
import { enqueueEntry, takeSlot } from "../../src/mergeQueue/store.js";
import type { PrFacts } from "../../src/mergeQueue/types.js";
import { FakeGitHub, greenCi, type FakePullRequest } from "./helpers/fakeGitHub.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#483 S5-j2a1 (C34 D6, D11, D13): the per-repository merge lease against real Postgres and the real `pg_advisory_xact_lock`, through a plain `app_user` pool (row security in force).
 * A direct merge and a queue slot exclude each other on one repository, atomically; a lapsed lease is overwritten; every exit of the gate frees it.
 */
vi.mock("@fx/core/src/pendingWork.js", () => ({ markWorkPending: vi.fn(async () => undefined) }));

const HEAD = "a".repeat(40);
const ITEM = "00000000-0000-4000-8000-000000000001";
const T0 = new Date("2026-11-03T10:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const open: PrFacts = { open: true, draft: false };

describe("D#483 S5-j2a1 merge lease [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, accountId, fn);

  async function world() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, repoId };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** A queued entry for a fresh work item of the repository. */
  async function queued(w: World, prNumber: number) {
    const workItemId = randomUUID();
    await seedWorkItem(db.admin, w.accountId, workItemId, w.repoId, { ghNumber: prNumber });
    const { entry } = await tenant(w.accountId, (c) => enqueueEntry(c, { accountId: w.accountId, repoId: w.repoId, workItemId, prNumber, headSha: HEAD, dependsOnPrNumber: null, approvedAt: T0 }));
    return entry;
  }
  const take = (w: World, entryId: string, now?: Date) =>
    tenant(w.accountId, (c) => takeSlot(c, { accountId: w.accountId, repoId: w.repoId, holder: `tick:${randomUUID()}`, facts: new Map([[entryId, open]]), ...(now ? { now } : {}) }));
  const leaseRows = async (w: World) => (await db.admin.query<{ holder: string; kind: string }>(`SELECT holder, kind FROM repo_merge_leases WHERE account_id = $1 AND repo_id = $2`, [w.accountId, w.repoId])).rows;

  it("two takers racing for one repository: exactly one wins, the others are told it is busy", async () => {
    const w = await world();
    const takes = await Promise.all(Array.from({ length: 8 }, () => acquireMergeLease(db.pureAppUserPool, w)));
    expect(takes.filter((t) => t.taken)).toHaveLength(1);
    expect(await leaseRows(w)).toHaveLength(1);
  });

  it("the lease is per repository: another repository of the same account takes its own", async () => {
    const w = await world();
    const other = randomUUID();
    await seedRepo(db.admin, w.accountId, other);
    expect((await acquireMergeLease(db.pureAppUserPool, w)).taken).toBe(true);
    expect((await acquireMergeLease(db.pureAppUserPool, { accountId: w.accountId, repoId: other })).taken).toBe(true);
  });

  it("a gate and an in-flight queue entry exclude each other, both ways", async () => {
    // The tick does not take a slot under a live lease; once the lease is freed it does.
    const a = await world();
    const entryA = await queued(a, 11);
    const lease = await acquireMergeLease(db.pureAppUserPool, a);
    expect(lease.taken).toBe(true);
    expect(await take(a, entryA.id)).toMatchObject({ taken: null, skipped: "slot_busy" });
    if (lease.taken) await lease.release();
    expect((await take(a, entryA.id)).taken?.id).toBe(entryA.id);

    // The gate does not take a lease under an in-flight entry; once the entry's slot lapses it does.
    const b = await world();
    const entryB = await queued(b, 12);
    expect((await take(b, entryB.id, T0)).taken?.id).toBe(entryB.id);
    expect(await acquireMergeLease(db.pureAppUserPool, { ...b, now: at(30) })).toEqual({ taken: false });
    expect(await leaseRows(b)).toEqual([]);
    // A tick that died leaves an entry whose slot lease has lapsed. It is no holder: the gate reclaims it by the queue's own rule (the entry goes back to queued) and takes the lease.
    const lapsed = at(MERGE_QUEUE_LEASE_SECONDS + 1);
    expect((await acquireMergeLease(db.pureAppUserPool, { ...b, now: lapsed })).taken).toBe(true);
    expect((await db.admin.query(`SELECT state FROM merge_queue_entries WHERE id = $1`, [entryB.id])).rows).toEqual([{ state: "queued" }]);
  });

  it("the lock is real: while another transaction holds the repository's advisory lock, takeSlot and acquireMergeLease wait for it, and both go on when it commits", async () => {
    const w = await world();
    const entry = await queued(w, 51);
    const other = await world();
    const holder = await db.pureAppUserPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('app.account_id', $1, true)", [w.accountId]);
      await lockRepoMerge(holder, w.accountId, w.repoId);
      const waiting = async () => Number((await db.admin.query(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).rows[0].n);
      const before = await waiting();
      let done = 0;
      const slot = take(w, entry.id).then((r) => (done++, r));
      const lease = acquireMergeLease(db.pureAppUserPool, w).then((r) => (done++, r));
      // A repository that is not locked is not held up by it.
      expect((await acquireMergeLease(db.pureAppUserPool, other)).taken).toBe(true);
      await expect.poll(waiting).toBe(before + 2);
      expect(done).toBe(0);
      await holder.query("COMMIT");
      const [s, l] = await Promise.all([slot, lease]);
      expect(done).toBe(2);
      expect([s.taken !== null, l.taken]).not.toEqual([true, true]);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  it("freeing a lease wakes the merge-queue sweep when an entry is queued behind it, and only then", async () => {
    const mark = vi.mocked(markWorkPending);
    const idle = await world();
    const a = await acquireMergeLease(db.pureAppUserPool, idle);
    mark.mockClear();
    if (a.taken) await a.release();
    expect(mark).not.toHaveBeenCalled();

    const busy = await world();
    await queued(busy, 61);
    const b = await acquireMergeLease(db.pureAppUserPool, busy);
    mark.mockClear();
    if (b.taken) await b.release();
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith("merge-queue-sweep");
    // A release that frees nothing (the lease was already overwritten) wakes nothing.
    mark.mockClear();
    await releaseMergeLease(db.pureAppUserPool, { ...busy, holder: "not-the-holder" });
    expect(mark).not.toHaveBeenCalled();
  });

  describe("D#483 S5-j2a2 (R-C35): a hold for GitHub's queue is named by the repository's numeric id, read when it lapses, bounded at 24 hours, and kept by the tick until then", () => {
    const nowMin = () => Math.floor(Date.now() / 60_000);
    /** A lapsed hold for pull request `pr` of the repository with GitHub id `id`, begun `ageMin` minutes ago. */
    const lapsed = async (w: World, pr = 7, id = "4242", ageMin = 1, item = ITEM) => {
      const holder = `ghq:${pr}:${id}:${nowMin() - ageMin}:${item}`;
      await db.admin.query("INSERT INTO repo_merge_leases (account_id, repo_id, holder, kind, lease_until) VALUES ($1, $2, $3, 'direct', now() - interval '1 second')", [w.accountId, w.repoId, holder]);
      return holder;
    };
    const secsLeft = async (w: World) => Number((await db.admin.query("SELECT extract(epoch FROM lease_until - now()) AS s FROM repo_merge_leases WHERE repo_id = $1", [w.repoId])).rows[0].s);
    const lapse = (w: World) => db.admin.query("UPDATE repo_merge_leases SET lease_until = now() - interval '1 second' WHERE repo_id = $1", [w.repoId]);

    it.each<[string, HostQueueEntryState | "throws" | "absent"]>([["still waiting", "queued"], ["unreadable", "unreadable"], ["the read throws", "throws"], ["no reader at all", "absent"]])("%s: the repository stays busy and the hold is renewed", async (_n, state) => {
      const w = await world();
      const holder = await lapsed(w);
      const seen: Array<[number, string]> = [];
      const reader = state === "absent" ? {} : { hostQueueEntry: async (n: number, id: string) => (seen.push([n, id]), state === "throws" ? Promise.reject(new Error("GitHub down")) : state) };
      expect(await acquireMergeLease(db.pureAppUserPool, { ...w, ...reader })).toEqual({ taken: false });
      // A read that said "still waiting" leaves the hold as it was; one that could not say counts as the first miss (see below).
      expect(await leaseRows(w)).toEqual([{ holder: state === "queued" ? holder : `${holder}:u1`, kind: "direct" }]);
      expect(await secsLeft(w)).toBeGreaterThan(29 * 60);
      if (state !== "absent") expect(seen).toEqual([[7, "4242"]]);
    });

    it("an unreadable read cannot renew a hold forever: the third in a row stays busy but is put before a person (stuck) and is read again within minutes; a read that says it is still waiting starts the count again", async () => {
      const w = await world();
      const holder = await lapsed(w);
      const unreadable = { hostQueueEntry: async () => "unreadable" as const };
      expect(await acquireMergeLease(db.pureAppUserPool, { ...w, ...unreadable })).toEqual({ taken: false });
      await lapse(w);
      expect(await acquireMergeLease(db.pureAppUserPool, { ...w, ...unreadable })).toEqual({ taken: false });
      expect((await leaseRows(w))[0]!.holder).toBe(`${holder}:u2`);
      // A readable answer in between: still waiting, the count starts again.
      await lapse(w);
      expect(await acquireMergeLease(db.pureAppUserPool, { ...w, hostQueueEntry: async () => "queued" as const })).toEqual({ taken: false });
      expect((await leaseRows(w))[0]!.holder).toBe(holder);
      for (const n of [1, 2]) {
        await lapse(w);
        expect(await acquireMergeLease(db.pureAppUserPool, { ...w, ...unreadable }), String(n)).toEqual({ taken: false });
      }
      await lapse(w);
      expect(await acquireMergeLease(db.pureAppUserPool, { ...w, ...unreadable })).toEqual({ taken: false, stuck: true });
      expect((await leaseRows(w))[0]!.holder).toBe(`${holder}:u3`);
      expect(await secsLeft(w)).toBeLessThan(6 * 60);
      // It keeps surfacing until the entry can be read, and the read that finds it gone frees the repository.
      await lapse(w);
      expect(await acquireMergeLease(db.pureAppUserPool, { ...w, ...unreadable })).toEqual({ taken: false, stuck: true });
      await lapse(w);
      expect((await acquireMergeLease(db.pureAppUserPool, { ...w, hostQueueEntry: async () => "gone" as const })).taken).toBe(true);
    });

    it("the count has no ceiling that ends the hold: past ten (and past a hundred) unreadable reads it still parses, stays busy and stuck, and only a gone read frees it", async () => {
      const w = await world();
      const holder = await lapsed(w);
      const unreadable = { hostQueueEntry: async () => "unreadable" as const };
      for (let n = 1; n <= 12; n++) {
        if (n > 1) await lapse(w);
        const take = await acquireMergeLease(db.pureAppUserPool, { ...w, ...unreadable });
        expect(take.taken, String(n)).toBe(false);
      }
      expect((await leaseRows(w))[0]!.holder).toBe(`${holder}:u12`);
      await db.admin.query("UPDATE repo_merge_leases SET holder = $2 WHERE repo_id = $1", [w.repoId, `${holder}:u999`]);
      await lapse(w);
      expect(await acquireMergeLease(db.pureAppUserPool, { ...w, ...unreadable })).toEqual({ taken: false, stuck: true });
      expect((await leaseRows(w))[0]!.holder).toBe(`${holder}:u999`);
      await lapse(w);
      expect((await acquireMergeLease(db.pureAppUserPool, { ...w, hostQueueEntry: async () => "gone" as const })).taken).toBe(true);
    });

    it("gone (the pull request left the queue): the next taker takes the repository", async () => {
      const w = await world();
      await lapsed(w);
      const take = await acquireMergeLease(db.pureAppUserPool, { ...w, hostQueueEntry: async () => "gone" });
      expect(take.taken).toBe(true);
      expect(await leaseRows(w)).toEqual([{ holder: take.taken ? take.holder : "", kind: "direct" }]);
    });

    it("a hold that has not lapsed is not read, and an ordinary lapsed lease is overwritten without a read", async () => {
      const w = await world();
      const reads: number[] = [];
      const reader = { hostQueueEntry: async (n: number) => (reads.push(n), "gone" as const) };
      await db.admin.query("INSERT INTO repo_merge_leases (account_id, repo_id, holder, kind, lease_until) VALUES ($1, $2, $3, 'direct', now() + interval '5 minutes')", [w.accountId, w.repoId, `ghq:7:4242:${nowMin()}:${ITEM}`]);
      expect(await acquireMergeLease(db.pureAppUserPool, { ...w, ...reader })).toEqual({ taken: false });
      await db.admin.query("UPDATE repo_merge_leases SET holder = 'lease-old', lease_until = now() - interval '1 second' WHERE repo_id = $1", [w.repoId]);
      expect((await acquireMergeLease(db.pureAppUserPool, { ...w, ...reader })).taken).toBe(true);
      expect(reads).toEqual([]);
    });

    it("the holder is digits and colons only, with the largest pull request number and repository id it can carry; a rename changes nothing, and the settle finds it by id, case folded away, and frees a counted hold too", async () => {
      const w = await world();
      const take = await acquireMergeLease(db.pureAppUserPool, w);
      expect(take.taken).toBe(true);
      if (take.taken) await take.holdForHostQueue(123456789, "123456789012345", ITEM);
      const rows = await leaseRows(w);
      expect(rows[0]!.holder).toMatch(new RegExp(`^ghq:123456789:123456789012345:\\d+:${ITEM}$`));
      expect(rows[0]!.holder.length).toBeLessThan(100);
      await db.admin.query("UPDATE repo_merge_leases SET holder = holder || ':u12' WHERE repo_id = $1", [w.repoId]);
      // Another pull request number that starts the same, and another repository's id that does, leave it.
      await tenant(w.accountId, (c) => releaseHostQueueLease(c, { accountId: w.accountId, repoGhId: "123456789012345", prNumber: 12345678 }));
      await tenant(w.accountId, (c) => releaseHostQueueLease(c, { accountId: w.accountId, repoGhId: "12345678901234", prNumber: 123456789 }));
      expect(await leaseRows(w)).toHaveLength(1);
      await tenant(w.accountId, (c) => releaseHostQueueLease(c, { accountId: w.accountId, repoGhId: 123456789012345, prNumber: 123456789 }));
      expect(await leaseRows(w)).toEqual([]);
      void holdLeaseForHostQueue;
    });

    it("the 24-hour bound: a hold that began more than a day ago ends at the next take with no read at all, and the item it was held for gets an event for it", async () => {
      const w = await world();
      const workItemId = randomUUID();
      await seedWorkItem(db.admin, w.accountId, workItemId, w.repoId, { ghNumber: 7 });
      await db.admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key, code, head_sha, pr_number) VALUES ($1, $2, 'merge_enqueued', 'e1', 'queue', $3, 7)", [w.accountId, workItemId, HEAD]);
      // Another item whose own pull request number is also 7 (a paired item has two numbers) is not the one the hold names.
      const other = randomUUID();
      await seedWorkItem(db.admin, w.accountId, other, w.repoId, { ghNumber: 8 });
      await db.admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key, code, head_sha, pr_number) VALUES ($1, $2, 'merge_enqueued', 'e2', 'auto_merge', $3, 7)", [w.accountId, other, HEAD]);
      await lapsed(w, 7, "4242", 1441, workItemId);
      const reads: number[] = [];
      const take = await acquireMergeLease(db.pureAppUserPool, { ...w, hostQueueEntry: async (n) => (reads.push(n), "queued" as const) });
      expect(take.taken).toBe(true);
      expect(reads).toEqual([]);
      const { rows } = await db.admin.query("SELECT code, reasons, pr_number FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'merge_gate'", [workItemId]);
      expect(rows).toEqual([{ code: "merge_hold_expired", reasons: ["merge_hold_expired"], pr_number: 7 }]);
      expect((await db.admin.query("SELECT 1 FROM work_item_driver_events WHERE work_item_id = $1 AND code = 'merge_hold_expired'", [other])).rows).toEqual([]);
      // Just under a day it is still read, not ended.
      const w2 = await world();
      await lapsed(w2, 7, "4242", 1439);
      expect((await acquireMergeLease(db.pureAppUserPool, { ...w2, hostQueueEntry: async () => "queued" as const })).taken).toBe(false);
    });

    it("a holder that says it is a hold but is not well formed fails closed: busy, never read as an ordinary lease, for 24 hours after its lease_until (which nothing renews), for a gate and for the tick alike", async () => {
      const reads: number[] = [];
      const reader = { hostQueueEntry: async (n: number) => (reads.push(n), "gone" as const) };
      for (const bad of ["ghq:garbage", `ghq:7:4242:${nowMin()}`, `ghq:7:4242:${nowMin()}:not-a-uuid`, `ghq:7:4242:${nowMin()}:${ITEM}:u1000`, `ghq:7:4242:${nowMin()}:${ITEM}:u`]) {
        const w = await world();
        const entry = await queued(w, 31);
        await db.admin.query("INSERT INTO repo_merge_leases (account_id, repo_id, holder, kind, lease_until) VALUES ($1, $2, $3, 'direct', now() - interval '1 second')", [w.accountId, w.repoId, bad]);
        expect(await acquireMergeLease(db.pureAppUserPool, { ...w, ...reader }), bad).toEqual({ taken: false });
        expect(await take(w, entry.id), bad).toMatchObject({ taken: null, skipped: "slot_busy" });
        expect((await leaseRows(w))[0]!.holder).toBe(bad);
        await db.admin.query("UPDATE repo_merge_leases SET lease_until = now() - interval '25 hours' WHERE repo_id = $1", [w.repoId]);
        expect((await acquireMergeLease(db.pureAppUserPool, { ...w, ...reader }) ).taken, bad).toBe(true);
      }
      expect(reads).toEqual([]);
    });

    it("a holder that says it is a runner's order but is not well formed fails closed the same way: busy for 24 hours after its lease_until, for a gate and for the tick", async () => {
      const ORDER = "11111111-2222-4333-8444-555555555555";
      for (const bad of ["ord:garbage", `ord:${ORDER}`, `ord:${ORDER}:`, `ord:${ORDER}:12x`, `ord:not-a-uuid:${nowMin()}`, `ord:${ORDER}:${nowMin()}:extra`]) {
        const w = await world();
        const entry = await queued(w, 31);
        await db.admin.query("INSERT INTO repo_merge_leases (account_id, repo_id, holder, kind, lease_until) VALUES ($1, $2, $3, 'direct', now() - interval '1 second')", [w.accountId, w.repoId, bad]);
        expect(await acquireMergeLease(db.pureAppUserPool, { ...w }), bad).toEqual({ taken: false });
        expect(await take(w, entry.id), bad).toMatchObject({ taken: null, skipped: "slot_busy" });
        expect((await leaseRows(w))[0]!.holder).toBe(bad);
        await db.admin.query("UPDATE repo_merge_leases SET lease_until = now() - interval '25 hours' WHERE repo_id = $1", [w.repoId]);
        expect((await acquireMergeLease(db.pureAppUserPool, { ...w })).taken, bad).toBe(true);
      }
    });

    // A retry of an order whose lease is still held waits for the order's end or its deadline: it never replaces the holder (a replaced holder in the same minute is identical, so the old gate's confirm would stay true).
    it("a retry of a live order, in the same minute or a later one, and at any state before the hand-over, answers busy and leaves the first holder's lease alone", async () => {
      const w = await world();
      const item = randomUUID();
      await seedWorkItem(db.admin, w.accountId, item, w.repoId, { ghNumber: 5 });
      const push = randomUUID();
      await db.admin.query("INSERT INTO plane_pushes (id, account_id, work_item_id, repo_id, code_repo, pairing_digest, state) VALUES ($1, $2, $3, $4, 'acme/widgets-public', $5, 'building')", [push, w.accountId, item, w.repoId, "a".repeat(64)]);
      const order = (await db.admin.query(`INSERT INTO plane_merge_orders (account_id, work_item_id, plane_push_id, repo_id, code_repo, pr_number, expected_public_head, reviewed_head, pairing_digest, deadline_at)
                                           VALUES ($1, $2, $3, $4, 'acme/widgets-public', 7, $5, $5, $6, now() + interval '1 hour') RETURNING id`, [w.accountId, item, push, w.repoId, HEAD, "a".repeat(64)])).rows[0].id as string;
      const asOrder = (id: string, ageMinutes = 0) => acquireMergeLease(db.pureAppUserPool, { ...w, kind: "order", holder: orderHolder(id, new Date(Date.now() - ageMinutes * 60_000)), leaseSeconds: 3600 });
      const first = await asOrder(order, 5);
      expect(first.taken).toBe(true);
      if (!first.taken) throw new Error("unreachable");
      // Another order (no row of its own) and a plain direct gate wait.
      expect((await asOrder(randomUUID())).taken).toBe(false);
      expect((await acquireMergeLease(db.pureAppUserPool, { ...w })).taken).toBe(false);
      // The same order asking again, in the same minute and in a later one, waits: pending, then claimed (nothing handed over yet), then authorized.
      for (const state of ["pending", "claimed", "authorized"]) {
        if (state === "claimed") await db.admin.query("UPDATE plane_merge_orders SET state = 'claimed', lease_generation = 1, lease_expires_at = now() + interval '1 hour' WHERE id = $1", [order]);
        if (state === "authorized") await db.admin.query("UPDATE plane_merge_orders SET state = 'authorized', write_token_issued_at = now() WHERE id = $1", [order]);
        expect((await asOrder(order, 5)).taken, `${state} same minute`).toBe(false);
        expect((await asOrder(order)).taken, `${state} later minute`).toBe(false);
        expect(await first.confirm(), state).toBe(true);
        expect(await leaseRows(w), state).toEqual([{ holder: first.holder, kind: "order" }]);
      }
      // The first gate's own release frees it, and only then.
      await first.release();
      expect(await leaseRows(w)).toEqual([]);
    });

    it("the queue tick treats a hold as busy whether lapsed or not, until a gate's read, the settle, the sweep or the 24 hours frees it; the sweep's read frees a lapsed one that is gone, and keeps one still queued", async () => {
      const w = await world();
      const entry = await queued(w, 31);
      await lapsed(w, 7, "4242", 1);
      expect(await take(w, entry.id)).toMatchObject({ taken: null, skipped: "slot_busy" });
      // Nobody asks: the sweep reads it. Still queued: it stays, and the tick is still held off.
      await reapLapsedHostHold(db.pureAppUserPool, { ...w, hostQueueEntry: async () => "queued" });
      expect(await leaseRows(w)).toHaveLength(1);
      expect(await take(w, entry.id)).toMatchObject({ taken: null, skipped: "slot_busy" });
      // Gone: freed, and the queue is woken.
      vi.mocked(markWorkPending).mockClear();
      await lapse(w);
      await reapLapsedHostHold(db.pureAppUserPool, { ...w, hostQueueEntry: async () => "gone" });
      expect(await leaseRows(w)).toEqual([]);
      expect(markWorkPending).toHaveBeenCalledWith("merge-queue-sweep");
      expect((await take(w, entry.id)).taken?.id).toBe(entry.id);
      // A hold past 24 hours no longer holds the tick off, even if nothing read it.
      const old = await world();
      const entry2 = await queued(old, 32);
      await lapsed(old, 7, "4242", 1500);
      expect((await take(old, entry2.id)).taken?.id).toBe(entry2.id);
    });
  });

  it("a lapsed lease is dead: the next taker overwrites it, and the old holder's release leaves the new lease alone", async () => {
    const w = await world();
    const first = await acquireMergeLease(db.pureAppUserPool, { ...w, now: T0, leaseSeconds: 60 });
    expect(first.taken).toBe(true);
    expect(await acquireMergeLease(db.pureAppUserPool, { ...w, now: at(30) })).toEqual({ taken: false });
    const second = await acquireMergeLease(db.pureAppUserPool, { ...w, now: at(61), kind: "order" });
    expect(second.taken).toBe(true);
    expect(await leaseRows(w)).toEqual([{ holder: second.taken ? second.holder : "", kind: "order" }]);
    if (first.taken) await first.release();
    expect(await leaseRows(w)).toHaveLength(1);
    // The tick also reads a lapsed lease as dead.
    expect(await tenant(w.accountId, (c) => hasLiveMergeLease(c, { ...w, now: at(61) }))).toBe(true);
    expect(await tenant(w.accountId, (c) => hasLiveMergeLease(c, { ...w, now: at(61 + 601) }))).toBe(false);
  });

  it("a gate and a tick racing for a fresh repository: exactly one of them gets it, every time", async () => {
    for (let i = 0; i < 20; i++) {
      const w = await world();
      const entry = await queued(w, 20 + i);
      const [lease, slot] = await Promise.all([acquireMergeLease(db.pureAppUserPool, w), take(w, entry.id)]);
      expect([lease.taken, slot.taken !== null]).not.toEqual([true, true]);
      expect([lease.taken, slot.taken !== null]).not.toEqual([false, false]);
    }
  });

  it("only the named holder frees a lease; a release for a lease that is gone changes nothing", async () => {
    const w = await world();
    const lease = await acquireMergeLease(db.pureAppUserPool, w);
    await releaseMergeLease(db.pureAppUserPool, { ...w, holder: "someone-else" });
    expect(await leaseRows(w)).toHaveLength(1);
    if (lease.taken) await lease.release();
    expect(await leaseRows(w)).toEqual([]);
    await releaseMergeLease(db.pureAppUserPool, { ...w, holder: "gone" });
  });

  it("a tenant reads and writes only its own leases (row-level security)", async () => {
    const a = await world();
    const b = await world();
    expect((await acquireMergeLease(db.pureAppUserPool, a)).taken).toBe(true);
    expect(await tenant(b.accountId, async (c) => (await c.query(`SELECT 1 FROM repo_merge_leases`)).rowCount)).toBe(0);
    await expect(tenant(b.accountId, (c) => c.query(`INSERT INTO repo_merge_leases (account_id, repo_id, holder, kind, lease_until) VALUES ($1, $2, 'x', 'direct', now())`, [a.accountId, a.repoId]))).rejects.toMatchObject({ code: "42501" });
    expect(await tenant(b.accountId, async (c) => (await c.query(`DELETE FROM repo_merge_leases WHERE account_id = $1`, [a.accountId])).rowCount)).toBe(0);
    expect(await tenant(b.accountId, async (c) => (await c.query(`UPDATE repo_merge_leases SET lease_until = now() WHERE account_id = $1`, [a.accountId])).rowCount)).toBe(0);
    expect(await leaseRows(a)).toHaveLength(1);
  });

  describe("through the gate", () => {
    const prOf = (over: Partial<FakePullRequest> = {}): FakePullRequest => ({ headSha: HEAD, state: "open", merged: false, draft: false, body: "", labels: [], comments: [], ...over });

    async function gateWorld() {
      const w = await world();
      const workItemId = randomUUID();
      await db.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number) VALUES ($1, $2, $3, 'feature', 'running', 'internal', 7)`, [workItemId, w.accountId, w.repoId]);
      for (const role of ["code-reviewer", "acceptance-tester"]) {
        await db.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, 'production', 'succeeded', '{"verdict":"pass"}'::jsonb, $4)`, [w.accountId, workItemId, role, HEAD]);
      }
      return { ...w, workItemId };
    }
    const gateDeps = (w: World, github: FakeGitHub, over: Partial<MergeGateDeps> = {}): MergeGateDeps => ({
      pool: db.runWriterPool,
      github,
      isAutoMergeAllowed: async () => true,
      requestReviews: async () => undefined,
      acquireMergeLease: async () => {
        const lease = await acquireMergeLease(db.pureAppUserPool, w);
        return lease.taken ? { release: lease.release, confirm: lease.confirm, holdForHostQueue: (n: number) => lease.holdForHostQueue(n, "4242", ITEM) } : null;
      },
      ...over,
    });
    const inputOf = (w: World & { workItemId: string }, over: Partial<MergeGateInput> = {}): MergeGateInput => ({
      accountId: w.accountId,
      workItemId: w.workItemId,
      pr: { repoId: w.repoId, prNumber: 7 },
      tier: "small",
      securityDiffTriggerFired: false,
      debaterEnabled: false,
      ...over,
    });
    const fake = (pr: FakePullRequest = prOf(), over: Partial<ConstructorParameters<typeof FakeGitHub>[0]> = {}) => new FakeGitHub({ pr, ciBySha: { [HEAD]: greenCi(HEAD) }, ...over });

    it("a second gate on the repository while one runs answers merge_repo_busy, reads nothing and merges nothing; it goes through once the first is done", async () => {
      const w = await gateWorld();
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const first = fake();
      const read = first.getPullRequest.bind(first);
      first.getPullRequest = async (ref) => (await hold, read(ref));
      const running = runMergeGate(gateDeps(w, first), inputOf(w));
      // The first has the lease before it reads (it is parked on its first read).
      await expect.poll(async () => (await leaseRows(w)).length).toBe(1);

      const second = fake();
      expect(await runMergeGate(gateDeps(w, second), inputOf(w))).toEqual({ outcome: "ready_human_merges", headSha: "", reasons: ["merge_repo_busy"] });
      expect(second.mergeCalls).toEqual([]);
      expect(second.humanMarks).toEqual([]);
      expect(second.ciQueries).toEqual([]);

      release();
      expect(await running).toEqual({ outcome: "merged", headSha: HEAD });
      expect(await leaseRows(w)).toEqual([]);
      expect(await runMergeGate(gateDeps(w, fake()), inputOf(w))).toMatchObject({ outcome: "merged" });
    });

    it("an in-flight queue entry makes the gate wait: no read, no merge", async () => {
      const w = await gateWorld();
      const entry = await queued(w, 31);
      expect((await take(w, entry.id)).taken?.id).toBe(entry.id);
      const github = fake();
      expect(await runMergeGate(gateDeps(w, github), inputOf(w))).toMatchObject({ outcome: "ready_human_merges", reasons: ["merge_repo_busy"] });
      expect(github.mergeCalls).toEqual([]);
    });

    it.each([
      ["merged", () => fake(), {}, "merged"],
      ["stopped (a draft)", () => fake(prOf({ draft: true })), {}, "ready_human_merges"],
      ["head moved (the caller's head is not the pull request's)", () => fake(), { expectedHeadSha: "b".repeat(40) }, "head_moved"],
      ["the pull request is closed", () => fake(prOf({ state: "closed" })), {}, "pr_not_open"],
      [
        "delegated to a runner",
        () => {
          const g = fake();
          g.mergePullRequest = async () => ({ merged: false, delegated: true });
          return g;
        },
        {},
        "merge_delegated",
      ],
    ] as const)("the lease is free again after the gate exits: %s", async (_name, make, over, outcome) => {
      const w = await gateWorld();
      const github = make();
      expect((await runMergeGate(gateDeps(w, github), inputOf(w, over as Partial<MergeGateInput>))).outcome).toBe(outcome);
      expect(await leaseRows(w)).toEqual([]);
    });

    it("enqueued in GitHub's queue: the lease is not freed but held for that pull request (D#483 S5-j2a2, R-C34-F4; the settle tests are in mergeGateRun.pg.test.ts)", async () => {
      const w = await gateWorld();
      expect((await runMergeGate(gateDeps(w, fake(prOf(), { queueMode: "queue" as const })), inputOf(w))).outcome).toBe("merge_enqueued");
      expect(await leaseRows(w)).toEqual([{ holder: expect.stringMatching(new RegExp(`^ghq:7:4242:\\d+:${ITEM}$`)), kind: "direct" }]);
    });

    it("D#483 S5-j2a2: the hold for GitHub's queue wakes nothing, and neither a competing take nor a lapsed in-flight reclaim removes it; only the settle (or its 30 minutes) frees it", async () => {
      const w = await gateWorld();
      const sibling = await queued(w, 9);
      vi.mocked(markWorkPending).mockClear();
      expect((await runMergeGate(gateDeps(w, fake(prOf(), { queueMode: "queue" as const })), inputOf(w))).outcome).toBe("merge_enqueued");
      expect(markWorkPending).not.toHaveBeenCalled();
      // Another direct merge and the reclaim run in `acquireMergeLease` leave the held lease as it was.
      expect(await acquireMergeLease(db.pureAppUserPool, w)).toEqual({ taken: false });
      expect(await leaseRows(w)).toEqual([{ holder: expect.stringMatching(new RegExp(`^ghq:7:4242:\\d+:${ITEM}$`)), kind: "direct" }]);
      // The queue's slot is excluded meanwhile, with its entry still queued.
      expect(await take(w, sibling.id)).toMatchObject({ taken: null, skipped: "slot_busy" });
      expect((await tenant(w.accountId, (c) => c.query("SELECT state FROM merge_queue_entries WHERE id = $1", [sibling.id]))).rows).toEqual([{ state: "queued" }]);
      // Settling it frees the repository: the queue's slot is taken.
      await tenant(w.accountId, (c) => releaseHostQueueLease(c, { accountId: w.accountId, repoGhId: 4242, prNumber: 7 }));
      expect((await take(w, sibling.id)).taken?.id).toBe(sibling.id);
    });

    it("D#483 S5-j2a2 (R-C35-4): the hold is only for a pull request that adds an ordered file; any other direct item gives the lease back at the enqueue; a doubt holds", async () => {
      const queue = () => fake(prOf(), { queueMode: "queue" as const });
      for (const [adds, held] of [[async () => false, false], [async () => true, true], [async () => { throw new Error("tree unreadable"); }, true], [undefined, true]] as const) {
        const w = await gateWorld();
        const out = await runMergeGate(gateDeps(w, queue(), adds === undefined ? {} : { addsOrderedFile: adds }), inputOf(w));
        expect(out.outcome).toBe("merge_enqueued");
        expect((await leaseRows(w)).length, String(adds)).toBe(held ? 1 : 0);
      }
    });

    it("D#483 S5-j2a2 (R-C35-5): a gate whose lease was taken over just before the merge call merges nothing and answers merge_repo_busy", async () => {
      const w = await gateWorld();
      const github = fake();
      // The last read before the merge call: another taker has the repository by then (this gate stalled past its lease).
      github.getMergeQueueMode = async () => {
        await db.admin.query("UPDATE repo_merge_leases SET holder = 'thief' WHERE account_id = $1 AND repo_id = $2", [w.accountId, w.repoId]);
        return { mode: "direct", source: "fake" };
      };
      expect(await runMergeGate(gateDeps(w, github), inputOf(w))).toMatchObject({ outcome: "ready_human_merges", reasons: ["merge_repo_busy"] });
      expect(github.mergeCalls).toEqual([]);
      expect(await leaseRows(w)).toEqual([{ holder: "thief", kind: "direct" }]);
    });

    it("D#483 S5-j2a2 (R-C35): a lease that lapsed and that nobody overwrote is lost as well: a tick may have come and gone, so the gate merges nothing", async () => {
      const w = await gateWorld();
      const github = fake();
      github.getMergeQueueMode = async () => {
        await db.admin.query("UPDATE repo_merge_leases SET lease_until = now() - interval '1 second' WHERE account_id = $1 AND repo_id = $2", [w.accountId, w.repoId]);
        return { mode: "direct", source: "fake" };
      };
      expect(await runMergeGate(gateDeps(w, github), inputOf(w))).toMatchObject({ outcome: "ready_human_merges", reasons: ["merge_repo_busy"] });
      expect(github.mergeCalls).toEqual([]);
    });

    it("the same for the enqueue into GitHub's queue, and a lease that is intact is renewed and merges", async () => {
      const w = await gateWorld();
      const github = fake(prOf(), { queueMode: "queue" as const });
      const read = github.getMergeQueueMode!.bind(github);
      github.getMergeQueueMode = async (...a) => {
        await db.admin.query("DELETE FROM repo_merge_leases WHERE account_id = $1 AND repo_id = $2", [w.accountId, w.repoId]);
        return read(...a);
      };
      expect(await runMergeGate(gateDeps(w, github), inputOf(w))).toMatchObject({ reasons: ["merge_repo_busy"] });
      expect(github.enqueueCalls).toEqual([]);
      const w2 = await gateWorld();
      expect(await runMergeGate(gateDeps(w2, fake()), inputOf(w2))).toMatchObject({ outcome: "merged" });
    });

    it("the lease is free again when the gate throws", async () => {
      const w = await gateWorld();
      const github = fake();
      github.getCiSnapshot = async () => {
        throw new Error("ci read failed");
      };
      await expect(runMergeGate(gateDeps(w, github), inputOf(w))).rejects.toThrow("ci read failed");
      expect(await leaseRows(w)).toEqual([]);
    });

    it("a gate that dies holding the lease blocks the repository no longer than the lease", async () => {
      const w = await world();
      expect((await acquireMergeLease(db.pureAppUserPool, { ...w, now: T0, leaseSeconds: 600 })).taken).toBe(true);
      // Nothing frees it (the holder is gone). No job runs; the next taker after lease_until overwrites it.
      expect((await acquireMergeLease(db.pureAppUserPool, { ...w, now: at(599) })).taken).toBe(false);
      expect((await acquireMergeLease(db.pureAppUserPool, { ...w, now: at(601) })).taken).toBe(true);
    });

    it("a plan write-back merge under the queue slot and a direct item on the same repository exclude each other", async () => {
      // The write-back merge runs under the queue's slot (an in-flight entry); a direct gate cannot take the repository while it holds it.
      const w = await world();
      const entry = await queued(w, 41);
      expect((await take(w, entry.id)).taken).not.toBeNull();
      expect(await acquireMergeLease(db.pureAppUserPool, w)).toEqual({ taken: false });
    });
  });
});
