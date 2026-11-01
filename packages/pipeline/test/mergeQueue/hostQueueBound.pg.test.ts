import { afterEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { enqueueDedupeKey, listHeadRemovals, recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { ENQUEUE_PULL_REQUEST_DOCUMENT } from "../../../github/src/mergeGateGraphql.js";
import { applyQueueEvent, runQueueTick, type QueueGateResult, type QueueTickDeps } from "../../src/mergeQueue/index.js";
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
        recordDriverEvent(c, r.accountId, { workItemId: entry.workItemId!, kind: "merge_enqueued", dedupeKey: enqueueDedupeKey(headSha, (await listHeadRemovals(c, r.accountId, entry.workItemId!, headSha, entry.prNumber)).length), code: "queue", headSha, prNumber: entry.prNumber }),
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
});
