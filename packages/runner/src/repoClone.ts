/**
 * D#2 PREVIEW-RUNNER-EVENTS: the shallow clone a preview run starts from.
 *
 * Before the agent starts, the runner clones the preview repository into a fixed directory of the sandbox, so the
 * agent's file tools (and the progress feed built from them) work on real repository-relative paths.
 *
 * Credentials: none reach the sandbox. The clone goes to the plain GitHub URL; the sandbox firewall forwards GitHub
 * traffic to our gh-proxy with the platform's own OIDC token for this run, and the proxy resolves the run to its
 * installation and adds its GitHub credential itself, under its read-only policy (the upload-pack service only). The
 * command carries no token, no username and no header.
 *
 * Safety: the command is `sh -c <fixed script> fx-clone <url> <dir> <limit>`. The repository name and the directory
 * reach the script only as positional arguments (always quoted in the script), never as shell text, and are validated
 * first. Nothing here is built by string concatenation into a shell line.
 *
 * Bounds: a time limit (`CLONE_TIMEOUT_MS`, enforced by the port) and a size limit (`MAX_CLONE_KB`, enforced inside
 * the script while the clone runs and once more when it ends).
 */

import { redactText } from "@fx/runtime/src/redact.js";

/** A clone that takes longer than this fails the run. Fits inside the preview's 9-minute cap. */
export const CLONE_TIMEOUT_MS = 90_000;
/** A repository over this many KiB on disk (checkout plus .git) fails the run. 200 MiB. */
export const MAX_CLONE_KB = 200 * 1024;
/** The script's exit code for "over the size limit". */
export const CLONE_EXIT_TOO_LARGE = 87;
/** The fixed directory a preview's repository is cloned into, and the agent works in. */
export const PREVIEW_WORKDIR = "/vercel/sandbox/repo";

export type CloneFailureReason = "clone_failed" | "clone_too_large";

/** What a failed clone leaves for the operator: its exit code (null when it was killed at the time limit) and the redacted end of its output. */
export interface CloneFailureDetail {
  exitCode: number | null;
  tail: string;
}

/** Thrown by the launch when the clone did not produce a usable checkout. The message and `reason` are fixed; `detail` is for operator logs only. */
export class CloneError extends Error {
  constructor(
    public readonly reason: CloneFailureReason,
    public readonly detail?: CloneFailureDetail,
  ) {
    super(`repository clone failed: ${reason}`);
    this.name = "CloneError";
  }
}

/** How much clone output the port holds while the clone runs (the end of it). Redaction runs on this, then the tail is cut. */
export const CLONE_OUTPUT_BUFFER_CHARS = 4096;
/** The most of the (redacted) output a failure keeps. */
export const CLONE_TAIL_MAX_CHARS = 500;

/**
 * The redacted, length-capped end of a failed clone's output. `raw` is the held end of the output and `truncated` says
 * whether anything before it was dropped. Redaction runs first, over everything held, then the tail is cut, so a
 * credential is never cut in half and left half-visible; when the front was dropped, the first (possibly partial) line
 * is dropped too, since a token whose head was cut off no longer looks like one. `secrets` are values to remove exactly.
 */
export function redactedCloneTail(raw: string, truncated: boolean, secrets: readonly (string | undefined)[]): string {
  let text = raw;
  if (truncated) {
    const nl = text.indexOf("\n");
    text = nl === -1 ? "" : text.slice(nl + 1);
  }
  const redacted = redactText(text, secrets).trim();
  return redacted.length > CLONE_TAIL_MAX_CHARS ? redacted.slice(-CLONE_TAIL_MAX_CHARS) : redacted;
}

export interface CloneTarget {
  owner: string;
  name: string;
}

/** GitHub owner and repository names: letters, digits, dot, dash and underscore only. */
const GITHUB_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const WORKDIR_RE = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const validName = (value: unknown): value is string => typeof value === "string" && GITHUB_NAME_RE.test(value) && value !== "." && value !== "..";

/**
 * The script. Every value arrives as `$1` (url), `$2` (directory) or `$3` (limit in KiB) and is always quoted.
 * Shallow (depth 1), single branch (the remote's default branch, since no branch is named), no tags, no submodules,
 * symlinks written as plain files (so a link in the repository cannot point the agent outside it), never a prompt.
 */
export const CLONE_SCRIPT = [
  // A persistent sandbox (the executor's, named for the issue) keeps the checkout of an earlier attempt. "Build again" is a
  // fresh start in that same sandbox, and a clone refuses a directory that is not empty, so a leftover CHECKOUT (a directory
  // holding a .git) is removed first. Anything that is not a checkout is left alone, and the clone then fails as it always did.
  'if [ -d "$2/.git" ]; then rm -rf "$2"; fi',
  'git -c core.symlinks=false clone --depth 1 --single-branch --no-tags --quiet -- "$1" "$2" &',
  "pid=$!",
  'while kill -0 "$pid" 2>/dev/null; do',
  '  kb=$(du -sk "$2" 2>/dev/null | cut -f1)',
  `  if [ "\${kb:-0}" -gt "$3" ]; then kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; rm -rf "$2"; exit ${CLONE_EXIT_TOO_LARGE}; fi`,
  "  sleep 1",
  "done",
  'wait "$pid" || exit $?',
  'kb=$(du -sk "$2" 2>/dev/null | cut -f1)',
  `if [ "\${kb:-0}" -gt "$3" ]; then rm -rf "$2"; exit ${CLONE_EXIT_TOO_LARGE}; fi`,
].join("\n");

/** The command to run in the sandbox, as a program and an argument array. Throws on a name or directory that is not plain. */
export function buildCloneCommand(target: CloneTarget, workdir: string, maxKb: number = MAX_CLONE_KB): { cmd: string; args: string[] } {
  if (!validName(target.owner) || !validName(target.name)) throw new Error("repository clone: not a GitHub repository name");
  if (typeof workdir !== "string" || !WORKDIR_RE.test(workdir) || workdir.split("/").some((s) => s === "." || s === "..")) {
    throw new Error("repository clone: the directory must be a plain absolute path");
  }
  if (!Number.isSafeInteger(maxKb) || maxKb <= 0) throw new Error("repository clone: the size limit must be a positive integer");
  return {
    cmd: "sh",
    args: ["-c", CLONE_SCRIPT, "fx-clone", `https://github.com/${target.owner}/${target.name}.git`, workdir, String(maxKb)],
  };
}
