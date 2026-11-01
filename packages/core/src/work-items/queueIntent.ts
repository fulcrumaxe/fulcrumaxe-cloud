import type { PoolClient } from 'pg';

/**
 * D#694 B6-5: what a person did to the merge queue from the card, recorded as an audit row in the same transaction as the action. The audit row IS the recorded intent
 * (no driver event is written for it): the removal that the webhook or the reconcile later records is told apart from GitHub's own by finding it, read back only
 * through the 0946 definer `work_item_queue_intents`. The 0713 definer has
 * no event of its own for these, so, as Reopen and Try the push again do, the row is written as `work_item.sent_back` with the action in its payload.
 * TODO: when it becomes permanent, add `merge_queue.removed` and `merge_queue.queued_again` to the definer's allowlist in a migration numbered at merge.
 */
export const QUEUE_REMOVE_ACTION = 'queue_remove';
export const QUEUE_AGAIN_ACTION = 'queue_again';
/** Written when the host answered a Remove press that the pull request was not in its queue; it names that press's row (`answers`), which then removed nothing. */
export const QUEUE_REMOVE_NOOP_ACTION = 'queue_remove_noop';
/** A removal this soon after a Remove press (or the reconcile's read of one) is the press's. */
export const REMOVE_INTENT_WINDOW_MINUTES = 10;
/** The code on a `merge_enqueued` fact that a person's Queue again produced; the retry rule counts removals only after the newest one. */
export const PERSON_REQUEUE_REASON = 'person_requeue';
/** The `reasons` code of a removal the product's own Remove press made. */
export const ACTOR_YOU = 'actor_you';

/** Writes one press as its audit row and returns the row's id (a no-op row names the Remove row it answers in `answers`). */
export async function writeQueueAudit(
  client: Pick<PoolClient, 'query'>,
  action: typeof QUEUE_REMOVE_ACTION | typeof QUEUE_AGAIN_ACTION | typeof QUEUE_REMOVE_NOOP_ACTION,
  payload: { workItemId: string; prNumber: number; headSha: string; answers?: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>('SELECT audit_write_work_item_action($1::text, $2::jsonb) AS id', [
    'work_item.sent_back',
    JSON.stringify({ action, work_item_id: payload.workItemId, pr_number: payload.prNumber, head_sha: payload.headSha, ...(payload.answers !== undefined ? { answers: payload.answers } : {}) }),
  ]);
  return rows[0]!.id;
}

/**
 * SQL: the presses of this item and head on the session's account, read through the `work_item_queue_intents` definer (migration 0946; production code never reads
 * the audit table itself). `window` is a placeholder for minutes, or `NULL` for every press. Columns: id, action, created_at, head_sha, pr_number, answers.
 */
export const queueIntentsSql = (item: string, head: string, window: string): string => `work_item_queue_intents(${item}::uuid, ${head}::text, ${window}::integer)`;

/** SQL: when the newest press of `action` for this item, pull request and head was recorded (placeholders or columns given by the caller), or NULL. */
export const queueAuditAtSql = (action: typeof QUEUE_AGAIN_ACTION, item: string, pr: string, head: string): string =>
  `(SELECT max(i.created_at) FROM ${queueIntentsSql(item, head, 'NULL')} i WHERE i.action = '${action}' AND i.pr_number = ${pr}::int)`;

/**
 * Whether a Remove press of this head of this pull request, recorded within the last REMOVE_INTENT_WINDOW_MINUTES, is still unanswered: a Remove row counts unless a
 * no-op row names it (the host told THAT press the pull request was not queued). Pairing by id, not by time: when A's press dequeues and B's later press is answered
 * "not queued", A's row stands, so the removal that follows is still yours. `accountId` is the session's account (the definer reads the session, not this argument).
 */
export async function removeIntentRecent(client: Pick<PoolClient, 'query'>, _accountId: string, workItemId: string, prNumber: number, headSha: string): Promise<boolean> {
  // The database's clock on both sides, never the app's.
  const { rows } = await client.query<{ recent: boolean }>(
    `WITH i AS (SELECT * FROM ${queueIntentsSql('$1', '$3', '$4')} WHERE pr_number = $2)
     SELECT EXISTS (SELECT 1 FROM i r WHERE r.action = '${QUEUE_REMOVE_ACTION}'
                      AND NOT EXISTS (SELECT 1 FROM i n WHERE n.action = '${QUEUE_REMOVE_NOOP_ACTION}' AND n.answers = r.id)) AS recent`,
    [workItemId, prNumber, headSha, REMOVE_INTENT_WINDOW_MINUTES],
  );
  return rows[0]?.recent === true;
}

/** Whether a Queue again press of this head is waiting for its enqueue: recorded after the newest `merge_enqueued` fact of the head (or there is none). */
export async function queueAgainPending(client: Pick<PoolClient, 'query'>, accountId: string, workItemId: string, prNumber: number, headSha: string): Promise<boolean> {
  const { rows } = await client.query<{ pending: boolean }>(
    `SELECT COALESCE(${queueAuditAtSql(QUEUE_AGAIN_ACTION, '$2', '$3', '$4')} > COALESCE((SELECT max(q.created_at) FROM work_item_driver_events q
        WHERE q.account_id = $1 AND q.work_item_id = $2 AND q.kind = 'merge_enqueued' AND q.pr_number = $3 AND q.head_sha = $4), '-infinity'::timestamptz), false) AS pending`,
    [accountId, workItemId, prNumber, headSha],
  );
  return rows[0]?.pending === true;
}
