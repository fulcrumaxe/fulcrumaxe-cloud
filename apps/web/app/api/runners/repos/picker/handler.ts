import type { NextRequest } from "next/server";
import type { Pool } from "pg";
import { listPickerRepos, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "@fx/runner-cloud";
import { RateLimitedError } from "@fx/api/src/errors.js";
import { pgSessionLimiter, SESSION_LIMITS, type SessionSubject } from "@fx/api/src/ratelimit/session.js";
import { handleSessionRequest } from "../../../../../lib/runnerRoutes";

/** Counts one picker read against the account's budget; throws `RateLimitedError` over it. */
export type PickerLimiter = (pool: Pool, subject: SessionSubject) => Promise<void>;
const defaultLimiter: PickerLimiter = (pool, subject) => pgSessionLimiter(pool, SESSION_LIMITS.runnerRepoPicker)(subject);

/**
 * The picker read behind the limit. The limit is charged first, so a refused call reads neither the database nor GitHub; a limiter that cannot run is a 500, never an
 * unlimited read. The refusal is the runner routes' own `rate_limited` shape with `retry_after`.
 */
export function pickerRun(limit: PickerLimiter = defaultLimiter, read: typeof listPickerRepos = listPickerRepos) {
  return async (deps: RunnerCloudDeps, principal: SessionPrincipal): Promise<RunnerHttpResponse> => {
    try {
      await limit(deps.appUserPool, { accountId: principal.accountId, userId: principal.userId });
    } catch (err) {
      if (!(err instanceof RateLimitedError)) throw err;
      const retryAfter = Math.max(1, Math.ceil(err.retryAfterSeconds));
      return { status: 429, body: { error: { code: "rate_limited", message: "too many picker reads; try again shortly" }, retry_after: retryAfter }, headers: { "retry-after": String(retryAfter) } };
    }
    return read(deps, principal);
  };
}

/** D#845 ON-7a2: GET /api/runners/repos/picker. Owner or admin; a runner signature has no meaning here and gets 401. The rules live in `listPickerRepos`; the per-account limit is `runnerRepoPicker`. */
export const listPickerReposHandler = (req: NextRequest) => handleSessionRequest(req, pickerRun());
