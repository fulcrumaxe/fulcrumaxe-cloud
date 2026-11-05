import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordDriverEvent, type DriverEventKind } from "@fx/core/src/work-items/driverEvents.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { settlePullRequest } from "../../src/mergeQueue/index.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { startQueueRepo, type QueueItem, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * Who a merge-queue entry says merged it. The queue's merge is the gate's only when the gate itself queued the head last enqueued for the pull request, and no removal by a person
 * (or any removal that is not GitHub's success) came after that evidence. A person's own "Merge when ready", a hand re-queue after a removal, and another tool's enqueue leave
 * only the webhook's fact, which carries no dial version: those merges are a person's. Real Postgres, row security in force.
 */
let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("merged_by of an entry the host's queue merged [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(r: QueueRepo, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, r.accountId, fn);
  const PUBLIC = "b".repeat(40);

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
  /** The gate's own decision: its `merge_gate` fact (code `merge_enqueued`), as the gate writes it before it asks the host's queue. */
  const gateFact = (r: QueueRepo, it: QueueItem, head = it.head, code = "merge_enqueued") => put(r, it, "merge_gate", head, { code, dialVersion: 0 });
  /** The webhook's (or the reconcile's) enqueue fact: no dial version, whoever pressed the button. */
  const webhookEnqueue = (r: QueueRepo, it: QueueItem, head = it.head) => put(r, it, "merge_enqueued", head, { code: "queue" });
  /** The gate's own enqueue fact: alone among the enqueue facts it carries the dial version. */
  const gateEnqueue = (r: QueueRepo, it: QueueItem, head = it.head) => put(r, it, "merge_enqueued", head, { code: "queue", dialVersion: 0 });
  const removal = (r: QueueRepo, it: QueueItem, head: string, code: string) => put(r, it, "merge_dequeued", head, { code });
  const merge = async (r: QueueRepo, it: QueueItem, head = it.head) => {
    await put(r, it, "merged_via_queue", head);
    await tenant(r, (c) => settlePullRequest(c, { accountId: r.accountId, repoId: r.repoId, prNumber: it.pr, merged: true }));
    return (await r.entry(it.pr)).mergedBy;
  };
  const item = async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    return { r, it: await r.addItem(7) };
  };

  it("the gate queued it: its merge_gate fact at the enqueued head makes the queue's merge the gate's", async () => {
    const { r, it } = await item();
    await gateFact(r, it);
    await webhookEnqueue(r, it);
    expect(await merge(r, it)).toBe("gate");
  });

  it("the gate queued it and its own enqueue fact (with the dial version) is the only evidence: the gate's", async () => {
    const { r, it } = await item();
    await gateEnqueue(r, it);
    expect(await merge(r, it)).toBe("gate");
  });

  it("a person pressed Merge when ready (only the webhook's enqueue fact): a person's merge", async () => {
    const { r, it } = await item();
    await webhookEnqueue(r, it);
    expect(await merge(r, it)).toBe("person");
  });

  it("a merge_gate fact that is not an enqueue (the gate left it for a person) is not evidence, whatever else is on the item", async () => {
    const { r, it } = await item();
    await gateFact(r, it, it.head, "ready_human_merges");
    await webhookEnqueue(r, it);
    expect(await merge(r, it)).toBe("person");
  });

  it("the gate queued another head and a person queued this one: the evidence is at the head last enqueued, so a person's", async () => {
    const { r, it } = await item();
    await gateFact(r, it);
    await webhookEnqueue(r, it);
    await webhookEnqueue(r, it, it.fresh);
    expect(await merge(r, it, it.fresh)).toBe("person");
  });

  it("a person took the gate's enqueue out and queued it again by hand: a person's merge, with only the older gate evidence on the item", async () => {
    const { r, it } = await item();
    await gateFact(r, it);
    await webhookEnqueue(r, it);
    await removal(r, it, it.head, "user");
    await webhookEnqueue(r, it);
    expect(await merge(r, it)).toBe("person");
  });

  it("GitHub removed the gate's enqueue and the gate queued it again (the one retry): the gate's merge", async () => {
    const { r, it } = await item();
    await gateEnqueue(r, it);
    await removal(r, it, it.head, "ci_failure");
    await gateEnqueue(r, it);
    expect(await merge(r, it)).toBe("gate");
  });

  it("GitHub's own success dequeue (the merge itself) is not a removal: the gate's merge stays the gate's", async () => {
    const { r, it } = await item();
    await gateFact(r, it);
    await webhookEnqueue(r, it);
    await removal(r, it, it.head, "merge");
    expect(await merge(r, it)).toBe("gate");
  });

  it("a removal of another head does not take the evidence away", async () => {
    const { r, it } = await item();
    await gateFact(r, it);
    await webhookEnqueue(r, it);
    await removal(r, it, it.fresh, "user");
    expect(await merge(r, it)).toBe("gate");
  });

  it("no enqueue fact at all, only the queue's merge: a person's", async () => {
    const { r, it } = await item();
    await gateFact(r, it);
    expect(await merge(r, it)).toBe("person");
  });

  it("a merge nothing queued (no queue fact) is a person's, as before", async () => {
    const { r, it } = await item();
    await gateFact(r, it);
    await tenant(r, (c) => settlePullRequest(c, { accountId: r.accountId, repoId: r.repoId, prNumber: it.pr, merged: true }));
    expect((await r.entry(it.pr)).mergedBy).toBe("person");
  });

  describe("a paired item: the public pull request is queued by a runner on an order the gate placed, and the gate's fact is keyed on the reviewed head", () => {
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

    it("an order that ended enqueued, with the gate's merge_delegated fact at the reviewed head: the gate's merge of the public head", async () => {
      const { r, it } = await item();
      await gateFact(r, it, it.head, "merge_delegated");
      await order(r, it, "enqueued");
      await webhookEnqueue(r, it, PUBLIC);
      expect(await merge(r, it, PUBLIC)).toBe("gate");
    });

    it("an order that ended merged counts too", async () => {
      const { r, it } = await item();
      await gateFact(r, it, it.head, "merge_delegated");
      await order(r, it, "merged");
      await webhookEnqueue(r, it, PUBLIC);
      expect(await merge(r, it, PUBLIC)).toBe("gate");
    });

    it("the order names another public head than the one last enqueued (a person pushed and queued the new head): a person's merge", async () => {
      const { r, it } = await item();
      await gateFact(r, it, it.head, "merge_delegated");
      await order(r, it, "enqueued");
      await webhookEnqueue(r, it, PUBLIC);
      await webhookEnqueue(r, it, "c".repeat(40));
      expect(await merge(r, it, "c".repeat(40))).toBe("person");
    });

    it("a public pull request a person queued by hand, with an order that failed: a person's merge", async () => {
      const { r, it } = await item();
      await gateFact(r, it, it.head, "merge_delegated");
      await order(r, it, "failed");
      await webhookEnqueue(r, it, PUBLIC);
      expect(await merge(r, it, PUBLIC)).toBe("person");
    });

    it("no order at all: a person's merge", async () => {
      const { r, it } = await item();
      await gateFact(r, it, it.head, "merge_delegated");
      await webhookEnqueue(r, it, PUBLIC);
      expect(await merge(r, it, PUBLIC)).toBe("person");
    });

    it("an order with no delegated gate fact at the reviewed head (a merge_gate fact of another code) is not evidence", async () => {
      const { r, it } = await item();
      await gateFact(r, it, it.head, "ready_human_merges");
      await order(r, it, "enqueued");
      await webhookEnqueue(r, it, PUBLIC);
      expect(await merge(r, it, PUBLIC)).toBe("person");
    });

    it("a person took the public pull request out of the queue and queued it again by hand: a person's merge", async () => {
      const { r, it } = await item();
      await gateFact(r, it, it.head, "merge_delegated");
      await order(r, it, "enqueued");
      await webhookEnqueue(r, it, PUBLIC);
      await removal(r, it, PUBLIC, "user");
      await webhookEnqueue(r, it, PUBLIC);
      expect(await merge(r, it, PUBLIC)).toBe("person");
    });
  });
});
