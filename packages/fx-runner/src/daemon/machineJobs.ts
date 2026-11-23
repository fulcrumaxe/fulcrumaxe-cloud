/**
 * D#845 ON-8c: the runner's side of machine jobs, the work the cloud asks of this machine to set a project up. One job at a time. A job is taken only after a claim reply said `machine_job`
 * (pollLoop), checked with `verifyMachineJob` against the keyring the build pins and this runner's own id (the same trust as a deploy order's or a run's signed job), and handed to the handler of
 * its kind. A kind with no handler is reported `failed` / `kind_unsupported`, which is what lets a later row add a kind by adding a handler and nothing else.
 *
 * THREAT MODEL. The adversary is a compromised cloud, or a job that is not what it says. At risk: this machine. A job that fails the signature, the runner, the expiry or the closed schema is dropped
 * and nothing is reported or run; nothing a job holds is used before it passes. A handler is given only the verified job and a reporter.
 *
 * (A session kind reports through `createSessionReporter` instead, on the machine-job route.) The reporter sends one progress report per call with the next `seq`, and keeps the order the cloud relies on: the runner's own steps (`SETUP_RUNNER_STEPS`) are reported in their listed order,
 * never back, and the job ends when its last step is reported `ok` (the cloud closes it as `done`) or any step is reported `failed`. After that, or when the cloud says the job is no longer
 * running, `report` sends nothing and says `closed`, and the job's `signal` aborts so a handler stops working for a job the cloud has already ended.
 */
import { JobSignatureError, SESSION_JOB_STEP_ORDER, SETUP_FAILURE_REASON_PATTERN, SETUP_RUNNER_STEPS, verifyMachineJob, type ColdstartState, type JobKeyring, type MachineJob, type MachineJobKind, type MachineJobOf, type SessionJobKind, type SessionJobProgressBody, type SetupProgressBody } from "@fulcrumaxe/runner-protocol";
import type { RunnerClient, SetupProgressResult } from "./client.js";
import { engineRefusal } from "../vm/engineGate.js";
import type { SandboxEngine } from "../vm/limits.js";

export const LAST_RUNNER_STEP = SETUP_RUNNER_STEPS[SETUP_RUNNER_STEPS.length - 1];
/** Tries for one report that got no answer (the cloud treats the second try at one `seq` as already recorded). */
const REPORT_TRIES = 3;

type SubStep = SetupProgressBody["sub_step"];
export interface Step {
  sub_step: SubStep;
  state: ColdstartState;
  failure_code?: SetupProgressBody["failure_code"];
  failure_reason?: string;
  bundle_bytes?: number;
}
/** `recorded`: the cloud has it. `lost`: no answer after the tries (the job goes on). `closed`: the job is over, nothing was sent. */
export type ReportResult = "recorded" | "lost" | "closed";

export interface StepReporter {
  report(step: Step): Promise<ReportResult>;
  readonly closed: boolean;
}

/** D#845 ON-13a1: one report of a session job (`SessionJobProgressBody` without its `seq`, which the reporter numbers). */
export interface SessionStep {
  step: SessionJobProgressBody["step"];
  state: SessionJobProgressBody["state"];
  failure_code?: SessionJobProgressBody["failure_code"];
  failure_reason?: string;
  start_mode?: SessionJobProgressBody["start_mode"];
}
export interface SessionReporter {
  report(step: SessionStep): Promise<ReportResult>;
  readonly closed: boolean;
}

export const SESSION_KINDS: readonly SessionJobKind[] = ["engine_session_start", "engine_session_stop", "engine_session_delete"];
export const isSessionKind = (kind: MachineJobKind): kind is SessionJobKind => (SESSION_KINDS as readonly string[]).includes(kind);

export interface MachineJobContext<K extends MachineJobKind> {
  job: MachineJobOf<K>;
  /** A session kind reports through the machine-job route by its own steps; every other kind through its setup. */
  reporter: K extends SessionJobKind ? SessionReporter : StepReporter;
  /** Aborts when the daemon is stopping or the cloud ended this job. */
  signal: AbortSignal;
}
export type MachineJobHandler<K extends MachineJobKind> = (context: MachineJobContext<K>) => Promise<void>;
export type MachineJobHandlers = { [K in MachineJobKind]?: MachineJobHandler<K> };

export type MachineJobEvent = { event: "dropped"; code: string } | { event: "unsupported"; kind: MachineJobKind } | { event: "ended"; kind: MachineJobKind } | { event: "handler_error"; kind: MachineJobKind } | { event: "engine_mismatch"; kind: MachineJobKind };

export interface MachineJobDeps {
  client: Pick<RunnerClient, "machineJobClaim" | "setupProgress" | "machineJobProgress">;
  keyring: JobKeyring;
  runnerId: string;
  now: () => Date;
  handlers: MachineJobHandlers;
  /** The engine this runner runs jobs in, read fresh for each job (see `effectiveEngine`). A job that requires a microVM is refused on any other. */
  sandboxEngine: () => SandboxEngine;
  /** The daemon's stop signal. */
  signal?: AbortSignal;
  log?: (event: MachineJobEvent) => void;
}

export interface MachineJobDispatcher {
  /** Takes one job if one waits and works it to its end. `none` when nothing was taken (including while a job is already in hand). */
  run(): Promise<"handled" | "none">;
  /** How many `project_setup` jobs are in hand now (0 or 1): the host load's `setups_running`. */
  setupsRunning(): number;
}

/** A microVM job needs both the engine this run chose (`chooseEngine`: the machine's line and a wired microVM sandbox) and the person's setting to be microvm, the same two facts the run jobs' gate reads. Anything else is `os_sandbox`. */
export function effectiveEngine(chosen: SandboxEngine, setting: string | undefined): SandboxEngine {
  return chosen === "microvm" && setting === "microvm" ? "microvm" : "os_sandbox";
}

/**
 * One report, sent up to `REPORT_TRIES` times: `recorded` once the cloud has it (a second try the cloud calls "not above the last" counts, the first got through), `refused` when the cloud says the
 * job is over, `lost` when nothing answered.
 */
async function sendWithRetry(call: () => Promise<SetupProgressResult>): Promise<ReportResult | "refused"> {
  for (let attempt = 0; attempt < REPORT_TRIES; attempt++) {
    const reply = await call();
    if (reply.kind === "recorded") return "recorded";
    // The same number twice means the first try got through and only its answer was lost.
    if (reply.kind === "refused" && reply.status === 409 && reply.code === "seq_not_increasing" && attempt > 0) return "recorded";
    if (reply.kind === "refused") return "refused";
  }
  return "lost";
}

export function createStepReporter(deps: { client: Pick<RunnerClient, "setupProgress"> }, job: MachineJob, ended: AbortController): StepReporter {
  let seq = 0;
  let highest = -1;
  let closed = false;
  const end = (): void => {
    closed = true;
    ended.abort();
  };
  return {
    get closed() {
      return closed;
    },
    async report(step) {
      if (closed || job.setup_id === undefined) return "closed";
      if (step.failure_reason !== undefined && !SETUP_FAILURE_REASON_PATTERN.test(step.failure_reason)) throw new Error("failure_reason");
      const at = (SETUP_RUNNER_STEPS as readonly string[]).indexOf(step.sub_step);
      if (at >= 0) {
        // The runner's own steps go in their listed order; a handler that goes back is a bug here and is stopped, not sent on.
        if (at < highest) throw new Error("step_order");
        highest = at;
      }
      const body: SetupProgressBody = { job_id: job.job_id, seq: seq++, sub_step: step.sub_step, state: step.state, ...(step.failure_code === undefined ? {} : { failure_code: step.failure_code }), ...(step.failure_reason === undefined ? {} : { failure_reason: step.failure_reason }), ...(step.bundle_bytes === undefined ? {} : { bundle_bytes: step.bundle_bytes }) };
      const result = await sendWithRetry(() => deps.client.setupProgress(job.setup_id as string, body));
      if (result === "refused") {
        end();
        return "closed";
      }
      if (body.state === "failed" || (body.state === "ok" && body.sub_step === LAST_RUNNER_STEP)) end();
      return result;
    },
  };
}

/**
 * D#845 ON-13a1: the reporter of a session job. It sends on the machine-job route by the signed `job_id` (a session job has no setup), numbers from 0, and keeps the order the cloud's definer fences: a step
 * of the kind's own list (`SESSION_JOB_STEP_ORDER`), never back (it may skip one). The job ends on a `failed` report or on `done` `ok`, which is where a start ends too: the session outlives the job, so the
 * runner's one job slot is free for the next stop. A start's `done` `ok` carries its `start_mode` and no other report does.
 */
export function createSessionReporter(deps: { client: Pick<RunnerClient, "machineJobProgress"> }, job: MachineJobOf<SessionJobKind>, ended: AbortController): SessionReporter {
  const order = SESSION_JOB_STEP_ORDER[job.kind] as readonly string[];
  let seq = 0;
  let highest = -1;
  let closed = false;
  const end = (): void => {
    closed = true;
    ended.abort();
  };
  return {
    get closed() {
      return closed;
    },
    async report(step) {
      if (closed) return "closed";
      if (step.failure_reason !== undefined && !SETUP_FAILURE_REASON_PATTERN.test(step.failure_reason)) throw new Error("failure_reason");
      const at = order.indexOf(step.step);
      if (at < 0 || at < highest) throw new Error("step_order");
      const finishing = step.step === "done" && step.state === "ok";
      if ((step.start_mode !== undefined) !== (finishing && job.kind === "engine_session_start")) throw new Error("start_mode");
      highest = at;
      const body: SessionJobProgressBody = { seq: seq++, step: step.step, state: step.state, ...(step.failure_code === undefined ? {} : { failure_code: step.failure_code }), ...(step.failure_reason === undefined ? {} : { failure_reason: step.failure_reason }), ...(step.start_mode === undefined ? {} : { start_mode: step.start_mode }) };
      const result = await sendWithRetry(() => deps.client.machineJobProgress(job.job_id, body));
      if (result === "refused") {
        end();
        return "closed";
      }
      if (body.state === "failed" || finishing) end();
      return result;
    },
  };
}

export function createMachineJobDispatcher(deps: MachineJobDeps): MachineJobDispatcher {
  const log = deps.log ?? (() => undefined);
  let active: MachineJobKind | undefined;
  let busy = false;
  return {
    setupsRunning: () => (active === "project_setup" ? 1 : 0),
    async run() {
      if (busy || deps.signal?.aborted === true) return "none";
      busy = true;
      try {
        const claimed = await deps.client.machineJobClaim();
        if (claimed.kind !== "job") return "none";
        let job: MachineJob;
        try {
          job = verifyMachineJob(claimed.signedJob, deps.keyring, deps.runnerId, deps.now());
        } catch (error) {
          // fx-swallow-ok: only the closed code is logged. A job that does not verify is nothing this runner may act on or answer: it is dropped, and the cloud lets it expire. Only the closed code is logged.
          log({ event: "dropped", code: error instanceof JobSignatureError ? error.code : "malformed" });
          return "handled";
        }
        active = job.kind;
        const ended = new AbortController();
        const reporter = isSessionKind(job.kind) ? createSessionReporter(deps, job as MachineJobOf<SessionJobKind>, ended) : createStepReporter(deps, job, ended);
        const handler = deps.handlers[job.kind] as MachineJobHandler<MachineJobKind> | undefined;
        /** The dispatcher's own refusals go on the kind's first step: `admission` for a session kind, the first runner step of a setup. */
        const refuse = (failure_code: "engine_unsupported" | "kind_unsupported", failure_reason?: string): Promise<ReportResult> =>
          isSessionKind(job.kind)
            ? (reporter as SessionReporter).report({ step: SESSION_JOB_STEP_ORDER[job.kind][0], state: "failed", failure_code, ...(failure_reason === undefined ? {} : { failure_reason }) })
            : (reporter as StepReporter).report({ sub_step: SETUP_RUNNER_STEPS[0], state: "failed", failure_code, ...(failure_reason === undefined ? {} : { failure_reason }) });
        try {
          if (engineRefusal(job.requires_engine === "microvm" ? "microvm" : undefined, deps.sandboxEngine()) !== undefined) {
            // Ruling 46: a job that needs a microVM is never run on another engine, whatever handler its kind has. A closed code, and nothing is started.
            log({ event: "engine_mismatch", kind: job.kind });
            await refuse("engine_unsupported", "engine_mismatch");
          } else if (handler === undefined) {
            log({ event: "unsupported", kind: job.kind });
            await refuse("kind_unsupported");
          } else {
            await handler({ job: job as never, reporter: reporter as never, signal: deps.signal === undefined ? ended.signal : AbortSignal.any([deps.signal, ended.signal]) });
          }
        } catch {
          // fx-swallow-ok: a handler's own error text could hold job content; one closed event is logged and the cloud lets the job expire
          log({ event: "handler_error", kind: job.kind });
        }
        log({ event: "ended", kind: job.kind });
        return "handled";
      } finally {
        active = undefined;
        busy = false;
      }
    },
  };
}
