import type { Pool } from "pg";
import { reportError } from "@fx/telemetry";

/**
 * D#6 R5a-2c (corrections C27 section 3, C28 section 3): the ENFORCED daily limit on what the gh-proxy streams to runners from
 * `git-upload-pack`, per repository per UTC day, in bytes. The count of full clones in 0765 is only a soft cost signal (a hostile client can
 * fetch a full pack without a request that looks like a clone); bytes are what cost money, whatever the request claims to be.
 *
 * The counter lives in the database (migration 0766, `runner_git_bytes_account`), on the proxy's narrow login. The allowance is a constant
 * INSIDE that function, never an argument; this constant is pinned to it by a test. The proxy adds the bytes it has sent at every
 * checkpoint (RUNNER_UPLOAD_PACK_CHECKPOINT_BYTES) while a response streams, and the remainder when it ends, and it ends a response at the
 * first checkpoint that answers spent. So the accepted overrun is the number of responses in flight at once times one checkpoint, and a
 * response cut off or killed at the function's maximum duration loses at most the bytes since its last checkpoint. The next request is refused.
 *
 * TODO(owner): the figure is the PM's proposed default, an owner decision about the runner plan (C21's open runner-plan figures). Check it
 * against the plan's price and the Vercel transfer included in our plan before launch. Changing it is a one-line migration plus this constant.
 */
export const RUNNER_UPLOAD_PACK_DAILY_BYTES_PER_REPO = 2 * 1024 * 1024 * 1024;

/** How many response bytes the proxy sends between two adds to the counter (and the stream's check of the answer): 32 MiB. */
export const RUNNER_UPLOAD_PACK_CHECKPOINT_BYTES = 32 * 1024 * 1024;

const DAY_MS = 86_400_000;
/** The most one call to the database function may add (it refuses more): 1 TiB. */
const MAX_BYTES_PER_CALL = 1_099_511_627_776;

/** Seconds from `nowMs` to the next 00:00 UTC. At least 1, so a header is never `0` at the boundary. */
export function secondsUntilUtcMidnight(nowMs: number): number {
  return Math.max(1, Math.ceil((DAY_MS - (nowMs % DAY_MS)) / 1000));
}

export interface RunnerCloneBudget {
  /** True once the repository has spent today's allowance. `null` when the database could not be asked: the caller refuses (fail closed). */
  isSpent(repoId: string): Promise<boolean | null>;
  /**
   * Adds bytes that were actually streamed to a runner, at a checkpoint or when a response ends (finished or cut off), and answers as
   * `isSpent` does for the new total. `null` when nothing could be counted (a database error, or a count that is not a positive whole number):
   * a caller that is still streaming ends the response. Never throws.
   */
  record(repoId: string, bytes: number): Promise<boolean | null>;
}

const STAGE = "github.runner_clone_budget";
const QUERY = "SELECT public.runner_git_bytes_account($1, $2) AS spent";

/** The budget on the proxy's narrow pool. A database error is reported as a coded class (never the error's text). */
export function createRunnerCloneBudget(ghProxyPool: Pool): RunnerCloneBudget {
  async function call(repoId: string, bytes: number): Promise<boolean | null> {
    try {
      const { rows } = await ghProxyPool.query<{ spent: unknown }>(QUERY, [repoId, bytes]);
      if (rows.length !== 1 || typeof rows[0]!.spent !== "boolean") {
        reportError(new Error("runner clone budget answered an unexpected shape"), { stage: STAGE });
        return null;
      }
      return rows[0]!.spent;
    } catch (err) {
      reportError(err, { stage: STAGE });
      return null;
    }
  }
  return {
    isSpent: (repoId) => call(repoId, 0),
    async record(repoId, bytes) {
      if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;
      // A count larger than the function accepts in one call is added in parts; any part that failed makes the answer null.
      let answer: boolean | null = false;
      for (let left = bytes; left > 0; left -= MAX_BYTES_PER_CALL) {
        const part = await call(repoId, Math.min(left, MAX_BYTES_PER_CALL));
        answer = part === null || answer === null ? null : part;
      }
      return answer;
    },
  };
}
