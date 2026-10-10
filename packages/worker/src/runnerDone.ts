import type { Pool, PoolClient } from "pg";
import { MAX_ENVELOPE_INPUT_BYTES, RUNNER_LEASE_SECONDS, SESSION_ID_PATTERN, redactDeep, type StopReason } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RUNNER_RUN_BRANCH, noteRunnerActivityCap, writeRunStatusOn, type FailureReason } from "@fx/runner";
import { guarded, RunActionInputError } from "./runActions.js";
import { leaseVerdict, requireLease, stopReasonFor, type HeartbeatRunnerRunInput } from "./runnerClaims.js";
import { runnerLimits, type RunnerLimitsSource } from "./runnerLimits.js";

/**
 * D#6 R2b-3f (C21 section 5, C12 section 5, C14 section 4): the `done` half of the runner lease facade on the `Worker`.
 *
 * `done` has to ask GitHub (is there a commit, are its paths in the Spec's scope, open the pull request), and a network call must
 * not sit inside the transaction that holds the run row's lock. So the facade is two writes around the route's GitHub work:
 *
 *   beginRunnerDone   the fence, once, with the lease extended by the lease length (the GitHub work may take a while, and the run must
 *                     still be the runner's when it ends). The answers are `proceed`, `fenced` (the stop reply) or `replay` (the run is
 *                     already finished by THIS runner's `done` at THIS generation, so the stored verdict is answered again).
 *   finishRunnerDone  the fence again, inside the write transaction, then the verdict: the status move through the one compare-and-set
 *                     writer, the session id in `cc_session_id` and the runner's `agentOutput`, redacted and byte-capped, in `envelope`.
 *                     All of it commits with the fence or not at all. If another `done` finished first, the answer is that one's
 *                     verdict (`replay`), so two concurrent attempts record once.
 *
 * Where the verdict lives: on the `run.status_changed` event the move writes (`viaRunnerDone`, `prNumber`, `branch`, `prHttpStatus`, and the
 * failure reason it already carries). The `branch` is the run branch the verdict was judged on, recorded next to `prNumber` (C25 section 1.2):
 * the job issuer reads it back as the branch a fix round continues, so the pull request is updated and never replaced. It is written in the same transaction as the move, so a stored verdict exists exactly when the
 * run is finished by `done`; a run finished any other way (the sweeper's `runner_lost`, a usage limit, a cancel) has none, and a `done`
 * for it is a stop. No column, so no migration.
 *
 * AUTHORITY WARNING, as for the other lease methods: `accountId` and `runnerId` MUST be the ones a verified runner request carries.
 * `verdict` is the cloud's own decision, made from GitHub and from our rows; nothing the runner sent decides it.
 */

/** The reasons a `done` can end a run `failed` with. All are `FailureReason`s (checked at compile time). */
export const DONE_FAILURE_REASONS = ["no_commit", "scope_unknown", "scope_violation", "pr_rejected", "internal_error", "taken_over"] as const satisfies readonly FailureReason[];
export type DoneFailureReason = (typeof DONE_FAILURE_REASONS)[number];

/** What the cloud decided about a run that sent `done`. */
export interface RunnerDoneVerdict {
  outcome: "succeeded" | "failed";
  /** Null exactly when `outcome` is `succeeded`. */
  failureReason: DoneFailureReason | null;
  /** The pull request the verdict is about; null when none exists. */
  prNumber: number | null;
  /** The run branch the verdict was judged on, recorded next to `prNumber` (C25 section 1.2): `fx/<run>-g<generation>` for a fresh run, a continuation's own branch otherwise. Set exactly when `prNumber` is. */
  branch?: string;
  /** The HTTP status GitHub refused the pull request with (`pr_rejected`); a number only. */
  prHttpStatus?: number;
  /** Why a `scope_unknown` ended the run, where that matters to the words shown: a renamed file, or a change type GitHub reported that the port does not know. */
  detail?: "renamed" | "unknown_change_type" | "no_file_list";
}

export interface FinishRunnerDoneInput extends HeartbeatRunnerRunInput {
  verdict: RunnerDoneVerdict;
  /** The Claude Code session the run ended in (already shape-checked by the protocol); stored in `cc_session_id`. */
  sessionId?: string;
  /** The runner's own output envelope: advisory, stored after redaction and capped in bytes. */
  agentOutput?: Record<string, unknown>;
}

export type BeginRunnerDoneResult = { kind: "proceed" } | { kind: "fenced"; reason: StopReason } | { kind: "replay"; verdict: RunnerDoneVerdict };
export type FinishRunnerDoneResult = { kind: "recorded"; verdict: RunnerDoneVerdict } | { kind: "fenced"; reason: StopReason } | { kind: "replay"; verdict: RunnerDoneVerdict };

export interface RunnerDoneFacade {
  /** Fences a runner's `done`, extends its lease, and says whether to go on, stop, or answer the stored verdict again. */
  beginRunnerDone(input: HeartbeatRunnerRunInput): Promise<BeginRunnerDoneResult>;
  /** Records the cloud's verdict for the run under the fence, in one transaction. */
  finishRunnerDone(input: FinishRunnerDoneInput): Promise<FinishRunnerDoneResult>;
}

export interface RunnerDoneDeps {
  /** Tests inject a fixed clock (milliseconds since the epoch). */
  now?: () => number;
  /** The wall-clock figure per account. Defaults to `runnerLimits`. */
  limits?: RunnerLimitsSource;
}

/** What is stored in place of an `agentOutput` that is over the byte cap once redacted. */
export const DROPPED_AGENT_OUTPUT = Object.freeze({ dropped: "too_large" });

const REASONS: ReadonlySet<string> = new Set(DONE_FAILURE_REASONS);

function requireVerdict(verdict: RunnerDoneVerdict): void {
  if (typeof verdict !== "object" || verdict === null) throw new RunActionInputError();
  const okReason = verdict.outcome === "succeeded" ? verdict.failureReason === null : verdict.outcome === "failed" && typeof verdict.failureReason === "string" && REASONS.has(verdict.failureReason);
  if (!okReason) throw new RunActionInputError();
  if (verdict.prNumber !== null && !(Number.isSafeInteger(verdict.prNumber) && verdict.prNumber >= 1)) throw new RunActionInputError();
  if (verdict.branch !== undefined && !(verdict.prNumber !== null && typeof verdict.branch === "string" && RUNNER_RUN_BRANCH.test(verdict.branch))) throw new RunActionInputError();
  if (verdict.prHttpStatus !== undefined && !(Number.isInteger(verdict.prHttpStatus) && verdict.prHttpStatus >= 100 && verdict.prHttpStatus <= 599)) throw new RunActionInputError();
  if (verdict.detail !== undefined && !((verdict.detail === "renamed" || verdict.detail === "unknown_change_type" || verdict.detail === "no_file_list") && verdict.failureReason === "scope_unknown")) throw new RunActionInputError();
}

/** The stored output: redacted (G2) first, then dropped whole if it is still over the cap in UTF-8 bytes. */
export function storedAgentOutput(agentOutput: Record<string, unknown>): Record<string, unknown> {
  const clean = redactDeep(agentOutput, []);
  return Buffer.byteLength(JSON.stringify(clean), "utf8") > MAX_ENVELOPE_INPUT_BYTES ? { ...DROPPED_AGENT_OUTPUT } : clean;
}

interface StoredRow {
  to: string;
  failureReason: string | null;
  prNumber: number | null;
  branch: string | null;
  prHttpStatus: number | null;
  detail: string | null;
}

/** The verdict a finished-by-`done` run stored, for this runner and generation; null when the run was finished some other way. */
async function storedVerdict(client: PoolClient, i: HeartbeatRunnerRunInput): Promise<RunnerDoneVerdict | null> {
  const { rows } = await client.query<{ payload: Record<string, unknown> }>(
    `SELECT e.payload
       FROM run_events e
       JOIN agent_runs a ON a.account_id = e.account_id AND a.id = e.run_id
      WHERE e.account_id = $1 AND e.run_id = $2 AND e.kind = 'run.status_changed' AND e.payload->>'viaRunnerDone' = 'true'
        AND a.runner_id = $3 AND a.lease_generation = $4 AND a.status IN ('succeeded', 'failed')
      ORDER BY e.seq DESC LIMIT 1`,
    [i.accountId, i.runId, i.runnerId, i.leaseGeneration],
  );
  const p = rows[0]?.payload as Partial<Record<keyof StoredRow, unknown>> | undefined;
  if (!p || (p.to !== "succeeded" && p.to !== "failed")) return null;
  const failureReason = typeof p.failureReason === "string" && REASONS.has(p.failureReason) ? (p.failureReason as DoneFailureReason) : null;
  if ((p.to === "succeeded") !== (failureReason === null)) return null;
  const prNumber = typeof p.prNumber === "number" && Number.isSafeInteger(p.prNumber) && p.prNumber >= 1 ? p.prNumber : null;
  return {
    outcome: p.to,
    failureReason,
    prNumber,
    ...(prNumber !== null && typeof p.branch === "string" && RUNNER_RUN_BRANCH.test(p.branch) ? { branch: p.branch } : {}),
    ...(typeof p.prHttpStatus === "number" ? { prHttpStatus: p.prHttpStatus } : {}),
    ...(p.detail === "renamed" || p.detail === "unknown_change_type" || p.detail === "no_file_list" ? { detail: p.detail } : {}),
  };
}

/** Package-internal: `runnerPool` is the runner login's pool and is captured here, never exposed. */
export function createRunnerDoneFacade(runnerPool: Pool, deps: RunnerDoneDeps = {}): RunnerDoneFacade {
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? runnerLimits;

  return {
    beginRunnerDone: (input) =>
      guarded(async () => {
        requireLease(input);
        const at = new Date(now());
        return withTenant(runnerPool, input.accountId, async (client): Promise<BeginRunnerDoneResult> => {
          const held = await leaseVerdict(client, input, at, RUNNER_LEASE_SECONDS, limits(input.accountId).maxRunWallClockMs);
          if (held === "ok") return { kind: "proceed" };
          if (held === "not_running") {
            const stored = await storedVerdict(client, input);
            if (stored) return { kind: "replay", verdict: stored };
          }
          return { kind: "fenced", reason: stopReasonFor(held) };
        });
      }),

    finishRunnerDone: (input) =>
      guarded(async () => {
        requireLease(input);
        requireVerdict(input.verdict);
        if (input.sessionId !== undefined && (typeof input.sessionId !== "string" || !SESSION_ID_PATTERN.test(input.sessionId))) throw new RunActionInputError();
        // A taken-over run stores no envelope (D#6 R4a-7): nothing the agent said before the owner stopped it can count as a result.
        const envelope = input.agentOutput === undefined || input.verdict.failureReason === "taken_over" ? undefined : storedAgentOutput(input.agentOutput);
        const at = new Date(now());
        return withTenant(runnerPool, input.accountId, async (client): Promise<FinishRunnerDoneResult> => {
          // Fenced again, in the transaction that writes: the lease may have ended while GitHub was being asked. The fence takes the run
          // row's lock, so a second `done` waits here and then finds the run finished.
          const held = await leaseVerdict(client, input, at, 0, limits(input.accountId).maxRunWallClockMs);
          if (held === "not_running") {
            const stored = await storedVerdict(client, input);
            return stored ? { kind: "replay", verdict: stored } : { kind: "fenced", reason: stopReasonFor(held) };
          }
          if (held !== "ok") return { kind: "fenced", reason: stopReasonFor(held) };
          const { verdict } = input;
          const moved = await writeRunStatusOn(client, {
            accountId: input.accountId,
            runId: input.runId,
            from: "running",
            to: verdict.outcome,
            ...(verdict.failureReason === null ? {} : { failureReason: verdict.failureReason }),
            runnerDone: { prNumber: verdict.prNumber, ...(verdict.branch === undefined ? {} : { branch: verdict.branch }), ...(verdict.prHttpStatus === undefined ? {} : { prHttpStatus: verdict.prHttpStatus }), ...(verdict.detail === undefined ? {} : { detail: verdict.detail }) },
            result: { ...(envelope === undefined ? {} : { envelope }), ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }) },
          });
          // Held under the row lock, so this is a defence: the run was running a statement ago.
          if (!moved.updated) return { kind: "fenced", reason: "run_terminal" };
          await noteRunnerActivityCap(client, { accountId: input.accountId, runId: input.runId });
          return { kind: "recorded", verdict };
        });
      }),
  };
}
