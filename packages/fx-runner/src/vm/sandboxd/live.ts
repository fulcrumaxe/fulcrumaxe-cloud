/**
 * D#587 B-5b-3a: the one place the live microVM stack is composed: the daemon (`Sandboxd`), then the SDK adapter over it with the egress policy port, then the
 * microVM `SandboxPort`. It returns `undefined` unless EVERY part is present, so a build that lacks one (today: the guest agent runtime and the boot facts) is
 * simply not wired, and `chooseEngine` keeps such a runner off the microVM engine; nothing is half-built and nothing falls back silently.
 *
 * Nothing here reads `process.*` or starts a process: the caller (`bin/fx-runner.mjs`) reads the uid and the host facts once and passes them in.
 */
import type { HostSandbox } from "../../sandbox/hostSandbox.js";
import { createMicrovmSandbox, type MicrovmSandbox, type MicrovmSandboxConfig } from "./microvmSandbox.js";
import { createEgressPolicyPort, type EgressStarters } from "./policyPort.js";
import { createDaemonSdk, idOf, type DaemonSdk } from "./sdkAdapter.js";
import { assertNotRoot, Sandboxd, type SandboxdDeps } from "./sandboxd.js";
import { createMicrovmVmPort } from "./vmPort.js";
import type { GuestBindings } from "./guestBindings.js";
import type { VmPort } from "../jobLifecycle.js";

export interface LiveMicrovmParts {
  /** The daemon's dependencies except the boot facts (`productionDepsBase`). */
  deps?: Omit<SandboxdDeps, "boot"> | undefined;
  /** The signed-metadata boot facts: which targets are listed and the digests a template boots from. */
  boot?: SandboxdDeps["boot"] | undefined;
  /** The template a VM boots from, and its RAM in MiB. */
  template?: string | undefined;
  memMb?: number | undefined;
  /** The runner's own uid, read once at the entry point (FU-90). */
  uid?: number | undefined;
  /** The egress proxy and the reverse endpoint (`startEgressProxy`, `startReverseEndpoint`). */
  egress?: EgressStarters | undefined;
  /** Runs the agent CLI inside the guest (B-5a-RT). */
  makeRuntime?: MicrovmSandboxConfig["makeRuntime"] | undefined;
}

/** The fixed refusal a VM run's check answers until the fresh-VM check exists. */
export const CHECK_CLOSED = "microvm_check_closed";

export interface LiveMicrovm {
  /**
   * The microVM port in the shape `run` hands the job code (`HostSandbox`). Two members are the OS sandbox's own and have no VM meaning yet: `interrupt` does nothing (a take-over and a
   * handoff's checkpoint turn are not in VM runs, and `stop` ends the agent), and `checkLaunch` refuses with a fixed word, because the approved check of a VM run is built in a fresh VM (B-5b),
   * never started on the host or in the agent's own guest.
   */
  port: HostSandbox;
  /** The same SDK the port uses, for the inventory source and the signed stop, delete and reap commands. */
  sdk: DaemonSdk;
  /** The production VM factory for `runVmJob` over this same port, daemon and egress policy port (B-5b-3c-ii). `persistent` makes the agent's VM keep a snapshot when stopped. */
  vmPort(options: { timeoutMs: number; persistent?: boolean; bindings: GuestBindings }): VmPort;
}

type Complete = { [K in keyof LiveMicrovmParts]-?: NonNullable<LiveMicrovmParts[K]> };

/** Whether the daemon would accept this runner's effective user id (`assertNotRoot`: a whole number above 0), so `doctor` and `run` agree for a root process too. */
function daemonAcceptsEuid(euid: number | undefined): boolean {
  try {
    assertNotRoot(euid);
    return true;
  } catch {
    // fx-swallow-ok: the daemon's refusal is the answer "no"; its text is not kept
    return false;
  }
}

/** Whether every part is there, in a usable shape, and the daemon would accept the euid. The same answer `createLiveMicrovm` acts on, so `doctor` and `run` agree. */
export function liveMicrovmComplete(parts: LiveMicrovmParts | undefined): parts is Complete {
  if (parts === undefined) return false;
  return (
    parts.deps !== undefined && daemonAcceptsEuid(parts.deps.euid) && parts.boot !== undefined && parts.egress !== undefined && typeof parts.makeRuntime === "function" &&
    typeof parts.template === "string" && parts.template !== "" &&
    typeof parts.memMb === "number" && Number.isSafeInteger(parts.memMb) && parts.memMb > 0 &&
    typeof parts.uid === "number" && Number.isSafeInteger(parts.uid) && parts.uid > 0
  );
}

export function createLiveMicrovm(parts: LiveMicrovmParts | undefined): LiveMicrovm | undefined {
  if (!liveMicrovmComplete(parts)) return undefined;
  try {
    const daemon = new Sandboxd({ ...parts.deps, boot: parts.boot });
    const policy = createEgressPolicyPort({ helper: parts.deps.helper, uid: parts.uid, egress: parts.egress });
    const sdk = createDaemonSdk({ daemon, policy, template: parts.template, memMb: parts.memMb });
    const port: MicrovmSandbox = createMicrovmSandbox({ sdk, makeRuntime: parts.makeRuntime });
    return {
      port: { ...port, interrupt: async () => undefined, checkLaunch: () => ({ refused: CHECK_CLOSED }) },
      sdk,
      vmPort: (options) => createMicrovmVmPort({ sandbox: port, daemon, policy, idOf, bindings: options.bindings, timeoutMs: options.timeoutMs, ...(options.persistent === undefined ? {} : { persistent: options.persistent }) }),
    };
  } catch {
    // fx-swallow-ok: a daemon that refuses to be built (run as root, no euid) is a build that is not wired; the error text is not kept
    return undefined;
  }
}
