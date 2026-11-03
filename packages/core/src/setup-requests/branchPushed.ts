import type { PoolClient } from 'pg';
import { readPlanePush } from '../repos/planePushRecord.js';
import { NotFoundError } from '../tenancy/errors.js';
import { SetupRequestError, getSetupRequest, markSetupRequestDoneInTx, type MarkedDone, type SetupRequest } from './store.js';

/**
 * D#598 P1g-2: "someone pushed to the public branch", raised by the platform from what it observed on GitHub (migration 0977).
 *
 * A request of this kind is never proposed by a model (it is not in `AGENT_PROPOSABLE_KINDS`) and is answered only by a person's own click: Keep and
 * Withdraw below, Replace in P1g-3. Nothing in the worker calls a resolution. It is a `derived` request: recomputed from the branch, refreshed while
 * open, closed as `condition_cleared` when the branch is back where the platform left it. Run everything here on a tenant transaction.
 *
 * The head the person was shown (`seen_head`) is a column of the request, not a driver event: a confirmed Replace reads it from the same row it
 * is answering, so the head it takes its lease on cannot be a different one from the head the person saw.
 */

/** The words an item shows once a person chose to keep the branch (the item keeps the pull request and stops updating it). */
export const PUBLIC_BRANCH_MANAGED_SENTENCE = 'Public branch managed by a person';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PG_UNIQUE = '23505';
const SAVEPOINT = 'branch_pushed_raise';
const KIND = 'branch_pushed_by_person';

/** What the list and the title show for the branch: its full name and the repository it is on. */
export function branchPushedTarget(codeRepo: string, branch: string): string {
  return `${branch} on ${codeRepo}`;
}

/** Plain words for the person. Short ids only (seven characters); nothing from the pushed commits is put in. */
export function branchPushedReason(a: { codeRepo: string; branch: string; seenHead: string; pushedHead: string }): string {
  return `Someone pushed to the public branch ${a.branch} of ${a.codeRepo}. It is now at ${a.seenHead.slice(0, 7)}; the cloud last pushed ${a.pushedHead.slice(0, 7)}. Nothing was overwritten, and the item is paused.`;
}

export type RaiseOutcome = { kind: 'raised' | 'refreshed' | 'unchanged'; request: SetupRequest } | { kind: 'not_applicable' };

/**
 * Raises the request for an item whose public branch is at `seenHead`, or brings the open one up to date. One open request per branch: the same head
 * again changes nothing, a newer push moves what the person sees (head and words) in the same row. `not_applicable` when the facts do not hold: the
 * item has no open, platform-owned public pull request, or the branch is at the head the platform pushed.
 * The push record moves to `waiting_person_pushed` (the merge gate already waits on it), in the same transaction.
 */
export async function raiseBranchPushedByPerson(client: PoolClient, input: { workItemId: string; seenHead: string }): Promise<RaiseOutcome> {
  if (!UUID_RE.test(input.workItemId)) throw new SetupRequestError('invalid_input', 'work_item_id must be a work item id', 'work_item_id');
  if (!SHA_RE.test(input.seenHead)) throw new SetupRequestError('invalid_input', 'seen_head must be a full commit id', 'seen_head');
  const { rows: account } = await client.query<{ id: string | null }>("SELECT NULLIF(current_setting('app.account_id', true), '')::uuid AS id");
  const accountId = account[0]?.id;
  if (!accountId) throw new NotFoundError('work item not found');
  const push = await readPlanePush(client, accountId, input.workItemId);
  if (push === null || push.headSha === null || push.managedByPersonAt !== null || !['pr_opened', 'waiting_person_pushed'].includes(push.state)) return { kind: 'not_applicable' };
  if (push.headSha === input.seenHead) return { kind: 'not_applicable' };
  const target = branchPushedTarget(push.codeRepo, push.branch);
  const reason = branchPushedReason({ codeRepo: push.codeRepo, branch: push.branch, seenHead: input.seenHead, pushedHead: push.headSha });

  const refresh = async (): Promise<RaiseOutcome | null> => {
    const open = await client.query<{ id: string; seen_head: string }>(
      "SELECT id, seen_head FROM setup_requests WHERE work_item_id = $1::uuid AND kind = $2 AND target = $3 AND state = 'open' FOR UPDATE",
      [input.workItemId, KIND, target],
    );
    const held = open.rows[0];
    if (!held) return null;
    if (held.seen_head === input.seenHead) return { kind: 'unchanged', request: await getSetupRequest(client, held.id) };
    await client.query('UPDATE setup_requests SET seen_head = $2, reason = $3 WHERE id = $1::uuid', [held.id, input.seenHead, reason]);
    return { kind: 'refreshed', request: await getSetupRequest(client, held.id) };
  };

  let outcome = await refresh();
  for (let attempt = 0; outcome === null && attempt < 3; attempt += 1) {
    await client.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO setup_requests (account_id, repo_id, work_item_id, origin, kind, target, reason, seen_head)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'derived', $4, $5, $6, $7) RETURNING id`,
        [accountId, push.repoId, input.workItemId, KIND, target, reason, input.seenHead],
      );
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      outcome = { kind: 'raised', request: await getSetupRequest(client, rows[0]!.id) };
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== PG_UNIQUE) throw error;
      // Another raise got there first: look again and refresh that one.
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      outcome = await refresh();
    }
  }
  if (outcome === null) throw new SetupRequestError('already_open', 'this step is already requested');
  await client.query("UPDATE plane_pushes SET state = 'waiting_person_pushed' WHERE id = $1::uuid AND state = 'pr_opened' AND managed_by_person_at IS NULL", [push.id]);
  return outcome;
}

/**
 * The branch is back at the head the platform pushed (a person reset it): the open request closes as `condition_cleared` and the push record goes back
 * to `pr_opened`, so the next fix round updates the pull request again. Nothing happens when there is nothing to clear. Returns whether anything changed.
 */
export async function clearBranchPushedByPerson(client: PoolClient, input: { workItemId: string }): Promise<boolean> {
  if (!UUID_RE.test(input.workItemId)) throw new SetupRequestError('invalid_input', 'work_item_id must be a work item id', 'work_item_id');
  const closed = await client.query("UPDATE setup_requests SET state = 'done', resolution = 'condition_cleared' WHERE work_item_id = $1::uuid AND kind = $2 AND state = 'open'", [input.workItemId, KIND]);
  const restored = await client.query("UPDATE plane_pushes SET state = 'pr_opened' WHERE work_item_id = $1::uuid AND state = 'waiting_person_pushed' AND managed_by_person_at IS NULL AND pr_number IS NOT NULL", [input.workItemId]);
  return (closed.rowCount ?? 0) + (restored.rowCount ?? 0) > 0;
}

/**
 * "Keep their version and stop pushing for this item": the request closes as done (the person's own click, an owner or admin of the account, as for
 * any request), the item restarts, and the push record says a person manages the branch. The platform pushes nothing to it from now on; the pull
 * request stays. {@link releaseManagedBranch} is the undo. Repeating the click changes nothing.
 */
export async function keepBranchPushedByPerson(client: PoolClient, input: { id: string; userId: string }): Promise<MarkedDone> {
  const current = await getSetupRequest(client, input.id);
  if (current.kind !== KIND || current.workItemId === null) throw new SetupRequestError('invalid_input', 'only a "someone pushed to the branch" request can be kept', 'id');
  const done = await markSetupRequestDoneInTx(client, input);
  if (done.changed) {
    await client.query(
      "UPDATE plane_pushes SET state = 'managed_by_person', managed_by_person_at = now() WHERE work_item_id = $1::uuid AND managed_by_person_at IS NULL AND state IN ('pr_opened', 'waiting_person_pushed')",
      [current.workItemId],
    );
  }
  return done;
}

/**
 * The undo of Keep: "Public branch managed by a person" is cleared by an owner or admin of the account, and the platform may update the branch again
 * (if it has moved since, the next fix round raises the request again). Returns whether it was set.
 */
export async function releaseManagedBranch(client: PoolClient, input: { workItemId: string; userId: string }): Promise<boolean> {
  if (!UUID_RE.test(input.workItemId)) throw new SetupRequestError('invalid_input', 'work_item_id must be a work item id', 'work_item_id');
  if (!UUID_RE.test(input.userId)) throw new SetupRequestError('invalid_input', 'userId must be a user id', 'userId');
  const { rowCount } = await client.query(
    `UPDATE plane_pushes p SET managed_by_person_at = NULL, state = CASE WHEN p.state = 'managed_by_person' THEN 'pr_opened' ELSE p.state END
      WHERE p.work_item_id = $1::uuid AND (p.managed_by_person_at IS NOT NULL OR p.state = 'managed_by_person') AND p.pr_number IS NOT NULL
        AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = p.account_id AND m.user_id = $2::uuid AND m.role IN ('owner', 'admin'))`,
    [input.workItemId, input.userId],
  );
  return (rowCount ?? 0) > 0;
}
