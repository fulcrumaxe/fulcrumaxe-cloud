/**
 * D#587 B-7b: the runner's receive path for signed sandbox commands (stop, delete, reap), carried on a claim reply and acked on the next claim.
 *
 * Before anything reaches the `SandboxLifecycle`, a command must pass, in this order: the signature under this build's pinned keyring and the sandbox
 * purpose string, this runner's own id (a command signed for another runner is a bad signature), its expiry (and a life no longer than a command may have),
 * the name pattern (the schema), and single use (a nonce seen before is dropped, whatever it asks). Single use holds across a restart: the nonces seen, with
 * their `exp`, are kept in a 0600 state file (no-follow, written before the lifecycle runs). When there is no clean state file to check against (it was missing, unreadable or refused), a command whose `exp` is earlier than this
 * process's start plus the longest command life is refused, so a command captured before a restart cannot run when the nonce history is lost. With a clean file the nonces alone decide. A command that fails any of these is dropped
 * without an ack: its fields are not trusted enough to name in a reply, and the cloud ages the row out on its own.
 *
 * The default lifecycle refuses everything. The VM helper's implementation arrives with the daemon that backs it (B-2b-iii); until then a runner that is
 * sent a command answers `unsupported` and touches nothing.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { JobSignatureError, SANDBOX_COMMAND_MAX_LIFE_S, SANDBOX_COMMANDS_PER_CLAIM, verifySandboxCommand, type JobKeyring, type SandboxCommand, type SandboxCommandAck } from "@fulcrumaxe/runner-protocol";

export type LifecycleRefusal = NonNullable<SandboxCommandAck["refusal"]>;
export type LifecycleResult = { ok: true } | { ok: false; refusal: LifecycleRefusal };

/** What the VM helper's daemon provides. Every method is idempotent: a sandbox that is already gone is `{ ok: true }` for delete and stop. */
export interface SandboxLifecycle {
  stop(name: string): Promise<LifecycleResult>;
  delete(name: string): Promise<LifecycleResult>;
  /** Deletes the stopped sandboxes only; a running one is never touched. */
  reapStopped(): Promise<LifecycleResult>;
}

/** The default: this runner has no VM helper behind it, so every command is refused and nothing is changed. */
export const refusingSandboxLifecycle: SandboxLifecycle = {
  stop: async () => ({ ok: false, refusal: "unsupported" }),
  delete: async () => ({ ok: false, refusal: "unsupported" }),
  reapStopped: async () => ({ ok: false, refusal: "unsupported" }),
};

/** The most nonces held at once. A command lives at most about eleven minutes and a claim brings at most five, so a full table means something is wrong: the command is dropped (fail closed). */
export const SANDBOX_NONCE_CAPACITY = 4096;
const MAX_PENDING_ACKS = SANDBOX_COMMANDS_PER_CLAIM * 4;

export interface SandboxCommandReceiver {
  /** Called with a claim reply's `sandbox_commands`. Returns when each command has been checked and started, not when the lifecycle finished. */
  receive(signed: readonly unknown[]): void;
  /** The acks for the next claim, oldest first. */
  pendingAcks(): SandboxCommandAck[];
  /** Call after the cloud answered 200 to the claim that carried `sent`. */
  committed(sent: readonly SandboxCommandAck[]): void;
  /** Resolves when every started command has finished (tests, and a stopping daemon). */
  idle(): Promise<void>;
}

const NONCE_FILE_MAX_BYTES = 1_048_576;
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The nonces in the state file, with `exp` (ms), only those still live. A missing file is an empty map; `undefined` is a file that is there but cannot be trusted. */
function loadSeen(file: string, uid: number | undefined, nowMs: number): Map<string, number> | undefined {
  if (lstatSync(file, { throwIfNoEntry: false }) === undefined) return new Map();
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    // fx-swallow-ok: a link or an unreadable file is "cannot be trusted"; the receiver then takes no command
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0 || st.size > NONCE_FILE_MAX_BYTES) return undefined;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    const raw = JSON.parse(buf.toString("utf8")) as { seen?: unknown };
    if (typeof raw.seen !== "object" || raw.seen === null || Array.isArray(raw.seen)) return undefined;
    const out = new Map<string, number>();
    for (const [nonce, exp] of Object.entries(raw.seen)) {
      if (!UUID_LOWER.test(nonce) || typeof exp !== "number" || !Number.isSafeInteger(exp) || exp < 0) return undefined;
      if (exp > nowMs) out.set(nonce, exp);
    }
    return out;
  } catch {
    // fx-swallow-ok: a file that is not what this module wrote cannot be trusted
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function saveSeen(file: string, seen: ReadonlyMap<string, number>): void {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ v: 1, seen: Object.fromEntries(seen) })}\n`);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // fx-swallow-ok: the temp file is already gone
    }
    throw error;
  }
}

export function createSandboxCommandReceiver(config: {
  keyring: JobKeyring;
  runnerId: string;
  now: () => Date;
  lifecycle?: SandboxLifecycle;
  log?: (line: string) => void;
  /** Where the seen nonces are kept across restarts (0600). Left out, they live in memory only (tests). */
  statePath?: string;
  /** The owner the state file must have. */
  uid?: number | undefined;
}): SandboxCommandReceiver {
  const lifecycle = config.lifecycle ?? refusingSandboxLifecycle;
  const startedMs = config.now().getTime();
  /** Whether a state file was there at start. The start-time guard below applies only when there is none to check a nonce against. */
  const hadStateFile = config.statePath !== undefined && lstatSync(config.statePath, { throwIfNoEntry: false }) !== undefined;
  /** nonce -> the command's `exp` in ms. A nonce is forgotten only once its command can no longer verify. */
  const loaded = config.statePath === undefined ? new Map<string, number>() : loadSeen(config.statePath, config.uid, startedMs);
  const seen = loaded ?? new Map<string, number>();
  if (loaded === undefined) config.log?.("fx-runner: the sandbox command state file cannot be trusted; sandbox commands are refused");
  const acks: SandboxCommandAck[] = [];
  const running = new Set<Promise<void>>();

  const apply = async (cmd: SandboxCommand): Promise<LifecycleResult> => {
    try {
      if (cmd.kind === "reap_sandboxes") return await lifecycle.reapStopped();
      const name = cmd.name;
      if (name === undefined) return { ok: false, refusal: "failed" };
      return cmd.kind === "stop_sandbox" ? await lifecycle.stop(name) : await lifecycle.delete(name);
    } catch {
      // fx-swallow-ok: a lifecycle that throws is reported as a failed command, in fixed words, with nothing of its error text
      return { ok: false, refusal: "failed" };
    }
  };

  return {
    receive(signed) {
      const nowMs = config.now().getTime();
      if (loaded === undefined) return;
      for (const [nonce, expMs] of seen) if (expMs <= nowMs) seen.delete(nonce);
      for (const item of signed.slice(0, SANDBOX_COMMANDS_PER_CLAIM)) {
        let cmd: SandboxCommand;
        try {
          cmd = verifySandboxCommand(item, config.keyring, config.runnerId, config.now());
        } catch (error) {
          // fx-swallow-ok: a command that does not verify is dropped and logged by its fixed code; it is never acted on
          config.log?.(`fx-runner: a sandbox command was dropped (${error instanceof JobSignatureError ? error.code : "invalid"})`);
          continue;
        }
        const expMs = Date.parse(cmd.exp);
        if (!(hadStateFile && loaded !== undefined) && expMs < startedMs + SANDBOX_COMMAND_MAX_LIFE_S * 1000) {
          config.log?.("fx-runner: a sandbox command was dropped (before_start)");
          continue;
        }
        if (seen.has(cmd.nonce)) {
          config.log?.("fx-runner: a sandbox command was dropped (nonce_reused)");
          continue;
        }
        if (seen.size >= SANDBOX_NONCE_CAPACITY) {
          config.log?.("fx-runner: a sandbox command was dropped (nonce_table_full)");
          continue;
        }
        // Recorded before the lifecycle runs, so a command that fails or hangs can never run a second time.
        seen.set(cmd.nonce, expMs);
        if (config.statePath !== undefined) {
          try {
            saveSeen(config.statePath, seen);
          } catch {
            // fx-swallow-ok: a nonce that cannot be kept across a restart is a command that does not run
            seen.delete(cmd.nonce);
            config.log?.("fx-runner: a sandbox command was dropped (state_unwritable)");
            continue;
          }
        }
        const nonce = cmd.nonce;
        const job = apply(cmd).then((result) => {
          if (acks.length >= MAX_PENDING_ACKS) acks.shift();
          acks.push(result.ok ? { nonce, outcome: "applied" } : { nonce, outcome: "refused", refusal: result.refusal });
        });
        const tracked = job.finally(() => running.delete(tracked));
        running.add(tracked);
      }
    },
    pendingAcks: () => acks.slice(0, MAX_PENDING_ACKS),
    committed(sent) {
      const done = new Set(sent.map((a) => a.nonce));
      for (let i = acks.length - 1; i >= 0; i--) if (done.has(acks[i]!.nonce)) acks.splice(i, 1);
    },
    async idle() {
      await Promise.all([...running]);
    },
  };
}
