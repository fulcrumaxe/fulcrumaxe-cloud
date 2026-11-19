import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unixSocketsRefused } from "../helpers/needsHostSockets.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";
import { AgentClient, ExecStream, viaUnixSocket, type StreamItem } from "./helpers/agentClient.js";

/**
 * The agent's streaming exec and native kill (D#587 B-1b), checked with the agent's own code on a Unix socket (`--unix`), no VM. FX_TEST_AGENT_PY
 * points the run at a mutated copy, which is how each guard here was checked (a mutant must turn a test red).
 */
const GUEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "microvm-image", "guest");
const AGENT = process.env["FX_TEST_AGENT_PY"] ?? path.join(GUEST_DIR, "agent.py");
const bin = (name: string): string => {
  const found = (process.env["PATH"] ?? "").split(path.delimiter).map((d) => path.join(d, name)).find((f) => existsSync(f));
  if (found === undefined) throw new Error(`${name} is not on PATH`);
  return found;
};
const hasPython = spawnSync("python3", ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"]).status === 0;
const skip = !hasPython || unixSocketsRefused();
const HOST_PATH = { PATH: process.env["PATH"] ?? "" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The agent, with Popen made slow when `slowStart` is set, so a kill can be made to arrive while a command is still starting. */
async function startAgent(dir: string, name: string, slowStart = false, env: Record<string, string> = {}): Promise<{ proc: ChildProcess; client: AgentClient; connect: () => Promise<net.Socket> }> {
  const sock = path.join(dir, `${name}.sock`);
  const wrapper = path.join(dir, `${name}.py`);
  writeFileSync(wrapper, `import subprocess, sys, time\nsys.path.insert(0, ${JSON.stringify(path.dirname(AGENT))})\nimport agent\nreal = subprocess.Popen\n\ndef slow(*a, **k):\n    time.sleep(1.0)\n    return real(*a, **k)\n\n${slowStart ? "subprocess.Popen = slow\n" : ""}sys.argv = ["agent.py", "--unix", ${JSON.stringify(sock)}]\nagent.main()\n`);
  const proc = spawn("python3", ["-I", wrapper], { stdio: "ignore", env: { ...process.env, ...env } });
  for (let i = 0; i < 200 && !existsSync(sock); i++) await sleep(25);
  const connect = viaUnixSocket(sock);
  return { proc, client: new AgentClient(connect), connect };
}

const stateOf = (pid: string): string => {
  try {
    return /^\d+ \(.*\) (\S)/.exec(readFileSync(path.join("/", "proc", pid, "stat"), "utf8"))?.[1] ?? "gone";
  } catch {
    return "gone";
  }
};
async function waitGone(pid: string): Promise<string> {
  const deadline = Date.now() + 5000;
  let state = stateOf(pid);
  while (!["gone", "Z"].includes(state) && Date.now() < deadline) {
    await sleep(25);
    state = stateOf(pid);
  }
  return state;
}
const hwmKb = (pid: number): number => Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
const exits = (items: StreamItem[]): StreamItem[] => items.filter((i) => i.ev === "exit");

describe.skipIf(skip)("agent.py streaming exec and kill", () => {
  let dir: string;
  let a: Awaited<ReturnType<typeof startAgent>>;
  let slow: Awaited<ReturnType<typeof startAgent>>;
  let stall: Awaited<ReturnType<typeof startAgent>>;
  const live: ExecStream[] = [];
  const open = async (agent: typeof a, header: Record<string, unknown>, stdin?: Buffer): Promise<ExecStream> => {
    const s = await ExecStream.open(agent.connect, header, stdin);
    live.push(s);
    return s;
  };
  beforeAll(async () => {
    dir = mkdtempSync(path.join(socketTmpRoot(), "fx-stream-"));
    a = await startAgent(dir, "a");
    slow = await startAgent(dir, "slow", true);
    stall = await startAgent(dir, "stall", false, { FX_AGENT_STALL_S: "1" });
  });
  afterAll(() => {
    for (const s of live) s.socket.destroy();
    a.proc.kill("SIGKILL");
    slow.proc.kill("SIGKILL");
    stall.proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("advertises the streaming ops without changing the protocol number", async () => {
    expect(await a.client.ping()).toEqual({ ok: true, proto: 1, caps: ["exec_stream", "kill"] });
  });

  it("delivers stdout and stderr as ordered frames while the process runs, and the exit exactly once at the end", async () => {
    const s = await open(a, { id: "order1", env: HOST_PATH, argv: [bin("sh"), "-c", "for i in 1 2 3; do echo o$i; sleep 0.15; echo e$i >&2; sleep 0.15; done; exit 4"] });
    // the first frame arrives long before the process ends (it runs about 0.9 s)
    const started = Date.now();
    const first = await s.next();
    expect(first).toMatchObject({ ev: "data", stream: "stdout", seq: 0 });
    expect(Date.now() - started).toBeLessThan(600);
    const items = [first!, ...(await s.all())];
    const data = items.filter((i) => i.ev === "data") as Array<Extract<StreamItem, { ev: "data" }>>;
    expect(data.map((d) => `${d.stream}:${d.data.toString().trim()}`)).toEqual(["stdout:o1", "stderr:e1", "stdout:o2", "stderr:e2", "stdout:o3", "stderr:e3"]);
    expect(items.map((i) => (i as { seq: number }).seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(exits(items)).toEqual([{ ev: "exit", seq: 6, exit: 4, signal: null, timed_out: false }]);
    expect(items[items.length - 1]!.ev).toBe("exit");
  });

  it("feeds stdin, reports a program that cannot start, a signal and a timeout, each with one exit frame", async () => {
    const cat = await (await open(a, { id: "stdin1", argv: [bin("cat")] }, Buffer.from("piped"))).all();
    expect(Buffer.concat(cat.filter((i) => i.ev === "data").map((i) => (i as { data: Buffer }).data)).toString()).toBe("piped");
    expect(exits(cat)).toMatchObject([{ exit: 0 }]);
    expect(await (await open(a, { id: "nope1", argv: ["/nonexistent/tool"] })).all()).toMatchObject([{ ev: "exit", exit: 127 }]);
    expect(await (await open(a, { id: "sig1", argv: [bin("sh"), "-c", "kill -9 $$"] })).all()).toMatchObject([{ ev: "exit", exit: null, signal: 9 }]);
    const t0 = Date.now();
    const timed = await (await open(a, { id: "to1", argv: [bin("sleep"), "30"], timeout_s: 0.3 })).all();
    expect(timed).toMatchObject([{ ev: "exit", exit: null, signal: 9, timed_out: true }]);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("a command that closes its output but keeps running still ends with its own exit code; a grandchild that outlives the leader is killed with it", async () => {
    expect(await (await open(a, { id: "closed1", env: HOST_PATH, argv: [bin("sh"), "-c", `exec >&- 2>&-; ${bin("sleep")} 0.6; exit 5`] })).all()).toMatchObject([{ ev: "exit", exit: 5, signal: null }]);
    const pidFile = path.join(dir, "orphan.pid");
    const t0 = Date.now();
    const items = await (await open(a, { id: "orphan1", argv: [bin("sh"), "-c", `${bin("sleep")} 30 & echo $! > ${pidFile}; exit 0`] })).all();
    expect(exits(items)).toMatchObject([{ exit: 0 }]);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(["gone", "Z"]).toContain(await waitGone(readFileSync(pidFile, "utf8").trim()));
  });

  it("a descendant that left the process group is still ended by the timeout, by a kill and by the leader's exit, and the stream ends within a bound", async () => {
    const setsid = bin("setsid");
    const trickle = (pidFile: string): string => `${setsid} ${bin("sh")} -c 'trap "" PIPE; echo $$ > ${pidFile}; while :; do printf x 2>/dev/null; ${bin("sleep")} 0.1; done'`;
    const pidOf = async (file: string): Promise<string> => {
      for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(25);
      await sleep(50);
      return readFileSync(file, "utf8").trim();
    };
    // (1) the leader waits for it; timeout_s 2 must end the stream, and the escapee, in bounded time
    const p1 = path.join(dir, "esc1.pid");
    const t1 = Date.now();
    const timed = await (await open(a, { id: "esc1", timeout_s: 2, argv: [bin("sh"), "-c", `${trickle(p1)} & wait`] })).all();
    expect(exits(timed)).toMatchObject([{ timed_out: true }]);
    expect(Date.now() - t1).toBeLessThan(10_000);
    expect(["gone", "Z"]).toContain(await waitGone(await pidOf(p1)));
    // (2) the leader exits at once and the escapee keeps writing: the stream ends POST_EXIT_S after the exit, whatever arrives
    const p2 = path.join(dir, "esc2.pid");
    const t2 = Date.now();
    const left = await (await open(a, { id: "esc2", timeout_s: 60, argv: [bin("sh"), "-c", `${trickle(p2)} & ${bin("sleep")} 0.3; exit 0`] })).all();
    expect(exits(left)).toMatchObject([{ exit: 0, timed_out: false }]);
    expect(Date.now() - t2).toBeLessThan(9000);
    expect(["gone", "Z"]).toContain(await waitGone(await pidOf(p2)));
    // (3) kill reaches it: SIGKILL must end the command although the escapee is outside the group
    const p3 = path.join(dir, "esc3.pid");
    const s3 = await open(a, { id: "esc3", timeout_s: 60, argv: [bin("sh"), "-c", `${trickle(p3)} & wait`] });
    const escapee = await pidOf(p3);
    expect(await a.client.kill("esc3", "SIGKILL")).toMatchObject({ ok: true, signalled: true });
    const t3 = Date.now();
    expect(exits(await s3.all())).toMatchObject([{ signal: 9 }]);
    expect(Date.now() - t3).toBeLessThan(9000);
    expect(["gone", "Z"]).toContain(await waitGone(escapee));
  }, 60_000);

  it("a start that fails leaves no record: kill says unknown_id and the id can be used again", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["nul1", { argv: ["a\u0000b"] }],
      ["nul2", { argv: [bin("echo")], cwd: "/tmp\u0000x" }],
      ["nul3", { argv: [bin("echo")], env: { K: "v\u0000" } }],
      ["cwd1", { argv: [bin("echo")], cwd: 5 }],
      ["env1", { argv: [bin("echo")], env: { "A=B": "v" } }],
      ["ent1", { argv: ["/nonexistent/tool"] }],
      ["dir1", { argv: [bin("echo")], cwd: path.join(dir, "no-such-dir") }],
    ];
    const started = async (): Promise<number> => ((await a.client.counters()) as { agent: { exec: number } }).agent.exec;
    for (const [id, extra] of bad) {
      const before = await started();
      await (await open(a, { id, ...extra })).all();
      // what is refused before a command is registered is not counted as started; only a spawn that fails (a missing program or directory) is
      expect((await started()) - before, id).toBe(id.startsWith("ent") || id.startsWith("dir") ? 1 : 0);
      expect(await a.client.kill(id), id).toMatchObject({ ok: false, code: "unknown_id" });
      expect(await (await open(a, { id, argv: [bin("echo"), "again"] })).all(), id).toMatchObject([{ ev: "data" }, { ev: "exit", exit: 0 }]);
    }
  });

  it("a kill during start keeps the strongest signal: KILL is not weakened by a later TERM", async () => {
    const s = await open(slow, { id: "strong1", argv: [bin("sleep"), "30"] });
    await sleep(250);
    expect(await slow.client.kill("strong1", "SIGKILL")).toMatchObject({ signalled: true });
    expect(await slow.client.kill("strong1", "SIGTERM")).toMatchObject({ signalled: true });
    expect(await s.all()).toMatchObject([{ ev: "exit", signal: 9 }]);
  });

  it("keeps the last 256 finished commands, oldest first out, and never forgets a running one", async () => {
    const keep = await open(a, { id: "keep1", argv: [bin("sleep"), "60"] });
    for (let batch = 0; batch < 15; batch++) {
      await Promise.all(Array.from({ length: 20 }, async (_, i) => (await open(a, { id: `ev${batch * 20 + i}`, argv: [bin("sh"), "-c", "exit 0"] })).all()));
    }
    expect(await a.client.kill("ev0")).toMatchObject({ ok: false, code: "unknown_id" });
    expect(await a.client.kill("ev299")).toMatchObject({ ok: true, signalled: false, exit: 0 });
    expect(await a.client.kill("keep1", "SIGKILL")).toMatchObject({ ok: true, signalled: true });
    await keep.all();
  }, 60_000);

  it("never signals a command whose leader has been reaped", () => {
    const script = `import sys, subprocess, signal, time\nsys.path.insert(0, ${JSON.stringify(path.dirname(AGENT))})\nimport agent\np = subprocess.Popen([${JSON.stringify(bin("sleep"))}, "30"], start_new_session=True)\nentry = {"id": "u", "proc": p, "pending": None, "result": {"exit": 0}}\nagent.signal_group(entry, signal.SIGKILL)\ntime.sleep(0.4)\nprint("alive" if p.poll() is None else "dead")\np.kill()\n`;
    expect(spawnSync("python3", ["-I", "-c", script], { encoding: "utf8" }).stdout.trim()).toBe("alive");
  });

  it("kills a command whose reader stops reading for STALL_S", async () => {
    await ExecStream.open(stall.connect, { id: "stall1", argv: [bin("yes")] }).then((s) => live.push(s));
    await sleep(4000); // STALL_S is 1 s here; asking earlier would signal the command ourselves
    const r = await stall.client.kill("stall1");
    expect(r).toMatchObject({ ok: true, signalled: false, signal: 9 });
  }, 40_000);

  it("stops after GRACE_BYTES of output once the leader has gone, long before the wall-clock bound", async () => {
    const t0 = Date.now();
    const items = await (await open(a, { id: "grace1", argv: [bin("sh"), "-c", `${bin("yes")} & exit 0`] })).all();
    expect(exits(items)).toMatchObject([{ exit: 0 }]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("holds backpressure with 10 MB and a slow reader: the child blocks and the agent's memory stays flat", async () => {
    const marker = path.join(dir, "producer-done");
    const total = 10 << 20;
    const before = hwmKb(a.proc.pid!);
    const s = await open(a, { id: "big1", argv: [bin("sh"), "-c", `${bin("head")} -c ${total} /dev/zero; echo done > ${marker}`] });
    let got = 0;
    const first = (await s.next()) as Extract<StreamItem, { ev: "data" }>;
    got += first.data.length;
    // the reader goes quiet: the agent may hold one chunk, the kernel a few hundred KB, and the producer must still be stuck on its pipe
    await sleep(1500);
    expect(existsSync(marker), "the producer ran to the end while nobody read: output is being buffered").toBe(false);
    expect(hwmKb(a.proc.pid!) - before).toBeLessThan(3000);
    // a slow drain: a short pause every few frames
    let frames = 0;
    let largest = first.data.length;
    for (let e = await s.next(); e !== null && e.ev === "data"; e = await s.next()) {
      got += e.data.length;
      largest = Math.max(largest, e.data.length);
      if (++frames % 40 === 0) await sleep(20);
      if (got >= total) break;
    }
    expect(got).toBe(total);
    expect(largest, "a frame carries at most 64 KiB").toBeLessThanOrEqual(65536);
    expect(frames, "frames are read in large chunks, not byte-sized ones").toBeLessThan(600);
    expect(exits(await s.all())).toMatchObject([{ exit: 0, signal: null }]);
    expect(existsSync(marker)).toBe(true);
    expect(hwmKb(a.proc.pid!) - before, "the agent's peak memory grew with the output").toBeLessThan(3000);
  }, 60_000);

  it("kill signals the command's whole process group, and the exit arrives once on the stream", async () => {
    const pidFile = path.join(dir, "gc.pid");
    const bare = path.join(dir, "gc-bare.pid"); // a group member that cleared its environment: only the group signal reaches it
    const s = await open(a, { id: "k1", argv: [bin("sh"), "-c", `${bin("sleep")} 30 & echo $! > ${pidFile}; ${bin("env")} -i ${bin("sleep")} 30 & echo $! > ${bare}; wait`] });
    for (let i = 0; i < 100 && !(existsSync(pidFile) && existsSync(bare)); i++) await sleep(25);
    await sleep(100);
    const grandchild = readFileSync(pidFile, "utf8").trim();
    const bareChild = readFileSync(bare, "utf8").trim();
    expect(await a.client.kill("k1")).toEqual({ ok: true, signalled: true });
    const items = await s.all();
    expect(exits(items)).toMatchObject([{ exit: null, signal: 15, timed_out: false }]);
    expect(["gone", "Z"]).toContain(await waitGone(grandchild));
    expect(["gone", "Z"]).toContain(await waitGone(bareChild));
    // SIGKILL by name, on a command that ignores TERM
    const stubborn = await open(a, { id: "k2", env: HOST_PATH, argv: [bin("sh"), "-c", "trap '' TERM; echo up; while :; do sleep 1; done"] });
    expect(await stubborn.next()).toMatchObject({ ev: "data", data: Buffer.from("up\n") });
    expect(await a.client.kill("k2", "SIGTERM")).toMatchObject({ signalled: true });
    await sleep(300);
    expect(await a.client.kill("k2", "SIGKILL")).toMatchObject({ signalled: true });
    expect(exits(await stubborn.all())).toMatchObject([{ signal: 9 }]);
  });

  it("a kill that arrives while the command is still starting takes effect as soon as the process exists", async () => {
    const t0 = Date.now();
    const s = await open(slow, { id: "start1", argv: [bin("sleep"), "30"] });
    await sleep(250); // inside the 1 s the wrapper holds Popen back
    expect(await slow.client.kill("start1", "SIGKILL")).toEqual({ ok: true, signalled: true });
    expect(await s.all()).toMatchObject([{ ev: "exit", exit: null, signal: 9 }]);
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it("a kill after the command has ended signals nothing and returns the recorded result, every time", async () => {
    const s = await open(a, { id: "done1", argv: [bin("sh"), "-c", "exit 7"] });
    expect(exits(await s.all())).toMatchObject([{ exit: 7 }]);
    for (let i = 0; i < 2; i++) expect(await a.client.kill("done1")).toEqual({ ok: true, signalled: false, exit: 7, signal: null, timed_out: false });
    const killed = await open(a, { id: "done2", argv: [bin("sleep"), "30"] });
    await sleep(100);
    await a.client.kill("done2", "SIGKILL");
    await killed.all();
    expect(await a.client.kill("done2")).toEqual({ ok: true, signalled: false, exit: null, signal: 9, timed_out: false });
  });

  it("answers a closed error for an unknown, malformed or reused id and for a signal it does not allow", async () => {
    expect(await a.client.kill("never-ran")).toMatchObject({ ok: false, code: "unknown_id" });
    for (const id of ["", "a b", "x".repeat(65), "../etc", 7 as unknown as string]) expect(await a.client.kill(id), JSON.stringify(id)).toMatchObject({ ok: false, code: "bad_id" });
    expect(await a.client.kill("done1", "SIGSEGV")).toMatchObject({ ok: false, code: "bad_signal" });
    expect(await a.client.kill("done1", 9 as unknown as string)).toMatchObject({ ok: false, code: "bad_signal" });
    for (const id of [undefined, "", "a/b", "y".repeat(65)]) expect(await (await open(a, { id, argv: [bin("echo")] })).all(), String(id)).toMatchObject([{ ev: "error", header: { ok: false, code: "bad_id" } }]);
    const busy = await open(a, { id: "dup1", argv: [bin("sleep"), "30"] });
    await sleep(100);
    expect(await (await open(a, { id: "dup1", argv: [bin("echo")] })).all()).toMatchObject([{ ev: "error", header: { ok: false, code: "duplicate_id" } }]);
    expect(await (await open(a, { id: "done1", argv: [bin("echo")] })).all()).toMatchObject([{ ev: "error", header: { code: "duplicate_id" } }]);
    await a.client.kill("dup1", "SIGKILL");
    await busy.all();
  });

  it("kills the command when the host disconnects or stops reading, so nothing outlives its reader", async () => {
    const pidFile = path.join(dir, "yes.pid");
    const s = await open(a, { id: "gone1", argv: [bin("sh"), "-c", `echo $$ > ${pidFile}; exec ${bin("yes")}`] });
    await s.next();
    s.socket.destroy();
    // Wait on the real event (the command's process ends) without sending it anything: a poll by `kill` would itself
    // deliver SIGTERM and could win the race against the agent's own SIGKILL, so the recorded signal would be 15, not 9.
    const pid = readFileSync(pidFile, "utf8").trim();
    const deadline = Date.now() + 30_000;
    let state = stateOf(pid);
    while (!["gone", "Z"].includes(state) && Date.now() < deadline) {
      await sleep(25);
      state = stateOf(pid);
    }
    expect(["gone", "Z"]).toContain(state);
    // Now only the agent's record is awaited; the command is already dead, so these kills signal nothing live.
    let last: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      last = await a.client.kill("gone1");
      if (last["signalled"] === false) break;
      await sleep(25);
    }
    expect(last).toMatchObject({ ok: true, signalled: false, signal: 9 });
  });

  it("refuses malformed frames with an error and no process, and keeps serving", async () => {
    const raw = (bytes: Buffer): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        const s = net.createConnection(path.join(dir, "a.sock"));
        const got: Buffer[] = [];
        const timer = setTimeout(() => reject(new Error("no reply")), 3000);
        s.on("data", (c) => got.push(c));
        s.on("error", reject);
        s.on("close", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(got));
        });
        s.on("connect", () => {
          s.write(bytes);
          setTimeout(() => s.end(), 300);
        });
      });
    const framed = (body: Buffer): Buffer => Buffer.concat([Buffer.from([0, 0, 0, body.length]), body]);
    const length = (n: number): Buffer => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(n);
      return b;
    };
    const errorOf = (reply: Buffer): Record<string, unknown> => JSON.parse(reply.subarray(4, 4 + reply.readUInt32BE(0)).toString()) as Record<string, unknown>;
    // an oversized header is refused before its body is read
    for (const claimed of [(1 << 20) + 1, 0xffffffff]) expect(errorOf(await raw(length(claimed)))).toMatchObject({ ok: false, error: expect.stringContaining("header too large") });
    // not JSON, JSON that is not an object, a bad stdin size, argv of the wrong type, an env that is not a map
    expect(errorOf(await raw(framed(Buffer.from("not json"))))).toMatchObject({ ok: false });
    expect(errorOf(await raw(framed(Buffer.from("[1,2]"))))).toMatchObject({ ok: false });
    expect(errorOf(await raw(framed(Buffer.from(JSON.stringify({ op: "exec_stream", id: "m1", argv: ["x"], stdin_size: 2 ** 40 })))))).toMatchObject({ ok: false, error: "ValueError: bad size" });
    expect(errorOf(await raw(framed(Buffer.from(JSON.stringify({ op: "exec_stream", id: "m2", argv: [] })))))).toMatchObject({ ok: false, error: expect.stringContaining("argv") });
    expect(errorOf(await raw(framed(Buffer.from(JSON.stringify({ op: "exec_stream", id: "m3", argv: ["x", 7] })))))).toMatchObject({ ok: false, error: expect.stringContaining("argv") });
    expect(errorOf(await raw(framed(Buffer.from(JSON.stringify({ op: "exec_stream", id: "m4", argv: ["x"], env: ["a"] })))))).toMatchObject({ ok: false });
    // a refused request leaves no registered command behind: its id is free and unknown
    expect(await a.client.kill("m2")).toMatchObject({ code: "unknown_id" });
    expect(await a.client.kill("m3")).toMatchObject({ code: "unknown_id" });
    expect(await a.client.ping()).toMatchObject({ ok: true });
  });
});
