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
