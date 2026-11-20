import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unixSocketsRefused } from "../helpers/needsHostSockets.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";
import { AgentClient, ExecStream, viaUnixSocket, type StreamItem } from "./helpers/agentClient.js";

/**
 * D#587 B-5a-RT-1, the two guest-side faults the first real-VM run found, checked against the agent's own code on a Unix socket (`--unix`):
 * (a) every byte the leader wrote is framed before the exit frame, however slowly the host reads; (b) a command is interrupted by SIGINT even
 * when the agent itself was started with SIGINT ignored, which is what a non-interactive shell does to a command it starts with `&`.
 */
const GUEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "microvm-image", "guest");
const AGENT = process.env["FX_TEST_AGENT_PY"] ?? path.join(GUEST_DIR, "agent.py");
const hasPython = spawnSync("python3", ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"]).status === 0;
const hasBash = spawnSync("bash", ["-c", "exit 0"]).status === 0;
const skip = !hasPython || !hasBash || unixSocketsRefused();
const bin = (name: string): string => {
  const found = (process.env["PATH"] ?? "").split(path.delimiter).map((d) => path.join(d, name)).find((f) => existsSync(f));
  if (found === undefined) throw new Error(`${name} is not on PATH`);
  return found;
};
const HOST_PATH = { PATH: process.env["PATH"] ?? "" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const exits = (items: StreamItem[]): StreamItem[] => items.filter((i) => i.ev === "exit");

describe.skipIf(skip)("agent.py streaming exec: output after the leader exits, and SIGINT", () => {
  let dir: string;
  let proc: ChildProcess;
  let client: AgentClient;
  let connect: ReturnType<typeof viaUnixSocket>;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(socketTmpRoot(), "fx-stream-exit-"));
    const sock = path.join(dir, "a.sock");
    const wrapper = path.join(dir, "a.py");
    writeFileSync(wrapper, `import sys\nsys.path.insert(0, ${JSON.stringify(path.dirname(AGENT))})\nimport agent\nsys.argv = ["agent.py", "--unix", ${JSON.stringify(sock)}]\nagent.main()\n`);
    // The way init starts the agent: `&` from a non-interactive bash, which leaves SIGINT and SIGQUIT ignored for it.
    proc = spawn("bash", ["-c", `python3 -I ${JSON.stringify(wrapper)} & wait`], { stdio: "ignore", detached: true });
    for (let i = 0; i < 200 && !existsSync(sock); i++) await sleep(25);
    connect = viaUnixSocket(sock);
    client = new AgentClient(connect);
  });
  afterAll(() => {
    try {
      process.kill(-(proc.pid ?? 0), "SIGKILL");
    } catch {
      proc.kill("SIGKILL"); // fx-swallow-ok: the group may already be gone
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("frames every byte the leader wrote before the exit frame, even when the host reads far slower than the post-exit bound", async () => {
    // The leader enlarges its stdout and stderr pipes to 1 MiB each, fills both, and exits at once: all 2 MiB is in the pipes when the leader is
    // seen gone, more than the socket buffers between the agent and the host can take. The host takes 400 ms per frame, so draining takes about
    // 13 s, far longer than POST_EXIT_S (5 s), and the output is above GRACE_BYTES.
    const per = 1 << 20;
    const total = 2 * per;
    const code = `import fcntl,os\nfor fd in (1,2):\n    fcntl.fcntl(fd,1031,${per})\n    os.write(fd,b"x"*${per})\n`;
    const s = await ExecStream.open(connect, { id: "late1", argv: [bin("python3"), "-I", "-c", code], timeout_s: 60 });
    const items: StreamItem[] = [];
    try {
      for (let e = await s.next(); e !== null; e = await s.next()) {
        items.push(e);
        if (e.ev === "exit") break;
        await sleep(400);
      }
    } finally {
      s.socket.destroy();
    }
    const got = items.filter((i) => i.ev === "data").reduce((n, i) => n + (i as { data: Buffer }).data.length, 0);
    expect(got, JSON.stringify(items.filter((i) => i.ev !== "data"))).toBe(total);
    expect(exits(items)).toMatchObject([{ exit: 0, signal: null, timed_out: false }]);
    expect(items[items.length - 1]!.ev).toBe("exit");
  }, 90_000);

  it("still cuts a background process that keeps writing after the leader's own output is framed", async () => {
    const started = Date.now();
    const s = await ExecStream.open(connect, { id: "late2", env: HOST_PATH, argv: [bin("sh"), "-c", `echo mine; ${bin("yes")} >&2 & exit 0`], timeout_s: 60 });
    const items = await s.all();
    expect(exits(items)).toMatchObject([{ exit: 0 }]);
    expect(Buffer.concat(items.filter((i) => i.ev === "data" && i.stream === "stdout").map((i) => (i as { data: Buffer }).data)).toString()).toBe("mine\n");
    expect(Date.now() - started).toBeLessThan(6000);
  }, 30_000);

  it("kill(SIGINT) interrupts a command although the agent was started with SIGINT ignored", async () => {
    const s = await ExecStream.open(connect, { id: "int1", env: HOST_PATH, argv: [bin("sh"), "-c", `echo ready; ${bin("sleep")} 30`], timeout_s: 60 });
    expect(await s.next()).toMatchObject({ ev: "data", data: Buffer.from("ready\n") });
    expect(await client.kill("int1", "SIGINT")).toMatchObject({ ok: true, signalled: true });
    const started = Date.now();
    const rest = await s.all();
    // sh dies of the signal its `sleep` child died of or of its own: either way the command ends well before sleep's 30 s
    expect(exits(rest)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(exits(rest)[0]).toMatchObject({ timed_out: false });
  }, 30_000);

  it("a trap on SIGINT in the command runs (the signal was not left ignored for it)", async () => {
    const s = await ExecStream.open(connect, { id: "int2", env: HOST_PATH, argv: [bin("sh"), "-c", `trap 'echo got-int; exit 7' INT; echo ready; while :; do ${bin("sleep")} 0.05; done`], timeout_s: 60 });
    expect(await s.next()).toMatchObject({ ev: "data", data: Buffer.from("ready\n") });
    await client.kill("int2", "SIGINT");
    const rest = await s.all();
    expect(Buffer.concat(rest.filter((i) => i.ev === "data").map((i) => (i as { data: Buffer }).data)).toString()).toContain("got-int");
    expect(exits(rest)).toMatchObject([{ exit: 7, signal: null }]);
  }, 30_000);
});
