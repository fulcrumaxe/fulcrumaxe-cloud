import { describe, expect, it } from "vitest";
import { findChromium } from "../../src/verifyBrowser/driver.js";
import { chromiumSandboxRefused, chromiumStartsWithSandbox } from "./chromiumSandbox.js";

const EXE = findChromium(process.env);
const insideSandbox = process.env.FX_RUNNER_CHECK === "1" || process.env.FX_RUNNER_JOB === "1";

describe("the Chromium sandbox skip for the real-browser suites", () => {
  it("skips only with a sandbox marker (check or agent job), a browser, and a browser that really cannot start its sandbox", () => {
    const fails = () => false;
    const starts = () => true;
    for (const env of [{ FX_RUNNER_CHECK: "1" }, { FX_RUNNER_JOB: "1" }, { FX_RUNNER_CHECK: "1", FX_RUNNER_JOB: "1" }]) {
      expect(chromiumSandboxRefused("/x/chrome", env, fails)).toBe(true);
      expect(chromiumSandboxRefused("/x/chrome", env, starts)).toBe(false);
      expect(chromiumSandboxRefused(undefined, env, fails)).toBe(false);
    }
    for (const env of [{}, { FX_RUNNER_JOB: "0" }, { FX_RUNNER_CHECK: "" }]) expect(chromiumSandboxRefused("/x/chrome", env, fails)).toBe(false);
  });

  it("does not run the probe on a host with no sandbox marker", () => {
    let probed = false;
    chromiumSandboxRefused("/x/chrome", {}, () => ((probed = true), false));
    expect(probed).toBe(false);
  });

  it.skipIf(EXE === undefined || insideSandbox)("the real probe says a browser starts with its sandbox on a developer host and in CI", () => {
    expect(chromiumStartsWithSandbox(EXE!)).toBe(true);
  });

  it("a missing binary is a probe that answers 'does not start', not an error", () => {
    expect(chromiumStartsWithSandbox("/nonexistent/chrome")).toBe(false);
  });
});
