import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpRoot } from "./tmpRoot.js";

/**
 * The runner's check and its agent jobs run under a seccomp filter that refuses user namespaces, and Chromium's own sandbox needs one: with the sandbox on it stops at start
 * with "No usable sandbox" (SIGTRAP). The production verify browser keeps that sandbox on and is never given `--no-sandbox`, and it runs outside any job sandbox, so the tests that
 * drive it for real cannot run inside the check, and are not bent to: they skip there, with this reason printed, and still run on a developer host and in CI.
 */
export const CHROMIUM_SANDBOX_SKIP_REASON = "Chromium's own sandbox cannot start here (inside a runner check or job the seccomp filter refuses user namespaces); the verify browser keeps that sandbox on, so this real-browser suite skips";

/** True when a sandbox marker is set (`FX_RUNNER_CHECK=1` in the runner's check, `FX_RUNNER_JOB=1` in an agent job). */
const marked = (env: NodeJS.ProcessEnv): boolean => env.FX_RUNNER_CHECK === "1" || env.FX_RUNNER_JOB === "1";

/** Starts the browser at `exe` with its sandbox on and asks it to dump an empty page; true when that works. A sandbox that cannot start ends the process on a fatal signal. */
export function chromiumStartsWithSandbox(exe: string): boolean {
  const profile = mkdtempSync(path.join(tmpRoot(), "chromium-probe-"));
  try {
    const out = spawnSync(exe, ["--headless", "--disable-gpu", "--disable-dev-shm-usage", `--user-data-dir=${profile}`, "--dump-dom", "about:blank"], { encoding: "utf8", timeout: 30_000 });
    return out.status === 0;
  } catch {
    // fx-swallow-ok: a probe that cannot even run answers "does not start"; the suite then skips with the reason printed
    return false;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * Whether a real-Chromium suite must skip because the browser's own sandbox cannot start. Both must hold: a sandbox marker, and a browser that really fails to start with its
 * sandbox on. The probe runs only when a marker is set, so a developer host or CI never skips and never pays for it.
 */
export function chromiumSandboxRefused(exe: string | undefined, env: NodeJS.ProcessEnv = process.env, probe: (exe: string) => boolean = chromiumStartsWithSandbox): boolean {
  if (exe === undefined || !marked(env)) return false;
  if (probe(exe)) return false;
  console.info(`[skip] ${CHROMIUM_SANDBOX_SKIP_REASON}`);
  return true;
}
