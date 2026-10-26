import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { EXECUTOR_ROLE, WorkItemHaltedError, type ExecutionTargetRegistry } from "@fx/runner";
import { REFUSED_BY_CODES, continueAfterLimit, type ContinueAfterLimitResult } from "@fx/pipeline";
import { continuationStartInput, type ContinuationDeps } from "./continuation.js";

/**
 * D#2 H14c-3-3b-2 (C88 R1, R5, R7, section 3): what the advance workflow asks, at the moment it reads an executor run that ended at a limit
 * (`timed_out` or `killed_spend`), before it records any failure. One answer, a fixed code the workflow switches on; the library
 * (`continueAfterLimit`) decides, this module only gathers the facts around it and maps what it answers.
 *
 * Fails closed: every answer that is not an exact, known continuation or park is `today`, which is the path the workflow took before this existed
 * (the item goes to Needs a person as `run_timed_out` / `run_killed_spend`). An unknown state, a missing row, a thrown error, a run that is not the
 * item's newest executor run, a role that is not the executor, a stage that is not one a build or a fix round runs in: all `today`, none starts anything.
 * Idempotent: a replayed step finds the child the first one started (by `parent_run_id`) and answers it; the library's keyed start and the database's
 * one-live-continuation-per-parent index are what stop a second start, and the cap on automatic continuations is counted from stored runs, never
 * from anything the workflow holds, so a restarted or retried workflow cannot reset it.
 */

/** The same value as `MAX_CONTINUATIONS_PER_WORK_ITEM` in @fx/core (a workflow body imports no value from a package, so a test holds the two equal). */
export const CONTINUE_LOOP_CEILING = 10;
/** Every code a step answers. */
export const ADVANCE_CONTINUE_CODES = ["continued", "duplicate", "parked", "work_item_closed", "waiting_on_answer", "busy", "halted", "today"] as const;
export type AdvanceContinueCode = (typeof ADVANCE_CONTINUE_CODES)[number];

/** What the workflow keeps: fixed words and a run id. `parkedAs` is a `refused_by` code or `monthly_budget_reached`, only with `parked`. */
export interface AdvanceContinueOut {
  code: AdvanceContinueCode;
  runId: string | null;
  parkedAs: string | null;
}

const out = (code: AdvanceContinueCode, runId: string | null = null, parkedAs: string | null = null): AdvanceContinueOut => ({ code, runId, parkedAs });
const TODAY = out("today");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The stages an executor run that a workflow waits on can end in: the build, a check fix round, a review fix round. Anything else is not continued. */
const CONTINUABLE_STAGES = new Set(["in_progress", "pr_opened", "changes_requested", "review_passed"]);
const CLOSED_STAGES = new Set(["merged", "closed_unmerged", "closed"]);
/** Parks whose fixed word the workflow can show (the pipeline's list plus the monthly budget); anything else read back is not trusted. */
const PARK_AS: ReadonlySet<string> = new Set([...REFUSED_BY_CODES, "monthly_budget_reached"]);

export interface AdvanceContinueDeps extends ContinuationDeps {
  registry: ExecutionTargetRegistry | null | undefined;
  /** The run-extension dial's seat (H14c-5c-3); absent in this part. Called after the open-ask check and before anything is read for a start. */
  gate?: (accountId: string, workItemId: string, endedRunId: string) => Promise<"allow" | "defer">;
  /** Test seam: the library call. */
  continueAfter?: typeof continueAfterLimit;
  /** Called with the error's name only, never its text. */
  logError?: (name: string) => void;
}

async function childOf(pool: Pool, accountId: string, endedRunId: string): Promise<string | null> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE account_id = $1 AND parent_run_id = $2 AND status <> 'refused_spend' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [accountId, endedRunId],
    );
    return rows[0]?.id ?? null;
  });
}

/** An open or overdue ask of any type on this run (C88 R5). */
async function hasOpenAsk(pool: Pool, accountId: string, runId: string): Promise<boolean> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM decision_asks WHERE account_id = $1 AND run_id = $2 AND state IN ('open', 'overdue')`,
      [accountId, runId],
    );
    return (rows[0]?.n ?? 0) > 0;
  });
}

/**
 * R7: no child, and the item is already in Needs a person: the park a first pass recorded, read from the item's own newest needs-a-person event
 * (a fixed `reason` and `refused_by`, validated against the known lists). Null when it cannot be read, so the caller takes today's path.
 */
async function recordedPark(pool: Pool, accountId: string, workItemId: string, endedRunId: string): Promise<string | null> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ reason: string | null; refused_by: string | null }>(
      `SELECT e.payload->>'reason' AS reason, e.payload->>'refused_by' AS refused_by
         FROM domain_events e
        WHERE e.account_id = $1 AND e.type = 'work_item.needs_human' AND e.subject_id = $2
          AND e.created_at >= (SELECT r.created_at FROM agent_runs r WHERE r.account_id = $1 AND r.id = $3)
        ORDER BY e.created_at DESC, e.id DESC LIMIT 1`,
      [accountId, workItemId, endedRunId],
    );
    const row = rows[0];
    if (!row) return null;
    const as = row.reason === "monthly_budget_reached" ? "monthly_budget_reached" : row.reason === "run_limit_reached" ? row.refused_by : null;
    return as !== null && PARK_AS.has(as) ? as : null;
  });
}

function mapResult(r: ContinueAfterLimitResult): AdvanceContinueOut | "duplicate" {
  switch (r.outcome) {
    case "continued": return out("continued", r.resume.id);
    case "parked": return r.reason === "monthly_budget_reached" ? out("parked", null, "monthly_budget_reached") : PARK_AS.has(r.refusedBy) ? out("parked", null, r.refusedBy) : TODAY;
    case "duplicate": return "duplicate";
    case "busy": return out("busy");
    case "refused": return r.reason === "work_item_closed" ? out("work_item_closed") : TODAY;
    default: return TODAY; // not_applicable, and any outcome this code does not know
  }
}

/**
 * The step. `endedRunId` is the run the workflow just read as ended; the step never trusts the workflow for anything else. Never throws.
 * The halt checks (the item's halt marker and epoch) are the caller's guard; a halt raised inside the start itself is `halted` here.
 */
export async function advanceContinue(deps: AdvanceContinueDeps, accountId: string, workItemId: string, endedRunId: string, at?: Date): Promise<AdvanceContinueOut> {
  try {
    if (!UUID_RE.test(accountId) || !UUID_RE.test(workItemId) || !UUID_RE.test(endedRunId)) return TODAY;
    const registry = deps.registry;
    if (!registry) return TODAY;
    // 1. The ended run, tenant-scoped, and a limit end. Whether it is the workflow's own item's executor run is the tail check in `decide`, which asks the database for the item's newest executor run.
    const ended = await withTenant(deps.pool, accountId, async (client) =>
      (await client.query<{ status: string }>(`SELECT status FROM agent_runs WHERE account_id = $1 AND id = $2`, [accountId, endedRunId])).rows[0]);
    if (!ended || (ended.status !== "timed_out" && ended.status !== "killed_spend")) return TODAY;
    // A replay (or a retry of a step the platform cut short) finds the run the first pass started and starts nothing.
    const existing = await childOf(deps.pool, accountId, endedRunId);
    if (existing !== null) return out("duplicate", existing);
    return await decide(deps, accountId, workItemId, endedRunId, at);
  } catch (err) {
    deps.logError?.(err instanceof Error ? err.name : "unknown");
    if (err instanceof WorkItemHaltedError) return out("halted");
    // An error after the start must not hide a child that is running: look once more (a failed look is today's path).
    try {
      const child = await childOf(deps.pool, accountId, endedRunId);
      if (child !== null) return out("duplicate", child);
    } catch {
      // fx-swallow-ok: the first error was already named above; with no readable child, today's path is the fail-closed answer
    }
    return TODAY;
  }
}

async function decide(deps: AdvanceContinueDeps, accountId: string, workItemId: string, endedRunId: string, at: Date | undefined): Promise<AdvanceContinueOut> {
  // 2. CARRY-25: only the run that just ended. It must be THIS item's newest executor run: a run of another item, another role or an older run is never the tail.
  const state = await withTenant(deps.pool, accountId, async (client) => {
    const item = await client.query<{ stage: string }>(`SELECT stage FROM work_items WHERE account_id = $1 AND id = $2`, [accountId, workItemId]);
    const newest = await client.query<{ id: string }>(
      `SELECT id FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND role = $3 AND status <> 'refused_spend' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [accountId, workItemId, EXECUTOR_ROLE],
    );
    return { stage: item.rows[0]?.stage, newest: newest.rows[0]?.id };
  });
  if (state.stage === undefined || state.newest !== endedRunId) return TODAY;
  if (CLOSED_STAGES.has(state.stage)) return out("work_item_closed");
  if (state.stage === "needs_human") {
    // Already parked by a first pass whose child was never made: say what was recorded (R7).
    const parked = await recordedPark(deps.pool, accountId, workItemId, endedRunId);
    return parked === null ? TODAY : out("parked", null, parked);
  }
  if (!CONTINUABLE_STAGES.has(state.stage)) return TODAY;
  // 3. R5: an open decision ask on the run fronts the continuation; nothing is continued while it is open.
  if (await hasOpenAsk(deps.pool, accountId, endedRunId)) return out("waiting_on_answer");
  // The seam for the run-extension dial (H14c-5c-3, TL ruling 10-25): it decides here whether a limit end continues on its own. Nothing is wired to it in this part, so
  // by default a continuation goes on as `auto_resume` and `max_resumes` decide. Fail closed: only an exact "allow" continues; "defer" waits for a person; anything else is today's path.
  if (deps.gate) {
    const verdict = await deps.gate(accountId, workItemId, endedRunId);
    if (verdict === "defer") return out("waiting_on_answer");
    if (verdict !== "allow") return TODAY;
  }
  // 4. The start input comes from the seat as it resolves now (R4); a refusal starts nothing.
  const input = await continuationStartInput(deps, accountId, endedRunId);
  if ("refused" in input) return TODAY;
  // 5. The library: the decision, the lock, the keyed start.
  const result = mapResult(await (deps.continueAfter ?? continueAfterLimit)(deps.pool, deps.registry!, { accountId, runId: endedRunId, resumeInput: input, ...(at ? { at } : {}) }));
  if (result !== "duplicate") return result;
  // 6. R7: the library says this run was continued already. Its child is the answer; with none (the attempt was refused for spend) and the item parked, the recorded park.
  const child = await childOf(deps.pool, accountId, endedRunId);
  if (child !== null) return out("duplicate", child);
  const parked = await recordedPark(deps.pool, accountId, workItemId, endedRunId);
  return parked === null ? TODAY : out("parked", null, parked);
}
