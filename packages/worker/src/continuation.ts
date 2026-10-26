import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { PREVIEW_WORKDIR, EXECUTOR_ROLE } from "@fx/runner";
import { assembleSeatPrompt, type ContinueAfterLimitInput } from "@fx/pipeline";
import type { SeatRefusal, SeatRequest, SeatResult } from "./seat.js";

/**
 * D#2 H14c-3-3b-1 (C88 R4): the one place a continuation's start input is built. The automatic step (3b-2, 3b-3) and the
 * customer's Continue (3b-4) both call it, so a continued seat is configured the way a check-fix round is: from the seat resolver as it
 * answers NOW (limits, `maxExtensions`, model, role card), never copied from the ended run. The checkpoint's `extensions_used` is never an input (C69 section 5):
 * a continuation starts its own count at 0 against the resolved `maxExtensions`.
 */

/** The executor resumes its own session, so it needs no recap: one fixed sentence, never the checkpoint text. */
export const CONTINUE_PROMPT = "Your previous run of this task stopped at a run limit. Continue the same task from where it stopped.";
/** The other seats start a fresh run of the same seat. Their notes, when the ended run left any, follow this inside a fence, as data. */
export const SEAT_CONTINUE_PROMPT = "Your previous run of this seat stopped at a run limit. Do the same task again.";

export type ContinuationStartInput = ContinueAfterLimitInput["resumeInput"];
export type ContinuationRefusal = SeatRefusal | "run_not_found" | "no_repo";

export interface ContinuationDeps {
  /** The runner login's pool. */
  pool: Pool;
  resolveRunSeat: (request: SeatRequest) => Promise<SeatResult>;
}

/**
 * `resumeInput` for `continueAfterLimit` and `continueWorkItem`, or `{ refused }` with nothing started (a seat refusal keeps its own word).
 * Reads the ended run (role, work item, repository, Spec version, pull request number, side) and, for a seat that starts fresh, the checkpoint's summary.
 */
export async function continuationStartInput(deps: ContinuationDeps, accountId: string, endedRunId: string): Promise<ContinuationStartInput | { refused: ContinuationRefusal }> {
  const ended = await withTenant(deps.pool, accountId, async (client) => {
    const run = await client.query<{ role: string; work_item_id: string | null; repo_id: string | null; gh_number: string | null; spec_version_id: string | null; run_mode: string | null }>(
      `SELECT ar.role, ar.work_item_id, w.repo_id, w.gh_number, ar.spec_version_id, ar.execution_mode AS run_mode
         FROM agent_runs ar JOIN work_items w ON w.account_id = ar.account_id AND w.id = ar.work_item_id
        WHERE ar.account_id = $1 AND ar.id = $2`,
      [accountId, endedRunId],
    );
    const row = run.rows[0];
    if (!row?.work_item_id) return undefined;
    const note = await client.query<{ summary: string | null }>(
      `SELECT payload->>'summary' AS summary FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = 'checkpoint' ORDER BY seq LIMIT 1`,
      [accountId, endedRunId],
    );
    return { ...row, workItemId: row.work_item_id, summary: note.rows[0]?.summary ?? undefined };
  });
  if (!ended) return { refused: "run_not_found" };
  const pr = ended.gh_number === null ? NaN : Number(ended.gh_number);
  if (ended.repo_id === null || !Number.isSafeInteger(pr) || pr < 1) return { refused: "no_repo" };
  const seat = await deps.resolveRunSeat({ accountId, role: ended.role, workItemId: ended.workItemId, ...(ended.run_mode === null ? {} : { expectedExecutionMode: ended.run_mode }) });
  if (!seat.ok) return { refused: seat.reason };
  return {
    ...seat.seat,
    repoId: ended.repo_id,
    product: "team",
    pr,
    // The summary is the agent's own text: for a fresh seat it goes through the one assembler (capped, fenced as data); the executor never sees it.
    prompt: ended.role === EXECUTOR_ROLE ? CONTINUE_PROMPT : assembleSeatPrompt(SEAT_CONTINUE_PROMPT, ended.summary).prompt,
    ...(ended.spec_version_id === null ? {} : { specVersionId: ended.spec_version_id }),
    ...(ended.run_mode === null ? {} : { expectedExecutionMode: ended.run_mode }),
    workdir: PREVIEW_WORKDIR,
  };
}
