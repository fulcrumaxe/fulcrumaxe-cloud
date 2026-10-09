/**
 * The claim gate (D#6 R4a-6, correction C16 section 1.3): the daemon takes no job while this machine cannot start the sandbox a job gets.
 *
 * The probe (R4a-5) runs at the first `check`, which `run` calls before the first claim. A pass is kept: the job's own sandbox start is
 * the check after that, and a job that cannot start it fails `sandbox_unavailable`, never unsandboxed. While the probe fails, `check`
 * answers with the failure's reason code and runs the probe again, but at most once every 5 minutes, so a machine that is fixed recovers
 * without a restart and one that is not is not hammered. The gate fails closed: a probe that throws, or answers with anything but a pass or
 * a reason from the closed set, is `probe_failed_other`.
 */
import { SANDBOX_UNAVAILABLE_REASONS, type SandboxUnavailableReason } from "@fulcrumaxe/runner-protocol";
import type { SandboxProbeResult } from "../sandbox/probe.js";

/** The least time between two probes while one is failing. */
export const REPROBE_INTERVAL_MS = 5 * 60 * 1000;

export type GateState = { open: true } | { open: false; reason: SandboxUnavailableReason };

export interface SandboxGate {
  check(): Promise<GateState>;
}

export interface SandboxGateDeps {
  probe: () => Promise<SandboxProbeResult>;
  now: () => Date;
}

const isReason = (value: unknown): value is SandboxUnavailableReason => typeof value === "string" && (SANDBOX_UNAVAILABLE_REASONS as readonly string[]).includes(value);

export function createSandboxGate(deps: SandboxGateDeps): SandboxGate {
  let state: GateState | undefined;
  let probedAt = 0;
  return {
    async check() {
      if (state?.open === true) return state;
      const now = deps.now().getTime();
      if (state !== undefined && now - probedAt < REPROBE_INTERVAL_MS) return state;
      probedAt = now;
      try {
        const result = await deps.probe();
        if (result.ok === true) state = { open: true };
        else state = { open: false, reason: isReason(result.reason) ? result.reason : "probe_failed_other" };
      } catch {
        // fx-swallow-ok: a probe that cannot run is a closed gate with a fixed reason; its error text could hold paths and is not kept
        state = { open: false, reason: "probe_failed_other" };
      }
      return state;
    },
  };
}
