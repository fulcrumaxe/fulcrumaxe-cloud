import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MICROVM_PINNED_ENV, REVERSE_HOSTS } from "../../src/vm/sandboxd/guestEnv.js";

/**
 * The guest's egress relays (D#587 B-5b-RELAY): `relay.py`, run by the guest's init, carries a loopback connection to a host vsock port. Checked here on any machine with python3 with
 * the vsock connect replaced by a TCP connect to a local upstream (a wrapper patches `relay.connect_host`; everything else is the shipped code). The real vsock path, from the booted
 * image, is vmRelays.real.test.ts.
 */
const GUEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "microvm-image", "guest");
const hasPython = spawnSync("python3", ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"]).status === 0;

describe("init starts the relays", () => {
  const init = readFileSync(path.join(GUEST_DIR, "init"), "utf8");
  it("runs one supervised relay for each pair, after the loopback is up and before the init says it is done", () => {
    expect(init).toContain('for pair in "5253 5253" "80 5254"; do');
    expect(init).toContain("/usr/bin/python3 -I /usr/lib/fx/relay.py $pair");
    expect(init.indexOf("ip link set lo up")).toBeLessThan(init.indexOf("/usr/lib/fx/relay.py"));
    expect(init.indexOf("/usr/lib/fx/relay.py")).toBeLessThan(init.indexOf("FXMARK init_done"));
    // a relay that ends is started again
    expect(init).toMatch(/\( while :; do .*relay\.py \$pair; sleep 1; done \) &/);
  });
  it("maps exactly the reverse hosts to the loopback in the guest's hosts file", () => {
    const line = /^printf '(127\.0\.0\.1 localhost [^\\]*)\\n::1/m.exec(init)?.[1];
    expect(line).toBeDefined();
    expect((line as string).split(" ").slice(2)).toEqual([...REVERSE_HOSTS]);
  });
  it("the pairs are the ports the guest's environment names: 5253 for the proxy variables and port 80 for the model host and git", () => {
    expect(MICROVM_PINNED_ENV["HTTPS_PROXY"]).toBe("http://127.0.0.1:5253");
    expect(MICROVM_PINNED_ENV["ANTHROPIC_BASE_URL"]).toBe(`http://${REVERSE_HOSTS[0]}`); // no port, so 80
    expect(MICROVM_PINNED_ENV["GIT_CONFIG_VALUE_0"]).toBe("https://github.com/");
  });
});

describe.skipIf(!hasPython)("relay.py", () => {
  let dir: string;
  let procs: ChildProcess[];
  let servers: net.Server[];
  let sockets: Set<net.Socket>;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "fx-relay-"));
    procs = [];
    servers = [];
    sockets = new Set();
  });
  afterEach(async () => {
    for (const p of procs) p.kill("SIGKILL");
    for (const s of sockets) s.destroy();
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    rmSync(dir, { recursive: true, force: true });
  });

  const track = (s: net.Socket): net.Socket => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
    s.on("error", () => undefined); // fx-swallow-ok: a test socket the other side reset
    return s;
  };
  const upstream = async (onConn: (s: net.Socket) => void): Promise<number> => {
    const server = net.createServer((s) => onConn(track(s)));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as net.AddressInfo).port;
  };
  /** The shipped relay on a free loopback port, with `connect_host(vsock_port)` going to the TCP port `ups[vsock_port]`. Resolves with its port, its bound address and the vsock ports it was asked for. */
  async function startRelay(vsock: number, ups: Record<number, number>, maxConnections?: number): Promise<{ port: number; bound: string }> {
    const script = path.join(dir, `wrap-${String(procs.length)}.py`);
    writeFileSync(
      script,
      [
        "import json, os, socket, sys",
        `sys.path.insert(0, ${JSON.stringify(GUEST_DIR)})`,
        "import relay",
        `ups = ${JSON.stringify(ups)}`,
        "asked = []",
        "def connect(vport):",
        "    asked.append(vport)",
        "    return socket.create_connection(('127.0.0.1', ups[str(vport)]), timeout=5)",
        maxConnections === undefined ? "" : `relay.MAX_CONNECTIONS = ${String(maxConnections)}`,
        "srv = relay.listen(0)",
        "print(json.dumps({'addr': srv.getsockname()[0], 'port': srv.getsockname()[1]}), flush=True)",
        "import threading",
        "def report():",
        "    for line in sys.stdin:",
        "        print(json.dumps({'asked': asked}), flush=True)",
        "threading.Thread(target=report, daemon=True).start()",
        `relay.serve(srv, ${String(vsock)}, connect)`,
      ].join("\n"),
    );
    const p = spawn("python3", ["-I", script], { stdio: ["pipe", "pipe", "inherit"] });
    procs.push(p);
    const lines: string[] = [];
    let waiter: (() => void) | undefined;
    let buf = "";
    p.stdout!.on("data", (c: Buffer) => {
      buf += c.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
        waiter?.();
      }
    });
    const line = async (): Promise<Record<string, unknown>> => {
      while (lines.length === 0) await new Promise<void>((resolve) => void (waiter = resolve));
      return JSON.parse(lines.shift() as string) as Record<string, unknown>;
    };
    const first = await line();
    return { port: first["port"] as number, bound: first["addr"] as string };
  }
  async function askedPorts(relayProc: ChildProcess): Promise<number[]> {
    return new Promise((resolve) => {
      relayProc.stdout!.once("data", (c: Buffer) => resolve((JSON.parse(c.toString().trim().split("\n").pop() as string) as { asked: number[] }).asked));
      relayProc.stdin!.write("?\n");
    });
  }
  const dial = (port: number): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
      const s = track(net.connect(port, "127.0.0.1"));
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  const readAll = (s: net.Socket): Promise<Buffer> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      s.on("data", (c: Buffer) => chunks.push(c));
      s.once("close", () => resolve(Buffer.concat(chunks)));
    });

  it("listens on the loopback only, and carries bytes both ways to the vsock port it is for, a megabyte each way (the upstream sends back what it got)", async () => {
    const seen: Buffer[] = [];
    const up = await upstream((s) => {
      s.on("data", (c: Buffer) => {
        seen.push(c);
        s.write(c);
      });
    });
    const relay = await startRelay(5254, { 5254: up });
    expect(relay.bound).toBe("127.0.0.1");
    const client = await dial(relay.port);
    const payload = Buffer.alloc(1 << 20, "abcdefghij");
    const got: Buffer[] = [];
    client.on("data", (c: Buffer) => got.push(c));
    client.write(payload);
    while (Buffer.concat(got).length < payload.length) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Buffer.concat(seen).equals(payload)).toBe(true);
    expect(Buffer.concat(got).equals(payload)).toBe(true);
    expect(await askedPorts(procs[0] as ChildProcess)).toEqual([5254]);
    client.destroy();
  }, 30_000);

  it("passes a half-close on: the end of a request reaches the upstream, which then answers and ends", async () => {
    const up = await upstream((s) => {
      const chunks: Buffer[] = [];
      s.on("data", (c: Buffer) => chunks.push(c));
      s.once("end", () => s.end(`got:${Buffer.concat(chunks).toString()}`));
    });
    const relay = await startRelay(5253, { 5253: up });
    const client = await dial(relay.port);
    const answer = readAll(client);
    client.end("request");
    expect((await answer).toString()).toBe("got:request");
  }, 20_000);

  it("closes the client at once when the host cannot be reached, and keeps serving", async () => {
    const live = await upstream((s) => void s.end("alive"));
    const relayDead = await startRelay(5254, { 5254: await closedPort() });
    const client = await dial(relayDead.port);
    expect((await readAll(client)).length).toBe(0);
    const relayLive = await startRelay(5254, { 5254: live });
    expect((await readAll(await dial(relayLive.port))).toString()).toBe("alive");
    // the same relay still answers after a failed connect
    expect((await readAll(await dial(relayLive.port))).toString()).toBe("alive");
  }, 20_000);

  it("closes a connection over its cap and serves again when one ends", async () => {
    const held: net.Socket[] = [];
    const up = await upstream((s) => void held.push(s));
    const relay = await startRelay(5254, { 5254: up }, 2);
    const a = await dial(relay.port);
    const b = await dial(relay.port);
    await new Promise((resolve) => setTimeout(resolve, 300)); // both are accepted and holding their slot
    const c = await dial(relay.port);
    expect((await readAll(c)).length).toBe(0); // closed by the relay, never reached the upstream
    expect(held).toHaveLength(2);
    a.destroy();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const d = await dial(relay.port);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(held).toHaveLength(3);
    b.destroy();
    d.destroy();
  }, 20_000);

  it("refuses to serve a pair other than the two it is for, so it can never be asked to reach another host port", () => {
    for (const args of [["8080", "5254"], ["5253", "5254"], ["80", "5253"], ["80"], ["x", "y"], ["80", "5254", "extra"], []]) {
      const r = spawnSync("python3", ["-I", path.join(GUEST_DIR, "relay.py"), ...args], { encoding: "utf8", timeout: 10_000 });
      expect({ args, status: r.status }).toEqual({ args, status: 2 });
    }
  });
});

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}
