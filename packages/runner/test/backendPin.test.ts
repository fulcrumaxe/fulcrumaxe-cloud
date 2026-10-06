import { describe, expect, it } from "vitest";
import { createClaudeCodeBackend } from "@fx/runtime/src/backends/claudeCode.js";
import { PIN_CHECK_SCRIPT, createBackendRegistry } from "@fx/runtime/src/backends/registry.js";
import { BACKENDS, CLAUDE_CODE_BACKEND } from "../src/backends.js";
import { CLAUDE_CLI_SHA256, CLAUDE_CLI_VERSION, SandboxPortError, createVercelSandboxPort, type SdkCommand, type SdkSandbox } from "../src/vercelSandboxPort.js";
import type { StartDetachedOptions } from "../src/sandboxPort.js";
import { buildSandboxEnv } from "../src/sandboxEnv.js";
import { networkPolicy } from "../src/networkPolicy.js";
import { retentionPolicyFor } from "../src/sandboxNaming.js";
import { keyedPolicy } from "./helpers/keyedPolicy.js";
import { sdkSessionStubs } from "./helpers/sdkSession.js";

/**
 * D#221 R1a: the pin check (version AND digest) before every agent command, and backend selection by registered name.
 * The fake answers the check command the way `sh` + `sha256sum` do: a version line, then `<sha>  <path>`.
 */

const NAME = "rn-8-reviewer-run-1";
type Call = { op: "runCommand" | "writeFiles"; params: Record<string, unknown> };

function harness(pin: { out?: string; exit?: number } = {}) {
  const calls: Call[] = [];
  const out = pin.out ?? `${CLAUDE_CLI_VERSION} (Claude Code)\n`;
  const sandbox: SdkSandbox = {
    name: NAME,
    async runCommand(params) {
      calls.push({ op: "runCommand", params: params as unknown as Record<string, unknown> });
      const command: SdkCommand =
        params.args?.[2] === "fx-pin"
          ? { async *logs() { for (const data of out.split("\u0000")) yield { stream: "stdout", data }; }, wait: async () => ({ exitCode: pin.exit ?? 0 }), kill: async () => undefined }
          : { async *logs() {}, wait: async () => ({ exitCode: 0 }), kill: async () => undefined };
      return command;
    },
    async writeFiles(files) {
      calls.push({ op: "writeFiles", params: { files } });
    },
    updateNetworkPolicy: async () => undefined,
    extendTimeout: async () => undefined,
    stop: async () => undefined,
    delete: async () => undefined,
    ...sdkSessionStubs(),
  };
  const get = async () => sandbox;
  return { calls, sdk: { create: get, get } };
}

const startOpts = (over: Partial<StartDetachedOptions> = {}): StartDetachedOptions => ({
  runId: "run-1",
  role: "reviewer",
  roleCard: "card",
  prompt: "go",
  model: "sonnet-5",
  workdir: "/vercel/sandbox/repo",
  capUsd: 5,
  networkPolicy: keyedPolicy(networkPolicy("reviewer", "team", { provider: "ai_gateway", githubForwardHost: "gh-proxy.fulcrumaxe.app" })),
  env: buildSandboxEnv("reviewer"),
  onEvent: () => {},
  ...over,
});

async function setup(pin?: Parameters<typeof harness>[0], backends = BACKENDS) {
  const h = harness(pin);
  const port = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk: h.sdk, backends });
  const handle = await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("reviewer"), timeoutMs: 7_200_000 });
  return { ...h, port, handle };
}

const pinCalls = (calls: Call[]) => calls.filter((c) => c.op === "runCommand" && (c.params.args as string[])[2] === "fx-pin");
const agentCalls = (calls: Call[]) => calls.filter((c) => c.op === "runCommand" && (c.params.args as string[])[2] === "fx-agent");
const fail = async (p: Promise<unknown>): Promise<SandboxPortError> => (await p.then(() => undefined, (e: unknown) => e)) as SandboxPortError;

describe("the pin check runs before EVERY agent command", () => {
  it("is one `sh -c` command naming the CLI, with no cwd and the run's env, and it passes the pinned binary", async () => {
    const { port, handle, calls } = await setup();
    await port.startDetached(handle, startOpts()).hookFired.catch(() => undefined);
    const [pin] = pinCalls(calls);
    expect(pin!.params).toMatchObject({ cmd: "sh", args: ["-c", PIN_CHECK_SCRIPT, "fx-pin", "claude", CLAUDE_CLI_SHA256], env: startOpts().env, detached: true });
    expect(pin!.params).not.toHaveProperty("cwd");
    expect(agentCalls(calls)).toHaveLength(1);
  });

  it("runs again on resume, and again for each further start", async () => {
    const { port, handle, calls } = await setup();
    await port.startDetached(handle, startOpts()).hookFired.catch(() => undefined);
    await port.resume(handle, "sess-9", "next", startOpts()).hookFired.catch(() => undefined);
    expect(pinCalls(calls)).toHaveLength(2);
    expect(agentCalls(calls)).toHaveLength(2);
    const order = calls.map((c) => (c.op === "writeFiles" ? "write" : (c.params.args as string[])[2]));
    expect(order).toEqual(["fx-pin", "write", "fx-agent", "fx-pin", "write", "fx-agent"]);
  });
});

describe("a pin that does not match fails closed, before the prompt or the agent", () => {
  const oversized = `${"x".repeat(2000)}\n${CLAUDE_CLI_SHA256}  /usr/local/bin/claude\n`;
  const cases: Array<[string, { out?: string; exit?: number }, string]> = [
    ["a different version", { out: "9.9.9 (Claude Code)\n" }, "cliVersion"],
    ["a digest mismatch (exit 4), the version line looking right", { out: `${CLAUDE_CLI_VERSION}\n`, exit: 4 }, "cliDigest"],
    ["a digest mismatch with an oversized chunk ending in the pinned hash", { out: oversized, exit: 4 }, "cliDigest"],
    ["a digest mismatch with output claiming success", { out: `${CLAUDE_CLI_VERSION}\n${CLAUDE_CLI_SHA256}  /x\n`, exit: 4 }, "cliDigest"],
    ["output over the cap with exit 0 (a cap is a failure, not a truncation)", { out: `${CLAUDE_CLI_VERSION}\n\u0000${"x".repeat(2000)}`, exit: 0 }, "cliVersion"],
    ["any other failure (exit 5)", { out: `${CLAUDE_CLI_VERSION}\n`, exit: 5 }, "cliVersion"],
    ["no output", { out: "" }, "cliVersion"],
  ];
  for (const [label, pin, operation] of cases) {
    for (const mode of ["start", "resume"] as const) {
      it(`${label} (${mode}) is ${operation}`, async () => {
        const { port, handle, calls } = await setup(pin);
        const run = mode === "start" ? port.startDetached(handle, startOpts()) : port.resume(handle, "sess-9", "next", startOpts());
        const err = await fail(run.hookFired);
        expect(err).toBeInstanceOf(SandboxPortError);
        expect(err.operation).toBe(operation);
        expect(agentCalls(calls)).toHaveLength(0);
        expect(calls.some((c) => c.op === "writeFiles")).toBe(false);
      });
    }
  }
});

describe("backend selection by registered name", () => {
  const stub = createClaudeCodeBackend({ cliVersion: "0.5.0", cliSha256: "e".repeat(64), settingsPath: "/fx/agent-config/settings.json", mcpPath: "/fx/agent-config/mcp.json" });
  const other = { ...stub, name: "stub-cli", cli: "stubcli", baseArgv: ["stubcli", ...stub.baseArgv.slice(1)], buildArgv: (i: { cliModel: string }) => ["stubcli", ...stub.baseArgv.slice(1), "--stub-model", i.cliModel] };
  const registry = createBackendRegistry([CLAUDE_CODE_BACKEND, other]);

  it("a start with no backend uses claude-code, with the argv the port always built", async () => {
    const { port, handle, calls } = await setup();
    await port.startDetached(handle, startOpts()).hookFired.catch(() => undefined);
    const args = agentCalls(calls)[0]!.params.args as string[];
    expect(args.slice(4)).toEqual(CLAUDE_CODE_BACKEND.buildArgv({ cliModel: "claude-sonnet-5", maxTurns: 100, capUsd: 5 }).map((a) => a));
  });

  it("a named registered backend supplies its own CLI, pin and argv", async () => {
    const { port, handle, calls } = await setup({ out: "0.5.0\n" }, registry);
    await port.startDetached(handle, startOpts({ backend: "stub-cli" })).hookFired.catch(() => undefined);
    expect((pinCalls(calls)[0]!.params.args as string[]).slice(3)).toEqual(["stubcli", "e".repeat(64)]);
    expect((agentCalls(calls)[0]!.params.args as string[]).slice(4)).toEqual(["stubcli", ...stub.baseArgv.slice(1), "--stub-model", "claude-sonnet-5"]);
  });

  it("the named backend's pin is the one checked: claude-code's output does not pass for it", async () => {
    const { port, handle, calls } = await setup(undefined, registry);
    const err = await fail(port.startDetached(handle, startOpts({ backend: "stub-cli" })).hookFired);
    expect(err.operation).toBe("cliVersion");
    expect(agentCalls(calls)).toHaveLength(0);
  });

  for (const mode of ["start", "resume"] as const) {
    it(`a backend that is not registered is refused before any SDK call (${mode})`, async () => {
      const { port, handle, calls } = await setup();
      const go = () => (mode === "start" ? port.startDetached(handle, startOpts({ backend: "codex" })) : port.resume(handle, "sess-9", "next", startOpts({ backend: "codex" })));
      expect(go).toThrow(/not selectable/);
      expect(calls).toEqual([]);
    });
  }

  it("the runner's own registry holds claude-code only until another backend is registered with the contract", () => {
    expect(BACKENDS.names()).toEqual(["claude-code"]);
  });
});
