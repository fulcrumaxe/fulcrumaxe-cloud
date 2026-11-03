import type { PoolClient } from 'pg';
import { readPlanePush } from '../repos/planePushRecord.js';
import { NotFoundError } from '../tenancy/errors.js';
import { COPY_BRANCH_ANSWER_CLOSED, COPY_BRANCH_MANAGED } from './copy.js';
import { SetupRequestError, getSetupRequest, markSetupRequestDoneInTx, type MarkedDone, type SetupRequest } from './store.js';

/**
 * D#598 P1g-2: "someone pushed to the public branch", raised by the platform from what it observed on GitHub (migration 0977).
 *
 * A request of this kind is never proposed by a model (it is not in `AGENT_PROPOSABLE_KINDS`) and is answered only by a person's own click: Keep and
 * Withdraw below, Replace in P1g-3. Nothing in the worker calls a resolution. It is a `derived` request: recomputed from the branch, refreshed while
 * open, closed as `condition_cleared` when the branch is back where the platform left it. Run everything here on a tenant transaction.
 *
 * `seen_head` is a column of the request and it MOVES while the request is open (a newer push refreshes it), so the row alone does not say which head
 * a person was looking at. A confirmed Replace therefore carries the head the person was shown, and {@link replaceBranchPushedByPerson} compares it with
 * the row under lock: a mismatch refuses (`head_changed`) and nothing is authorized. Only then is the lease authorized, on that head and no other.
 */

/** The words an item shows once a person chose to keep the branch (the item keeps the pull request and stops updating it). */
export const PUBLIC_BRANCH_MANAGED_SENTENCE = COPY_BRANCH_MANAGED;

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
  const spent = await clearReplaceAuthorization(client, input.workItemId);
  return (closed.rowCount ?? 0) + (restored.rowCount ?? 0) > 0 || spent;
}

interface LockedPush {
  id: string;
  state: string;
  managed: boolean;
  authorized: string | null;
  answeredRequestId: string | null;
}

/**
 * The push row a request is about, locked: the one whose branch and repository the request names (its target is `<branch> on <code repo>`), never "whatever row the
 * item has", so an item with two rows (it was re-paired) answers only the one it asked about.
 */
async function lockPushOf(client: PoolClient, request: { workItemId: string | null; target: string }): Promise<LockedPush | null> {
  const { rows } = await client.query<{ id: string; state: string; managed: boolean; authorized: string | null; answered: string | null }>(
    `SELECT id, state, managed_by_person_at IS NOT NULL AS managed, replace_authorized_head AS authorized, answered_request_id AS answered FROM plane_pushes
      WHERE work_item_id = $1::uuid AND branch || ' on ' || code_repo = $2 AND pr_number IS NOT NULL FOR UPDATE`,
    [request.workItemId, request.target],
  );
  const r = rows[0];
  return r ? { id: r.id, state: r.state, managed: r.managed, authorized: r.authorized, answeredRequestId: r.answered } : null;
}

/** The audit row of a person's answer, through the same definer the item's other operator moves use (it stamps the actor and refuses anyone but an owner or admin). */
async function auditAnswer(client: PoolClient, workItemId: string, action: 'public_branch_keep' | 'public_branch_replace' | 'public_branch_release', requestId: string | null): Promise<void> {
  // TODO: like Reopen and Try the push again (operatorMoves.ts), written as `work_item.sent_back` with the action in its payload: the 0713 allowlist has no event of its own.
  await client.query('SELECT audit_write_work_item_action($1::text, $2::jsonb)', ['work_item.sent_back', JSON.stringify({ work_item_id: workItemId, action, ...(requestId !== null ? { request_id: requestId } : {}) })]);
}

const MANAGE_SQL = `UPDATE plane_pushes p SET state = 'managed_by_person', managed_by_person_at = now(), replace_authorized_head = NULL, answered_request_id = $2::uuid, kept_head = $4, kept_replaced_at = NULL
  WHERE p.id = $1::uuid AND p.managed_by_person_at IS NULL AND p.state IN ('pr_opened', 'waiting_person_pushed')
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = p.account_id AND m.user_id = $3::uuid AND m.role IN ('owner', 'admin'))`;

/**
 * "Keep their version and stop pushing for this item": the request closes as done (the person's own click, an owner or admin of the account, as for
 * any request), the item restarts, and the push record says a person manages the branch. The platform pushes nothing to it from now on; the pull
 * request stays. {@link releaseManagedBranch} is the undo. Repeating the click changes nothing.
 *
 * Keep wins until a round has taken the head: a person who confirmed Replace and then thinks better of it keeps their version, and the authorization is cleared in the
 * same transaction, so no round that has not started yet can overwrite it. A round already under way holds its lease on the person's head and cannot be stopped (its final
 * push is made outside the cloud), so a Keep that arrives then can lose: the update lands, the record takes the new head, and the managed line says the Keep lost
 * (`kept_head`, `kept_replaced_at`). Once the Replace was spent (the update landed, or a round was refused) the request is closed and Keep is `not_open`.
 */
export async function keepBranchPushedByPerson(client: PoolClient, input: { id: string; userId: string }): Promise<MarkedDone> {
  if (!UUID_RE.test(input.id)) throw new SetupRequestError('invalid_input', 'id must be a request id', 'id');
  await client.query('SELECT 1 FROM setup_requests WHERE id = $1::uuid FOR UPDATE', [input.id]);
  const current = await getSetupRequest(client, input.id);
  if (current.kind !== KIND || current.workItemId === null) throw new SetupRequestError('invalid_input', 'only a "someone pushed to the branch" request can be kept', 'id');
  const push = await lockPushOf(client, current);
  const forbidden = () => Object.assign(new Error('only an owner or admin can do this'), { code: '42501' });
  if (current.state === 'open') {
    const done = await markSetupRequestDoneInTx(client, input);
    if (done.changed) {
      // A pull request that has closed, or is already someone's to manage, is answered without the mark (the request still closes).
      if (push !== null && !push.managed && ['pr_opened', 'waiting_person_pushed'].includes(push.state) && ((await client.query(MANAGE_SQL, [push.id, current.id, input.userId, current.seenHead])).rowCount ?? 0) === 0) throw forbidden();
      await auditAnswer(client, current.workItemId, 'public_branch_keep', current.id);
    }
    return done;
  }
  if (current.state === 'done' && push !== null && push.answeredRequestId === current.id) {
    // The same answer again.
    if (push.managed) return { request: current, changed: false, restart: null };
    // A Replace of this very request that nothing has used yet: the later click wins. The item was restarted by the Replace, so nothing is filed again.
    if (push.authorized !== null && push.state === 'pr_opened') {
      if (((await client.query(MANAGE_SQL, [push.id, current.id, input.userId, current.seenHead])).rowCount ?? 0) === 0) throw forbidden();
      await auditAnswer(client, current.workItemId, 'public_branch_keep', current.id);
      return { request: current, changed: true, restart: null };
    }
  }
  throw new SetupRequestError('not_open', COPY_BRANCH_ANSWER_CLOSED);
}

/**
 * The undo of Keep: "Public branch managed by a person" is cleared by an owner or admin of the account, and the platform may update the branch again
 * (if it has moved since, the next fix round raises the request again). Returns whether it was set.
 */
export async function releaseManagedBranch(client: PoolClient, input: { workItemId: string; userId: string }): Promise<boolean> {
  if (!UUID_RE.test(input.workItemId)) throw new SetupRequestError('invalid_input', 'work_item_id must be a work item id', 'work_item_id');
  if (!UUID_RE.test(input.userId)) throw new SetupRequestError('invalid_input', 'userId must be a user id', 'userId');
  const { rowCount } = await client.query(
    `UPDATE plane_pushes p SET managed_by_person_at = NULL, answered_request_id = NULL, kept_head = NULL, kept_replaced_at = NULL, state = CASE WHEN p.state = 'managed_by_person' THEN 'pr_opened' ELSE p.state END
      WHERE p.work_item_id = $1::uuid AND (p.managed_by_person_at IS NOT NULL OR p.state = 'managed_by_person') AND p.pr_number IS NOT NULL
        AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = p.account_id AND m.user_id = $2::uuid AND m.role IN ('owner', 'admin'))`,
    [input.workItemId, input.userId],
  );
  if ((rowCount ?? 0) === 0) return false;
  await auditAnswer(client, input.workItemId, 'public_branch_release', null);
  return true;
}

/** The authorization is single-use: spent when the update lands, when a round is refused, when the branch is back, and on any other answer. Returns whether one was set. */
export async function clearReplaceAuthorization(client: PoolClient, workItemId: string): Promise<boolean> {
  const { rowCount } = await client.query('UPDATE plane_pushes SET replace_authorized_head = NULL WHERE work_item_id = $1::uuid AND replace_authorized_head IS NOT NULL', [workItemId]);
  return (rowCount ?? 0) > 0;
}

/**
 * "Replace it with the item's version", after the person's second confirmation. The request closes as the person's answer and the item restarts (as for Keep);
 * the push record is authorized to take its lease on the head the person was shown, and the fix round that resumes publishes with that lease (a push in
 * between makes the lease fail and asks again). Nothing is pushed here: only a round publishes.
 *
 * `shownHead` is what the person's page showed. If the open request has moved on to a newer head, nothing is written and `head_changed` is thrown, so a push the
 * person never saw is never overwritten. A repeat of a closed request changes nothing. When the item no longer has an open pull request waiting on this branch
 * (closed, merged, taken over), the whole answer is refused, so the request is not closed for nothing.
 */
export async function replaceBranchPushedByPerson(client: PoolClient, input: { id: string; userId: string; shownHead: string }): Promise<MarkedDone> {
  if (!SHA_RE.test(input.shownHead)) throw new SetupRequestError('invalid_input', 'shown_head must be a full commit id', 'shown_head');
  if (!UUID_RE.test(input.id)) throw new SetupRequestError('invalid_input', 'id must be a request id', 'id');
  await client.query('SELECT 1 FROM setup_requests WHERE id = $1::uuid FOR UPDATE', [input.id]);
  const current = await getSetupRequest(client, input.id);
  if (current.kind !== KIND || current.workItemId === null) throw new SetupRequestError('invalid_input', 'only a "someone pushed to the branch" request can be replaced', 'id');
  const push = await lockPushOf(client, current);
  if (current.state === 'open') {
    if (current.seenHead !== input.shownHead) throw new SetupRequestError('head_changed', 'the branch moved since the page was shown');
    if (push === null || push.managed || push.state !== 'waiting_person_pushed') throw new SetupRequestError('not_open', 'the pull request is no longer waiting on this branch');
    const done = await markSetupRequestDoneInTx(client, { id: input.id, userId: input.userId });
    if (done.changed) {
      await client.query("UPDATE plane_pushes SET state = 'pr_opened', replace_authorized_head = $2, answered_request_id = $3::uuid WHERE id = $1::uuid", [push.id, input.shownHead, current.id]);
      await auditAnswer(client, current.workItemId, 'public_branch_replace', current.id);
    }
    return done;
  }
  // A repeat of the same answer changes nothing. A request closed any other way (Keep, a withdrawal, the branch put back) is not a success to report.
  if (current.state === 'done' && push !== null && push.answeredRequestId === current.id && !push.managed) return { request: current, changed: false, restart: null };
  throw new SetupRequestError('not_open', COPY_BRANCH_ANSWER_CLOSED);
}
