/**
 * D#845 MC-8b: the runner's receive path for signed machine commands (the Claude sign-in link), carried on a claim reply and acked on the next claim.
 *
 * Each command is checked in this order before anything is run: the signature under this build's pinned keyring and the machine-command purpose string, this runner's own id, its expiry and its life
 * (all inside `verifyMachineCommand`), and single use (a `command_id` seen before is dropped, whatever it asks). A command that fails any of these is dropped without an ack, as sandbox commands are:
 * its fields are not trusted enough to name in a reply, and the cloud ages the row out. The seen ids are kept in a small 0600 file in the state directory (written before the command runs, no link followed,
 * an id forgotten only once its command can no longer verify), so a command the cloud delivers again after a restart is dropped too, a sign-out included. A file that is there but cannot be trusted (a link,
 * another owner, wider than 0600, not what this module wrote) makes the receiver take no command at all. Without a state path (tests) the ids live in memory only.
 *
 * Commands run one after another in the order they arrived, so a code never overtakes the start it belongs to. Every command that passed is acked: `applied`, or `refused` with a fixed reason.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { JobSignatureError, MACHINE_COMMANDS_PER_CLAIM, verifyMachineCommand, type JobKeyring, type MachineCommand, type MachineCommandAck } from "@fulcrumaxe/runner-protocol";
import type { ClaudeLoginRunner, Outcome } from "./claudeLogin.js";

export interface MachineCommandReceiver {
  /** Called with a claim reply's `machine_commands`. Returns when each command has been checked and queued, not when it finished. */
  receive(signed: readonly unknown[]): void;
  /** The acks for the next claim, oldest first. */
  pendingAcks(): MachineCommandAck[];
  /** Call after the cloud answered 200 to the claim that carried `sent`. */
  committed(sent: readonly MachineCommandAck[]): void;
  /** Resolves when every queued command has finished (tests, and a stopping daemon). */
  idle(): Promise<void>;
}

const MAX_PENDING_ACKS = MACHINE_COMMANDS_PER_CLAIM * 4;
/** The most ids held at once. A command lives at most ten minutes and a claim brings at most five, so a full table means something is wrong: the command is dropped (fail closed). */
export const MACHINE_COMMAND_SEEN_CAPACITY = 1024;

const SEEN_FILE_MAX_BYTES = 1_048_576;
const ID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The ids in the state file, with their `expires_at` (ms), only those still live. A missing file is an empty map; `undefined` is a file that is there but cannot be trusted. */
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
    if (!st.isFile() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0 || st.size > SEEN_FILE_MAX_BYTES) return undefined;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    const raw = JSON.parse(buf.toString("utf8")) as { seen?: unknown };
    if (typeof raw.seen !== "object" || raw.seen === null || Array.isArray(raw.seen)) return undefined;
    const out = new Map<string, number>();
    for (const [id, exp] of Object.entries(raw.seen)) {
      if (!ID_SHAPE.test(id) || typeof exp !== "number" || !Number.isSafeInteger(exp) || exp < 0) return undefined;
      if (exp > nowMs) out.set(id, exp);
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

export function createMachineCommandReceiver(config: {
  keyring: JobKeyring;
  runnerId: string;
  now: () => Date;
  login: ClaudeLoginRunner;
  log?: (line: string) => void;
  /** Where the seen ids are kept across restarts (0600). Left out, they live in memory only (tests). */
  statePath?: string;
  /** The owner the state file must have. */
  uid?: number | undefined;
}): MachineCommandReceiver {
  const loaded = config.statePath === undefined ? new Map<string, number>() : loadSeen(config.statePath, config.uid, config.now().getTime());
  const seen = loaded ?? new Map<string, number>();
  if (loaded === undefined) config.log?.("fx-runner: the machine command state file cannot be trusted; machine commands are refused");
  const acks: MachineCommandAck[] = [];
  let chain: Promise<void> = Promise.resolve();

  const run = async (cmd: MachineCommand): Promise<Outcome> => {
    try {
      if (cmd.kind === "claude_login_start") return await config.login.start(cmd.args.request_id);
      if (cmd.kind === "claude_login_code") return await config.login.code(cmd.args.request_id);
      return await config.login.logout();
    } catch {
      // fx-swallow-ok: a handler that throws is reported as a failed command, in fixed words, with nothing of its error text
      return { ok: false, refusal: "failed" };
    }
  };

  return {
    receive(signed) {
      const nowMs = config.now().getTime();
      if (loaded === undefined) return;
      for (const [id, expMs] of seen) if (expMs <= nowMs) seen.delete(id);
      for (const item of signed.slice(0, MACHINE_COMMANDS_PER_CLAIM)) {
        let cmd: MachineCommand;
        try {
          cmd = verifyMachineCommand(item, config.keyring, config.runnerId, config.now());
        } catch (error) {
          // fx-swallow-ok: a command that does not verify is dropped and logged by its fixed code; it is never acted on
          config.log?.(`fx-runner: a machine command was dropped (${error instanceof JobSignatureError ? error.code : "invalid"})`);
          continue;
        }
        if (seen.has(cmd.command_id)) {
          config.log?.("fx-runner: a machine command was dropped (id_reused)");
          continue;
        }
        if (seen.size >= MACHINE_COMMAND_SEEN_CAPACITY) {
          config.log?.("fx-runner: a machine command was dropped (table_full)");
          continue;
        }
        // Recorded (and kept across a restart) before the command runs, so one that fails or hangs can never run a second time.
        seen.set(cmd.command_id, Date.parse(cmd.expires_at));
        if (config.statePath !== undefined) {
          try {
            saveSeen(config.statePath, seen);
          } catch {
            // fx-swallow-ok: an id that cannot be kept across a restart is a command that does not run
            seen.delete(cmd.command_id);
            config.log?.("fx-runner: a machine command was dropped (state_unwritable)");
            continue;
          }
        }
        const commandId = cmd.command_id;
        chain = chain.then(async () => {
          const result = await run(cmd);
          if (acks.length >= MAX_PENDING_ACKS) acks.shift();
          acks.push(result.ok ? { command_id: commandId, outcome: "applied" } : { command_id: commandId, outcome: "refused", refusal: result.refusal });
        });
      }
    },
    pendingAcks: () => acks.slice(0, MAX_PENDING_ACKS),
    committed(sent) {
      const done = new Set(sent.map((a) => a.command_id));
      for (let i = acks.length - 1; i >= 0; i--) if (done.has(acks[i]!.command_id)) acks.splice(i, 1);
    },
    async idle() {
      await chain;
      await config.login.idle();
    },
  };
}
