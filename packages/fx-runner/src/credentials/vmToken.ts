/**
 * The Claude token a microVM job is handed (D#587 B-6-VMTOKEN). The person mints it themselves with the Claude CLI's token command on this
 * machine (the runner never runs that command: this file starts no process) and stores it with `fx-runner credentials set-vm-token`, from a
 * no-echo prompt or standard input, never an argument. It lives in `<state dir>/credentials/claude-vm-token` (see `secretFile.ts` for the file rules).
 * `readVmToken` is the only reader: the file first, the dev environment variable (a getter the entry point supplies, so the environment is never handed over whole) only when the file is missing. Every message is
 * `<code>: <fixed text>` and never holds the token, a path or an error's own words.
 *
 * The one place the mint command's name may appear in the source, and only for local-machine microVM mode: `test/credentialGrep.test.ts` pins that.
 */
import { lstatSync } from "node:fs";
import path from "node:path";
import { CliError } from "../cliError.js";
import { readSecretFile, removeSecretFile, writeSecretFile, type SecretFileSpec } from "./secretFile.js";

export const VM_TOKEN_DIR = "credentials";
export const VM_TOKEN_FILE = "claude-vm-token";
const FILE_MAX_BYTES = 4096;
/**
 * ASSUMPTION from the Spec (Ruling 26.1 moves the real redacted fixture to the first owner-run of `set-vm-token`), not yet confirmed: a minted token starts with this prefix and is 20 to 512 printable characters. A real redacted fixture
 * of a minted token must confirm both at that first owner run (the Team Lead's task); a mismatch is a Spec correction.
 */
export const VM_TOKEN_PREFIX = "sk-ant-oat";
export const VM_TOKEN_MIN = 20;
export const VM_TOKEN_MAX = 512;

export type VmTokenProblem = "vm_token_missing" | "vm_token_format" | "vm_token_unsafe";

const TEXT: Readonly<Record<VmTokenProblem, string>> = {
  vm_token_missing: "no Claude token is stored for virtual machines on this machine; run: fx-runner credentials set-vm-token",
  vm_token_format: `the token must be ${VM_TOKEN_MIN} to ${VM_TOKEN_MAX} printable characters with no spaces, and start with ${VM_TOKEN_PREFIX}`,
  vm_token_unsafe: "the token file or a directory above it is not safe to use",
};

export class VmTokenError extends CliError {
  readonly code: VmTokenProblem;
  constructor(code: VmTokenProblem, reason?: string) {
    super(`${code}: ${reason ?? TEXT[code]}`);
    this.code = code;
  }
}

/** What a terminal is asked. It names the mint command, which the person runs themselves, and the scrollback the token stays in. */
export const VM_TOKEN_PROMPT =
  "Mint a Claude token on this machine yourself (run: claude setup-token), then paste it here (what you type is not shown). " +
  "Afterwards clear your terminal scrollback, which still holds the token the mint command printed.\nToken: ";

/** The refusal when a token is given as an argument (fixed text; nothing of the argument is repeated). */
export const VM_TOKEN_USAGE = "set-vm-token takes no argument and never a token on the command line; it reads the token from a hidden prompt or from standard input";

export const VM_TOKEN_SPEC: SecretFileSpec = {
  dir: VM_TOKEN_DIR,
  file: VM_TOKEN_FILE,
  maxBytes: FILE_MAX_BYTES,
  missing: () => new VmTokenError("vm_token_missing"),
  unsafe: (reason, remedy) => new VmTokenError("vm_token_unsafe", `${reason}; ${remedy ?? "run: fx-runner credentials clear-vm-token"}, then run: fx-runner credentials set-vm-token`),
};

/** The token a person typed or piped: one trailing newline is dropped, then it must have the prefix, fit, and be printable ASCII without spaces. */
export function parseVmToken(raw: string): string {
  const text = raw.replace(/\r?\n$/, "");
  if (text.length < VM_TOKEN_MIN || text.length > VM_TOKEN_MAX || !/^[\x21-\x7e]+$/.test(text) || !text.startsWith(VM_TOKEN_PREFIX)) throw new VmTokenError("vm_token_format");
  return text;
}

/** The stored token. Throws `VmTokenError`: missing, unsafe (link, owner, mode, size) or format (empty file, wrong shape: also reported as unsafe by status). */
export function readVmTokenFile(stateDir: string, uid: number | undefined): string {
  const bytes = readSecretFile(VM_TOKEN_SPEC, stateDir, uid);
  try {
    return parseVmToken(bytes.toString("utf8"));
  } finally {
    bytes.fill(0);
  }
}

export function writeVmToken(stateDir: string, uid: number | undefined, raw: string): void {
  writeSecretFile(VM_TOKEN_SPEC, stateDir, uid, parseVmToken(raw));
}

/** Deletes the file; true when there was one. Safe to repeat. */
export function clearVmToken(stateDir: string, uid: number | undefined): boolean {
  return removeSecretFile(VM_TOKEN_SPEC, stateDir, uid);
}

export type VmTokenStatus = { state: "missing" } | { state: "unsafe" } | { state: "present"; ageDays: number; source: "file" };

/** The file's state, derived from the file on every call. It reads the token to judge its shape but returns no part of it. */
export function vmTokenStatus(stateDir: string, uid: number | undefined, now: number = Date.now()): VmTokenStatus {
  try {
    readVmTokenFile(stateDir, uid);
  } catch (error) {
    // fx-swallow-ok: the state itself is the answer (missing or unsafe); the error's words are never shown
    if (error instanceof VmTokenError && error.code === "vm_token_missing") return { state: "missing" };
    return { state: "unsafe" };
  }
  const mtime = lstatSync(path.join(stateDir, VM_TOKEN_DIR, VM_TOKEN_FILE)).mtimeMs;
  return { state: "present", ageDays: Math.max(0, Math.floor((now - mtime) / 86_400_000)), source: "file" };
}

/**
 * The one read of the model token for a VM run: a fresh buffer on each call, zeroed by the token step after the send. The file first; the environment
 * variable only when the file is missing (a foreground dev run). A file that is unsafe or the wrong shape gives an empty buffer, which the token step
 * refuses: never a fall back to the variable. A missing token is an empty buffer too.
 */
export function readVmToken(stateDir: string, uid: number | undefined, envToken: () => string | undefined): Buffer {
  try {
    return Buffer.from(readVmTokenFile(stateDir, uid), "utf8");
  } catch (error) {
    // fx-swallow-ok: a bad file is an empty buffer, which the token step refuses; only a missing file falls through to the dev variable
    if (!(error instanceof VmTokenError) || error.code !== "vm_token_missing") return Buffer.alloc(0);
  }
  return Buffer.from(envToken() ?? "", "utf8");
}
