import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { RUNNER_JOB_SKIP_REASON, insideRunnerSandbox, skipInsideRunnerSandbox } from "../e2e/runner-job-guard.mjs";

// The workspace Playwright config must never hang inside a runner job or check: it prints a named skip and exits 0 within
// seconds, and it is a no-op everywhere else (CI and a developer host still run the e2e).
const APP = fileURLToPath(new URL("..", import.meta.url));
const REASON = "[skip] real-browser e2e cannot run inside the runner's sandbox; the staging verify stage covers it";

describe("runner-job e2e guard", () => {
  it("names the reason in the agreed words", () => {
    expect(RUNNER_JOB_SKIP_REASON).toBe(REASON);
  });

  it("only the value 1 of either runner marker counts", () => {
    expect(insideRunnerSandbox({ FX_RUNNER_JOB: "1" })).toBe(true);
    expect(insideRunnerSandbox({ FX_RUNNER_CHECK: "1" })).toBe(true);
    for (const value of ["", "0", "true", "yes"]) {
      expect(insideRunnerSandbox({ FX_RUNNER_JOB: value, FX_RUNNER_CHECK: value }), value).toBe(false);
    }
    expect(insideRunnerSandbox({})).toBe(false);
  });

  it("fires under a marker: prints the reason once and exits 0", () => {
    for (const env of [{ FX_RUNNER_JOB: "1" }, { FX_RUNNER_CHECK: "1" }]) {
      const exit = vi.fn();
      const log = vi.fn();
      expect(skipInsideRunnerSandbox(env, exit, log)).toBe(true);
      expect(log.mock.calls).toEqual([[REASON]]);
      expect(exit.mock.calls).toEqual([[0]]);
    }
  });

  it("is a no-op without a marker", () => {
    const exit = vi.fn();
    const log = vi.fn();
    expect(skipInsideRunnerSandbox({ CI: "true" }, exit, log)).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  // The real config, loaded by the real Playwright CLI: `--list` loads the config and lists tests without a browser or a server.
  const list = (marker) => {
    // An explicit allowlist of named keys: the child never gets the parent's whole environment.
    const env = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "CI", "PLAYWRIGHT_BROWSERS_PATH"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, marker);
    return spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--list", "e2e/fixture-server.spec.ts"], { cwd: APP, env, encoding: "utf8", timeout: 60_000 });
  };

  it("the real config under FX_RUNNER_JOB=1 skips with the reason, exit 0, in seconds, listing nothing and starting no server", () => {
    const started = Date.now();
    const out = list({ FX_RUNNER_JOB: "1" });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout + out.stderr).toContain(REASON);
    expect(out.stdout).not.toContain("fixture-server.spec.ts");
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("the real config under FX_RUNNER_CHECK=1 skips the same way", () => {
    const out = list({ FX_RUNNER_CHECK: "1" });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout + out.stderr).toContain(REASON);
  }, 60_000);

  it("control: the real config without a marker still lists the e2e", () => {
    const out = list({});
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("fixture-server.spec.ts");
    expect(out.stdout + out.stderr).not.toContain(REASON);
  }, 60_000);
});
