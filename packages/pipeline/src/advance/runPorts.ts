/**
 * D#483 P2: what the stage driver's pipeline steps may do with agent runs. The worker (which owns the runner pool and
 * knows the account and the work item) implements these over its run starter; this package never sees the pool that
 * starts a run. All three are plain data in and out, so a step runs in a test over an in-memory fake.
 *
 * The account and the work item are bound by whoever builds the ports, never taken from the request: a step cannot
 * start a run for another item.
 */
export interface AdvanceRunRequest {
  /** Names the step. The run's idempotency key is built from it, so a replayed step returns the SAME run and never a second one. */
  step: string;
  /** The role card the run uses. */
  role: string;
  prompt: string;
  /** Clone the item's repository into the run's working directory before the agent starts. */
  clone: boolean;
  /** Executor runs only: names the sandbox. The pull request does not exist yet, so this is the issue's number. */
  pr?: number;
  /** Start only if no OTHER run of the item is live (this step's own keyed run is always returned). Refused as `already_running`. */
  exclusive?: boolean;
  /**
   * D#6 R4d-1 (C32): the repository's `execution_mode` the prompt was built for. The start refuses `execution_mode_changed` when the
   * repository's mode is different when the run is started, so a sandbox prompt never reaches a runner and a runner prompt never
   * reaches a sandbox. Absent: no check (a prompt that does not depend on the mode).
   */
  expectedExecutionMode?: string;
  /**
   * D#6 R4d-5a (C34): the `spec_versions.id` the run is built from. The executor build sets it, so the run is held at done to the file list of exactly the Spec
   * version it was started from. Absent: the run pins no version.
   */
  specVersionId?: string;
}

export type AdvanceRunStart = { ok: true; runId: string } | { ok: false; reason: string };

export interface AdvanceRunOutcome {
  status: string;
  done: boolean;
  /** The run's parsed AGENT_OUTPUT envelope, or null. Model text: untrusted. */
  envelope: Record<string, unknown> | null;
  /** Where the run executes. Only a `runner` run's `pending` time is credited to a wait (D#6 C12 A3). Absent when unknown. */
  runtime?: string;
  /**
   * D#6 C29: for a run that has left `pending`, how long ago (milliseconds, on the database's clock) it did, read from the run's own
   * `started_at`. Null or absent for a run still pending or whose record has none. A step that is called again uses it so a wait
   * budget counts the time the run has really been working, not the time since this call began.
   */
  runningMs?: number | null;
}

export interface AdvanceRunPorts {
  /** Starts the run, or finds the one an earlier call of the same step started. A refusal is data, never a throw. */
  startRun(request: AdvanceRunRequest): Promise<AdvanceRunStart>;
  /** How a run stands. A run that does not exist reads as `{ status: "missing", done: true }`. */
  outcome(runId: string): Promise<AdvanceRunOutcome>;
  /** The existing cancel path (the same one the Cancel button uses). Safe on a finished run. */
  cancel(runId: string): Promise<void>;
}
