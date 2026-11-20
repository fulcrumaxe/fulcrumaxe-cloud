import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxNameConflictError, buildSandboxEnv, createVercelSandboxPort, type SdkCommand as RealCommand, type SdkCreateParams, type SdkListedSandbox as RealListed, type SdkSandbox, type SdkSandboxListPage as RealListPage, type SdkSession as RealSession, type SdkSessionPage as RealSessionPage, type VercelSandboxSdk } from "@fx/runner";
import type { SdkCommand as LocalCommand, SdkListedSandbox as LocalListed, SdkSandbox as LocalSandbox, SdkSandboxListPage as LocalListPage, SdkSession as LocalSession, SdkSessionPage as LocalSessionPage, VercelSandboxSdk as LocalSdk } from "../../../src/vm/sandboxd/sdkSlice.js";
import { createDaemonSdk, type PolicyPort } from "../../../src/vm/sandboxd/sdkAdapter.js";
import { makeRig, runCleanups, type Rig } from "./helpers.js";

/**
 * The local slice is held to the real one by exact type equality, member by member, in both directions: a field added to a real method's parameters (required or
 * optional), a changed type or a new member makes one of these fail `tsc`, where plain assignability would let it through (method parameters are compared loosely).
 * The one deliberate difference is a network policy, which the slice leaves opaque; every other part of those parameters is compared whole.
 */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const mustBeSame = <_T extends true>(): void => undefined;
type RealSb = SdkSandbox;
type SansPolicy<T> = Omit<T, "networkPolicy">;
mustBeSame<Same<keyof RealSb, keyof LocalSandbox>>();
mustBeSame<Same<keyof VercelSandboxSdk, keyof LocalSdk>>();
mustBeSame<Same<keyof RealCommand, keyof LocalCommand>>();
mustBeSame<Same<SansPolicy<Parameters<VercelSandboxSdk["create"]>[0]>, SansPolicy<Parameters<LocalSdk["create"]>[0]>>>();
mustBeSame<Same<Parameters<VercelSandboxSdk["get"]>[0], Parameters<LocalSdk["get"]>[0]>>();
mustBeSame<Same<Parameters<NonNullable<VercelSandboxSdk["list"]>>[0], Parameters<NonNullable<LocalSdk["list"]>>[0]>>();
mustBeSame<Same<Parameters<RealSb["runCommand"]>, Parameters<LocalSandbox["runCommand"]>>>();
mustBeSame<Same<Parameters<RealSb["writeFiles"]>, Parameters<LocalSandbox["writeFiles"]>>>();
mustBeSame<Same<Parameters<RealSb["updateNetworkPolicy"]>[1], Parameters<LocalSandbox["updateNetworkPolicy"]>[1]>>();
mustBeSame<Same<Parameters<RealSb["extendTimeout"]>, Parameters<LocalSandbox["extendTimeout"]>>>();
mustBeSame<Same<Parameters<RealSb["stop"]>, Parameters<LocalSandbox["stop"]>>>();
mustBeSame<Same<Parameters<RealSb["delete"]>, Parameters<LocalSandbox["delete"]>>>();
mustBeSame<Same<Parameters<RealSb["listSessions"]>, Parameters<LocalSandbox["listSessions"]>>>();
mustBeSame<Same<ReturnType<RealSb["currentSession"]>, ReturnType<LocalSandbox["currentSession"]>>>();
mustBeSame<Same<Awaited<ReturnType<RealSb["runCommand"]>>, Awaited<ReturnType<LocalSandbox["runCommand"]>>>>();
mustBeSame<Same<Parameters<RealCommand["logs"]>, Parameters<LocalCommand["logs"]>>>();
mustBeSame<Same<Parameters<RealCommand["wait"]>, Parameters<LocalCommand["wait"]>>>();
mustBeSame<Same<Parameters<RealCommand["kill"]>, Parameters<LocalCommand["kill"]>>>();
mustBeSame<Same<RealListed, LocalListed>>();
mustBeSame<Same<RealListPage, LocalListPage>>();
mustBeSame<Same<RealSession, LocalSession>>();
mustBeSame<Same<RealSessionPage, LocalSessionPage>>();
mustBeSame<Same<Pick<RealSb, "name" | "status" | "persistent" | "image" | "vcpus" | "keepLastSnapshots" | "timeout">, Pick<LocalSandbox, "name" | "status" | "persistent" | "image" | "vcpus" | "keepLastSnapshots" | "timeout">>>();

afterEach(runCleanups);

const IMAGE = `fx-agent@sha256:${"d".repeat(64)}`;
const NAME = "ex-1-executor-run-1";

interface PolicyLog { applied: Array<{ id: string; policy: unknown }>; released: string[]; failApply?: boolean }
function policyPort(log: PolicyLog): PolicyPort {
  return {
    apply: async (id, policy) => {
      if (log.failApply === true) throw new Error("proxy down");
      log.applied.push({ id, policy });
    },
    release: async (id) => void log.released.push(id),
  };
}

function setup(over: { now?: () => number } = {}): { rig: Rig; sdk: VercelSandboxSdk; log: PolicyLog } {
  const rig = makeRig();
  const log: PolicyLog = { applied: [], released: [] };
  const sdk: VercelSandboxSdk = createDaemonSdk({ daemon: rig.daemon, policy: policyPort(log), template: "fx-agent", memMb: 512, ...over }); // assignable to the real slice, or tsc fails
  return { rig, sdk, log };
}

const creds = { teamId: "t", projectId: "p", token: "tok" };
const params = (name = NAME, over: Partial<SdkCreateParams> = {}): SdkCreateParams => ({ name, image: IMAGE, timeout: 60_000, persistent: false, resources: { vcpus: 2 }, tags: {}, networkPolicy: "deny-all", ...creds, ...over });
const run = async (sandbox: SdkSandbox, script: string): Promise<{ exitCode: number; out: string }> => {
  const command = await sandbox.runCommand({ cmd: "sh", args: ["-c", script], detached: true });
  let out = "";
  for await (const chunk of command.logs()) if (chunk.stream === "stdout") out += String(chunk.data);
  return { exitCode: (await command.wait()).exitCode, out };
};

describe("the SdkSandbox slice on the daemon", () => {
  it("create returns what the port reads back: name, status, what it was created with, one session", async () => {
    const { sdk, log, rig } = setup();
    const sandbox = await sdk.create(params(NAME, { persistent: true, keepLastSnapshots: { count: 2 } }));
    expect(sandbox).toMatchObject({ name: NAME, status: "running", persistent: true, image: IMAGE, vcpus: 2, timeout: 60_000 });
    expect(sandbox.currentSession().sessionId).toMatch(/^sb-[0-9a-f]{32}-1$/);
    expect(rig.helper.frames.find((f) => f["verb"] === "prepare")).toMatchObject({ template: "fx-agent", vcpus: 2, mem_mb: 512 });
    expect(log.applied).toEqual([{ id: rig.daemon.list()[0]?.name, policy: "deny-all" }]);
    expect((await sdk.get({ name: NAME, resume: false, ...creds })).name).toBe(NAME);
  });

  it("a taken name answers 400 bad_request, the shape the port reads as a conflict", async () => {
    const { sdk } = setup();
    await sdk.create(params());
    await expect(sdk.create(params())).rejects.toMatchObject({ response: { status: 400 }, json: { error: { code: "bad_request" } } });
  });

  it("an unknown or malformed name is a 404 on get, and a bad name is refused on create before any VM", async () => {
    const { sdk, rig } = setup();
    await expect(sdk.get({ name: "ex-nope", resume: false, ...creds })).rejects.toMatchObject({ response: { status: 404 } });
    await expect(sdk.get({ name: "../x", resume: false, ...creds })).rejects.toMatchObject({ response: { status: 404 } });
    await expect(sdk.create(params("bad name"))).rejects.toMatchObject({ response: { status: 400 } });
    expect(rig.helper.frames).toEqual([]);
  });

  it("long port names map to distinct daemon ids, and list answers in port names", async () => {
    const { sdk, rig } = setup();
    const a = `ex-${"a".repeat(150)}1`;
    const b = `ex-${"a".repeat(150)}2`;
    await sdk.create(params(a));
    await sdk.create(params(b));
    const ids = rig.daemon.list().map((r) => r.name);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id))).toBe(true);
    const listed = await sdk.list!({ namePrefix: "ex-", ...creds });
    expect(listed.sandboxes.map((s) => s.name).sort()).toEqual([a, b]);
    expect((await sdk.list!({ namePrefix: "rn-", ...creds })).sandboxes).toEqual([]);
  });

  it("no sandbox without its policy: a create with none, a failed apply, and a policy port that is missing", async () => {
    const { sdk, rig, log } = setup();
    await expect(sdk.create({ ...params(), networkPolicy: undefined as never })).rejects.toMatchObject({ response: { status: 400 } });
    expect(rig.helper.frames).toEqual([]);
    log.failApply = true;
    await expect(sdk.create(params())).rejects.toMatchObject({ response: { status: 502 }, json: { error: { code: "policy_failed" } } });
    expect(rig.daemon.list()).toEqual([]);
    expect(rig.helper.entries.size).toBe(0);
    await expect(sdk.get({ name: NAME, resume: false, ...creds })).rejects.toMatchObject({ response: { status: 404 } });
    expect(() => createDaemonSdk({ daemon: rig.daemon, template: "t", memMb: 1 } as never)).toThrow(/policy port/);
  });

  it("two names that map to one id are refused, never merged", async () => {
    const rig = makeRig();
    const log: PolicyLog = { applied: [], released: [] };
    const sdk = createDaemonSdk({ daemon: rig.daemon, policy: policyPort(log), template: "fx-agent", memMb: 512, idOf: () => "sb-clash" });
    await sdk.create(params("ex-one"));
    await expect(sdk.create(params("ex-two"))).rejects.toMatchObject({ response: { status: 400 } });
    await expect(sdk.get({ name: "ex-two", resume: false, ...creds })).rejects.toMatchObject({ response: { status: 404 } });
    expect((await sdk.get({ name: "ex-one", resume: false, ...creds })).name).toBe("ex-one");
    expect(rig.daemon.list()).toHaveLength(1);
  });

  it("a sandbox still being created is listed as pending", async () => {
    const { sdk, rig } = setup();
    let release!: () => void;
    rig.helper.holdPrepare = new Promise<void>((r) => (release = r));
    const creating = sdk.create(params());
    await new Promise((r) => setTimeout(r, 60));
    expect((await sdk.list!({ namePrefix: "ex-", ...creds })).sandboxes).toMatchObject([{ name: NAME, status: "pending" }]);
    release();
    await creating;
  });

  it("nothing runs in a session before its policy is in force: pending, and commands and files are refused", async () => {
    const rig = makeRig();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sdk = createDaemonSdk({ daemon: rig.daemon, policy: { apply: () => gate, release: async () => undefined }, template: "fx-agent", memMb: 512 });
    const creating = sdk.create(params());
    await new Promise((r) => setTimeout(r, 150));
    const early = await sdk.get({ name: NAME, resume: false, ...creds });
    expect(early.status).toBe("pending");
    expect((await sdk.list!({ namePrefix: "ex-", ...creds })).sandboxes).toMatchObject([{ status: "pending" }]);
    await expect(early.runCommand({ cmd: "true", detached: true })).rejects.toMatchObject({ response: { status: 409 } });
    await expect(early.writeFiles([{ path: "/fx/a", content: "x" }])).rejects.toMatchObject({ response: { status: 409 } });
    release();
    const sandbox = await creating;
    expect(sandbox.status).toBe("running");
    await expect(run(sandbox, "true")).resolves.toMatchObject({ exitCode: 0 });
  });

  it("a create the helper refuses leaves no name taken, and a boot that fails on wake leaves the sandbox stopped", async () => {
    const { sdk, rig } = setup();
    rig.helper.refuse.set("prepare", "unavailable");
    await expect(sdk.create(params())).rejects.toMatchObject({ response: { status: 502 } });
    await expect(sdk.get({ name: NAME, resume: false, ...creds })).rejects.toMatchObject({ response: { status: 404 } });
    rig.helper.refuse.delete("prepare");
    const sandbox = await sdk.create(params());
    await sandbox.stop();
    rig.helper.refuse.set("prepare", "unavailable");
    await expect(sdk.get({ name: NAME, resume: true, ...creds })).rejects.toMatchObject({ response: { status: 502 } });
    expect(sandbox.status).toBe("stopped");
    rig.helper.refuse.delete("prepare");
    expect((await sdk.get({ name: NAME, resume: true, ...creds })).status).toBe("running");
  });

  it("a wake whose closing policy cannot be applied fails, and leaves no VM running", async () => {
    const { sdk, log, rig } = setup();
    const sandbox = await sdk.create(params());
    await sandbox.stop();
    log.failApply = true;
    await expect(sdk.get({ name: NAME, resume: true, ...creds })).rejects.toMatchObject({ response: { status: 502 } });
    expect(rig.helper.entries.size).toBe(0);
    expect(sandbox.status).toBe("stopped");
  });

  it("runs a command: output in order, exit code, the cwd it was given, and a kill", async () => {
    const { sdk } = setup();
    const sandbox = await sdk.create(params());
    expect(await run(sandbox, "echo one; echo two >&2; echo three")).toEqual({ exitCode: 0, out: "one\nthree\n" });
    const command = await sandbox.runCommand({ cmd: "sh", args: ["-c", 'echo "$PWD"'], env: { FX_X: "v" }, cwd: "/tmp", detached: true });
    let out = "";
    for await (const chunk of command.logs()) out += String(chunk.data);
    expect(out).toBe("/tmp\n");
    const long = await sandbox.runCommand({ cmd: "sleep", args: ["30"], detached: true });
    await long.kill("SIGKILL");
    expect((await long.wait()).exitCode).toBe(137);
    const fresh = await sandbox.currentSession().getCommand?.(long.cmdId as string);
    expect(fresh?.cmdId).toBe(long.cmdId);
    await expect(sandbox.currentSession().getCommand?.("nope")).rejects.toMatchObject({ response: { status: 404 } });
  });

  it("wait rejects with the signal's reason when it aborts first, as the real SDK's does", async () => {
    const { sdk } = setup();
    const sandbox = await sdk.create(params());
    const command = await sandbox.runCommand({ cmd: "sleep", args: ["30"], detached: true });
    const ac = new AbortController();
    const waiting = command.wait({ signal: ac.signal });
    ac.abort(new Error("late"));
    await expect(waiting).rejects.toThrow("late");
    await command.kill("SIGKILL");
  });

  it("writeFiles lands bytes and mode in the guest, and a bad path writes nothing", async () => {
    const { sdk, rig } = setup();
    const sandbox = await sdk.create(params());
    await sandbox.writeFiles([{ path: "/fx/a.txt", content: "héllo", mode: 0o444 }]);
    const stored = [...rig.agents.values()][0]?.files.get("/fx/a.txt");
    expect(stored?.data.toString("utf8")).toBe("héllo");
    expect(stored?.mode).toBe(0o444);
    await expect(sandbox.writeFiles([{ path: "/fx/ok", content: "x" }, { path: "relative", content: "y" }])).rejects.toMatchObject({ response: { status: 400 } });
    expect([...rig.agents.values()][0]?.files.has("/fx/ok")).toBe(false);
  });

  it("updateNetworkPolicy goes to the policy port, and stop releases it", async () => {
    const { sdk, log, rig } = setup();
    const sandbox = await sdk.create(params());
    const id = rig.daemon.list()[0]?.name;
    await sandbox.updateNetworkPolicy({ allow: { "registry.npmjs.org": [] } });
    expect(log.applied.at(-1)).toEqual({ id, policy: { allow: { "registry.npmjs.org": [] } } });
    await sandbox.stop();
    expect(sandbox.status).toBe("stopped");
    expect(log.released).toEqual([id]);
  });

  it("stop, then get with resume boots a fresh VM as a second session, closed until the port applies its policy", async () => {
    const { sdk, log, rig } = setup();
    const first = await sdk.create(params());
    await first.stop();
    expect((await sdk.get({ name: NAME, resume: false, ...creds })).status).toBe("stopped");
    await expect(first.runCommand({ cmd: "true", detached: true })).rejects.toMatchObject({ response: { status: 409 } });
    const woken = await sdk.get({ name: NAME, resume: true, ...creds });
    expect(woken.status).toBe("running");
    expect(woken.currentSession().sessionId).toMatch(/-2$/);
    expect(log.applied.at(-1)?.policy).toBe("deny-all");
    expect(rig.helper.frames.filter((f) => f["verb"] === "start")).toHaveLength(2);
    const sessions = (await woken.listSessions()).sessions;
    expect(sessions.map((s) => s.id.slice(-2))).toEqual(["-2", "-1"]);
    expect(sessions[0]).toMatchObject({ memory: 512, region: "microvm" });
    expect(sessions[0]).not.toHaveProperty("activeCpuDurationMs");
    expect(sessions[0]).not.toHaveProperty("networkTransfer");
  });

  it("delete is idempotent, ends the VM, and the name is then unknown", async () => {
    const { sdk, rig, log } = setup();
    const sandbox = await sdk.create(params());
    await sandbox.delete();
    await sandbox.delete().catch((e: unknown) => expect(e).toMatchObject({ response: { status: 404 } }));
    expect(rig.helper.entries.size).toBe(0);
    expect(log.released).toHaveLength(1);
    await expect(sdk.get({ name: NAME, resume: false, ...creds })).rejects.toMatchObject({ response: { status: 404 } });
  });

  it("the sandbox is stopped when its timeout runs out, and extendTimeout moves that", async () => {
    const { sdk } = setup();
    const short = await sdk.create(params("ex-short", { timeout: 150 }));
    const extended = await sdk.create(params("ex-extended", { timeout: 150 }));
    await extended.extendTimeout(1_000);
    expect(extended.timeout).toBe(1_150);
    await new Promise((r) => setTimeout(r, 450));
    expect(short.status).toBe("stopped");
    expect(extended.status).toBe("running");
    await expect(extended.extendTimeout(0)).rejects.toMatchObject({ response: { status: 400 } });
    await extended.delete();
  });

  it("an aborted create hands nothing back and leaves no VM", async () => {
    const { sdk, rig } = setup();
    const ac = new AbortController();
    ac.abort(new Error("gave up"));
    await expect(sdk.create(params(NAME, { signal: ac.signal }))).rejects.toThrow("gave up");
    await new Promise((r) => setTimeout(r, 300));
    expect(rig.helper.entries.size).toBe(0);
  });
});

describe("vercelSandboxPort runs on it unchanged", () => {
  const NAME_PP = "pp-attempt-1";
  const portOn = (sdk: VercelSandboxSdk) => createVercelSandboxPort({ teamId: "t", projectId: "p", getToken: async () => "tok", sdk, image: IMAGE, measureRetryDelayMs: 5 });
  const create = (port: ReturnType<typeof portOn>, name = NAME_PP) => port.createSandbox({ sandboxName: name, retention: { persistent: false }, timeoutMs: 7_200_000, vcpus: 1, networkPolicy: [{ host: "gh-proxy.example", purpose: "github_proxy" }] });

  it("create, conflict, exists, list, write, run, extend, stop, resume, delete and not-found, through the port's own code", async () => {
    const { sdk, rig, log } = setup();
    const port = portOn(sdk);
    const handle = await create(port);
    expect(handle.sandboxName).toBe(NAME_PP);
    expect(handle.sessionId).toBeDefined();
    expect(log.applied).toHaveLength(1);
    await expect(create(port)).rejects.toBeInstanceOf(SandboxNameConflictError);
    expect(await port.sandboxExists(handle)).toBe(true);
    expect((await port.listSandboxes?.({ prefix: "pp-" }))?.sandboxes).toMatchObject([{ name: NAME_PP, persistent: false, status: "running" }]);
    await port.writeFiles(handle, [{ path: "/fx/plane-publish/in.json", content: "{}" }]);
    expect([...rig.agents.values()][0]?.files.get("/fx/plane-publish/in.json")?.data.toString()).toBe("{}");
    const result = await port.runCommand(handle, { role: "plane_publish" as never, cmd: "node", args: ["-e", "process.stdout.write('hi'); process.exit(3)"], env: buildSandboxEnv("plane_publish" as never), networkPolicy: [{ host: "gh-proxy.example", purpose: "github_proxy" }], timeoutMs: 30_000 });
    expect(result).toMatchObject({ exitCode: 3, stdout: "hi", timedOut: false });
    await expect(port.extendTimeout(handle, 5_000)).resolves.toBeUndefined();
    const usage = await port.measure(handle, [handle.sessionId as string]);
    expect(usage).toMatchObject([{ sessionId: handle.sessionId, memoryMb: 512, region: "microvm" }]);
    await port.stop(handle);
    expect(await port.sandboxExists(handle)).toBe(true);
    await port.deleteSandbox(handle);
    await port.deleteSandbox(handle);
    expect(await port.sandboxExists(handle)).toBe(false);
    expect(rig.helper.entries.size).toBe(0);
    await expect(port.measure(handle, ["x"])).rejects.toMatchObject({ status: 404 });
  });
});

describe("a session is never half in force (review of the first version)", () => {
  /** A policy port that logs, and whose `apply` can be held or made to fail. */
  function gated(over: { failApply?: boolean } = {}): { port: PolicyPort; log: string[]; hold(): void; open(): void; failApply: boolean } {
    const log: string[] = [];
    let gate: Promise<void> = Promise.resolve();
    let release: () => void = () => undefined;
    const state = {
      log,
      failApply: over.failApply === true,
      hold: () => void (gate = new Promise<void>((r) => (release = r))),
      open: () => release(),
      port: {
        apply: async (_id: string, policy: unknown) => {
          log.push(`apply-start ${typeof policy === "string" ? policy : "rules"}`);
          await gate;
          if (state.failApply) {
            log.push("apply-partial");
            throw new Error("second listener refused");
          }
          log.push("apply-done");
        },
        release: async () => void log.push("release"),
      } as PolicyPort,
    };
    return state;
  }
  const build = (g: ReturnType<typeof gated>, now?: () => number) => {
    const rig = makeRig();
    const sdk: VercelSandboxSdk = createDaemonSdk({ daemon: rig.daemon, policy: g.port, template: "fx-agent", memMb: 512, ...(now === undefined ? {} : { now }) });
    return { rig, sdk };
  };

  it("R1: a resume whose signal aborts mid-boot ends as a stopped sandbox, not a running one with no policy", async () => {
    const g = gated();
    const { sdk, rig } = build(g);
    const first = await sdk.create(params());
    await first.stop();
    g.log.length = 0;
    let open!: () => void;
    rig.helper.holdPrepare = new Promise<void>((r) => (open = r));
    const ac = new AbortController();
    const waking = sdk.get({ name: NAME, resume: true, signal: ac.signal, ...creds });
    await new Promise((r) => setTimeout(r, 60));
    ac.abort(new Error("gave up"));
    await expect(waking).rejects.toThrow("gave up");
    expect(first.status).toBe("pending"); // still waking: never reported as ready
    await expect(first.runCommand({ cmd: "true", detached: true })).rejects.toMatchObject({ response: { status: 409 } });
    open();
    await vi.waitFor(() => expect(first.status).toBe("stopped"), { timeout: 3000 });
    expect(rig.helper.entries.size).toBe(0);
    expect(g.log).toEqual(["apply-start deny-all", "apply-done", "release"]);
    await expect(first.runCommand({ cmd: "true", detached: true })).rejects.toMatchObject({ response: { status: 409 } });
    const again = await sdk.get({ name: NAME, resume: true, ...creds });
    expect(again.status).toBe("running");
    expect(again.currentSession().sessionId).toMatch(/-3$/);
  });

  it("R2: a timer, stop or delete that comes while the policy is being applied waits for it, and create returns a running sandbox", async () => {
    const g = gated();
    const { sdk } = build(g);
    g.hold();
    const creating = sdk.create(params(NAME, { timeout: 100 }));
    await new Promise((r) => setTimeout(r, 250)); // longer than the timeout: the timer must not exist yet
    const early = await sdk.get({ name: NAME, resume: false, ...creds });
    const stopping = early.stop();
    const deleting = early.delete();
    await new Promise((r) => setTimeout(r, 50));
    expect(g.log).toEqual(["apply-start deny-all"]);
    g.open();
    const made = await creating;
    expect(g.log.slice(0, 2)).toEqual(["apply-start deny-all", "apply-done"]);
    await Promise.all([stopping, deleting]);
    expect(g.log).toEqual(["apply-start deny-all", "apply-done", "release", "release"]);
    expect(made.name).toBe(NAME);
  });

  it("R2: the timed stop of a sandbox whose apply was slow runs after the apply, and leaves nothing in force", async () => {
    const g = gated();
    const { sdk } = build(g);
    g.hold();
    const creating = sdk.create(params(NAME, { timeout: 120 }));
    setTimeout(() => g.open(), 300);
    const made = await creating;
    expect(made.status).toBe("running");
    await vi.waitFor(() => expect(made.status).toBe("stopped"), { timeout: 2000 });
    expect(g.log).toEqual(["apply-start deny-all", "apply-done", "release"]);
  });

  it("R3: a failed apply destroys the VM first and then still releases, on create and on wake", async () => {
    const g = gated({ failApply: true });
    const { sdk, rig } = build(g);
    const releasedWith: number[] = [];
    const inner = g.port.release;
    g.port.release = async (id) => {
      releasedWith.push(rig.helper.entries.size);
      await inner(id);
    };
    await expect(sdk.create(params())).rejects.toMatchObject({ response: { status: 502 } });
    expect(g.log).toEqual(["apply-start deny-all", "apply-partial", "release"]);
    expect(releasedWith).toEqual([0]); // the VM was already gone
    g.failApply = false;
    const made = await sdk.create(params());
    await made.stop();
    g.log.length = 0;
    releasedWith.length = 0;
    g.failApply = true;
    await expect(sdk.get({ name: NAME, resume: true, ...creds })).rejects.toMatchObject({ response: { status: 502 } });
    expect(g.log).toEqual(["apply-start deny-all", "apply-partial", "release"]);
    expect(releasedWith).toEqual([0]);
    expect(made.status).toBe("stopped");
  });

  it("R4: a policy change on a deleted handle is a 404 and on a stopped VM a 409, and never reaches the policy port or a later sandbox of the same name", async () => {
    const g = gated();
    const { sdk } = build(g);
    const old = await sdk.create(params());
    await old.stop();
    await expect(old.updateNetworkPolicy("allow-all")).rejects.toMatchObject({ response: { status: 409 } });
    await old.delete();
    await expect(old.updateNetworkPolicy("allow-all")).rejects.toMatchObject({ response: { status: 404 } });
    const fresh = await sdk.create(params());
    g.log.length = 0;
    await expect(old.updateNetworkPolicy("allow-all")).rejects.toMatchObject({ response: { status: 404 } });
    expect(g.log).toEqual([]);
    await fresh.updateNetworkPolicy({ allow: [] });
    expect(g.log).toEqual(["apply-start rules", "apply-done"]);
  });

  it("R6: a wake holds commands and files off until its closing policy is in force", async () => {
    const g = gated();
    const { sdk } = build(g);
    const sandbox = await sdk.create(params());
    await sandbox.stop();
    g.hold();
    const waking = sdk.get({ name: NAME, resume: true, ...creds });
    await new Promise((r) => setTimeout(r, 200));
    expect(sandbox.status).toBe("pending");
    await expect(sandbox.runCommand({ cmd: "true", detached: true })).rejects.toMatchObject({ response: { status: 409 } });
    await expect(sandbox.writeFiles([{ path: "/fx/a", content: "x" }])).rejects.toMatchObject({ response: { status: 409 } });
    g.open();
    expect((await waking).status).toBe("running");
  });

  it("R6: nor in the moment after the boot has landed and before the closing policy has started", async () => {
    const g = gated();
    const { sdk, rig } = build(g);
    const sandbox = await sdk.create(params());
    await sandbox.stop();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const realGet = rig.daemon.get.bind(rig.daemon);
    rig.daemon.get = async (name, opts) => {
      const made = await realGet(name, opts);
      await gate; // the daemon says "running" here; the adapter has not yet heard
      return made;
    };
    const waking = sdk.get({ name: NAME, resume: true, ...creds });
    await new Promise((r) => setTimeout(r, 200));
    expect(rig.daemon.stateOf([...rig.helper.entries.keys()][0] as string)).toBe("running");
    expect(sandbox.status).toBe("pending");
    await expect(sandbox.runCommand({ cmd: "true", detached: true })).rejects.toMatchObject({ response: { status: 409 } });
    open();
    expect((await waking).status).toBe("running");
  });

  it("R5: a wake whose closing policy fails, with the helper refusing the destroy, stays pending and refuses commands", async () => {
    const g = gated();
    const { sdk, rig } = build(g);
    const sandbox = await sdk.create(params());
    await sandbox.stop();
    g.failApply = true;
    rig.helper.refuse.set("destroy", "internal");
    await expect(sdk.get({ name: NAME, resume: true, ...creds })).rejects.toMatchObject({ response: { status: 502 } });
    expect(rig.helper.entries.size).toBe(1); // the VM is still there
    expect(sandbox.status).toBe("pending"); // so it is never reported as a stopped, usable sandbox
    await expect(sandbox.runCommand({ cmd: "true", detached: true })).rejects.toMatchObject({ response: { status: 409 } });
    await expect(sandbox.writeFiles([{ path: "/fx/a", content: "x" }])).rejects.toMatchObject({ response: { status: 409 } });
    rig.helper.refuse.delete("destroy");
  });

  it("R6: a wake that was given up on, with the helper refusing the destroy, stays pending and refuses commands", async () => {
    const g = gated();
    const { sdk, rig } = build(g);
    const sandbox = await sdk.create(params());
    await sandbox.stop();
    g.log.length = 0; // the stop's own release must not be mistaken for the one this test waits for
    const ac = new AbortController();
    let open!: () => void;
    rig.helper.holdPrepare = new Promise<void>((r) => (open = r));
    const waking = sdk.get({ name: NAME, resume: true, signal: ac.signal, ...creds });
    await new Promise((r) => setTimeout(r, 60));
    ac.abort(new Error("gave up"));
    await expect(waking).rejects.toThrow("gave up");
    rig.helper.refuse.set("destroy", "internal");
    open();
    // the boot lands, the closing policy goes in, the signal is found aborted, the destroy is refused, the release still happens: the abort-after-boot path
    await vi.waitFor(() => expect(g.log).toEqual(["apply-start deny-all", "apply-done", "release"]), { timeout: 3000 });
    expect(rig.helper.entries.size).toBe(1);
    expect(sandbox.status).toBe("pending");
    await expect(sandbox.runCommand({ cmd: "true", detached: true })).rejects.toMatchObject({ response: { status: 409 } });
    rig.helper.refuse.delete("destroy");
  });

  it("a stop through a stale handle is a 404 and never stops a newer sandbox of the same name", async () => {
    const g = gated();
    const { sdk } = build(g);
    const old = await sdk.create(params());
    await old.delete();
    const fresh = await sdk.create(params());
    g.log.length = 0;
    await expect(old.stop()).rejects.toMatchObject({ response: { status: 404 } });
    expect(fresh.status).toBe("running");
    expect(g.log).toEqual([]);
    await expect(fresh.runCommand({ cmd: "true", detached: true })).resolves.toBeDefined();
  });

  it("a wake of a sandbox that is already running changes nothing: same session, no new policy", async () => {
    const g = gated();
    const { sdk } = build(g);
    const sandbox = await sdk.create(params());
    const session = sandbox.currentSession().sessionId;
    g.log.length = 0;
    const same = await sdk.get({ name: NAME, resume: true, ...creds });
    expect(same.currentSession().sessionId).toBe(session);
    expect(g.log).toEqual([]);
  });

  it("the timeout of a woken sandbox counts from when its policy is in force, not from the boot", async () => {
    const g = gated();
    const { sdk } = build(g);
    const sandbox = await sdk.create(params(NAME, { timeout: 150 }));
    await sandbox.stop();
    g.hold();
    setTimeout(() => g.open(), 300);
    const woken = await sdk.get({ name: NAME, resume: true, ...creds });
    expect(woken.status).toBe("running");
    await new Promise((r) => setTimeout(r, 40));
    expect(woken.status).toBe("running");
    await vi.waitFor(() => expect(woken.status).toBe("stopped"), { timeout: 2000 });
  });
});

describe("the limit as an absolute value (LimitControl)", () => {
  const build = () => {
    const rig = makeRig();
    const log: PolicyLog = { applied: [], released: [] };
    return { rig, sdk: createDaemonSdk({ daemon: rig.daemon, policy: policyPort(log), template: "fx-agent", memMb: 512 }) };
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("armTimeoutAt sets the live timer and leaves the total alone: a longer value outlives the original limit, a shorter one ends the sandbox sooner", async () => {
    const { sdk } = build();
    const longer = await sdk.create(params("lc-longer", { timeout: 150 }));
    const shorter = await sdk.create(params("lc-shorter", { timeout: 60_000 }));
    await sdk.armTimeoutAt("lc-longer", 1000);
    await sdk.armTimeoutAt("lc-shorter", 100);
    expect(longer.timeout).toBe(150); // not added to the total
    expect(shorter.timeout).toBe(60_000);
    await sleep(400);
    expect(longer.status).toBe("running");
    expect(shorter.status).toBe("stopped");
    await longer.delete();
  });

  it("setTimeoutMs sets the total a wake arms with, and leaves the live timer alone", async () => {
    const { sdk } = build();
    const live = await sdk.create(params("lc-live", { timeout: 150 }));
    await sdk.setTimeoutMs("lc-live", 60_000);
    expect(live.timeout).toBe(60_000);
    await vi.waitFor(() => expect(live.status).toBe("stopped"), { timeout: 2000 }); // the live timer still fired at 150 ms
    await sdk.setTimeoutMs("lc-live", 250); // a wake now arms with this total, exactly
    const woken = await sdk.get({ name: "lc-live", resume: true, ...creds });
    expect(woken.timeout).toBe(250);
    expect(woken.status).toBe("running");
    await vi.waitFor(() => expect(woken.status).toBe("stopped"), { timeout: 2000 });
  });

  it("armTimeoutAt on a sandbox with no live timer does nothing, and a bad value or an unknown name is refused", async () => {
    const { sdk } = build();
    const sandbox = await sdk.create(params("lc-down", { timeout: 60_000 }));
    await sandbox.stop();
    await expect(sdk.armTimeoutAt("lc-down", 50)).resolves.toBeUndefined();
    const woken = await sdk.get({ name: "lc-down", resume: true, ...creds });
    await sleep(150);
    expect(woken.status).toBe("running"); // the 50 ms was never applied to the next session
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
      await expect(sdk.armTimeoutAt("lc-down", bad)).rejects.toMatchObject({ response: { status: 400 } });
      await expect(sdk.setTimeoutMs("lc-down", bad)).rejects.toMatchObject({ response: { status: 400 } });
    }
    await expect(sdk.armTimeoutAt("lc-nobody", 100)).rejects.toMatchObject({ response: { status: 404 } });
    await expect(sdk.setTimeoutMs("lc-nobody", 100)).rejects.toMatchObject({ response: { status: 404 } });
    await woken.delete();
  });

  it("a timer past 2^31-1 ms is clamped, on an extension and on a wake, and never fires at once", async () => {
    const { sdk } = build();
    const sandbox = await sdk.create(params("lc-clamp", { timeout: 1000 }));
    await sandbox.extendTimeout(2 ** 31 - 1); // the running total is now past what a timer holds
    await sleep(150);
    expect(sandbox.status).toBe("running");
    await sandbox.stop();
    const woken = await sdk.get({ name: "lc-clamp", resume: true, ...creds });
    expect(woken.timeout).toBe(1000 + 2 ** 31 - 1);
    await sleep(150);
    expect(woken.status).toBe("running");
    await woken.delete();
  });
});
