import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { redactShapes } from '@fx/runtime/src/redact.js';
import { markWorkPending } from '../pendingWork.js';
import { NotFoundError } from '../tenancy/errors.js';
import type { CheckOutcome } from './checks.js';
import type { CheckReasonCode } from './copy.js';
import {
  ENV_NAME_RE,
  isAgentProposableKind,
  isValidReason,
  isValidTarget,
  normalizeProviderUrl,
  type AgentProposableKind,
  type SetupRequestCheckKind,
  type SetupRequestKind,
  type SetupRequestState,
} from './kinds.js';

/**
 * D#598 P8a: the one read/write path for `setup_requests` (migration 0856). Run it on a tenant-scoped client (`withTenant`): row security
 * hides another account's rows, so a foreign id is `NotFoundError`, the same answer as a missing one. The account is the transaction's,
 * never an input. The database holds the real rules (fixed kinds, no value column, host list, state machine, who may write); this file
 * checks them first so a caller gets a named error in words, and turns a lost race into the same named error.
 *
 * What pauses an item is derived here, never stamped on it: an open request pauses its item; a withdrawn one keeps it paused until a
 * person's next `advance_work_item` request after the withdrawal; a done request pauses nothing.
 */

export type SetupRequestErrorCode = 'invalid_input' | 'already_open' | 'not_open' | 'work_item_repo_mismatch';

/** `invalid_input` and `work_item_repo_mismatch` map to 422, `already_open` and `not_open` to 409. */
export class SetupRequestError extends Error {
  constructor(
    readonly code: SetupRequestErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'SetupRequestError';
  }
}

export interface SetupRequest {
  id: string;
  repoId: string;
  workItemId: string | null;
  origin: 'agent' | 'derived';
  kind: SetupRequestKind;
  target: string;
  envName: string | null;
  reason: string;
  providerUrl: string | null;
  checkKind: SetupRequestCheckKind | null;
  state: SetupRequestState;
  createdBy: string | null;
  createdAt: Date;
  resolution: 'marked_done' | 'check_passed' | 'condition_cleared' | 'withdrawn' | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  checkReason: string | null;
  checkRanAt: Date | null;
}

interface Row {
  id: string;
  repo_id: string;
  work_item_id: string | null;
  origin: SetupRequest['origin'];
  kind: SetupRequestKind;
  target: string;
  env_name: string | null;
  reason: string;
  provider_url: string | null;
  check_kind: SetupRequestCheckKind | null;
  state: SetupRequestState;
  created_by: string | null;
  created_at: Date;
  resolution: SetupRequest['resolution'];
  resolved_by: string | null;
  resolved_at: Date | null;
  check_reason: string | null;
  check_ran_at: Date | null;
}

const COLUMNS = `id, repo_id, work_item_id, origin, kind, target, env_name, reason, provider_url, check_kind, state, created_by, created_at,
  resolution, resolved_by, resolved_at, check_reason, check_ran_at`;

const map = (r: Row): SetupRequest => ({
  id: r.id,
  repoId: r.repo_id,
  workItemId: r.work_item_id,
  origin: r.origin,
  kind: r.kind,
  target: r.target,
  envName: r.env_name,
  reason: r.reason,
  providerUrl: r.provider_url,
  checkKind: r.check_kind,
  state: r.state,
  createdBy: r.created_by,
  createdAt: r.created_at,
  resolution: r.resolution,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at,
  checkReason: r.check_reason,
  checkRanAt: r.check_ran_at,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_UNIQUE = '23505';

export interface ProposeSetupRequestInput {
  /** The person whose session proposes it; stamped as `created_by`. Never read from a request body. */
  userId: string;
  repoId: string;
  workItemId?: string | null;
  kind: AgentProposableKind;
  target: string;
  /** `env_var` only: the variable's NAME. There is no value field. */
  envName?: string | null;
  reason: string;
  providerUrl?: string | null;
  /** `env_var` only. */
  check?: SetupRequestCheckKind | null;
}

/** Stamps one agent-proposed request, open. Refuses an unknown or derived-only kind and any malformed field before writing. */
export async function proposeSetupRequest(client: PoolClient, input: ProposeSetupRequestInput): Promise<SetupRequest> {
  const bad = (field: string, message: string): never => {
    throw new SetupRequestError('invalid_input', message, field);
  };
  if (!isAgentProposableKind(input.kind)) bad('kind', 'kind is not one a setup request can take');
  if (!UUID_RE.test(input.userId)) bad('userId', 'userId must be a user id');
  if (!UUID_RE.test(input.repoId)) bad('repo_id', 'repo_id must be a repo id');
  const workItemId = input.workItemId ?? null;
  if (workItemId !== null && !UUID_RE.test(workItemId)) bad('work_item_id', 'work_item_id must be a work item id');
  if (!isValidTarget(input.target)) bad('target', 'target must be 1 to 200 characters without control characters');
  if (!isValidReason(input.reason)) bad('reason', 'reason must be 1 to 1000 characters of plain text');
  // A request never carries a secret: text shaped like a credential is refused, not stored and not redacted into something that looks fine.
  if (redactShapes(input.target) !== input.target) bad('target', 'target looks like a credential; a request names a step and never carries a value');
  if (redactShapes(input.reason) !== input.reason) bad('reason', 'reason looks like a credential; a request names a step and never carries a value');
  const envName = input.envName ?? null;
  if ((input.kind === 'env_var') !== (envName !== null)) bad('env_name', input.kind === 'env_var' ? 'an env_var request names the variable' : 'only an env_var request names a variable');
  if (envName !== null && !ENV_NAME_RE.test(envName)) bad('env_name', 'env_name must be a variable name');
  const check = input.check ?? null;
  if (check !== null && input.kind !== 'env_var') bad('check', 'only an env_var request can carry a check');
  let providerUrl: string | null = null;
  if (input.providerUrl !== undefined && input.providerUrl !== null) {
    providerUrl = normalizeProviderUrl(input.providerUrl);
    if (providerUrl === null) bad('provider_url', 'provider_url must be an https page on github.com or vercel.com');
  }

  // The repo must be the account's (row security), and a named item must belong to that repo.
  const repo = await client.query('SELECT 1 FROM repos WHERE id = $1::uuid', [input.repoId]);
  if (repo.rowCount === 0) throw new NotFoundError('repo not found');
  if (workItemId !== null) {
    const item = await client.query<{ repo_id: string | null }>('SELECT repo_id FROM work_items WHERE id = $1::uuid', [workItemId]);
    if (item.rowCount === 0) throw new NotFoundError('work item not found');
    if (item.rows[0]!.repo_id !== input.repoId) throw new SetupRequestError('work_item_repo_mismatch', 'the work item belongs to a different repo', 'work_item_id');
  }

  try {
    const { rows } = await client.query<Row>(
      `INSERT INTO setup_requests (account_id, repo_id, work_item_id, origin, kind, target, env_name, reason, provider_url, check_kind, created_by)
       VALUES (NULLIF(current_setting('app.account_id', true), '')::uuid, $1::uuid, $2::uuid, 'agent', $3, $4, $5, $6, $7, $8, $9::uuid)
       RETURNING ${COLUMNS}`,
      [input.repoId, workItemId, input.kind, input.target, envName, input.reason, providerUrl, check, input.userId],
    );
    // A request with an automatic check is looked at by the check sweep; tell it there is work (an idle platform opens no connection).
    if (check !== null) markSetupRequestCheckPending();
    return map(rows[0]!);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === PG_UNIQUE) throw new SetupRequestError('already_open', 'this step is already requested');
    throw error;
  }
}

/** Tells the check sweep there is a request to look at. Never throws and never waits on the store (the row is the durable signal; the backstop finds it). */
export function markSetupRequestCheckPending(): void {
  void markWorkPending('setup-request-check');
}

export interface ListSetupRequestsInput {
  /** `open` (default): requests waiting for a person. `all`: every state, newest first. */
  state?: 'open' | 'all';
  workItemId?: string;
  repoId?: string;
  limit?: number;
}

export const SETUP_REQUEST_LIST_LIMIT = 200;

/** The account's requests, newest first. `truncated` is true when more exist than were returned. */
export async function listSetupRequests(client: PoolClient, input: ListSetupRequestsInput = {}): Promise<{ requests: SetupRequest[]; truncated: boolean }> {
  const limit = input.limit ?? SETUP_REQUEST_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SETUP_REQUEST_LIST_LIMIT) throw new SetupRequestError('invalid_input', 'limit is out of range', 'limit');
  for (const [field, value] of [['work_item_id', input.workItemId], ['repo_id', input.repoId]] as const) {
    if (value !== undefined && !UUID_RE.test(value)) throw new SetupRequestError('invalid_input', `${field} must be an id`, field);
  }
  const { rows } = await client.query<Row>(
    `SELECT ${COLUMNS} FROM setup_requests
      WHERE ($1::text = 'all' OR state = 'open')
        AND ($2::uuid IS NULL OR work_item_id = $2::uuid)
        AND ($3::uuid IS NULL OR repo_id = $3::uuid)
      ORDER BY created_at DESC, id
      LIMIT $4::integer`,
    [input.state ?? 'open', input.workItemId ?? null, input.repoId ?? null, limit + 1],
  );
  return { requests: rows.slice(0, limit).map(map), truncated: rows.length > limit };
}

export async function getSetupRequest(client: PoolClient, id: string): Promise<SetupRequest> {
  if (!UUID_RE.test(id)) throw new NotFoundError('setup request not found');
  const { rows } = await client.query<Row>(`SELECT ${COLUMNS} FROM setup_requests WHERE id = $1::uuid`, [id]);
  if (rows.length === 0) throw new NotFoundError('setup request not found');
  return map(rows[0]!);
}

/**
 * A person's decision on an open request: `done` (resumes the item at once; a later failing check puts it back) or `withdrawn` (the item
 * stays paused). Repeating the decision already taken returns the request unchanged; the opposite decision on a closed request is `not_open`.
 * The person is the transaction's `app.user_id`, which the database requires to be an owner or admin of the account.
 */
export async function resolveSetupRequest(client: PoolClient, input: { id: string; userId: string; to: 'done' | 'withdrawn' }): Promise<SetupRequest> {
  if (!UUID_RE.test(input.userId)) throw new SetupRequestError('invalid_input', 'userId must be a user id', 'userId');
  const current = await getSetupRequest(client, input.id);
  if (current.state === input.to) return current;
  if (current.state !== 'open') throw new SetupRequestError('not_open', `the request is already ${current.state}`);
  const { rows } = await client.query<Row>(
    `UPDATE setup_requests
        SET state = $2, resolution = $3, resolved_by = $4::uuid
      WHERE id = $1::uuid AND state = 'open'
      RETURNING ${COLUMNS}`,
    [input.id, input.to, input.to === 'done' ? 'marked_done' : 'withdrawn', input.userId],
  );
  if (rows.length > 0) return map(rows[0]!);
  // Lost a race with another decision: report what it was.
  const after = await getSetupRequest(client, input.id);
  if (after.state === input.to) return after;
  throw new SetupRequestError('not_open', `the request is already ${after.state}`);
}

/**
 * The derived request for a repo and kind (public/private drift): raised when the condition holds, refreshed when its words change, closed
 * as `condition_cleared` when it no longer holds. `current` null means the condition does not hold. No person is involved, and nothing is
 * stamped: calling it again with the same facts changes nothing.
 */
export async function syncDerivedSetupRequest(
  client: PoolClient,
  input: { repoId: string; kind: 'parity_drift'; current: { target: string; reason: string; providerUrl?: string | null } | null },
): Promise<SetupRequest | null> {
  if (!UUID_RE.test(input.repoId)) throw new SetupRequestError('invalid_input', 'repo_id must be a repo id', 'repo_id');
  const open = await client.query<Row>(
    `SELECT ${COLUMNS} FROM setup_requests WHERE repo_id = $1::uuid AND kind = $2 AND origin = 'derived' AND state = 'open' FOR UPDATE`,
    [input.repoId, input.kind],
  );
  const held = open.rows[0];
  if (input.current === null) {
    if (!held) return null;
    const { rows } = await client.query<Row>(
      `UPDATE setup_requests SET state = 'done', resolution = 'condition_cleared' WHERE id = $1::uuid RETURNING ${COLUMNS}`,
      [held.id],
    );
    return map(rows[0]!);
  }
  if (!isValidTarget(input.current.target)) throw new SetupRequestError('invalid_input', 'target must be 1 to 200 characters without control characters', 'target');
  if (!isValidReason(input.current.reason)) throw new SetupRequestError('invalid_input', 'reason must be 1 to 1000 characters of plain text', 'reason');
  if (held) {
    if (held.target === input.current.target && held.reason === input.current.reason) return map(held);
    const { rows } = await client.query<Row>(`UPDATE setup_requests SET target = $2, reason = $3 WHERE id = $1::uuid RETURNING ${COLUMNS}`, [held.id, input.current.target, input.current.reason]);
    return map(rows[0]!);
  }
  const providerUrl = input.current.providerUrl ? normalizeProviderUrl(input.current.providerUrl) : null;
  if (input.current.providerUrl && providerUrl === null) throw new SetupRequestError('invalid_input', 'provider_url must be an https page on github.com or vercel.com', 'provider_url');
  const { rows } = await client.query<Row>(
    `INSERT INTO setup_requests (account_id, repo_id, work_item_id, origin, kind, target, reason, provider_url)
     SELECT NULLIF(current_setting('app.account_id', true), '')::uuid, r.id, NULL, 'derived', $2, $3, $4, $5 FROM repos r WHERE r.id = $1::uuid
     RETURNING ${COLUMNS}`,
    [input.repoId, input.kind, input.current.target, input.current.reason, providerUrl],
  );
  if (rows.length === 0) throw new NotFoundError('repo not found');
  return map(rows[0]!);
}

/** Why an item is held by a setup request, or null when none holds it. Read from the requests each time; nothing is stamped on the item. */
export type SetupHold = 'setup_request_open' | 'setup_request_withdrawn';

export async function setupHoldFor(client: PoolClient, workItemId: string): Promise<SetupHold | null> {
  if (!UUID_RE.test(workItemId)) return null;
  const { rows } = await client.query<{ hold: SetupHold | null }>(
    `SELECT CASE
              WHEN bool_or(s.state = 'open') THEN 'setup_request_open'
              WHEN bool_or(s.state = 'withdrawn' AND NOT EXISTS (
                     SELECT 1 FROM run_action_requests q
                      WHERE q.account_id = s.account_id AND q.kind = 'advance_work_item' AND q.target_id = s.work_item_id AND q.created_at > s.resolved_at))
                THEN 'setup_request_withdrawn'
            END AS hold
       FROM setup_requests s
      WHERE s.work_item_id = $1::uuid AND s.state IN ('open', 'withdrawn')`,
    [workItemId],
  );
  return rows[0]?.hold ?? null;
}

export type CheckApplied =
  | { result: 'skipped' }
  | { result: 'stamped'; request: SetupRequest }
  | { result: 'resolved'; request: SetupRequest; advance: { actionId: string; replayed: boolean } | null };

/**
 * What a check found, written once on the request's own tenant transaction (the caller opens it with a member of the account as the
 * session user: the table's update policy and the run-action definer both want a person on the transaction, and the sweep uses the one who
 * proposed the request). Locks the request first; one that is no longer open (withdrawn or marked done meanwhile) is `skipped`, nothing
 * written.
 *  - pass: the request closes as `check_passed` (no person is named as the resolver) and, when it names a work item, ONE `advance_work_item`
 *    run-action request is filed in the same transaction (the existing run action restarts the held workflow, or answers `already_running`; a
 *    repeat by the same request returns the first). A failure to file it rolls the whole thing back, so a pass is never recorded without the wake-up.
 *  - not yet: only the check's stamp moves (`check_ran_at` from the database clock, `check_reason` the fixed reason code). The request stays
 *    open and the item stays paused.
 */
export async function applyCheckOutcome(client: PoolClient, input: { id: string; outcome: CheckOutcome }): Promise<CheckApplied> {
  if (!UUID_RE.test(input.id)) throw new NotFoundError('setup request not found');
  const locked = await client.query<Row>(`SELECT ${COLUMNS} FROM setup_requests WHERE id = $1::uuid FOR UPDATE`, [input.id]);
  const current = locked.rows[0];
  if (current === undefined) throw new NotFoundError('setup request not found');
  if (current.state !== 'open' || current.check_kind === null) return { result: 'skipped' };
  if (!input.outcome.pass) {
    const { rows } = await client.query<Row>(
      `UPDATE setup_requests SET check_reason = $2, check_ran_at = now() WHERE id = $1::uuid AND state = 'open' RETURNING ${COLUMNS}`,
      [input.id, input.outcome.reason],
    );
    return { result: 'stamped', request: map(rows[0]!) };
  }
  const { rows } = await client.query<Row>(
    `UPDATE setup_requests SET state = 'done', resolution = 'check_passed', check_ran_at = now() WHERE id = $1::uuid AND state = 'open' RETURNING ${COLUMNS}`,
    [input.id],
  );
  const request = map(rows[0]!);
  let advance: { actionId: string; replayed: boolean } | null = null;
  if (request.workItemId !== null) {
    const key = `setup_request_check_passed:${request.id}`;
    const filed = await client.query<{ action_id: string; replayed: boolean }>(
      'SELECT action_id, replayed FROM run_action_request($1, $2::uuid, $3, $4)',
      ['advance_work_item', request.workItemId, key, createHash('sha256').update(key).digest('hex')],
    );
    advance = { actionId: filed.rows[0]!.action_id, replayed: filed.rows[0]!.replayed };
  }
  return { result: 'resolved', request, advance };
}

const SAVEPOINT_REOPEN = 'setup_request_reopen';

/**
 * A request marked done whose check now says "not yet" goes back to waiting, with the check's reason (the one transition the table allows
 * from `done`). The unique index allows one open request per step, so a newer open request for the same item, kind and target (someone asked
 * again while this one was done) is the request that waits: the old one stays done, the reason lands on the newer one, and no second open
 * row is made. A twin that appears between the look and the write (two callers at once) is the unique violation; the look is repeated.
 * Run it on a tenant transaction whose session user is a member of the account. Returns the request that is open afterwards.
 */
export async function reopenSetupRequest(client: PoolClient, input: { id: string; reason: CheckReasonCode }): Promise<{ request: SetupRequest; folded: boolean }> {
  if (!UUID_RE.test(input.id)) throw new NotFoundError('setup request not found');
  const locked = await client.query<Row>(`SELECT ${COLUMNS} FROM setup_requests WHERE id = $1::uuid FOR UPDATE`, [input.id]);
  const old = locked.rows[0];
  if (old === undefined) throw new NotFoundError('setup request not found');
  if (old.state === 'withdrawn') throw new SetupRequestError('not_open', 'the request was withdrawn');
  if (old.check_kind === null) throw new SetupRequestError('invalid_input', 'only a request with an automatic check can be put back', 'check');
  const stamp = (id: string) =>
    client.query<Row>(`UPDATE setup_requests SET check_reason = $2, check_ran_at = now() WHERE id = $1::uuid RETURNING ${COLUMNS}`, [id, input.reason]);
  if (old.state === 'open') return { request: map((await stamp(old.id)).rows[0]!), folded: false };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const twin = await client.query<{ id: string }>(
      `SELECT id FROM setup_requests
        WHERE state = 'open' AND id <> $1::uuid AND repo_id = $2::uuid AND kind = $3 AND target = $4
          AND COALESCE(env_name, '') = COALESCE($5, '') AND work_item_id IS NOT DISTINCT FROM $6::uuid
        FOR UPDATE`,
      [old.id, old.repo_id, old.kind, old.target, old.env_name, old.work_item_id],
    );
    if (twin.rows[0] !== undefined) {
      const request = map((await stamp(twin.rows[0].id)).rows[0]!);
      if (request.checkKind !== null) markSetupRequestCheckPending();
      return { request, folded: true };
    }
    await client.query(`SAVEPOINT ${SAVEPOINT_REOPEN}`);
    try {
      const { rows } = await client.query<Row>(
        `UPDATE setup_requests
            SET state = 'open', resolution = NULL, resolved_by = NULL, resolved_at = NULL, check_reason = $2, check_ran_at = now()
          WHERE id = $1::uuid AND state = 'done' RETURNING ${COLUMNS}`,
        [old.id, input.reason],
      );
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT_REOPEN}`);
      markSetupRequestCheckPending();
      return { request: map(rows[0]!), folded: false };
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== PG_UNIQUE) throw error;
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_REOPEN}`);
    }
  }
  throw new SetupRequestError('already_open', 'this step is already requested');
}
