/**
 * D#6 R-CHK-2 (C47): the runner's check step. When a signed job carries `check`, the runner runs exactly that argument vector after the agent's last turn.
 *
 * Threat model (the runner executes a platform-signed command on the customer's machine):
 *  - the command is the job's `check`, which `verifyJob` has already verified (signature, expiry); nothing is read from the branch and nothing from the agent;
 *  - it is an argument vector, never a shell string: it is handed to the sandbox tool as separate arguments after `--` (no `sh -c`, no interpolation);
 *  - it runs under the job's own sandbox rules (the settings the agent got: filesystem, allowances, the Nix store view) plus no network and a seccomp filter that refuses
 *    Unix-domain sockets, as for the agent; a platform or machine where that cannot be applied fails the check (`launch` answers `refused`), it never runs weaker.
 *    The environment is built from the clean allowlist, minus every model credential and the agent CLI's env file. It also tells pnpm to work offline and to skip the
 *    release-age lookup that needs registry metadata (`HostSandbox.checkLaunch`): a dependency install that needs the network then fails at once with a named error
 *    instead of waiting on a connection that cannot be made. This loosens nothing: the network and every file access are as before. Its `HOME` is a fresh empty directory
 *    inside the job's own temp directory, holding the same pnpm settings as files (no dependency check before a script, the job's store) and an empty `.npmrc`, because the
 *    pnpm commands a test starts get a filtered environment that keeps `HOME` and drops those settings (`checkHome.ts`); it never sets `CI` or turns off the purge prompt,
 *    so a nested install still cannot delete `node_modules`;
 *  - the files the vector names inside the checkout (`scripts/check.sh`) are put back to their content at the merge-base of the job's branch tip with the repository's
 *    default branch (as the runner fetched it) for the run and given back to the branch afterwards (CWE-345). The merge-base, never the tip: a fix round's tip holds the
 *    previous round's edits, and no branch commit is in the default branch's history. Paths are normalised first (`./scripts/check.sh` is `scripts/check.sh`); `..`,
 *    an absolute path or an option is not a file name. A symlink anywhere on a pinned path, or content that cannot be read byte-exact, fails the check (CWE-59). Files such a
 *    script itself loads stay the branch's; they are inside the sandbox like any other code of the branch, and the CI of the public repository remains the final gate;
 *  - the give-back runs on the host, after the check: each parent directory is checked again (not a link, same device and inode as when pinned) and the file is created
 *    without following a link; a path that fails either test is not written, the check fails and the path is named in the summary;
 *  - its own time cap ends the whole process group (SIGTERM, then SIGKILL); a stop from the cloud or a shutdown does the same;
 *  - what is reported is a closed shape: exit code, duration, timed-out flag, the skipped-test count, and the last 4096 bytes of output after credential-shape
 *    redaction, with the workspace and home paths replaced. When the check fails, one line ahead of that output names the test files the runner's output reported as failed
 *    (vitest's `FAIL path`, pytest's `FAILED path::test`), picked out of the WHOLE output as it streams and not only its tail: a plain relative file name each, at most 40,
 *    first-seen order, the rest counted, 1500 bytes at most, redacted like the rest. A second line, `changed files (N): ...`, names the paths the branch changed against the
 *    default branch's merge-base (read with the same guarded git as the version-control digest, after the check), in the same closed shape: sorted, at most 40, 1000 bytes,
 *    N counting every path so a reader can tell a cut list from a whole one. The cloud compares the two lines: a check that failed only in files the change did not touch
 *    needs a person, not a fix round. Left out when the check passed or was stopped, or when git could not say.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeSync, type Stats } from "node:fs";
import path from "node:path";
import { CHECK_FAILED_FILE_CHARS, CHECK_FAILED_FILES_MAX, CHECK_SUMMARY_MAX_BYTES, redactShapes, type Check, type CheckNotRunReason, type DoneCheck } from "@fulcrumaxe/runner-protocol";
import type { InstallCapture } from "./engineKit.js";
import { GitPathError, guardConfigEnv, type GitCapture } from "./git.js";
import { gitEnv, type CleanEnvOptions } from "../job/cleanEnv.js";
import { HostReadSession, hostGit, readWorkspaceGit } from "./hostRead.js";
import { protectedRootNames, VCS_DIR } from "../sandbox/checkProtected.js";

/** How much raw output is kept before redaction; the summary is cut to `CHECK_SUMMARY_MAX_BYTES` afterwards. */
const RAW_TAIL_CHARS = 32 * 1024;
/** What a package manager or a program prints when it asked for the network and there is none (pnpm in offline mode, or a connection that cannot be made). */
const NETWORK_REFUSED = /ERR_PNPM_NO_OFFLINE|ENETUNREACH|EADDRNOTAVAIL|EAI_AGAIN/;
const NAMED_FILE = /^[A-Za-z0-9_@+][A-Za-z0-9_./@+-]{0,255}$/;

/** `./scripts//check.sh` -> `scripts/check.sh`. Undefined for what is not a plain repo-relative file name: an option, an absolute path, `..`. */
export function normalised(arg: string): string | undefined {
  if (arg.startsWith("/")) return undefined;
  const parts = arg.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return undefined;
  const joined = parts.join("/");
  return NAMED_FILE.test(joined) ? joined : undefined;
}

/** What the sandbox gives for the vector: the tool, its arguments, the environment, and bytes for the tool's descriptor 3 (a seccomp filter). */
export type CheckLaunch = { tool: string; args: string[]; env: Record<string, string>; feed?: Buffer };
/** The sandbox refuses to run the check here, with the words the summary carries. */
export type CheckRefused = { refused: string };

export interface CheckStepInput {
  check: Check;
  workspace: string;
  /** The commit the named files are pinned to: the merge-base of the job's branch tip with the default branch. */
  base: string;
  launch: (argv: readonly string[], devShell: boolean) => CheckLaunch | CheckRefused | undefined;
  /** The bytes of `relative` at `base` in the repository `dir`, or null when it is not a file there. Throws when they cannot be read exactly. */
  baseFile: (dir: string, base: string, relative: string) => Promise<Buffer | null>;
  /** The repository the base commit is read from (the runner's mirror, which holds the default branch). */
  baseDir: string;
  home?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface CheckStepDeps {
  capture: InstallCapture;
  now: () => Date;
  /** A digest of the workspace's version-control state that a commit, a branch move or a reset would change (HEAD and every ref). Throws when it cannot be read. */
  vcsState: (workspace: string) => Promise<string>;
  /**
   * The paths the workspace changes against `base` (tracked changes and new files), or null when git could not say. Read only after a check has failed, to name them in
   * the summary's header. Optional: a daemon without it sends no such line, and the cloud then treats a failed check as it always did.
   */
  changedFiles?: (workspace: string, base: string) => Promise<string[] | null>;
}

export type CheckOutcome = { passed: boolean; body: DoneCheck; /** Set when the check was not run because the dev shell is missing. */ noDevShell?: true };

/** `Tests  12 passed | 3 skipped (15)` -> 3. Null when the output has no such line. */
export function skippedTests(output: string): number | null {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  let found: number | null = null;
  for (const line of plain.split("\n")) {
    const match = line.match(/^\s*Tests\s.*?(\d+) skipped/);
    if (match) found = Number(match[1]);
  }
  return found;
}

/** A test file that failed, as a test runner prints it: vitest's `FAIL  [|project| ]path > test name` (also behind a `pkg test:` prefix) and pytest's `FAILED path::test`. */
const FAILED_FILE = /(?:^|[\s:])(?:FAIL {1,3}(?:\|[^|\s]+\|\s+)?|FAILED +)(\S+?\.(?:[cm]?[jt]sx?|py|sh|bats))(?:::|\s|$)/;
/** How many failed test files, and how many bytes of their names, the summary names. */
const FAILED_FILES_MAX = 40;
const FAILED_FILES_BYTES = 1500;

/**
 * Picks the failed test files out of the whole output of a check, line by line as it arrives (the summary keeps only the end of the output, and a long run's failures
 * are printed far above it). Closed shape: only a plain relative file name (`NAMED_FILE`, the workspace prefix removed first) is ever kept, first-seen order, at most
 * `FAILED_FILES_MAX` of them; the rest are counted.
 */
export function createFailedFiles(workspace: string): { line: (text: string) => void; summary: () => string; list: () => { files: string[]; more: number } } {
  const seen = new Set<string>();
  let more = 0;
  return {
    line(text) {
      const match = text.replace(/\u001b\[[0-9;]*m/g, "").match(FAILED_FILE);
      if (match === null) return;
      let file = match[1] ?? "";
      if (file.startsWith(`${workspace}/`)) file = file.slice(workspace.length + 1);
      if (!NAMED_FILE.test(file) || seen.has(file)) return;
      if (seen.size < FAILED_FILES_MAX) seen.add(file);
      else more += 1;
    },
    /**
     * D#6 CHECK-FAILFILES-TO-CLOUD: the names for `done`'s `check.failed_files`: the first 20 that are plain repo-relative paths of at most 200 characters and carry no credential shape (`normalised` refuses an
     * option, an absolute path and `..`), and how many more were seen. 20 is what a card can list without becoming the output; the full count is still in the summary header. Names only, never output.
     */
    list() {
      const files: string[] = [];
      for (const file of seen) {
        const name = normalised(file);
        if (name !== undefined && name === file && name.length <= CHECK_FAILED_FILE_CHARS && redactShapes(name) === name && files.length < CHECK_FAILED_FILES_MAX) files.push(name);
      }
      return { files, more: seen.size + more - files.length };
    },
    /** The line for the summary's header (with its newline), or "" when no failed test file was seen. */
    summary() {
      if (seen.size === 0) return "";
      const shown: string[] = [];
      let bytes = 0;
      for (const file of seen) {
        const name = redactShapes(file);
        bytes += Buffer.byteLength(name) + 2;
        if (bytes > FAILED_FILES_BYTES) break;
        shown.push(name);
      }
      const left = seen.size + more - shown.length;
      return `failed test files (${String(seen.size + more)}): ${shown.join(", ")}${left === 0 ? "" : ` (and ${String(left)} more)`}\n`;
    },
  };
}

/** How many changed files, and how many bytes of their names, the header names. A longer list is counted, and the cloud then does not rely on it. */
const CHANGED_FILES_MAX = 40;
const CHANGED_FILES_BYTES = 1000;

/**
 * The header line that names the files the branch changed (`changed files (N): a, b`), with the same closed shape as the failed-files line: only a plain relative file
 * name (`NAMED_FILE`) is ever named, in sorted order, at most `CHANGED_FILES_MAX` of them and `CHANGED_FILES_BYTES` bytes; every other path (an odd name, or past a
 * cap) is counted in `(and K more)`. N is the count of all of them, so a reader can tell a complete list from a cut one. "" when nothing changed or git could not say.
 */
export function changedFilesLine(files: readonly string[] | null): string {
  if (files === null) return "";
  const all = [...new Set(files)].sort();
  if (all.length === 0) return "";
  const shown: string[] = [];
  let bytes = 0;
  for (const file of all) {
    if (!NAMED_FILE.test(file) || shown.length >= CHANGED_FILES_MAX) continue;
    const name = redactShapes(file);
    bytes += Buffer.byteLength(name) + 2;
    if (bytes > CHANGED_FILES_BYTES) break;
    shown.push(name);
  }
  const left = all.length - shown.length;
  return `changed files (${String(all.length)}): ${shown.join(", ")}${left === 0 ? "" : `${shown.length === 0 ? "" : " "}(and ${String(left)} more)`}\n`;
}

/** The workspace's changed paths against `base`, read with the daemon's guarded git (the same guard as `createVcsState`). Null when a call fails or its listing was cut. */
export function createChangedFiles(capture: GitCapture, envOptions: CleanEnvOptions): NonNullable<CheckStepDeps["changedFiles"]> {
  return async (workspace, base) => {
    // `--no-renames`: a rename names both paths. The untracked listing is the files the agent made and has not committed (ignored files are not changes).
    // Both reads go through `readWorkspaceGit`: the git folder's shape is checked first, and a shape it does not know throws `workspace_git_refused`.
    const session = new HostReadSession(); // the two reads walk the worktree for nested repositories once
    const tracked = await readWorkspaceGit(capture, envOptions, workspace, hostGit("diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--"), 30_000, session);
    const fresh = await readWorkspaceGit(capture, envOptions, workspace, hostGit("ls-files", "-z", "--others", "--exclude-standard"), 30_000, session);
    if (tracked.code !== 0 || tracked.timedOut || fresh.code !== 0 || fresh.timedOut) return null;
    // A listing as long as the capture keeps could have been cut: the list is then not complete, and not offered.
    if (tracked.stdout.length >= LISTING_CAP_GUARD || fresh.stdout.length >= LISTING_CAP_GUARD) return null;
    return [...tracked.stdout.split("\0"), ...fresh.stdout.split("\0")].filter((name) => name !== "");
  };
}

/** A listing at least this long (the capture keeps 64 K) is treated as possibly cut. */
const LISTING_CAP_GUARD = 60 * 1024;

/** The last `max` bytes of `text`, without a broken character at the start. */
function lastBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  return bytes.subarray(bytes.length - max).toString("utf8").replace(/^�+/, "");
}

interface Dir {
  path: string;
  /** Device and inode when pinned; undefined for a directory this step made. */
  id: string | undefined;
}
interface Held {
  rel: string;
  file: string;
  dirs: Dir[];
  original: { kind: "none" } | { kind: "file"; bytes: Buffer; mode: number };
}

const idOf = (stat: { dev: number | bigint; ino: number | bigint }): string => `${String(stat.dev)}:${String(stat.ino)}`;

type Probe = { kind: "missing" } | { kind: "unreadable" } | { kind: "found"; stat: Stats };

/** `lstat`, with the failure classified: a missing path and an unreadable one are different answers, and every caller acts on both. */
function probe(target: string): Probe {
  try {
    return { kind: "found", stat: lstatSync(target) };
  } catch (error) {
    // fx-swallow-ok: the error is turned into the returned kind ("missing" or "unreadable"), which each caller acts on (an unreadable path fails the check)
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
}

/** The parents of `rel` under `root`, from the root down, as they are now: undefined where one is missing, `bad` where one is a link or not a directory. */
function chainOf(root: string, rel: string): { dirs: Dir[]; missingFrom: number; bad: boolean } {
  const parts = rel.split("/").slice(0, -1);
  const dirs: Dir[] = [];
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    const seen = probe(current);
    if (seen.kind === "missing") return { dirs, missingFrom: i, bad: false };
    if (seen.kind === "unreadable" || seen.stat.isSymbolicLink() || !seen.stat.isDirectory()) return { dirs, missingFrom: -1, bad: true };
    dirs.push({ path: current, id: idOf(seen.stat) });
  }
  return { dirs, missingFrom: -1, bad: false };
}

/**
 * Puts each file the vector names back to its base content and remembers what the branch had (pushing to `held` as it goes, so a failure part-way is still given back).
 * A file the branch added (absent at the base) is taken away for the run. Returns the paths that cannot be pinned safely (a link on the path, a name that is not a file).
 */
async function pinned(input: CheckStepInput, held: Held[], changed: string[]): Promise<string[]> {
  const problems: string[] = [];
  const root = path.resolve(input.workspace);
  const names = new Set<string>();
  for (const arg of input.check.argv) {
    const rel = normalised(arg);
    if (rel !== undefined) names.add(rel);
  }
  for (const rel of names) {
    const file = path.join(root, rel);
    const chain = chainOf(root, rel);
    if (chain.bad) {
      problems.push(rel);
      continue;
    }
    let now: Held["original"];
    const here = probe(file);
    if (here.kind === "unreadable" || (here.kind === "found" && !here.stat.isFile())) {
      problems.push(rel);
      continue;
    }
    if (here.kind === "found") {
      const bytes = readOrNull(file);
      if (bytes === null) {
        problems.push(rel);
        continue;
      }
      now = { kind: "file", bytes, mode: here.stat.mode & 0o777 };
    } else now = { kind: "none" };
    if (chain.missingFrom >= 0 && now.kind === "file") {
      problems.push(rel);
      continue;
    }
    const at = await input.baseFile(input.baseDir, input.base, rel);
    if (at === null && now.kind === "none") continue;
    if (at !== null && now.kind === "file" && now.bytes.equals(at)) continue;
    changed.push(rel);
    const entry: Held = { rel, file, dirs: chain.dirs, original: now };
    held.push(entry);
    if (now.kind === "file") unlinkSync(file);
    if (at !== null) {
      if (chain.missingFrom >= 0) makeDirs(root, rel, chain.missingFrom, entry);
      writeNew(file, at, now.kind === "file" ? now.mode : 0o755);
    }
  }
  return problems;
}

function readOrNull(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch {
    // fx-swallow-ok: the caller treats null as "cannot be pinned" and fails the check naming the path
    return null;
  }
}

function makeDirs(root: string, rel: string, from: number, entry: Held): void {
  const parts = rel.split("/").slice(0, -1);
  let current = path.join(root, ...parts.slice(0, from));
  for (let i = from; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    mkdirSync(current, { mode: 0o755 });
    entry.dirs.push({ path: current, id: undefined });
  }
}

/** Creates `file` exclusively and without following a link at its last component. */
function writeNew(file: string, bytes: Buffer, mode: number): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
  } finally {
    closeSync(fd);
  }
}

/** Gives the branch its files back. Returns the paths that were not written: a parent changed or became a link, or the file is not a plain file any more. */
function giveBack(held: readonly Held[]): string[] {
  const refused: string[] = [];
  for (const entry of [...held].reverse()) {
    try {
      for (const dir of entry.dirs) {
        const stat = lstatSync(dir.path);
        if (stat.isSymbolicLink() || !stat.isDirectory() || (dir.id !== undefined && idOf(stat) !== dir.id)) throw new Error("parent changed");
      }
      const now = probe(entry.file);
      if (now.kind === "unreadable" || (now.kind === "found" && !now.stat.isFile())) throw new Error("not a file");
      if (now.kind === "found") unlinkSync(entry.file);
      if (entry.original.kind === "file") writeNew(entry.file, entry.original.bytes, entry.original.mode);
      else
        for (const dir of [...entry.dirs].reverse()) {
          if (dir.id !== undefined) break;
          rmdirSync(dir.path);
        }
    } catch {
      // fx-swallow-ok: the refusal is returned as the path's name; the caller fails the check and the summary names it
      refused.push(entry.rel);
    }
  }
  return refused;
}

type Saved = { kind: "absent" } | { kind: "file"; bytes: Buffer; mode: number } | { kind: "other" };
interface Snapshot {
  files: Map<string, Saved>;
  vcs: string;
}

function savedOf(file: string): Saved {
  const seen = probe(file);
  if (seen.kind === "missing") return { kind: "absent" };
  if (seen.kind === "unreadable" || !seen.stat.isFile()) return { kind: "other" };
  const bytes = readOrNull(file);
  return bytes === null ? { kind: "other" } : { kind: "file", bytes, mode: seen.stat.mode & 0o777 };
}

const sameSaved = (a: Saved, b: Saved): boolean => a.kind === b.kind && (a.kind !== "file" || (b.kind === "file" && a.mode === b.mode && a.bytes.equals(b.bytes)));

/** The bytes and mode of every protected file, and a digest of the version-control state (HEAD, every ref, the index file), before or after the check. */
async function snapshotOf(workspace: string, names: readonly string[], deps: CheckStepDeps): Promise<Snapshot> {
  const files = new Map<string, Saved>();
  for (const name of names) files.set(name, savedOf(path.join(workspace, name)));
  const index = savedOf(path.join(workspace, VCS_DIR, "index"));
  const indexDigest = index.kind === "file" ? createHash("sha256").update(index.bytes).digest("hex") : index.kind;
  return { files, vcs: `${await deps.vcsState(workspace)}\n${indexDigest}` };
}

/**
 * Compares the protected paths with how they were. A protected file the check changed, created or removed is put back from the snapshot (never committed); the names go to
 * the summary. Version-control state that moved cannot be put back from here: it fails the check by name (the folder is also bound read-only for the check).
 */
async function guardProtected(workspace: string, before: Snapshot, deps: CheckStepDeps): Promise<{ changed: string[]; unrestored: string[] }> {
  const names = new Set<string>([...before.files.keys(), ...protectedRootNames(workspace)]);
  const after = await snapshotOf(workspace, [...names], deps);
  const changed: string[] = [];
  const unrestored: string[] = [];
  for (const name of names) {
    const was = before.files.get(name) ?? ({ kind: "absent" } as Saved);
    const now = after.files.get(name)!;
    if (sameSaved(was, now)) continue;
    changed.push(name);
    const file = path.join(workspace, name);
    try {
      if (now.kind !== "absent") rmSync(file, { recursive: true, force: true });
      if (was.kind === "file") writeNew(file, was.bytes, was.mode);
    } catch {
      // fx-swallow-ok: the path is returned in `unrestored`, which fails the check and is named in the summary
      unrestored.push(name);
    }
  }
  if (after.vcs !== before.vcs) {
    changed.push(VCS_DIR);
    unrestored.push(VCS_DIR);
  }
  return { changed, unrestored };
}

/** The git state digest the daemon uses: HEAD and every ref, read with the guarded git of its other workspace calls. Throws when a call fails. */
export function createVcsState(capture: GitCapture, envOptions: CleanEnvOptions): CheckStepDeps["vcsState"] {
  return async (workspace) => {
    // A refused shape throws here; the check step turns a throw from this read into `protected_unreadable` (the check is not run).
    const refs = await readWorkspaceGit(capture, envOptions, workspace, hostGit("for-each-ref", "--format=%(objectname) %(refname)"), 30_000);
    const head = await readWorkspaceGit(capture, envOptions, workspace, hostGit("rev-parse", "--verify", "HEAD"), 30_000);
    const symbolic = await readWorkspaceGit(capture, envOptions, workspace, hostGit("symbolic-ref", "-q", "HEAD"), 30_000);
    if (refs.code !== 0 || refs.timedOut || head.code !== 0 || head.timedOut) throw new Error("version-control state unreadable");
    return `${head.stdout.trim()}\n${symbolic.stdout.trim()}\n${refs.stdout}`;
  };
}

/**
 * Reads a file at a commit from the runner's mirror with the daemon's own guarded git. The text the capture returns is checked against the object's own hash, so a blob
 * that is not valid text (or was cut) is refused rather than written back changed.
 */
export function createBaseFile(capture: GitCapture, envOptions: CleanEnvOptions): CheckStepInput["baseFile"] {
  const env = (): Record<string, string> => ({ ...gitEnv(envOptions), ...guardConfigEnv() });
  return async (dir, base, relative) => {
    const named = await capture("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `${base}:${relative}`], env(), 30_000);
    const oid = named.stdout.trim();
    if (named.code !== 0 || named.timedOut || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return null;
    const kind = await capture("git", ["-C", dir, "cat-file", "-t", oid], env(), 30_000);
    if (kind.code !== 0 || kind.stdout.trim() !== "blob") return null;
    const blob = await capture("git", ["-C", dir, "cat-file", "blob", oid], env(), 30_000);
    if (blob.code !== 0 || blob.timedOut) throw new Error("base file unreadable");
    const bytes = Buffer.from(blob.stdout, "utf8");
    const digest = createHash(oid.length === 64 ? "sha256" : "sha1").update(`blob ${String(bytes.length)}\0`).update(bytes).digest("hex");
    if (digest !== oid) throw new Error("base file is not byte-exact");
    return bytes;
  };
}

/** The plain sentence when the workspace's git folder is not the one the runner made (see `hostRead.ts`). */
const GIT_FOLDER_CHANGED = "the workspace's git folder was changed in a way the runner will not read";

export function createCheckStep(deps: CheckStepDeps): (input: CheckStepInput) => Promise<CheckOutcome> {
  return async (input) => {
    const started = deps.now().getTime();
    const failed = (reason: CheckNotRunReason, summary: string): CheckOutcome => ({ passed: false, body: { exit_code: null, duration_ms: Math.max(0, deps.now().getTime() - started), timed_out: false, skipped_tests: null, summary: lastBytes(summary, CHECK_SUMMARY_MAX_BYTES), reason } });
    const launch = input.launch(input.check.argv, input.check.dev_shell);
    if (launch === undefined) return failed("sandbox_unavailable", "the sandbox could not start the check");
    if ("refused" in launch) return failed("sandbox_refused", launch.refused);
    const held: Held[] = [];
    const changed: string[] = [];
    let problems: string[];
    try {
      problems = await pinned(input, held, changed);
    } catch {
      // fx-swallow-ok: a checkout that cannot be pinned is not checked; the error text could hold a path
      const lost = giveBack(held);
      return failed("pin_failed", `the check was not run: its files could not be pinned to the default branch${lost.length === 0 ? "" : `; not given back: ${lost.join(", ")}`}`);
    }
    if (problems.length > 0) {
      const lost = giveBack(held);
      return failed("pin_failed", `the check was not run: these files could not be pinned (a link or a non-file on the path): ${problems.join(", ")}${lost.length === 0 ? "" : `; not given back: ${lost.join(", ")}`}`);
    }
    // The protected paths as they are now, to be compared after the check; one that cannot be read means the check is not run.
    const names = protectedRootNames(input.workspace);
    let before: Snapshot;
    try {
      before = await snapshotOf(input.workspace, names, deps);
    } catch (error) {
      // fx-swallow-ok: a workspace whose protected state cannot be read is not checked; the failure is the returned outcome
      const lost = giveBack(held);
      const why = error instanceof GitPathError && error.code === "workspace_git_refused" ? GIT_FOLDER_CHANGED : "the workspace's protected files could not be read";
      return failed("protected_unreadable", `the check was not run: ${why}${lost.length === 0 ? "" : `; not given back: ${lost.join(", ")}`}`);
    }
    let out: Awaited<ReturnType<InstallCapture>>;
    const failedFiles = createFailedFiles(input.workspace);
    try {
      out = await deps.capture(launch.tool, launch.args, launch.env, input.workspace, input.check.timeout_s * 1000, RAW_TAIL_CHARS, input.signal, launch.feed, failedFiles.line);
    } catch {
      // fx-swallow-ok: a check that could not be started did not pass; the error text could hold a path
      const lost = giveBack(held);
      return failed("start_failed", `the check could not be started${lost.length === 0 ? "" : `; not given back: ${lost.join(", ")}`}`);
    }
    let guard: { changed: string[]; unrestored: string[] };
    let gitFolderChanged = false;
    try {
      guard = await guardProtected(input.workspace, before, deps);
    } catch (error) {
      // fx-swallow-ok: if the protected state cannot be compared the check cannot pass; the failure is named below
      guard = { changed: ["(could not be compared)"], unrestored: ["(could not be compared)"] };
      // The version-control digest is read through `readWorkspaceGit`, which re-checks the pinned git folder after the check's processes have ended.
      if (error instanceof GitPathError && error.code === "workspace_git_refused") gitFolderChanged = true;
    }
    const lost = giveBack(held);
    if (gitFolderChanged) return failed("protected_changed", `the check did not pass: ${GIT_FOLDER_CHANGED}${lost.length === 0 ? "" : `; not given back: ${lost.join(", ")}`}`);
    const skipped = skippedTests(out.tail);
    let shown = redactShapes(out.tail);
    shown = shown.split(input.workspace).join("<workspace>");
    if (input.home !== undefined && input.home !== "/") shown = shown.split(input.home).join("<home>");
    shown = shown.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, " ");
    // A check that stopped on something it asked the network for (it has none) says so in a line of its own, so the cause is not buried in the output's tail.
    const needsNetwork = out.code !== 0 && !out.timedOut && !out.aborted && NETWORK_REFUSED.test(out.tail);
    const unpinned = input.check.argv.filter((arg) => /\s/.test(arg)).map((arg) => (arg.length > 40 ? `${arg.slice(0, 40)}...` : arg));
    // The files the branch changed, for a failed check only (the cloud compares them with the failed test files). After the files are given back, so the workspace is the
    // agent's own state; a read that fails or is not offered leaves the line out, and the cloud then keeps its fix round.
    let changedLine = "";
    if (out.code !== 0 && !out.timedOut && !out.aborted && deps.changedFiles !== undefined) {
      try {
        changedLine = changedFilesLine(await deps.changedFiles(input.workspace, input.base));
      } catch {
        // fx-swallow-ok: a changed-files read that failed leaves the header line out; the check's result does not depend on it
        changedLine = "";
      }
    }
    // A failed check names its failing test files on `done` (protocol 13); a pass, a timeout or an abort names none, and nothing is sent when none were seen.
    const named = out.code !== 0 && !out.timedOut && !out.aborted ? failedFiles.list() : { files: [], more: 0 };
    const failedList = named.files.length === 0 ? {} : { failed_files: named.files, ...(named.more === 0 ? {} : { failed_files_more: named.more }) };
    const header = [
      out.code !== 0 ? failedFiles.summary() : "",
      changedLine,
      needsNetwork ? "the check needed the network, which it does not have: a package it asked for is not in this repository's package store on the runner (the runner installs dependencies before the check)\n" : "",
      changed.length === 0 ? "" : `check files changed by this branch: ${changed.join(", ")}\n`,
      lost.length === 0 ? "" : `check files not given back to the branch: ${lost.join(", ")}\n`,
      guard.changed.length === 0 ? "" : `the check changed paths it may not (put back where possible): ${guard.changed.join(", ")}\n`,
      guard.unrestored.length === 0 ? "" : `not put back: ${guard.unrestored.join(", ")}\n`,
      unpinned.length === 0 ? "" : `not pinned (a string with spaces is not a file name): ${unpinned.join(" | ")}\n`,
    ].join("");
    const summary = `${header}${lastBytes(shown, CHECK_SUMMARY_MAX_BYTES - Buffer.byteLength(header))}`;
    // The check ran, but it touched protected paths or its files could not be given back: its result does not count, and the reason says so (a plain failing exit carries none).
    const reason: CheckNotRunReason | undefined = guard.changed.length > 0 || guard.unrestored.length > 0 ? "protected_changed" : lost.length > 0 ? "not_restored" : undefined;
    const body: DoneCheck = { exit_code: out.timedOut || out.aborted ? null : out.code, duration_ms: Math.max(0, deps.now().getTime() - started), timed_out: out.timedOut, skipped_tests: skipped, summary: lastBytes(summary, CHECK_SUMMARY_MAX_BYTES).replace(/\u0000/g, ""), ...(reason === undefined ? {} : { reason }), ...failedList };
    return { passed: out.code === 0 && !out.timedOut && !out.aborted && lost.length === 0 && guard.changed.length === 0, body };
  };
}
