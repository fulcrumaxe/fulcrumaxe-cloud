import type { CleanEnvOptions, CredentialMode } from "./cleanEnv.js";
import { cleanEnv } from "./cleanEnv.js";
import { buildPrompt } from "./prompt.js";
import { jobHashRefusals, type HashCheckedJob, type HashRefusal } from "./verifyHashes.js";
import { cliModelNameFor, type Job, type NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import type { SandboxPort } from "../sandbox/port.js";
import { MODEL_HOST } from "../sandbox/sandboxSettings.js";
import type { WorkspaceStore } from "./workspace.js";

/** The job fields `runJob` reads. The daemon passes a job it has already verified (signature, expiry, repo visibility). */
export type RunnableJob = HashCheckedJob & Pick<Job, "job_id" | "run_id" | "continues" | "model_hint"> & { expires_at?: Job["expires_at"] };

/** Resume a session this machine still holds, in its workspace, or start fresh in a new workspace on `branch`. */
export type SessionPlan = { kind: "resume"; sessionId: string; workspace: string } | { kind: "fresh"; branch: string | null };

/**
 * Remembers which job ids this runner has started. `claim` is synchronous and answers true exactly once per id, so two
 * calls with the same id (a redelivery, a retry racing the first) cannot both start. `expiresAt` is the job's own expiry: a durable
 * ledger keeps the id until then, since a job past it is refused before it gets here.
 */
export interface JobLedger {
  claim(jobId: string, expiresAt?: string): boolean;
  /**
   * Whether the ledger holds this id. A `claim` that answered false for an id this says it does not hold was refused because the
   * ledger could not record it (a damaged file, a failed write), which is not a repeat of the job. Optional: a ledger without it is
   * taken to answer false only for repeats.
   */
  has?(jobId: string): boolean;
}

export function createMemoryLedger(): JobLedger {
  const seen = new Set<string>();
  return {
    claim(jobId) {
      if (seen.has(jobId)) return false;
      seen.add(jobId);
      return true;
    },
  };
}

export interface RunJobDeps {
  /** The only way an agent is started and stopped. The tier behind it is not this module's business. */
  sandbox: SandboxPort;
  workspaces: WorkspaceStore;
  ledger: JobLedger;
  credentials: CredentialMode;
  /** Must equal what the sandbox tier and the engine were given, or the tier refuses the job's environment. */
  envOptions?: CleanEnvOptions;
  /** Decides resume or fresh from the job's `continues` and this machine's own session index. */
  planSession: (continues: RunnableJob["continues"]) => SessionPlan;
  /** The CLI's `--model` value used when the job names no model. Passed through as given: the job's own `model_hint` is mapped, this is not. */
  defaultModel: string;
  /** Every event of the run, with model text: stays on this machine. */
  onEvent?: (event: NormalizedEvent) => void | Promise<void>;
  /** How long a job may run before it is stopped. Default 2 h. */
  wallClockMs?: number;
}

export const DEFAULT_WALL_CLOCK_MS = 2 * 60 * 60_000;
/** How long the sandbox outlives the wall clock, so this module's clock fires first. */
const SANDBOX_MARGIN_MS = 10 * 60_000;

export type FailureReason = "wall_clock" | "no_result" | "agent_error" | "agent_exit" | "sandbox_unavailable" | (string & {});

export type RunJobResult =
  | { status: "duplicate" }
  | { status: "refused"; reasons: HashRefusal[] }
  | { status: "done"; workspace: string; sessionId?: string; agentOutput?: Record<string, unknown> }
  | { status: "failed"; reason: FailureReason; workspace?: string };

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** A closed reason for a rejection: the error's own `code` when it is a plain snake_case word, else a generic one. */
function reasonOf(error: unknown): FailureReason {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CODE.test(code) ? code : "agent_exit";
}

/** The CLI `--model` name a job runs under: the default when it names none, else its price-table id mapped; `undefined` for an id the table lacks. */
export function cliModelFor(job: { model_hint: string | null }, defaultModel: string): string | undefined {
  return job.model_hint === null ? defaultModel : cliModelNameFor(job.model_hint);
}

/**
 * Runs one verified job and reports how it ended. One path for every tier: create a sandbox, start the agent in it, wait
 * for its hook raced against the wall clock, then stop and delete the sandbox on every exit. It knows an agent runtime
 * and a sandbox port and nothing about either one's kind.
 *
 *  - A job id seen before starts nothing (`duplicate`).
 *  - A job whose text or tool digest does not match is refused before a workspace or process exists.
 *  - With a session this machine still holds, the run resumes it in its workspace; otherwise it starts fresh in a new one.
 *    The workspace is left for the caller (it pushes the branch from it) unless the run never got as far as starting.
 */
export async function runJob(job: RunnableJob, deps: RunJobDeps): Promise<RunJobResult> {
  if (!deps.ledger.claim(job.job_id, job.expires_at)) return { status: "duplicate" };
  const reasons = jobHashRefusals(job);
  if (reasons.length > 0) return { status: "refused", reasons };

  // The job names its model by price-table id, which the CLI does not know. Map it, and refuse an id the table lacks before a workspace or process exists.
  const cliModel = cliModelFor(job, deps.defaultModel);
  if (cliModel === undefined) return { status: "failed", reason: "model_unsupported" };

  // The session index is a file on this machine: a recorded workspace that is not one of this store's own directories is never run in. Start fresh instead.
  const planned = deps.planSession(job.continues);
  const plan: SessionPlan = planned.kind === "resume" && !deps.workspaces.owns(planned.workspace) ? { kind: "fresh", branch: job.continues?.branch ?? null } : planned;
  const workspace = plan.kind === "resume" ? plan.workspace : await deps.workspaces.create(job.run_id);
  const wallClockMs = deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const start = {
    runId: job.run_id,
    role: job.role,
    roleCard: job.role_card.text,
    prompt: buildPrompt(job),
    model: cliModel,
    workdir: workspace,
    capUsd: 0, // the runner settles no money
    networkPolicy: [{ host: MODEL_HOST, purpose: "model" }],
    env: cleanEnv(deps.credentials, deps.envOptions),
    onEvent: deps.onEvent ?? (() => undefined),
  };

  let handle;
  try {
    handle = await deps.sandbox.createSandbox({ sandboxName: `rn-${job.run_id}`, retention: { persistent: false }, timeoutMs: wallClockMs + SANDBOX_MARGIN_MS });
  } catch (error) {
    // fx-swallow-ok: the failure is returned as a closed reason code; the error text could hold job content
    if (plan.kind === "fresh") await deps.workspaces.discard(workspace);
    return { status: "failed", reason: reasonOf(error) === "agent_exit" ? "sandbox_unavailable" : reasonOf(error) };
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const started = plan.kind === "resume" ? deps.sandbox.resume(handle, plan.sessionId, start.prompt, start) : deps.sandbox.startDetached(handle, start);
    started.hookFired.catch(noop); // if the clock wins, a later rejection is not an unhandled one
    const clock = new Promise<"wall_clock">((resolve) => {
      timer = setTimeout(() => resolve("wall_clock"), wallClockMs);
    });
    const ended = await Promise.race([started.hookFired, clock]);
    if (ended === "wall_clock") return { status: "failed", reason: "wall_clock", workspace };
    if (ended === undefined) return { status: "failed", reason: "no_result", workspace };
    if (ended.type !== "result") return { status: "failed", reason: "agent_error", workspace };
    return { status: "done", workspace, ...(ended.sessionId === undefined ? {} : { sessionId: ended.sessionId }), ...(ended.agentOutput === undefined ? {} : { agentOutput: ended.agentOutput }) };
  } catch (error) {
    // fx-swallow-ok: the failure is returned as a closed reason code; the error text could hold job content
    return { status: "failed", reason: reasonOf(error), workspace };
  } finally {
    clearTimeout(timer);
    await deps.sandbox.stop(handle).catch(noop);
    await deps.sandbox.deleteSandbox(handle).catch(noop);
  }
}

function noop(): void {
  // fx-swallow-ok: cleanup after a run must not replace the run's own result; a sandbox left behind is reaped by name
}
