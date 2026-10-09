import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { bwrapCanCreateNamespaces, insideRunnerJob } from "./helpers/bwrapProbe.js";

/**
 * D#6 R7e B4: the runner's real-Nix and real-bubblewrap suites cannot run inside a runner job (bubblewrap makes namespaces there but the nested view
 * fails), so they skip when the job marker `FX_RUNNER_JOB=1` is set. The check lives in `test/helpers/bwrapProbe.ts` and nowhere else. Here: the helper
 * answers by the marker; every real suite skips (no failure, nothing run) in a child vitest run with the marker set; and without it a real suite still runs.
 */
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_SUITES = ["nixShell.real", "nixShell.hostConf.real", "nixShell.view.real", "nixView.bwrap", "sandboxAllowances.bwrap"].map((name) => `test/${name}.test.ts`);
const VITEST = path.join(PACKAGE, "node_modules", "vitest", "vitest.mjs");
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));

interface Totals { failed: number; passed: number; pending: number }

/** Runs the given test files in a child vitest with the host environment, `FX_RUNNER_JOB` set or removed. */
function childRun(files: readonly string[], marker: boolean): Totals {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["FX_RUNNER_JOB"];
  delete env["FX_TEST_BWRAP_PROBE_BIN"];
  if (marker) env["FX_RUNNER_JOB"] = "1";
  const out = spawnSync(process.execPath, [VITEST, "run", "--reporter=json", ...files], { cwd: PACKAGE, env, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  expect(out.error, "the child vitest could not start").toBeUndefined();
  const start = out.stdout.indexOf("{");
  expect(start, out.stderr).toBeGreaterThanOrEqual(0);
  const json = JSON.parse(out.stdout.slice(start)) as { numFailedTests: number; numPassedTests: number; numPendingTests: number };
  return { failed: json.numFailedTests, passed: json.numPassedTests, pending: json.numPendingTests };
}

describe("the runner-job marker and the real suites", () => {
  it("the probe helper refuses by the marker alone, even where bubblewrap works", () => {
    vi.stubEnv("FX_RUNNER_JOB", "1");
    try {
      expect(insideRunnerJob()).toBe(true);
      expect(bwrapCanCreateNamespaces(BWRAP)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("only the value 1 counts as the marker", () => {
    for (const value of ["", "0", "true", "yes"]) {
      vi.stubEnv("FX_RUNNER_JOB", value);
      try {
        expect(insideRunnerJob(), value).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  it("with the marker set, all five real suites skip: tests are pending, none passes or fails", () => {
    const totals = childRun(REAL_SUITES, true);
    expect(totals.failed).toBe(0);
    expect(totals.passed).toBe(0);
    expect(totals.pending).toBeGreaterThan(0);
  }, 300_000);

  it("control: without the marker a real suite still runs on a host that can make namespaces", () => {
    vi.stubEnv("FX_RUNNER_JOB", "");
    const canRun = bwrapCanCreateNamespaces(BWRAP);
    vi.unstubAllEnvs();
    if (!canRun) return;
    const totals = childRun(["test/sandboxAllowances.bwrap.test.ts"], false);
    expect(totals.failed).toBe(0);
    expect(totals.passed).toBeGreaterThan(0);
  }, 300_000);
});
