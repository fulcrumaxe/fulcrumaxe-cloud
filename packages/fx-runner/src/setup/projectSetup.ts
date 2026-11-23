/**
 * D#845 ON-8d: the `project_setup` handler, coldstart in a microVM. After the ON-8c preparation (`prepareProjectSetup`: engine archive and plan, checked on the host) `runVmJob` runs:
 *   sandbox_boot -> workspace_in -> bootstrap -> [the engine's coldstart steps, one report per status line] -> finalize -> bundle_out
 * No model credential enters the guest (`needsToken: false`) and there is no check VM, so the job makes one VM, under the closed `project_setup` egress put in force before anything is sent. The repository goes in through
 * `sendWorkspace`, the engine and plan files through `sendSetupInputs`; only a git bundle comes out (`pullBundle`), and `applyBundle` checks it with the setup's bundle policy before it touches the host copy. A refusal ends the
 * job `bundle_refused` with its reason; nothing is pushed. Every step is reported in order through the ON-8c reporter, and the first failed report ends the job. The success path ends with `bundle_out` `ok`: `push`,
 * `pr_open` and `gh_labels` (the job's final step) are ON-8f's. The guest's text goes to a local 0600 log (at most 1 MiB), never sent; only the status stream is read live.
 */
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { SETUP_FAILURE_CODES, SETUP_FAILURE_REASON_PATTERN, SETUP_RUNNER_STEPS, type MachineJobOf, type SetupProgressBody } from "@fulcrumaxe/runner-protocol";
import type { RunnerClient } from "../daemon/client.js";
import type { JobHandlerDeps } from "../daemon/jobHandler.js";
import type { MachineJobHandler, StepReporter } from "../daemon/machineJobs.js";
import type { AppliedBundle } from "../daemon/vmBundle.js";
import type { SandboxHandle } from "../sandbox/port.js";
import { runVmJob, StepRefusal, type VmJobOutcome } from "../vm/jobLifecycle.js";
import { pullBundle } from "../vm/workspace/bundleOut.js";
import { DEFAULT_GUEST_PATHS, GuestWorkspaceError, sendWorkspace, type GuestPaths, type WorkspaceArchive } from "../vm/workspace/guestWorkspace.js";
import type { EngineTransport } from "./engineArchive.js";
import { BOOTSTRAP, COLDSTART, FINALIZE, MERGE_PROGRAM, runSetupCommand, sendSetupInputs, SetupGuestError } from "./guestScripts.js";
import { prepareProjectSetup, type Prepared } from "./prepare.js";
import { bundleReasonOf, projectSetupPolicy } from "./setupPolicy.js";
import { createStatusReader } from "./statusStream.js";

/** The runner's host copy of the repository at the job's `base_sha`: the mirror its objects come from, a work tree at that commit (the bundle is applied to it) and the archive that goes into the guest. */
export interface SetupRepoCopy {
  mirrorDir: string;
  workspace: string;
  archive: WorkspaceArchive;
  release(): Promise<void>;
}
export interface SetupRepos {
  open(input: { repoId: number; owner: string; name: string; baseSha: string; signal: AbortSignal }): Promise<SetupRepoCopy>;
}

export interface ProjectSetupDeps {
  client: Pick<RunnerClient, "setupPlan">;
  /** `pathsOf`: the standard tier's guest has its paths below a per-job root named from the sandbox name (`hostGuest.ts`); a microVM's are the image's own. */
  vm: Pick<NonNullable<JobHandlerDeps["vm"]>, "guestOf" | "lifecycle"> & { pathsOf?(name: string): GuestPaths };
  repos: SetupRepos;
  apply: (input: { bundle: Buffer; base: string; mirrorDir: string; workspace: string }) => Promise<AppliedBundle>;
  logDir: string;
  transport?: EngineTransport;
  paths?: GuestPaths;
  stepTimeoutMs?: number;
  limitsMs?: { bootstrap: number; coldstart: number; finalize: number };
}

const LOG_CAP = 1024 * 1024;
const DEFAULT_LIMITS = { bootstrap: 10 * 60_000, coldstart: 30 * 60_000, finalize: 5 * 60_000 };
const VM_LIMIT_MS = 60 * 60_000;
type RunnerStep = (typeof SETUP_RUNNER_STEPS)[number];

/** The local log: 0600, opened without following a link, at most 1 MiB (the rest is dropped). It never throws and nothing in it is sent. */
function openLog(dir: string, setupId: string | undefined): { write(text: string): void; close(): void } {
  let fd: number | undefined;
  let size = 0;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (setupId !== undefined && lstatSync(dir).isDirectory()) fd = openSync(path.join(dir, `${setupId}.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    if (fd !== undefined && !fstatSync(fd).isFile()) throw new Error("log_file");
    if (fd !== undefined) fchmodSync(fd, 0o600); // a log left by an earlier run keeps its old mode through the open
  } catch {
    // fx-swallow-ok: a log that cannot be opened is no log; the setup does not depend on it
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
  }
  return {
    write(text) {
      if (fd === undefined || size >= LOG_CAP) return;
      try {
        const bytes = Buffer.from(text, "utf8").subarray(0, LOG_CAP - size);
        writeSync(fd, bytes);
        size += bytes.length;
      } catch {
        // fx-swallow-ok: a failed log write is dropped, never an error of the setup
      }
    },
    close: () => (fd === undefined ? undefined : closeSync(fd)),
  };
}

const reasonOf = (value: string | undefined): string | undefined => (value !== undefined && SETUP_FAILURE_REASON_PATTERN.test(value) ? value : undefined);
const handleOf = (name: string): SandboxHandle => ({ runId: "", sandboxName: name, sessionId: "" });

export function createProjectSetupHandler(deps: ProjectSetupDeps): MachineJobHandler<"project_setup"> {
  return async ({ job, reporter, signal }) => {
    const prepared = await prepareProjectSetup({ client: deps.client, reporter, signal, ...(deps.transport === undefined ? {} : { transport: deps.transport }) }, job);
    if (prepared.ready) await setUp(deps, job, prepared, reporter, signal);
  };
}

/**
 * The handler for each job's engine (`sandbox_engine`): a microVM runner uses the microVM guest, any other the OS sandbox's host guest (`hostGuest.ts`); nothing else in the handler differs. The engine is asked again for
 * each job. A guest this build has none of is the closed `engine_unsupported`, and nothing is started. Undefined when neither exists, so the dispatcher reports `kind_unsupported`.
 */
export function setupHandlerFor(handlers: { microvm: MachineJobHandler<"project_setup"> | undefined; standard: MachineJobHandler<"project_setup"> | undefined }, engine: () => "microvm" | "os_sandbox"): MachineJobHandler<"project_setup"> | undefined {
  if (handlers.microvm === undefined && handlers.standard === undefined) return undefined;
  return async (context) => {
    const chosen = engine() === "microvm" ? handlers.microvm : handlers.standard;
    if (chosen === undefined) await context.reporter.report({ sub_step: SETUP_RUNNER_STEPS[0], state: "failed", failure_code: "engine_unsupported", failure_reason: "no_guest" });
    else await chosen(context);
  };
}

async function setUp(deps: ProjectSetupDeps, job: MachineJobOf<"project_setup">, prepared: Extract<Prepared, { ready: true }>, reporter: StepReporter, signal: AbortSignal): Promise<void> {
  const life = deps.vm.lifecycle;
  const limits = deps.limitsMs ?? DEFAULT_LIMITS;
  const { setup } = prepared.plan;
  const names = { agent: `su-${job.job_id}`, check: `sc-${job.job_id}` };
  const paths = deps.paths ?? deps.vm.pathsOf?.(names.agent) ?? DEFAULT_GUEST_PATHS;
  const log = openLog(deps.logDir, job.setup_id);
  let copy: SetupRepoCopy | undefined;
  let current: RunnerStep = "sandbox_boot";
  let bundleBytes = 0;

  const step = async (sub: RunnerStep, state: "started" | "ok"): Promise<void> => {
    current = sub;
    await reporter.report({ sub_step: sub, state });
  };
  /** Reports the failure (which closes the job) and unwinds `runVmJob`; teardown then runs as for any other way out. */
  const fail = async (sub: SetupProgressBody["sub_step"], code: string, reason?: string): Promise<never> => {
    const closed = reasonOf(reason);
    await reporter.report({ sub_step: sub, state: "failed", failure_code: code, ...(closed === undefined ? {} : { failure_reason: closed }) });
    throw new StepRefusal("setup_failed");
  };
  /** A bundle that was refused ends `bundle_refused` with its closed reason; any other failure to bring it out is a workspace failure. */
  const refused = (error: unknown, why: string): Promise<never> => fail("bundle_out", bundleReasonOf(error) === undefined ? "vm_workspace_failed" : "bundle_refused", bundleReasonOf(error) ?? why);
  const guestOf = (name: string) => deps.vm.guestOf(handleOf(name));
  const sink = (_stream: string, text: string): undefined => (log.write(text), undefined);

  try {
    await reporter.report({ sub_step: "sandbox_boot", state: "started" });
    const outcome: VmJobOutcome<void, AppliedBundle, void> = await runVmJob<void, { bundle: Buffer; base: string }, AppliedBundle, void>({
      names,
      port: typeof life.port === "function" ? life.port({ timeoutMs: VM_LIMIT_MS, runId: job.job_id }) : life.port,
      registry: life.registry, caps: life.caps, request: life.request, readMemAvailableBytes: life.readMemAvailableBytes,
      needsToken: false, // no model credential ever enters a setup's guest, and no check VM is made (`needsCheck` below)
      keepAgentVm: false, signal, stepTimeoutMs: deps.stepTimeoutMs ?? 5 * 60_000,
      steps: {
        async workspaceIn(name) {
          await step("sandbox_boot", "ok");
          await step("workspace_in", "started");
          const guest = await guestOf(name);
          // the closed template goes in force before a byte is sent in
          await guest.updateNetworkPolicy(projectSetupPolicy()).catch(() => fail("workspace_in", "vm_egress_unavailable", "policy"));
          copy = await deps.repos.open({ repoId: job.repo_gh_id, owner: setup.repo_owner, name: setup.repo_name, baseSha: job.args.base_sha, signal }).catch(() => fail("workspace_in", "vm_workspace_failed", "repo"));
          await sendWorkspace(guest, copy.archive, paths).catch((error: unknown) => fail("workspace_in", "vm_workspace_failed", error instanceof GuestWorkspaceError ? error.code : "workspace"));
          await sendSetupInputs(guest, { engineTar: prepared.engine.tar, answers: prepared.host.answers, files: prepared.files }, paths).catch((error: unknown) => fail("workspace_in", "vm_workspace_failed", error instanceof SetupGuestError ? error.code : "inputs"));
          await step("workspace_in", "ok");
        },
        async runAgent(name) {
          const guest = await guestOf(name);
          await step("bootstrap", "started");
          const boot = await runSetupCommand(guest, { script: BOOTSTRAP, args: [job.args.branch, `${setup.repo_owner}/${setup.repo_name}`], limitMs: limits.bootstrap, onText: sink, signal }, paths);
          if (boot.exitCode !== 0) await fail("bootstrap", "bootstrap_failed", boot.timedOut ? "timeout" : "exit");
          await step("bootstrap", "ok");

          // Each accepted status line is one report, in order: the reports are chained so a slow answer never reorders them.
          let sent: Promise<unknown> = Promise.resolve();
          const reader = createStatusReader((line) => {
            sent = sent.then(() => reporter.report({ sub_step: line.step, state: line.state, ...(line.code === undefined ? {} : { failure_code: line.code }) }));
          });
          const onText = (stream: "stdout" | "stderr", text: string): "stop" | undefined => (stream === "stdout" ? reader.feed(text) : sink(stream, text)) ?? (reporter.closed ? "stop" : undefined);
          const cold = await runSetupCommand(guest, { script: COLDSTART, args: [MERGE_PROGRAM, prepared.host.name, setup.kind, setup.visibility], limitMs: limits.coldstart, onText, signal }, paths);
          await sent;
          const last = reader.lines[reader.lines.length - 1];
          if (reader.refused) await fail(last?.step ?? "preflight", "setup_status_refused");
          if (reader.lines.some((line) => line.state === "failed")) throw new StepRefusal("setup_failed"); // already reported, with the engine's own code
          if (cold.exitCode !== 0 || last?.step !== "done" || last.state !== "ok") await fail(last?.step ?? "preflight", "interrupted", cold.timedOut ? "timeout" : undefined);

          await step("finalize", "started");
          const when = `${String(Math.floor(Date.parse(job.issued_at) / 1000))} +0000`;
          const done = await runSetupCommand(guest, { script: FINALIZE, args: [job.args.engine.version, when, (copy as SetupRepoCopy).archive.commit], limitMs: limits.finalize, onText: sink, signal }, paths);
          if (done.exitCode !== 0) await fail("finalize", "finalize_failed", done.timedOut ? "timeout" : "exit");
          await step("finalize", "ok");
        },
        async bundleOut(name) {
          await step("bundle_out", "started");
          const pulled = await pullBundle(await guestOf(name), (copy as SetupRepoCopy).archive.commit, { paths }).then((bundle) => ({ bundle }), (error: unknown) => ({ error }));
          if ("error" in pulled) return refused(pulled.error, "pull");
          // finalize always commits: no new commit is a failure of the guest's own work
          if (pulled.bundle === null) return fail("bundle_out", "finalize_failed", "no_commit");
          bundleBytes = pulled.bundle.length;
          return { bundle: pulled.bundle, base: (copy as SetupRepoCopy).archive.commit };
        },
        async hostApply(collected) {
          const { mirrorDir, workspace } = copy as SetupRepoCopy;
          return deps.apply({ ...collected, mirrorDir, workspace }).catch((error: unknown) => refused(error, "apply"));
        },
        needsCheck: () => false,
      },
    });
    if (outcome.ok) await reporter.report({ sub_step: "bundle_out", state: "ok", bundle_bytes: bundleBytes });
    else if (!reporter.closed && !signal.aborted) {
      // a failure no step reported itself: the VM could not be made, reached or ended
      const code = (SETUP_FAILURE_CODES as readonly string[]).includes(outcome.code) ? outcome.code : "vm_workspace_failed";
      await reporter.report({ sub_step: current, state: "failed", failure_code: code, ...(reasonOf(outcome.step) === undefined ? {} : { failure_reason: reasonOf(outcome.step) as string }) });
    }
  } finally {
    await copy?.release().catch(() => undefined); // fx-swallow-ok: a host copy that cannot be removed now is swept with the runner's other workspaces
    log.close();
  }
}
