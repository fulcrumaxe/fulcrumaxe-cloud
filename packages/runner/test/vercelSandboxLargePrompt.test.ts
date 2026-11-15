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
import type { StartDetachedOptions } from "../src/sandboxPort.js";
import { buildSandboxEnv } from "../src/sandboxEnv.js";
import { networkPolicy } from "../src/networkPolicy.js";
import { retentionPolicyFor } from "../src/sandboxNaming.js";
import { keyedPolicy } from "./helpers/keyedPolicy.js";

// Linux caps ONE argument string at 128 KiB (MAX_ARG_STRLEN), so a long prompt must never be an argument of any command the port runs.
const ARG_STRING_LIMIT = 128 * 1024;
const NAME = "rn-8-reviewer-run-1";

describe("a prompt longer than one argument string", () => {
  it("goes to the sandbox as a file's content; no command argument carries it", async () => {
    const commands: Array<{ cmd: string; args: string[] }> = [];
    const files: Array<{ path: string; content: string }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sandbox: SdkSandbox = {
      name: NAME,
      status: "running",
      currentSession: () => ({ sessionId: "sess-1" }),
      async runCommand(params): Promise<SdkCommand> {
        commands.push({ cmd: params.cmd, args: [...(params.args ?? [])] });
        const isAgent = params.args?.[1] === PROMPT_WRAPPER;
        return {
          async *logs() {
            if (isAgent) await gate;
            else if (params.args?.[2] === "fx-pin") yield { stream: "stdout", data: `${CLAUDE_CLI_VERSION}\n` };
          },
          wait: async () => ({ exitCode: 0 }),
          kill: async () => undefined,
        };
      },
      writeFiles: async (list) => void files.push(...list.map((f) => ({ path: f.path, content: String(f.content) }))),
      updateNetworkPolicy: async () => undefined,
      extendTimeout: async () => undefined,
      stop: async () => undefined,
      delete: async () => undefined,
      listSessions: async () => ({ sessions: [], pagination: { next: null } }),
    };
    const sdk: VercelSandboxSdk = { create: async (params: SdkCreateParams) => (void params, sandbox), get: async () => sandbox };
    const port = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk, measureRetryDelayMs: 0 });
    const made = await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("code-reviewer"), timeoutMs: 7_200_000, networkPolicy: [] });
    const prompt = `START-${"x".repeat(3 * ARG_STRING_LIMIT)}-END`;
    const opts: StartDetachedOptions = {
      runId: "run-1",
      role: "code-reviewer",
      roleCard: "card",
      prompt,
      model: "sonnet-5",
      capUsd: 5,
      networkPolicy: keyedPolicy(networkPolicy("code-reviewer", "team", { provider: "ai_gateway", githubForwardHost: "gh-proxy.fulcrumaxe.app" })),
      env: buildSandboxEnv("code-reviewer"),
      onEvent: () => {},
    };
    const run = port.startDetached(made, opts);
    await run.launched;

    const agent = commands.find((c) => c.args[1] === PROMPT_WRAPPER);
    expect(agent).toBeDefined();
    for (const c of commands) for (const a of [c.cmd, ...c.args]) expect(a.length).toBeLessThan(ARG_STRING_LIMIT);
    expect(commands.some((c) => c.args.join(" ").includes("START-"))).toBe(false);
    // The wrapper reads the file named by the command's first argument as the agent's standard input.
    const promptFile = agent!.args[3]!;
    expect(promptFile).toMatch(/^\/tmp\/fx-prompt-/);
    expect(files.find((f) => f.path === promptFile)?.content).toBe(`card\n\n${prompt}`);
    release();
    await run.hookFired;
  });
});
