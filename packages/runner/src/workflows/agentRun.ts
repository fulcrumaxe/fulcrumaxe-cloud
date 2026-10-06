import type { Pool } from "pg";
import { sleep } from "workflow";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { resolveExecutionTarget, type ExecutionRun, type ExecutionTargetRegistry, type HookResult } from "../executionTarget.js";
import type { HookWaitPort } from "../hookChannel.js";
import { failClosedOnQueued, startAgentRun, type StartAgentRunInput, type StartAgentRunResult } from "../startAgentRun.js";
import { writeRunStatus } from "../runStatusWriter.js";
import type { RunStatus } from "../statusTransitions.js";
import type { Product, Role } from "../types.js";

/**
 * D#2 H09b2-wf, reshaped by H14c-3-3a-3 (P2/P3): the "use workflow" orchestrator and its "use step" functions.
 *
 * **Serializable signature (criterion 4).** `agentRunWorkflow(input, watchdogMs)` takes plain data. The pool, the
 * target registry and (in tests) the hook wait port are reached through the module-level wiring below, which the
 * worker's composition root sets once (`configureAgentRunWiring`); a step never takes one as an argument.
 *
 * **Input is NOT ids-only yet (follow-up WORKFLOW-INPUT-IDS).** `agentRunWorkflow` takes the whole start input, prompt and
 * role card included, because `dispatchStep` starts the run from it. This file is not compiled as a workflow today and
 * nothing may use it as one: a real workflow's arguments land in the Workflow service's event log. Before it is, its
 * input must shrink to ids (runId, accountId, watchdogMs) with the rest loaded server-side. A test pins that no other
 * source mentions it.
 *
 * **The target finalizes; the hook is a wake-up.** `SandboxTarget` now finalizes a finished run itself, in the
 * process that holds its output recorder, meter total and measurement, and only then resumes the hook with
 * `{ runId, status }`. So nothing here finalizes: after the hook (or the watchdog) the workflow READS the run's
 * status, which is the durable record, and acts only on a watchdog that fires on a run still `running`.
 *
 * This file's directives are not compiled by the app build (the Workflow builder only compiles apps/web), and the
 * real follower is apps/web/workflows/agentRunFollow.ts, which calls the plain bodies exported at the bottom.
 * `@workflow/vitest` needs vitest >= 3.1 and this repo pins 2.x, so the workflow's race is tested through the
 * steps with a fake `sleep`, as before.
 */

export interface AgentRunWiring {
  pool: Pool;
  registry: ExecutionTargetRegistry;
  /** Tests only: the in-memory side of the hook. Production's wait is a workflow-level hook in apps/web. */
  hookWait?: HookWaitPort;
}
let wiring: AgentRunWiring | undefined;
/** Called by the worker's composition root (and by tests). A later call replaces the earlier one. */
export function configureAgentRunWiring(next: AgentRunWiring | undefined): void {
  wiring = next;
}
function wired(): AgentRunWiring {
  if (!wiring) throw new Error("agentRun: not wired (configureAgentRunWiring was not called)");
  return wiring;
}

export type RunAgentRunWorkflowResult = {
  id: string;
  /** The run's status as the database has it when the workflow ends. */
  status: RunStatus;
  /** Present only on the watchdog-timeout path (pass/fail 7). */
  hookTimedOut?: true;
};

/** `"use step"`: dispatch. A thin call-through to `startAgentRun`. */
export async function dispatchStep(input: StartAgentRunInput): Promise<StartAgentRunResult> {
  "use step";
  const { pool, registry } = wired();
  // A queued runner run has no hook to wait on: cancel it and fail, never carry on as if it had started.
  return failClosedOnQueued(pool, input.accountId, await startAgentRun(pool, registry, input));
}

/** `"use step"`: the hook-wait leg (tests only; production waits on a workflow-level hook). */
export async function hookWaitStep(hookToken: string): Promise<HookResult> {
  "use step";
  const { hookWait } = wired();
  if (!hookWait) throw new Error("agentRun: no hook wait wired");
  return hookWait.wait(hookToken);
}

/** `"use step"`: the watchdog-timeout write, the SAME compare-and-set the queue-TTL path uses one level up. */
export async function timeoutStep(accountId: string, runId: string): Promise<{ updated: boolean; currentStatus?: RunStatus }> {
  "use step";
  return writeRunStatus(wired().pool, { accountId, runId, from: "running", to: "timed_out" });
}

/**
 * `"use step"`: the run's current status, read tenant-scoped. This is the durable record: the terminal status row
 * the target's finalize wrote. A run cancelled out of band while the workflow was parked is already `cancelled`.
 */
export async function runStatusStep(accountId: string, runId: string): Promise<RunStatus | undefined> {
  "use step";
  return withTenant(wired().pool, accountId, async (client) => {
    const { rows } = await client.query<{ status: RunStatus }>("SELECT status FROM agent_runs WHERE account_id = $1 AND id = $2", [accountId, runId]);
    return rows[0]?.status;
  });
}

interface FollowRunRow {
  role: Role;
  product: Product | null;
  execution_mode: string | null;
  dispatch_repo_id: string | null;
  dispatch_pr_number: string | null;
}

/**
 * `"use step"`: cancel on the run's own target. The run is rebuilt from `agent_runs` the way `cancelRun` does (the
 * persisted dispatch identity; dispatch-time inputs `cancel` never reads are placeholders). A run whose mode is not
 * persisted or not registered is left to the caller's other safety nets.
 */
export async function cancelStep(accountId: string, runId: string): Promise<void> {
  "use step";
  const rebuilt = await rebuildRun(accountId, runId);
  if (rebuilt) await resolveExecutionTarget(rebuilt.mode, wired().registry).cancel(rebuilt.run);
}

/** The run rebuilt from `agent_runs` the way `cancelRun` does it, with its persisted execution mode; undefined when the mode is not persisted. */
async function rebuildRun(accountId: string, runId: string): Promise<{ run: ExecutionRun; mode: string } | undefined> {
  const row = await withTenant(wired().pool, accountId, async (client) => {
    const { rows } = await client.query<FollowRunRow>(
      `SELECT ar.role, r.product, ar.execution_mode, ar.dispatch_repo_id, ar.dispatch_pr_number::text AS dispatch_pr_number
         FROM agent_runs ar LEFT JOIN repos r ON r.account_id = ar.account_id AND r.id = ar.dispatch_repo_id
        WHERE ar.account_id = $1 AND ar.id = $2`,
      [accountId, runId],
    );
    return rows[0];
  });
  if (!row?.execution_mode) return undefined;
  const run: ExecutionRun = {
    id: runId,
    accountId,
    role: row.role,
    product: row.product ?? "team",
    repoId: row.dispatch_repo_id ?? undefined,
    pr: row.dispatch_pr_number ? Number(row.dispatch_pr_number) : undefined,
    roleCard: "",
    prompt: "",
    model: "",
    capUsd: 0,
    spend: { plan: "starter" },
  };
  return { run, mode: row.execution_mode };
}

/**
 * `"use step"`: the lost-run check for a run the follower sees as still `running`. Asks the run's target whether its
 * compute is gone (the sandbox stopped or deleted from outside) and settles it as failed if so. Changes nothing while the
 * sandbox is running or the provider cannot answer. Returns the status afterwards, the durable record.
 */
export async function settleLostStep(accountId: string, runId: string): Promise<RunStatus | undefined> {
  "use step";
  const rebuilt = await rebuildRun(accountId, runId);
  if (rebuilt) await resolveExecutionTarget(rebuilt.mode, wired().registry).settleIfLost?.(rebuilt.run);
  return runStatusStep(accountId, runId);
}

/** What the follower's status step reports: the status and whether the run is over (fixed fields; no text). */
export interface FollowStatus {
  status: RunStatus | "unknown";
  done: boolean;
}

/**
 * For the follower in apps/web: the run's status, and whether it has left `pending`/`running`. A run that is still
 * `running` is checked for lost compute (its sandbox stopped or deleted from outside) and settled if so, so the follower
 * sees it end at its next look instead of polling a dead run to the full watchdog.
 */
export async function followStatusBody(accountId: string, runId: string): Promise<FollowStatus> {
  let status = await runStatusStep(accountId, runId);
  if (status === "running") status = (await settleLostStep(accountId, runId)) ?? status;
  return { status: status ?? "unknown", done: status !== undefined && status !== "pending" && status !== "running" };
}

/** For the follower in apps/web: the watchdog fired. Time the run out (compare-and-set from `running`), then stop its sandbox. */
export async function followTimeoutBody(accountId: string, runId: string): Promise<FollowStatus> {
  const write = await timeoutStep(accountId, runId);
  await cancelStep(accountId, runId);
  const status = write.updated ? "timed_out" : (write.currentStatus ?? "unknown");
  return { status, done: true };
}

/** `"use workflow"`: the thin orchestrator. Arguments are plain data. */
export async function agentRunWorkflow(input: StartAgentRunInput, watchdogMs: number): Promise<RunAgentRunWorkflowResult> {
  "use workflow";

  const started = await dispatchStep(input);
  if (started.status !== "running") {
    return { id: started.id, status: started.status };
  }

  const raced = await Promise.race<{ timedOut: true } | { timedOut: false; result: HookResult }>([
    hookWaitStep(started.hookToken).then((result) => ({ timedOut: false as const, result })),
    sleep(watchdogMs).then(() => ({ timedOut: true as const })),
  ]);

  const status = await runStatusStep(input.accountId, started.id);
  // Cancelled while parked: nothing is left to time out or stop.
  if (status === "cancelled") return { id: started.id, status, ...(raced.timedOut ? { hookTimedOut: true as const } : {}) };

  if (raced.timedOut) {
    const out = await followTimeoutBody(input.accountId, started.id);
    return { id: started.id, status: out.status === "unknown" ? "cancelled" : out.status, hookTimedOut: true };
  }
  // The hook says the target finalized; the status row is the record. Another run's id is not accepted.
  if (raced.result.runId !== started.id) throw new Error("agentRun: the hook answered for a different run");
  return { id: started.id, status: status ?? "failed" };
}
