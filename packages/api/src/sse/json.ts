import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { listRunEvents, type RunEventDTO } from "@fx/core/src/events/read.js";
import { RateLimitedError } from "../errors.js";
import { openCursor, parseRunCursor, sealCursor, isCursorStale, type CursorEnv } from "./cursor.js";
import { headSeq, readSettledEventsAfter, settleMsFromEnv } from "./poller.js";
import { isStreamVisible, toAccountEventDTO, toRunEventDTO, type AccountEventDTO } from "./views.js";

/**
 * D#31 API-5 criterion 8: `Accept: application/json` returns
 * `{data, next_cursor}` for the SAME events the stream would send, through
 * the same services (`listRunEvents` for a run, the account event read for
 * the account) and the same view/redaction layer.
 *
 * `next_cursor` is always resumable, unlike a "null on the last page"
 * cursor: a polling client passes it straight back as `?cursor=` and
 * receives only later events. With nothing new it echoes the position it
 * was given, re-sealed with the position time moved to now (the server has
 * just confirmed nothing older lies after it). Pages are SETTLED reads
 * (poller.ts): a row younger than the settle window is left for a later
 * page rather than risk skipping a lower serial that has not committed.
 */

/** "A token's 7th poll in one minute -> 429": JSON polling is metered separately from (and tighter than) the general per-token cap. */
export const JSON_POLLS_PER_TOKEN_PER_MINUTE = 6;

export interface AccountEventsPage {
  data: AccountEventDTO[];
  next_cursor: string;
  /** True when the presented cursor predates retention: the client must refetch state; `data` is empty and `next_cursor` is positioned at now. */
  resync?: boolean;
}

export interface RunEventsPage {
  data: RunEventDTO[];
  next_cursor: string;
}

/**
 * Charges one JSON poll against a TOKEN's 6-per-minute bucket
 * (`stream_json_poll_check`, migration 0639 -- tenant-bound like
 * `rate_limit_check`). Sessions are not metered here: a browser polls no
 * faster than its own stream would. Fails closed: a database error is a
 * thrown error (500), never "allowed".
 */
export async function chargeJsonPoll(pool: Pool, principal: { kind: string; accountId: string; tokenId?: string }): Promise<void> {
  if (principal.kind !== "token") return;
  if (!principal.tokenId) {
    throw new Error("chargeJsonPoll: token principal is missing tokenId");
  }
  const decision = await withTenant(pool, principal.accountId, async (client) => {
    const { rows } = await client.query<{ allowed: boolean; retry_after_seconds: number }>(
      "SELECT allowed, retry_after_seconds FROM stream_json_poll_check($1, $2)",
      [principal.tokenId, JSON_POLLS_PER_TOKEN_PER_MINUTE],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("stream_json_poll_check returned no row");
    }
    return row;
  });
  if (!decision.allowed) {
    throw new RateLimitedError(decision.retry_after_seconds);
  }
}

export async function accountEventsPage(
  pool: Pool,
  accountId: string,
  input: { cursor?: string; limit: number; settleMs?: number },
  nowMs: number,
  env: CursorEnv = process.env,
): Promise<AccountEventsPage> {
  // The cursor's third field is a POSITION time (cursor.ts); each call below says what it is set to.
  const mint = (serial: bigint, positionAtMs: number): string => sealCursor({ accountId, serial, issuedAtMs: positionAtMs }, env);

  if (!input.cursor) {
    // No position given: start from now. Nothing is replayed, matching an SSE connect without Last-Event-ID.
    return { data: [], next_cursor: mint(await headSeq(pool, accountId), nowMs) };
  }
  const claims = openCursor(input.cursor, accountId, env);
  if (isCursorStale(claims, nowMs)) {
    return { data: [], next_cursor: mint(await headSeq(pool, accountId), nowMs), resync: true };
  }
  // Settled read: a row still inside the settle window (and everything after it) is left for a later page,
  // so a lower serial whose transaction commits late is never skipped (poller.ts, COMMIT-ORDER SAFETY).
  const read = await readSettledEventsAfter(pool, accountId, claims.serial, input.limit, input.settleMs ?? settleMsFromEnv());
  const last = read.rows[read.rows.length - 1];
  if (!last) {
    // Nothing settled after a position that was in retention when presented: every later event is created
    // from now on, so the position time can move to now.
    return { data: [], next_cursor: mint(claims.serial, nowMs) };
  }
  return {
    data: read.rows.filter(isStreamVisible).map(toAccountEventDTO),
    // A full page may leave older rows behind it, so anchor to the last event's own created_at (the clock
    // retention purges by -- sweep.ts deletes on created_at -- which is what a position time guards; settling
    // uses inserted_at, a different question);
    // a short page has reached the settled end, so later events are all created from now on.
    next_cursor: mint(last.seq, read.full ? last.createdAt.getTime() : nowMs),
  };
}

export async function runEventsPage(
  pool: Pool,
  principal: { accountId: string; userId: string },
  runId: string,
  input: { cursor?: string; limit: number },
): Promise<RunEventsPage> {
  const afterSeq = input.cursor === undefined ? 0 : parseRunCursor(input.cursor);
  const page = await listRunEvents({ pool, principal }, runId, { afterSeq, limit: input.limit });
  const last = page.data[page.data.length - 1];
  return { data: page.data.map(toRunEventDTO), next_cursor: String(last ? last.seq : afterSeq) };
}
