import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { removeTree } from "./removeTree.js";

export { removeTree };

/**
 * Scratch directories that do not outlive the test file (FU-169). A suite that calls `mkdtempSync` and never removes the
 * result leaves one directory per test behind; on a busy host that was tens of thousands in a day.
 *
 * `tempDir` makes the directory and registers it for removal after the last test of the file that asked for it (this
 * module registers its `afterAll` once per file, because vitest loads a fresh module instance per test file). Under
 * vitest the temp directory is the run's own root (see `bindTmp.ts`), so the global setup's leak check counts only what
 * this package made.
 */
const made: string[] = [];

/** `mkdtempSync` under `base` (default: the temp directory), removed after this file's tests. */
export function tempDir(prefix: string, base: string = tmpdir()): string {
  const dir = mkdtempSync(path.join(base, prefix));
  made.push(dir);
  return dir;
}

/** Registers a directory somebody else made (a helper's result) for removal after this file's tests. */
export function trackTempDir(dir: string): string {
  made.push(dir);
  return dir;
}

afterAll(() => {
  // one directory that cannot be removed must not leave the others behind: collect, then fail once
  const errors: unknown[] = [];
  for (const dir of made.splice(0).reverse()) {
    try {
      removeTree(dir);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length} temp director${errors.length === 1 ? "y" : "ies"} could not be removed`);
});
