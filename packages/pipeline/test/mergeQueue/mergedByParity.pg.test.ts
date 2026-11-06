import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordDriverEvent, type DriverEventKind } from "@fx/core/src/work-items/driverEvents.js";
import { recordMergeReceiptOn } from "@fx/db/src/mergeReceipt.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { settlePullRequest } from "../../src/mergeQueue/index.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { startQueueRepo, type QueueItem, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * Two copies of one rule decide "did our gate queue this merge": `gateEnqueueOf` with the pre-check of `recordMergeReceiptOn` (packages/db mergeReceipt.ts, the receipt) and
 * `gateQueuedSql` (store.ts, the queue entry's `merged_by`). This runs one table of fact scenarios through both, against one real database, and requires them to agree:
 * the receipt answering `not_policy` exactly when the entry says `person`. Each row also names the answer it must be, so two copies that drift together still fail.
 */
let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

type Head = "head" | "fresh" | "public" | "other";
type Step =
  | { fact: "merge_gate"; code: string; head?: Head }
  | { fact: "enqueue"; versioned: boolean; head?: Head }
  | { fact: "removal"; code: string; head?: Head }
  | { order: "enqueued" | "merged" | "failed" };
interface Row {
  name: string;
  steps: Step[];
  /** The head the pull request was last enqueued at, and so merged at. */
  merged: Head;
  expect: "gate" | "person";
}

const gate = (code = "merge_enqueued", head?: Head): Step => ({ fact: "merge_gate", code, ...(head ? { head } : {}) });
const hand = (head?: Head): Step => ({ fact: "enqueue", versioned: false, ...(head ? { head } : {}) });
const versioned = (head?: Head): Step => ({ fact: "enqueue", versioned: true, ...(head ? { head } : {}) });
const removed = (code: string, head?: Head): Step => ({ fact: "removal", code, ...(head ? { head } : {}) });

const TABLE: Row[] = [
  { name: "the gate's merge_gate fact, then the webhook's enqueue", steps: [gate(), hand()], merged: "head", expect: "gate" },
  { name: "the gate's own versioned enqueue fact alone", steps: [versioned()], merged: "head", expect: "gate" },
  { name: "a person's own enqueue (the webhook's fact only)", steps: [hand()], merged: "head", expect: "person" },
  { name: "a merge_gate fact of another code is no evidence", steps: [gate("ready_human_merges"), hand()], merged: "head", expect: "person" },
  { name: "the gate's evidence is at another head than the one enqueued", steps: [gate(), hand(), hand("fresh")], merged: "fresh", expect: "person" },
  { name: "a person took the gate's enqueue out, then queued it again by hand", steps: [gate(), hand(), removed("user"), hand()], merged: "head", expect: "person" },
  { name: "GitHub removed it (not a success) and the gate retried: the old merge_gate fact stands (deduped) and a new versioned enqueue follows", steps: [gate(), hand(), removed("ci_failure"), versioned()], merged: "head", expect: "gate" },
  { name: "GitHub's success dequeue is not a removal", steps: [gate(), hand(), removed("merge")], merged: "head", expect: "gate" },
  { name: "a removal of another head does not take the evidence away", steps: [gate(), hand(), removed("user", "fresh")], merged: "head", expect: "gate" },
  { name: "a non-success removal and nothing enqueued after it: not the gate's", steps: [gate(), hand(), removed("user")], merged: "head", expect: "person" },
  { name: "a non-success removal, then only a merge_gate fact and no new enqueue: not the gate's", steps: [versioned(), removed("ci_failure"), gate()], merged: "head", expect: "person" },
  { name: "paired: an order that ended enqueued, with the delegated fact at the reviewed head", steps: [gate("merge_delegated"), { order: "enqueued" }, hand("public")], merged: "public", expect: "gate" },
  { name: "paired: an order that ended merged", steps: [gate("merge_delegated"), { order: "merged" }, hand("public")], merged: "public", expect: "gate" },
  { name: "paired: an order that failed", steps: [gate("merge_delegated"), { order: "failed" }, hand("public")], merged: "public", expect: "person" },
  { name: "paired: no delegated fact at the reviewed head", steps: [gate("ready_human_merges"), { order: "enqueued" }, hand("public")], merged: "public", expect: "person" },
  { name: "paired: the order names another public head than the one enqueued last", steps: [gate("merge_delegated"), { order: "enqueued" }, hand("public"), hand("other")], merged: "other", expect: "person" },
  { name: "paired: a person took the public pull request out and queued it again", steps: [gate("merge_delegated"), { order: "enqueued" }, hand("public"), removed("user", "public"), hand("public")], merged: "public", expect: "person" },
  { name: "paired: removed by GitHub and nothing enqueued after it", steps: [gate("merge_delegated"), { order: "enqueued" }, hand("public"), removed("ci_failure", "public")], merged: "public", expect: "person" },
];

describe("merged_by and the merge receipt decide 'did our gate queue it' alike [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(r: QueueRepo, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, r.accountId, fn);
  const PUBLIC = "b".repeat(40);
  const OTHER = "c".repeat(40);

  const put = (r: QueueRepo, it: QueueItem, kind: DriverEventKind, head: string, o: { code?: string; dialVersion?: number } = {}) =>
    tenant(r, (c) =>
      recordDriverEvent(c, r.accountId, {
        workItemId: it.workItemId,
        kind,
        dedupeKey: `${kind}:${randomUUID()}`,
        ...(o.code !== undefined ? { code: o.code } : {}),
        ...(kind === "merge_dequeued" ? { reasons: [o.code === "user" ? "actor_user" : "actor_app"] } : {}),
        ...(o.dialVersion !== undefined ? { dialVersion: o.dialVersion } : {}),
        headSha: head,
        prNumber: it.pr,
      }),
    );

  async function order(r: QueueRepo, it: QueueItem, state: "enqueued" | "merged" | "failed"): Promise<void> {
    const push = randomUUID();
    await db.admin.query("INSERT INTO plane_pushes (id, account_id, work_item_id, repo_id, code_repo, pairing_digest, state) VALUES ($1, $2, $3, $4, 'acme/widgets-public', $5, 'building')", [push, r.accountId, it.workItemId, r.repoId, "a".repeat(64)]);
    await db.admin.query(
      `INSERT INTO plane_merge_orders (account_id, work_item_id, plane_push_id, repo_id, code_repo, pr_number, expected_public_head, reviewed_head, pairing_digest, deadline_at)
       VALUES ($1, $2, $3, $4, 'acme/widgets-public', $5, $6, $7, $8, now() + interval '1 hour')`,
      [r.accountId, it.workItemId, push, r.repoId, it.pr, PUBLIC, it.head, "a".repeat(64)],
    );
    const user = randomUUID();
    await db.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [user, `${user}@example.test`]);
    const runner = await insertRunner(db.admin, r.accountId, user);
    const upd = (set: string) => db.admin.query(`UPDATE plane_merge_orders SET ${set} WHERE work_item_id = $1`, [it.workItemId]);
    await upd(`state = 'claimed', runner_id = '${runner}', lease_generation = 1, attempts = 1, lease_expires_at = now() + interval '10 minutes'`);
    if (state === "failed") return void (await upd(`state = 'failed', outcome_code = 'runner_report_mismatch', finished_at = now()`));
    await upd(`state = 'authorized', write_token_issued_at = now()`);
    await upd(`state = '${state}', outcome_code = '${state}', finished_at = now()`);
  }

  for (const row of TABLE) {
    it(`${row.name}: ${row.expect}`, async () => {
      const r = await startQueueRepo(db);
      repos.push(r);
      const it0 = await r.addItem(7);
      const heads: Record<Head, string> = { head: it0.head, fresh: it0.fresh, public: PUBLIC, other: OTHER };
      for (const s of row.steps) {
        if ("order" in s) await order(r, it0, s.order);
        else if (s.fact === "merge_gate") await put(r, it0, "merge_gate", heads[s.head ?? "head"], { code: s.code, dialVersion: 0 });
        else if (s.fact === "enqueue") await put(r, it0, "merge_enqueued", heads[s.head ?? "head"], { code: "queue", ...(s.versioned ? { dialVersion: 0 } : {}) });
        else await put(r, it0, "merge_dequeued", heads[s.head ?? "head"], { code: s.code });
      }
      const merged = heads[row.merged];
      // The receipt, asked as the webhook and the reconcile ask it.
      const receipt = await tenant(r, (c) =>
        recordMergeReceiptOn(c, { accountId: r.accountId, workItemId: it0.workItemId, eventHead: merged, reviewHeads: [merged, it0.head], outcome: "merged", decidedBy: { kind: "merge_enqueued", head: merged } }),
      );
      // The queue entry, settled as the webhook settles it once the host's queue merged the pull request.
      await put(r, it0, "merged_via_queue", merged);
      await tenant(r, (c) => settlePullRequest(c, { accountId: r.accountId, repoId: r.repoId, prNumber: it0.pr, merged: true }));
      const mergedBy = (await r.entry(it0.pr)).mergedBy;

      expect(mergedBy).toBe(row.expect);
      expect(receipt === "not_policy" ? "person" : "gate").toBe(row.expect);
    });
  }
});
