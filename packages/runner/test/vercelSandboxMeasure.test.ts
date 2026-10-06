import { describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_VERSION,
  COUNTERS_SCRIPT,
  MEASURE_MAX_READS,
  SandboxPortError,
  createVercelSandboxPort,
  type SdkCommand,
  type SdkCreateParams,
  type SdkSandbox,
  type SdkSession,
} from "../src/vercelSandboxPort.js";
import { SANDBOX_VCPUS, type SandboxHandle, type StartDetachedOptions } from "../src/sandboxPort.js";
import { buildSandboxEnv } from "../src/sandboxEnv.js";
import { networkPolicy } from "../src/networkPolicy.js";
import { retentionPolicyFor } from "../src/sandboxNaming.js";
import { keyedPolicy } from "./helpers/keyedPolicy.js";

/** D#2 COMPUTE-SETTLE CS-1: the Vercel port's `measure`, `readCounters`, pinned resources and session report (fake SDK). */

const NAME = "rn-8-reviewer-run-1";
const createOpts = { sandboxName: NAME, retention: retentionPolicyFor("reviewer"), timeoutMs: 7_200_000 };

const full = (id: string, extra: Partial<SdkSession> = {}): SdkSession => ({
  id,
  memory: 4096,
  region: "iad1",
  duration: 300_000,
  activeCpuDurationMs: 60_000,
  networkTransfer: { ingress: 5, egress: 1234 },
  ...extra,
});

function httpError(status: number): Error {
  return Object.assign(new Error("boom"), { response: { status } });
}

/** A fake SDK whose `listSessions` serves `reads[n]` (a list of pages) on the n-th read; a call without a cursor starts a read. */
function fakeSdk(reads: SdkSession[][][] = [[[]]]) {
  const log: string[] = [];
  const commands: { cmd: string; args?: string[] }[] = [];
  const created: SdkCreateParams[] = [];
  const listCalls: { cursor?: string }[] = [];
  const knobs = { running: true, counterOut: "12.5 3000 4096\n", counterExit: 0, hangCounters: false, listError: undefined as number | undefined };
  let read = -1;
  const sandbox: SdkSandbox = {
    name: NAME,
    get status() {
      return knobs.running ? "running" : "stopped";
    },
    currentSession: () => ({ sessionId: "sess-1" }),
    async runCommand(params): Promise<SdkCommand> {
      log.push("runCommand");
      commands.push({ cmd: params.cmd, args: params.args });
      const isCounters = params.args?.[1] === COUNTERS_SCRIPT;
      const out = isCounters ? knobs.counterOut : params.args?.[2] === "fx-pin" ? `${CLAUDE_CLI_VERSION}\n` : "";
      return {
        async *logs() {
          if (isCounters && knobs.hangCounters) await new Promise<never>(() => undefined);
          if (out) yield { stream: "stdout", data: out };
        },
        wait: async () => ({ exitCode: isCounters ? knobs.counterExit : 0 }),
        kill: async () => undefined,
      };
    },
    writeFiles: async () => undefined,
    updateNetworkPolicy: async () => undefined,
    extendTimeout: async () => undefined,
    stop: async () => undefined,
    delete: async () => undefined,
    async listSessions(params) {
      listCalls.push({ cursor: params?.cursor });
      if (knobs.listError) throw httpError(knobs.listError);
      if (params?.cursor === undefined) read++;
      const pages = reads[Math.min(read, reads.length - 1)]!;
      const index = Number(params?.cursor ?? 0);
      return { sessions: pages[index] ?? [], pagination: { next: index + 1 < pages.length ? String(index + 1) : null } };
    },
  };
  const sdk = {
    create: async (params: SdkCreateParams) => (created.push(params), sandbox),
    get: async () => sandbox,
  };
  return { sdk, sandbox, log, commands, created, listCalls, knobs };
}

const newPort = (f: ReturnType<typeof fakeSdk>, callTimeoutMs?: number) =>
  createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk: f.sdk, measureRetryDelayMs: 0, callTimeoutMs });

const handle: SandboxHandle = { runId: "", sandboxName: NAME };

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

describe("measure", () => {
  it("returns only the requested sessions, with every figure mapped, across two pages", async () => {
    const f = fakeSdk([[[full("other"), full("s1")], [full("s2", { memory: 2048, duration: 61_000, activeCpuDurationMs: 7, networkTransfer: { ingress: 0, egress: 9 } })]]]);
    const usage = await newPort(f).measure(handle, ["s1", "s2"]);
    expect(usage).toEqual([
      { sessionId: "s1", memoryMb: 4096, region: "iad1", durationMs: 300_000, activeCpuMs: 60_000, egressBytes: 1234 },
      { sessionId: "s2", memoryMb: 2048, region: "iad1", durationMs: 61_000, activeCpuMs: 7, egressBytes: 9 },
    ]);
    expect(f.listCalls.map((c) => c.cursor)).toEqual([undefined, "1"]);
  });

  it("a session whose CPU is not reported yet comes back without it, never throws, and is re-read at most 3 times", async () => {
    const f = fakeSdk([[[full("s1", { activeCpuDurationMs: undefined })]]]);
    const usage = await newPort(f).measure(handle, ["s1"]);
    expect(usage).toEqual([{ sessionId: "s1", memoryMb: 4096, region: "iad1", durationMs: 300_000, egressBytes: 1234 }]);
    expect(f.listCalls).toHaveLength(MEASURE_MAX_READS);
  });

  it("stops re-reading once every figure is in", async () => {
    const f = fakeSdk([[[full("s1", { networkTransfer: undefined })]], [[full("s1")]]]);
    const usage = await newPort(f).measure(handle, ["s1"]);
    expect(usage[0]).toMatchObject({ egressBytes: 1234 });
    expect(f.listCalls).toHaveLength(2);
  });

  it("an API 5xx is a SandboxPortError, and no session ids means no call", async () => {
    const f = fakeSdk();
    f.knobs.listError = 503;
    await expect(newPort(f).measure(handle, ["s1"])).rejects.toMatchObject({ name: SandboxPortError.name, operation: "measure", status: 503 });
    const none = fakeSdk();
    expect(await newPort(none).measure(handle, [])).toEqual([]);
    expect(none.listCalls).toHaveLength(0);
  });
});

describe("createSandbox and the session report", () => {
  it("pins 2 vCPUs, opens no ports, and the handle carries the created session", async () => {
    const f = fakeSdk();
    const made = await newPort(f).createSandbox(createOpts);
    expect(f.created[0]).toMatchObject({ resources: { vcpus: SANDBOX_VCPUS } });
    expect(SANDBOX_VCPUS).toBe(2);
    expect(f.created[0]).not.toHaveProperty("ports");
    expect(made.sessionId).toBe("sess-1");
  });

  it("onSession is awaited before any command starts, on both startDetached and resume", async () => {
    for (const mode of ["start", "resume"] as const) {
      const f = fakeSdk();
      const port = newPort(f);
      const made = await port.createSandbox(createOpts);
      const seen: string[] = [];
      const onSession = async (id: string) => {
        seen.push(id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(`awaited:${f.log.length}`); // no command had started by now
      };
      const run = mode === "start" ? port.startDetached(made, startOpts({ onSession })) : port.resume(made, "cc-1", "again", startOpts({ onSession }));
      await run.hookFired;
      expect(seen).toEqual(["sess-1", "awaited:0"]);
      expect(f.log.length).toBeGreaterThan(0);
    }
  });
});

describe("readCounters", () => {
  it("reads the VM's own counters in the running session", async () => {
    const f = fakeSdk();
    expect(await newPort(f).readCounters(handle)).toEqual({ sessionId: "sess-1", uptimeMs: 12_500, cpuMs: 3000, txBytes: 4096 });
    // The one extra command is exactly the constant script, nothing else.
    expect(f.commands).toEqual([{ cmd: "sh", args: ["-c", COUNTERS_SCRIPT] }]);
  });

  it("never wakes a stopped sandbox, and any failure is just undefined", async () => {
    const stopped = fakeSdk();
    stopped.knobs.running = false;
    expect(await newPort(stopped).readCounters(handle)).toBeUndefined();
    expect(stopped.log).toEqual([]);
    for (const out of ["", "garbage", "1 2", "1 2 3 4", "1 -2 3", "1 NaN 3"]) {
      const f = fakeSdk();
      f.knobs.counterOut = out;
      expect(await newPort(f).readCounters(handle)).toBeUndefined();
    }
    const failed = fakeSdk();
    failed.knobs.counterExit = 1;
    expect(await newPort(failed).readCounters(handle)).toBeUndefined();
  });

  it("is bounded: a command that never finishes does not hold the caller", async () => {
    const f = fakeSdk();
    f.knobs.hangCounters = true;
    const started = Date.now();
    expect(await newPort(f, 50).readCounters(handle)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("the command is one read-only shell script: no write, no network", () => {
    expect(COUNTERS_SCRIPT).not.toMatch(/>>|>\s*[/&]|\bcurl\b|\bwget\b|\bnc\b|\brm\b|\btee\b/);
  });
});

describe("sandboxExists", () => {
  const withGet = (get: (p: { signal?: AbortSignal }) => Promise<SdkSandbox>, callTimeoutMs?: number) =>
    createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk: { create: fakeSdk().sdk.create, get }, callTimeoutMs });

  it("is false only for a definite 404 or 410 on get", async () => {
    for (const status of [404, 410]) expect(await withGet(async () => Promise.reject(httpError(status))).sandboxExists(handle)).toBe(false);
    expect(await newPort(fakeSdk()).sandboxExists(handle)).toBe(true);
  });

  it("any other answer counts as 'exists': a 5xx, a 403, a network error, a malformed answer, another sandbox's name, a timeout", async () => {
    const answers: (() => Promise<SdkSandbox>)[] = [
      async () => Promise.reject(httpError(500)),
      async () => Promise.reject(httpError(403)),
      async () => Promise.reject(new Error("ECONNRESET")),
      async () => undefined as unknown as SdkSandbox,
      async () => ({ ...fakeSdk().sandbox, name: "rn-8-someone-else" }),
    ];
    for (const get of answers) expect(await withGet(get).sandboxExists(handle)).toBe(true);
    const hang = (p: { signal?: AbortSignal }) => new Promise<SdkSandbox>((_, reject) => p.signal?.addEventListener("abort", () => reject(new Error("timed out"))));
    expect(await withGet(hang, 30).sandboxExists(handle)).toBe(true);
  });
});
