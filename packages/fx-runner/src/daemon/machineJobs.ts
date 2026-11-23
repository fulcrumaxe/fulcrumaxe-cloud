/**
 * D#845 ON-8c: the runner's side of machine jobs, the work the cloud asks of this machine to set a project up. One job at a time. A job is taken only after a claim reply said `machine_job`
 * (pollLoop), checked with `verifyMachineJob` against the keyring the build pins and this runner's own id (the same trust as a deploy order's or a run's signed job), and handed to the handler of
 * its kind. A kind with no handler is reported `failed` / `kind_unsupported`, which is what lets a later row add a kind by adding a handler and nothing else.
 *
 * THREAT MODEL. The adversary is a compromised cloud, or a job that is not what it says. At risk: this machine. A job that fails the signature, the runner, the expiry or the closed schema is dropped
 * and nothing is reported or run; nothing a job holds is used before it passes. A handler is given only the verified job and a reporter.
 *
 * The reporter sends one progress report per call with the next `seq`, and keeps the order the cloud relies on: the runner's own steps (`SETUP_RUNNER_STEPS`) are reported in their listed order,
 * never back, and the job ends when its last step is reported `ok` (the cloud closes it as `done`) or any step is reported `failed`. After that, or when the cloud says the job is no longer
 * running, `report` sends nothing and says `closed`, and the job's `signal` aborts so a handler stops working for a job the cloud has already ended.
 */
import { JobSignatureError, SETUP_FAILURE_REASON_PATTERN, SETUP_RUNNER_STEPS, verifyMachineJob, type ColdstartState, type JobKeyring, type MachineJob, type MachineJobKind, type MachineJobOf, type SetupProgressBody } from "@fulcrumaxe/runner-protocol";
import type { RunnerClient } from "./client.js";
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

export interface MachineJobContext<K extends MachineJobKind> {
  job: MachineJobOf<K>;
  reporter: StepReporter;
  /** Aborts when the daemon is stopping or the cloud ended this job. */
  signal: AbortSignal;
}
export type MachineJobHandler<K extends MachineJobKind> = (context: MachineJobContext<K>) => Promise<void>;
export type MachineJobHandlers = { [K in MachineJobKind]?: MachineJobHandler<K> };

export type MachineJobEvent = { event: "dropped"; code: string } | { event: "unsupported"; kind: MachineJobKind } | { event: "ended"; kind: MachineJobKind } | { event: "handler_error"; kind: MachineJobKind } | { event: "engine_mismatch"; kind: MachineJobKind };

export interface MachineJobDeps {
  client: Pick<RunnerClient, "machineJobClaim" | "setupProgress">;
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

export function createStepReporter(deps: Pick<MachineJobDeps, "client">, job: MachineJob, ended: AbortController): StepReporter {
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
      let result: ReportResult = "lost";
      for (let attempt = 0; attempt < REPORT_TRIES; attempt++) {
        const reply = await deps.client.setupProgress(job.setup_id, body);
        if (reply.kind === "recorded") result = "recorded";
        // The same number twice means the first try got through and only its answer was lost.
        else if (reply.kind === "refused" && reply.status === 409 && reply.code === "seq_not_increasing" && attempt > 0) result = "recorded";
        else if (reply.kind === "refused") {
          end();
          return "closed";
        } else continue;
        break;
      }
      if (body.state === "failed" || (body.state === "ok" && body.sub_step === LAST_RUNNER_STEP)) end();
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
        const reporter = createStepReporter(deps, job, ended);
        const handler = deps.handlers[job.kind] as MachineJobHandler<MachineJobKind> | undefined;
        try {
          if (engineRefusal(job.requires_engine === "microvm" ? "microvm" : undefined, deps.sandboxEngine()) !== undefined) {
            // Ruling 46: a job that needs a microVM is never run on another engine, whatever handler its kind has. A closed code, and nothing is started.
            log({ event: "engine_mismatch", kind: job.kind });
            await reporter.report({ sub_step: SETUP_RUNNER_STEPS[0], state: "failed", failure_code: "engine_unsupported", failure_reason: "engine_mismatch" });
          } else if (handler === undefined) {
            log({ event: "unsupported", kind: job.kind });
            await reporter.report({ sub_step: SETUP_RUNNER_STEPS[0], state: "failed", failure_code: "kind_unsupported" });
          } else {
            await handler({ job: job as never, reporter, signal: deps.signal === undefined ? ended.signal : AbortSignal.any([deps.signal, ended.signal]) });
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
