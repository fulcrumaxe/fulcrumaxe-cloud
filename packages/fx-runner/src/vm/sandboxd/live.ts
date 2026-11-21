/**
 * D#587 B-5b-3a: the one place the live microVM stack is composed: the daemon (`Sandboxd`), then the SDK adapter over it with the egress policy port, then the
 * microVM `SandboxPort`. It returns `undefined` unless EVERY part is present, so a build that lacks one (the entry point supplies them all, `src/vm/liveParts.ts`) is
 * simply not wired, and `chooseEngine` keeps such a runner off the microVM engine; nothing is half-built and nothing falls back silently.
 *
 * Nothing here reads `process.*` or starts a process: the caller (`bin/fx-runner.mjs`) reads the uid and the host facts once and passes them in.
 */
import type { HostSandbox } from "../../sandbox/hostSandbox.js";
import { createMicrovmSandbox, type MicrovmSandbox, type MicrovmSandboxConfig } from "./microvmSandbox.js";
import { createEgressPolicyPort, type EgressStarters } from "./policyPort.js";
import { createDaemonSdk, sandboxIdOf, type DaemonSdk } from "./sdkAdapter.js";
import { assertNotRoot, Sandboxd, type SandboxdDeps } from "./sandboxd.js";
import { createMicrovmVmPort } from "./vmPort.js";
import type { GuestBindings, GuestRunHooks } from "./guestBindings.js";
import { HelperError } from "./helperClient.js";
import { createWorkspaceCrossing, type WorkspaceCrossing } from "../workspace/crossing.js";
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
  /** Runs the agent CLI inside the guest (B-5a-RT): `guestMakeRuntime(shared, bindings.binding)`. The working-copy crossing wraps it (`createWorkspaceCrossing`) inside `createLiveMicrovm`. */
  makeRuntime?: MicrovmSandboxConfig["makeRuntime"] | undefined;
  /** The per-sandbox bindings `makeRuntime` was built over; the VM factory registers each VM in them and the token step reads from them (3c-i). */
  bindings?: GuestBindings | undefined;
  /** A fresh buffer holding the runner's model token, made at each call by the entry point (the only place that reads the environment). Never logged, never kept. */
  readToken?: (() => Buffer) | undefined;
  /** Where each run's usage and relay sinks come from (D#587 3c-iii). `run` attaches them once the run's usage gate and relay exist; a build without this part is not wired. */
  runHooks?: GuestRunHooks | undefined;
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
  vmPort(options: { timeoutMs: number; runId: string; persistent?: boolean; bindings?: GuestBindings }): VmPort;
  /** Where the run's usage and relay sinks are attached (`run`), and where each VM's binding reads them from. */
  runHooks: GuestRunHooks;
  /**
   * What startup reaping works over (D#587 3c-iii): the sandbox ids the HELPER still holds (it outlives this process, the daemon's own list does not), and a port that ends one by id. A VM
   * the helper no longer knows counts as gone. The port's own records of persistent snapshots are untouched.
   */
  reap: { list(): Promise<string[]>; port: Pick<VmPort, "releaseEgress" | "delete"> };
  /** What `deps.vm` of the job handler needs from the port and the parts (D#587 B-5b-3c-iii). */
  crossing: WorkspaceCrossing;
  guestOf: MicrovmSandbox["guestOf"];
  quiesce: MicrovmSandbox["quiesce"];
  /** The RAM of every VM in MiB (the request a job's admission is checked with). */
  memMb: number;
  bindings: GuestBindings;
  readToken: () => Buffer;
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
    parts.deps !== undefined && daemonAcceptsEuid(parts.deps.euid) && parts.boot !== undefined && parts.egress !== undefined && typeof parts.makeRuntime === "function" && parts.bindings !== undefined && typeof parts.readToken === "function" && typeof parts.runHooks?.attach === "function" && typeof parts.runHooks.forRun === "function" &&
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
    // the working copy crosses into the guest at the agent's start: the crossing wraps the guest runtime, so the port itself decides nothing about a working copy (B-5b)
    const crossing = createWorkspaceCrossing(parts.makeRuntime);
    const port: MicrovmSandbox = createMicrovmSandbox({ sdk, makeRuntime: crossing.makeRuntime });
    const bindings = parts.bindings;
    const runHooks = parts.runHooks;
    const helper = parts.deps.helper;
    return {
      port: { ...port, interrupt: async () => undefined, checkLaunch: () => ({ refused: CHECK_CLOSED }) },
      sdk,
      vmPort: (options) => createMicrovmVmPort({ sandbox: port, daemon, policy, idOf: sandboxIdOf, bindings: options.bindings ?? bindings, timeoutMs: options.timeoutMs, hooks: () => runHooks.forRun(options.runId), ...(options.persistent === undefined ? {} : { persistent: options.persistent }) }),
      runHooks,
      reap: {
        list: async () => (await helper.list()).map((entry) => entry.sandboxId),
        port: {
          releaseEgress: (id) => policy.release(id),
          async delete(id) {
            try {
              await helper.destroy(id);
            } catch (err) {
              // a VM the helper no longer knows is gone; every other refusal is a failed reap
              if (!(err instanceof HelperError && err.code === "unknown_sandbox")) throw err;
            }
          },
        },
      },
      crossing,
      guestOf: (handle) => port.guestOf(handle),
      quiesce: (handle) => port.quiesce(handle),
      memMb: parts.memMb,
      bindings,
      readToken: parts.readToken,
    };
  } catch {
    // fx-swallow-ok: a daemon that refuses to be built (run as root, no euid) is a build that is not wired; the error text is not kept
    return undefined;
  }
}
