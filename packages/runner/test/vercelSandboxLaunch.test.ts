import { describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_VERSION,
  PROMPT_WRAPPER,
  createVercelSandboxPort,
  type SdkCommand,
  type SdkCreateParams,
  type SdkSandbox,
  type VercelSandboxSdk,
} from "../src/vercelSandboxPort.js";
import type { SandboxHandle, StartDetachedOptions } from "../src/sandboxPort.js";
import { buildSandboxEnv } from "../src/sandboxEnv.js";
import { networkPolicy } from "../src/networkPolicy.js";
import { retentionPolicyFor } from "../src/sandboxNaming.js";
import { keyedPolicy } from "./helpers/keyedPolicy.js";

/** PREVIEW-AGENT-LAUNCH: the port's `launched` promise and `sandboxState` (fake SDK). */

const NAME = "rn-8-reviewer-run-1";
const handle: SandboxHandle = { runId: "", sandboxName: NAME };
const httpError = (status: number): Error => Object.assign(new Error("boom"), { response: { status } });

function fakeSdk(knobs: { status?: string; agentCommandError?: Error; getError?: Error } = {}) {
  let release!: () => void;
  const agentGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const sandbox: SdkSandbox = {
    name: NAME,
    get status() {
      return knobs.status ?? "running";
    },
    currentSession: () => ({ sessionId: "sess-1" }),
    async runCommand(params): Promise<SdkCommand> {
      const isAgent = params.args?.[1] === PROMPT_WRAPPER;
      if (isAgent) {
        events.push("agentCommand");
        if (knobs.agentCommandError) throw knobs.agentCommandError;
      }
      return {
        async *logs() {
          if (isAgent) await agentGate; // the agent keeps running: its output has not ended
          else if (params.args?.[2] === "fx-pin") yield { stream: "stdout", data: `${CLAUDE_CLI_VERSION}\n` };
        },
        wait: async () => ({ exitCode: 0 }),
        kill: async () => undefined,
      };
    },
    writeFiles: async () => undefined,
    updateNetworkPolicy: async () => undefined,
    extendTimeout: async () => undefined,
    stop: async () => undefined,
    delete: async () => undefined,
    listSessions: async () => ({ sessions: [], pagination: { next: null } }),
  };
  const sdk: VercelSandboxSdk = {
    create: async (params: SdkCreateParams) => (void params, sandbox),
    get: async () => {
      if (knobs.getError) throw knobs.getError;
      return sandbox;
    },
  };
  return { sdk, events, release };
}

const newPort = (sdk: VercelSandboxSdk) => createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk, measureRetryDelayMs: 0 });

function startOpts(overrides: Partial<StartDetachedOptions> = {}): StartDetachedOptions {
  return {
    runId: "run-1",
    role: "reviewer",
    roleCard: "card",
    prompt: "go",
    model: "sonnet-5",
    capUsd: 5,
    networkPolicy: keyedPolicy(networkPolicy("reviewer", "team", { provider: "ai_gateway", githubForwardHost: "gh-proxy.fulcrumaxe.app" })),
    env: buildSandboxEnv("reviewer"),
    onEvent: () => {},
    ...overrides,
  };
}

describe("launched", () => {
  it("settles when the agent command exists, not when the agent ends", async () => {
    const f = fakeSdk();
    const port = newPort(f.sdk);
    const made = await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("reviewer"), timeoutMs: 7_200_000 });
    const run = port.startDetached(made, startOpts());
    const ended = run.hookFired.then(() => "ended");
    await run.launched;
    expect(f.events).toEqual(["agentCommand"]);
    // The agent is still running: the run has not ended.
    expect(await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve("still running"), 30))])).toBe("still running");
    f.release();
    await run.hookFired;
  });

  it("rejects when the launch fails before a command exists, and the run's hook rejects with it", async () => {
    const f = fakeSdk({ agentCommandError: httpError(500) });
    const port = newPort(f.sdk);
    const made = await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("reviewer"), timeoutMs: 7_200_000 });
    const run = port.startDetached(made, startOpts());
    await expect(run.launched).rejects.toBeTruthy();
    await expect(run.hookFired).rejects.toBeTruthy();
  });

  it("rejects when the sandbox cannot be attached to at all", async () => {
    const f = fakeSdk({ getError: httpError(404) });
    const port = newPort(f.sdk);
    const run = port.startDetached(handle, startOpts());
    await expect(run.launched).rejects.toBeTruthy();
    await expect(run.hookFired).rejects.toBeTruthy();
  });
});

describe("sandboxState", () => {
  const stateFor = (knobs: Parameters<typeof fakeSdk>[0]) => newPort(fakeSdk(knobs).sdk).sandboxState!(handle);

  it("running and pending are running; stopped, failed and aborted are stopped", async () => {
    expect(await stateFor({ status: "running" })).toBe("running");
    expect(await stateFor({ status: "pending" })).toBe("running");
    for (const status of ["stopped", "failed", "aborted"]) expect(await stateFor({ status })).toBe("stopped");
  });

  it("a stop in progress, a snapshot or a status it does not know is unknown (looked at again later)", async () => {
    for (const status of ["stopping", "snapshotting", "something-new"]) expect(await stateFor({ status })).toBe("unknown");
  });

  it("gone only for a definite 404 or 410; any other failure is unknown", async () => {
    for (const status of [404, 410]) expect(await stateFor({ getError: httpError(status) })).toBe("gone");
    for (const status of [403, 500, 503]) expect(await stateFor({ getError: httpError(status) })).toBe("unknown");
    expect(await stateFor({ getError: new Error("ECONNRESET") })).toBe("unknown");
  });

  it("reads the sandbox without waking it", async () => {
    const seen: (boolean | undefined)[] = [];
    const f = fakeSdk();
    const sdk: VercelSandboxSdk = { create: f.sdk.create, get: async (p) => (seen.push(p.resume), f.sdk.get(p)) };
    await newPort(sdk).sandboxState!(handle);
    expect(seen).toEqual([false]);
  });
});
