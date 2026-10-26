import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { ExecutionModeChangedError, WorkItemHaltedError, EXECUTOR_ROLE, recordStage, type ExecutionTargetRegistry } from "@fx/runner";
import { continueWorkItem, type ContinueAfterLimitResult } from "@fx/pipeline";
import type { AdvanceStartArgs } from "./advance.js";
import { continuationStartInput, type ContinuationDeps } from "./continuation.js";
import { RunActionInputError, guarded, type PerformResult } from "./runActions.js";

/**
 * D#2 H14c-3-3b-4 (C88 section 3, C89): the performer of `continue_work_item`, the back end of the manual Continue on a card parked at a run limit.
 * It turns one claimed request into at most ONE continuation run of the item's executor, on the customer's money, then follows that run with the
 * advance workflow. The route (API-6c) only files the request; everything that decides is here, at perform time.
 *
 * Order, and why. Every refusal that costs nothing comes first, and nothing is spent before the start:
 *   1. who it runs as: `run_action_perform_principal` (a session principal; a token or the system never continues), then an owner or admin of the account NOW
 *      (membership alone is not enough: the definer only proves membership). The account is the leased row's, never an input;
 *   2. the item, tenant-scoped; a replay is answered from the run this request's key already started, so a double click or a re-kick starts nothing;
 *   3. fail closed: a closed item, a halted item, an item that is not parked by a run limit, or a latest run that is not an executor run that ended at a
 *      limit is `not_continuable` (or its own code) and no run, reservation or stage move is made;
 *   4. the start input, built by `continuationStartInput` (the one place both the automatic and the manual path take it from);
 *   5. `continueWorkItem`, keyed on the request id (the lease row's id), under the item's lock. The library counts the ceiling from stored runs;
 *   6. on a start: needs_human -> in_progress (keyed, replay-safe), then the advance workflow follows the child.
 * A busy answer throws, so the run-action workflow retries it with backoff and, at the attempt cap, settles `failed busy`.
 */

/** Every code this performer can settle with (C88 section 3; API-6c maps each to a fixed code). A seat refusal and the library's own refusals keep their words. */
export const CONTINUE_FIXED_CODES = [
  "not_continuable", "work_item_closed", "work_item_ceiling", "spend", "monthly_budget_reached", "foreign_session", "no_spec_version", "work_item_halted",
  "principal_not_authorised", "kind_mismatch", "target_not_found", "prompt_not_retained", "spec_changed", "no_repo", "execution_mode_changed",
] as const;

/** Another caller is deciding this item right now and nothing was started: the workflow's `errorCodeFor` maps the name to `busy` and retries. */
export class ContinueBusyError extends Error {
  constructor() {
    super("continue: busy");
    this.name = "ContinueBusyError";
  }
}

export interface ContinueModuleDeps extends Pick<ContinuationDeps, "resolveRunSeat"> {
  /** apps/web starts the advance workflow here. Absent, the run still starts and a person's "Check the build" follows it. */
  startAdvance: ((args: AdvanceStartArgs) => Promise<void>) | null;
}

export interface ContinueFacade {
  /**
   * Performs a CLAIMED `continue_work_item` action. Takes the action id and nothing else. Outcome `{ run_id }`; a replay returns the same run and starts nothing.
   * Refusals: see `CONTINUE_FIXED_CODES`, or a seat refusal's own code.
   */
  performContinueWorkItem(actionId: string): Promise<PerformResult>;
}

interface PrincipalRow {
  allowed: boolean;
  account_id: string;
  kind: string;
  target_id: string;
  principal_kind: string;
  user_id: string | null;
}
interface Facts {
  role: string | undefined;
  item: { stage: string; halted: boolean; halt_epoch: number } | undefined;
  /** The run this request's own key started, if any. */
  own: { id: string; status: string } | undefined;
  /** The item's newest run other than a spend-refused one: the run `continueWorkItem` continues. */
  latest: { id: string; role: string; status: string } | undefined;
  /** The `reason` of the item's newest park (`work_item.needs_human`). */
  park: string | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const CLOSED_STAGES: readonly string[] = ["merged", "closed_unmerged", "closed"];
/** The only parks a Continue answers (C88 3b-4 item 4). */
const LIMIT_PARKS: readonly string[] = ["run_limit_reached", "monthly_budget_reached"];
/** The only ends a run can be continued from, and the only role this performer continues (the seats' sites belong to the advance workflow). */
const CONTINUABLE_STATUSES: readonly string[] = ["timed_out", "killed_spend"];
const TERMINAL: readonly string[] = ["succeeded", "failed", "timed_out", "killed_spend", "refused_spend", "cancelled"];
const refused = (errorCode: string): PerformResult => ({ result: "refused", errorCode });

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createContinueModule(runnerPool: Pool, registry: ExecutionTargetRegistry, deps: ContinueModuleDeps): ContinueFacade {
  async function load(accountId: string, userId: string, itemId: string, actionId: string): Promise<Facts> {
    return withTenant(runnerPool, accountId, userId, async (client): Promise<Facts> => {
      const role = (await client.query<{ role: string }>("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2", [accountId, userId])).rows[0]?.role;
      const item = (await client.query<NonNullable<Facts["item"]>>("SELECT stage, halted_at IS NOT NULL AS halted, halt_epoch FROM work_items WHERE id = $1 AND account_id = $2", [itemId, accountId])).rows[0];
      if (!item) return { role, item, own: undefined, latest: undefined, park: undefined };
      const own = (
        await client.query<{ id: string; status: string }>(
          `SELECT r.id, r.status FROM agent_runs r JOIN agent_run_idempotency_keys k ON k.account_id = r.account_id AND k.run_id = r.id
            WHERE r.account_id = $1 AND r.work_item_id = $2 AND r.parent_run_id IS NOT NULL AND k.idempotency_key = r.parent_run_id::text || ':manual-continue:' || $3`,
          [accountId, itemId, actionId],
        )
      ).rows[0];
      const latest = (
        await client.query<NonNullable<Facts["latest"]>>(
          "SELECT id, role, status FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND status <> 'refused_spend' ORDER BY created_at DESC, id DESC LIMIT 1",
          [accountId, itemId],
        )
      ).rows[0];
      const park = (
        await client.query<{ reason: string | null }>(
          "SELECT payload->>'reason' AS reason FROM domain_events WHERE account_id = $1 AND subject_id = $2 AND type = 'work_item.needs_human' ORDER BY seq DESC LIMIT 1",
          [accountId, itemId],
        )
      ).rows[0]?.reason;
      return { role, item, own, latest, park: park ?? undefined };
    });
  }

  async function perform(actionId: string): Promise<PerformResult> {
    if (typeof actionId !== "string" || !UUID_RE.test(actionId)) throw new RunActionInputError();
    const who = (await runnerPool.query<PrincipalRow>("SELECT * FROM run_action_perform_principal($1::uuid)", [actionId])).rows[0];
    if (!who || !who.allowed || who.user_id === null || who.principal_kind !== "session") return refused("principal_not_authorised");
    if (who.kind !== "continue_work_item") return refused("kind_mismatch");
    const { account_id: accountId, user_id: userId, target_id: itemId } = who;

    const f = await load(accountId, userId, itemId, actionId);
    // The definer proves membership only. Continuing starts spend on a click, so the caller must still be an owner or admin now.
    if (f.role !== "owner" && f.role !== "admin") return refused("principal_not_authorised");
    if (!f.item) return refused("target_not_found");

    // A replay (a double click, a second kick, a crash after the start): answered from the run this request already started. Nothing more is spent.
    if (f.own) {
      if (f.own.status === "refused_spend") return refused(f.park === "monthly_budget_reached" ? "monthly_budget_reached" : "spend");
      if (f.own.status === "cancelled") return refused("not_continuable");
      return finish(who, actionId, f.own.id, f.own.status);
    }

    if (CLOSED_STAGES.includes(f.item.stage)) return refused("work_item_closed");
    if (f.item.halted) return refused("work_item_halted");
    // Fail closed: anything not positively a limit park of an executor run is not continuable.
    if (f.item.stage !== "needs_human" || f.park === undefined || !LIMIT_PARKS.includes(f.park)) return refused("not_continuable");
    if (!f.latest || f.latest.role !== EXECUTOR_ROLE || !CONTINUABLE_STATUSES.includes(f.latest.status)) return refused("not_continuable");

    const input = await continuationStartInput({ pool: runnerPool, resolveRunSeat: deps.resolveRunSeat }, accountId, f.latest.id);
    if ("refused" in input) return refused(input.refused === "run_not_found" ? "target_not_found" : CODE_RE.test(input.refused) ? input.refused : "not_continuable");

    let result: ContinueAfterLimitResult;
    try {
      result = await continueWorkItem({ pool: runnerPool, registry }, { accountId, workItemId: itemId, requestId: actionId, resumeInput: input });
    } catch (err) {
      if (err instanceof WorkItemHaltedError) return refused("work_item_halted");
      if (err instanceof ExecutionModeChangedError) return refused("execution_mode_changed");
      throw err;
    }
    switch (result.outcome) {
      case "continued":
        return finish(who, actionId, result.resume.id, result.resume.status);
      case "duplicate": {
        // Another caller's continuation of this run is live or finished; this request's own key started nothing.
        const own = (await load(accountId, userId, itemId, actionId)).own;
        return own && own.status !== "refused_spend" && own.status !== "cancelled" ? finish(who, actionId, own.id, own.status) : refused("not_continuable");
      }
      case "busy":
        throw new ContinueBusyError();
      case "refused":
        return refused(result.reason);
      case "parked":
        if (result.reason === "monthly_budget_reached") return refused("monthly_budget_reached");
        return refused(result.refusedBy === "work_item_ceiling" || result.refusedBy === "spend" || result.refusedBy === "foreign_session" ? result.refusedBy : "not_continuable");
      default:
        return refused("not_continuable");
    }
  }

  /** The run exists. Move the item back to In progress (keyed on this request, so a replay is a no-op), then follow the run. */
  async function finish(who: PrincipalRow, actionId: string, runId: string, status: string): Promise<PerformResult> {
    const { account_id: accountId, user_id: userId, target_id: itemId } = who;
    const info = await withTenant(runnerPool, accountId, userId!, async (client) => {
      const item = (await client.query<{ stage: string; halt_epoch: number; halted: boolean }>("SELECT stage, halt_epoch, halted_at IS NOT NULL AS halted FROM work_items WHERE id = $1 AND account_id = $2 FOR UPDATE", [itemId, accountId])).rows[0];
      // Only an item still parked by a run limit moves (a replay finds it already moved, or moved on by the workflow, and leaves it). A halt since the start leaves it where it is.
      if (item?.stage === "needs_human" && !item.halted) {
        const park = (await client.query<{ reason: string | null }>("SELECT payload->>'reason' AS reason FROM domain_events WHERE account_id = $1 AND subject_id = $2 AND type = 'work_item.needs_human' ORDER BY seq DESC LIMIT 1", [accountId, itemId])).rows[0]?.reason;
        if (park && LIMIT_PARKS.includes(park)) await recordStage(client, { workItemId: itemId, toStage: "in_progress", at: new Date(), source: "control_plane", sourceRef: `continue:${actionId}`, runId });
      }
      const spec = (await client.query<{ version: number }>("SELECT sv.version FROM agent_runs r JOIN spec_versions sv ON sv.id = r.spec_version_id AND sv.account_id = r.account_id WHERE r.id = $1 AND r.account_id = $2", [runId, accountId])).rows[0];
      return { halted: item?.halted ?? true, haltEpoch: item?.halt_epoch ?? 0, specVersion: spec ? Number(spec.version) : null };
    });
    if (deps.startAdvance && !info.halted && !TERMINAL.includes(status)) {
      await deps.startAdvance({ accountId, userId: userId!, workItemId: itemId, actionId, haltEpoch: info.haltEpoch, specVersion: info.specVersion, resumeRunId: runId });
    }
    return { result: "done", outcome: { run_id: runId } };
  }

  return { performContinueWorkItem: (actionId) => guarded(() => perform(actionId)) };
}
