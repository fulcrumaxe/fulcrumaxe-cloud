/**
 * D#587 B-5a part 3: the claim gate for a runner the person set to the `microvm` engine. While the machine cannot start a VM (no KVM, no helper, a helper that is not ready
 * or out of date) the gate is closed with the matching `microvm_*` reason, the poll loop sends it as a status poll and takes no job, and nothing is run in the OS sandbox
 * instead. An engine that is not `microvm` is the OS sandbox gate, untouched.
 *
 * One rhythm for both answers: the machine is asked at most once every 5 minutes, whether the last answer was closed (a fixed machine recovers without a restart) or open (a helper
 * that dies after start is noticed before a later claim), so a machine is not hammered either way. Fails closed: facts that cannot be read, or a reader that throws, are `microvm_no_kvm` (see `microvmUnavailableReason`). While the engine
 * setting is not `microvm` nothing is remembered, so switching it on checks the machine afresh.
 */
import type { SandboxEngine, VmHostFacts } from "../vm/limits.js";
import { microvmUnavailableReason } from "../vm/engineGate.js";
import { REPROBE_INTERVAL_MS, type GateState, type SandboxGate } from "./sandboxGate.js";

export interface MicrovmGateDeps {
  /** The engine setting, read at every check (a setting changed while the daemon runs applies at the next claim). */
  engine: () => SandboxEngine | "invalid";
  /** What the machine says: the KVM device, the helper's socket and what the helper answered. Absent: no facts, which is the same as no KVM. */
  facts: (() => Promise<VmHostFacts | undefined>) | undefined;
  now: () => Date;
  /**
   * Whether a missing limit already holds claiming (`limitsClaimBlock`, B-6a): the claim then goes out paused, as it always has, and this gate says nothing until the limits are set.
   * Both are "claims nothing"; the person fixes the limits first because `doctor` lists them first.
   */
  limitsBlocked: () => boolean;
  /** The OS sandbox gate, asked when the engine is not `microvm` or the machine can start a VM. */
  inner: SandboxGate;
}

export function createMicrovmGate(deps: MicrovmGateDeps): SandboxGate {
  let passed = false;
  let closed: GateState | undefined;
  let askedAt = 0;
  return {
    async check() {
      if (deps.engine() !== "microvm" || deps.limitsBlocked()) {
        passed = false;
        closed = undefined;
        return deps.inner.check();
      }
      const now = deps.now().getTime();
      if (passed && now - askedAt < REPROBE_INTERVAL_MS) return deps.inner.check();
      if (closed !== undefined && now - askedAt < REPROBE_INTERVAL_MS) return closed;
      askedAt = now;
      let facts: VmHostFacts | undefined;
      try {
        facts = deps.facts === undefined ? undefined : await deps.facts();
      } catch {
        // fx-swallow-ok: facts that cannot be read are a closed gate with a fixed reason; the error text could hold paths and is not kept
        facts = undefined;
      }
      const reason = microvmUnavailableReason({ engine: "microvm", facts });
      if (reason !== undefined) {
        passed = false;
        closed = { open: false, reason };
        return closed;
      }
      closed = undefined;
      passed = true;
      return deps.inner.check();
    },
  };
}
