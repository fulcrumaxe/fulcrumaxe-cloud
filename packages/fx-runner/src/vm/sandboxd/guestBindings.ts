/**
 * The per-sandbox bindings of a microVM job (D#587 B-5b-3c-i): sandbox name -> the daemon's sandbox handle and the job's `JobToken` over it.
 *
 * Why it exists: the guest runtime is built by `guestMakeRuntime` from the Vercel-shaped `SdkSandbox` slice, which has no stdin, no user, no token flag and no
 * stream, and which must not be widened (it is held to the real Vercel type). The daemon's own handle has all of those, so the wiring registers the handle here
 * when it creates a VM, and the runtime's `launch` reaches it by the sandbox's name. The token is therefore on one path only: `JobToken.deliver` (the lifecycle's
 * token step), `JobToken.launchStream` (the CLI's one launch, always the ordinary user), `JobToken.wipe` (the lifecycle's quiesce). Every other command the
 * runtime starts goes through the handle's plain stream and carries no token.
 *
 * Nothing here reads `process.*` or starts a process. The token's source is injected as `read`, a function that returns a fresh buffer (the bin edge reads the
 * runner's own credential, as `cleanEnv` does for the host path).
 */
import type { TokenSlot } from "../jobLifecycle.js";
import type { GuestBinding, GuestLaunch } from "./guestRuntime.js";
import { JobToken, JobTokenError, type JobTokenOptions, type TokenSandbox } from "./jobToken.js";
import type { SdkSandbox } from "./sdkSlice.js";

/** The sinks one run's guest events go to: its usage gate and its relay (the OS-sandbox path's `onLocalEvent` and `onNearLimit`). */
export interface RunEventHooks {
  onLocalEvent: NonNullable<GuestBinding["onLocalEvent"]>;
  onNearLimit: NonNullable<GuestBinding["onNearLimit"]>;
}

/**
 * The late-bound source of `RunEventHooks`: the entry point's stack is built before the run's usage gate and relay exist, so `run` attaches the factory once they do. A VM made before
 * that, or by a build that never attaches, is refused (`guest_hooks_unattached`), never run without the sinks: spend and usage-limit reporting depend on them.
 */
export class GuestRunHooks {
  private make: ((runId: string) => RunEventHooks) | undefined;
  attach(make: (runId: string) => RunEventHooks): void {
    this.make = make;
  }
  forRun(runId: string): RunEventHooks {
    if (this.make === undefined) throw new Error("guest_hooks_unattached");
    return this.make(runId);
  }
}

interface Bound { sandbox: TokenSandbox; token: JobToken; timeoutMs?: number; hooks?: RunEventHooks }

export interface GuestBindingsOptions {
  token?: JobTokenOptions;
  /** The port's wall-clock limit of a sandbox, so a guest command's own limit follows it (`MicrovmSandbox.timeoutMsOf`). */
  timeoutMsOf?: (name: string) => number | undefined;
}

export class GuestBindings {
  private readonly bound = new Map<string, Bound>();
  constructor(private readonly options: GuestBindingsOptions = {}) {}

  /**
   * Called when a VM is created. One binding per name: a name that is still bound is a wiring bug, refused rather than replaced. `timeoutMs` is the wall-clock limit the VM was
   * made with; the guest runtime's own command limit follows it (FU-170), so a long job is not cut short and a short one is not left running on a fixed fallback.
   */
  bind(name: string, sandbox: TokenSandbox, timeoutMs?: number, hooks?: RunEventHooks): JobToken {
    if (this.bound.has(name)) throw new Error("guest_already_bound");
    const token = new JobToken(sandbox, this.options.token);
    this.bound.set(name, { sandbox, token, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(hooks === undefined ? {} : { hooks }) });
    return token;
  }

  /** Called when the VM is deleted or destroyed. Safe to repeat. */
  unbind(name: string): void {
    this.bound.delete(name);
  }

  tokenOf(name: string): JobToken | undefined {
    return this.bound.get(name)?.token;
  }

  /** The lifecycle's token step for one VM: `deliver` reads a fresh buffer and sends it, `wipe` resolves only when the guest confirmed that none is left. */
  slot(name: string, read: () => Buffer): TokenSlot {
    const of = (): JobToken => {
      const token = this.tokenOf(name);
      if (token === undefined) throw new JobTokenError("vm_token_delivery_failed");
      return token;
    };
    return { deliver: async (signal) => of().deliver(read, signal), wipe: async () => of().wipe() };
  }

  /** The runtime's `launch` for one VM: the CLI's token spec goes through `launchStream`, every other spec through the plain stream with the token flag off. */
  launch(name: string): GuestLaunch {
    return (spec) => {
      const bound = this.bound.get(name);
      if (bound === undefined) return Promise.reject(new JobTokenError("vm_token_delivery_failed"));
      const { withToken, ...rest } = spec;
      if (withToken === true) return bound.token.launchStream(rest);
      return bound.sandbox.runStream({ ...rest, withToken: false });
    };
  }

  /** What `guestMakeRuntime` takes as its `bind`: the runtime for a guest gets that guest's launch, found by name. */
  readonly binding = (guest: SdkSandbox): GuestBinding => ({
    launch: this.launch(guest.name),
    // the run's usage and relay sinks, as bound with the VM: `guestMakeRuntime` spreads them into the runtime's config
    ...this.bound.get(guest.name)?.hooks,
    // always passed (FU-170): the limit this VM was bound with, else the port's own answer, else the runtime's bounded fallback
    timeoutMs: () => this.bound.get(guest.name)?.timeoutMs ?? this.options.timeoutMsOf?.(guest.name),
  });
}
