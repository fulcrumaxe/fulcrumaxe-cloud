import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { socketTmpRoot } from "../../helpers/tmpRoot.js";
import { vmAssetName, type BootDigests, type TargetListing } from "../../../src/vm/bootGate.js";
import { agentAtVsockDir, type GuestAgent } from "../../../src/vm/sandboxd/guestAgent.js";
import { createHelperClient } from "../../../src/vm/sandboxd/helperClient.js";
import { Sandboxd, type SandboxdDeps } from "../../../src/vm/sandboxd/sandboxd.js";

/** Test doubles for B-2b-iii: a helper that speaks the real frames over a real Unix socket, and a guest agent that speaks the real agent protocol. */
const cleanups: Array<() => void> = [];
export const runCleanups = (): void => {
  for (const fn of cleanups.splice(0).reverse()) fn();
};
export const scratch = (): string => {
  const dir = mkdtempSync(path.join(socketTmpRoot(), "fxd-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Reads length-prefixed frames off a socket. */
function frames(sock: net.Socket, onFrame: (header: Record<string, unknown>, body: Buffer) => void): void {
  let buf = Buffer.alloc(0);
  sock.on("data", (c) => {
    buf = Buffer.concat([buf, c]);
    for (;;) {
      if (buf.length < 4) return;
      const n = buf.readUInt32BE(0);
      if (buf.length < 4 + n) return;
      const header = JSON.parse(buf.subarray(4, 4 + n).toString()) as Record<string, unknown>;
      const size = Number(header["size"] ?? header["stdin_size"] ?? 0);
      if (buf.length < 4 + n + size) return;
      const body = buf.subarray(4 + n, 4 + n + size);
      buf = buf.subarray(4 + n + size);
      onFrame(header, body);
    }
  });
}

export interface FakeAgent {
  /** argv of every exec the agent was asked to run, in order. */
  execs: string[][];
  pings: number;
  /** Holds every accepted connection until released: a guest that is slow to answer. */
  gate?: Promise<void>;
  close(): void;
}

/** A guest agent on `<dir>/v.sock`, behind Firecracker's `CONNECT` handshake. It runs exec for real (a new session, as agent.py does) and answers when the process ends. */
export function startFakeAgent(dir: string): FakeAgent {
  const children = new Set<ChildProcess>();
  const agent: FakeAgent = { execs: [], pings: 0, close: () => undefined };
  const server = net.createServer((sock) => {
    sock.on("error", () => undefined);
    let pre = "";
    const onHello = (c: Buffer): void => {
      pre += c.toString("latin1");
      const end = pre.indexOf("\n");
      if (end < 0) return;
      sock.off("data", onHello);
      if (pre.slice(0, end) !== "CONNECT 5252") return void sock.destroy();
      sock.write("OK 1073741824\n");
      frames(sock, (header, body) => void serve(sock, header, body));
      if (pre.length > end + 1) sock.emit("data", Buffer.from(pre.slice(end + 1), "latin1"));
    };
    sock.on("data", onHello);
  });
  const send = (sock: net.Socket, header: object, ...blobs: Buffer[]): void => {
    const body = Buffer.from(JSON.stringify(header));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    if (!sock.destroyed) sock.write(Buffer.concat([len, body, ...blobs]));
  };
  async function serve(sock: net.Socket, header: Record<string, unknown>, body: Buffer): Promise<void> {
    await agent.gate;
    if (header["op"] === "ping") {
      agent.pings++;
      return send(sock, { ok: true, proto: 1 });
    }
    if (header["op"] !== "exec") return send(sock, { ok: false, error: "unknown op" });
    const argv = header["argv"] as string[];
    agent.execs.push(argv);
    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, cwd: typeof header["cwd"] === "string" ? header["cwd"] : "/" });
    children.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.stdin.end(body);
    child.on("error", () => send(sock, { ok: true, exit: 127 }));
    child.on("close", (code, signal) => {
      children.delete(child);
      const o = Buffer.concat(out);
      const e = Buffer.concat(err);
      const num = signal === null ? null : ({ SIGTERM: 15, SIGKILL: 9 } as Record<string, number>)[signal] ?? 1;
      send(sock, { ok: true, exit: code, signal: num, stdout_size: o.length, stderr_size: e.length }, o, e);
    });
  }
  server.listen(path.join(dir, "v.sock"));
  agent.close = () => {
    server.close();
    for (const argv of agent.execs) if (argv[3] === "sh" && argv[4]?.startsWith("/tmp/fx-cmd-")) rmSync(argv[4], { force: true });
    for (const c of children) {
      try {
        process.kill(-(c.pid as number), "SIGKILL");
      } catch {
        // already gone
      }
    }
  };
  cleanups.push(agent.close);
  return agent;
}

export interface FakeHelper {
  sock: string;
  /** Every request frame the helper received, parsed. */
  frames: Array<Record<string, unknown>>;
  /** Hold the answer to `prepare` until this resolves. */
  holdPrepare?: Promise<void>;
  /** Answer this verb with a refusal code. */
  refuse: Map<string, string>;
  /** Replace the next reply of this verb with these raw bytes. */
  raw: Map<string, string>;
  /** Called after `start` for an id, once its directory exists. */
  onStart: (id: string, dir: string) => void;
  /** Chmod/replace hooks so a test can make the vsock directory wrong. */
  mangle: (id: string, dir: string) => string;
  entries: Map<string, { dir: string }>;
}

export function startFakeHelper(root: string, gid = process.getgid?.() ?? 1000): FakeHelper {
  const h: FakeHelper = { sock: path.join(root, "helper.sock"), frames: [], refuse: new Map(), raw: new Map(), onStart: () => undefined, mangle: (_id, dir) => dir, entries: new Map() };
  const dirOf = (id: string): string => path.join(root, "vsock", id);
  const server = net.createServer((sock) => {
    sock.on("error", () => undefined);
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      const end = buf.indexOf("\n");
      if (end < 0) return;
      const frame = JSON.parse(buf.slice(0, end)) as Record<string, unknown>;
      buf = "";
      h.frames.push(frame);
      void answer(frame).then((line) => sock.end(line));
    });
  });
  async function answer(f: Record<string, unknown>): Promise<string> {
    const verb = String(f["verb"]);
    if (verb === "prepare") await h.holdPrepare;
    const raw = h.raw.get(verb);
    if (raw !== undefined) return raw;
    const code = h.refuse.get(verb);
    if (code !== undefined) return `${JSON.stringify({ ok: false, protocol: 1, code })}\n`;
    const id = String(f["sandbox_id"]);
    if (verb === "prepare" || verb === "start") {
      const dir = dirOf(id);
      if (verb === "prepare") {
        mkdirSync(dir, { recursive: true });
        chmodSync(dir, 0o710);
        h.entries.set(id, { dir });
      } else {
        if (!h.entries.has(id)) return `${JSON.stringify({ ok: false, protocol: 1, code: "unknown_sandbox" })}\n`;
        h.onStart(id, dir);
      }
      return `${JSON.stringify({ ok: true, protocol: 1, vsock_dir: h.mangle(id, dir), sandbox_gid: gid })}\n`;
    }
    if (verb === "destroy") {
      if (!h.entries.delete(id)) return `${JSON.stringify({ ok: false, protocol: 1, code: "unknown_sandbox" })}\n`;
      return `${JSON.stringify({ ok: true, protocol: 1 })}\n`;
    }
    const sandboxes = [...h.entries].map(([sandbox_id, e]) => ({ sandbox_id, vsock_dir: e.dir, sandbox_gid: gid, created: 1_700_000_000 }));
    return `${JSON.stringify({ ok: true, protocol: 1, sandboxes })}\n`;
  }
  server.listen(h.sock);
  cleanups.push(() => server.close());
  return h;
}

export const connectUnix = (file: string) => (): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const s = net.createConnection(file);
    s.once("error", reject);
    s.once("connect", () => resolve(s));
  });

const DIGESTS: BootDigests = { kernel: "a".repeat(64), rootfs: "b".repeat(64), agent: "c".repeat(64) };
export const listing = (over: Partial<BootDigests> = {}): TargetListing => ({
  ok: true,
  paths: (["kernel", "rootfs", "agent"] as const).map((k) => `vm-fx-agent-0123456789ab/${vmAssetName(k, "amd64", over[k] ?? DIGESTS[k])}`),
}) as TargetListing;

export interface Rig {
  daemon: Sandboxd;
  helper: FakeHelper;
  agents: Map<string, FakeAgent>;
  /** Delays every guest connection of one sandbox until released. */
  deps: SandboxdDeps;
}

export function makeRig(over: { listing?: TargetListing; euid?: number; agentFor?: (dir: string) => GuestAgent; gid?: number; extra?: Partial<SandboxdDeps> } = {}): Rig {
  const root = scratch();
  mkdirSync(path.join(root, "vsock"));
  const helper = startFakeHelper(root, over.gid);
  const agents = new Map<string, FakeAgent>();
  helper.onStart = (id, dir) => {
    if (!agents.has(id)) agents.set(id, startFakeAgent(dir));
  };
  const deps: SandboxdDeps = {
    euid: over.euid ?? process.geteuid?.(),
    helper: createHelperClient(connectUnix(helper.sock), 5000),
    boot: { listTargets: async () => over.listing ?? listing(), facts: () => ({ arch: "amd64", digests: DIGESTS }) },
    inspectDir: (dir) => {
      try {
        const st = lstatSync(dir);
        return { isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink(), uid: st.uid, gid: st.gid, mode: st.mode };
      } catch {
        return undefined;
      }
    },
    agentFor: over.agentFor ?? agentAtVsockDir,
    now: () => 1_700_000_000,
    bootTimeoutMs: 3000,
    pollMs: 20,
    ...over.extra,
  };
  const daemon = new Sandboxd(deps);
  return { daemon, helper, agents, deps };
}

/** A vsock proxy that accepts and never answers CONNECT: a guest that is not booted, or wedged. */
export function startSilentProxy(): string {
  const file = path.join(scratch(), "silent.sock");
  const server = net.createServer((s) => s.on("error", () => undefined)).listen(file);
  cleanups.push(() => server.close());
  return file;
}
