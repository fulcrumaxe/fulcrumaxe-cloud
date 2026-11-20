import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { unixSocketsRefused } from "../../helpers/needsHostSockets.js";
import { socketTmpRoot } from "../../helpers/tmpRoot.js";
import { AgentClient, ExecStream, viaUnixSocket } from "../helpers/agentClient.js";
import { createGuestAgent, type GuestAgent } from "../../../src/vm/sandboxd/guestAgent.js";
import type { GuestStream, StreamFrame } from "../../../src/vm/sandboxd/streamCommand.js";
import { makeRig, runCleanups } from "./helpers.js";

/**
 * D#587 B-5a-RT-1 against the real guest agent: `agent.py` itself, run on a Unix socket (`--unix`, the same code after accept), spoken to by the
 * production client. The test client in helpers/agentClient.ts stays as the independent oracle: what it reads off the same agent is what the
 * production client must read. Not faked faithfully here: vsock itself and Firecracker's UDS proxy (the dispatched real-VM run, vmStream.real.test.ts),
 * and the guest's cgroup-based token launch (agentToken.test.ts).
 */
const GUEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "infra", "microvm-image", "guest");
const AGENT = process.env["FX_TEST_AGENT_PY"] ?? path.join(GUEST_DIR, "agent.py");
const hasPython = spawnSync("python3", ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"]).status === 0;
const skip = !hasPython || unixSocketsRefused();
const bin = (name: string): string => {
  const found = (process.env["PATH"] ?? "").split(path.delimiter).map((d) => path.join(d, name)).find((f) => existsSync(f));
  if (found === undefined) throw new Error(`${name} is not on PATH`);
  return found;
};
const hasSetsid = (process.env["PATH"] ?? "").split(path.delimiter).some((d) => d !== "" && existsSync(path.join(d, "setsid")));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const HOST_PATH = { PATH: process.env["PATH"] ?? "" };
const SH = (): string => bin("sh");

interface RunningAgent { proc: ChildProcess; sock: string; guest: GuestAgent; oracle: AgentClient }
let dir: string;
const agents: ChildProcess[] = [];
async function startAgent(name: string, slowStart = false): Promise<RunningAgent> {
  const sock = path.join(dir, `${name}.sock`);
  const wrapper = path.join(dir, `${name}.py`);
  writeFileSync(wrapper, `import subprocess, sys, time\nsys.path.insert(0, ${JSON.stringify(path.dirname(AGENT))})\nimport agent\nreal = subprocess.Popen\n\ndef slow(*a, **k):\n    time.sleep(1.0)\n    return real(*a, **k)\n\n${slowStart ? "subprocess.Popen = slow\n" : ""}sys.argv = ["agent.py", "--unix", ${JSON.stringify(sock)}]\nagent.main()\n`);
  const proc = spawn("python3", ["-I", wrapper], { stdio: "ignore", env: { ...process.env } });
  agents.push(proc);
  for (let i = 0; i < 200 && !existsSync(sock); i++) await sleep(25);
  const connect = (): Promise<net.Socket> => new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    s.once("error", reject);
    s.once("connect", () => resolve(s));
  });
  return { proc, sock, guest: createGuestAgent(connect, 5000), oracle: new AgentClient(viaUnixSocket(sock)) };
}

async function drain(stream: GuestStream): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  for await (const f of stream.frames) out.push(f);
  return out;
}
const text = (frames: StreamFrame[], stream: "stdout" | "stderr"): string => Buffer.concat(frames.filter((f) => f.stream === stream).map((f) => f.data)).toString();

describe.skipIf(skip)("the production client against agent.py", () => {
  let a: RunningAgent;
  let slow: RunningAgent;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(socketTmpRoot(), "fx-strmreal-"));
    a = await startAgent("a");
    slow = await startAgent("slow", true);
  });
  afterAll(() => {
    for (const p of agents) p.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the same frames, in the same order, as the independent test client, and the exit once", async () => {
    const argv = [SH(), "-c", "for i in 1 2 3; do echo o$i; sleep 0.1; echo e$i >&2; sleep 0.1; done; exit 4"];
    const ours = await a.guest.streamInGuest({ env: HOST_PATH, id: "same-ours", argv });
    const frames = await drain(ours);
    const oracle = (await (await ExecStream.open(viaUnixSocket(a.sock), { id: "same-oracle", argv, env: HOST_PATH })).all()).filter((i) => i.ev === "data") as Array<{ stream: string; data: Buffer }>;
    expect(frames.map((f) => `${f.stream}:${f.data.toString().trim()}`)).toEqual(oracle.map((f) => `${f.stream}:${f.data.toString().trim()}`));
    expect(frames).toHaveLength(6);
    expect(await ours.done).toEqual({ exit: 4, signal: null, timedOut: false });
  });

  it("delivers output while the command still runs (the first frame arrives long before it ends)", async () => {
    const stream = await a.guest.streamInGuest({ env: HOST_PATH, id: "live-1", argv: [SH(), "-c", "echo first; sleep 1.2; echo last"] });
    const t = Date.now();
    const first = await stream.frames[Symbol.asyncIterator]().next();
    expect(first.value).toMatchObject({ stream: "stdout", data: Buffer.from("first\n") });
    expect(Date.now() - t).toBeLessThan(800);
    await stream.frames[Symbol.asyncIterator]().return?.();
  });

  it("feeds stdin, reports a program that cannot start as exit 127, and a timeout as `timedOut` with the guest's SIGKILL", async () => {
    const cat = await a.guest.streamInGuest({ env: HOST_PATH, id: "cat-1", argv: [bin("cat")], stdin: Buffer.from("piped prompt") });
    expect(text(await drain(cat), "stdout")).toBe("piped prompt");
    expect(await cat.done).toMatchObject({ exit: 0 });
    const nope = await a.guest.streamInGuest({ env: HOST_PATH, id: "nope-1", argv: ["/nonexistent/tool"] });
    await drain(nope);
    expect(await nope.done).toEqual({ exit: 127, signal: null, timedOut: false });
    const t0 = Date.now();
    const timed = await a.guest.streamInGuest({ env: HOST_PATH, id: "to-1", argv: [bin("sleep"), "30"], timeoutS: 0.3 });
    await drain(timed);
    expect(await timed.done).toEqual({ exit: null, signal: 9, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it.each([
    ["SIGTERM", "sleep 30", { exit: null, signal: 15 }],
    ["SIGKILL", "trap '' TERM INT HUP; sleep 30", { exit: null, signal: 9 }],
  ] as const)("kill(%s) ends the command and `done` says which signal ended it", async (signal, script, expected) => {
    const stream = await a.guest.streamInGuest({ env: HOST_PATH, id: `k-${signal}`, argv: [SH(), "-c", `${script}`] });
    const reading = drain(stream);
    await sleep(300);
    await stream.kill(signal);
    await reading;
    expect(await stream.done).toMatchObject({ ...expected, timedOut: false });
  });

  it("kill(SIGINT) reaches a child that traps it, and kill(SIGHUP) likewise: the command's own handler decides how it ends", async () => {
    for (const [signal, mark] of [["SIGINT", "int"], ["SIGHUP", "hup"]] as const) {
      const script = `trap 'echo got-${mark}; exit 7' ${mark.toUpperCase()}; echo ready; while :; do ${bin("sleep")} 0.05; done`;
      const stream = await a.guest.streamInGuest({ env: HOST_PATH, id: `trap-${mark}`, argv: [SH(), "-c", script] });
      const it = stream.frames[Symbol.asyncIterator]();
      expect((await it.next()).value).toMatchObject({ data: Buffer.from("ready\n") });
      await stream.kill(signal);
      const rest: StreamFrame[] = [];
      for (let n = await it.next(); n.done !== true; n = await it.next()) rest.push(n.value);
      expect(text(rest, "stdout")).toContain(`got-${mark}`);
      expect(await stream.done).toMatchObject({ exit: 7, signal: null });
    }
  });

  it.skipIf(!hasSetsid)("kill(SIGKILL) ends a command whose descendant left the process group with setsid, and the stream ends within a bound", async () => {
    const pidFile = path.join(dir, "esc.pid");
    const script = `${bin("setsid")} ${SH()} -c 'echo $$ > ${pidFile}; while :; do printf x 2>/dev/null; ${bin("sleep")} 0.1; done' & wait`;
    const stream = await a.guest.streamInGuest({ env: HOST_PATH, id: "esc-1", argv: [SH(), "-c", script], timeoutS: 60 });
    const reading = drain(stream);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(25);
    await sleep(100);
    const escapee = readFileSync(pidFile, "utf8").trim();
    const t = Date.now();
    await stream.kill("SIGKILL");
    await reading;
    expect(await stream.done).toMatchObject({ signal: 9 });
    expect(Date.now() - t).toBeLessThan(9000);
    await sleep(200);
    const state = ((): string => {
      try {
        return /^\d+ \(.*\) (\S)/.exec(readFileSync(path.join("/", "proc", escapee, "stat"), "utf8"))?.[1] ?? "gone";
      } catch {
        return "gone";
      }
    })();
    expect(["gone", "Z"]).toContain(state);
  }, 30_000);

  it("a kill sent while the guest is still starting the command is held by the guest and lands (the strongest signal wins)", async () => {
    const stream = await slow.guest.streamInGuest({ env: HOST_PATH, id: "early-1", argv: [bin("sleep"), "30"] });
    await sleep(250); // the guest's start takes a second: the command is registered, not yet running
    await stream.kill("SIGKILL");
    await stream.kill("SIGTERM");
    await drain(stream);
    expect(await stream.done).toMatchObject({ signal: 9 });
  });

  it("a kill of a command that has ended is not an error, and nor is one that races the guest reading the request", async () => {
    const stream = await a.guest.streamInGuest({ env: HOST_PATH, id: "end-1", argv: [bin("true")] });
    await drain(stream);
    await expect(stream.kill("SIGTERM")).resolves.toBeUndefined();
    for (let i = 0; i < 8; i++) {
      const racing = await a.guest.streamInGuest({ env: HOST_PATH, id: `race-${i}`, argv: [bin("sleep"), "30"] });
      const reading = drain(racing);
      await racing.kill("SIGKILL"); // straight after the write: the agent may not have registered the id yet
      await reading;
      expect(await racing.done).toMatchObject({ signal: 9 });
    }
  });

  it("an id the guest has already used is `refused` (its duplicate_id), not a clean end", async () => {
    // streamInGuest resolves once the request is written, not once the guest has registered the id; the two requests ride separate connections, so
    // without a guest-side acknowledgement the guest may read the second first (and then the first is the one refused). The command's first output is
    // that acknowledgement: the guest sends it only after it registered the id and started the process.
    const first = await a.guest.streamInGuest({ env: HOST_PATH, id: "dup-1", argv: [SH(), "-c", `echo up; exec ${bin("sleep")} 30`] });
    const firstFrames = first.frames[Symbol.asyncIterator]();
    expect(await firstFrames.next()).toMatchObject({ done: false, value: { stream: "stdout" } });
    const second = await a.guest.streamInGuest({ env: HOST_PATH, id: "dup-1", argv: [bin("true")] });
    await expect(drain(second)).rejects.toMatchObject({ code: "refused" });
    await first.kill("SIGKILL");
    await drain(first);
  });

  it("reads 20 MiB of output in full and in order, in frames of at most 64 KiB, and a quiet command's silence is not an error", async () => {
    const total = 20 << 20;
    const stream = await a.guest.streamInGuest({ env: HOST_PATH, id: "big-1", argv: [SH(), "-c", `head -c ${total} /dev/zero | tr '\\0' 'a'; sleep 0.3; echo done >&2`] });
    let bytes = 0;
    let biggest = 0;
    let bad = false;
    for await (const f of stream.frames) {
      biggest = Math.max(biggest, f.data.length);
      if (f.stream === "stdout") {
        bytes += f.data.length;
        if (f.data.some((b) => b !== 0x61)) bad = true;
      }
    }
    expect(bytes).toBe(total);
    expect(biggest).toBeLessThanOrEqual(65536);
    expect(bad).toBe(false);
    expect(await stream.done).toMatchObject({ exit: 0 });
  }, 60_000);
});

describe.skipIf(skip)("Sandbox.runStream on the daemon, with the real guest agent behind it", () => {
  afterEach(runCleanups);
  let a: RunningAgent;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(socketTmpRoot(), "fx-strmd-"));
    a = await startAgent("d");
  });
  afterAll(() => {
    for (const p of agents) p.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });
  const params = (name: string) => ({ name, template: "fx-agent", vcpus: 1, memMb: 256 });
  const rigWithRealAgent = () => makeRig({ agentFor: () => a.guest });

  it("runs a command, streams its output and exit, and refuses an id the VM's agent has seen (even after the first ended)", async () => {
    const rig = rigWithRealAgent();
    const sb = await rig.daemon.create(params("s1"));
    const stream = await sb.runStream({ env: HOST_PATH, id: "job-1", cmd: SH(), args: ["-c", "echo $0 hi; exit 3"], timeoutS: 30 });
    expect(text(await drain(stream), "stdout")).toContain("hi");
    expect(await stream.done).toMatchObject({ exit: 3 });
    await expect(sb.runStream({ env: HOST_PATH, id: "job-1", cmd: bin("true") })).rejects.toMatchObject({ status: 409, code: "conflict" });
  });

  it("refuses a bad id, a stopped sandbox, and a token launch as root, before the guest sees anything", async () => {
    const rig = rigWithRealAgent();
    const sb = await rig.daemon.create(params("s2"));
    await expect(sb.runStream({ env: HOST_PATH, id: "bad id", cmd: bin("true") })).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await expect(sb.runStream({ env: HOST_PATH, id: "tok-1", cmd: bin("true"), withToken: true, user: "root" })).rejects.toMatchObject({ code: "bad_request" });
    await sb.stop();
    await expect(sb.runStream({ env: HOST_PATH, id: "late-1", cmd: bin("true") })).rejects.toMatchObject({ status: 409, code: "not_running" });
    await expect(rig.daemon.runStream("no-such", { id: "x-1", cmd: bin("true") })).rejects.toMatchObject({ status: 404 });
  });

  it("a stop kills a running stream that the consumer reads, and `done` settles", async () => {
    const rig = rigWithRealAgent();
    const sb = await rig.daemon.create(params("s3"));
    const stream = await sb.runStream({ env: HOST_PATH, id: "stop-1", cmd: bin("sleep"), args: ["30"] });
    const reading = drain(stream).catch(() => undefined);
    await sleep(200);
    const t = Date.now();
    await sb.stop();
    await reading;
    const done = await stream.done.then((d) => d, (e: unknown) => e);
    expect(done).toSatisfy((d: unknown) => (d as { signal?: number }).signal === 9 || (d as { code?: string }).code === "lost");
    expect(Date.now() - t).toBeLessThan(5000);
    expect(sb.status).toBe("stopped");
  });

  it("a stop ends a stream whose consumer never reads (the kill's exit frame cannot be read), by dropping the connection: `done` rejects `lost`", async () => {
    const rig = rigWithRealAgent();
    const sb = await rig.daemon.create(params("s4"));
    const stream = await sb.runStream({ env: HOST_PATH, id: "stop-2", cmd: bin("sleep"), args: ["30"] });
    await sb.stop();
    await expect(stream.done).rejects.toMatchObject({ code: "lost" });
  });

  it("a delete waits for the running stream's end as a stop does, and leaves no record", async () => {
    const rig = rigWithRealAgent();
    const sb = await rig.daemon.create(params("s5"));
    const stream = await sb.runStream({ env: HOST_PATH, id: "del-1", cmd: bin("sleep"), args: ["30"] });
    await sb.delete();
    await expect(stream.done).rejects.toMatchObject({ code: "lost" });
    expect(rig.daemon.list()).toEqual([]);
  });

  it("a stream that ended is no longer a running command: stop has nothing of it to kill", async () => {
    const rig = rigWithRealAgent();
    const sb = await rig.daemon.create(params("s6"));
    const stream = await sb.runStream({ env: HOST_PATH, id: "ended-1", cmd: bin("true") });
    await drain(stream);
    await stream.done;
    await sleep(20);
    expect((rig.daemon as unknown as { records: Map<string, { commands: Set<unknown> }> }).records.get("s6")?.commands.size).toBe(0);
    await sb.stop();
  });
});
