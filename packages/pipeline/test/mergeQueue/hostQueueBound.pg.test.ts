import { afterEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { enqueueDedupeKey, listHeadRemovals, recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { PERSON_REQUEUE_REASON, queueAgainPending } from "@fx/core/src/work-items/queueIntent.js";
import { operatorVerdict, readOperatorFacts } from "@fx/core/src/work-items/operatorActions.js";
import { readReviewHold } from "@fx/core/src/work-items/reviewHold.js";
import { ENQUEUE_PULL_REQUEST_DOCUMENT } from "../../../github/src/mergeGateGraphql.js";
import { applyQueueEvent, enqueueEntry, returnToReview, runQueueTick, type QueueGateResult, type QueueTickDeps } from "../../src/mergeQueue/index.js";
import { fakeGitHubRest, freshRepo, type FakeRepoState } from "../review/helpers/fakeGitHubRest.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { startQueueRepo, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#694 B6-3: the number of pull requests of one repository waiting in the host's merge queue is bounded by the rule's `max_entries_to_build` (1 when it cannot be read),
 * the product queue never updates a branch that is behind a merge queue, and a removal gets one automatic retry. Real Postgres; the enqueue goes to the strict GitHub
 * fake, which enforces the pinned document and well-formed variables and logs every mutation that reached it.
 */
let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("host-queue bound and retry through the tick [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(r: QueueRepo, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, r.accountId, fn);

  /** One strict GitHub fake per pull request; the gate stub is the production gate's enqueue step: the pinned mutation, then the driver fact. */
  const world = async (prs: number[], queueInfo: QueueTickDeps["queueInfo"]) => {
    const r = await startQueueRepo(db);
    repos.push(r);
    const gh = new Map<number, FakeRepoState>();
    for (const pr of prs) {
      const it = await r.addItem(pr);
      gh.set(pr, freshRepo({ prNumber: pr, headSha: it.head, mergeQueue: { exists: true, mutations: [] } }));
    }
    const enqueues = () => [...gh.values()].flatMap((s) => s.mergeQueue!.mutations.filter((m) => m.kind === "enqueue").map(() => s.prNumber));
    const gate: QueueTickDeps["gate"] = async ({ entry, headSha }): Promise<QueueGateResult> => {
      const s = gh.get(entry.prNumber)!;
      const res = await fakeGitHubRest(s).request({ method: "POST", path: "/graphql", body: { query: ENQUEUE_PULL_REQUEST_DOCUMENT, variables: { pullRequestId: `PR_kwDOfake${entry.prNumber}`, expectedHeadOid: headSha } } });
      expect(res.status).toBe(200);
      await tenant(r, async (c) =>
        recordDriverEvent(c, r.accountId, { workItemId: entry.workItemId!, kind: "merge_enqueued", dedupeKey: enqueueDedupeKey(headSha, (await listHeadRemovals(c, r.accountId, entry.workItemId!, headSha, entry.prNumber, { all: true })).length), code: "queue", ...((await queueAgainPending(c, r.accountId, entry.workItemId!, entry.prNumber, headSha)) ? { reasons: [PERSON_REQUEUE_REASON] } : {}), headSha, prNumber: entry.prNumber }),
      );
      return { outcome: "merge_enqueued" };
    };
    const tick = () => runQueueTick(r.deps({ gate, ...(queueInfo ? { queueInfo } : {}) }), r);
    return { r, gh, enqueues, tick };
  };
  const webhook = (r: QueueRepo, payload: unknown) => tenant(r, (c) => applyQueueEvent(c, { accountId: r.accountId, repoId: r.repoId, eventName: "pull_request", payload }));

  it("3 ready pull requests on a queue with a batch size of 2: exactly 2 enqueues, the third waits and goes when one of the two ends", async () => {
    const w = await world([7, 8, 9], async () => ({ mode: "queue", maxEntries: 2 }));
    const out = await w.tick();
    expect(out.steps.map((s) => (s.step === "released" ? s.why : s.step === "idle" ? s.why : s.step))).toEqual(["host_queued", "host_queued", "host_queue_full"]);
    expect(w.enqueues()).toEqual([7, 8]);
    expect(await w.r.entry(9)).toMatchObject({ state: "queued" });
    expect(await w.r.entry(7)).toMatchObject({ state: "queued", slotHolder: null });
    await w.tick();
    expect(w.enqueues()).toEqual([7, 8]);
    // Pull request 7 merges through the queue: the webhook settles it and the third now goes.
    const it7 = w.r.items.get(7)!;
    await tenant(w.r, (c) => recordDriverEvent(c, w.r.accountId, { workItemId: it7.workItemId, kind: "merged_via_queue", dedupeKey: "m7", headSha: it7.head, prNumber: 7 }));
    await webhook(w.r, { action: "closed", pull_request: { number: 7, merged: true, head: { sha: it7.head } } });
    await w.tick();
    expect(w.enqueues()).toEqual([7, 8, 9]);
  });

  it("a batch size that cannot be read is 1: one enqueue, the others wait", async () => {
    const w = await world([7, 8], async () => {
      throw new Error("unreadable");
    });
    await w.tick();
    expect(w.enqueues()).toEqual([7]);
  });

  it("no update-branch and no branch comparison is made for an entry behind a merge queue, even when the branch is behind its base", async () => {
    const w = await world([7, 8], async () => ({ mode: "queue", maxEntries: 2 }));
    w.r.mainMoved(0);
    await w.tick();
    expect(w.enqueues()).toEqual([7, 8]);
    expect(w.r.calls.filter((c) => c.path.includes("update-branch") || c.path.includes("/compare/"))).toEqual([]);
  });

  it("the retry limit holds with no webhook settle at all: the second removal fact is on record, the tick takes the entry and enqueues nothing, and the item goes to a person", async () => {
    const w = await world([7], async () => ({ mode: "queue", maxEntries: 1 }));
    const it = w.r.items.get(7)!;
    await db.admin.query(`UPDATE work_items SET stage = 'review_passed' WHERE id = $1`, [it.workItemId]);
    await w.tick();
    for (const i of [1, 2]) {
      await tenant(w.r, (c) => recordDriverEvent(c, w.r.accountId, { workItemId: it.workItemId, kind: "merge_dequeued", dedupeKey: `x${i}`, code: "ci_failure", reasons: ["actor_app"], headSha: it.head, prNumber: 7 }));
    }
    const out = await w.tick();
    expect(out.steps).toEqual([{ step: "released", entryId: it.entryId, why: "merge_queue_retry_used" }, { step: "idle", why: "waiting_mergeability" }]);
    expect(w.enqueues()).toEqual([7]);
    expect(await w.r.entry(7)).toMatchObject({ state: "stopped", reason: "merge_queue_retry_used" });
    expect((await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [it.workItemId])).rows[0]).toEqual({ stage: "needs_human" });
  });

  it("a person's removal on record with no settle stops the entry at the take: no automatic enqueue", async () => {
    const w = await world([7], async () => ({ mode: "queue", maxEntries: 1 }));
    const it = w.r.items.get(7)!;
    await w.tick();
    await tenant(w.r, (c) => recordDriverEvent(c, w.r.accountId, { workItemId: it.workItemId, kind: "merge_dequeued", dedupeKey: "u1", code: "manual", reasons: ["actor_user"], headSha: it.head, prNumber: 7 }));
    await w.tick();
    expect(w.enqueues()).toEqual([7]);
    expect(await w.r.entry(7)).toMatchObject({ state: "stopped", reason: "removed_from_merge_queue" });
  });

  it("a halted item is not retried: after a GitHub removal its entry is left out of the take and nothing is enqueued", async () => {
    const w = await world([7, 8], async () => ({ mode: "queue", maxEntries: 2 }));
    const it = w.r.items.get(7)!;
    await w.tick();
    expect(w.enqueues()).toEqual([7, 8]);
    await tenant(w.r, (c) => recordDriverEvent(c, w.r.accountId, { workItemId: it.workItemId, kind: "merge_dequeued", dedupeKey: "g1", code: "ci_failure", reasons: ["actor_app"], headSha: it.head, prNumber: 7 }));
    await db.admin.query(`UPDATE work_items SET halted_at = now(), halt_action_id = gen_random_uuid() WHERE id = $1`, [it.workItemId]);
    await w.tick();
    expect(w.enqueues()).toEqual([7, 8]);
    expect(await w.r.entry(7)).toMatchObject({ state: "queued" });
  });

  it("a removal by GitHub is retried once on the same head (a second enqueue), the second removal stops it: no third enqueue", async () => {
    const w = await world([7], async () => ({ mode: "queue", maxEntries: 1 }));
    const it = w.r.items.get(7)!;
    const removal = async () => {
      await tenant(w.r, (c) => recordDriverEvent(c, w.r.accountId, { workItemId: it.workItemId, kind: "merge_dequeued", dedupeKey: `d${Math.random()}`, code: "ci_failure", reasons: ["actor_app"], headSha: it.head, prNumber: 7 }));
      await webhook(w.r, { action: "dequeued", reason: "CI_FAILURE", pull_request: { number: 7, merged: false, head: { sha: it.head } } });
    };
    await w.tick();
    await removal();
    await w.tick();
    expect(w.enqueues()).toEqual([7, 7]);
    await removal();
    expect(await w.r.entry(7)).toMatchObject({ state: "stopped", reason: "merge_queue_retry_used" });
    await w.tick();
    expect(w.enqueues()).toEqual([7, 7]);
  });
  it("B6-5: remove (GitHub), retry, remove (GitHub), escalate, Queue again, remove (GitHub): exactly one more automatic retry, then the next removal escalates again, and a second Queue again goes back through the gate", async () => {
    const w = await world([7], async () => ({ mode: "queue", maxEntries: 1 }));
    const it = w.r.items.get(7)!;
    await db.admin.query(`UPDATE work_items SET stage = 'review_passed' WHERE id = $1`, [it.workItemId]);
    // The gate's answer for this pull request, which the item's queue state is read against.
    await db.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key, code, head_sha, pr_number) VALUES ($1, $2, 'merge_gate', 'g7', 'queue', $3, 7)`, [w.r.accountId, it.workItemId, it.head]);
    const escalations = async () => (await db.admin.query<{ dedupe_key: string }>(`SELECT dedupe_key FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'escalated' ORDER BY seq`, [it.workItemId])).rows.map((e) => e.dedupe_key);
    /** Held for a person by the queue, with Queue again on offer, and the advance there re-enters the review (not a rebuild). */
    const heldForQueueAgain = async () => {
      expect((await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [it.workItemId])).rows[0]).toEqual({ stage: "needs_human" });
      expect(await tenant(w.r, (c) => readReviewHold(c, it.workItemId))).toBe(true);
      expect(operatorVerdict("queue_again", (await tenant(w.r, (c) => readOperatorFacts(c, it.workItemId, "owner")))!)).toEqual({ ok: true });
    };
    const removal = async (i: number) => {
      await tenant(w.r, (c) => recordDriverEvent(c, w.r.accountId, { workItemId: it.workItemId, kind: "merge_dequeued", dedupeKey: `seq${i}`, code: "ci_failure", reasons: ["actor_app"], headSha: it.head, prNumber: 7 }));
      await webhook(w.r, { action: "dequeued", reason: "CI_FAILURE", pull_request: { number: 7, merged: false, head: { sha: it.head } } });
    };
    const queueAgain = async () => {
      await db.admin.query(`INSERT INTO audit_log (account_id, actor, action, payload) VALUES ($1, 'tester', 'work_item.sent_back', $2::jsonb)`, [w.r.accountId, JSON.stringify({ action: "queue_again", work_item_id: it.workItemId, pr_number: 7, head_sha: it.head })]);
      // What the Queue again route does besides the audit row: the stopped entry goes back to review, and the item's normal advance queues it again.
      await tenant(w.r, async (c) => {
        await returnToReview(c, { accountId: w.r.accountId, entryId: it.entryId });
        await enqueueEntry(c, { accountId: w.r.accountId, repoId: w.r.repoId, workItemId: it.workItemId, prNumber: 7, headSha: it.head, approvedAt: new Date() });
      });
    };
    await w.tick();
    await removal(1);
    await w.tick();
    expect(w.enqueues()).toEqual([7, 7]);
    await removal(2);
    expect(await w.r.entry(7)).toMatchObject({ state: "stopped", reason: "merge_queue_retry_used" });
    await w.tick();
    expect(w.enqueues()).toEqual([7, 7]);
    // A person queues it again: the two earlier removals no longer count, so the take goes ahead.
    await queueAgain();
    await w.tick();
    expect(w.enqueues()).toEqual([7, 7, 7]);
    const facts = (await db.admin.query<{ dedupe_key: string; reasons: string[] }>(`SELECT dedupe_key, reasons FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'merge_enqueued' ORDER BY seq`, [it.workItemId])).rows;
    expect(facts.map((f) => f.reasons)).toEqual([[], [], [PERSON_REQUEUE_REASON]]);
    expect(new Set(facts.map((f) => f.dedupe_key)).size).toBe(3);
    // GitHub's next removal gets its one retry again...
    await removal(3);
    expect(await w.r.entry(7)).toMatchObject({ state: "queued" });
    await w.tick();
    expect(w.enqueues()).toEqual([7, 7, 7, 7]);
    // ...and only that one.
    await removal(4);
    expect(await w.r.entry(7)).toMatchObject({ state: "stopped", reason: "merge_queue_retry_used" });
    await w.tick();
    expect(w.enqueues()).toEqual([7, 7, 7, 7]);
    // That exhaustion is the second cycle's own escalation, so the item is held for Queue again exactly as after the first.
    expect(await escalations()).toEqual([`queue_retry_used:${it.head}`, `queue_retry_used:${it.head}:c1`]);
    await heldForQueueAgain();
    // A second Queue again: back through the gate on the same head, and the cycle starts afresh once more.
    await queueAgain();
    await w.tick();
    expect(w.enqueues()).toEqual([7, 7, 7, 7, 7]);
    const reasons = (await db.admin.query<{ reasons: string[] }>(`SELECT reasons FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'merge_enqueued' ORDER BY seq`, [it.workItemId])).rows.map((f) => f.reasons);
    expect(reasons).toEqual([[], [], [PERSON_REQUEUE_REASON], [], [PERSON_REQUEUE_REASON]]);
    await removal(5);
    await w.tick();
    expect(w.enqueues()).toEqual([7, 7, 7, 7, 7, 7]);
    await removal(6);
    expect(await escalations()).toEqual([`queue_retry_used:${it.head}`, `queue_retry_used:${it.head}:c1`, `queue_retry_used:${it.head}:c2`]);
    await heldForQueueAgain();
  });
});
