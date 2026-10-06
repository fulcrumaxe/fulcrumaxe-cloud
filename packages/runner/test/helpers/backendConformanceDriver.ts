import type { ConformanceDriver, ConformanceIo, ConformanceRun } from "@fx/runtime/test/backends/conformance.contract.js";
import { CONFORMANCE_ROLE, CONFORMANCE_RUN_ID } from "@fx/runtime/test/backends/conformance.contract.js";
import { buildSandboxEnv } from "../../src/sandboxEnv.js";
import { networkPolicy } from "../../src/networkPolicy.js";
import { createUsageMeter } from "../../src/meteringGuard.js";
import { retentionPolicyFor } from "../../src/sandboxNaming.js";
import { buildTerminalReport } from "../../src/targets/sandboxTarget.js";
import { CLAUDE_CLI_VERSION, createVercelSandboxPort, type SdkSandbox } from "../../src/vercelSandboxPort.js";
import type { NormalizedEvent } from "../../src/types.js";
import { keyedPolicy } from "./keyedPolicy.js";
import { sdkSessionStubs } from "./sdkSession.js";

const NAME = "rn-9-reviewer-run-1";

/**
 * A sandbox whose agent command prints what the test gives it and exits with the code it gives. The version command
 * answers with the pinned version. No network, no process, no clock.
 */
function scriptedSdk(io: ConformanceIo): { create: (p: { name: unknown }) => Promise<SdkSandbox>; get: (p: { name: unknown }) => Promise<SdkSandbox> } {
  const sandbox: SdkSandbox = {
    name: NAME,
    async runCommand(params) {
      if (params.args?.[2] === "fx-pin") {
        return {
          async *logs() {
            yield { stream: "stdout", data: `${CLAUDE_CLI_VERSION} (Claude Code)\n` };
          },
          wait: async () => ({ exitCode: 0 }),
          kill: async () => undefined,
        };
      }
      return {
        async *logs() {
          for (const l of io.stderr ?? []) yield { stream: "stderr", data: l + "\n" };
          for (const l of io.stdout) yield { stream: "stdout", data: l + "\n" };
        },
        wait: async () => ({ exitCode: io.exit }),
        kill: async () => undefined,
      };
    },
    async writeFiles() {},
    updateNetworkPolicy: async () => undefined,
    extendTimeout: async () => undefined,
    stop: async () => undefined,
    delete: async () => undefined,
    ...sdkSessionStubs(),
  };
  const named = async (): Promise<SdkSandbox> => sandbox;
  return { create: named, get: named };
}

/** The Claude Code backend, through the real Vercel sandbox port over a scripted sandbox. */
export const claudeCodeConformanceDriver: ConformanceDriver = {
  backend: "claude-code",
  async run(io): Promise<ConformanceRun> {
    const delivered: NormalizedEvent[] = [];
    const invalid: string[] = [];
    const port = createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk: scriptedSdk(io), onInvalidEvent: (r) => void invalid.push(r) });
    const handle = await port.createSandbox({ sandboxName: NAME, retention: retentionPolicyFor("reviewer"), timeoutMs: 7_200_000 });
    const { hookFired } = port.startDetached(handle, {
      runId: CONFORMANCE_RUN_ID,
      role: CONFORMANCE_ROLE,
      roleCard: "role card",
      prompt: "prompt",
      model: "sonnet-5",
      backend: "claude-code",
      workdir: "/vercel/sandbox/repo",
      capUsd: 5,
      networkPolicy: keyedPolicy(networkPolicy("reviewer", "team", { provider: "ai_gateway", githubForwardHost: "gh-proxy.fulcrumaxe.app" })),
      env: buildSandboxEnv("reviewer"),
      onEvent: (e) => void delivered.push(e),
    });
    return { delivered, invalid, last: await hookFired };
  },
  meter(events) {
    const meter = createUsageMeter();
    for (const e of events) meter.observe(e);
    const t = meter.total();
    return { total: t, inputSideTokens: t.inputTokens + t.cacheWriteTokens + t.cacheReadTokens, implausible: meter.implausible(), flags: meter.flags() };
  },
  settle(last, meteredUsd) {
    const report = buildTerminalReport(last, "s1", meteredUsd);
    return { status: report.status, usd: report.usd };
  },
};
