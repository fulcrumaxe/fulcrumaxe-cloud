/**
 * File transfer rules shared by the daemon and the guest-agent client (D#587 B-2b-iii-b). They mirror infra/microvm-image/guest/agent.py:
 * `put` and `get` take an absolute path, `put` takes `mode & 0o777` (default 0o644), and a body is at most MAX_BYTES (256 MiB) in one frame.
 * The agent itself checks only that a `put` path is absolute; the host refuses more, so nothing odd reaches the guest.
 */
import path from "node:path";

/** agent.py MAX_BYTES: the most one put or get can carry. */
export const MAX_FILE_BYTES = 256 << 20;
/** The size of one piece on the wire and in memory; a transfer never holds much more than a few of these. */
export const FILE_PIECE = 1 << 20;
const MAX_PATH = 4096;

/** A file body: a buffer, or a source read piece by piece (its total must equal the `size` given beside it). */
export type FileContent = Buffer | { chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array> };

export class FileError extends Error {
  constructor(readonly code: "bad_path" | "bad_mode") {
    super(`fx-sandboxd file: ${code}`);
    this.name = "FileError";
  }
}

/**
 * Absolute, no NUL, no `..` and nothing that normalising would change (so no `.` or doubled slash either: the path the guest opens is the path the
 * caller named). The agent normalises nothing, which is why a `..` is refused here instead of being resolved.
 */
export function checkGuestPath(p: string): string {
  const ok = typeof p === "string" && p.length <= MAX_PATH && path.posix.isAbsolute(p) && !p.includes("\0") && !p.split("/").includes("..") && path.posix.normalize(p) === p;
  if (!ok) throw new FileError("bad_path");
  return p;
}

/** The mode the guest will apply: agent.py's `int(mode) & 0o777`, 0o644 when none is given. A non-integer is refused, not rounded. */
export function guestFileMode(mode: number | undefined): number {
  if (mode === undefined) return 0o644;
  if (!Number.isSafeInteger(mode) || mode < 0) throw new FileError("bad_mode");
  return mode & 0o777;
}
