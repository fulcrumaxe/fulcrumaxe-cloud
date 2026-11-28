/**
 * D#587 B-5b-3c-ii: the production `VmPort` for `runVmJob` (the VM factory behind a job's agent VM and its fresh check VM), over the microVM `SandboxPort` and the daemon.
 *
 *  - `create` boots the VM through the port. The SDK adapter underneath does not hand a sandbox out until the guest agent has answered and a CLOSED network policy
 *    is in force (both listeners up), so egress and the guest are already up when `create` returns. `startEgress` and `waitGuest` check that, they do not start a
 *    second path: a job's own rules still go in lazily, through the port's one policy write at the agent's start (and the check VM's one write).
 *  - `stop` is the port's stop (a snapshot only for a sandbox made persistent). `delete` ends the VM and every snapshot of it, and is safe to repeat.
 *  - `destroy` (Ruling 18, FU-155) ends the VM with no snapshot. A VM made non-persistent has no snapshot to keep, so that is the port's delete. A persistent one may hold
 *    earlier snapshots that a delete would drop, so it goes through the daemon's own no-snapshot teardown, which keeps them.
 *  - `releaseEgress` closes the VM's two listeners (the policy port's `release`, by daemon id); it is safe to repeat.
 * Nothing here starts a process or reads `process.*`.
 */
import type { SandboxHandle } from "../../sandbox/port.js";
import { CHANNEL_PORT } from "../../engineHost/guestSession.js";
import type { VmKind, VmPort } from "../jobLifecycle.js";
import type { Connect } from "./guestAgent.js";
import type { MicrovmSandbox } from "./microvmSandbox.js";
import type { GuestBindings, RunEventHooks } from "./guestBindings.js";
import type { Sandboxd } from "./sandboxd.js";

export interface MicrovmVmPortParts {
  sandbox: Pick<MicrovmSandbox, "createSandbox" | "stop" | "deleteSandbox" | "guestOf" | "sandboxState"> & Partial<Pick<MicrovmSandbox, "wake">>;
  /** The daemon's no-snapshot teardown (`Sandboxd.teardown`), by daemon id. */
  daemon: Pick<Sandboxd, "teardown" | "get"> & Partial<Pick<Sandboxd, "hasTimedOutWrite">>;
  /** The per-sandbox bindings the guest runtime and the token step read (`GuestBindings`): bound when a VM is created, unbound when it is ended. */
  bindings: Pick<GuestBindings, "bind" | "unbind">;
  /** The egress policy port's `release`, by daemon id. */
  policy: { release(sandboxId: string): Promise<void> };
  /** The adapter's sandbox name to daemon id map. */
  idOf: (name: string) => string;
  /** The port's wall-clock limit for a VM, in ms (the check VM's included). */
  timeoutMs: number;
  /** The run's usage and relay sinks, asked for before a VM is made and bound with it. Throws when none can be had, so no VM is made without them. */
  hooks?: () => RunEventHooks;
  /** Make the AGENT's VM persistent (a stop keeps a snapshot). The check VM is never persistent. */
  persistent?: boolean;
}

/** Fixed words only: nothing a job, a path or a helper said travels in these. */
export class VmPortRefused extends Error {
  constructor(readonly code: "egress_down" | "guest_not_ready" | "vm_not_gone" | "resume_unavailable") {
    super(code);
    this.name = "VmPortRefused";
  }
}

/** A connection to a guest vsock port, as `viaFirecrackerVsock` hands it out. */
type Duplex = Awaited<ReturnType<Connect>>;

/** The VM factory of a persistent sandbox that can also be woken from its kept disk (D#845 ON-13a1). */
export type ResumableVmPort = VmPort & {
  resume(id: string): Promise<void>;
  /** D#845 ON-13b2: a connection to the engine session's channel of a running VM (vsock port 5255). The microVM tier has it; the standard tier's port does not. The caller closes it. */
  channel?(id: string): Promise<Duplex>;
  /** True when the daemon's last snapshot write of this VM timed out and no destroy has returned since: the helper stops the VM by itself, so a channel to it is not to be expected. */
  writeTimedOut?(id: string): boolean;
};

export function createMicrovmVmPort(parts: MicrovmVmPortParts): ResumableVmPort {
  const handles = new Map<string, SandboxHandle>();
  const persistentIds = new Set<string>();
  const handleOf = (id: string): SandboxHandle => handles.get(id) ?? { runId: "", sandboxName: id, sessionId: "" };
  const forget = (id: string): void => {
    parts.bindings.unbind(id);
    handles.delete(id);
    persistentIds.delete(id);
  };
  return {
    async create(id: string, kind: VmKind) {
      const persistent = kind === "agent" && parts.persistent === true;
      if (persistent) persistentIds.add(id);
      try {
        const hooks = parts.hooks?.(); // before the VM exists: a refusal leaves nothing to end
        handles.set(id, await parts.sandbox.createSandbox({ sandboxName: id, retention: { persistent }, timeoutMs: parts.timeoutMs }));
        if (persistent) parts.bindings.unbind(id); // a session's earlier stop left its binding (a stop never unbinds): the handle in it is stale
        parts.bindings.bind(id, await parts.daemon.get(parts.idOf(id)), parts.timeoutMs, hooks); // the daemon's own handle: the token and the guest's streams go through it, by name
      } catch (err) {
        persistentIds.delete(id);
        throw err; // a VM that was made is ended by the caller's teardown (it was registered first)
      }
    },
    async resume(id) {
      // a VM that is up again is bound like one that was made: the token and the guest's streams go through the daemon's handle, by name
      if (parts.sandbox.wake === undefined || parts.persistent !== true) throw new VmPortRefused("resume_unavailable");
      persistentIds.add(id);
      try {
        const hooks = parts.hooks?.();
        await parts.sandbox.wake(handleOf(id), parts.timeoutMs);
        parts.bindings.unbind(id); // the stop that kept this disk left the old handle bound
        parts.bindings.bind(id, await parts.daemon.get(parts.idOf(id)), parts.timeoutMs, hooks);
      } catch (err) {
        persistentIds.delete(id);
        throw err;
      }
    },
    async startEgress(id) {
      if ((await parts.sandbox.sandboxState?.(handleOf(id))) !== "running") throw new VmPortRefused("egress_down");
    },
    async waitGuest(id, signal) {
      signal.throwIfAborted();
      try {
        await parts.sandbox.guestOf(handleOf(id));
      } catch {
        // fx-swallow-ok: replaced by one fixed word; the port's error could hold a name or a path
        throw new VmPortRefused("guest_not_ready");
      }
      signal.throwIfAborted();
    },
    releaseEgress: (id) => parts.policy.release(parts.idOf(id)),
    channel: async (id) => (await parts.daemon.get(parts.idOf(id))).connect(CHANNEL_PORT),
    writeTimedOut: (id) => parts.daemon.hasTimedOutWrite?.(parts.idOf(id)) === true,
    stop: (id) => parts.sandbox.stop(handleOf(id)),
    async destroy(id) {
      if (!persistentIds.has(id)) {
        // nothing to keep: no snapshot exists for a VM that was never persistent, so ending it is the port's own delete
        await parts.sandbox.deleteSandbox(handleOf(id));
        forget(id);
        return;
      }
      if (!(await parts.daemon.teardown(parts.idOf(id)))) throw new VmPortRefused("vm_not_gone");
      await parts.policy.release(parts.idOf(id));
      forget(id);
    },
    async delete(id) {
      await parts.sandbox.deleteSandbox(handleOf(id));
      forget(id);
    },
  };
}
