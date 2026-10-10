import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@fulcrumaxe/runner-protocol";
import { cleanEnv, type CleanEnvOptions } from "../src/job/cleanEnv.js";
import { AgentRunFailed, HostSandboxRefused, createHostSandbox } from "../src/sandbox/hostSandbox.js";
import type { NetworkRule, StartDetachedOptions } from "../src/sandbox/port.js";

type Block = { filesystem: { allowWrite: string[]; denyWrite: string[] }; network: { allowedDomains: string[] } } & Record<string, unknown>;
const HOME = "/home/jane";
/** The runner state directory must be writable: the per-job env file is made under it (D#6 C44-1). */
const STATE = mkdtempSync(path.join(tmpdir(), "r4b13_state-"));

function setup(over: { hold?: boolean; done?: unknown; envOptions?: CleanEnvOptions; mirrorsRoot?: string } = {}) {
  const blocks: Block[] = [];
  const runIds: unknown[] = [];
  const starts: unknown[] = [];
  const stops: unknown[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime: AgentRuntime = {
    start: async (opts) => {
      starts.push(opts);
      return { handle: { runId: opts.runId, done: over.done ?? (over.hold ? gate : Promise.resolve()) } };
    },
    stop: async (handle) => {
      stops.push(handle);
      release();
    },
    resume: async (handle) => ({ handle }),
  };
  const tempRoot = mkdtempSync(path.join(tmpdir(), "r4b13_host-"));
  const host = createHostSandbox({
    credentials: { mode: "subscription" },
    ...(over.envOptions === undefined ? {} : { envOptions: over.envOptions }),
    makeRuntime: (sandbox, _protected, _jobEnv, runId) => {
      blocks.push(sandbox as Block);
      runIds.push(runId);
      return runtime;
    },
    home: HOME,
    stateDir: STATE,
    binaryDir: `${HOME}/.local/bin`,
    registries: ["registry.npmjs.org"],
    ...(over.mirrorsRoot === undefined ? {} : { mirrorsRoot: over.mirrorsRoot }),
    tempRoot,
    workspaceRoot: tmpdir(),
  });
  const workdir = mkdtempSync(path.join(tmpdir(), "r4b13_wd-"));
  const opts = (more: Partial<StartDetachedOptions> = {}): StartDetachedOptions => ({
    runId: "run-1", role: "executor", roleCard: "card", prompt: "p", model: "sonnet", workdir, capUsd: 0,
    networkPolicy: [{ host: "api.anthropic.com", purpose: "model" }], env: cleanEnv({ mode: "subscription" }), onEvent: () => undefined, ...more,
  });
  const create = (name = "rn-1") => host.createSandbox({ sandboxName: name, retention: { persistent: false }, timeoutMs: 1_000 });
  return { host, blocks, runIds, starts, stops, tempRoot, workdir, opts, create, release: () => release() };
}

afterEach(() => vi.useRealTimers());

describe("hostSandbox: refusals happen before anything is built or started", () => {
  const rules: Array<[string, NetworkRule]> = [
    ["an authHeader rule", { host: "api.anthropic.com", purpose: "model", authHeader: "x-api-key" }],
    ["a rule that carries a header value", Object.defineProperty({ host: "api.anthropic.com", purpose: "model" }, "authValue", { value: "k", enumerable: false }) as NetworkRule],
    ["the cloud's GitHub forwarder", { host: "gh-proxy.example.com", purpose: "github_proxy" }],
  ];
  it.each(rules)("throws on %s, with no runtime built", async (_label, rule) => {
    const t = setup();
    const handle = await t.create();
    expect(() => t.host.startDetached(handle, t.opts({ networkPolicy: [rule] }))).toThrow(HostSandboxRefused);
    expect(t.blocks).toEqual([]);
    expect(t.starts).toEqual([]);
  });

  it("throws when env is not exactly cleanEnv, and when the workdir is not absolute", async () => {
    const t = setup();
    const handle = await t.create();
    expect(() => t.host.startDetached(handle, t.opts({ env: { ...cleanEnv({ mode: "subscription" }), GH_TOKEN: "x" } }))).toThrow("env_not_clean");
    expect(() => t.host.startDetached(handle, t.opts({ workdir: "relative" }))).toThrow("bad_workdir");
    expect(t.starts).toEqual([]);
  });

  it("with extra PATH directories configured, env must carry exactly them: the plain clean env is refused, and so is a different set", async () => {
    const tools = { extraPathDirs: ["/nix/store/aaa-bubblewrap/bin", "/nix/store/bbb-socat/bin"] };
    const t = setup({ envOptions: tools });
    const handle = await t.create();
    expect(() => t.host.startDetached(handle, t.opts({ env: cleanEnv({ mode: "subscription" }) }))).toThrow("env_not_clean");
    expect(() => t.host.startDetached(handle, t.opts({ env: cleanEnv({ mode: "subscription" }, { extraPathDirs: ["/nix/store/other/bin"] }) }))).toThrow("env_not_clean");
    expect(t.starts).toEqual([]);
    expect(() => t.host.startDetached(handle, t.opts({ env: cleanEnv({ mode: "subscription" }, tools) }))).not.toThrow();
  });

  it("a second start while the first is running is refused", async () => {
    const t = setup({ hold: true });
    const handle = await t.create();
    const first = t.host.startDetached(handle, t.opts());
    expect(() => t.host.startDetached(handle, t.opts())).toThrow("sandbox_busy");
    t.release();
    await first.hookFired;
  });

  it("starting a sandbox that was never created or is deleted throws not-found", async () => {
    const t = setup();
    expect(() => t.host.startDetached({ runId: "", sandboxName: "nope" }, t.opts())).toThrow("sandbox not found");
  });
});

describe("hostSandbox: the runtime is built for one run", () => {
  it("hands makeRuntime the run id of the job it is built for, so its events can be routed to that run", async () => {
    const t = setup();
    const one = await t.create("rn-1");
    const two = await t.create("rn-2");
    await t.host.startDetached(one, t.opts({ runId: "run-1" })).hookFired;
    await t.host.startDetached(two, t.opts({ runId: "run-2" })).hookFired;
    expect(t.runIds).toEqual(["run-1", "run-2"]);
  });
});

describe("hostSandbox: the sandbox block comes from the one builder, for this job", () => {
  it("builds an enabled block for the job's workdir, its own temp dir, the model host plus the declared registries", async () => {
    const t = setup();
    const handle = await t.create();
    await t.host.startDetached(handle, t.opts()).hookFired;
    expect(t.blocks).toHaveLength(1);
    const block = t.blocks[0]!;
    expect(block).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(block.filesystem.allowWrite).toEqual([t.workdir, path.join(t.tempRoot, "rn-1")]);
    expect(block.filesystem.denyWrite).toEqual([STATE, `${HOME}/.local/bin`]);
    expect(block.network.allowedDomains).toEqual(["api.anthropic.com", "registry.npmjs.org"]);
  });

  it("the policy's hosts are the allowlist: a host that is not a plain DNS name stops the start", async () => {
    const t = setup();
    const handle = await t.create();
    expect(() => t.host.startDetached(handle, t.opts({ networkPolicy: [{ host: "*.evil.example", purpose: "package_registry" }] }))).toThrow(TypeError);
    expect(t.starts).toEqual([]);
  });

  it("resume starts the agent with the session to resume and the new prompt", async () => {
    const t = setup();
    const handle = await t.create();
    await t.host.resume(handle, "sess-1", "carry on", t.opts()).hookFired;
    expect(t.starts[0]).toMatchObject({ resumeSessionId: "sess-1", prompt: "carry on" });
  });
});

describe("hostSandbox: lifecycle", () => {
  it("delete removes the per-job temp directory and the sandbox; state follows", async () => {
    const t = setup();
    const handle = await t.create();
    const temp = path.join(t.tempRoot, "rn-1");
    expect(existsSync(temp)).toBe(true);
    expect(await t.host.sandboxExists(handle)).toBe(true);
    await t.host.deleteSandbox(handle);
    expect(existsSync(temp)).toBe(false);
    expect(await t.host.sandboxExists(handle)).toBe(false);
    expect(await t.host.sandboxState?.(handle)).toBe("gone");
    expect(await t.host.measure(handle, ["s"])).toEqual([]);
    expect(await t.host.readCounters(handle)).toBeUndefined();
  });

  it("the wall-clock limit stops the agent and ends the hook with sandbox_timeout; extendTimeout moves it", async () => {
    vi.useFakeTimers();
    const t = setup({ hold: true });
    const handle = await t.create();
    await t.host.extendTimeout(handle, 1_000);
    const { hookFired } = t.host.startDetached(handle, t.opts());
    const settled = hookFired.then(() => "ok", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(t.stops).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(t.stops).toHaveLength(1);
    expect(await settled).toBe("sandbox_timeout");
    expect(await t.host.sandboxState?.(handle)).toBe("stopped");
  });
});

describe("hostSandbox: the sandbox name is one plain segment", () => {
  it.each(["", ".", "..", "../x", "a/b", "/abs", "a\\b", ".hidden", "x..y", "a".repeat(129)])("refuses %j before any directory is made or removed", async (name) => {
    const t = setup();
    const before = readdirSync(t.tempRoot);
    await expect(t.create(name)).rejects.toMatchObject({ code: "bad_sandbox_name" });
    expect(readdirSync(t.tempRoot)).toEqual(before);
    expect(existsSync(t.tempRoot)).toBe(true);
    await t.host.deleteSandbox({ runId: "", sandboxName: name });
    expect(existsSync(t.tempRoot)).toBe(true);
  });

  it("refuses a name that is already live, keeps the first sandbox's directory, and takes the name again once it is deleted", async () => {
    const t = setup();
    const first = await t.create("rn-dup");
    await expect(t.create("rn-dup")).rejects.toMatchObject({ code: "sandbox_exists" });
    expect(await t.host.sandboxExists(first)).toBe(true);
    expect(readdirSync(t.tempRoot)).toEqual(["rn-dup"]);
    await t.host.deleteSandbox(first);
    await expect(t.create("rn-dup")).resolves.toMatchObject({ sandboxName: "rn-dup" });
  });

  it("still takes an ordinary name", async () => {
    const t = setup();
    await t.create("rn-0a1b2c3d-4e5f.6");
    expect(readdirSync(t.tempRoot)).toEqual(["rn-0a1b2c3d-4e5f.6"]);
  });
});

describe("hostSandbox: the engine's outcome is carried through", () => {
  it.each(["credential_mismatch", "no_init_line", "claude_flags_unsupported", "permission_mode_forced", "agent_error", "agent_exit"])("a failed outcome %s rejects hookFired with that code", async (failureReason) => {
    const t = setup({ done: Promise.resolve({ status: "failed", failureReason, engineVersion: "2.1.289" }) });
    const handle = await t.create();
    const error = await t.host.startDetached(handle, t.opts()).hookFired.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(AgentRunFailed);
    expect((error as AgentRunFailed).code).toBe(failureReason);
  });

  it("an outcome with no usable reason is an agent exit, and a clean one or none settles as before", async () => {
    for (const [done, code] of [[{ status: "failed", failureReason: "Not A Code" }, "agent_exit"], [{ status: "failed" }, "agent_exit"], [{ status: "ok", engineVersion: "x" }, undefined], [undefined, undefined]] as const) {
      const t = setup({ done: Promise.resolve(done) });
      const handle = await t.create();
      const error = await t.host.startDetached(handle, t.opts()).hookFired.then(() => undefined, (e: unknown) => e);
      expect((error as AgentRunFailed | undefined)?.code).toBe(code);
    }
  });
});

describe("hostSandbox: the block goes through the one builder and its guard", () => {
  it("calls sandboxSettings and checks the block before the runtime is made", () => {
    const host = readFileSync(path.join(import.meta.dirname, "..", "src", "sandbox", "hostSandbox.ts"), "utf8");
    expect(host).toContain("sandboxSettings({");
    expect(host.indexOf("assertEnabledSandbox(sandbox)")).toBeLessThan(host.indexOf("config.makeRuntime(sandbox,"));
  });
});

describe("hostSandbox: git path B reads one repo mirror's objects and nothing else of the mirrors", () => {
  const MIRRORS = `${HOME}/.cache/fx-runner/mirrors`;
  const OBJECTS = `${MIRRORS}/0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f.git/objects`;
  type FsBlock = { filesystem: { allowRead: string[]; allowWrite: string[]; denyWrite: string[]; denyRead: string[] } };

  it("the job's settings hold exactly one extra read path, no matching write entry, and the mirrors root in denyWrite", async () => {
    const t = setup({ mirrorsRoot: MIRRORS });
    const handle = await t.create();
    t.host.startDetached(handle, t.opts({ extraReadPaths: [OBJECTS] }));
    const fs = (t.blocks[0] as unknown as FsBlock).filesystem;
    expect(fs.allowRead).toEqual([t.workdir, expect.stringContaining(t.tempRoot), OBJECTS]);
    expect(fs.allowWrite).not.toContain(OBJECTS);
    expect(fs.allowWrite.some((entry) => entry === MIRRORS || entry.startsWith(`${MIRRORS}/`))).toBe(false);
    expect(fs.denyWrite).toContain(MIRRORS);
    expect(fs.denyRead).toContain(MIRRORS);
  });

  it("a job with no grant gets none, and a grant is refused when no mirrors root is configured", async () => {
    const t = setup({ mirrorsRoot: MIRRORS });
    t.host.startDetached(await t.create(), t.opts());
    expect((t.blocks[0] as unknown as FsBlock).filesystem.allowRead).toEqual([t.workdir, expect.stringContaining(t.tempRoot)]);
    const bare = setup();
    const handle = await bare.create("rn-2");
    expect(() => bare.host.startDetached(handle, bare.opts({ extraReadPaths: [OBJECTS] }))).toThrow(/not under a runner-owned root/);
    expect(bare.blocks).toEqual([]);
  });
});
