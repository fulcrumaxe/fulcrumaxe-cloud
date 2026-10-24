import type { ContextAssembly, ContextSection, ContextSpill } from "@fx/runner";

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
  /**
   * D#598 P1f-5c: the commit a paired sandbox build starts from, recorded on the run (`head_sha`, fixed at insert). The publish step reads it as the
   * private base and refuses when it is missing. Set only for a paired sandbox executor run.
   */
  headSha?: string;
  /** D#600 CX-2: the prompt's sections (code, bytes, hash, trimmed bytes) from the assembler, stored on the run's context ledger. Absent: none recorded. */
  contextSections?: readonly ContextSection[];
  /** D#600 CX-10a: the cloud's assembly time for this prompt (and whether it built the repo map), stored on the run's context ledger. Absent: not recorded. */
  contextAssembly?: ContextAssembly;
  /** D#600 CX-4a: the files holding text the prompt cut (written to `/fx/context/<code>.md` before the agent starts) and the uncut prompt to use if one cannot be written. Sandbox runs only. */
  contextSpill?: ContextSpill;
  /** D#601 MEM-3: the token estimate of the memory in the prompt (0 when none was recalled), stored on the run's context ledger. Absent: not recorded. */
  memoryTokens?: number;
  /** D#601 MEM-3b: a runner run's recalled memory, split by who wrote it. It rides in the signed job and the prompt holds none of it. Absent: none, or not a runner run. */
  jobMemory?: { person: string; fenced: string };
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
  /** D#6 R2b-3: the end of the follow-up chain that starts at the run asked about; the run to cancel when the wait is abandoned. Absent: the run asked about. */
  tailRunId?: string;
}

export interface AdvanceRunPorts {
  /** Starts the run, or finds the one an earlier call of the same step started. A refusal is data, never a throw. */
  startRun(request: AdvanceRunRequest): Promise<AdvanceRunStart>;
  /**
   * D#597 CC-3: the run an earlier call of a step started, whatever pin its key carries: the full step (the prefix plus the pin) and the run's id. A
   * replay uses it to find its run again even when the notes accepted since would now give a different pin. Absent: no such lookup.
   */
  findStep?(stepPrefix: string): Promise<{ step: string; runId: string } | null>;
  /**
   * D#483 S5-k1e: the runs a panel seat's earlier asks started, whatever attempt they were: the steps shaped `<head>[:s<n>]<tail>` (the item's own prefix is the port's
   * business), each with its attempt number and the run's status, oldest first. A seat chooses its next key from this. Absent: every seat is a first ask.
   */
  startedAttempts?(head: string, tail: string): Promise<Array<{ attempt: number; status: string }>>;
  /**
   * D#483 S5-k1e: the read-only headroom check for a whole round: would a spending limit deny the seats of these roles if they were all started now? Writes no run
   * row. `{ ok: false, reason }` carries the denial's own name (`model_budget_exceeded`, ...). Absent: the round is not checked as a whole.
   */
  headroom?(roles: readonly string[]): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** How a run that does not exist reads as `{ status: "missing", done: true }`. */
  outcome(runId: string): Promise<AdvanceRunOutcome>;
  /** The existing cancel path (the same one the Cancel button uses). Safe on a finished run. */
  cancel(runId: string): Promise<void>;
}
