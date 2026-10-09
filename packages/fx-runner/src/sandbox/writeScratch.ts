/**
 * D#6 R7b, C25 section 2.1: a write entry of a job's allowances is job-scoped. The path is a directory the runner makes fresh for this job (mode
 * 0700, owned by the runner's user) right before launch and removes after the job ends, so nothing the job writes there outlives it or is there for a
 * later job to find. A path that already exists is never adopted: a directory another program (or another job) made is not this job's to write.
 *
 * Removal never follows a symlink: a link planted inside the directory is unlinked as a link, and a directory that is not the one the runner made
 * (different inode) is left alone.
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";

/** Why a write entry may not be made. Closed set; never carries a path. */
export type WriteScratchDetail = "write_path_exists" | "write_parent_missing" | "write_path_unusable";

export class WriteScratchRefused extends Error {
  constructor(readonly detail: WriteScratchDetail) {
    super(detail);
    this.name = "WriteScratchRefused";
  }
}

/** The write directories one sandbox made, by path, with the identity each had when it was made. */
export type ScratchDirs = Map<string, { dev: number; ino: number }>;

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WriteScratchRefused("write_path_unusable");
  }
}

/**
 * Makes each path in `wanted` fresh (0700) and records it in `owned`. A path that exists is refused unless this sandbox made it earlier (a resume),
 * and then only if it is still that same directory. If any path is refused, the ones made by this call are removed again.
 */
export function claimScratch(owned: ScratchDirs, wanted: readonly string[]): void {
  const made: string[] = [];
  try {
    for (const target of wanted) {
      const have = owned.get(target);
      const st = lstatOrNull(target);
      if (have !== undefined) {
        if (st !== null && st.isDirectory() && st.dev === have.dev && st.ino === have.ino) continue;
        throw new WriteScratchRefused("write_path_exists");
      }
      if (st !== null) throw new WriteScratchRefused("write_path_exists");
      try {
        mkdirSync(target, { mode: 0o700 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new WriteScratchRefused(code === "EEXIST" ? "write_path_exists" : code === "ENOENT" ? "write_parent_missing" : "write_path_unusable");
      }
      made.push(target);
      // mkdir made it just now, so the runner's user owns it; what is checked is that it is a directory and not something swapped in
      const fresh = lstatSync(target);
      if (!fresh.isDirectory()) throw new WriteScratchRefused("write_path_unusable");
      chmodSync(target, 0o700);
      owned.set(target, { dev: fresh.dev, ino: fresh.ino });
    }
  } catch (error) {
    for (const target of made) {
      owned.delete(target);
      try {
        removeTree(target);
      } catch {
        // fx-swallow-ok: the refusal is what the caller reports; a rollback that cannot finish leaves the directory the runner made, and the next claim of it refuses
      }
    }
    throw error;
  }
}

/** Removes `dir` and everything in it without following a symlink: a link is unlinked, a directory is entered only when lstat says it is one. */
function removeTree(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory()) {
    unlinkSync(dir);
    return;
  }
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name);
    if (lstatSync(child).isDirectory()) removeTree(child);
    else unlinkSync(child);
  }
  rmdirSync(dir);
}

/**
 * Removes every directory `owned` holds, success or failure of the job. A path that is gone is fine; one that is no longer the directory the runner
 * made is left alone. Every path is tried; it throws after the last if any could not be removed.
 */
export function releaseScratch(owned: ScratchDirs): void {
  let failed = false;
  for (const [target, id] of [...owned]) {
    owned.delete(target);
    try {
      const st = lstatOrNull(target);
      if (st === null) continue;
      if (!st.isDirectory() || st.dev !== id.dev || st.ino !== id.ino) continue;
      removeTree(target);
    } catch {
      // fx-swallow-ok: every path is tried, and the failure is raised once after the last
      failed = true;
    }
  }
  if (failed) throw new Error("write_scratch_not_removed");
}
