import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentClient, viaUnixSocket } from "./helpers/agentClient.js";

/**
 * The in-guest agent and init, checked on any machine with python3: the agent's own code, listening on a Unix socket instead of vsock
 * (`--unix`). The vsock transport itself, the host-only peer check and the real guest are covered by vmBoot.real.test.ts.
 */
const GUEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "microvm-image", "guest");
/** The agent's PATH is the guest's; on this machine tools live elsewhere, so a test names them by absolute path. */
const bin = (name: string): string => {
  const found = (process.env["PATH"] ?? "").split(path.delimiter).map((d) => path.join(d, name)).find((f) => existsSync(f));
  if (found === undefined) throw new Error(`${name} is not on PATH`);
  return found;
};
const hasPython = spawnSync("python3", ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"]).status === 0;

describe("the guest files", () => {
  it("the init is a bash script that parses and is executable, and sets up what the probes check", () => {
    const init = readFileSync(path.join(GUEST_DIR, "init"), "utf8");
    expect(spawnSync("bash", ["-n", path.join(GUEST_DIR, "init")]).status).toBe(0);
    expect(statSync(path.join(GUEST_DIR, "init")).mode & 0o111).not.toBe(0);
    for (const needle of ["mount -t proc", "mount -t sysfs", "devtmpfs", "ln -sfn /proc/self/fd /dev/fd", "/etc/hosts", "ip link set lo up"]) expect(init, needle).toContain(needle);
    // no network bring-up of any kind: there is no device to bring up
    expect(init).not.toMatch(/dhclient|ifconfig|ip addr|ip route|resolv\.conf/);
  });
});

describe.skipIf(!hasPython)("agent.py over a Unix socket", () => {
  let dir: string;
  let proc: ChildProcess;
  let client: AgentClient;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "fx-agent-"));
    const sock = path.join(dir, "a.sock");
    proc = spawn("python3", ["-I", path.join(GUEST_DIR, "agent.py"), "--unix", sock], { stdio: "ignore" });
    for (let i = 0; i < 200 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 25));
    client = new AgentClient(viaUnixSocket(sock));
  });
  afterAll(() => {
    proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers ping and counters", async () => {
    expect(await client.ping()).toEqual({ ok: true, proto: 1 });
    const c = (await client.counters()) as { ok: boolean; uptime_s: number; mem_kb: Record<string, number>; cpu_ticks: number[]; nics: string[]; agent: { requests: number } };
    expect(c).toMatchObject({ ok: true });
    expect(c.uptime_s).toBeGreaterThan(0);
    expect(c.mem_kb["MemTotal"]).toBeGreaterThan(0);
    expect(c.cpu_ticks.length).toBeGreaterThanOrEqual(4);
    expect(c.nics).toContain("lo");
    expect(c.agent.requests).toBeGreaterThan(0);
  });

  it("`echo ok` returns ok with exit 0; exit codes, stderr, stdin, env and the working directory come through", async () => {
    expect(await client.exec([bin("echo"), "ok"])).toMatchObject({ exit: 0, stdout: "ok\n", stderr: "" });
    expect(await client.exec([bin("sh"), "-c", "echo e >&2; exit 3"])).toMatchObject({ exit: 3, stdout: "", stderr: "e\n" });
    expect((await client.exec([bin("cat")], { stdin: Buffer.from("piped") })).stdout).toBe("piped");
    expect((await client.exec([bin("pwd")], { cwd: dir })).stdout).toBe(`${dir}\n`);
    // the caller's environment is not inherited: only the fixed base and what the request names
    process.env["FX_LEAK_CHECK"] = "leak";
    const seen = (await client.exec([bin("env")], { env: { FX_X: "1" } })).stdout.split("\n").sort();
    expect(seen).toEqual(["FX_X=1", "HOME=/vercel", "LANG=C.UTF-8", "PATH=/opt/fx/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", ""].sort());
  });

  it("reports a program that does not exist, a signal, and a timeout, without hanging", async () => {
    expect(await client.exec(["/nonexistent/tool"])).toMatchObject({ exit: 127 });
    expect((await client.exec([bin("sh"), "-c", "kill -9 $$"])).header).toMatchObject({ exit: null, signal: 9 });
    expect((await client.exec([bin("sleep"), "30"], { timeoutS: 0.3 })).header).toMatchObject({ exit: null, timed_out: true });
  });

  it("round-trips files byte for byte at 0 B, 1 B and 8 MiB, and keeps the mode", async () => {
    for (const size of [0, 1, 8 << 20]) {
      const data = randomBytes(size);
      const file = path.join(dir, "nested", `f${size}`);
      await client.put(file, data, 0o600);
      expect(Buffer.compare(await client.get(file), data), `${size} bytes`).toBe(0);
    }
    expect(statSync(path.join(dir, "nested", "f1")).mode & 0o777).toBe(0o600);
  });

  it("refuses a frame header claiming more than 1 MiB before reading any of it", async () => {
    // Send only the 4-byte length (4 GiB - 1) and no body. An agent that read the body first would wait for it forever; this one must
    // answer at once with a fixed error, having allocated nothing for it.
    const sock = path.join(dir, "a.sock");
    for (const claimed of [(1 << 20) + 1, 0xffffffff]) {
      const reply = await new Promise<Buffer>((resolve, reject) => {
        const s = net.createConnection(sock);
        const got: Buffer[] = [];
        const timer = setTimeout(() => reject(new Error("no reply: the agent is waiting for the oversized header")), 3000);
        s.on("data", (c) => got.push(c));
        s.on("error", reject);
        s.on("close", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(got));
        });
        s.on("connect", () => {
          const len = Buffer.alloc(4);
          len.writeUInt32BE(claimed);
          s.write(len);
          // the agent ends its side after replying; end ours so it does not wait on us
          setTimeout(() => s.end(), 300);
        });
      });
      const n = reply.readUInt32BE(0);
      expect(JSON.parse(reply.subarray(4, 4 + n).toString())).toMatchObject({ ok: false, error: expect.stringContaining("header too large") });
    }
    expect(await client.ping()).toMatchObject({ ok: true });
  });

  it("kills the whole process group on timeout, and caps what it buffers", async () => {
    // a grandchild that keeps stdout open must not hold the connection past the timeout
    const started = Date.now();
    const pidFile = path.join(dir, "grandchild.pid");
    const r = await client.exec([bin("sh"), "-c", `${bin("sleep")} 30 & echo $! > ${pidFile}; wait`], { timeoutS: 0.5 });
    expect(r.header).toMatchObject({ exit: null, timed_out: true });
    expect(Date.now() - started).toBeLessThan(10_000);
    // the grandchild is dead too (gone, or a zombie waiting to be reaped), not left running past the timeout
    const pid = readFileSync(pidFile, "utf8").trim();
    const stateOf = (): string => {
      try {
        return /^\d+ \(.*\) (\S)/.exec(readFileSync(path.join("/", "proc", pid, "stat"), "utf8"))?.[1] ?? "gone";
      } catch {
        return "gone"; // no such process
      }
    };
    // SIGKILL is delivered asynchronously, so under load the process can still show as running for a moment: wait up to 5 s for it to
    // go. One that is still alive at the deadline is a failure.
    const deadline = Date.now() + 5000;
    let state = stateOf();
    while (!["gone", "Z"].includes(state) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      state = stateOf();
    }
    expect(["gone", "Z"]).toContain(state);
    // 20 MiB on stdout comes back cut at 16 MiB and flagged
    const big = await client.exec([bin("head"), "-c", String(20 << 20), "/dev/zero"]);
    expect(big.header).toMatchObject({ exit: 0, truncated: true, stdout_size: 16 << 20 });
  });

  it("refuses what it must, with an error and no effect", async () => {
    await expect(client.put("relative/path", Buffer.from("x"))).rejects.toThrow(/absolute/);
    await expect(client.get(path.join(dir, "missing"))).rejects.toThrow(/FileNotFound/);
    await expect(client.exec([])).rejects.toThrow(/argv/);
    await expect(client.exec(["echo", 7 as unknown as string])).rejects.toThrow(/argv/);
    expect((await client.request({ op: "nope" })).header).toMatchObject({ ok: false, error: "unknown op" });
    expect((await client.request({ op: "exec", argv: ["x"], env: ["not", "a", "map"] })).header).toMatchObject({ ok: false });
    // a size over the cap is refused before any byte of it is read or allocated
    expect((await client.request({ op: "put", path: path.join(dir, "big"), size: 2 ** 40 })).header).toMatchObject({ ok: false });
    expect(existsSync(path.join(dir, "big"))).toBe(false);
    // the agent still serves after all of that
    expect(await client.ping()).toMatchObject({ ok: true });
  });
});
