/**
 * D#587 B-5b: one engine for a runner, and no way to run a job on a weaker one. The engine a runner reports in its hello, the engine its job gate
 * checks a signed job against, and the sandbox it runs the job in are all decided by `chooseEngine` and `selectSandbox`, so they cannot disagree.
 *
 *  - `chooseEngine`: `microvm` only when the machine's engine line says so AND this build has a microVM sandbox to run jobs in. A machine that
 *    could run VMs but whose build cannot start a job in one reports `os_sandbox`, so the cloud never sends it a job that needs a VM.
 *  - `engineRefusal`: a signed job that requires a microVM is refused (`engine_required`) by a runner whose engine is anything else. The cloud routes
 *    on the same fact; this is the runner's own second check, and it never reads anything but the job's signed field and its own engine.
 *  - `selectSandbox`: the port for the engine. `microvm` without a microVM port is an error, never the OS sandbox: there is no downgrade.
 */
import { ENGINE_LINES, type EngineLine, type SandboxEngine } from "./limits.js";

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
