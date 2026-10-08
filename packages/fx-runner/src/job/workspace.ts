import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { NotAPlainSegment, segmentUnder } from "./plainSegment.js";

/** Where a job's working copy lives. `create` makes an empty private directory for a fresh session; filling it from the repository is the git path's job. */
export interface WorkspaceStore {
  /** A new, empty, absolute directory for this run. Throws if one is already there. */
  create(runId: string): Promise<string>;
  /** Removes a directory this store made. Refuses any other path. Idempotent. */
  discard(dir: string): Promise<void>;
  /** True only for a directory this store could have made: one plain segment, directly under its root. */
  owns(dir: string): boolean;
}

/** A store of per-run directories (0700) directly under `root`. */
export function createWorkspaceStore(root: string): WorkspaceStore {
  if (!path.isAbsolute(root)) throw new TypeError("workspace root must be absolute");
  // `resolve`, not `normalize`: normalize keeps a trailing slash, and then no directory is ever "directly under" the root.
  const base = path.resolve(root);
  const planned = (runId: string): string => {
    try {
      return segmentUnder(base, runId);
    } catch (error) {
      if (error instanceof NotAPlainSegment) throw new TypeError("bad run id for a workspace");
      throw error;
    }
  };
  const owns = (dir: string): boolean => {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== base) return false;
    try {
      return planned(path.basename(resolved)) === resolved;
    } catch {
      // fx-swallow-ok: a name that is not one plain segment is simply not this store's
      return false;
    }
  };
  return {
    owns,
    async create(runId) {
      const dir = planned(runId);
      mkdirSync(base, { recursive: true, mode: 0o700 });
      if (existsSync(dir)) throw new Error("workspace already exists");
      mkdirSync(dir, { mode: 0o700 });
      return dir;
    },
    async discard(dir) {
      const resolved = path.resolve(dir);
      // Only a directory this store could have made: one plain segment, directly under the root.
      if (!owns(resolved)) throw new TypeError("not a workspace of this store");
      rmSync(resolved, { recursive: true, force: true });
    },
  };
}
