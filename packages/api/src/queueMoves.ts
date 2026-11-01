import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { OperatorRefusedError } from "@fx/core/src/work-items/operatorMoves.js";
import { operatorVerdict, readOperatorFacts } from "@fx/core/src/work-items/operatorActions.js";
import { QUEUE_AGAIN_ACTION, QUEUE_REMOVE_ACTION, QUEUE_REMOVE_NOOP_ACTION, writeQueueAudit } from "@fx/core/src/work-items/queueIntent.js";
import { mergeQueue } from "@fx/pipeline";

/**
 * D#694 B6-5: the two writes behind Remove from queue and Queue again. Both ask the one table of operator actions first (with the item's row locked), name the pull request
 * and head from the item's newest enqueue fact, and write the audit row in the same transaction. Nothing here calls GitHub: the route does, after this commits, so the
 * recorded intent exists before the removal can arrive.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface QueueMoveCtx {
  pool: Pool;
  principal: { accountId: string; userId: string; role: string };
}

/** The item is not waiting in the merge queue (Remove). Nothing was written. */
export class NotInQueueError extends Error {
  constructor() {
    super("the pull request is not in the merge queue");
    this.name = "NotInQueueError";
  }
}

async function newestEnqueue(client: PoolClient, accountId: string, workItemId: string): Promise<{ prNumber: number; headSha: string } | null> {
  const { rows } = await client.query<{ pr_number: number | null; head_sha: string | null }>(
    `SELECT pr_number, head_sha FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'merge_enqueued' ORDER BY seq DESC LIMIT 1`,
    [accountId, workItemId],
  );
  const r = rows[0];
  return r && r.pr_number !== null && r.head_sha !== null ? { prNumber: r.pr_number, headSha: r.head_sha } : null;
}

/** What a press named: the pull request and head, and the id of its audit row (a no-op row answers it by that id). */
export interface QueueMoveTarget {
  prNumber: number;
  headSha: string;
  pressId: string;
}

async function move(ctx: QueueMoveCtx, workItemId: string, action: typeof QUEUE_REMOVE_ACTION | typeof QUEUE_AGAIN_ACTION): Promise<QueueMoveTarget> {
  if (!UUID_RE.test(workItemId)) throw new NotFoundError("not found");
  const { accountId, userId, role } = ctx.principal;
  const remove = action === QUEUE_REMOVE_ACTION;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const facts = await readOperatorFacts(client, workItemId, role, true);
    if (!facts) throw new NotFoundError("not found");
    const verdict = operatorVerdict(remove ? "remove_from_queue" : "queue_again", facts);
    // Remove has its own answer for an item that is not waiting there; every other refusal is the table's.
    if (!verdict.ok) {
      if (remove && verdict.reason === "state") throw new NotInQueueError();
      throw new OperatorRefusedError(verdict);
    }
    const target = await newestEnqueue(client, accountId, workItemId);
    if (target === null) throw new NotInQueueError();
    const pressId = await writeQueueAudit(client, action, { workItemId, ...target });
    if (!remove) {
      // The entry the queue stopped goes back to review, so the item's normal advance enqueues it again and the tick's take guard sees the press.
      const entry = await mergeQueue.getEntryByWorkItem(client, accountId, workItemId);
      if (entry !== null) await mergeQueue.returnToReview(client, { accountId, entryId: entry.id });
    }
    return { ...target, pressId };
  });
}

export const removeFromQueue = (ctx: QueueMoveCtx, workItemId: string) => move(ctx, workItemId, QUEUE_REMOVE_ACTION);
export const queueAgain = (ctx: QueueMoveCtx, workItemId: string) => move(ctx, workItemId, QUEUE_AGAIN_ACTION);

/** The host answered THIS Remove press that the pull request was not in its queue: the no-op row names the press's row, so only that press reads as having removed nothing. */
export async function markRemoveNoop(ctx: QueueMoveCtx, workItemId: string, target: QueueMoveTarget): Promise<void> {
  await withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, (client) =>
    writeQueueAudit(client, QUEUE_REMOVE_NOOP_ACTION, { workItemId, prNumber: target.prNumber, headSha: target.headSha, answers: target.pressId }),
  );
}
