import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { enqueueDedupeKey, listHeadRemovals, recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { NO_ANSWER_CODE, isQueuedSql, removalRetryAllowed } from "@fx/core/src/work-items/mergeReadiness.js";
import { PERSON_REQUEUE_REASON } from "@fx/core/src/work-items/queueIntent.js";
import { DEQUEUE_PULL_REQUEST_DOCUMENT, ENABLE_AUTO_MERGE_DOCUMENT, ENQUEUE_PULL_REQUEST_DOCUMENT, MERGE_QUEUE_ENTRY_DOCUMENT, MERGE_QUEUE_READ_DOCUMENT, MERGE_QUEUE_REMOVAL_DOCUMENT } from "../../../github/src/mergeGateGraphql.js";
import { createGitHubMergeGatePort, type GitHubHttp } from "../../src/build/githubMergePort.js";
import { HOST_DEQUEUED_REASON, HOST_RETRY_USED_REASON, NO_ANSWER_REASON, readHostQueued, reconcileHostQueued, releaseToQueue, takeSlot } from "../../src/mergeQueue/index.js";
import { fakeGitHubRest, freshRepo, type FakeRepoState } from "../review/helpers/fakeGitHubRest.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedRepo } from "../build/helpers/seed.js";
import { startQueueRepo, type QueueItem, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#694 B6-4: the bounded reconcile of entries waiting in the host's merge queue, against real Postgres (row security in force) and GitHub's strict GraphQL fake behind
 * the real port. Facts are aged by moving their stamps back; `at(minutes)` moves the reconcile's clock forward.
 */
let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

it("the card's no_answer code is the one the reconcile writes", () => {
  expect(NO_ANSWER_CODE).toBe(NO_ANSWER_REASON);
});

describe("reconcile of entries waiting in the host's queue [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(r: QueueRepo, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, r.accountId, fn);
  const at = (minutes: number) => () => new Date(Date.now() + minutes * 60_000);
  const DOCS = { read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT, dequeue: DEQUEUE_PULL_REQUEST_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT, removal: MERGE_QUEUE_REMOVAL_DOCUMENT };

  /** GitHub: one strict fake per pull request behind the real port; `reads` counts the entry reads. */
  /** GitHub's removal event for `head`: who did it and why. */
  const removedBy = (head: string, actor: string | null, reason: string | null = "DEQUEUED", oid: string | null = head) => ({ createdAt: "2026-11-01T10:00:00Z", reason, actor: actor === null ? null : { __typename: actor }, beforeCommit: oid === null ? null : { oid } });
  const world = (r: QueueRepo, github: Record<number, Partial<FakeRepoState> & { entry?: boolean; readFails?: boolean; removal?: NonNullable<FakeRepoState["mergeQueue"]>["removal"]; removalFails?: boolean }>) => {
    const states = new Map<number, FakeRepoState>();
    for (const [n, o] of Object.entries(github)) {
      const it = r.items.get(Number(n))!;
      const { entry, readFails, removal, removalFails, ...rest } = o;
      states.set(it.pr, freshRepo({ prNumber: it.pr, headSha: it.head, mergeQueue: { exists: true, mutations: [], ...(entry ? { entry: { id: "MQE_kwDOentry1", state: "QUEUED", position: 1 } } : {}), ...(readFails ? { readFails } : {}), ...(removal ? { removal } : {}), ...(removalFails ? { removalFails } : {}) }, ...rest }));
    }
    let reads = 0;
    const http: GitHubHttp = { request: (req) => (reads++, fakeGitHubRest(states.get(((req.body as { variables?: { number?: number } }).variables ?? {}).number!)!).request(req)) };
    const port = createGitHubMergeGatePort({ http, resolveRepo: async () => ({ owner: "acme", name: "widgets" }), markReadyForHumanMerge: async () => undefined, queueDocuments: DOCS });
    let opened = 0;
    return { reads: () => reads, opened: () => opened, github: async () => (opened++, { getQueueEntry: (pr: Parameters<NonNullable<typeof port.getQueueEntry>>[0]) => port.getQueueEntry!(pr), getLastQueueRemoval: (pr: Parameters<NonNullable<typeof port.getQueueEntry>>[0]) => port.getLastQueueRemoval!(pr) }) };
  };
  const run = (r: QueueRepo, w: ReturnType<typeof world>, o: { now?: () => Date; maxReads?: number } = {}) =>
    reconcileHostQueued({ github: w.github, inTenant: (id, fn) => withTenant(db.pureAppUserPool, id, fn), ...(o.now ? { now: o.now } : {}) }, { accountId: r.accountId, repoId: r.repoId, maxReads: o.maxReads ?? 20 });

  const fact = (r: QueueRepo, it: QueueItem, kind: "merge_enqueued" | "merge_dequeued", key: string, o: { actor?: "user" | "app"; head?: string } = {}) =>
    tenant(r, (c) =>
      recordDriverEvent(c, r.accountId, { workItemId: it.workItemId, kind, dedupeKey: key, code: kind === "merge_enqueued" ? "queue" : "ci_failure", ...(kind === "merge_dequeued" ? { reasons: [`actor_${o.actor ?? "app"}`] } : {}), headSha: o.head ?? it.head, prNumber: it.pr }),
    );
  /** Every fact so far happened `minutes` ago. */
  const age = (it: QueueItem, minutes: number) => db.admin.query(`UPDATE work_item_driver_events SET created_at = created_at - make_interval(mins => $2) WHERE work_item_id = $1`, [it.workItemId, minutes]);
  /** The entry row's own stamp (the database's clock, set by a trigger) moved back: the entry was last touched `minutes` ago. */
  const ageEntry = async (it: QueueItem, minutes: number) => {
    await db.admin.query(`ALTER TABLE merge_queue_entries DISABLE TRIGGER USER`);
    try {
      await db.admin.query(`UPDATE merge_queue_entries SET updated_at = updated_at - make_interval(mins => $2) WHERE id = $1`, [it.entryId, minutes]);
    } finally {
      await db.admin.query(`ALTER TABLE merge_queue_entries ENABLE TRIGGER USER`);
    }
  };
  const setup = async (prs: number[], enqueuedMinutesAgo = 30) => {
    const r = await startQueueRepo(db);
    repos.push(r);
    for (const pr of prs) {
      const it = await r.addItem(pr);
      await db.admin.query(`UPDATE work_items SET stage = 'review_passed' WHERE id = $1`, [it.workItemId]);
      await fact(r, it, "merge_enqueued", enqueueDedupeKey(it.head, 0));
      await age(it, enqueuedMinutesAgo);
      await ageEntry(it, enqueuedMinutesAgo);
    }
    return r;
  };
  const stage = async (it: QueueItem) => (await db.admin.query<{ stage: string }>(`SELECT stage FROM work_items WHERE id = $1`, [it.workItemId])).rows[0]!.stage;
  const facts = async (it: QueueItem, kind: string) => (await db.admin.query<{ code: string | null }>(`SELECT code FROM work_item_driver_events WHERE work_item_id = $1 AND kind = $2 ORDER BY seq`, [it.workItemId, kind])).rows.map((x) => x.code);
  const queued = (r: QueueRepo, it: QueueItem) => tenant(r, async (c) => (await c.query<{ q: boolean }>(`SELECT ${isQueuedSql("$1::uuid", "$2::uuid", String(it.pr))} AS q`, [r.accountId, it.workItemId])).rows[0]!.q);

  it("a lost merge settles as merged by the queue: the fact, the entry (the gate's) and the item once; a replay and a later pass change nothing", async () => {
    const r = await setup([7]);
    const it = r.items.get(7)!;
    const w = world(r, { 7: { state: "closed", merged: true } });
    expect(await run(r, w)).toEqual({ reads: 1, settled: 1, escalated: 0 });
    expect(await r.entry(7)).toMatchObject({ state: "merged", mergedBy: "gate", slotHolder: null });
    expect(await stage(it)).toBe("merged");
    expect(await facts(it, "merged_via_queue")).toHaveLength(1);
    expect(await run(r, w, { now: at(60) })).toEqual({ reads: 0, settled: 0, escalated: 0 });
    expect(w.reads()).toBe(1);
  });

  it("a merge at a head other than the one enqueued is still recorded as the queue's merge, with the difference raised once", async () => {
    const r = await setup([7]);
    const it = r.items.get(7)!;
    await run(r, world(r, { 7: { state: "closed", merged: true, headSha: it.fresh } }));
    expect(await facts(it, "escalated")).toEqual(["merged_head_differs"]);
    expect(await r.entry(7)).toMatchObject({ state: "merged", mergedBy: "gate" });
  });

  it("closed without merging ends the entry as closed", async () => {
    const r = await setup([7]);
    await run(r, world(r, { 7: { state: "closed" } }));
    expect((await r.entry(7)).state).toBe("closed");
  });

  it("a lost removal counts as a dequeue: the first is retried once (the entry stays queued and is eligible again), the second hands the item to a person", async () => {
    const r = await setup([7]);
    const it = r.items.get(7)!;
    const w = world(r, { 7: { removal: removedBy(it.head, "Bot") } });
    expect(await run(r, w)).toEqual({ reads: 1, settled: 1, escalated: 0 });
    expect(await facts(it, "merge_dequeued")).toEqual(["not_in_queue_reconciled"]);
    expect(await r.entry(7)).toMatchObject({ state: "queued", reason: null });
    expect(await queued(r, it)).toBe(false);
    const again = await tenant(r, (c) => takeSlot(c, { accountId: r.accountId, repoId: r.repoId, holder: "t", facts: new Map([[it.entryId, { open: true, draft: false }]]) }));
    expect(again.taken?.prNumber).toBe(7);
    await tenant(r, (c) => releaseToQueue(c, { accountId: r.accountId, entryId: it.entryId, holder: "t" }));
    // The tick enqueues the head again; the host's queue drops it again and the delivery is lost again.
    await fact(r, it, "merge_enqueued", enqueueDedupeKey(it.head, 1));
    await age(it, 30);
    expect(await run(r, w, { now: at(15) })).toEqual({ reads: 1, settled: 1, escalated: 0 });
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: HOST_RETRY_USED_REASON });
    expect(await stage(it)).toBe("needs_human");
    expect(await facts(it, "escalated")).toEqual([HOST_RETRY_USED_REASON]);
    expect(await facts(it, "merge_dequeued")).toEqual(["not_in_queue_reconciled", "not_in_queue_reconciled"]);
  });

  it("B6-5: a lost removal that follows a Remove press of that head within ten minutes is recorded as the person's own (actor_you) and gets no retry; an older press is GitHub's, and is retried", async () => {
    const r = await setup([7, 8]);
    const pressed = r.items.get(7)!;
    const old = r.items.get(8)!;
    const audit = (it: QueueItem, minutesAgo: number) =>
      db.admin.query(`INSERT INTO audit_log (account_id, actor, action, payload, created_at) VALUES ($1, 'tester', 'work_item.sent_back', $2::jsonb, now() - make_interval(mins => $3))`, [
        r.accountId,
        JSON.stringify({ action: "queue_remove", work_item_id: it.workItemId, pr_number: it.pr, head_sha: it.head }),
        minutesAgo,
      ]);
    await audit(pressed, 2);
    await audit(old, 11);
    const w = world(r, { 7: {}, 8: { removal: removedBy(old.head, "Bot") } });
    await run(r, w);
    // The pressed head's removal is "you" without asking GitHub who did it: two entry reads and one removal read (for the older press).
    expect(w.reads()).toBe(3);
    const reasons = async (it: QueueItem) => (await db.admin.query<{ reasons: string[] }>(`SELECT reasons FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'merge_dequeued'`, [it.workItemId])).rows.map((x) => x.reasons[0]);
    expect(await reasons(pressed)).toEqual(["actor_you"]);
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: HOST_DEQUEUED_REASON });
    expect(await reasons(old)).toEqual(["actor_app"]);
    expect(await r.entry(8)).toMatchObject({ state: "queued", reason: null });
  });

  /** The reconcile's `merge_dequeued` rows for the head: their reasons, and whether the retry rule would allow another enqueue. */
  const recorded = async (r: QueueRepo, it: QueueItem) => {
    const removals = await tenant(r, (c) => listHeadRemovals(c, r.accountId, it.workItemId, it.head, it.pr));
    return { reasons: removals.map((x) => x.reasons), retry: removalRetryAllowed(removals) };
  };

  it("the removal's actor is read once from GitHub: a Bot removal is the queue's own and is retried once; a person's (a User with no reason, or reason MANUAL even from a Bot) is not retried and stops the entry", async () => {
    for (const [removal, reasons, retry] of [
      [(h: string) => removedBy(h, "Bot"), ["actor_app"], true],
      [(h: string) => removedBy(h, "User", null), ["actor_user"], false],
      [(h: string) => removedBy(h, "Bot", "MANUAL"), ["actor_user"], false],
    ] as const) {
      const r = await setup([7]);
      const it = r.items.get(7)!;
      const w = world(r, { 7: { removal: removal(it.head) } });
      expect(await run(r, w)).toEqual({ reads: 1, settled: 1, escalated: 0 });
      // The entry read and the removal read are the only calls, and the second runs once.
      expect(w.reads()).toBe(2);
      expect(await recorded(r, it)).toEqual({ reasons: [reasons], retry });
      expect(await r.entry(7)).toMatchObject(retry ? { state: "queued", reason: null } : { state: "stopped", reason: HOST_DEQUEUED_REASON });
    }
  });

  it("fails toward a person: a failed read, no event, an event for another head, or an actor GitHub did not name each record the removal as a person's, with no retry", async () => {
    const cases: Array<[string, (h: string) => Record<string, unknown>]> = [
      ["the read fails (HTTP 502)", () => ({ removal: removedBy("x".repeat(40), "Bot"), removalFails: true })],
      ["there is no removal event", () => ({})],
      ["the event is for another head", () => ({ removal: removedBy("x".repeat(40), "Bot") })],
      ["the event names no commit", (h) => ({ removal: removedBy(h, "Bot", "DEQUEUED", null) })],
      ["the event has no actor", (h) => ({ removal: removedBy(h, null) })],
    ];
    for (const [name, over] of cases) {
      const r = await setup([7]);
      const it = r.items.get(7)!;
      await run(r, world(r, { 7: over(it.head) }));
      expect(await recorded(r, it), name).toEqual({ reasons: [["actor_user"]], retry: false });
      expect(await r.entry(7), name).toMatchObject({ state: "stopped", reason: HOST_DEQUEUED_REASON });
    }
  });

  it("the removal is read only for a pull request that is open and not queued: not for a merge, a close, a pull request still queued, an auto-merge enqueue without an entry, or a removal already on record", async () => {
    const a = await setup([7, 8, 9]);
    const w = world(a, { 7: { state: "closed", merged: true }, 8: { state: "closed" }, 9: { entry: true } });
    await run(a, w);
    expect(w.reads()).toBe(3);
    const b = await setup([7]);
    const hold = b.items.get(7)!;
    await fact(b, hold, "merge_dequeued", "dequeued:d1", { actor: "user" });
    await age(hold, 30);
    const wb = world(b, { 7: {} });
    await run(b, wb);
    expect(wb.reads()).toBe(1);
  });

  it("a person's removal that the webhook recorded but never settled holds: the entry stops with no retry", async () => {
    const r = await setup([7]);
    const it = r.items.get(7)!;
    await fact(r, it, "merge_dequeued", "dequeued:d1", { actor: "user" });
    await age(it, 30);
    await run(r, world(r, { 7: {} }));
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: HOST_DEQUEUED_REASON });
    expect(await facts(it, "merge_dequeued")).toEqual(["ci_failure"]);
  });

  it("a manual re-enqueue that was never recorded is recorded, so the entry reads as queued again and is not enqueued twice; a replay writes nothing", async () => {
    const r = await setup([7]);
    const it = r.items.get(7)!;
    await fact(r, it, "merge_dequeued", "dequeued:d1");
    await age(it, 30);
    const w = world(r, { 7: { entry: true } });
    expect(await run(r, w)).toEqual({ reads: 1, settled: 1, escalated: 0 });
    expect(await queued(r, it)).toBe(true);
    expect(await tenant(r, (c) => readHostQueued(c, r.accountId, r.repoId))).toEqual([{ entryId: it.entryId, prNumber: 7 }]);
    await run(r, w, { now: at(45) });
    expect(await facts(it, "merge_enqueued")).toHaveLength(2);
  });

  it("still in GitHub's queue: left alone (no fact, no state change)", async () => {
    const r = await setup([7]);
    const it = r.items.get(7)!;
    expect(await run(r, world(r, { 7: { entry: true } }))).toEqual({ reads: 1, settled: 0, escalated: 0 });
    expect(await r.entry(7)).toMatchObject({ state: "queued" });
    expect(await stage(it)).toBe("review_passed");
    expect(await facts(it, "merge_dequeued")).toEqual([]);
  });

  it("six hours with no answer stops the entry and moves the item to needs_human once, for a pull request still queued and for one GitHub cannot be read about; sooner, nothing", async () => {
    const r = await setup([7, 8, 9], 120);
    const [a, b, c9] = [7, 8, 9].map((n) => r.items.get(n)!);
    expect(await run(r, world(r, { 7: { entry: true }, 8: { readFails: true }, 9: { entry: true } }))).toMatchObject({ settled: 0, escalated: 0 });
    for (const it of [a!, b!]) await age(it!, 300);
    const w = world(r, { 7: { entry: true }, 8: { readFails: true }, 9: { entry: true } });
    expect(await run(r, w, { now: at(15) })).toEqual({ reads: 3, settled: 0, escalated: 2 });
    for (const [n, it] of [[7, a!], [8, b!]] as const) {
      expect(await r.entry(n)).toMatchObject({ state: "stopped", reason: NO_ANSWER_REASON });
      expect(await stage(it)).toBe("needs_human");
      expect(await facts(it, "escalated")).toEqual([NO_ANSWER_REASON]);
    }
    expect(await r.entry(9)).toMatchObject({ state: "queued" });
    expect(await stage(c9!)).toBe("review_passed");
    expect(await run(r, w, { now: at(60) })).toMatchObject({ escalated: 0 });
  });

  it("B6-5: after a person's Queue again of the same head, the host's next six-hour silence is its own escalation (the next cycle), once", async () => {
    const r = await setup([7], 120);
    const it = r.items.get(7)!;
    await age(it, 300);
    const w = world(r, { 7: { entry: true } });
    expect(await run(r, w, { now: at(15) })).toMatchObject({ escalated: 1 });
    // Queue again: the gate's enqueue of the same head answers the person, and the entry waits in the host's queue again.
    await tenant(r, (c) => recordDriverEvent(c, r.accountId, { workItemId: it.workItemId, kind: "merge_enqueued", dedupeKey: `${enqueueDedupeKey(it.head, 0)}:again`, code: "queue", reasons: [PERSON_REQUEUE_REASON], headSha: it.head, prNumber: it.pr }));
    await db.admin.query(`ALTER TABLE merge_queue_entries DISABLE TRIGGER USER`);
    try {
      await db.admin.query(`UPDATE merge_queue_entries SET state = 'queued', reason = NULL WHERE id = $1`, [it.entryId]);
    } finally {
      await db.admin.query(`ALTER TABLE merge_queue_entries ENABLE TRIGGER USER`);
    }
    await age(it, 400);
    await ageEntry(it, 400);
    expect(await run(r, w, { now: at(30) })).toMatchObject({ escalated: 1 });
    const keys = (await db.admin.query<{ dedupe_key: string }>(`SELECT dedupe_key FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'escalated' ORDER BY seq`, [it.workItemId])).rows.map((e) => e.dedupe_key);
    expect(keys).toEqual([`queue_no_answer:${it.head}`, `queue_no_answer:${it.head}:c1`]);
    expect(await run(r, w, { now: at(60) })).toMatchObject({ escalated: 0 });
  });

  it("bounds: an entry younger than 20 minutes or whose head moved is not read and opens no client; one entry is read once per 10 minutes; one call makes at most maxReads", async () => {
    const r = await setup([7, 8, 9, 10], 30);
    await tenant(r, (c) => recordDriverEvent(c, r.accountId, { workItemId: r.items.get(10)!.workItemId, kind: "pr_head_pushed", dedupeKey: "p1", headSha: r.items.get(10)!.fresh, prNumber: 10 }));
    const solo = await setup([]);
    const young = await solo.addItem(11);
    await fact(solo, young, "merge_enqueued", enqueueDedupeKey(young.head, 0)); // 19 minutes would do; this one is seconds old
    const none = world(solo, { 11: { entry: true } });
    expect(await run(solo, none)).toEqual({ reads: 0, settled: 0, escalated: 0 });
    const w = world(r, { 7: { entry: true }, 8: { entry: true }, 9: { entry: true }, 10: { entry: true } });
    expect(await run(r, w, { maxReads: 2 })).toMatchObject({ reads: 2 });
    expect(w.reads()).toBe(2);
    expect(await run(r, w, { maxReads: 20 })).toMatchObject({ reads: 1 }); // the 2 read just now wait; the third is due; 10 (head moved) and 11 (young) never
    expect(await run(r, w, { maxReads: 20 })).toMatchObject({ reads: 0 });
    expect(await run(r, w, { now: at(11), maxReads: 20 })).toMatchObject({ reads: 3 });
    expect(w.reads()).toBe(6);
    expect(await run(r, w, { maxReads: 0 })).toMatchObject({ reads: 0 });
    expect(none.opened()).toBe(0);
  });

  it("another repository's entries are never read or settled", async () => {
    const a = await setup([7], 1);
    const repoB = randomUUID();
    await seedRepo(db.admin, a.accountId, repoB); // the same account, another repository
    const b = await startQueueRepo(db, { existing: { accountId: a.accountId, repoId: repoB } });
    repos.push(b);
    const itB = await b.addItem(7);
    await db.admin.query(`UPDATE work_items SET stage = 'review_passed' WHERE id = $1`, [itB.workItemId]);
    await fact(b, itB, "merge_enqueued", enqueueDedupeKey(itB.head, 0));
    await age(itB, 30);
    await ageEntry(itB, 30);
    const w = world(b, { 7: { state: "closed", merged: true } });
    expect(await run(a, w)).toEqual({ reads: 0, settled: 0, escalated: 0 }); // B's entry is due, A's is not: A's pass looks at A's repository only
    expect(w.reads()).toBe(0);
    expect(await a.entry(7)).toMatchObject({ state: "queued" });
    expect(await b.entry(7)).toMatchObject({ state: "queued" });
  });

  it("two sweeps racing on one due entry read it once (the claim's compare-and-set)", async () => {
    const r = await setup([7]);
    const w = world(r, { 7: { entry: true } });
    let inner: Awaited<ReturnType<typeof run>> | null = null;
    const racing = { ...w, github: async () => { inner = await run(r, w); return w.github(); } };
    const outer = await run(r, racing);
    expect(inner).toMatchObject({ reads: 1 });
    expect(outer).toMatchObject({ reads: 0 });
    expect(w.reads()).toBe(1);
  });

  it("an entry touched over 10 minutes ago whose enqueue is under 20 minutes old is not read", async () => {
    const r = await setup([7], 15);
    const w = world(r, { 7: { entry: true } });
    expect(await run(r, w)).toEqual({ reads: 0, settled: 0, escalated: 0 });
    expect(w.opened()).toBe(0);
  });

  it("an auto-merge enqueue has no queue entry while its checks run: 30 minutes without one is not a removal; the 6-hour stop still covers it", async () => {
    const r = await setup([7]);
    const it = r.items.get(7)!;
    await db.admin.query(`UPDATE work_item_driver_events SET code = 'auto_merge' WHERE work_item_id = $1 AND kind = 'merge_enqueued'`, [it.workItemId]);
    const w = world(r, { 7: {} });
    expect(await run(r, w)).toEqual({ reads: 1, settled: 0, escalated: 0 });
    expect(w.reads()).toBe(1); // no removal read: an auto-merge enqueue with no entry is not a removal
    expect(await facts(it, "merge_dequeued")).toEqual([]);
    expect(await r.entry(7)).toMatchObject({ state: "queued" });
    expect(await queued(r, it)).toBe(true);
    await age(it, 400);
    expect(await run(r, w, { now: at(15) })).toEqual({ reads: 1, settled: 0, escalated: 1 });
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: NO_ANSWER_REASON });
  });

  it("the 6-hour stop holds when no client can be opened (a failing opener, or a repository no longer read), exactly once; a younger entry is untouched", async () => {
    const r = await setup([7, 8], 420);
    const [a, b] = [7, 8].map((n) => r.items.get(n)!);
    await age(b!, -390); // 8 was enqueued 30 minutes ago
    const w = world(r, { 7: {}, 8: {} });
    const failing = { ...w, github: async () => { throw new Error("token mint failed"); } };
    expect(await run(r, failing)).toEqual({ reads: 0, settled: 0, escalated: 1 });
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: NO_ANSWER_REASON });
    expect(await stage(a!)).toBe("needs_human");
    expect(await facts(a!, "escalated")).toEqual([NO_ANSWER_REASON]);
    expect(await r.entry(8)).toMatchObject({ state: "queued" });
    expect(await run(r, failing, { now: at(15) })).toEqual({ reads: 0, settled: 0, escalated: 0 });
    expect(await facts(a!, "escalated")).toEqual([NO_ANSWER_REASON]);
    const r2 = await setup([7], 420);
    expect(await run(r2, { ...w, github: async () => null as unknown as Awaited<ReturnType<typeof w.github>> })).toEqual({ reads: 0, settled: 0, escalated: 1 });
    expect(await r2.entry(7)).toMatchObject({ state: "stopped", reason: NO_ANSWER_REASON });
    expect(w.reads()).toBe(0);
  });

  it("a claim that throws counts as a read and the other entries still go", async () => {
    const r = await setup([7, 8]);
    const w = world(r, { 7: { entry: true }, 8: { entry: true } });
    let calls = 0;
    const inTenant = <T,>(id: string, fn: (c: PoolClient) => Promise<T>) => (++calls === 2 ? Promise.reject(new Error("db blip")) : withTenant(db.pureAppUserPool, id, fn));
    const out = await reconcileHostQueued({ github: w.github, inTenant }, { accountId: r.accountId, repoId: r.repoId, maxReads: 20 });
    expect(out.reads).toBe(2);
    expect(w.reads()).toBe(1);
  });
  it("SR: an auto-merge enqueue with a recorded removal is still settled from the facts (a person's removal stops it)", async () => {
    const r = await setup([7]);
    const it = r.items.get(7)!;
    await db.admin.query(`UPDATE work_item_driver_events SET code = 'auto_merge' WHERE work_item_id = $1 AND kind = 'merge_enqueued'`, [it.workItemId]);
    await fact(r, it, "merge_dequeued", "dequeued:d1", { actor: "user" });
    await age(it, 30);
    await run(r, world(r, { 7: {} }));
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: HOST_DEQUEUED_REASON });
  });
});
