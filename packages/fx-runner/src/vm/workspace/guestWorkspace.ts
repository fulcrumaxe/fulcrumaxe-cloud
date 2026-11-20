/**
 * A job's working copy inside a microVM guest (D#587 B-5b). The repository goes in as one verified, read-only archive; what the guest does with it
 * is fixed text here, run with the host's values as separate arguments, never spliced into a shell string.
 *
 *  - The archive, the start commit's own text and three lists (the regular files, the links, the git index lines) are written below `stage`. No host path
 *    is in any of them: every name is relative to the workspace, and the guest's paths are the constants below (or a test's own).
 *  - The guest unpacks as its own agent user, never root, with `--no-same-owner --no-same-permissions`, then builds the git state from the HOST's index
 *    lines (`git update-index --index-info`), not by staging the files one by one: a `.gitattributes` in the tree cannot change a byte. The tree git writes must equal the
 *    tree the host named, and the start commit (its text hashed back) must equal the id the host gave and have that tree, or the script stops.
 *  - The repository is the real start commit with its parents absent (`.git/shallow` names it), so the agent's commits are its children and a bundle
 *    of them has exactly that one prerequisite.
 *  - `stage/base` is written last: the id of the commit the working copy started from. It is the marker `reopenWorkspace` reads after a stop.
 */
import type { SdkSandbox } from "../sandboxd/sdkSlice.js";
import type { TreeItem } from "./tree.js";

/** The guest's work directory (`/vercel/sandbox` is made for the agent user at every boot) and the staging directory beside it. */
export const GUEST_WORKSPACE = "/vercel/sandbox/work";
export const GUEST_STAGE = "/vercel/sandbox/.fx-stage";

export interface GuestPaths {
  workspace: string;
  stage: string;
}
export const DEFAULT_GUEST_PATHS: GuestPaths = Object.freeze({ workspace: GUEST_WORKSPACE, stage: GUEST_STAGE });

/** How long the unpack may take: the daemon's own frames and the VM timer bound everything else. */
const UNPACK_MS = 10 * 60_000;

export class GuestWorkspaceError extends Error {
  constructor(readonly code: "unpack_failed" | "unpack_timeout" | "guest_unreachable" | "workspace_missing") {
    super(code);
    this.name = "GuestWorkspaceError";
  }
}

const UNPACK_SCRIPT = [
  "set -eu",
  "umask 022",
  "W=$1; S=$2; TREE=$3; BASE=$4",
  'rm -rf "$W"',
  'mkdir -p "$W"',
  'base64 -d "$S/archive.b64" | tar -xzf - -C "$W" --no-same-owner --no-same-permissions',
  'rm -f "$S/archive.b64"',
  'cd "$W"',
  "git init -q",
  "git config user.name fulcrumaxe",
  "git config user.email runner@localhost",
  "git config core.autocrlf false",
  'git hash-object -w --no-filters --stdin-paths <"$S/files.lst" >/dev/null',
  'while IFS= read -r p; do readlink -n -- "$p" | git hash-object -w --stdin >/dev/null; done <"$S/links.lst"',
  'git update-index --add -z --index-info <"$S/index.info"',
  '[ "$(git write-tree)" = "$TREE" ]',
  '[ "$(git hash-object -t commit -w --stdin <"$S/commit.txt")" = "$BASE" ]',
  'printf \'%s\\n\' "$BASE" >.git/shallow',
  '[ "$(git rev-parse "$BASE^{tree}")" = "$TREE" ]',
  'git update-ref refs/heads/fx-work "$BASE"',
  "git symbolic-ref HEAD refs/heads/fx-work",
  'rm -f "$S/files.lst" "$S/links.lst" "$S/index.info" "$S/commit.txt"',
  'printf \'%s\\n\' "$BASE" >"$S/base"',
].join("\n");

export interface WorkspaceArchive {
  /** The gzip-compressed tar the host built and checked. */
  gz: Buffer;
  /** The start commit's id, and its raw text (the host hashed it back to that id). */
  commit: string;
  commitText: Buffer;
  /** The git tree id the archive holds (the host's own `rev-parse <commit>^{tree}`). */
  tree: string;
  /** The tree's listing, as `git ls-tree -r` gave it. */
  items: readonly TreeItem[];
}

/**
 * Runs `cmd` in the guest, as its agent user, and answers its exit code and the end of what it printed (`keep` characters of each stream). `limitMs` ends it
 * with SIGKILL, and `timedOut` says so; the limit starts BEFORE the guest is asked to start the command, so a guest that never answers is bounded here and not only by the VM's own
 * timer. An aborted `signal` kills the command at once and says so (`aborted`). `onText` sees every chunk as it arrives.
 */
export async function runInGuest(guest: SdkSandbox, spec: { cmd: string; args: readonly string[]; cwd?: string; env?: Record<string, string> }, limitMs: number, keep = 64 * 1024, onText?: (stream: "stdout" | "stderr", text: string) => void, signal?: AbortSignal): Promise<{ exitCode: number | null; timedOut: boolean; aborted?: true; stdout: string; stderr: string }> {
  const held = { stdout: "", stderr: "" };
  if (signal?.aborted === true) return { exitCode: null, timedOut: false, aborted: true, ...held };
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), limitMs);
  });
  let onAbort: (() => void) | undefined;
  const stop = new Promise<"abort">((resolve) => {
    if (signal === undefined) return;
    onAbort = () => resolve("abort");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const starting = guest.runCommand({ cmd: spec.cmd, args: [...spec.args], ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }), ...(spec.env === undefined ? {} : { env: spec.env }), detached: true });
    starting.catch(() => undefined); // fx-swallow-ok: a start that fails after the limit or a stop won is not an unhandled rejection; the race below reports the outcome
    const first = await Promise.race([starting, limit, stop]);
    if (typeof first === "string") {
      // the command may still come up after it was given up on: it is killed then
      void starting.then((late) => late.kill("SIGKILL")).catch(() => undefined); // fx-swallow-ok: a command that never started has nothing to kill
      return { exitCode: null, timedOut: first === "timeout", ...(first === "abort" ? { aborted: true as const } : {}), ...held };
    }
    const command = first;
    const finished = (async () => {
      for await (const chunk of command.logs()) {
        if ((chunk.stream !== "stdout" && chunk.stream !== "stderr") || typeof chunk.data !== "string") continue;
        onText?.(chunk.stream, chunk.data);
        held[chunk.stream] = (held[chunk.stream] + chunk.data).slice(-keep);
      }
      return command.wait();
    })();
    finished.catch(() => undefined); // fx-swallow-ok: a rejection after the limit won is not an unhandled one; the race below reports the outcome
    const outcome = await Promise.race([finished, limit, stop]);
    if (outcome === "timeout" || outcome === "abort") {
      await command.kill("SIGKILL").catch(() => undefined); // fx-swallow-ok: the command is reported as timed out or stopped whether or not the kill reached it
      return { exitCode: null, timedOut: outcome === "timeout", ...(outcome === "abort" ? { aborted: true as const } : {}), ...held };
    }
    return { exitCode: outcome.exitCode, timedOut: false, ...held };
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Puts the verified archive into the guest and builds its git state. Any failure is a closed `GuestWorkspaceError`; nothing the guest printed is kept.
 */
export async function sendWorkspace(guest: SdkSandbox, archive: WorkspaceArchive, paths: GuestPaths = DEFAULT_GUEST_PATHS): Promise<void> {
  const files = archive.items.filter((i) => i.mode !== "120000").map((i) => i.path).join("\n");
  const links = archive.items.filter((i) => i.mode === "120000").map((i) => i.path).join("\n");
  const index = archive.items.map((i) => `${i.mode} ${i.oid}\t${i.path}\0`).join("");
  // the staging directory is made by the agent user: the guest's file transfer would make a missing one as root, and the unpack then could not clean it
  const made = await runInGuest(guest, { cmd: "sh", args: ["-c", 'mkdir -p -m 700 -- "$1"', "fx-stage", paths.stage] }, 60_000).catch(() => undefined); // fx-swallow-ok: an unreachable guest is the closed code just below
  if (made?.exitCode !== 0) throw new GuestWorkspaceError("guest_unreachable");
  try {
    await guest.writeFiles([
      { path: `${paths.stage}/archive.b64`, content: archive.gz.toString("base64"), mode: 0o644 },
      { path: `${paths.stage}/files.lst`, content: files === "" ? "" : `${files}\n`, mode: 0o644 },
      { path: `${paths.stage}/links.lst`, content: links === "" ? "" : `${links}\n`, mode: 0o644 },
      { path: `${paths.stage}/index.info`, content: index, mode: 0o644 },
      { path: `${paths.stage}/commit.txt`, content: archive.commitText.toString("utf8"), mode: 0o644 },
    ]);
  } catch {
    // fx-swallow-ok: replaced by the closed code; the daemon's error text could hold a path
    throw new GuestWorkspaceError("guest_unreachable");
  }
  const ran = await runInGuest(guest, { cmd: "sh", args: ["-c", UNPACK_SCRIPT, "fx-unpack", paths.workspace, paths.stage, archive.tree, archive.commit] }, UNPACK_MS).catch(() => {
    // fx-swallow-ok: replaced by the closed code; nothing from the guest is kept
    throw new GuestWorkspaceError("guest_unreachable");
  });
  if (ran.timedOut) throw new GuestWorkspaceError("unpack_timeout");
  if (ran.exitCode !== 0) throw new GuestWorkspaceError("unpack_failed");
}
