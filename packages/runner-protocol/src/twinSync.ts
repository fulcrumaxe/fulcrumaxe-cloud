/**
 * D#845 ON-27d2: what a private twin's sync (the public repository's changes coming into the twin) shares between the cloud and the runner.
 *
 * A sync names the PATHS to bring in, at most TWIN_SYNC_MAX_PATHS of them (the parity's own cap), in the signed bytes. The runner sets exactly those paths to the public tip's blobs on top of the twin's tip, in one commit, and
 * checks again, from the trees it built, that nothing else changed and that no path of the private set was touched. A path is a plain repository path: the checks below keep a name that a git argument, a tree entry or a
 * working copy could read as something else out of the signed bytes, so the cloud and the runner refuse the same set of names.
 */
export const TWIN_SYNC_MAX_PATHS = 200;
/** The largest file the sync copies, in bytes (the publish's own limit). A larger public file is refused with `sync_unsafe_path`. */
export const TWIN_SYNC_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const TWIN_SYNC_BRANCH_PREFIX = "fx/twin-sync-";

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]/;

/** True for a repository path the sync may name: relative, with no empty, `.`, `..` or `.git` segment, no control character and no backslash, at most 1024 characters. */
export function isTwinSyncPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length < 1 || path.length > 1024 || CONTROL.test(path) || path.startsWith("/")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git");
}

/** The branch a sync pushes to on the twin, named from the public tip it brings in. */
export const twinSyncBranch = (publicTip: string): string => `${TWIN_SYNC_BRANCH_PREFIX}${publicTip.slice(0, 12)}`;
