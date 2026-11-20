/**
 * The job's model credential in an agent VM (D#587 B-5b-3c). A thin discipline over the sandbox's `deliverToken` (token to a 0700 tmpfs over
 * vsock) and `wipeToken` (file removed, every token cgroup killed and checked empty): the token is delivered once at agent start, only commands
 * this module launches can read it, and it is wiped, with the guest's confirmation, before the VM is stopped, snapshotted, quiesced or bundled.
 *
 * What it guarantees: the token never enters argv, env, a log or an error here (errors are one of two fixed codes with no cause and no text); the
 * buffer the caller's `read` returns is owned by this module and zeroed when delivery settles or is given up on; a wipe the guest does not
 * confirm latches the state, and `stop` then deletes the VM instead of stopping or snapshotting it. What it does not cover (Ruling 7): a copy a
 * holder writes on purpose to disk or the network, and the caller's own source of the token, which `read` must hand over as a fresh buffer.
 */
import type { CommandSpec, SandboxdCommand } from "./command.js";

/** The only two ways this module ends a job; each is a closed code of criterion 23, with no free text. */
export type JobTokenCode = "vm_token_delivery_failed" | "vm_teardown_incomplete";
export class JobTokenError extends Error {
  constructor(readonly code: JobTokenCode) {
    super(code);
    this.name = "JobTokenError";
  }
}

/** The slice of the sandbox handle this module uses. */
export interface TokenSandbox {
  deliverToken(token: Buffer): Promise<void>;
  wipeToken(): Promise<void>;
  runCommand(spec: CommandSpec & { signal?: AbortSignal }): Promise<SandboxdCommand>;
  stop(): Promise<void>;
  delete(): Promise<void>;
}

export interface JobTokenOptions { deliverMs?: number; wipeMs?: number }
const DEFAULT_MS = 30_000;

/** Settles with `work`, or fails when `ms` pass or `signal` aborts; the timer and the listener are always released. The work itself is not cancelled. */
function bounded<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const giveUp = (): void => done(() => reject(new Error("unconfirmed")));
    const timer = setTimeout(giveUp, ms);
    const done = (finish: () => void): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", giveUp);
      finish();
    };
    if (signal?.aborted === true) return giveUp();
    signal?.addEventListener("abort", giveUp, { once: true });
    work.then((v) => done(() => resolve(v)), (e: unknown) => done(() => reject(e)));
  });
}

type Launch = Omit<CommandSpec, "withToken" | "user"> & { signal?: AbortSignal };

export class JobToken {
  /** idle: no token in the guest. held: one may be there. blocked: a wipe was not confirmed, so the VM may still hold it. */
  private state: "idle" | "held" | "blocked" = "idle";
  private wiping: Promise<void> | undefined;

  constructor(private readonly sandbox: TokenSandbox, private readonly options: JobTokenOptions = {}) {}

  /** Delivers one token, from a fresh buffer `read` returns. Any failure (read, refusal, timeout, abort) wipes at once and ends with `vm_token_delivery_failed`. */
  async deliver(read: () => Buffer, signal?: AbortSignal): Promise<void> {
    if (this.state === "blocked") throw new JobTokenError("vm_teardown_incomplete");
    if (this.state !== "idle" || signal?.aborted === true) throw new JobTokenError("vm_token_delivery_failed");
    let token: Buffer | undefined;
    try {
      token = read();
      if (!Buffer.isBuffer(token) || token.length === 0) throw new Error("no token");
      this.state = "held"; // before the put: a put that is abandoned in flight may still land
      await bounded(this.sandbox.deliverToken(token), this.options.deliverMs ?? DEFAULT_MS, signal);
    } catch {
      // fx-swallow-ok: replaced by the one fixed code; nothing about the token or the cause may travel
      token?.fill(0);
      await this.wipe().then(() => undefined, () => undefined); // fx-swallow-ok: an unconfirmed wipe stays latched as `blocked`, and `stop` then deletes
      throw new JobTokenError("vm_token_delivery_failed");
    }
    token.fill(0);
  }

  /** The only way a token-reading command starts: always `withToken`, always the ordinary user, only while a delivery is held and no wipe has begun. */
  launch(spec: Launch): Promise<SandboxdCommand> {
    if (this.state !== "held" || this.wiping !== undefined) return Promise.reject(new JobTokenError("vm_token_delivery_failed"));
    return this.sandbox.runCommand({ ...spec, withToken: true, user: "ubuntu" });
  }

  /**
   * Call before any stop, snapshot, quiesce or bundle-out. Resolves when the guest confirmed that no token file and no holder is left (or none
   * was ever delivered); otherwise rejects with `vm_teardown_incomplete` and the state stays `blocked`. One wipe at a time; a later call retries.
   */
  wipe(): Promise<void> {
    if (this.state === "idle") return Promise.resolve();
    this.wiping ??= bounded(this.sandbox.wipeToken(), this.options.wipeMs ?? DEFAULT_MS).then(
      () => void (this.state = "idle"),
      () => {
        this.state = "blocked";
        throw new JobTokenError("vm_teardown_incomplete");
      },
    ).finally(() => void (this.wiping = undefined));
    return this.wiping;
  }

  /** Wipes, then stops (a snapshot, where the sandbox is configured for one). An unconfirmed wipe never reaches `stop`: the VM is deleted instead. */
  async stop(): Promise<void> {
    try {
      await this.wipe();
    } catch (err) {
      await this.sandbox.delete().then(() => undefined, () => undefined); // fx-swallow-ok: the fixed code below is the report; the teardown table retries a failed delete
      throw err;
    }
    await this.sandbox.stop();
  }
}

/** Delivers, runs `run`, and wipes on every way out (return, throw, abort, timeout); a failed wipe replaces whatever `run` ended with. */
export async function withJobToken<T>(jobToken: JobToken, read: () => Buffer, run: (token: JobToken) => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    await jobToken.deliver(read, signal);
    return await run(jobToken);
  } finally {
    await jobToken.wipe();
  }
}
