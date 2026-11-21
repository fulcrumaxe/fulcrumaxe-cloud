import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { socketTmpRoot } from "../../helpers/tmpRoot.js";
import { removeTree } from "../../helpers/tempTree.js";
import { vmAssetName, type BootDigests, type TargetListing } from "../../../src/vm/bootGate.js";
import { agentAtVsockDir, type GuestAgent } from "../../../src/vm/sandboxd/guestAgent.js";
import { createHelperClient } from "../../../src/vm/sandboxd/helperClient.js";
import { fdInspectDir, hasForeignListener, realFdOps, removeOwnVsockSocket, type HostFacts } from "../../../src/vm/sandboxd/vsockFd.js";
import { TeardownError, type ProcessLister } from "../../../src/vm/sandboxd/teardown.js";
import { Sandboxd, type SandboxdDeps } from "../../../src/vm/sandboxd/sandboxd.js";

/** Test doubles for B-2b-iii: a helper that speaks the real frames over a real Unix socket, and a guest agent that speaks the real agent protocol. */
const cleanups: Array<() => void> = [];
export const runCleanups = (): void => {
  for (const fn of cleanups.splice(0).reverse()) fn();
};
export const onCleanup = (fn: () => void): void => void cleanups.push(fn);
export const scratch =(): string => {
  const dir = mkdtempSync(path.join(socketTmpRoot(), "fxd-"));
  cleanups.push(() => removeTree(dir));
  return dir;
};

/** Reads length-prefixed frames off a socket. */
function frames(sock: net.Socket, onFrame: (header: Record<string, unknown>, body: Buffer) => void): void {
  // chunks are joined only once a whole frame can be present: a 64 MiB body must not be re-copied for every 64 KiB that arrives
  let chunks: Buffer[] = [];
  let have = 0;
  let need = 4;
  sock.on("data", (c) => {
    chunks.push(c);
    have += c.length;
    while (have >= need) {
      const buf = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
      chunks = [buf];
      const n = buf.readUInt32BE(0);
      if (buf.length < 4 + n) return void (need = 4 + n);
      const header = JSON.parse(buf.subarray(4, 4 + n).toString()) as Record<string, unknown>;
      const size = Number(header["size"] ?? header["stdin_size"] ?? 0);
      if (buf.length < 4 + n + size) return void (need = 4 + n + size);
      const body = buf.subarray(4 + n, 4 + n + size);
      const rest = buf.subarray(4 + n + size);
      chunks = rest.length > 0 ? [rest] : [];
      have = rest.length;
      need = 4;
      onFrame(header, body);
    }
  });
}

export interface FakeAgent {
  /** argv of every exec the agent was asked to run, in order. */
  execs: string[][];
  pings: number;
  /** The op of every request, in order: a refused path must leave this empty. */
  ops: string[];
  /** Files `put` stored, as agent.py would write them (mode already masked to 0o777). */
  files: Map<string, { data: Buffer; mode: number }>;
  /** The newest connection, so a test can look at its write buffer. */
  lastSock?: net.Socket;
  /** Replaces the `get` reply: raw bytes after a frame that names `size`. */
  getReply?: (path: string) => { header: object; blobs: Buffer[] } | undefined;
  /** Holds every accepted connection until released: a guest that is slow to answer. */
  gate?: Promise<void>;
  /** The token the guest holds (a `token_put` stored it, a `token_wipe` removed it), and the `token` flag of every exec. */
  token?: Buffer;
  execTokenFlags: boolean[];
  /** Answers `token_put` / `token_wipe` with the agent's refusal. */
  refuseTokenPut?: boolean;
  /** Holds every `token_put` until this resolves: a slow delivery. */
  holdTokenPut?: Promise<void>;
  refuseTokenWipe?: boolean;
  close(): void;
}

/** A guest agent on `<dir>/v.sock`, behind Firecracker's `CONNECT` handshake. It runs exec for real (a new session, as agent.py does) and answers when the process ends. */
/** The places the guest image mounts as tmpfs (infra/microvm-image/guest/init); everything else is on the read-only root disk. */
const GUEST_WRITABLE = ["/tmp", "/var/tmp", "/var/log", "/var/cache", "/run", "/dev/shm", "/vercel"];

export function startFakeAgent(dir: string, opts: { readOnlyRoot?: boolean } = {}): FakeAgent {
  const children = new Set<ChildProcess>();
  const agent: FakeAgent = { execs: [], execTokenFlags: [], pings: 0, ops: [], files: new Map(), close: () => undefined };
  const server = net.createServer((sock) => {
    sock.on("error", () => undefined);
    agent.lastSock = sock;
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
    agent.ops.push(String(header["op"]));
    await agent.gate;
    if (header["op"] === "ping") {
      agent.pings++;
      return send(sock, { ok: true, proto: 1 });
    }
    // agent.py's put and get: the whole body is held, the path must be absolute, the mode is masked, and a body over MAX_BYTES is not read
    if (header["op"] === "put") {
      const p = String(header["path"]);
      if (!p.startsWith("/")) return send(sock, { ok: false, error: "ValueError: path must be absolute" });
      if (opts.readOnlyRoot === true && !GUEST_WRITABLE.some((w) => p.startsWith(`${w}/`))) return send(sock, { ok: false, error: `OSError: [Errno 30] Read-only file system: ${JSON.stringify(path.posix.dirname(p))}` });
      agent.files.set(p, { data: Buffer.from(body), mode: Number(header["mode"] ?? 0o644) & 0o777 });
      return send(sock, { ok: true });
    }
    if (header["op"] === "get") {
      const p = String(header["path"]);
      const custom = agent.getReply?.(p);
      if (custom !== undefined) return send(sock, custom.header, ...custom.blobs);
      const file = agent.files.get(p);
      if (file === undefined) return send(sock, { ok: false, error: "FileNotFoundError" });
      return send(sock, { ok: true, size: file.data.length }, file.data);
    }
    if (header["op"] === "token_put") {
      await agent.holdTokenPut;
      if (agent.refuseTokenPut === true) return send(sock, { ok: false, code: "secret_dir_unsafe" });
      agent.token = Buffer.from(body);
      return send(sock, { ok: true });
    }
    if (header["op"] === "token_wipe") {
      if (agent.refuseTokenWipe === true) return send(sock, { ok: false, code: "holders_remain" });
      const removed = agent.token !== undefined;
      agent.token = undefined;
      return send(sock, { ok: true, removed, killed: 0 });
    }
    if (header["op"] !== "exec") return send(sock, { ok: false, error: "unknown op" });
    const argv = header["argv"] as string[];
    agent.execs.push(argv);
    agent.execTokenFlags.push(header["token"] === true);
    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, cwd: typeof header["cwd"] === "string" ? header["cwd"] : "/" });
    children.add(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    // A command that exits (or never reads) before its stdin is written closes the pipe: the write then fails with EPIPE
    // on this stream, which has no other listener. agent.py ignores the same error, so the fake does too.
    child.stdin.on("error", () => undefined);
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
  entries: Map<string, { dir: string; running?: boolean }>;
  /** Snapshots the fake helper holds, by id. */
  snapshots: Map<string, { sandbox: string; bytes: number }>;
  /** What a `snapshot` reports as `snapshot_bytes`. */
  snapshotBytes: number;
  /** Called when a snapshot is taken (the VM is gone) and when one is resumed, once the dir is ready. */
  onSnapshot: (id: string, snap: string, dir: string) => void;
  onResume: (id: string, snap: string, dir: string) => void;
  /** Verbs whose reply is dropped after they have been carried out. */
  dropReply: Set<string>;
  /** Holds a `snapshot` until this resolves, before anything is stored. */
  holdSnapshot?: Promise<void>;
}

export function startFakeHelper(root: string, gid = process.getgid?.() ?? 1000): FakeHelper {
  const h: FakeHelper = { sock: path.join(root, "helper.sock"), frames: [], refuse: new Map(), raw: new Map(), onStart: () => undefined, mangle: (_id, dir) => dir, entries: new Map(), snapshots: new Map(), snapshotBytes: 4096, onSnapshot: () => undefined, onResume: () => undefined, dropReply: new Set() };
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
      void answer(frame).then((line) => sock.end(h.dropReply.has(String(frame["verb"])) ? "" : line)); // the verb ran; the answer is lost on the way back
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
        chmodSync(dir, 0o1770);
        h.entries.set(id, { dir });
      } else {
        if (!h.entries.has(id)) return `${JSON.stringify({ ok: false, protocol: 1, code: "unknown_sandbox" })}\n`;
        h.onStart(id, dir);
      }
      return `${JSON.stringify({ ok: true, protocol: 1, vsock_dir: h.mangle(id, dir), sandbox_gid: gid })}\n`;
    }
    const refusal = (code: string): string => `${JSON.stringify({ ok: false, protocol: 1, code })}\n`;
    if (verb === "snapshot") {
      await h.holdSnapshot;
      const e = h.entries.get(id);
      if (e === undefined) return refusal("unknown_sandbox");
      const snap = String(f["snapshot_id"]);
      if (h.snapshots.has(snap)) return refusal("bad_id");
      h.snapshots.set(snap, { sandbox: id, bytes: h.snapshotBytes });
      e.running = false; // the VM is killed, and the sandbox stays prepared
      h.onSnapshot(id, snap, e.dir);
      return `${JSON.stringify({ ok: true, protocol: 1, snapshot_bytes: h.snapshotBytes })}\n`;
    }
    if (verb === "resume") {
      const e = h.entries.get(id);
      if (e === undefined) return refusal("unknown_sandbox");
      const snap = String(f["snapshot_id"]);
      if (!h.snapshots.has(snap)) return refusal("unknown_snapshot");
      if (existsSync(path.join(e.dir, "v.sock"))) return refusal("internal"); // Firecracker cannot bind over a stale socket
      e.running = true;
      h.onResume(id, snap, e.dir);
      return `${JSON.stringify({ ok: true, protocol: 1, vsock_dir: h.mangle(id, e.dir), sandbox_gid: gid })}\n`;
    }
    if (verb === "snapshot_delete") {
      return h.snapshots.delete(String(f["snapshot_id"])) ? `${JSON.stringify({ ok: true, protocol: 1 })}\n` : refusal("unknown_snapshot");
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
  /** Bytes the snapshot directory reports free, and the daemon's clock in seconds. */
  free: { bytes: number };
  clock: { t: number };
  /** A new daemon over the same helper and state directory: what a restart of the process is. */
  restart(): Sandboxd;
}

export function makeRig(over: { readOnlyRoot?: boolean; listing?: TargetListing; euid?: number; agentFor?: (dir: string) => GuestAgent; gid?: number; extra?: Partial<SandboxdDeps> } = {}): Rig {
  const free = { bytes: 1024 ** 4 };
  const clock = { t: 1_700_000_000 };
  const root = scratch();
  mkdirSync(path.join(root, "vsock"));
  const helper = startFakeHelper(root, over.gid);
  const agents = new Map<string, FakeAgent>();
  helper.onStart = (id, dir) => {
    if (agents.has(id)) return;
    rmSync(path.join(dir, "v.sock"), { force: true }); // a fresh boot replaces whatever a dead VM left
    agents.set(id, startFakeAgent(dir, { readOnlyRoot: over.readOnlyRoot === true }));
  };
  const deps: SandboxdDeps = {
    euid: over.euid ?? process.geteuid?.(),
    helper: createHelperClient(connectUnix(helper.sock), 5000),
    boot: { listTargets: async () => over.listing ?? listing(), facts: () => ({ arch: "amd64", digests: DIGESTS }) },
    inspectDir: (dir) => fdInspectDir(dir, realOps()),
    hasForeignListener: (dir) => hasForeignListener(dir, realOps()),
    agentFor: over.agentFor ?? ((dir: string) => agentAtVsockDir(dir, realOps())),
    removeVsockSocket: (dir) => removeOwnVsockSocket(dir, realOps()),
    snapshots: { dir: "/fictional/snapshots", quotaBytes: 1024 ** 3, freeBytes: () => free.bytes, stateDir: path.join(scratch(), "state") },
    now: () => clock.t,
    bootTimeoutMs: 3000,
    pollMs: 20,
    ...over.extra,
  };
  // a stopped VM leaves its runner-owned v.sock behind; its memory comes back from the snapshot
  const savedFiles = new Map<string, FakeAgent["files"]>();
  helper.onSnapshot = (id, snap, dir) => {
    const old = agents.get(id);
    savedFiles.set(snap, new Map(old?.files));
    old?.close();
    agents.delete(id);
    const stale = net.createServer().listen(path.join(dir, "v.sock"));
    cleanups.push(() => stale.close());
  };
  helper.onResume = (id, snap, dir) => {
    const agent = startFakeAgent(dir, { readOnlyRoot: over.readOnlyRoot === true });
    for (const [p, f] of savedFiles.get(snap) ?? []) agent.files.set(p, f);
    agents.set(id, agent);
  };
  return { daemon: new Sandboxd(deps), helper, agents, deps, free, clock, restart: () => new Sandboxd(deps) };
}

/** A vsock proxy that accepts and never answers CONNECT: a guest that is not booted, or wedged. */
export function startSilentProxy(): string {
  const file = path.join(scratch(), "silent.sock");
  const server = net.createServer((s) => s.on("error", () => undefined)).listen(file);
  cleanups.push(() => server.close());
  return file;
}

/**
 * Runs `run` with setTimeout/clearTimeout wrapped, and reports the timers made with one of the (distinctive) delays `ms` and how many of
 * them were never cleared: a timer left pending after its race was decided is a leak the suite would otherwise not see.
 */
export async function trackTimers(ms: number[], run: () => Promise<unknown>): Promise<{ made: number; uncleared: number }> {
  const made = new Set<unknown>();
  const cleared = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, delay?: number, ...rest: unknown[]) => {
    const handle = (realSet as (...a: unknown[]) => NodeJS.Timeout)(fn, delay, ...rest);
    if (delay !== undefined && ms.includes(delay)) made.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    cleared.add(handle);
    return realClear(handle);
  }) as typeof clearTimeout;
  try {
    await run();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    for (const handle of made) if (!cleared.has(handle)) realClear(handle as NodeJS.Timeout); // never leave one behind, whatever the assertion says
  }
  return { made: made.size, uncleared: [...made].filter((h) => !cleared.has(h)).length };
}

/** What the daemon's caller reads once from the process and passes in. */
export const HOST: HostFacts = { euid: process.geteuid?.(), platform: process.platform };
export const realOps = () => realFdOps(HOST);

/** `pgrep -c <name>`: its exit status 1 with a count of 0 means none; any other failure is a failure of the check, never "none". */
export const makePgrepLister = (bin = "pgrep"): ProcessLister => ({
  count: (name) =>
    new Promise((resolve, reject) => {
      execFile(bin, ["-c", name], { timeout: 5000, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } }, (err, stdout) => {
        const text = String(stdout).trim();
        const none = err !== null && (err as { code?: unknown }).code === 1;
        // a missing binary or a crash prints nothing: an empty answer is a failed check, never a count of 0
        if ((err === null || none) && /^\d+$/.test(text)) return resolve(Number(text));
        reject(new TeardownError([], -1));
      });
    }),
});
export const pgrepLister: ProcessLister = makePgrepLister();

