import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GlobalSetupContext } from "vitest/node";
import { removeTree } from "./helpers/removeTree.js";

declare module "vitest" {
  interface ProvidedContext {
    fxTmpRoot: string;
  }
}

/**
 * Temp-directory leak guard (FU-169). The run gets a temp root of its own; `bindTmp.ts` points every test worker's TMPDIR at it,
 * so everything this package's tests make with `os.tmpdir()` lands there. Once every test file is done the root is listed:
 * the run fails when more than MAX_LEFT entries remain (the root is then removed either way). Other projects in the same
 * workspace run share the host's temp directory but not this root, so their leaks are never counted here.
 *
 * Why it exists: suites that `mkdtemp` and never remove left tens of thousands of directories in a day on a busy host
 * (about 10 GB an hour of disk). A test that makes a directory removes it (see `helpers/tempTree.ts`).
 *
 * Tuning, all through the environment (read only; a globalSetup never writes `process.env`, see scripts/check-globalsetup-env.sh):
 *   FX_TMP_LEAK_MAX    the largest number of entries allowed to remain (default 0)
 *   FX_TMP_LEAK_GUARD  `warn` prints the list and still passes; `off` skips the check
 *
 * Node's own `node-compile-cache` directory is not a test's and is never counted. Not covered: a test that builds its path
 * from a hard-coded `/tmp`, or from `tmpRoot()` when the host's temp directory is not under `/tmp`.
 */
const IGNORED = new Set(["node-compile-cache"]);

export default function setup({ provide }: GlobalSetupContext): () => void {
  const mode = process.env["FX_TMP_LEAK_GUARD"] ?? "fail";
  if (mode === "off") return () => undefined;
  // a short name: Unix-socket fixtures built under the temp root must stay under the socket path limit
  const root = mkdtempSync(path.join(tmpdir(), "fxt-"));
  provide("fxTmpRoot", root);
  const parsed = Number(process.env["FX_TMP_LEAK_MAX"]);
  const max = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  return () => {
    const left = readdirSync(root).filter((name) => !IGNORED.has(name)).sort();
    removeTree(root);
    if (left.length <= max) return;
    const shown = left.slice(0, 20).map((name) => `  ${name}`).join("\n");
    const message = `fx-runner tests left ${left.length} entries in their temp root (allowed ${max}); remove what a test makes (helpers/tempTree.ts).\nfirst ${Math.min(20, left.length)}:\n${shown}`;
    if (mode === "warn") {
      console.warn(message);
      return;
    }
    throw new Error(message);
  };
}
