/**
 * Deliberate-violation fixture for the model-call guard.
 *
 * This test forces FX_FORBID_MODEL_CALLS=1, installs the guard, then does
 * exactly the things the guard exists to stop, and asserts that each one
 * throws. If the guard is ever weakened or removed, these assertions fail
 * (the fixture goes red) instead of the violation silently succeeding.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as childProcess from "node:child_process";
import { installModelCallGuard, type InstalledGuard } from "../src/guard";

describe("model-call guard violation fixture", () => {
  let guard: InstalledGuard;
  let previousEnv: string | undefined;

  beforeEach(() => {
    previousEnv = process.env.FX_FORBID_MODEL_CALLS;
    process.env.FX_FORBID_MODEL_CALLS = "1";
    guard = installModelCallGuard();
  });

  afterEach(() => {
    guard.uninstall();
    if (previousEnv === undefined) {
      delete process.env.FX_FORBID_MODEL_CALLS;
    } else {
      process.env.FX_FORBID_MODEL_CALLS = previousEnv;
    }
  });

  it("throws on fetch() to the AI Gateway host", async () => {
    await expect(
      fetch("https://ai-gateway.vercel.sh/claude-code/v1/messages"),
    ).rejects.toThrow(/blocked fetch/);
  });

  it("throws on fetch() to the Anthropic API host", async () => {
    await expect(
      fetch("https://api.anthropic.com/v1/messages"),
    ).rejects.toThrow(/blocked fetch/);
  });

  it("does not block fetch() to an unrelated host", async () => {
    // Guard against a guard that is too broad: it must not throw for hosts
    // outside the forbidden list. We only assert it does NOT throw the
    // guard's own error; a real network failure in a sandboxed test
    // environment is expected and not what this fixture is checking.
    try {
      await fetch("https://example.com/not-a-model-endpoint");
    } catch (err) {
      expect((err as Error).message).not.toMatch(/blocked fetch/);
    }
  });

  it("throws on child_process.spawn of the claude binary", () => {
    // exec/execFile/fork all funnel through the same ChildProcess.spawn()
    // internals as spawn() itself, so the guard's message names the
    // underlying "spawn", not the entry-point function the caller used.
    expect(() => childProcess.spawn("claude", ["-p", "reply ok"])).toThrow(
      /blocked child_process spawn/,
    );
  });

  it("throws on child_process.exec of a claude command line", () => {
    expect(() => childProcess.exec('claude -p "reply ok"')).toThrow(
      /blocked child_process spawn/,
    );
  });

  it("throws on child_process.execFile of the claude binary", () => {
    expect(() => childProcess.execFile("claude", ["-p", "reply ok"])).toThrow(
      /blocked child_process spawn/,
    );
  });

  it("does not block spawning an unrelated binary", () => {
    expect(() => childProcess.spawn("true")).not.toThrow(
      /blocked child_process/,
    );
  });
});
