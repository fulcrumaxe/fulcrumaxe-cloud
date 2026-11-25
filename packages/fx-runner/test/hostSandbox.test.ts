import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SURVEY_ROLE, type AgentRuntime } from "@fulcrumaxe/runner-protocol";
import { cleanEnv, type CleanEnvOptions } from "../src/job/cleanEnv.js";
import { AgentRunFailed, HostSandboxRefused, createHostSandbox } from "../src/sandbox/hostSandbox.js";
import type { NetworkRule, StartDetachedOptions } from "../src/sandbox/port.js";
import type { WslMachine } from "../src/sandbox/platform.js";
import { tempDir } from "./helpers/tempTree.js";

type Block = { filesystem: { allowWrite: string[]; denyWrite: string[]; allowRead: string[] }; network: { allowedDomains: string[] } } & Record<string, unknown>;
const HOME = "/home/jane";
const ROOT_TABLE = "26 1 8:16 / / rw,relatime - ext4 /dev/sdb rw\n";
/** The runner state directory must be writable: the per-job env file is made under it (D#6 C44-1). */
const STATE = tempDir("r4b13_state-");

function setup(over: { hold?: boolean; done?: unknown; stopFails?: boolean; envOptions?: CleanEnvOptions; mirrorsRoot?: string; wsl?: { denyPaths: readonly string[]; loopback: boolean }; machine?: WslMachine } = {}) {
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
      if (over.stopFails === true) throw new Error("the agent's group did not end");
    },
    resume: async (handle) => ({ handle }),
  };
  const tempRoot = tempDir("r4b13_host-");
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
    wsl: over.machine ?? (over.wsl === undefined ? undefined : { interopEntry: () => false, mountinfo: () => ROOT_TABLE, clearance: over.wsl }),
    tempRoot,
    workspaceRoot: tmpdir(),
  });
  const workdir = tempDir("r4b13_wd-");
  const opts = (more: Partial<StartDetachedOptions> = {}): StartDetachedOptions => ({
    runId: "run-1", role: "executor", roleCard: "card", prompt: "p", model: "sonnet", workdir, capUsd: 0,
    networkPolicy: [{ host: "api.anthropic.com", purpose: "model" }], env: cleanEnv({ mode: "subscription" }), onEvent: () => undefined, ...more,
  });
  const create = (name = "rn-1") => host.createSandbox({ sandboxName: name, retention: { persistent: false }, timeoutMs: 1_000 });
  return { host, blocks, runIds, starts, stops, tempRoot, workdir, opts, create, release: () => release() };
}

afterEach(() => vi.useRealTimers());

describe("hostSandbox: the signed browser method reaches the runtime on a start and on a resume (D#749 V2c-2b)", () => {
  it("passes browserMethod to runtime.start both ways, and nothing when the options carry none", async () => {
    const t = setup();
    const handle = await t.create();
    await t.host.startDetached(handle, t.opts({ browserMethod: "playwright_runner" })).hookFired;
    await t.host.resume(handle, "sess-1", "next", t.opts({ browserMethod: "playwright_runner" })).hookFired;
    await t.host.startDetached(handle, t.opts()).hookFired;
    expect(t.starts.map((s) => (s as { browserMethod?: string }).browserMethod)).toEqual(["playwright_runner", "playwright_runner", undefined]);
  });
});

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

describe("hostSandbox: WSL2 (D#587 B-9b)", () => {
  const loopback = { entries: [{ kind: "loopback" as const, value: "127.0.0.1", access: "bind" as const, reason: "dev server" }], commandTimeoutS: 600, storeKey: "acme__widgets" };
  const WSL = { denyPaths: ["/mnt", "/mnt/c", "/run/WSL"], loopback: false };

  it("puts every Windows-side path in both deny lists of the job's block", async () => {
    const t = setup({ wsl: WSL });
    await t.host.startDetached(await t.create(), t.opts()).hookFired;
    const fs = t.blocks[0]!.filesystem as unknown as { denyRead: string[]; denyWrite: string[] };
    for (const entry of WSL.denyPaths) {
      expect(fs.denyRead).toContain(entry);
      expect(fs.denyWrite).toContain(entry);
    }
  });

  it("refuses a loopback allowance where the networking mode is mirrored or unknown, before any runtime is built", async () => {
    const t = setup({ wsl: WSL });
    const handle = await t.create();
    expect(() => t.host.startDetached(handle, t.opts({ allowances: loopback }))).toThrow("sandbox_allowance_forbidden");
    expect(t.blocks).toEqual([]);
  });

  it("grants it where the mode is NAT, and grants it anywhere that is not WSL2", async () => {
    for (const wsl of [{ ...WSL, loopback: true }, undefined]) {
      const t = setup({ wsl });
      await t.host.startDetached(await t.create(), t.opts({ allowances: loopback })).hookFired;
      expect((t.blocks[0]!.network as unknown as { allowLocalBinding: boolean }).allowLocalBinding).toBe(true);
    }
  });

  it("the machine handed to the host sandbox reaches the check launch: a WSL2 machine without a clearance cannot start one, a cleared one can (the wiring at hostSandbox's file-system host)", async () => {
    const launches = async (machine: WslMachine | undefined): Promise<boolean> => {
      const t = setup({ machine });
      const handle = await t.create();
      await t.host.startDetached(handle, t.opts()).hookFired;
      return t.host.checkLaunch?.(handle, ["true"], false) !== undefined;
    };
    // The control: where the check can start at all (bubblewrap, socat and the socket filter are here), an ordinary machine starts one. Without it the refusal below would prove nothing.
    if (!(await launches(undefined))) return;
    const uncleared: WslMachine = { interopEntry: () => true, mountinfo: () => ROOT_TABLE, clearance: undefined };
    expect(await launches(uncleared)).toBe(false);
    expect(await launches({ ...uncleared, interopEntry: () => false, clearance: { denyPaths: ["/mnt"], loopback: false } })).toBe(true);
  });

  it("re-reads the machine for every job: a drive mounted after start is denied, an interop entry that came back or an unreadable mount table refuses the job", async () => {
    let table: string | undefined = ROOT_TABLE;
    let interop = false;
    const machine: WslMachine = { interopEntry: () => interop, mountinfo: () => table, clearance: { denyPaths: ["/mnt", "/run/WSL"], loopback: false } };
    const t = setup({ machine });
    const deny = (): string[] => (t.blocks.at(-1)!.filesystem as unknown as { denyRead: string[] }).denyRead;
    await t.host.startDetached(await t.create("rn-a"), t.opts({ runId: "a" })).hookFired;
    expect(deny()).not.toContain("/srv/winshare");
    table = `${ROOT_TABLE}55 22 0:48 / /srv/winshare rw - 9p C:\\134 rw\n`;
    await t.host.startDetached(await t.create("rn-b"), t.opts({ runId: "b" })).hookFired;
    expect(deny()).toEqual(expect.arrayContaining(["/mnt", "/run/WSL", "/srv/winshare"]));
    const before = t.blocks.length;
    interop = true;
    interop = false;
    table = undefined;
    const handle = await t.create("rn-d");
    expect(() => t.host.startDetached(handle, t.opts({ runId: "d" }))).toThrow("wsl_machine_changed");
    table = "";
    expect(() => t.host.startDetached(handle, t.opts({ runId: "e" }))).toThrow("wsl_machine_changed");
    interop = true;
    table = ROOT_TABLE;
    expect(() => t.host.startDetached(handle, t.opts({ runId: "f" }))).toThrow("wsl_machine_changed");
    expect(t.blocks).toHaveLength(before);
  });

  it("leaves the lists alone without the WSL input", async () => {
    const t = setup();
    await t.host.startDetached(await t.create(), t.opts()).hookFired;
    expect(JSON.stringify(t.blocks[0]!.filesystem)).not.toContain("/run/WSL");
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

describe("hostSandbox: no publish sandbox on this machine (D#598 P1f-5a)", () => {
  it("writeFiles and runCommand each refuse fail-closed with a typed error, and start nothing", async () => {
    const t = setup();
    const handle = await t.create("pp-11111111-2222-4333-8444-555555555555");
    await expect(t.host.writeFiles(handle, [{ path: "/fx/plane-publish/fx-plane-publish.mjs", content: "x", mode: 0o555 }])).rejects.toMatchObject({ name: "HostSandboxRefused", code: "no_publish_sandbox" });
    await expect(t.host.runCommand(handle, { role: "plane_publish", cmd: "node", args: ["/fx/plane-publish/fx-plane-publish.mjs"], env: {}, networkPolicy: [], timeoutMs: 60_000 })).rejects.toMatchObject({ name: "HostSandboxRefused", code: "no_publish_sandbox" });
    expect(t.starts).toEqual([]);
    expect(t.blocks).toEqual([]);
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

describe("hostSandbox: stop", () => {
  it("tells the caller when the agent could not be stopped, while delete still removes the sandbox", async () => {
    const t = setup({ stopFails: true });
    const handle = await t.create();
    const { hookFired } = t.host.startDetached(handle, t.opts());
    await hookFired.catch(() => undefined);
    await expect(t.host.stop(handle)).rejects.toThrow("did not end");
    await expect(t.host.deleteSandbox(handle)).resolves.toBeUndefined();
    expect(await t.host.sandboxExists(handle)).toBe(false);
  });

  it("a stop that works resolves", async () => {
    const t = setup();
    const handle = await t.create();
    const { hookFired } = t.host.startDetached(handle, t.opts());
    await hookFired.catch(() => undefined);
    await expect(t.host.stop(handle)).resolves.toBeUndefined();
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

/**
 * D#845 ON-10c: the project survey on the OS-sandbox tier. Its working copy is read-only (denied for writes, not granted), the one place a command may write is the run's own temp directory (its TMPDIR, made 0700
 * and removed with the sandbox), and its network is the model host alone, whatever the machine is set up with and whatever the job's rules say.
 */
describe("hostSandbox: the project survey (D#845 ON-10c)", () => {
  const model: NetworkRule = { host: "api.anthropic.com", purpose: "model" };

  it("the workspace is read-only: not in allowWrite, in denyWrite, and the run's own temp directory is the one write grant", async () => {
    const t = setup();
    const handle = await t.create();
    await t.host.startDetached(handle, t.opts({ role: SURVEY_ROLE })).hookFired;
    const block = t.blocks[0]!;
    const own = path.join(t.tempRoot, "rn-1");
    expect(block.filesystem.allowWrite).toEqual([own]);
    expect(block.filesystem.denyWrite).toContain(t.workdir);
    expect(existsSync(own)).toBe(true);
    expect(statSync(own).mode & 0o777).toBe(0o700);
    // read access to the checkout is still there
    expect(block.filesystem.allowRead).toContain(t.workdir);
  });

  it("the executor's block is unchanged: its workspace is writable (the control)", async () => {
    const t = setup();
    const handle = await t.create();
    await t.host.startDetached(handle, t.opts()).hookFired;
    expect(t.blocks[0]!.filesystem.allowWrite).toContain(t.workdir);
    expect(t.blocks[0]!.filesystem.denyWrite).not.toContain(t.workdir);
  });

  it("the network is the model host and nothing else, even on a machine set up with a registry", async () => {
    const t = setup();
    const handle = await t.create();
    await t.host.startDetached(handle, t.opts({ role: SURVEY_ROLE, networkPolicy: [model] })).hookFired;
    expect(t.blocks[0]!.network).toEqual({ allowedDomains: ["api.anthropic.com"], strictAllowlist: true, allowLocalBinding: false });
    const other = setup();
    const again = await other.create();
    await other.host.startDetached(again, other.opts({ networkPolicy: [model] })).hookFired;
    expect(other.blocks[0]!.network.allowedDomains).toEqual(["api.anthropic.com", "registry.npmjs.org"]);
  });

  it.each([
    ["github.com", { host: "github.com", purpose: "github_direct" }],
    ["a registry", { host: "registry.npmjs.org", purpose: "other" }],
    ["an address", { host: "169.254.169.254", purpose: "other" }],
  ] as Array<[string, NetworkRule]>)("a survey job with a rule for %s is refused before a runtime is built", async (_name, rule) => {
    const t = setup();
    const handle = await t.create();
    expect(() => t.host.startDetached(handle, t.opts({ role: SURVEY_ROLE, networkPolicy: [model, rule] }))).toThrow(HostSandboxRefused);
    expect(t.blocks).toEqual([]);
    expect(t.starts).toEqual([]);
  });

  it("a survey job that carries sandbox allowances is refused too", async () => {
    const t = setup();
    const handle = await t.create();
    expect(() => t.host.startDetached(handle, t.opts({ role: SURVEY_ROLE, allowances: { entries: [{ kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "install" }], commandTimeoutS: 60, storeKey: "k" } as never }))).toThrow(HostSandboxRefused);
    expect(t.blocks).toEqual([]);
  });

  it("the run's temp directory goes with the sandbox", async () => {
    const t = setup();
    const handle = await t.create();
    await t.host.startDetached(handle, t.opts({ role: SURVEY_ROLE })).hookFired;
    const own = path.join(t.tempRoot, "rn-1");
    expect(existsSync(own)).toBe(true);
    await t.host.deleteSandbox(handle);
    expect(existsSync(own)).toBe(false);
  });
});
