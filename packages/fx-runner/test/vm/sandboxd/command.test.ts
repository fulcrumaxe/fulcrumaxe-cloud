import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxdCommand, type LogChunk } from "../../../src/vm/sandboxd/command.js";
import { createGuestAgent, viaFirecrackerVsock, type ExecResult, type GuestAgent } from "../../../src/vm/sandboxd/guestAgent.js";
import { makeRig, runCleanups } from "./helpers.js";

afterEach(runCleanups);
const params = (name: string) => ({ name, template: "fx-agent", vcpus: 2, memMb: 512 });
const collect = async (it: AsyncIterable<LogChunk>): Promise<LogChunk[]> => {
  const out: LogChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
};
/** How many processes on this host have `needle` in their command line (the fake guest runs its commands here). */
const running = (needle: string): number => Number(spawnSync("pgrep", ["-fc", needle], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } }).stdout.trim() || 0);
const until = async (fn: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 25));
};
/** A rig whose guest connections wait for `gate.now`: swap it for an open promise to let them through. */
function gatedRig() {
  const gate = { now: Promise.resolve() as Promise<void> };
  const rig = makeRig({
    agentFor: (dir) => {
      const connect = viaFirecrackerVsock(`${dir}/v.sock`);
      return createGuestAgent(async () => {
        await gate.now;
        return connect();
      });
    },
  });
  const close = (): { open: () => void } => {
    let open!: () => void;
    gate.now = new Promise<void>((r) => (open = r));
    return { open };
  };
  return { rig, close };
}

describe("a detached command", () => {
  it("echo ok: stdout, exit 0 once, and the logs replay", async () => {
    const sb = await (await makeRig().daemon.create(params("a")));
    const cmd = await sb.runCommand({ cmd: "echo", args: ["ok"] });
    expect(await cmd.wait()).toEqual({ exitCode: 0 });
    expect(await collect(cmd.logs())).toEqual([{ stream: "stdout", data: "ok\n" }]);
    expect(await collect(cmd.logs())).toEqual([{ stream: "stdout", data: "ok\n" }]);
  });

  it("each stream keeps its order, the exit code is the process's, and wait() says the same thing every time", async () => {
    const sb = await makeRig().daemon.create(params("a"));
    const cmd = await sb.runCommand({ cmd: "sh", args: ["-c", "echo one; echo err1 >&2; echo two; echo err2 >&2; exit 3"] });
    const seen: number[] = [];
    await Promise.all([cmd.wait().then((r) => seen.push(r.exitCode)), cmd.wait().then((r) => seen.push(r.exitCode))]);
    seen.push((await cmd.wait()).exitCode);
    expect(seen).toEqual([3, 3, 3]);
    const logs = await collect(cmd.logs());
    expect(logs.filter((c) => c.stream === "stdout").map((c) => c.data).join("")).toBe("one\ntwo\n");
    expect(logs.filter((c) => c.stream === "stderr").map((c) => c.data).join("")).toBe("err1\nerr2\n");
  });

  it("a program that does not exist exits 127 and does not hang", async () => {
    const sb = await makeRig().daemon.create(params("a"));
    expect((await (await sb.runCommand({ cmd: "/nonexistent/prog" })).wait()).exitCode).toBe(127);
  });

  it("kill ends a running command in the guest with the signal's code, once; a kill after the end changes nothing", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(params("a"));
    const cmd = await sb.runCommand({ cmd: "sleep", args: ["31.11"] });
    await until(() => running("sleep 31.11") > 0);
    expect(running("sleep 31.11")).toBeGreaterThan(0);
    const results: number[] = [];
    void cmd.wait().then((r) => results.push(r.exitCode));
    await cmd.kill("SIGKILL");
    await cmd.kill("SIGKILL");
    expect((await cmd.wait()).exitCode).toBe(137);
    await until(() => running("sleep 31.11") === 0);
    expect(running("sleep 31.11")).toBe(0);
    await cmd.kill();
    expect(results).toEqual([137]);
    const term = await sb.runCommand({ cmd: "sleep", args: ["31.12"] });
    await term.kill();
    expect((await term.wait()).exitCode).toBe(143);
  });

  it("stop while a command is still starting waits for the start, kills the command, and settles it once", async () => {
    const { rig, close } = gatedRig();
    const sb = await rig.daemon.create(params("a"));
    const { open } = close();
    const pending = sb.runCommand({ cmd: "sleep", args: ["31.14"] });
    const stopping = sb.stop();
    let stopped = false;
    void stopping.then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBe(false); // the start is still in flight, so the stop waits for it
    expect(rig.helper.frames.map((f) => f["verb"])).toEqual(["prepare", "start"]);
    open();
    const cmd = await pending;
    await stopping;
    const exits: number[] = [];
    await cmd.wait().then((r) => exits.push(r.exitCode));
    expect(exits).toEqual([137]);
    expect(sb.status).toBe("stopped");
    expect(rig.helper.frames.map((f) => f["verb"])).toEqual(["prepare", "start", "destroy"]);
    await until(() => running("sleep 31.14") === 0);
    expect(running("sleep 31.14")).toBe(0);
  });

  it("an abort that fires during the start kills the command as soon as it is running", async () => {
    const { rig, close } = gatedRig();
    const sb = await rig.daemon.create(params("a"));
    const { open } = close();
    const ac = new AbortController();
    const pending = sb.runCommand({ cmd: "sleep", args: ["31.13"], signal: ac.signal });
    ac.abort();
    open();
    const cmd = await pending;
    expect((await cmd.wait()).exitCode).toBe(137);
    await until(() => running("sleep 31.13") === 0);
    expect(running("sleep 31.13")).toBe(0);
  });
});

/** Deterministic races against a scripted agent: no processes, only the order of events. */
describe("kill during start, scripted", () => {
  const exited = (over: Partial<ExecResult> = {}): ExecResult => ({ exit: 0, signal: null, timedOut: false, stdout: Buffer.from("hi"), stderr: Buffer.alloc(0), ...over });
  function script() {
    const calls: string[][] = [];
    const held: Array<{ req: Parameters<GuestAgent["runInGuest"]>[0]; resolve: (r: ExecResult) => void; reject: (e: unknown) => void }> = [];
    const agent: GuestAgent = {
      ping: async () => undefined,
      put: async () => undefined,
      get: async () => 0,
      putToken: async () => undefined,
      wipeToken: async () => ({ removed: false, killed: 0 }),
      runInGuest: (req) => {
        calls.push(req.argv);
        return new Promise((resolve, reject) => held.push({ req, resolve, reject }));
      },
    };
    return { agent, calls, held };
  }

  it("a kill before start() sends nothing to the guest and ends the command with the signal's code", async () => {
    const s = script();
    const cmd = new SandboxdCommand(s.agent, { cmd: "sleep" });
    await cmd.kill("SIGKILL");
    await cmd.start();
    expect(s.calls).toEqual([]);
    expect(await cmd.wait()).toEqual({ exitCode: 137 });
  });

  it("a kill between connect and write is delivered the moment the request is written", async () => {
    const s = script();
    const cmd = new SandboxdCommand(s.agent, { cmd: "sleep" });
    const started = cmd.start();
    await cmd.kill("SIGTERM");
    expect(s.calls).toHaveLength(1); // only the command itself: not yet sent, so no kill exec
    s.held[0]!.req.onSent?.();
    await started;
    await until(() => s.calls.length === 2);
    expect(s.calls[1]!.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(s.calls[1]!.at(-1)).toBe("TERM");
    s.held[0]!.resolve(exited({ exit: null, signal: 15 }));
    expect(await cmd.wait()).toEqual({ exitCode: 143 });
  });

  it("the exit code is delivered once: a kill that cannot be delivered ends the command, and the guest's late answer does not change it", async () => {
    const s = script();
    const cmd = new SandboxdCommand(s.agent, { cmd: "sleep" });
    const started = cmd.start();
    s.held[0]!.req.onSent?.();
    await started;
    const killing = cmd.kill("SIGKILL");
    await until(() => s.held.length === 2);
    s.held[1]!.reject(new Error("guest gone"));
    await killing;
    expect(await cmd.wait()).toEqual({ exitCode: 137 });
    s.held[0]!.resolve(exited({ exit: 0 }));
    await new Promise((r) => setTimeout(r, 10));
    expect(await cmd.wait()).toEqual({ exitCode: 137 });
    expect(await collect(cmd.logs())).toEqual([]);
  });

  it("a command that could not be sent rejects start, and wait() with it", async () => {
    const s = script();
    const cmd = new SandboxdCommand(s.agent, { cmd: "sleep" });
    const started = cmd.start();
    s.held[0]!.reject(new Error("no route"));
    await expect(started).rejects.toThrow("no route");
    await expect(cmd.wait()).rejects.toThrow("no route");
  });

  it("an abort signal that is already set never starts the command; one that fires during the start kills it once it runs", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(params("a"));
    const before = rig.agents.get("a")!.execs.length;
    const cmd = await sb.runCommand({ cmd: "sleep", args: ["31.15"], signal: AbortSignal.abort() });
    expect((await cmd.wait()).exitCode).toBe(137);
    expect(rig.agents.get("a")!.execs.length).toBe(before);
    expect(running("sleep 31.15")).toBe(0);
  });

  it("delete kills what is running and leaves no process behind", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(params("a"));
    const cmd = await sb.runCommand({ cmd: "sleep", args: ["31.16"] });
    await until(() => running("sleep 31.16") > 0);
    await sb.delete();
    expect((await cmd.wait()).exitCode).toBe(137);
    await until(() => running("sleep 31.16") === 0);
    expect(running("sleep 31.16")).toBe(0);
    expect(rig.daemon.list()).toEqual([]);
  });
});
