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

interface Bound { sandbox: TokenSandbox; token: JobToken }

export interface GuestBindingsOptions {
  token?: JobTokenOptions;
  /** The port's wall-clock limit of a sandbox, so a guest command's own limit follows it (`MicrovmSandbox.timeoutMsOf`). */
  timeoutMsOf?: (name: string) => number | undefined;
}

export class GuestBindings {
  private readonly bound = new Map<string, Bound>();
  constructor(private readonly options: GuestBindingsOptions = {}) {}

  /** Called when a VM is created. One binding per name: a name that is still bound is a wiring bug, refused rather than replaced. */
  bind(name: string, sandbox: TokenSandbox): JobToken {
    if (this.bound.has(name)) throw new Error("guest_already_bound");
    const token = new JobToken(sandbox, this.options.token);
    this.bound.set(name, { sandbox, token });
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
    ...(this.options.timeoutMsOf === undefined ? {} : { timeoutMs: () => this.options.timeoutMsOf?.(guest.name) }),
  });
}
