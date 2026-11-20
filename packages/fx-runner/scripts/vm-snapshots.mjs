// What `fx-runner vm uninstall` prints about the runner's snapshot_dir (D#587 B-2a-2 PR-5): how many snapshots (top-level entries) and their bytes in all.
// Read here, at the bin edge, as the runner user, never as root. Nothing is followed: a link counts as one entry of its own size, and a directory that
// cannot be read, or a tree of more than MAX_ENTRIES entries, makes the whole answer "could not be read" (undefined), never a partial number.
// Directories are iterated with opendirSync, so the cap applies while reading and a huge directory is never held in memory as one list.
import { lstatSync, opendirSync } from "node:fs";
import path from "node:path";

export const MAX_ENTRIES = 200_000;

/** @param {string} dir @param {number} [cap] @returns {{ count: number, bytes: number } | undefined} */
export function summarizeSnapshots(dir, cap = MAX_ENTRIES) {
  try {
    if (!lstatSync(dir).isDirectory()) return undefined;
    let bytes = 0;
    let seen = 0;
    let count = 0;
    const walk = (d, top) => {
      const handle = opendirSync(d);
      try {
        for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
          if (++seen > cap) throw new Error("too many entries");
          if (top) count += 1;
          const file = path.join(d, entry.name);
          const info = lstatSync(file);
          bytes += info.size;
          if (info.isDirectory()) walk(file, false);
        }
      } finally {
        handle.closeSync();
      }
    };
    walk(dir, true);
    return { count, bytes };
  } catch {
    return undefined;
  }
}
