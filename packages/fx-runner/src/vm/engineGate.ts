/**
 * D#587 B-5b: one engine for a runner, and no way to run a job on a weaker one. The engine a runner reports in its hello, the engine its job gate
 * checks a signed job against, and the sandbox it runs the job in are all decided by `chooseEngine` and `selectSandbox`, so they cannot disagree.
 *
 *  - `chooseEngine`: `microvm` only when the machine's engine line says so AND this build has a microVM sandbox to run jobs in. A machine that
 *    could run VMs but whose build cannot start a job in one reports `os_sandbox`, so the cloud never sends it a job that needs a VM.
 *  - `engineRefusal`: a signed job that requires a microVM is refused (`engine_required`) by a runner whose engine is anything else. The cloud routes
 *    on the same fact; this is the runner's own second check, and it never reads anything but the job's signed field and its own engine.
 *  - `selectSandbox`: the port for the engine. `microvm` without a microVM port is an error, never the OS sandbox: there is no downgrade.
 *  - `microvmUnavailableReason` (D#587 B-5a part 3): a runner the person set to `microvm` that cannot start a VM names the one reason, from a closed set of four, and the claim gate
 *    (`daemon/microvmGate.ts`) takes no job while it holds. It is never answered by running the job in the OS sandbox.
 */
import { ENGINE_LINES, type EngineLine, type SandboxEngine, type VmHostFacts } from "./limits.js";

export function chooseEngine(line: EngineLine | undefined, microvmSandboxWired: boolean): SandboxEngine {
  return line === ENGINE_LINES.microvm && microvmSandboxWired ? "microvm" : "os_sandbox";
}

export function engineRefusal(required: "microvm" | undefined, engine: SandboxEngine): "engine_required" | undefined {
  return required === "microvm" && engine !== "microvm" ? "engine_required" : undefined;
}

export class EngineUnavailable extends Error {
  constructor() {
    super("the microvm engine was selected but no microVM sandbox is available; the OS sandbox is never used instead");
    this.name = "EngineUnavailable";
  }
}

export function selectSandbox<T>(engine: SandboxEngine, ports: { os_sandbox: T; microvm?: T | undefined }): T {
  if (engine === "os_sandbox") return ports.os_sandbox;
  if (ports.microvm === undefined) throw new EngineUnavailable();
  return ports.microvm;
}

/**
 * The four reasons, in the protocol's order. They are members of the protocol's `SANDBOX_UNAVAILABLE_REASONS` (a test pins that the probe's five and these four are
 * exactly that set), kept here as a plain list so `src/vm` does not depend on how the protocol package spells its set.
 */
export const MICROVM_UNAVAILABLE_REASONS = ["microvm_no_kvm", "microvm_helper_missing", "microvm_helper_not_ready", "microvm_helper_out_of_date"] as const;
export type MicrovmUnavailableReason = (typeof MICROVM_UNAVAILABLE_REASONS)[number];

/**
 * Why a runner whose engine setting is `microvm` cannot start a VM right now, or undefined when nothing here stops it (and for every other engine: this answers only for `microvm`).
 * Checked in the order a person would fix them: the KVM device, then the helper's socket, then what the helper said. Every fact that is not a plain "yes" fails closed:
 *  - no facts at all, or a KVM device that is absent or could not be read: `microvm_no_kvm` (a device the runner cannot use is no device);
 *  - a helper socket that is absent: `microvm_helper_missing`; one that is there but could not be used (permissions, not a socket): `microvm_helper_not_ready`;
 *  - the helper's answer: none or an error is `microvm_helper_not_ready`, another protocol number is `microvm_helper_out_of_date`, and a fact nobody asked for is `microvm_helper_not_ready`.
 * Limits are not a reason here: a missing cap already holds claiming through `limitsClaimBlock`.
 */
export function microvmUnavailableReason(input: { engine: SandboxEngine | "invalid"; facts: VmHostFacts | undefined }): MicrovmUnavailableReason | undefined {
  if (input.engine !== "microvm") return undefined;
  const { facts } = input;
  if (facts === undefined || facts.kvm !== "present") return "microvm_no_kvm";
  if (facts.helperSocket === "absent") return "microvm_helper_missing";
  if (facts.helperSocket !== "present") return "microvm_helper_not_ready";
  if (facts.helperState === "out_of_date") return "microvm_helper_out_of_date";
  if (facts.helperState !== "ready") return "microvm_helper_not_ready";
  return undefined;
}

/**
 * D#587 B-5b-3a: what a runner says when its answer to "can I claim?" changes while it runs, one closed sentence per reason. The four `microvm_*` reasons each have their own
 * words and never borrow the OS sandbox's (bubblewrap, user namespaces); the OS reasons keep the wording they always had. A back-to-working change is one fixed line.
 * An unknown word is described as the OS sandbox's, as before, and never as a VM problem.
 */
const MICROVM_REASON_WORDS: Readonly<Record<MicrovmUnavailableReason, string>> = {
  microvm_no_kvm: "this machine has no usable KVM device",
  microvm_helper_missing: "the VM helper is not installed",
  microvm_helper_not_ready: "the VM helper is installed but did not answer as ready",
  microvm_helper_out_of_date: "the VM helper speaks another version than this runner",
};

export function reasonChangeLine(reason: string | undefined): string {
  if (reason === undefined) return "fx-runner: the sandbox works again; claiming jobs";
  if ((MICROVM_UNAVAILABLE_REASONS as readonly string[]).includes(reason)) {
    return `fx-runner: the microVM engine you chose cannot start (${reason}: ${MICROVM_REASON_WORDS[reason as MicrovmUnavailableReason]}); no job will be claimed, and the OS sandbox is not used instead. Run: fx-runner doctor`;
  }
  return `fx-runner: the sandbox does not work on this machine (${reason}); no job will be claimed. Run: fx-runner doctor`;
}

/** The start-up line for a runner that cannot claim because its build cannot start a VM yet (`microvm_build_unwired`, local only: nothing is sent to the cloud). */
export const UNWIRED_LINE = "fx-runner: this build cannot start jobs in a microVM yet (microvm_build_unwired), so a runner set to microvm claims nothing, and the OS sandbox is not used instead. Run: fx-runner doctor";

/** The line for a wired build whose run chose the OS sandbox while the setting now says `microvm` (`microvm_restart_needed`, local only). */
export const RESTART_LINE = "fx-runner: the engine setting is microvm but this run started on the OS sandbox (microvm_restart_needed), so it claims nothing until it is restarted, and the OS sandbox is not used instead. Restart it, then run: fx-runner doctor";
