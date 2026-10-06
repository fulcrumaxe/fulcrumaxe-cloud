import { describe, expect, it } from "vitest";
import { createFakeSandbox } from "../src/fakeSandbox.js";
import { SandboxNotFoundError, type SandboxHandle, type StartDetachedOptions } from "../src/sandboxPort.js";
import { buildSandboxEnv } from "../src/sandboxEnv.js";
import { networkPolicy } from "../src/networkPolicy.js";
import { retentionPolicyFor, sandboxNameFor } from "../src/sandboxNaming.js";
import { createStubRuntime } from "./helpers/stubRuntime.js";
import type { NormalizedEvent } from "../src/types.js";

function detachedOpts(overrides: Partial<StartDetachedOptions> = {}): StartDetachedOptions {
  return {
    runId: "run-1",
    role: "executor",
    roleCard: "executor role card",
    prompt: "do the thing",
    model: "sonnet-5",
    capUsd: 40,
    networkPolicy: networkPolicy("executor", "team", { provider: "ai_gateway", githubForwardHost: "gh-proxy.fulcrumaxe.app" }),
    env: buildSandboxEnv("executor"),
    onEvent: () => {},
    ...overrides,
  };
}

const RESULT_EVENT: NormalizedEvent = {
  runId: "run-1",
  role: "executor",
  seq: 1,
  type: "result",
  ts: "2026-09-18T00:00:00Z",
  agentOutput: { verdict: "done" },
};

describe("fakeSandbox (SandboxPort test double)", () => {
  it("createSandbox records the options it was given, unchanged", async () => {
    const { port, state } = createFakeSandbox(createStubRuntime());
    const opts = { sandboxName: "executor-run-1", retention: retentionPolicyFor("executor"), timeoutMs: 2 * 60 * 60 * 1000 };
    await port.createSandbox(opts);
    expect(state.created).toEqual([opts]);
  });

  it("startDetached returns synchronously (detached) with a hookFired promise, which resolves to the run's terminal event", async () => {
    const runtime = createStubRuntime([RESULT_EVENT]);
    const { port } = createFakeSandbox(runtime);
    const handle: SandboxHandle = { runId: "", sandboxName: "executor-run-1" };
    const events: NormalizedEvent[] = [];
    const { hookFired } = port.startDetached(
      handle,
      detachedOpts({
        onEvent: (e) => {
          events.push(e);
        },
      }),
    );
    const terminal = await hookFired;
    expect(terminal).toEqual(RESULT_EVENT);
    expect(events).toEqual([RESULT_EVENT]);
  });

  it("startDetached passes the given networkPolicy-scoped env through to the runtime unchanged", async () => {
    const runtime = createStubRuntime([RESULT_EVENT]);
    const { port } = createFakeSandbox(runtime);
    const handle: SandboxHandle = { runId: "", sandboxName: "executor-run-1" };
    const opts = detachedOpts();
    port.startDetached(handle, opts);
    expect(runtime.startCalls).toHaveLength(1);
    expect(runtime.startCalls[0].runId).toBe(opts.runId);
    expect(runtime.startCalls[0].capUsd).toBe(opts.capUsd);
  });

  it("extendTimeout records the call", async () => {
    const { port, state } = createFakeSandbox(createStubRuntime());
    const handle: SandboxHandle = { runId: "", sandboxName: "executor-run-1" };
    await port.extendTimeout(handle, 30 * 60 * 1000);
    expect(state.extended).toEqual([{ handle, additionalMs: 30 * 60 * 1000 }]);
  });

  it("stop is idempotent and records every call, including a repeat", async () => {
    const { port, state } = createFakeSandbox(createStubRuntime());
    const handle: SandboxHandle = { runId: "", sandboxName: "executor-run-1" };
    await port.stop(handle);
    await port.stop(handle);
    expect(state.stopped).toEqual([handle, handle]);
  });

  it("hang() makes startDetached's hookFired never settle (Spec pass/fail 7's watchdog scenario, for H09b)", async () => {
    const { port, hang } = createFakeSandbox(createStubRuntime([RESULT_EVENT]));
    const sandboxName = "executor-run-1";
    hang(sandboxName);
    const handle: SandboxHandle = { runId: "", sandboxName };
    const { hookFired } = port.startDetached(handle, detachedOpts());
    const raced = await Promise.race([
      hookFired.then(() => "hook"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 20)),
    ]);
    expect(raced).toBe("timeout");
  });

  it("failResumeWithNotFound() makes resume throw SandboxNotFoundError (Spec pass/fail 9's expired-snapshot scenario, for H09b)", () => {
    const { port, failResumeWithNotFound } = createFakeSandbox(createStubRuntime());
    const sandboxName = "ex-repo-42-7";
    failResumeWithNotFound(sandboxName);
    const handle: SandboxHandle = { runId: "", sandboxName };
    expect(() => port.resume(handle, "cc-session-1", "resume prompt", detachedOpts())).toThrow(SandboxNotFoundError);
  });

  it("deleteSandbox records the call -- H09b's webhook route calls this on pr.closed/pr.merged for the executor's persistent sandbox", async () => {
    const { port, state } = createFakeSandbox(createStubRuntime());
    const accountId = "22222222-2222-4222-8222-222222222222";
    const repoId = "11111111-1111-4111-8111-111111111111";
    const handle: SandboxHandle = {
      runId: "",
      sandboxName: sandboxNameFor({ role: "executor", runId: "run-1", accountId, repoId, pr: 7 }),
    };
    await port.deleteSandbox(handle);
    expect(state.deleted).toEqual([handle]);
    expect(handle.sandboxName).toBe(`ex-${accountId}-${repoId}-7`);
  });

  /**
   * H09 security review, "informational" 1: `StartDetachedOptions.env`
   * accepted any map. This fake stands in for "the port" in this PR (no
   * real `@vercel/sandbox` implementation ships here), so it is the one
   * place that should assert `env` really is `buildSandboxEnv(role)`
   * rather than trusting the caller built it correctly.
   */
  describe("env must equal buildSandboxEnv(role) (H09 security review, informational 1)", () => {
    it("startDetached rejects an env with an extra, non-buildSandboxEnv key", () => {
      const { port } = createFakeSandbox(createStubRuntime());
      const handle: SandboxHandle = { runId: "", sandboxName: "executor-run-1" };
      const opts = detachedOpts({ env: { ...buildSandboxEnv("executor"), STRIPE_SECRET_KEY: "sk_test_leak" } });
      expect(() => port.startDetached(handle, opts)).toThrow();
    });

    it("startDetached rejects an env with a tampered placeholder value", () => {
      const { port } = createFakeSandbox(createStubRuntime());
      const handle: SandboxHandle = { runId: "", sandboxName: "executor-run-1" };
      const opts = detachedOpts({ env: { ...buildSandboxEnv("executor"), ANTHROPIC_API_KEY: "sk-ant-not-empty" } });
      expect(() => port.startDetached(handle, opts)).toThrow();
    });

    it("resume rejects a mismatched env the same way startDetached does", () => {
      const { port } = createFakeSandbox(createStubRuntime());
      const handle: SandboxHandle = { runId: "", sandboxName: "executor-run-1" };
      const opts = detachedOpts({ env: { ...buildSandboxEnv("executor"), GH_PAT: "ghp_leak" } });
      expect(() => port.resume(handle, "cc-session-1", "resume prompt", opts)).toThrow();
    });

    it("accepts exactly buildSandboxEnv(role) -- the happy path every other test in this file relies on", () => {
      const { port } = createFakeSandbox(createStubRuntime([RESULT_EVENT]));
      const handle: SandboxHandle = { runId: "", sandboxName: "executor-run-1" };
      expect(() => port.startDetached(handle, detachedOpts())).not.toThrow();
    });

    /**
     * H09 security RE-review, "should fix" 3: the mismatch error printed
     * `JSON.stringify(env)` -- the exact rejected env, values included.
     * This assertion only ever fires when a caller put something it
     * shouldn't have in `env`, so the rejected env is precisely the case
     * most likely to be carrying a real secret. The fix reports key NAMES
     * only; these tests plant a real-looking secret VALUE and assert it
     * never appears anywhere in the thrown message.
     */
    describe("the env-mismatch error never echoes a secret VALUE (H09 security re-review, should-fix 3)", () => {
      const PLANTED_GITHUB_TOKEN = "ghs_REALSECRETVALUE0000000000000000";
      const PLANTED_ANTHROPIC_KEY = "sk-ant-REALSECRETVALUE00000000000000";

      it("startDetached: an extra key carrying a planted secret value never appears in the thrown message", () => {
        const { port } = createFakeSandbox(createStubRuntime());
        const handle: SandboxHandle = { runId: "", sandboxName: "executor-run-1" };
        const opts = detachedOpts({ env: { ...buildSandboxEnv("executor"), GITHUB_TOKEN: PLANTED_GITHUB_TOKEN } });
        let thrown: unknown;
        try {
          port.startDetached(handle, opts);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).not.toContain(PLANTED_GITHUB_TOKEN);
      });

      it("resume: a tampered value on an expected key never appears in the thrown message", () => {
        const { port } = createFakeSandbox(createStubRuntime());
        const handle: SandboxHandle = { runId: "", sandboxName: "executor-run-1" };
        const opts = detachedOpts({ env: { ...buildSandboxEnv("executor"), ANTHROPIC_API_KEY: PLANTED_ANTHROPIC_KEY } });
        let thrown: unknown;
        try {
          port.resume(handle, "cc-session-1", "resume prompt", opts);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).not.toContain(PLANTED_ANTHROPIC_KEY);
      });

      it("the thrown message names the offending keys instead", () => {
        const { port } = createFakeSandbox(createStubRuntime());
        const handle: SandboxHandle = { runId: "", sandboxName: "executor-run-1" };
        const opts = detachedOpts({ env: { ...buildSandboxEnv("executor"), GITHUB_TOKEN: PLANTED_GITHUB_TOKEN } });
        expect(() => port.startDetached(handle, opts)).toThrow(/extra keys:.*GITHUB_TOKEN/);
      });
    });
  });
});

describe("D#2 SWEEP-BACKOFF: a scripted delete failure", () => {
  it("failDelete makes deleteSandbox throw to the caller, records no delete, and leaves the sandbox existing; other sandboxes still delete", async () => {
    const { port, state, failDelete } = createFakeSandbox(createStubRuntime());
    const broken: SandboxHandle = { runId: "", sandboxName: "code-reviewer-broken" };
    const fine: SandboxHandle = { runId: "", sandboxName: "code-reviewer-fine" };
    failDelete(broken.sandboxName);
    await expect(port.deleteSandbox(broken)).rejects.toThrow(/deleteSandbox failed/);
    expect(state.deleted).toEqual([]);
    expect(await port.sandboxExists(broken)).toBe(true);
    await port.deleteSandbox(fine);
    expect(state.deleted).toEqual([fine]);
    expect(await port.sandboxExists(fine)).toBe(false);
  });
});
