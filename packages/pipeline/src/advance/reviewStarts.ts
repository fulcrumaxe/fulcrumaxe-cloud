import { attemptKey } from "./attemptKeys.js";

/**
 * D#483 S5-k1d: the two starts after the build that a spending limit can deny (a reviewer's run on a head, and the executor's fix round), and what they share
 * with the other waiting starts: the run key of each attempt, built by the one attempt helper (the first ask keeps the key it always had, every later ask is
 * `:s<n>` after everything else in the key), and the same key shape as a SQL pattern, so the sweep that resumes a parked review or fix round counts exactly the runs
 * these starts made.
 *
 * The keys are the ones the starts already used (`review:<head>:<role>[:rr<n>]` here, and the worker's `fix:<head>:<approval>[:r<n>]`); the worker puts
 * `advance:<item>:` in front. A re-review round (`:rr<n>`) and an attempt (`:s<n>`) are different suffixes of different letters, and the attempt goes last, so a
 * re-review round asked while an attempt is pending can never reuse the attempt's number or its key.
 */

const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const ROLE = /^[a-z][a-z-]{0,40}$/;

/** The step name of one ask of one reviewer on one head: the bare key on the first ask, `<key>:s<n>` on a later one. */
export function reviewStep(headSha: string, role: string, rereview = 0, attempt = 0): string {
  return attemptKey(`review:${headSha}:${role}${rereview > 0 ? `:rr${rereview}` : ""}`, attempt);
}

/** Characters that mean something in a LIKE pattern, escaped with a backslash (the pattern is used with ESCAPE '\'). */
const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The SQL LIKE pattern (`ESCAPE '\'`) of the idempotency keys of every reviewer run on one head of one item (any role, any re-review round, any attempt, with or
 * without a placement generation). A head that is not a commit id gives no pattern, so a malformed one matches nothing.
 */
export function reviewKeyLikes(workItemId: string, headSha: string | null): string[] {
  if (headSha === null || !SHA.test(headSha)) return [];
  return [`advance:${likeEscape(workItemId)}:review:${headSha}:%`];
}

/**
 * The same for the fix rounds of one head under one approval (the worker's key: `fix:<head>:<approval>[:r<retry>][:s<n>]`, then a placement generation and a note
 * pin). The head is part of the key, so an earlier round on an earlier head never counts against this one.
 */
export function fixKeyLikes(workItemId: string, headSha: string | null, actionId: string): string[] {
  if (headSha === null || !SHA.test(headSha)) return [];
  return [`advance:${likeEscape(workItemId)}:fix:${headSha}:${likeEscape(actionId)}%`];
}

/** The role and the re-review round a reviewer run's key names, or null when it is not a reviewer key. Reads through an attempt, a placement generation and a note pin. */
export function parseReviewKey(key: string): { headSha: string; role: string; rereview: number } | null {
  const m = /:review:([0-9a-f]{40}|[0-9a-f]{64}):([a-z][a-z-]*)(?::rr(\d{1,3}))?(?::s\d{1,6})?(?::p\d{1,2})?(?::n[0-9a-f]{16})?$/.exec(key);
  if (!m || !ROLE.test(m[2]!)) return null;
  return { headSha: m[1]!, role: m[2]!, rereview: m[3] === undefined ? 0 : Number(m[3]) };
}
