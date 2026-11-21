import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Removal that survives a tree a test made unreadable (FU-169). No test framework import, so the global setup can use it too.
 * Gives every directory its owner's access back first (links are never followed), then removes the tree.
 */
export function removeTree(dir: string): void {
  reopen(dir);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function reopen(entry: string): void {
  let info;
  try {
    info = lstatSync(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory()) return;
  chmodSync(entry, 0o700);
  for (const name of readdirSync(entry)) reopen(path.join(entry, name));
}
