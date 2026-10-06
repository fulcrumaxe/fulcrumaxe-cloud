import type { Pool } from 'pg';
import { markWorkPending } from '../pendingWork.js';
import { withTenant } from '../tenancy/withTenant.js';
import type { RunActionKind, RunActionMessage, RunActionSignal } from './signal.js';

export interface RunActionCtx {
  /** app_user pool -- the request runs through withTenant on it. */
  pool: Pool;
  /** `tokenId` is set for a token principal, and `userId` is then the token's creator. */
  principal: { accountId: string; userId: string; tokenId?: string };
}

export interface RunActionRequestInput {
  kind: RunActionKind;
  targetId: string;
  idempotencyKey?: string;
  /** Fingerprint of what the request names; a replayed key with another hash is refused (22023). */
  requestHash: string;
}

export interface RunActionRequestResult {
  actionId: string;
  state: string;
  replayed: boolean;
}

export interface RunActionDeps {
  signal: RunActionSignal;
  /** Default 2000. */
  signalTimeoutMs?: number;
  /** Receives the action id and an error code only. Default: console.warn. */
  onSignalError?: (actionId: string, code: 'signal_failed' | 'signal_timeout') => void;
}

/**
 * Asks for a run action through the `run_action_request` definer (the account
 * and caller come from the session, never from a parameter). Database errors
 * reach the caller as they are: 42501 forbidden, P0002 not found, 22023 a
 * reused key. The signal goes out after the commit, only for a new row, and
 * never changes the result: a throw or a hang is cut off after the timeout.
 */
export async function requestRunAction(
  ctx: RunActionCtx,
  input: RunActionRequestInput,
  deps: RunActionDeps,
): Promise<RunActionRequestResult> {
  const { accountId, userId, tokenId } = ctx.principal;
  const row = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
    const { rows } = await client.query<{ action_id: string; state: string; replayed: boolean }>(
      'SELECT action_id, state, replayed FROM run_action_request($1, $2, $3, $4)',
      [input.kind, input.targetId, input.idempotencyKey ?? null, input.requestHash],
    );
    return rows[0]!;
  });
  const result = { actionId: row.action_id, state: row.state, replayed: row.replayed };
  if (!result.replayed) await announceNewRunAction(deps, { actionId: result.actionId, accountId, kind: input.kind });
  return result;
}

/**
 * The one step every path that queues run-action work takes once its row is committed: mark the run-action sweep
 * pending (so the gated cron does not skip the row if the kick is lost), then send the kick. A path that inserts a
 * run-action row and calls only sendSignal leaves the row waiting for the 30-minute backstop.
 */
export async function announceNewRunAction(deps: RunActionDeps, msg: RunActionMessage): Promise<void> {
  void markWorkPending('run-action-sweep');
  await sendSignal(deps, msg);
}

export async function sendSignal(deps: RunActionDeps, msg: RunActionMessage): Promise<void> {
  const report = deps.onSignalError ?? ((id, code) => console.warn(`run action ${id}: ${code}`));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'signal_timeout'>((resolve) => {
    timer = setTimeout(() => resolve('signal_timeout'), deps.signalTimeoutMs ?? 2000);
  });
  const sent = Promise.resolve()
    .then(() => deps.signal.signal(msg))
    .then(
      () => undefined,
      () => 'signal_failed' as const,
    );
  const failure = await Promise.race([sent, timedOut]);
  clearTimeout(timer);
  if (failure) report(msg.actionId, failure);
}
