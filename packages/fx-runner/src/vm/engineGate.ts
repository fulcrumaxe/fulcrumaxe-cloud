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
