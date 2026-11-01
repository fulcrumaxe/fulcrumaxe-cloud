import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { enqueueDedupeKey, recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { isQueuedSql, readQueuedToMerge } from "@fx/core/src/work-items/mergeReadiness.js";
import type { PoolClient } from "pg";
import { applyQueueEvent, HOST_DEQUEUED_REASON, HOST_RETRY_USED_REASON, readHostQueued, settleHostDequeue, takeSlot } from "../../src/mergeQueue/index.js";
import { seedRepo } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { shaOf, startQueueRepo, type QueueItem, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#694 B6-2 and B6-3: an entry whose pull request waits in the host's merge queue stays `queued` and reads as waiting there from the item's driver facts (never a stored
 * state). The webhook settles it: a merge or a close ends it; the first removal by GitHub of a head is retried once; a person's removal, or a second one, stops it and the
 * second hands the item to a person. A late or replayed delivery never undoes an end. Real Postgres, row security in force.
 */
let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("host-queue settle and the one automatic retry [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(r: QueueRepo, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, r.accountId, fn);
  const apply = (r: QueueRepo, payload: unknown) => tenant(r, (c) => applyQueueEvent(c, { accountId: r.accountId, repoId: r.repoId, eventName: "pull_request", payload }));
  const closedMerged = (pr: number, head: string) => ({ action: "closed", pull_request: { number: pr, merged: true, head: { sha: head } } });

  const fact = (r: QueueRepo, it: QueueItem, kind: "merge_enqueued" | "merge_dequeued" | "merged_via_queue", head: string, o: { code?: string; actor?: "user" | "app"; key?: string; pr?: number } = {}) =>
    tenant(r, (c) =>
      recordDriverEvent(c, r.accountId, {
        workItemId: it.workItemId,
        kind,
        dedupeKey: o.key ?? `${kind}:${randomUUID()}`,
        ...(kind === "merge_dequeued" ? { code: o.code ?? "ci_failure", reasons: [`actor_${o.actor ?? "app"}`] } : kind === "merge_enqueued" ? { code: "queue" } : {}),
        headSha: head,
        prNumber: o.pr ?? it.pr,
      }),
    );
  /** What the webhook does for a removal: the mapper writes the fact, then the queue settles from it. */
  const removal = async (r: QueueRepo, it: QueueItem, head: string, o: { code?: string; actor?: "user" | "app"; payloadReason?: string } = {}) => {
    await fact(r, it, "merge_dequeued", head, o);
    return apply(r, { action: "dequeued", reason: o.payloadReason ?? "CI_FAILURE", pull_request: { number: it.pr, merged: false, head: { sha: head } } });
  };
  const queuedFlag = (r: QueueRepo, it: QueueItem) => tenant(r, async (c) => (await c.query<{ q: boolean }>(`SELECT ${isQueuedSql("$1::uuid", "$2::uuid", String(it.pr))} AS q`, [r.accountId, it.workItemId])).rows[0]!.q);
  const setup = async (prs: number[]) => {
    const r = await startQueueRepo(db);
    repos.push(r);
    for (const pr of prs) await r.addItem(pr);
    return r;
  };
  const enqueued = async (r: QueueRepo, pr: number) => {
    const it = r.items.get(pr)!;
    await fact(r, it, "merge_enqueued", it.head, { key: enqueueDedupeKey(it.head, 0) });
    return it;
  };

  it("an enqueue fact makes the entry read as waiting in the host's queue without any state change; a removal, a merge fact or a new head ends that", async () => {
    const r = await setup([7]);
    const it = await enqueued(r, 7);
    expect(await queuedFlag(r, it)).toBe(true);
    expect(await r.entry(7)).toMatchObject({ state: "queued", slotHolder: null, phase: null });
    expect(await tenant(r, (c) => readHostQueued(c, r.accountId, r.repoId))).toEqual([{ entryId: it.entryId, prNumber: 7 }]);
    expect(await tenant(r, (c) => readQueuedToMerge(c, r.accountId, it.workItemId, it.pr))).toEqual({ headSha: it.head, prNumber: 7 });
    await fact(r, it, "merge_dequeued", it.head, { code: "merge" });
    expect(await queuedFlag(r, it)).toBe(true); // GitHub's success reason ends nothing
    await tenant(r, (c) => recordDriverEvent(c, r.accountId, { workItemId: it.workItemId, kind: "pr_head_pushed", dedupeKey: "p1", headSha: shaOf(7, "fresh"), prNumber: 7 }));
    expect(await queuedFlag(r, it)).toBe(false);
    expect(await tenant(r, (c) => readQueuedToMerge(c, r.accountId, it.workItemId, it.pr))).toBeNull();
    const r2 = await setup([9]);
    const it2 = await enqueued(r2, 9);
    await fact(r2, it2, "merged_via_queue", it2.head);
    expect(await queuedFlag(r2, it2)).toBe(false);
  });

  it("D#694 B6-3: facts of another pull request that a body link attached to the item neither make it queued nor end its queued state", async () => {
    const r = await setup([7]);
    const it = r.items.get(7)!;
    await fact(r, it, "merge_enqueued", shaOf(99, "head"), { pr: 99, key: "other-enq" }); // someone else's pull request, linked by "Closes #N"
    expect(await queuedFlag(r, it)).toBe(false);
    expect(await tenant(r, (c) => readHostQueued(c, r.accountId, r.repoId))).toEqual([]);
    await enqueued(r, 7);
    expect(await queuedFlag(r, it)).toBe(true);
    await fact(r, it, "merge_dequeued", shaOf(99, "head"), { pr: 99, code: "manual" });
    await fact(r, it, "merged_via_queue", shaOf(99, "head"), { pr: 99 });
    await tenant(r, (c) => recordDriverEvent(c, r.accountId, { workItemId: it.workItemId, kind: "pr_head_pushed", dedupeKey: "p99", headSha: shaOf(99, "fresh"), prNumber: 99 }));
    await fact(r, it, "merge_dequeued", shaOf(7, "fresh"), { code: "manual" }); // this pull request, but another head
    expect(await queuedFlag(r, it)).toBe(true);
    expect(await tenant(r, (c) => readQueuedToMerge(c, r.accountId, it.workItemId, 7))).toEqual({ headSha: it.head, prNumber: 7 });
    expect(await removal(r, it, it.head)).toBe(true);
    expect(await queuedFlag(r, it)).toBe(false);
  });

  it("the first removal by GitHub is retried once: the entry stays queued, reads as not waiting, and is eligible again on the same head", async () => {
    const r = await setup([7]);
    const it = await enqueued(r, 7);
    expect(await removal(r, it, it.head)).toBe(true);
    expect(await r.entry(7)).toMatchObject({ state: "queued", reason: null });
    expect(await queuedFlag(r, it)).toBe(false);
    const again = await tenant(r, (c) => takeSlot(c, { accountId: r.accountId, repoId: r.repoId, holder: "t", facts: new Map([[it.entryId, { open: true, draft: false }]]) }));
    expect(again.taken?.prNumber).toBe(7);
  });

  it("the second removal of the same head uses the retry up: the entry stops with a fixed code and the item goes to needs_human with one escalated fact; replays x3 add nothing", async () => {
    const r = await setup([7]);
    const it = await enqueued(r, 7);
    await db.admin.query(`UPDATE work_items SET stage = 'review_passed' WHERE id = $1`, [it.workItemId]);
    await removal(r, it, it.head);
    await fact(r, it, "merge_enqueued", it.head, { key: enqueueDedupeKey(it.head, 1) });
    await removal(r, it, it.head);
    for (let i = 0; i < 2; i++) await apply(r, { action: "dequeued", reason: "CI_FAILURE", pull_request: { number: 7, merged: false, head: { sha: it.head } } });
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: HOST_RETRY_USED_REASON });
    const escalated = await tenant(r, async (c) => (await c.query(`SELECT code FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'escalated'`, [it.workItemId])).rows);
    expect(escalated).toEqual([{ code: HOST_RETRY_USED_REASON }]);
    expect((await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [it.workItemId])).rows[0]).toEqual({ stage: "needs_human" });
  });

  it("a halted item whose retry is used up still moves to needs_human (the park) and stays halted", async () => {
    const r = await setup([7]);
    const it = await enqueued(r, 7);
    await db.admin.query(`UPDATE work_items SET stage = 'review_passed', halted_at = now(), halt_action_id = gen_random_uuid() WHERE id = $1`, [it.workItemId]);
    await removal(r, it, it.head);
    await fact(r, it, "merge_enqueued", it.head, { key: enqueueDedupeKey(it.head, 1) });
    await removal(r, it, it.head);
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: HOST_RETRY_USED_REASON });
    const row = (await db.admin.query(`SELECT stage, halted_at IS NOT NULL AS halted FROM work_items WHERE id = $1`, [it.workItemId])).rows[0];
    expect(row).toEqual({ stage: "needs_human", halted: true });
  });

  it("GitHub's success reasons are not removals: a MERGE dequeue plus one real removal still gets its retry (the count excludes them)", async () => {
    const r = await setup([7]);
    const it = await enqueued(r, 7);
    await fact(r, it, "merge_dequeued", it.head, { code: "merge" });
    await fact(r, it, "merge_dequeued", it.head, { code: "already_merged" });
    await removal(r, it, it.head);
    expect(await r.entry(7)).toMatchObject({ state: "queued" });
  });

  it("a person's removal stops the entry at once and no retry follows", async () => {
    const r = await setup([7]);
    const it = await enqueued(r, 7);
    await removal(r, it, it.head, { actor: "user", payloadReason: "MANUAL" });
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: HOST_DEQUEUED_REASON });
  });

  it("the head rule: a removal of a head the item moved on from, or of an entry with no enqueue fact, changes nothing", async () => {
    const r = await setup([7, 8]);
    const it = await enqueued(r, 7);
    await removal(r, it, shaOf(7, "tip"));
    expect(await r.entry(7)).toMatchObject({ state: "queued" });
    expect(await queuedFlag(r, it)).toBe(true);
    const other = r.items.get(8)!;
    await removal(r, other, other.head);
    expect(await r.entry(8)).toMatchObject({ state: "queued" });
  });

  it("scope: with the same pull request number and head enqueued in two repositories of one account, a settle for repository B never touches repository A's entry", async () => {
    const a = await setup([7]);
    const repoB = randomUUID();
    await seedRepo(db.admin, a.accountId, repoB);
    const b = await startQueueRepo(db, { existing: { accountId: a.accountId, repoId: repoB } });
    repos.push(b);
    const itB = await b.addItem(7);
    const itA = await enqueued(a, 7);
    await fact(b, itB, "merge_enqueued", itB.head, { key: enqueueDedupeKey(itB.head, 0) });
    expect(itA.head).toBe(itB.head);
    await fact(a, itA, "merge_dequeued", itA.head, { actor: "user" }); // only A's item was removed
    const settled = await tenant(a, (c) => settleHostDequeue(c, { accountId: a.accountId, repoId: repoB, prNumber: 7, headSha: itA.head }));
    expect(settled).toEqual({ outcome: "ignored" });
    expect(await a.entry(7)).toMatchObject({ state: "queued" });
    expect((await tenant(a, (c) => settleHostDequeue(c, { accountId: a.accountId, repoId: a.repoId, prNumber: 7, headSha: itA.head }))).outcome).toBe("removed");
  });

  it("a merge of an entry waiting in the host's queue settles it as merged by the gate; any other merge is a person's; out of order and replayed deliveries end merged", async () => {
    const r = await setup([7, 8]);
    const it = await enqueued(r, 7);
    await fact(r, it, "merged_via_queue", it.head);
    for (let i = 0; i < 3; i++) await apply(r, closedMerged(7, it.head));
    expect(await r.entry(7)).toMatchObject({ state: "merged", mergedBy: "gate", slotHolder: null });
    await apply(r, { action: "dequeued", reason: "MERGE", pull_request: { number: 7, merged: true, head: { sha: it.head } } });
    expect((await r.entry(7)).state).toBe("merged");
    await apply(r, closedMerged(8, r.items.get(8)!.head));
    expect(await r.entry(8)).toMatchObject({ state: "merged", mergedBy: "person" });
  });

  it("closed unmerged ends the entry closed, and a late removal does not reopen it", async () => {
    const r = await setup([7]);
    const it = await enqueued(r, 7);
    await apply(r, { action: "closed", pull_request: { number: 7, merged: false, head: { sha: it.head } } });
    await removal(r, it, it.head);
    expect((await r.entry(7)).state).toBe("closed");
  });

  it("a malformed removal (no number, no head, a head that is not a commit id) changes nothing and never throws", async () => {
    const r = await setup([7]);
    await enqueued(r, 7);
    for (const payload of [{ action: "dequeued", pull_request: { number: 0, head: { sha: shaOf(7, "head") } } }, { action: "dequeued", pull_request: { number: 7, head: { sha: "main" } } }, { action: "dequeued", pull_request: { number: 7 } }, { action: "dequeued" }, null]) await apply(r, payload);
    expect(await r.entry(7)).toMatchObject({ state: "queued" });
  });
});
