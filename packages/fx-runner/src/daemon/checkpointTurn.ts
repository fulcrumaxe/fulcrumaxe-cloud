/**
 * The one resume of a handed-off run (D#599 HO-3): after the agent's turn has been ended the way a take-over ends it, its session is resumed once, in
 * the same workspace, with the constant checkpoint prompt. The agent commits and writes the handoff note; the caller pushes. This module starts no
 * process but the one resume, sends nothing to the cloud, and keeps the note on this machine.
 */
import type { Job } from "@fulcrumaxe/runner-protocol";
import { CHECKPOINT_PROMPT, noteFromEnvelope, type CheckpointNote } from "../job/checkpoint.js";
import { cleanEnv, type CleanEnvOptions, type CredentialMode } from "../job/cleanEnv.js";
import { cliModelFor } from "../job/runJob.js";
import type { SandboxPort } from "../sandbox/port.js";
import { MODEL_HOST } from "../sandbox/sandboxSettings.js";

/** The sandbox outlives the turn's own limit by this much, so the limit fires first. */
const SANDBOX_MARGIN_MS = 60_000;

/**
 * The longest a checkpoint turn may run: the cloud's handoff window. The runner does not trust the cloud's deadline to be sane; a far-future one must
 * not set a long sandbox lifetime, and a delay above 2^31-1 ms would make Node's timer fire at once.
 */
export const CHECKPOINT_MAX_TURN_MS = 300_000;

export interface CheckpointTurnInput {
  job: Pick<Job, "run_id" | "role" | "role_card" | "model_hint"> & Partial<Pick<Job, "context_window">>;
  /** The port the run itself used (with the job's read grants and allowances), so the resume sees what the first turn saw. */
  sandbox: SandboxPort;
  credentials: CredentialMode;
  envOptions?: CleanEnvOptions | undefined;
  defaultModel: string;
  workspace: string;
  sessionId: string;
  /** Aborts the turn: the lease was lost, the daemon is stopping, or the time for it ran out. The sandbox is stopped at once. */
  signal: AbortSignal;
  /** The most the sandbox may live, in ms, before the margin; capped at `CHECKPOINT_MAX_TURN_MS`. */
  limitMs: number;
}

/** `finished`: the agent ended its turn before the signal. `note`: what it wrote, cleaned and capped; undefined when it wrote none. */
export interface CheckpointTurnResult {
  finished: boolean;
  note?: CheckpointNote;
}

export async function runCheckpointTurn(input: CheckpointTurnInput): Promise<CheckpointTurnResult> {
  const { job, sandbox, signal } = input;
  const model = cliModelFor(job, input.defaultModel);
  if (model === undefined || signal.aborted) return { finished: false };
  const start = {
    runId: job.run_id,
    role: job.role,
    roleCard: job.role_card.text,
    prompt: CHECKPOINT_PROMPT,
    model,
    workdir: input.workspace,
    ...(job.context_window === undefined ? {} : { contextWindowTokens: job.context_window }),
    capUsd: 0, // the runner settles no money
    networkPolicy: [{ host: MODEL_HOST, purpose: "model" }],
    env: cleanEnv(input.credentials, input.envOptions),
    onEvent: () => undefined,
  };
  let handle;
  try {
    handle = await sandbox.createSandbox({ sandboxName: `rn-${job.run_id}-ck`, retention: { persistent: false }, timeoutMs: Math.min(input.limitMs, CHECKPOINT_MAX_TURN_MS) + SANDBOX_MARGIN_MS });
  } catch {
    // fx-swallow-ok: no sandbox for the turn means no note; the caller still pushes what is committed, and the error text could hold job content
    return { finished: false };
  }
  try {
    const started = sandbox.resume(handle, input.sessionId, CHECKPOINT_PROMPT, start);
    started.hookFired.catch(noop);
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal.aborted) resolve("aborted");
      else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const ended = await Promise.race([started.hookFired, aborted]);
    if (ended === "aborted") return { finished: false };
    const note = ended?.type === "result" ? noteFromEnvelope(ended.agentOutput) : undefined;
    return { finished: true, ...(note === undefined ? {} : { note }) };
  } catch {
    // fx-swallow-ok: a turn that failed to run leaves no note; the failure is not reported as text
    return { finished: false };
  } finally {
    await sandbox.stop(handle).catch(noop);
    await sandbox.deleteSandbox(handle).catch(noop);
  }
}

function noop(): void {
  // fx-swallow-ok: cleanup after the turn must not replace its result
}
