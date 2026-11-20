/**
 * The approved check, run in a guest the agent NEVER had (D#587 B-5b item 4, TL ruling 12). The agent has passwordless sudo in its own VM, so a verdict taken there could be
 * made by whatever it left running. For a VM run the flow is: the agent's VM runs; its bundle comes out and the host applies and checks it on the host copy; every host step
 * runs on that updated copy; the host archives the new tip (`buildWorkspaceArchive`, attribute-free, exactly as it archives the start commit) into a FRESH VM made for this
 * check alone (`createFreshVmCheck`); the check runs there, and the HOST reads the exit code and decides pass or fail. The fresh VM is deleted when the check ends.
 *
 * What the check runs is the same command the host would run: the job's signed `check.argv`, as separate arguments (no shell string), in the guest's workspace, under the clean guest
 * environment, with the job's own time limit and the network rules the agent's VM had. What it reports has the host run's shape (`DoneCheck`): exit code, duration, timed-out
 * flag, skipped-test count, and a summary that is a header (the failed test files and their hints, then the closed `CHECK_HEADER_END` line) followed by the last bytes of the
 * output, redacted, with the guest workspace path replaced.
 *
 * What is the same as the host step: the files the vector names inside the checkout are put back to their content at the merge-base for the run (as bytes, never re-encoded)
 * and given back to the branch afterwards (CWE-345), and a link or a non-file on a pinned path fails the check (`pin_failed`).
 * What is different, and why: the host step also snapshots the workspace's protected files and version-control state before and after. In a fresh VM that guard is not needed:
 * nothing of the agent's is there to compare, and nothing the check does leaves the VM (the host workspace is never written by it).
 */
import { CHECK_HEADER_END, CHECK_SUMMARY_MAX_BYTES, redactShapes, type Check, type CheckNotRunReason, type DoneCheck } from "@fulcrumaxe/runner-protocol";
import { createFailedFiles, normalised, skippedTests, type CheckOutcome } from "../../daemon/checkStep.js";
import type { CreateSandboxOptions, NetworkRule, SandboxHandle } from "../../sandbox/port.js";
import type { SdkSandbox } from "../sandboxd/sdkSlice.js";
import { guestEnvOf } from "../sandboxd/guestEnv.js";
import { policyOf } from "../sandboxd/microvmSandbox.js";
import { DEFAULT_GUEST_PATHS, runInGuest, sendWorkspace, type GuestPaths, type WorkspaceArchive } from "./guestWorkspace.js";

/** How much raw output is kept before redaction, as on the host. */
const RAW_TAIL_CHARS = 32 * 1024;
const MAX_PINNED = 16;

export interface GuestCheckInput {
  check: Check;
  guest: SdkSandbox;
  /** The bytes of `relative` at the pin, or null when it is not a file there (the host's `baseFile`). Throws when they cannot be read exactly. */
  baseFile: (relative: string) => Promise<Buffer | null>;
  now: () => Date;
  paths?: GuestPaths;
  /** A stop (a lost lease, a cancel): the check's command is killed at once and the result never passes. */
  signal?: AbortSignal;
}

const SAVE = [
  "set -eu",
  'W=$1; S=$2; shift 2',
  // both directories are made here, by the agent user: the guest's file transfer would make a missing one as root, and the cleanup after could not remove its files
  'rm -rf "$S/pins" "$S/pin-in"; mkdir -p "$S/pins" "$S/pin-in"',
  'RW=$(realpath -m -- "$W")',
  "i=0",
  'for rel in "$@"; do',
  '  p="$W/$rel"',
  '  [ "$(realpath -m -- "$p")" = "$RW/$rel" ] || exit 3',
  '  if [ -L "$p" ] || [ -d "$p" ]; then exit 3; fi',
  '  if [ -f "$p" ]; then cp -p -- "$p" "$S/pins/$i"; else : >"$S/pins/$i.absent"; fi',
  "  i=$((i+1))",
  "done",
].join("\n");

/** Puts each pinned file in place from the base64 text the host wrote (bytes, never re-encoded), then gives it the mode the agent's copy had. */
const PLACE = [
  "set -eu",
  'W=$1; S=$2; shift 2',
  "i=0",
  'for rel in "$@"; do',
  '  mkdir -p -- "$(dirname -- "$W/$rel")"',
  '  base64 -d "$S/pin-in/$i.b64" >"$W/$rel"',
  '  if [ -f "$S/pins/$i" ]; then chmod --reference="$S/pins/$i" -- "$W/$rel"; fi',
  "  i=$((i+1))",
  "done",
  'rm -rf "$S/pin-in"',
].join("\n");

const RESTORE = [
  "set -u",
  'W=$1; S=$2; shift 2',
  "bad=0; i=0",
  'for rel in "$@"; do',
  '  p="$W/$rel"',
  '  if [ -f "$S/pins/$i" ]; then cp -p -- "$S/pins/$i" "$p" || bad=1',
  '  elif [ -f "$S/pins/$i.absent" ]; then rm -f -- "$p" || bad=1; fi',
  "  i=$((i+1))",
  "done",
  'rm -rf "$S/pins"',
  "exit $bad",
].join("\n");

function lastBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  return bytes.subarray(bytes.length - max).toString("utf8").replace(/^�+/, "");
}

/** The pinned names in a vector: each argument that is a plain repo-relative file name. Order kept, repeats dropped, at most `MAX_PINNED`. */
export function pinnedNames(argv: readonly string[]): string[] {
  const names: string[] = [];
  for (const arg of argv) {
    const rel = normalised(arg);
    if (rel !== undefined && !names.includes(rel) && names.length < MAX_PINNED) names.push(rel);
  }
  return names;
}

export async function runGuestCheck(input: GuestCheckInput): Promise<CheckOutcome> {
  const started = input.now().getTime();
  const paths = input.paths ?? DEFAULT_GUEST_PATHS;
  const elapsed = (): number => Math.max(0, input.now().getTime() - started);
  const closed = (reason: CheckNotRunReason, summary: string): CheckOutcome => ({ passed: false, body: { exit_code: null, duration_ms: elapsed(), timed_out: false, skipped_tests: null, summary: lastBytes(`${summary}\n${CHECK_HEADER_END}\n`, CHECK_SUMMARY_MAX_BYTES), reason } });
  const { argv, timeout_s } = input.check;
  if (argv.length === 0 || argv.some((a) => typeof a !== "string" || a.includes("\0") || a.length > 4096)) return closed("start_failed", "the check could not be started");
  const names = pinnedNames(argv);
  const pins: Array<{ rel: string; bytes: Buffer }> = [];
  try {
    for (const rel of names) {
      const bytes = await input.baseFile(rel);
      if (bytes !== null) pins.push({ rel, bytes });
    }
  } catch {
    // fx-swallow-ok: a file that cannot be read exactly is not pinned, so the check is not run; the error text could hold a path
    return closed("pin_failed", "the check was not run: its files could not be pinned to the default branch");
  }
  const toPin = pins.map((p) => p.rel);
  const common = [paths.workspace, paths.stage];
  let saved = false;
  const restore = async (): Promise<string[]> => {
    if (!saved) return [];
    const back = await runInGuest(input.guest, { cmd: "sh", args: ["-c", RESTORE, "fx-restore", ...common, ...toPin] }, 60_000).catch(() => undefined); // fx-swallow-ok: an unreachable guest means the files were not given back, which is what the result says
    return back?.exitCode === 0 ? [] : toPin;
  };
  try {
    if (toPin.length > 0) {
      const save = await runInGuest(input.guest, { cmd: "sh", args: ["-c", SAVE, "fx-save", ...common, ...toPin] }, 60_000);
      saved = save.exitCode === 0;
      if (!saved) return closed("pin_failed", "the check was not run: these files could not be pinned (a link or a non-file on the path)");
      // the bytes go over as base64 text and are decoded in the guest: a file that is not UTF-8 reaches the check exactly as the default branch has it
      await input.guest.writeFiles(pins.map((p, i) => ({ path: `${paths.stage}/pin-in/${String(i)}.b64`, content: p.bytes.toString("base64"), mode: 0o644 })));
      const placed = await runInGuest(input.guest, { cmd: "sh", args: ["-c", PLACE, "fx-place", ...common, ...toPin] }, 60_000);
      if (placed.exitCode !== 0) throw new Error("pin_not_placed");
    }
  } catch {
    // fx-swallow-ok: a pin that failed part way is given back below; the error text could hold a path
    const lost = await restore();
    return closed("pin_failed", `the check was not run: its files could not be pinned to the default branch${lost.length === 0 ? "" : `; not given back: ${lost.join(", ")}`}`);
  }
  const failedFiles = createFailedFiles(paths.workspace);
  let tail = "";
  const ran = await runInGuest(input.guest, { cmd: argv[0] as string, args: argv.slice(1), cwd: paths.workspace, env: guestEnvOf({}) }, timeout_s * 1000, RAW_TAIL_CHARS, (_stream, text) => {
    tail = (tail + text).slice(-RAW_TAIL_CHARS);
    for (const line of text.split("\n")) failedFiles.line(line);
  }, input.signal).catch(() => undefined); // fx-swallow-ok: a check that could not be started did not pass; the error text could hold a path
  const lost = await restore();
  if (ran === undefined) return closed("start_failed", `the check could not be started${lost.length === 0 ? "" : `; not given back: ${lost.join(", ")}`}`);
  const aborted = input.signal?.aborted === true || ran.aborted === true;
  const failed = ran.exitCode !== 0 || ran.timedOut || aborted;
  let shown = redactShapes(tail).split(paths.workspace).join("<workspace>");
  shown = shown.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, " ");
  const named = failed && !ran.timedOut && !aborted ? failedFiles.list() : { files: [], more: 0 };
  const failedList = named.files.length === 0 ? {} : { failed_files: named.files, ...(named.more === 0 ? {} : { failed_files_more: named.more }) };
  const header = [failed ? failedFiles.summary() : "", failed ? failedFiles.hints() : "", lost.length === 0 ? "" : `check files not given back to the branch: ${lost.join(", ")}\n`, `${CHECK_HEADER_END}\n`].join("");
  const summary = `${header}${lastBytes(shown, CHECK_SUMMARY_MAX_BYTES - Buffer.byteLength(header))}`;
  const reason: CheckNotRunReason | undefined = lost.length > 0 ? "not_restored" : undefined;
  const body: DoneCheck = { exit_code: ran.timedOut || aborted ? null : ran.exitCode, duration_ms: elapsed(), timed_out: ran.timedOut, skipped_tests: skippedTests(tail), summary: lastBytes(summary, CHECK_SUMMARY_MAX_BYTES).replace(/\u0000/g, ""), ...(reason === undefined ? {} : { reason }), ...failedList };
  return { passed: ran.exitCode === 0 && !ran.timedOut && !aborted && lost.length === 0, body };
}

/** The port calls a fresh check VM needs: the microVM port's own, nothing more. */
export interface FreshCheckPort {
  createSandbox(opts: CreateSandboxOptions): Promise<SandboxHandle>;
  deleteSandbox(handle: SandboxHandle): Promise<void>;
  /** The running guest of a sandbox (`MicrovmSandbox.guestOf`). */
  guestOf(handle: SandboxHandle): Promise<SdkSandbox>;
}

export interface FreshCheckInput {
  runId: string;
  check: Check;
  /** A repository the runner owns that holds `tip` (the job's host workspace after the verified bundle was brought in). */
  repoDir: string;
  /** The commit the check runs on: the host's own tip, read the way the push reads it. */
  tip: string;
  baseFile: (relative: string) => Promise<Buffer | null>;
  /** The network rules the agent's VM ran under; the check VM gets exactly these. */
  networkPolicy: readonly NetworkRule[];
  signal?: AbortSignal;
}

/** Time the fresh VM may take beyond the check's own limit: boot, the unpack, the pins. */
const SETUP_MARGIN_MS = 30 * 60_000;

/**
 * The approved check in a FRESH VM (TL ruling 12). A guest the agent never had: made from the image, given the archive of the host's new tip, and deleted when the check ends.
 * The host decides the verdict from what the check reports there. Any failure to get that far is a closed `CheckNotRunReason`, never a pass.
 */
export function createFreshVmCheck(deps: { port: FreshCheckPort; archive: (repoDir: string, commit: string) => Promise<WorkspaceArchive>; now: () => Date; maxTimeoutMs: number; paths?: GuestPaths }): (input: FreshCheckInput) => Promise<CheckOutcome> {
  return async (input) => {
    const failed = (reason: CheckNotRunReason, summary: string): CheckOutcome => ({ passed: false, body: { exit_code: null, duration_ms: 0, timed_out: false, skipped_tests: null, summary: `${summary}\n${CHECK_HEADER_END}\n`, reason } });
    if (input.check.dev_shell) return failed("sandbox_refused", "the check needs the repository's Nix dev shell, which a microVM does not have");
    if (input.signal?.aborted === true) return failed("start_failed", "the check could not be started");
    let archive: WorkspaceArchive;
    try {
      archive = await deps.archive(input.repoDir, input.tip);
    } catch {
      // fx-swallow-ok: replaced by a closed reason; the error text could hold a path
      return failed("start_failed", "the check could not be started: the new tip could not be archived");
    }
    let handle: SandboxHandle | undefined;
    try {
      // a name of its own: the agent's VM is `rn-<run>`, and this one is never it
      handle = await deps.port.createSandbox({ sandboxName: `rc-${input.runId}`, retention: { persistent: false }, timeoutMs: Math.min(input.check.timeout_s * 1000 + SETUP_MARGIN_MS, deps.maxTimeoutMs) });
      const guest = await deps.port.guestOf(handle);
      await guest.updateNetworkPolicy(policyOf([...input.networkPolicy]));
      try {
        await sendWorkspace(guest, archive, deps.paths);
      } catch {
        // fx-swallow-ok: replaced by a closed reason; the error text could hold a path
        return failed("start_failed", "the check could not be started: the new tip could not be sent into the check VM");
      }
      return await runGuestCheck({ check: input.check, guest, baseFile: input.baseFile, now: deps.now, ...(deps.paths === undefined ? {} : { paths: deps.paths }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
    } catch {
      // fx-swallow-ok: replaced by a closed reason; the error text could hold a name or a path
      return failed("sandbox_unavailable", "the sandbox could not start the check");
    } finally {
      if (handle !== undefined) await deps.port.deleteSandbox(handle).catch(() => undefined); // fx-swallow-ok: a VM that cannot be deleted now ends with its own timer; the verdict stands
    }
  };
}
