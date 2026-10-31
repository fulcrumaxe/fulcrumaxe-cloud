import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import type { PoolClient } from "pg";
import { applyQueueEvent, HOST_DEQUEUED_REASON, HOST_QUEUE_LEASE_SECONDS, HOST_QUEUE_PHASE, PARKED_PHASE, renewSlot, takeSlot } from "../../src/mergeQueue/index.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { shaOf, startQueueRepo, type QueueItem, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#694 B6-2: the webhook settles an entry that waits in the host's merge queue (over real Postgres). The hold the tick leaves (phase `host_queue`, the store's longest lease)
 * is only the bound for a lost delivery: a merge, a close or a removal ends it, a late or replayed delivery never undoes an end, and a removal of a head the item has moved
 * on from changes nothing.
 */
let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("host-queue settle [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(r: QueueRepo, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, r.accountId, fn);
  const apply = (r: QueueRepo, payload: unknown) => tenant(r, (c) => applyQueueEvent(c, { accountId: r.accountId, repoId: r.repoId, eventName: "pull_request", payload }));
  const dequeued = (pr: number, head: string, reason?: string) => ({ action: "dequeued", ...(reason !== undefined ? { reason } : {}), pull_request: { number: pr, merged: false, head: { sha: head } } });
  const closedMerged = (pr: number, head: string) => ({ action: "closed", pull_request: { number: pr, merged: true, head: { sha: head } } });

  const enqueueFact = (r: QueueRepo, it: QueueItem, head: string) =>
    tenant(r, (c) => recordDriverEvent(c, r.accountId, { workItemId: it.workItemId, kind: "merge_enqueued", dedupeKey: `enqueued:${head}`, code: "queue", headSha: head, prNumber: it.pr, queueEntryId: "MQE_kwDOentry" }));

  /** What the tick leaves when the gate answers merge_enqueued: the slot held in the host-queue phase, and the gate's own driver row for the head. */
  const hostQueued = async (r: QueueRepo, pr: number, head?: string) => {
    const it = r.items.get(pr)!;
    const holder = `t:${pr}`;
    const taken = await tenant(r, (c) => takeSlot(c, { accountId: r.accountId, repoId: r.repoId, holder, facts: new Map([[it.entryId, { open: true, draft: false }]]) }));
    expect(taken.taken?.prNumber).toBe(pr);
    await tenant(r, (c) => renewSlot(c, { accountId: r.accountId, entryId: it.entryId, holder, phase: HOST_QUEUE_PHASE, leaseSeconds: HOST_QUEUE_LEASE_SECONDS }));
    await enqueueFact(r, it, head ?? it.head);
    expect(await r.entry(pr)).toMatchObject({ state: "in_flight", phase: HOST_QUEUE_PHASE });
    return it;
  };
  const setup = async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    return r;
  };

  it("a removal of the enqueued head stops the entry with a fixed code and frees the slot, so the entry behind it can take it", async () => {
    const r = await setup();
    await r.addItem(7);
    await r.addItem(8);
    const it = await hostQueued(r, 7);
    expect(await apply(r, dequeued(7, it.head, "MANUAL"))).toBe(true);
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: HOST_DEQUEUED_REASON, slotHolder: null, phase: null, leaseUntil: null });
    const next = await tenant(r, (c) => takeSlot(c, { accountId: r.accountId, repoId: r.repoId, holder: "t:8", facts: new Map([[r.items.get(8)!.entryId, { open: true, draft: false }]]) }));
    expect(next.taken?.prNumber).toBe(8);
  });

  it("a replay of the same delivery x3 changes nothing after the first", async () => {
    const r = await setup();
    await r.addItem(7);
    const it = await hostQueued(r, 7);
    await apply(r, dequeued(7, it.head, "CI_FAILURE"));
    const first = await r.entry(7);
    for (let i = 0; i < 2; i++) await apply(r, dequeued(7, it.head, "CI_FAILURE"));
    expect(await r.entry(7)).toEqual(first);
  });

  it("the stale-head rule: a removal of a head the item has moved on from changes nothing; the newest enqueued head is the one that counts", async () => {
    const r = await setup();
    await r.addItem(7);
    const it = await hostQueued(r, 7);
    // The head moved and the item was enqueued again at the new head: the old head's removal is stale, the new head's is not.
    const moved = shaOf(7, "fresh");
    await enqueueFact(r, it, moved);
    await apply(r, dequeued(7, it.head, "MANUAL"));
    expect(await r.entry(7)).toMatchObject({ state: "in_flight", phase: HOST_QUEUE_PHASE });
    await apply(r, dequeued(7, shaOf(7, "tip"), "MANUAL"));
    expect(await r.entry(7)).toMatchObject({ state: "in_flight", phase: HOST_QUEUE_PHASE });
    await apply(r, dequeued(7, moved, "MANUAL"));
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: HOST_DEQUEUED_REASON });
  });

  it.each(["MERGE", "ALREADY_MERGED"])("the queue's own success (%s) stops nothing: the merge's close settles the entry", async (reason) => {
    const r = await setup();
    await r.addItem(7);
    const it = await hostQueued(r, 7);
    await apply(r, dequeued(7, it.head, reason));
    expect(await r.entry(7)).toMatchObject({ state: "in_flight", phase: HOST_QUEUE_PHASE });
  });

  it("an entry that is not waiting in the host's queue (parked, queued, or with no enqueue fact) is not touched by a removal", async () => {
    const r = await setup();
    await r.addItem(7);
    await r.addItem(8);
    const it = r.items.get(7)!;
    await tenant(r, (c) => takeSlot(c, { accountId: r.accountId, repoId: r.repoId, holder: "t", facts: new Map([[it.entryId, { open: true, draft: false }]]) }));
    await tenant(r, (c) => renewSlot(c, { accountId: r.accountId, entryId: it.entryId, holder: "t", phase: PARKED_PHASE }));
    await enqueueFact(r, it, it.head);
    await apply(r, dequeued(7, it.head, "MANUAL"));
    expect(await r.entry(7)).toMatchObject({ state: "in_flight", phase: PARKED_PHASE });
    await apply(r, dequeued(8, r.items.get(8)!.head, "MANUAL"));
    expect(await r.entry(8)).toMatchObject({ state: "queued" });
    // In the host-queue phase but with no enqueue fact on record: nothing says which head was sent, so nothing is settled.
    await tenant(r, (c) => renewSlot(c, { accountId: r.accountId, entryId: it.entryId, holder: "t", phase: HOST_QUEUE_PHASE }));
    await apply(r, dequeued(7, shaOf(7, "tip"), "MANUAL"));
    expect(await r.entry(7)).toMatchObject({ state: "in_flight", phase: HOST_QUEUE_PHASE });
  });

  it("a malformed removal (no number, no head, a head that is not a commit id) changes nothing and never throws", async () => {
    const r = await setup();
    await r.addItem(7);
    await hostQueued(r, 7);
    for (const payload of [dequeued(0, shaOf(7, "head"), "MANUAL"), dequeued(7, "main", "MANUAL"), { action: "dequeued", pull_request: { number: 7 } }, { action: "dequeued" }, null]) await apply(r, payload);
    expect(await r.entry(7)).toMatchObject({ state: "in_flight", phase: HOST_QUEUE_PHASE });
  });

  it("a merge of an entry waiting in the host's queue settles it as merged by the gate, and frees the slot; a merge of any other entry is a person's", async () => {
    const r = await setup();
    await r.addItem(7);
    await r.addItem(8);
    const it = await hostQueued(r, 7);
    await apply(r, closedMerged(7, it.head));
    expect(await r.entry(7)).toMatchObject({ state: "merged", mergedBy: "gate", slotHolder: null, phase: null });
    await apply(r, closedMerged(8, r.items.get(8)!.head));
    expect(await r.entry(8)).toMatchObject({ state: "merged", mergedBy: "person" });
  });

  it("out of order: the merge's close before the removal, and the removal before the close, both end merged; x3 replays change nothing", async () => {
    for (const order of [["closed", "dequeued"], ["dequeued", "closed"]] as const) {
      const r = await setup();
      await r.addItem(7);
      const it = await hostQueued(r, 7);
      const deliveries = { closed: closedMerged(7, it.head), dequeued: dequeued(7, it.head, "MERGE") };
      for (let round = 0; round < 3; round++) for (const name of order) await apply(r, deliveries[name]);
      expect(await r.entry(7)).toMatchObject({ state: "merged", mergedBy: "gate", slotHolder: null });
    }
  });

  it("closed before a user's removal: the entry stays closed and the late removal does not reopen it; the removal before the close ends closed too", async () => {
    for (const order of [["closed", "dequeued"], ["dequeued", "closed"]] as const) {
      const r = await setup();
      await r.addItem(7);
      const it = await hostQueued(r, 7);
      const deliveries = { closed: { action: "closed", pull_request: { number: 7, merged: false, head: { sha: it.head } } }, dequeued: dequeued(7, it.head, "MANUAL") };
      for (const name of order) await apply(r, deliveries[name]);
      expect((await r.entry(7)).state).toBe("closed");
    }
  });
});
