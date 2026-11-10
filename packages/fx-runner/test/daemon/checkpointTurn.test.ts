import { describe, expect, it } from "vitest";
import type { Job } from "@fulcrumaxe/runner-protocol";
import { CHECKPOINT_MAX_TURN_MS, runCheckpointTurn } from "../../src/daemon/checkpointTurn.js";
import type { SandboxPort } from "../../src/sandbox/port.js";

const job = { run_id: "run-1", role: "executor", role_card: { text: "card" }, model_hint: null } as unknown as Job;

function portRecording(timeouts: number[]): SandboxPort {
  return {
    async createSandbox(opts: { sandboxName: string; timeoutMs: number }) {
      timeouts.push(opts.timeoutMs);
      return { runId: "", sandboxName: opts.sandboxName };
    },
    resume: (handle: unknown) => ({ handle, hookFired: Promise.resolve(undefined) }),
    async stop() {},
    async deleteSandbox() {},
  } as unknown as SandboxPort;
}

describe("the checkpoint turn keeps the job's signed browser method (D#749 V2c-2b)", () => {
  const resumedWith = async (extra: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
    const opts: Array<Record<string, unknown>> = [];
    const sandbox = {
      async createSandbox(o: { sandboxName: string }) {
        return { runId: "", sandboxName: o.sandboxName };
      },
      resume: (handle: unknown, _session: string, _prompt: string, o: Record<string, unknown>) => (opts.push(o), { handle, hookFired: Promise.resolve(undefined) }),
      async stop() {},
      async deleteSandbox() {},
    } as unknown as SandboxPort;
    await runCheckpointTurn({ job: { ...job, ...extra } as unknown as Job, sandbox, credentials: { mode: "subscription" }, defaultModel: "sonnet", workspace: "/w", sessionId: "s", signal: new AbortController().signal, limitMs: 90_000 });
    return opts;
  };

  it("passes browser_method in the resume options when the job has one, and none otherwise", async () => {
    expect((await resumedWith({ role: "deploy-verifier", browser_method: "playwright_runner" }))[0]!["browserMethod"]).toBe("playwright_runner");
    expect((await resumedWith({}))[0]!["browserMethod"]).toBeUndefined();
  });
});

describe("the checkpoint turn's own length cap (HO-3)", () => {
  const run = async (limitMs: number): Promise<number[]> => {
    const timeouts: number[] = [];
    await runCheckpointTurn({ job, sandbox: portRecording(timeouts), credentials: { mode: "subscription" }, defaultModel: "sonnet", workspace: "/w", sessionId: "s", signal: new AbortController().signal, limitMs });
    return timeouts;
  };

  it("never gives its sandbox more than the local maximum plus the margin, whatever limit the caller passes", async () => {
    expect(await run(Number.MAX_SAFE_INTEGER)).toEqual([CHECKPOINT_MAX_TURN_MS + 60_000]);
    expect(await run(2 ** 31)).toEqual([CHECKPOINT_MAX_TURN_MS + 60_000]);
  });

  it("leaves a shorter limit as it is", async () => {
    expect(await run(90_000)).toEqual([150_000]);
  });
});
