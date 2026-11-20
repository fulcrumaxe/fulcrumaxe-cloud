import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@fulcrumaxe/runner-protocol";
import type { SandboxHandle, StartDetachedOptions } from "../../../src/sandbox/port.js";
import { createDaemonSdk, type LimitControl } from "../../../src/vm/sandboxd/sdkAdapter.js";
import { FIXED_ENV, SUBSCRIPTION_TOKEN_VAR } from "../../../src/job/cleanEnv.js";
import { MICROVM_ENV_NAMES, MICROVM_GUEST_ENV, MICROVM_PINNED_ENV, REVERSE_HOSTS, guestEnvOf, microvmEnvAllowed } from "../../../src/vm/sandboxd/guestEnv.js";
import { MAX_TIMEOUT_MS, VM_BACKSTOP_MS, RUN_COMMAND_MAX_OUTPUT_CHARS, createMicrovmSandbox, policyOf } from "../../../src/vm/sandboxd/microvmSandbox.js";
import type { SdkSandbox, VercelSandboxSdk } from "../../../src/vm/sandboxd/sdkSlice.js";
import { scriptedRuntime } from "../../sandboxPortContract.js";
import { makeRig, runCleanups } from "./helpers.js";

afterEach(runCleanups);

const creds = { teamId: "t", projectId: "p", token: "tok" };

/** A policy port the test can hold: while `gate.on` is set, `apply` resolves (or rejects) only when the test says so. */
interface Gate { on: boolean; release(): void; fail(): void }

function setup(runtime: AgentRuntime = scriptedRuntime()) {
  const rig = makeRig();
  const log: string[] = [];
  const waiting: Array<{ ok: () => void; no: () => void }> = [];
  const gate: Gate = {
    on: false,
    release: () => void waiting.splice(0).forEach((w) => w.ok()),
    fail: () => void waiting.splice(0).forEach((w) => w.no()),
  };
  const sdk = createDaemonSdk({
    daemon: rig.daemon,
    policy: {
      apply: async (_id, policy) => {
        log.push(`policy ${JSON.stringify(policy)}`);
        if (gate.on) await new Promise<void>((ok, no) => void waiting.push({ ok, no: () => no(new Error("policy refused")) }));
      },
      release: async () => void log.push("release"),
    },
    template: "fx-agent",
    memMb: 256,
  });
  // the guest as the port sees it: a command's start and its kill are recorded in the same log as the policy
  const limitCalls: string[] = [];
  /** A hook the guest's `writeFiles` waits on first, so a test can hold a write in flight. */
  const hold: { write?: () => Promise<void> } = {};
  const commands: Array<{ env: Record<string, string> | undefined }> = [];
  const watched: Pick<VercelSandboxSdk, "create" | "get"> & LimitControl = {
    create: (params) => sdk.create(params),
    setTimeoutMs: (name, totalMs) => (limitCalls.push(`total ${totalMs}`), sdk.setTimeoutMs(name, totalMs)),
    armTimeoutAt: (name, remainingMs) => (limitCalls.push(`arm ${remainingMs}`), sdk.armTimeoutAt(name, remainingMs)),
    get: async (params) => {
      const guest = await sdk.get(params);
      return new Proxy(guest, {
        get: (target, key) => {
          if (key === "writeFiles") return async (...args: Parameters<SdkSandbox["writeFiles"]>) => (await hold.write?.(), target.writeFiles(...args));
          if (key !== "runCommand") return Reflect.get(target, key) as unknown;
          return async (cmd: Parameters<SdkSandbox["runCommand"]>[0]) => {
            log.push("command");
            commands.push({ env: cmd.env });
            const command = await target.runCommand(cmd);
            return new Proxy(command, { get: (c, k) => (k === "kill" ? (signal?: string) => (log.push(`kill ${String(signal)}`), c.kill(signal as never)) : (Reflect.get(c, k) as unknown)) });
          };
        },
      });
    },
  };
  const built: SdkSandbox[] = [];
  const envs: Array<Record<string, string>> = [];
  const port = createMicrovmSandbox({
    sdk: watched,
    makeRuntime: (guest, job) => {
      log.push("runtime built");
      built.push(guest);
      envs.push(job.env);
      return { ...runtime, start: async (o) => (log.push("agent start"), runtime.start(o)) };
    },
  });
  return { rig, log, sdk, port, built, gate, envs, commands, limitCalls, hold };
}
const opts = (over: Partial<StartDetachedOptions> = {}): StartDetachedOptions => ({ runId: "r1", role: "executor", roleCard: "c", prompt: "p", model: "sonnet", workdir: "/work/job", capUsd: 1, networkPolicy: [], env: {}, onEvent: () => undefined, ...over });
const create = (port: ReturnType<typeof setup>["port"], name: string, timeoutMs = 60_000): Promise<SandboxHandle> => port.createSandbox({ sandboxName: name, retention: { persistent: false }, timeoutMs });

describe("the microVM engine's own promises", () => {
  it("a sandbox is created closed, and a job's hosts are in force before its agent exists", async () => {
    const { port, log } = setup();
    const handle = await create(port, "m-order");
    expect(log).toEqual(['policy "deny-all"']);
    await port.startDetached(handle, opts({ networkPolicy: [{ host: "registry.npmjs.org", purpose: "deps" }, { host: "registry.npmjs.org", purpose: "deps" }] })).hookFired;
    expect(log.slice(1)).toEqual(['policy {"allow":["registry.npmjs.org"]}', "runtime built", "agent start"]);
  });

  it("a rule that carries a header to inject, or the GitHub forwarder, and a relative workdir, are refused before any VM or runtime is touched", async () => {
    const { port, log, rig } = setup();
    const handle = await create(port, "m-refuse");
    const before = [...log];
    const frames = rig.helper.frames.length;
    for (const rule of [{ host: "a.example", purpose: "x", authHeader: "authorization" }, { host: "a.example", purpose: "x", authValue: "v" }, { host: "a.example", purpose: "github_proxy" }]) {
      expect(() => port.startDetached(handle, opts({ networkPolicy: [rule] }))).toThrowError(expect.objectContaining({ code: "network_rule_forbidden" }) as Error);
    }
    expect(() => port.startDetached(handle, opts({ workdir: "work" }))).toThrowError(expect.objectContaining({ code: "bad_workdir" }) as Error);
    expect(() => port.startDetached(handle, opts({ workdir: undefined as never }))).toThrowError(expect.objectContaining({ code: "bad_workdir" }) as Error);
    await expect(port.runCommand(handle, { role: "r", cmd: "true", args: [], env: {}, networkPolicy: [{ host: "a.example", purpose: "github_proxy" }], timeoutMs: 1000 })).rejects.toMatchObject({ code: "network_rule_forbidden" });
    expect(log).toEqual(before);
    expect(rig.helper.frames.length).toBe(frames);
  });

  it("a run that outlives the port's timeout ends as `sandbox_timeout`, and the VM's own timer is set past it", async () => {
    const runtime = scriptedRuntime({ hold: true });
    const { port, sdk } = setup(runtime);
    const handle = await create(port, "m-timeout", 150);
    expect((await sdk.get({ name: "m-timeout", resume: false, ...creds })).timeout).toBe(150 + VM_BACKSTOP_MS);
    const { hookFired } = port.startDetached(handle, opts());
    await expect(hookFired).rejects.toMatchObject({ code: "sandbox_timeout" });
    expect(runtime.stopped()).toBeGreaterThan(0);
  });

  it("extendTimeout moves the port's limit and the VM's timer together, and leaves a stopped VM's alone", async () => {
    const { port, sdk } = setup();
    const handle = await create(port, "m-extend", 1000);
    await port.extendTimeout(handle, 400);
    expect(port.timeoutMsOf(handle)).toBe(1400);
    expect((await sdk.get({ name: "m-extend", resume: false, ...creds })).timeout).toBe(1400 + VM_BACKSTOP_MS);
    await port.stop(handle);
    await port.extendTimeout(handle, 100);
    expect(port.timeoutMsOf(handle)).toBe(1500);
    await expect(port.extendTimeout(handle, 0)).rejects.toMatchObject({ code: "bad_request" });
    await expect(port.extendTimeout(handle, 1.5)).rejects.toMatchObject({ code: "bad_request" });
  });

  it("a failed outcome from the agent rejects hookFired with the engine's reason, and a clean one resolves", async () => {
    const failed = setup(scriptedRuntime({ events: [], done: Promise.resolve({ status: "failed", failureReason: "credential_mismatch" }) }));
    const handle = await create(failed.port, "m-failed");
    await expect(failed.port.startDetached(handle, opts()).hookFired).rejects.toMatchObject({ code: "credential_mismatch", name: "AgentRunFailed" });
    const clean = setup(scriptedRuntime({ events: [], done: Promise.resolve({ status: "ok" }) }));
    await expect(clean.port.startDetached(await create(clean.port, "m-ok"), opts()).hookFired).resolves.toBeUndefined();
  });

  it("a name that is not a plain name is refused before any VM exists, and a name made at the same moment is taken", async () => {
    const { port, rig } = setup();
    await expect(create(port, "bad name")).rejects.toMatchObject({ code: "bad_sandbox_name" });
    expect(rig.helper.frames).toEqual([]);
    const [a, b] = await Promise.allSettled([create(port, "m-race"), create(port, "m-race")]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(rig.daemon.list()).toHaveLength(1);
  });

  it("delete removes a sandbox this port instance never made, and a name nobody has is done", async () => {
    const { port, sdk, rig } = setup();
    await sdk.create({ name: "m-foreign", image: "i", timeout: 60_000, persistent: false, resources: { vcpus: 1 }, tags: {}, networkPolicy: "deny-all", ...creds });
    const handle = { runId: "", sandboxName: "m-foreign" };
    expect(await port.sandboxExists(handle)).toBe(true);
    await port.deleteSandbox(handle);
    expect(rig.daemon.list()).toEqual([]);
    expect(await port.sandboxExists(handle)).toBe(false);
    await expect(port.deleteSandbox({ runId: "", sandboxName: "m-nobody" })).resolves.toBeUndefined();
  });

  it("runCommand: a command that overruns is killed and reported as timed out with no exit code; output past the cap is cut and flagged", async () => {
    const { port, rig } = setup();
    const handle = await create(port, "m-cmd");
    const slow = await port.runCommand(handle, { role: "r", cmd: "sleep", args: ["30"], env: {}, networkPolicy: [], timeoutMs: 300 });
    expect(slow).toMatchObject({ exitCode: null, timedOut: true });
    const big = await port.runCommand(handle, { role: "r", cmd: "sh", args: ["-c", `head -c ${RUN_COMMAND_MAX_OUTPUT_CHARS + 500} /dev/zero | tr '\\000' a`], env: {}, networkPolicy: [], timeoutMs: 20_000 });
    expect(big.truncated).toBe(true);
    expect(big.stdout).toHaveLength(RUN_COMMAND_MAX_OUTPUT_CHARS);
    expect(big.exitCode).toBe(0);
    for (const bad of [{ cmd: "" }, { timeoutMs: 0 }, { args: ["a\0b"] }]) {
      await expect(port.runCommand(handle, { role: "r", cmd: "true", args: [], env: {}, networkPolicy: [], timeoutMs: 1000, ...bad })).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(rig.agents.size).toBe(1);
  });

  it("files and commands are refused for a sandbox that is stopped, and nothing wakes it", async () => {
    const { port } = setup();
    const handle = await create(port, "m-down");
    await port.stop(handle);
    await expect(port.writeFiles(handle, [{ path: "/a", content: "a" }])).rejects.toMatchObject({ code: "not_running" });
    await expect(port.runCommand(handle, { role: "r", cmd: "true", args: [], env: {}, networkPolicy: [], timeoutMs: 1000 })).rejects.toMatchObject({ code: "not_running" });
    expect(await port.sandboxState?.(handle)).toBe("stopped");
  });

  it("sandboxState: a status the engine does not know is `unknown`, a read that fails is `unknown`, and only a definite not-found is `gone`", async () => {
    const stub = (status: string | Error): VercelSandboxSdk & LimitControl => ({
      setTimeoutMs: async () => undefined,
      armTimeoutAt: async () => undefined,
      create: async () => ({ currentSession: () => ({ sessionId: "s" }) }) as unknown as SdkSandbox,
      get: async () => {
        if (status instanceof Error) throw status;
        return { status } as unknown as SdkSandbox;
      },
    });
    const state = async (s: string | Error): Promise<string | undefined> => {
      const port = createMicrovmSandbox({ sdk: stub(s), makeRuntime: () => scriptedRuntime() });
      return port.sandboxState?.({ runId: "", sandboxName: "m-x" });
    };
    expect(await state("stopping")).toBe("unknown");
    expect(await state("snapshotting")).toBe("unknown");
    expect(await state("pending")).toBe("running");
    expect(await state("failed")).toBe("stopped");
    expect(await state(new Error("down"))).toBe("unknown");
    expect(await state(Object.assign(new Error("x"), { response: { status: 404 } }))).toBe("gone");
  });

  it("a stop that comes while the sandbox is still waking waits for the agent to exist, then ends it", async () => {
    const runtime = scriptedRuntime({ hold: true });
    const { port } = setup(runtime);
    const handle = await create(port, "m-wake");
    await port.stop(handle); // VM down
    const { hookFired } = port.startDetached(handle, opts()); // boots again
    await port.stop(handle);
    expect((await hookFired)?.seq).toBe(1);
    expect(runtime.stopped()).toBeGreaterThan(0);
    expect(await port.sandboxState?.(handle)).toBe("stopped");
  });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const command = (over: Record<string, unknown> = {}) => ({ role: "r", cmd: "true", args: [] as string[], env: {} as Record<string, string>, networkPolicy: [] as Array<{ host: string; purpose: string }>, timeoutMs: 5000, ...over });

describe("a running agent's network policy is never replaced", () => {
  it("runCommand and writeFiles are refused as `sandbox_busy` while a run goes, before any policy call, and work again once it ends", async () => {
    const runtime = scriptedRuntime({ hold: true });
    const { port, log, built } = setup(runtime);
    const handle = await create(port, "b-busy");
    const { hookFired, launched } = port.startDetached(handle, opts({ networkPolicy: [{ host: "a.example", purpose: "x" }] }));
    await launched;
    const before = [...log];
    expect(before).toContain('policy {"allow":["a.example"]}');
    await expect(port.runCommand(handle, command({ networkPolicy: [{ host: "b.example", purpose: "x" }] }))).rejects.toMatchObject({ code: "sandbox_busy" });
    await expect(port.writeFiles(handle, [{ path: "/a", content: "a" }])).rejects.toMatchObject({ code: "sandbox_busy" });
    expect(log).toEqual(before); // no policy line, and no command
    expect(built).toHaveLength(1);
    runtime.release();
    await hookFired;
    await expect(port.runCommand(handle, command())).resolves.toMatchObject({ exitCode: 0 });
    await expect(port.writeFiles(handle, [{ path: "/a", content: "a" }])).resolves.toBeUndefined();
  });
});

describe("a job's environment is checked against the microVM table", () => {
  const refused = (code: string) => expect.objectContaining({ code }) as Error;

  it("a token, a cloud key, a CA-file name or any other name outside the table is refused before a runtime exists, on start, resume and runCommand", async () => {
    const { port, log, rig } = setup();
    const handle = await create(port, "b-env");
    const before = [...log];
    const frames = rig.helper.frames.length;
    for (const name of [SUBSCRIPTION_TOKEN_VAR, "AWS_SECRET_ACCESS_KEY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "EXTRA_NOT_ALLOWED"]) {
      const env = { PATH: "/usr/bin", [name]: "x" };
      expect(() => port.startDetached(handle, opts({ env })), name).toThrowError(refused("env_not_clean"));
      expect(() => port.resume(handle, "s-1", "again", opts({ env })), name).toThrowError(refused("env_not_clean"));
      await expect(port.runCommand(handle, command({ env, networkPolicy: [{ host: "a.example", purpose: "x" }] })), name).rejects.toMatchObject({ code: "env_not_clean" });
    }
    expect(log).toEqual(before); // no policy line, no runtime, no command
    expect(rig.helper.frames.length).toBe(frames);
  });

  it("the table has no CA variable, a pinned network name carries only its pinned value, and a clean job's own names pass", () => {
    for (const name of ["CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", SUBSCRIPTION_TOKEN_VAR]) expect(MICROVM_ENV_NAMES.has(name), name).toBe(false);
    expect([...MICROVM_ENV_NAMES].filter((n) => /CA_|_CA|CERT|SSL|TOKEN|KEY|SECRET/i.test(n))).toEqual([]);
    expect(microvmEnvAllowed({})).toBe(true);
    expect(microvmEnvAllowed({ PATH: "/usr/bin", HOME: "/home/u", ...FIXED_ENV, HTTPS_PROXY: MICROVM_PINNED_ENV["HTTPS_PROXY"], ANTHROPIC_BASE_URL: "http://api.anthropic.com" })).toBe(true);
    expect(microvmEnvAllowed({ HTTPS_PROXY: "http://evil.example:3128" })).toBe(false);
    expect(microvmEnvAllowed({ ANTHROPIC_BASE_URL: "https://evil.example" })).toBe(false);
    expect(microvmEnvAllowed({ PATH: "a\0b" })).toBe(false);
    expect(microvmEnvAllowed(null)).toBe(false);
    expect(microvmEnvAllowed(["PATH"])).toBe(false);
  });

  it("allowances, extra read paths and a spill directory are refused until B-5b defines them, before any runtime", async () => {
    const { port, log } = setup();
    const handle = await create(port, "b-grants");
    const before = [...log];
    for (const over of [{ allowances: { entries: [], commandTimeoutS: 1 } as never }, { extraReadPaths: ["/fictional/read"] }, { spillDir: "/fictional/spill" }]) {
      expect(() => port.startDetached(handle, opts(over))).toThrowError(refused("sandbox_allowance_forbidden"));
      expect(() => port.resume(handle, "s-1", "again", opts(over))).toThrowError(refused("sandbox_allowance_forbidden"));
    }
    expect(log).toEqual(before);
    await expect(port.startDetached(handle, opts({ extraReadPaths: [] })).hookFired).resolves.toBeDefined();
  });
});

describe("the timers", () => {
  it("repeated tiny extensions add exactly their length: the run still ends as `sandbox_timeout` near the original deadline", async () => {
    const { port } = setup(scriptedRuntime({ hold: true }));
    const handle = await create(port, "t-deadline", 300);
    const t0 = Date.now();
    const { hookFired } = port.startDetached(handle, opts());
    const outcome = hookFired.then(() => "ended", (e: unknown) => e);
    await sleep(200);
    await port.extendTimeout(handle, 1);
    await port.extendTimeout(handle, 1);
    expect(await outcome).toMatchObject({ code: "sandbox_timeout" });
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it("an extension made mid-run reaches the VM too, so the VM's timer stays a backstop past the port's", async () => {
    const { port, sdk } = setup(scriptedRuntime({ hold: true }));
    const handle = await create(port, "t-mid", 400);
    const { hookFired, launched } = port.startDetached(handle, opts());
    await launched;
    await port.extendTimeout(handle, 50);
    expect((await sdk.get({ name: "t-mid", resume: false, ...creds })).timeout).toBeGreaterThanOrEqual(450 + VM_BACKSTOP_MS);
    await expect(hookFired).rejects.toMatchObject({ code: "sandbox_timeout" });
  });

  it("a mid-run extension of real length moves the port's deadline by its length", async () => {
    const { port } = setup(scriptedRuntime({ hold: true }));
    const handle = await create(port, "t-long", 300);
    const t0 = Date.now();
    const { hookFired } = port.startDetached(handle, opts());
    const outcome = hookFired.then(() => "ended", (e: unknown) => e);
    await sleep(100);
    await port.extendTimeout(handle, 400);
    expect(await Promise.race([outcome, sleep(500 - (Date.now() - t0)).then(() => "going")])).toBe("going"); // the original 300 ms is long past
    expect(await outcome).toMatchObject({ code: "sandbox_timeout" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(690);
  });

  it("a restart after a stop gives the woken VM exactly the backstop past the port's limit: no idle time is added on top", async () => {
    const { port, sdk } = setup(scriptedRuntime({ hold: true }));
    const handle = await create(port, "t-wake", 5000);
    await port.stop(handle);
    await sleep(200);
    const { hookFired, launched } = port.startDetached(handle, opts());
    await launched;
    expect((await sdk.get({ name: "t-wake", resume: false, ...creds })).timeout).toBe(5000 + VM_BACKSTOP_MS);
    await port.stop(handle);
    await hookFired;
  });

  it("an extension made while the VM is stopped sets the total its next wake arms with: the port's limit plus the backstop, exactly", async () => {
    const { port, sdk, limitCalls } = setup(scriptedRuntime({ hold: true }));
    const handle = await create(port, "t-stopped", 1000);
    await port.stop(handle);
    await port.extendTimeout(handle, 60_000);
    expect(port.timeoutMsOf(handle)).toBe(61_000);
    expect(limitCalls).toEqual([`total ${61_000 + VM_BACKSTOP_MS}`]);
    const { hookFired, launched } = port.startDetached(handle, opts());
    await launched;
    expect((await sdk.get({ name: "t-stopped", resume: false, ...creds })).timeout).toBe(61_000 + VM_BACKSTOP_MS);
    await port.stop(handle);
    await hookFired;
  });

  it("time spent idle before a start tops the VM's live timer up to the port's deadline plus the backstop, and does not touch the total", async () => {
    const { port, sdk, limitCalls } = setup(scriptedRuntime({ hold: true }));
    const handle = await create(port, "t-idle", 5000);
    await sleep(250);
    const { hookFired, launched } = port.startDetached(handle, opts());
    await launched;
    expect((await sdk.get({ name: "t-idle", resume: false, ...creds })).timeout).toBe(5000 + VM_BACKSTOP_MS); // the total is not grown
    const armed = limitCalls.filter((c) => c.startsWith("arm ")).map((c) => Number(c.slice(4)));
    expect(armed).toHaveLength(1);
    expect(armed[0]).toBeGreaterThanOrEqual(5000 + VM_BACKSTOP_MS - 60); // the live timer is full again: the 250 idle ms are not taken from it
    expect(armed[0]).toBeLessThanOrEqual(5000 + VM_BACKSTOP_MS);
    await port.stop(handle);
    await hookFired;
  });

  it("the backstop does not grow over the sandbox's life: runs on a live VM with idle time between them, then stop and start, leave the VM's timeout at the limit plus the backstop", async () => {
    const { port, sdk } = setup(scriptedRuntime());
    const handle = await create(port, "t-life", 1000);
    const total = async (): Promise<number | undefined> => (await sdk.get({ name: "t-life", resume: false, ...creds })).timeout;
    await sleep(400);
    await port.startDetached(handle, opts()).hookFired;
    await sleep(400);
    await port.startDetached(handle, opts()).hookFired;
    expect(await total()).toBe(1000 + VM_BACKSTOP_MS);
    for (let cycle = 0; cycle < 3; cycle++) {
      await port.stop(handle);
      await port.startDetached(handle, opts()).hookFired;
      expect(await total()).toBe(1000 + VM_BACKSTOP_MS);
      await sleep(120);
      await port.startDetached(handle, opts()).hookFired;
      expect(await total()).toBe(1000 + VM_BACKSTOP_MS);
    }
    // an extension is added once, and is still exact after a wake
    await port.extendTimeout(handle, 500);
    await port.stop(handle);
    await port.startDetached(handle, opts()).hookFired;
    expect(await total()).toBe(1500 + VM_BACKSTOP_MS);
  });


  it("a limit or an extension that no timer can hold is refused as `bad_request`, and a run that goes keeps going", async () => {
    const runtime = scriptedRuntime({ hold: true });
    const { port } = setup(runtime);
    await expect(create(port, "t-big", 2 ** 31)).rejects.toMatchObject({ code: "bad_request" });
    await expect(create(port, "t-big2", MAX_TIMEOUT_MS + 1)).rejects.toMatchObject({ code: "bad_request" });
    const handle = await create(port, "t-cap", 60_000);
    const { hookFired } = port.startDetached(handle, opts());
    const settled = hookFired.then(() => "ended", () => "failed");
    await expect(port.extendTimeout(handle, 2 ** 31)).rejects.toMatchObject({ code: "bad_request" });
    await expect(port.extendTimeout(handle, MAX_TIMEOUT_MS)).rejects.toMatchObject({ code: "bad_request" }); // the total would pass the cap
    expect(port.timeoutMsOf(handle)).toBe(60_000);
    expect(await Promise.race([settled, sleep(150).then(() => "going")])).toBe("going");
    runtime.release();
    expect(await settled).toBe("ended");
    // the total, not only each step, is capped, and the cap itself is accepted
    await port.stop(handle);
    await port.extendTimeout(handle, MAX_TIMEOUT_MS - 60_000);
    expect(port.timeoutMsOf(handle)).toBe(MAX_TIMEOUT_MS);
    await expect(port.extendTimeout(handle, 1)).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("the policy is in force, in order, before anything runs", () => {
  it("no hosts is `deny-all`, logged before the runtime is built", async () => {
    expect(policyOf([])).toBe("deny-all");
    const { port, log } = setup();
    const handle = await create(port, "p-empty");
    await port.startDetached(handle, opts({ networkPolicy: [] })).hookFired;
    expect(log.slice(1, 4)).toEqual(['policy "deny-all"', "runtime built", "agent start"]);
  });

  it("a start waits for the policy to be in force: no runtime and no agent until `apply` resolves", async () => {
    const { port, log, gate } = setup();
    const handle = await create(port, "p-wait");
    gate.on = true;
    const { hookFired } = port.startDetached(handle, opts({ networkPolicy: [{ host: "a.example", purpose: "x" }] }));
    await sleep(150);
    expect(log.slice(1)).toEqual(['policy {"allow":["a.example"]}']);
    gate.release();
    await hookFired;
    expect(log.slice(1)).toEqual(['policy {"allow":["a.example"]}', "runtime built", "agent start"]);
  });

  it("a policy that cannot be put in force builds no runtime, and hookFired rejects", async () => {
    const { port, log, gate } = setup();
    const handle = await create(port, "p-fail");
    gate.on = true;
    const { hookFired } = port.startDetached(handle, opts({ networkPolicy: [{ host: "a.example", purpose: "x" }] }));
    const outcome = hookFired.then(() => "ended", (e: unknown) => e);
    await sleep(50);
    gate.fail();
    expect(await outcome).toBeInstanceOf(Error);
    expect(log).not.toContain("runtime built");
    expect(log).not.toContain("agent start");
  });

  it("runCommand puts its policy in force before the command exists, and waits for it", async () => {
    const { port, log, gate } = setup();
    const handle = await create(port, "p-cmd");
    gate.on = true;
    const ran = port.runCommand(handle, command({ networkPolicy: [{ host: "b.example", purpose: "x" }] }));
    await sleep(150);
    expect(log.slice(1)).toEqual(['policy {"allow":["b.example"]}']); // no "command" yet
    gate.release();
    await expect(ran).resolves.toMatchObject({ exitCode: 0 });
    expect(log.slice(1)).toEqual(['policy {"allow":["b.example"]}', "command"]);
  });

  it("a command with no hosts runs closed", async () => {
    const { port, log } = setup();
    const handle = await create(port, "p-cmd-closed");
    await port.runCommand(handle, command());
    expect(log.slice(1)).toEqual(['policy "deny-all"', "command"]);
  });
});

describe("a command that overruns", () => {
  it("is killed with SIGKILL", async () => {
    const { port, log } = setup();
    const handle = await create(port, "k-kill");
    const result = await port.runCommand(handle, command({ cmd: "sleep", args: ["30"], timeoutMs: 300 }));
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(log).toContain("kill SIGKILL");
  });
});

describe("a sandbox is created only with limits the engine can hold", () => {
  it("a bad `vcpus` is refused by the port, before the daemon", async () => {
    const { port, rig } = setup();
    for (const vcpus of [0, -1, 1.5, Number.NaN]) await expect(port.createSandbox({ sandboxName: `v-${String(vcpus)}`, retention: { persistent: false }, timeoutMs: 60_000, vcpus })).rejects.toMatchObject({ code: "bad_request" });
    expect(rig.helper.frames).toEqual([]);
  });

  it("an adapter 400 is `sandbox_exists` only when the name is there, and `bad_request` otherwise", async () => {
    const stub = (exists: boolean): VercelSandboxSdk & LimitControl => ({
      setTimeoutMs: async () => undefined,
      armTimeoutAt: async () => undefined,
      create: async () => Promise.reject(Object.assign(new Error("x"), { response: { status: 400 } })),
      get: async () => (exists ? ({ status: "running" } as unknown as SdkSandbox) : Promise.reject(Object.assign(new Error("x"), { response: { status: 404 } }))),
    });
    const make = (exists: boolean) => createMicrovmSandbox({ sdk: stub(exists), makeRuntime: () => scriptedRuntime() });
    await expect(make(true).createSandbox({ sandboxName: "x-1", retention: { persistent: false }, timeoutMs: 1000 })).rejects.toMatchObject({ code: "sandbox_exists" });
    await expect(make(false).createSandbox({ sandboxName: "x-2", retention: { persistent: false }, timeoutMs: 1000 })).rejects.toMatchObject({ code: "bad_request" });
  });
});

/** A promise the test settles by hand: the gate a call is held at, in place of a sleep. */
function gated(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => void (open = resolve));
  return { wait, open };
}
const policyLines = (log: string[]): string[] => log.filter((l) => l.startsWith("policy"));

describe("a sandbox does one thing at a time: the in-flight marker is set before the first await", () => {
  const busy = expect.objectContaining({ code: "sandbox_busy" }) as Error;

  it("a runCommand in flight when a start comes: the start is refused, the command keeps its policy, and no agent runs beside it", async () => {
    const runtime = scriptedRuntime({ hold: true });
    const { port, log, built } = setup(runtime);
    const handle = await create(port, "i-cmd-first");
    const held = gated();
    const reached = gated();
    const cmd = port.runCommand(handle, command({ networkPolicy: [{ host: "b.example", purpose: "x" }], onSession: async () => (reached.open(), held.wait) }));
    await reached.wait; // the command is past its checks and parked between them and its policy call
    expect(() => port.startDetached(handle, opts({ networkPolicy: [{ host: "a.example", purpose: "x" }] }))).toThrowError(busy);
    expect(() => port.resume(handle, "s-1", "again", opts())).toThrowError(busy);
    await expect(port.runCommand(handle, command({ networkPolicy: [{ host: "c.example", purpose: "x" }] }))).rejects.toMatchObject({ code: "sandbox_busy" }); // a second command
    await expect(port.writeFiles(handle, [{ path: "/a", content: "a" }])).rejects.toMatchObject({ code: "sandbox_busy" });
    held.open();
    await expect(cmd).resolves.toMatchObject({ exitCode: 0 });
    expect(policyLines(log)).toEqual(['policy "deny-all"', 'policy {"allow":["b.example"]}']); // only the command's own policy followed the create
    expect(log).not.toContain("runtime built");
    expect(log).not.toContain("agent start");
    expect(built).toHaveLength(0);
    // the marker is gone with the command: a start now goes ahead, and its policy is the last one
    const { hookFired } = port.startDetached(handle, opts({ networkPolicy: [{ host: "a.example", purpose: "x" }] }));
    runtime.release();
    await hookFired;
    expect(policyLines(log).at(-1)).toBe('policy {"allow":["a.example"]}');
  });

  it("a start in flight when a command or a file write comes: both are refused, and the agent's policy is the last one", async () => {
    const runtime = scriptedRuntime({ hold: true });
    const { port, log, gate } = setup(runtime);
    const handle = await create(port, "i-start-first");
    gate.on = true; // the start is parked at its policy call
    const { hookFired } = port.startDetached(handle, opts({ networkPolicy: [{ host: "a.example", purpose: "x" }] }));
    await vi.waitFor(() => expect(policyLines(log)).toHaveLength(2));
    await expect(port.runCommand(handle, command({ networkPolicy: [{ host: "b.example", purpose: "x" }] }))).rejects.toMatchObject({ code: "sandbox_busy" });
    await expect(port.writeFiles(handle, [{ path: "/a", content: "a" }])).rejects.toMatchObject({ code: "sandbox_busy" });
    gate.release();
    runtime.release();
    await hookFired;
    expect(policyLines(log)).toEqual(['policy "deny-all"', 'policy {"allow":["a.example"]}']);
    expect(log).not.toContain("command");
  });

  it("a writeFiles in flight when a start or a command comes: both are refused, and the marker clears when the write fails", async () => {
    const { port, log, hold } = setup();
    const handle = await create(port, "i-write");
    const held = gated();
    const reached = gated();
    hold.write = async () => (reached.open(), held.wait);
    const writing = port.writeFiles(handle, [{ path: "/a", content: "a" }]);
    await reached.wait;
    expect(() => port.startDetached(handle, opts())).toThrowError(busy);
    await expect(port.runCommand(handle, command({ networkPolicy: [{ host: "b.example", purpose: "x" }] }))).rejects.toMatchObject({ code: "sandbox_busy" });
    await expect(port.writeFiles(handle, [{ path: "/b", content: "b" }])).rejects.toMatchObject({ code: "sandbox_busy" });
    expect(policyLines(log)).toEqual(['policy "deny-all"']);
    held.open();
    await expect(writing).resolves.toBeUndefined();
    hold.write = undefined;
    await expect(port.runCommand(handle, command())).resolves.toMatchObject({ exitCode: 0 });
    // a command that fails (its session callback throws) does not leave the marker set
    await expect(port.runCommand(handle, command({ onSession: () => Promise.reject(new Error("callback failed")) }))).rejects.toThrow("callback failed");
    await expect(port.startDetached(handle, opts()).hookFired).resolves.toBeDefined();
    // a write that fails clears it too
    await port.stop(handle);
    await expect(port.writeFiles(handle, [{ path: "/a", content: "a" }])).rejects.toMatchObject({ code: "not_running" });
    await expect(port.startDetached(handle, opts()).hookFired).resolves.toBeDefined();
  });
});

describe("the fixed names are pinned to their exact values, and laid over every job's environment", () => {
  const refused = (code: string) => expect.objectContaining({ code }) as Error;

  it("a wrong value for any FIXED_ENV name (the scrub flag set to 0 or empty, an inflated output limit, a changed marker) is refused on start, resume and runCommand", async () => {
    const { port, log, built } = setup();
    const handle = await create(port, "e-pin");
    const before = [...log];
    const wrong: Array<[string, string]> = [["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "0"], ["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", ""], ["FX_RUNNER_JOB", "0"], ["BASH_MAX_OUTPUT_LENGTH", "999999999"], ["BASH_MAX_OUTPUT_LENGTH", "1"], ["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "100"]];
    for (const name of Object.keys(FIXED_ENV)) wrong.push([name, `${FIXED_ENV[name] as string}x`], [name, ""]);
    for (const [name, value] of wrong) {
      const env = { [name]: value };
      expect(microvmEnvAllowed(env), `${name}=${value}`).toBe(false);
      expect(() => port.startDetached(handle, opts({ env })), name).toThrowError(refused("env_not_clean"));
      expect(() => port.resume(handle, "s-1", "again", opts({ env })), name).toThrowError(refused("env_not_clean"));
      await expect(port.runCommand(handle, command({ env })), name).rejects.toMatchObject({ code: "env_not_clean" });
    }
    expect(log).toEqual(before);
    expect(built).toHaveLength(0);
    for (const [name, value] of Object.entries(FIXED_ENV)) expect(microvmEnvAllowed({ [name]: value }), name).toBe(true); // the exact value is accepted
  });

  it("a start with no environment hands the runtime, and a command the guest, every pinned pair: the fixed names and the network names", async () => {
    const { port, envs, commands } = setup();
    const handle = await create(port, "e-lay");
    await port.startDetached(handle, opts({ env: {} })).hookFired;
    await port.runCommand(handle, command({ env: {} }));
    expect(envs).toHaveLength(1);
    expect(commands).toHaveLength(1);
    for (const env of [envs[0], commands[0]?.env]) {
      expect(env).toMatchObject(FIXED_ENV);
      expect(env).toMatchObject(MICROVM_PINNED_ENV);
      expect(env?.["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"]).toBe("1");
    }
  });

  it("the guest's own PATH, HOME, USER, LOGNAME and TMPDIR replace the host's: no host value reaches the runtime or a command", async () => {
    const { port, envs, commands } = setup();
    const handle = await create(port, "e-guest");
    const host = { PATH: "/fictional/host/bin:/usr/bin", HOME: "/fictional/host/home", USER: "fictional-host-user", LOGNAME: "fictional-host-user", TMPDIR: "/fictional/host/tmp" };
    await port.startDetached(handle, opts({ env: { ...host, LANG: "C.UTF-8" } })).hookFired;
    await port.runCommand(handle, command({ env: { ...host } }));
    for (const env of [envs[0], commands[0]?.env]) {
      expect(env).toMatchObject(MICROVM_GUEST_ENV);
      expect(JSON.stringify(env)).not.toContain("fictional");
    }
    expect(envs[0]?.["LANG"]).toBe("C.UTF-8"); // a name outside the host-copied five is carried as given
    expect(MICROVM_GUEST_ENV).toEqual({ PATH: expect.stringContaining("/usr/bin") as string, HOME: "/vercel", USER: "ubuntu", LOGNAME: "ubuntu", TMPDIR: "/tmp" });
  });

  it("the guest values are the guest agent's own: they match the image's agent and its init", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const image = path.resolve(here, "../../../../../infra/microvm-image/guest");
    const agent = readFileSync(path.join(image, "agent.py"), "utf8");
    const baseEnv = /^BASE_ENV = (\{.*\})$/m.exec(agent)?.[1];
    expect(baseEnv).toBeDefined();
    const base = JSON.parse(baseEnv as string) as Record<string, string>;
    expect(MICROVM_GUEST_ENV["PATH"]).toBe(base["PATH"]);
    expect(MICROVM_GUEST_ENV["HOME"]).toBe(base["HOME"]);
    const user = /^USER = \("([a-z]+)", \d+, \d+\)$/m.exec(agent)?.[1];
    expect(MICROVM_GUEST_ENV["USER"]).toBe(user);
    expect(MICROVM_GUEST_ENV["LOGNAME"]).toBe(user);
    expect(readFileSync(path.join(image, "init"), "utf8")).toMatch(/for d in \/tmp \/var\/tmp; do mount -t tmpfs/); // TMPDIR is the guest's tmpfs
  });

  it("a value with a control character is refused, for the guest-valued names and every other", async () => {
    const { port, built } = setup();
    const handle = await create(port, "e-ctl");
    for (const name of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "TZ"]) {
      for (const value of ["a\nb", "a\rb", "a\u0000b", "a\u001bb", "a\u007fb", "\t"]) {
        expect(microvmEnvAllowed({ [name]: value }), `${name}`).toBe(false);
      }
      expect(() => port.startDetached(handle, opts({ env: { [name]: "x\nFOO=1" } })), name).toThrowError(refused("env_not_clean"));
      await expect(port.runCommand(handle, command({ env: { [name]: "x\nFOO=1" } })), name).rejects.toMatchObject({ code: "env_not_clean" });
    }
    expect(built).toHaveLength(0);
  });
});

describe("a client that follows the proxy variables sends the rewritten hosts to the reverse relay", () => {
  /** What a proxy-following client does with `NO_PROXY`: a host that matches an entry (exactly, or as a domain suffix) is not sent to the proxy. */
  const bypasses = (noProxy: string, host: string): boolean => noProxy.split(",").map((e) => e.trim().toLowerCase().replace(/^\./, "")).some((e) => e !== "" && (host === e || host.endsWith(`.${e}`)));
  /** Where the request goes: a bypassed host connects directly (the guest's loopback relay for it, 127.0.0.1:80), any other http(s) host goes to the proxy. */
  const routeOf = (env: Record<string, string>, url: string): "reverse relay" | "CONNECT relay" => {
    const host = new URL(url).hostname;
    const noProxy = env["NO_PROXY"] ?? "";
    return bypasses(noProxy, host) ? "reverse relay" : "CONNECT relay";
  };

  it("the model API base URL and GitHub are covered by both NO_PROXY spellings; any other host still goes to the CONNECT relay", () => {
    const env = guestEnvOf({});
    const base = env["ANTHROPIC_BASE_URL"] as string;
    expect(base).toBe("http://api.anthropic.com");
    for (const name of ["NO_PROXY", "no_proxy"]) {
      expect(bypasses(env[name] as string, new URL(base).hostname), name).toBe(true);
      expect(bypasses(env[name] as string, "github.com"), name).toBe(true);
      expect(bypasses(env[name] as string, "registry.npmjs.org"), name).toBe(false);
      expect(bypasses(env[name] as string, "notgithub.com"), name).toBe(false);
    }
    expect(routeOf(env, `${base}/v1/messages`)).toBe("reverse relay");
    expect(routeOf(env, "http://github.com/owner/repo.git")).toBe("reverse relay");
    expect(routeOf(env, "https://registry.npmjs.org/left-pad")).toBe("CONNECT relay");
  });

  it("every host the engine rewrites is on one list: the base URL and NO_PROXY are built from it, so they cannot drift", () => {
    expect(REVERSE_HOSTS.length).toBeGreaterThan(0);
    for (const host of REVERSE_HOSTS) for (const name of ["NO_PROXY", "no_proxy"]) expect((MICROVM_PINNED_ENV[name] as string).split(",")).toContain(host);
    expect(new URL(MICROVM_PINNED_ENV["ANTHROPIC_BASE_URL"] as string).hostname).toBe(REVERSE_HOSTS[0]);
    expect(MICROVM_PINNED_ENV["NO_PROXY"]).toBe(MICROVM_PINNED_ENV["no_proxy"]);
    expect((MICROVM_PINNED_ENV["NO_PROXY"] as string).split(",")).toEqual(expect.arrayContaining(["127.0.0.1", "localhost"]));
  });
});
