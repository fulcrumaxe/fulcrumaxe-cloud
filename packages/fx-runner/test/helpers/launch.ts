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

/**
 * The start-up bubblewrap probe, answered "usable" (D#6 CHECK-NESTED-SANDBOX): for a test about what the engine does with a job, not about the probe. The real probe starts a
 * nested bubblewrap, which cannot create namespaces inside the runner's own check sandbox, so it would end every run there as `sandbox_unusable`. The probe has its own tests
 * (`engines/claude/sandboxUnusable.test.ts` over a script, `bashSandbox.bwrap.test.ts` over the real tool, which skips where nesting is refused).
 */
export const shellSandboxUsable = async (): Promise<boolean> => false;
