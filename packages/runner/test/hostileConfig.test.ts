import { describe, expect, it, vi } from "vitest";
import {
  FX_AGENT_CONFIG_DIR,
  FX_AGENT_MCP_CONFIG,
  FX_AGENT_MCP_PATH,
  FX_AGENT_SETTINGS,
  FX_AGENT_SETTINGS_PATH,
  agentSettingsFor,
  FX_LIMIT_HOOK_PATH,
  FX_LIMIT_HOOK_SCRIPT,
  FX_RUN_LIMITS_PATH,
} from "../src/agentConfig.js";
import { CLAUDE_CLI_VERSION, SANDBOX_AGENT_COMMAND, createVercelSandboxPort, type SdkCommand, type SdkSandbox } from "../src/vercelSandboxPort.js";
import type { StartDetachedOptions } from "../src/sandboxPort.js";
import { buildSandboxEnv } from "../src/sandboxEnv.js";
import { networkPolicy } from "../src/networkPolicy.js";
import { keyedPolicy } from "./helpers/keyedPolicy.js";
import { sdkSessionStubs } from "./helpers/sdkSession.js";
import { retentionPolicyFor } from "../src/sandboxNaming.js";
import { BACKENDS, CLAUDE_CODE_BACKEND } from "../src/backends.js";
import { createBackendRegistry } from "@fx/runtime/src/backends/registry.js";
import { HOSTILE_REPO_DIR, backendsRegisteredWithContract, hostileConfigViolations, readTree, runHostileConfigContract, sentinelsOf, type ProducedRun, type Produce } from "./hostileConfig.contract.js";

// The prompt file name is random; pin it so two runs can be compared byte for byte.
vi.mock("node:crypto", async (orig) => ({ ...(await orig<typeof import("node:crypto")>()), randomUUID: () => "00000000-0000-4000-8000-000000000000" }));

const WORKDIR = "/vercel/sandbox/repo";
const NAME = "rn-8-reviewer-run-1";
/** The role `startAndResume` runs as (the fixture options below). */
const START_OPTS_ROLE = "reviewer";

/** The fixture's file list, pinned so it cannot silently shrink. */
const FIXTURE_FILES = [
  ".claude/CLAUDE.md", ".claude/agents/hostile.md", ".claude/commands/hostile.md", ".claude/settings.json", ".claude/settings.local.json",
  ".claude/rules/hostile-glob.md", ".claude/rules/hostile-root.md", ".claude/skills/hostile/SKILL.md", ".codex/config.toml", ".mcp.json", ".opencode/agents/hostile.md", "AGENTS.md", "CLAUDE.local.md", "CLAUDE.md", "opencode.json", "sub/.claude/rules/hostile-nested.md", "sub/readme.txt",
];

type Op = { op: "write" | "agent"; params: Record<string, unknown> };

/** A fake SDK that records writes and agent commands in one ordered log. */
function recordingSdk() {
  const log: Op[] = [];
  const done = (): SdkCommand => ({ async *logs() {}, wait: async () => ({ exitCode: 0 }), kill: async () => undefined });
  const sandbox: SdkSandbox = {
    name: NAME,
    async runCommand(params) {
      if (params.args?.[2] === "fx-pin") {
        return { async *logs() { yield { stream: "stdout", data: `${CLAUDE_CLI_VERSION}\n` }; }, wait: async () => ({ exitCode: 0 }), kill: async () => undefined };
      }
      log.push({ op: "agent", params: params as unknown as Record<string, unknown> });
      return done();
    },
    async writeFiles(files) {
      log.push({ op: "write", params: { files } });
    },
    updateNetworkPolicy: async () => undefined,
    extendTimeout: async () => undefined,
    stop: async () => undefined,
    delete: async () => undefined,
    ...sdkSessionStubs(),
  };
  const get = async () => sandbox;
  return { log, sdk: { create: get, get } };
}

const startOpts = (workdir: string | undefined = WORKDIR): StartDetachedOptions => ({
  runId: "run-1",
  role: "reviewer",
  roleCard: "card",
  prompt: "go",
  model: "sonnet-5",
  workdir,
  capUsd: 5,
  networkPolicy: keyedPolicy(networkPolicy("reviewer", "team", { provider: "ai_gateway", githubForwardHost: "gh-proxy.fulcrumaxe.app" })),
  env: buildSandboxEnv("reviewer"),
  onEvent: () => {},
});

async function startAndResume(workdir: string | undefined = WORKDIR) {
  const { log, sdk } = recordingSdk();
  const port = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk });
  const handle = await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("reviewer"), timeoutMs: 7_200_000 });
  await port.startDetached(handle, startOpts(workdir)).hookFired.catch(() => undefined);
  await port.resume(handle, "sess-9", "next", startOpts(workdir)).hookFired.catch(() => undefined);
  return log;
}

const produceClaudeCode: Produce = async () => {
  const log = await startAndResume();
  const agents = log.filter((o) => o.op === "agent").map((o) => o.params as { args: string[]; env: Record<string, string> });
  return {
    workdir: WORKDIR,
    // args = ["-c", WRAPPER, "fx-agent", promptFile, ...agentArgv]
    argv: agents.map((a) => a.args.slice(4)),
    envs: agents.map((a) => a.env),
    writes: log.filter((o) => o.op === "write").flatMap((o) => (o.params as { files: ProducedRun["writes"] }).files),
  };
};

/** The flag groups Step 0 (pinned 2.1.0 help text) established. */
const REQUIRED = [["--setting-sources", ""], ["--settings", FX_AGENT_SETTINGS_PATH], ["--strict-mcp-config"], ["--mcp-config", FX_AGENT_MCP_PATH]];
const claudeCode = { name: "claude-code", requiredArgv: REQUIRED };

runHostileConfigContract(claudeCode, produceClaudeCode);

describe("D#221 R1a: a backend is selectable only if it is registered with the contract", () => {
  it("every backend in the registry has run runHostileConfigContract above", () => {
    expect(BACKENDS.names().filter((n) => !backendsRegisteredWithContract().includes(n))).toEqual([]);
  });

  it("the contract's flag groups are the descriptor's own, so the test cannot drift from what the port sends", () => {
    expect(CLAUDE_CODE_BACKEND.hostileConfig.requiredArgv).toEqual(REQUIRED);
  });

  it("catches a backend registered without the contract", () => {
    const stub = { ...CLAUDE_CODE_BACKEND, name: "stub-cli" };
    const names = createBackendRegistry([CLAUDE_CODE_BACKEND, stub]).names();
    expect(names.filter((n) => !backendsRegisteredWithContract().includes(n))).toEqual(["stub-cli"]);
  });
});

describe("SS-CONTRACT: removing any restriction flag fails the contract", () => {
  for (const group of REQUIRED) {
    it(`without ${group.join(" ")}`, async () => {
      const strip = (argv: string[]) => {
        const i = argv.findIndex((_, k) => group.every((g, j) => argv[k + j] === g));
        return i < 0 ? argv : [...argv.slice(0, i), ...argv.slice(i + group.length)];
      };
      const produce: Produce = async (files) => {
        const run = await produceClaudeCode(files);
        return { ...run, argv: run.argv.map(strip) };
      };
      expect((await hostileConfigViolations(claudeCode, produce)).join()).toContain(`argv lacks ${group.join(" ")}`);
    });
  }

  it("catches a runner that lets the workspace change its output, or copies a fixture file into argv or a write", async () => {
    const changes: Produce = async (files) => ({ ...(await produceClaudeCode(files)), workdir: `${WORKDIR}${Object.keys(files).length}` });
    expect((await hostileConfigViolations(claudeCode, changes)).join()).toContain("differential");
    const leaks: Produce = async (files) => {
      const run = await produceClaudeCode(files);
      return { ...run, writes: [...run.writes, { path: "/fx/x", content: files[".mcp.json"] ?? "" }, { path: `${WORKDIR}/a`, content: "" }] };
    };
    const found = (await hostileConfigViolations(claudeCode, leaks)).join("\n");
    expect(found).toContain("leak:");
    expect(found).toContain("write inside the workspace");
  });
});

describe("SS-FIXTURE", () => {
  const tree = readTree(HOSTILE_REPO_DIR);
  it("has exactly the pinned file list, each with its own sentinel", () => {
    expect(Object.keys(tree).sort()).toEqual([...FIXTURE_FILES].sort());
    for (const [file, content] of Object.entries(tree)) expect(content, file).toMatch(/FXSENT-/);
    expect(sentinelsOf(tree).length).toBeGreaterThanOrEqual(13);
  });
});

describe("SS-ARGV, SS-FILES, SS-CONTENT: claude-code start and resume", () => {
  it("every agent command carries the restriction flags from the constant", async () => {
    const run = await produceClaudeCode({});
    expect(run.argv).toHaveLength(2);
    for (const argv of run.argv) expect(argv.slice(0, SANDBOX_AGENT_COMMAND.length)).toEqual([...SANDBOX_AGENT_COMMAND]);
    expect(SANDBOX_AGENT_COMMAND.slice(5)).toEqual(["--setting-sources", "", "--settings", FX_AGENT_SETTINGS_PATH, "--strict-mcp-config", "--mcp-config", FX_AGENT_MCP_PATH]);
    // --mcp-config is variadic: a flag must follow its path.
    expect(run.argv.every((argv) => argv[SANDBOX_AGENT_COMMAND.length]!.startsWith("--"))).toBe(true);
    expect(run.argv[1]!.slice(-2)).toEqual(["--resume", "sess-9"]);
  });

  it("writes both config files, 0444, before EVERY agent command, with the exact content", async () => {
    const log = await startAndResume();
    const ops = log.map((o) => o.op);
    expect(ops).toEqual(["write", "agent", "write", "agent"]);
    for (const o of log.filter((x) => x.op === "write")) {
      const files = (o.params as { files: { path: string; content: string; mode?: number }[] }).files;
      const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
      // Owner ruling (D#483 P3): the settings are the hook plus the role's allow list and dontAsk, the same on start AND resume.
      expect(JSON.parse(byPath[FX_AGENT_SETTINGS_PATH]!.content)).toEqual(agentSettingsFor(START_OPTS_ROLE));
      expect(JSON.parse(byPath[FX_AGENT_MCP_PATH]!.content)).toEqual(FX_AGENT_MCP_CONFIG);
      expect(byPath[FX_AGENT_SETTINGS_PATH]!.mode).toBe(0o444);
      expect(byPath[FX_AGENT_MCP_PATH]!.mode).toBe(0o444);
      expect(files.find((f) => f.path.startsWith("/tmp/fx-prompt-"))!.mode).toBe(0o600);
      // C66: the runner's one hook script, on start AND resume, 0444, equal to the constant.
      expect(byPath[FX_LIMIT_HOOK_PATH]!.content).toBe(FX_LIMIT_HOOK_SCRIPT);
      expect(byPath[FX_LIMIT_HOOK_PATH]!.mode).toBe(0o444);
      expect(byPath[FX_RUN_LIMITS_PATH]!.mode).toBe(0o444);
    }
  });

  it("the base settings and MCP constants are exactly the specified objects (C66: one runner-owned PostToolUse hook; permissions come per role)", () => {
    // Written out literally, not from the constants, so a drift in either is caught.
    expect(FX_AGENT_SETTINGS).toEqual({
      disableAllHooks: false,
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: `/bin/sh ${FX_AGENT_CONFIG_DIR}/limit-hook.sh`, timeout: 5 }] }] },
      permissions: { allow: [], deny: [] },
    });
    expect(FX_LIMIT_HOOK_PATH).toBe("/fx/agent-config/limit-hook.sh");
    expect(FX_AGENT_MCP_CONFIG).toEqual({ mcpServers: {} });
  });

  it("the hook script reads only the run-limits file and does nothing else", () => {
    expect(FX_LIMIT_HOOK_SCRIPT).toContain(`f=${FX_RUN_LIMITS_PATH}`);
    // Shell builtins only: no child process at all, and no clock (C66).
    expect(FX_LIMIT_HOOK_SCRIPT).not.toMatch(/\b(cat|sed|date|awk|grep|tr|head|cut|expr)\b|\$\(|`/);
    expect(FX_LIMIT_HOOK_SCRIPT).not.toMatch(/\b(curl|wget|nc|git|node|eval|source)\b|\/vercel|\/tmp|\bsh -c/);
    expect(FX_LIMIT_HOOK_SCRIPT).not.toContain(WORKDIR);
  });
});

describe("SS-PATH: the config directory and the workdir never overlap", () => {
  it("is an absolute constant outside the workdir; no argv or env value names the workdir", async () => {
    expect(FX_AGENT_CONFIG_DIR).toBe("/fx/agent-config");
    const run = await produceClaudeCode({});
    const values = [...run.argv.flat(), ...run.envs.flatMap((e) => Object.values(e))];
    expect(values.filter((v) => v.includes(WORKDIR))).toEqual([]);
  });

  for (const workdir of ["/fx/agent-config", "/fx/agent-config/repo", "/fx/agent-config/../agent-config/x", "/fx", "/", "fx/../fx"]) {
    it(`refuses workdir ${workdir} before any SDK call, on start and resume`, async () => {
      const { log, sdk } = recordingSdk();
      const port = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk });
      const handle = await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("reviewer"), timeoutMs: 7_200_000 });
      expect(() => port.startDetached(handle, startOpts(workdir))).toThrow();
      expect(() => port.resume(handle, "sess-9", "next", startOpts(workdir))).toThrow();
      expect(log).toEqual([]);
    });
  }
});
