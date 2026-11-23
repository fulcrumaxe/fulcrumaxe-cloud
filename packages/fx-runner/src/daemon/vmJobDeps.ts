/**
 * D#587 B-5b-3c-iii: what the job handler's `deps.vm` is made of when the runner's engine is `microvm`. Every piece already exists; this only joins them over the one live stack
 * (`createLiveMicrovm`): the working-copy crossing and the guest reads come from the port, the archive of a commit and the bundle apply from the guarded git, the approved check from
 * the fresh-VM check, the token step from the bindings and the VM factory per job from the port. Nothing here starts a process or reads `process.*`: the git runners, the clock, the
 * state directory, the memory reader and the settings reader are handed in.
 */
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { CleanEnvOptions } from "../job/cleanEnv.js";
import type { MemAvailableReader, MicrovmCaps } from "../vm/limits.js";
import type { LiveMicrovm } from "../vm/sandboxd/live.js";
import { reapVms, VmRegistry, vmCapBlock } from "../vm/jobLifecycle.js";
import type { RunEventHooks } from "../vm/sandboxd/guestBindings.js";
import type { EventRelay } from "./lease.js";
import type { UsageGate } from "./usageGate.js";
import { createCheckInVm } from "../vm/workspace/guestCheck.js";
import { buildWorkspaceArchive } from "./vmArchive.js";
import { applyBundle } from "./vmBundle.js";
import { createGit, type Git, type GitCapture } from "./git.js";
import { workflowPolicy } from "../setup/setupPolicy.js";
import type { JobHandlerDeps } from "./jobHandler.js";

export interface VmJobWiring {
  live: LiveMicrovm;
  stateDir: string;
  /** The runner's git capture (the engine's), the large-output one where there is one, and the clean environment git runs under. */
  capture: GitCapture;
  captureLarge?: GitCapture | undefined;
  envOptions?: CleanEnvOptions | undefined;
  now: () => Date;
  /** The limits as the settings hold them now, read at each job, so a change is seen at the next admission and never kills a running VM. */
  caps: () => MicrovmCaps | undefined;
  readMemAvailableBytes: MemAvailableReader;
  /** Whether a job's agent runs on the person's subscription token (the only credential a VM run takes in v1). Else no token step is made. */
  subscription: boolean;
}

/** The directory only this process writes (0700) that archives and throwaway repositories are made below; made at first use, a link or a non-directory is refused. */
function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory()) throw new Error("vm_scratch_not_a_directory");
  if ((info.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  return dir;
}

export function createVmJobDeps(wiring: VmJobWiring): NonNullable<JobHandlerDeps["vm"]> {
  const { live } = wiring;
  const gitOptions = wiring.envOptions === undefined ? {} : { envOptions: wiring.envOptions };
  const git = createGit({ capture: wiring.capture, ...gitOptions });
  const gitLarge = createGit({ capture: wiring.captureLarge ?? wiring.capture, ...gitOptions });
  const scratch = (): string => privateDir(path.join(wiring.stateDir, "vm-scratch"));
  const archive = async (repoDir: string, commit: string) => buildWorkspaceArchive({ git, gitLarge, scratchDir: scratch() }, repoDir, commit);
  const registry = new VmRegistry();
  return {
    crossing: live.crossing,
    archive,
    quiesce: (handle) => live.quiesce(handle),
    guestOf: (handle) => live.guestOf(handle),
    apply: async (input) => applyBundle({ git, gitLarge, scratchDir: scratch() }, input),
    freshCheck: createCheckInVm({ port: { guestOf: (handle) => live.guestOf(handle) }, archive, now: wiring.now }),
    lifecycle: {
      // one factory per job: the VM's wall-clock limit is the job's own (FU-170's other half is the binding the factory makes, which hands the same number to the guest)
      port: (options) => live.vmPort(options),
      registry,
      get caps() {
        return wiring.caps();
      },
      request: { vcpus: 1, memoryMb: live.memMb },
      readMemAvailableBytes: wiring.readMemAvailableBytes,
      token: { needed: () => wiring.subscription, slot: (vm) => live.bindings.slot(vm, live.readToken) },
    },
  };
}

/** D#845 ON-8d: what a project setup takes from the run jobs' guarded runners and scratch directory, and the bundle apply WITH the setup's policy (`setupPolicy.ts`). A run's own `apply` is unchanged. */
export function createSetupVmParts(wiring: Pick<VmJobWiring, "stateDir" | "capture" | "captureLarge" | "envOptions">): { git: Git; gitLarge: Git; scratch: () => string; apply: NonNullable<JobHandlerDeps["vm"]>["apply"] } {
  const gitOptions = wiring.envOptions === undefined ? {} : { envOptions: wiring.envOptions };
  const git = createGit({ capture: wiring.capture, ...gitOptions });
  const gitLarge = createGit({ capture: wiring.captureLarge ?? wiring.capture, ...gitOptions });
  const scratch = (): string => privateDir(path.join(wiring.stateDir, "vm-scratch"));
  return { git, gitLarge, scratch, apply: async (input) => applyBundle({ git, gitLarge, scratchDir: scratch(), policy: workflowPolicy(gitLarge) }, input) };
}

/**
 * What a microVM run's guest events go to: exactly what the OS-sandbox path passes its engine (`run.ts`, `makeRuntime`): each event feeds the usage gate and is relayed to THAT run's own sink,
 * and a near-limit warning goes to the gate. Made per run id, so two runs at once never share a sink.
 */
export function runEventHooks(sinks: { usage: Pick<UsageGate, "observe" | "warn">; relay: Pick<EventRelay, "emit"> }): (runId: string) => RunEventHooks {
  return (runId) => ({ onLocalEvent: (event) => (sinks.usage.observe(event), sinks.relay.emit(runId, event)), onNearLimit: (info) => sinks.usage.warn(info) });
}

/** The local, closed reasons a runner on the microVM engine does not claim (nothing here is sent to the cloud). */
export type VmRunBlock = "microvm_api_key_unsupported" | "vm_reap_pending" | "vm_cap_reached";

export interface VmClaimGuard {
  /** Reaps once, before the first claim. A failed reap holds claiming (`vm_reap_pending`) until a later pass is clean. */
  start(): Promise<void>;
  /** Read at every claim, with the other claim blocks. */
  block(): VmRunBlock | undefined;
}

/**
 * D#587 3c-iii: the claim loop's own part of the microVM path. It is made over the SAME registry the job lifecycle uses (`vm.lifecycle.registry`), so a VM that is up counts at the claim and at
 * admission alike.
 *  - A runner on an API key has no token step and a subscription-only guest runtime, so each job it claimed would fail when the CLI starts: it claims nothing instead.
 *  - Startup reaping ends the VMs the helper still holds from an earlier process (their egress listeners, the token a crash left inside, the RAM the new registry does not count) before anything is
 *    claimed. An unreadable helper list counts as a failure: what is left is then unknown. While held, each claim check starts one more pass. Nothing is claimed in between, so no job of this
 *    process owns a VM the pass could end.
 *  - The VM cap holds claiming once it is reached, so the runner does not take jobs it can only refuse.
 */
export function createVmClaimGuard(wiring: { live: LiveMicrovm; vm: NonNullable<JobHandlerDeps["vm"]>; subscription: boolean }): VmClaimGuard {
  const { live, vm } = wiring;
  let held = true;
  let pass: Promise<void> | undefined;
  const reapOnce = async (): Promise<void> => {
    let listFailed = false;
    const result = await reapVms({
      prefix: live.idPrefix,
      idOf: live.idOf,
      list: () =>
        live.reap.list().catch((err: unknown) => {
          listFailed = true;
          throw err;
        }),
      port: live.reap.port,
      registry: vm.lifecycle.registry,
    });
    held = listFailed || result.failed > 0;
  };
  const run = (): Promise<void> => {
    pass ??= reapOnce()
      .catch(() => {
        // fx-swallow-ok: a pass that throws is a pass that did not finish: claiming stays held and the next claim check tries again
        held = true;
      })
      .finally(() => {
        pass = undefined;
      });
    return pass;
  };
  return {
    start: run,
    block() {
      if (!wiring.subscription) return "microvm_api_key_unsupported";
      if (held) {
        void run();
        return "vm_reap_pending";
      }
      return vmCapBlock(vm.lifecycle.registry, vm.lifecycle.caps);
    },
  };
}
