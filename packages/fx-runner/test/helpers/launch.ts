import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { LaunchPlace } from "../../src/launchDir.js";
import { tmpRoot } from "./tmpRoot.js";

let shared: string | undefined;

/**
 * A launch place for tests (D#6 RUNNER-CWD-1): a launch root of its own under the tests' temp directory (one per test file), with the real home
 * directory and this process's working directory as the two places a launch may never be, exactly as the program's entry point gives them.
 */
export function testLaunch(): LaunchPlace {
  shared ??= mkdtempSync(path.join(tmpRoot(), "fxr-launch-"));
  return { root: path.join(shared, "launch"), home: homedir(), processCwd: () => process.cwd(), uid: process.getuid?.() };
}
