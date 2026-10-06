import { z } from "zod";
import { ApiError, InvalidCursorError } from "./errors.js";

/** "The v1 contract": {data:[...], next_cursor:string|null}. No totals. */
export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

// Security fix round item 3 (CWE-755): a strict decimal-integer shape,
// no leading zero (so "0" alone still parses, but never a form like
// "010"), so `Number()`'s permissive coercion -- "1e2", "0x10", " 5 "
// all becoming a valid finite number -- never reaches the range check
// below.
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;

/**
 * `limit=201` -> 422 (criterion 4 of API-3a, exercised here at the shared
 * helper so every later paginated route gets it for free). No `limit` ->
 * the default. Anything that isn't a positive integer within range is a
 * validation failure, mapped by the caller's zod query schema in
 * practice -- this is the one place the numbers themselves live.
 *
 * Security fix round item 3 (CWE-755, security review of this PR):
 * previously threw a bare `RangeError`, which `mapError` has no case
 * for and falls through to 500 `internal_error` -- a caller that calls
 * this directly (rather than through a route's zod query schema) turned
 * an out-of-range `limit` into a server fault instead of a validation
 * error. Now throws an `ApiError` (422 `validation_failed`, with a
 * `details` entry naming `limit`) the same way `mapError` already maps
 * every other validation failure in this package.
 */
export function parseLimit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") {
    return DEFAULT_LIMIT;
  }
  if (!DECIMAL_INTEGER.test(raw)) {
    throw new ApiError(422, "validation_failed", `limit must be a positive integer, got: ${raw}`, [
      { path: "limit", code: "invalid_type" },
    ]);
  }
  const n = Number(raw);
  if (n < 1 || n > MAX_LIMIT) {
    throw new ApiError(
      422,
      "validation_failed",
      `limit must be an integer between 1 and ${MAX_LIMIT}, got: ${raw}`,
      [{ path: "limit", code: "too_big" }],
    );
  }
  return n;
}

interface CursorPayload {
  created_at: string;
  id: string;
}

const cursorIdSchema = z.string().uuid();

// Fix round 2 (CWE-1284): `Date.parse` silently normalizes an
// out-of-range calendar date (Feb 30 -> Mar 2) and accepts years outside
// 1-9999, unlike Postgres's `timestamptz` parser (error 22008) -- a
// forged cursor built from one of those used to reach `$3::timestamptz`
// unchanged and come back as 500, not 422. Require the exact fixed-width
// shape `encodeCursor`/`to_char(...)` (packages/core's read.ts) emits,
// plus a real calendar check.
const CURSOR_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function isValidCursorTimestamp(value: string): boolean {
  const match = CURSOR_TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

/**
 * An opaque keyset cursor on `(created_at, id)`. Deliberately NOT
 * encrypted (unlike the SSE account-stream cursor API-5 seals with
 * `FX_CURSOR_KEY_V1`) -- "The v1 contract" only calls this one "opaque",
 * and it carries nothing sensitive beyond a timestamp and a row id the
 * caller already knows from the very page they cursor from (fix round 1:
 * `createdAt` is now text, not a millisecond-only `Date`).
 */
export function encodeCursor(createdAt: string, id: string): string {
  const payload: CursorPayload = { created_at: createdAt, id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Throws InvalidCursorError (422 `invalid_cursor`) for anything that
 * doesn't decode back to a well-formed payload -- a tampered or
 * truncated cursor looks the same here as a well-formed one whose `id`
 * isn't a real row id.
 *
 * Security fix round item 4 (CWE-20, security review of this PR): `id`
 * is now checked against `z.string().uuid()` (the same validator
 * `contract.test.ts` already uses for a response `id` field) before
 * this returns -- once `id` reaches a route's keyset query as a `uuid`
 * column parameter, an arbitrary string previously reached Postgres and
 * came back as error 22P02, which `mapError` has no case for and maps
 * to 500. Tenant isolation never depended on this: the cursor carries
 * no `account_id`, and the keyset query it feeds always runs under the
 * caller's own RLS, so a forged `id` could only ever move within the
 * caller's own rows -- this fix is about status-code correctness
 * (a validation failure, not a server fault), not an isolation gap.
 *
 * Fix round 2: `created_at` is now checked with `isValidCursorTimestamp`
 * instead of `Date.parse` -- see that function's comment.
 */
export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as CursorPayload).created_at !== "string" ||
    typeof (parsed as CursorPayload).id !== "string" ||
    "v" in parsed || // a queue cursor (see encodeQueueCursor) must never page the default sort
    !isValidCursorTimestamp((parsed as CursorPayload).created_at) ||
    !cursorIdSchema.safeParse((parsed as CursorPayload).id).success
  ) {
    throw new InvalidCursorError();
  }
  return parsed as CursorPayload;
}

interface QueueCursorPayload {
  v: "q1";
  priority: number;
  queue_rank: string | null;
  created_at: string;
  id: string;
}

const QUEUE_RANK_RE = /^(?:0|[1-9][0-9]{0,15})$/;

/** The `sort=queue` cursor: versioned, and carries the whole pick-order key (`queueRank` is bigint text, null = unranked). */
export function encodeQueueCursor(key: { priority: number; queueRank: string | null; createdAt: string; id: string }): string {
  const payload: QueueCursorPayload = {
    v: "q1",
    priority: key.priority,
    queue_rank: key.queueRank,
    created_at: key.createdAt,
    id: key.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** InvalidCursorError (422) for anything that is not a well-formed `q1` payload -- including a default-sort cursor. */
export function decodeQueueCursor(cursor: string): { priority: number; queueRank: string | null; createdAt: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  const p = parsed as Partial<QueueCursorPayload> | null;
  if (
    typeof p !== "object" ||
    p === null ||
    p.v !== "q1" ||
    !Number.isInteger(p.priority) ||
    p.priority! < 0 ||
    p.priority! > 3 ||
    !(p.queue_rank === null || (typeof p.queue_rank === "string" && QUEUE_RANK_RE.test(p.queue_rank))) ||
    typeof p.created_at !== "string" ||
    !isValidCursorTimestamp(p.created_at) ||
    typeof p.id !== "string" ||
    !cursorIdSchema.safeParse(p.id).success
  ) {
    throw new InvalidCursorError();
  }
  return { priority: p.priority!, queueRank: p.queue_rank, createdAt: p.created_at, id: p.id };
}
