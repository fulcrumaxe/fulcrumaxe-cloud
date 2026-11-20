/**
 * The host side of the in-guest agent's protocol (infra/microvm-image/guest/agent.py, D#587 B-1): one request per connection, a 4-byte
 * big-endian length and that many bytes of JSON, then raw bytes the JSON names. `connect` is Firecracker's vsock proxy (the host connects to the
 * VM's Unix socket and says `CONNECT <port>`); a test hands it a plain Unix socket.
 */
import net from "node:net";
import type { Duplex } from "node:stream";
import { VSOCK_SOCKET_NAME, dialVsockDir, type FdOps } from "./vsockFd.js";
import { FILE_PIECE, MAX_FILE_BYTES, checkGuestPath, guestFileMode, type FileContent } from "./files.js";

export const AGENT_PORT = 5252;
const MAX_HEADER = 1 << 20;
/** The most bytes the agent keeps of one output stream (MAX_OUTPUT in agent.py). */
export const MAX_OUTPUT = 16 << 20;

export type Connect = () => Promise<Duplex>;

export class AgentError extends Error {
  constructor(readonly code: "unreachable" | "bad_reply" | "refused" | "timeout" | "bad_request") {
    super(`the guest agent failed: ${code}`);
    this.name = "AgentError";
  }
}

/**
 * Connects to a Firecracker vsock Unix socket and finishes the `CONNECT` handshake; nothing past the `OK <port>` line has been read. `target` is
 * a socket path (tests), or a function that returns the connected socket (production: `dialVsockDir`, which connects through checked fds).
 */
export function viaFirecrackerVsock(target: string | (() => Promise<net.Socket>), port = AGENT_PORT, handshakeMs = 10_000): Connect {
  return async () => {
    let socket: net.Socket;
    try {
      socket = typeof target === "string" ? net.createConnection(target) : await target();
    } catch {
      // fx-swallow-ok: the refusal's own text could name a path; the caller gets one fixed error
      throw new AgentError("unreachable");
    }
    return await new Promise<Duplex>((resolve, reject) => {
      // a guest that is not booted, or wedged, never answers `CONNECT`: the handshake has its own deadline
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new AgentError("timeout"));
      }, handshakeMs);
      const fail = (): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(new AgentError("unreachable"));
      };
      socket.once("error", fail);
      socket.once("close", fail);
      let seen = "";
      const onData = (chunk: Buffer): void => {
        seen += chunk.toString("latin1");
        const end = seen.indexOf("\n");
        if (end === -1) return;
        socket.off("data", onData);
        if (!/^OK \d+$/.test(seen.slice(0, end))) return fail();
        clearTimeout(timer);
        socket.off("error", fail);
        socket.off("close", fail);
        resolve(socket);
      };
      socket.on("data", onData);
      socket.write(`CONNECT ${port}\n`);
    });
  };
}

/** Bytes the reader holds before it stops reading the socket; a reader that is never taken from stops the guest at this bound. */
const HIGH_WATER = 4 << 20;

class Reader {
  private chunks: Buffer[] = [];
  private have = 0;
  private ended = false;
  /** Only a streaming read pauses the socket; `take` must wait for as many bytes as the reply names (up to the agent's output cap). */
  private bounded = false;
  private wake: (() => void) | undefined;
  constructor(private readonly socket: Duplex) {
    const end = (): void => {
      this.ended = true;
      this.wake?.();
    };
    socket.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.have += chunk.length;
      if (this.bounded && this.have >= HIGH_WATER) socket.pause();
      this.wake?.();
    });
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
  }
  private async until(n: number): Promise<void> {
    while (this.have < n) {
      if (this.ended) throw new AgentError("bad_reply");
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
  /** Removes `n` held bytes (n <= have) from the head, copying only what it hands out. */
  private consume(n: number): Buffer {
    const parts: Buffer[] = [];
    let left = n;
    while (left > 0) {
      const head = this.chunks[0] as Buffer;
      if (head.length <= left) {
        parts.push(head);
        left -= head.length;
        this.chunks.shift();
      } else {
        parts.push(head.subarray(0, left));
        this.chunks[0] = head.subarray(left);
        left = 0;
      }
    }
    this.have -= n;
    if (this.have < HIGH_WATER / 2) this.socket.resume();
    return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
  }
  async take(n: number): Promise<Buffer> {
    await this.until(n);
    return this.consume(n);
  }
  /** Hands `n` bytes to `sink` in pieces of at most `piece`, holding no more than HIGH_WATER at a time; a slow sink slows the socket. */
  async stream(n: number, sink: (chunk: Buffer) => void | Promise<void>, piece: number, progress: () => void): Promise<void> {
    this.bounded = true;
    for (let left = n; left > 0; ) {
      await this.until(1);
      const chunk = this.consume(Math.min(left, this.have, piece));
      left -= chunk.length;
      progress();
      await sink(chunk);
    }
  }
}

/** One reply frame's JSON, checked: an object with `ok: true`. Raw bytes it names are still unread. */
async function readReply(reader: Reader): Promise<Record<string, unknown>> {
  const size = (await reader.take(4)).readUInt32BE(0);
  if (size > MAX_HEADER) throw new AgentError("bad_reply");
  let head: unknown;
  try {
    head = JSON.parse((await reader.take(size)).toString("utf8"));
  } catch (err) {
    if (err instanceof AgentError) throw err;
    // fx-swallow-ok: the parser's message could echo guest bytes
    throw new AgentError("bad_reply");
  }
  if (typeof head !== "object" || head === null || Array.isArray(head)) throw new AgentError("bad_reply");
  if ((head as Record<string, unknown>)["ok"] !== true) throw new AgentError("refused");
  return head as Record<string, unknown>;
}

/** Resolves when the bytes are flushed, so a sender never has more than one piece in flight; a socket that dies meanwhile rejects. */
function writeAll(socket: Duplex, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      socket.off("error", fail);
      socket.off("close", fail);
    };
    const fail = (): void => {
      done();
      reject(new AgentError("unreachable"));
    };
    socket.once("error", fail);
    socket.once("close", fail);
    socket.write(data, (err) => {
      if (err) return fail();
      done();
      resolve();
    });
  });
}

/** `content` in pieces of at most FILE_PIECE bytes, never copied. */
async function* pieces(content: FileContent): AsyncGenerator<Buffer> {
  const parts: AsyncIterable<Uint8Array> | Iterable<Uint8Array> = Buffer.isBuffer(content) ? [content] : content.chunks;
  for await (const part of parts) {
    for (let at = 0; at < part.length; at += FILE_PIECE) yield Buffer.from(part.buffer, part.byteOffset + at, Math.min(FILE_PIECE, part.length - at));
  }
}

export interface AgentReply {
  header: Record<string, unknown>;
  blobs: Buffer[];
}

/** The most bytes of a subscription token the agent takes (MAX_TOKEN in agent.py). */
export const TOKEN_MAX_BYTES = 4096;

/** A token is 1..TOKEN_MAX_BYTES bytes of printable ASCII without a space, as the agent requires; nothing here names a byte of it. */
export function checkToken(token: Buffer): void {
  if (token.length < 1 || token.length > TOKEN_MAX_BYTES) throw new AgentError("bad_request");
  for (const b of token) if (b < 0x21 || b > 0x7e) throw new AgentError("bad_request");
}

export interface ExecRequest {
  argv: string[];
  /** Runs the command with the delivered subscription token in its environment (the agent reads it from its tmpfs file and removes the file). */
  token?: boolean;
  /** The guest user; the agent's default is the unprivileged one. A token launch as root is refused. */
  user?: "root" | "ubuntu";
  env?: Record<string, string>;
  cwd?: string;
  stdin?: Buffer;
  timeoutS?: number;
  /** Called once the request is written to the guest: from here on a kill has a process to reach. */
  onSent?: () => void;
}

export interface ExecResult {
  /** The exit status; null when the process ended on a signal (then `signal` is set) or timed out. */
  exit: number | null;
  signal: number | null;
  timedOut: boolean;
  stdout: Buffer;
  stderr: Buffer;
}

export interface GuestAgent {
  ping(): Promise<void>;
  runInGuest(req: ExecRequest): Promise<ExecResult>;
  /** Writes one file; `size` is the exact byte count of `content` (the agent needs it before the first byte). */
  put(req: { path: string; mode?: number; size: number; content: FileContent }): Promise<void>;
  /** Reads one file into `sink` in pieces, awaiting it between pieces; resolves with the byte count. */
  get(path: string, sink: (chunk: Buffer) => void | Promise<void>): Promise<number>;
  /** Pushes the subscription token to the guest's tmpfs. The caller's buffer is zeroed when this settles, whatever the outcome. */
  putToken(token: Buffer): Promise<void>;
  /** Asks the guest to remove the token and kill every process that holds it; call it before any snapshot. Rejects unless the guest says none is left. */
  wipeToken(): Promise<{ removed: boolean; killed: number }>;
}

/** A transfer ends after this long in all; it also ends when `ioTimeoutMs` passes with no progress. */
const TRANSFER_MAX_MS = 600_000;

/**
 * `ioTimeoutMs` bounds every answer except `runInGuest` (the "exec" op on the wire), which the agent answers only when the process has ended and so waits its own `timeout_s`
 * (600 s by default in the agent) plus this slack.
 */
export function createGuestAgent(connect: Connect, ioTimeoutMs = 30_000, transferMaxMs = TRANSFER_MAX_MS): GuestAgent {
  /** `connect` is bounded here as well, so a Connect without a deadline of its own cannot leave a request pending for ever. */
  async function open(): Promise<Duplex> {
    let connectTimer: NodeJS.Timeout | undefined;
    const connecting = connect();
    return await Promise.race([connecting, new Promise<never>((_, reject) => (connectTimer = setTimeout(() => reject(new AgentError("timeout")), ioTimeoutMs)))]).catch((err: unknown) => {
      connecting.then((late) => late.destroy(), () => undefined);
      throw err;
    }).finally(() => clearTimeout(connectTimer));
  }
  async function request(header: Record<string, unknown>, body: Buffer, blobKeys: readonly string[], timeoutMs: number, onSent?: () => void): Promise<AgentReply> {
    const socket = await open();
    let timer: NodeJS.Timeout | undefined;
    try {
      const reader = new Reader(socket);
      const json = Buffer.from(JSON.stringify(header));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(json.length);
      socket.write(Buffer.concat([length, json, body]));
      onSent?.();
      const answer = (async (): Promise<AgentReply> => {
        const header = await readReply(reader);
        const blobs: Buffer[] = [];
        for (const key of blobKeys) {
          const n = header[key] ?? 0; // the agent names no size on a timeout or a program it could not start, and sends no bytes
          // each stream is capped on its own, as the agent caps each: a guest naming more is lying, and `take` would buffer it all
          if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_OUTPUT) throw new AgentError("bad_reply");
          blobs.push(await reader.take(n));
        }
        return { header, blobs };
      })();
      const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new AgentError("timeout")), timeoutMs)));
      return await Promise.race([answer, limit]);
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }
  /** One connection for a file transfer: bounded by an idle timer that `progress` re-arms, and by TRANSFER_MAX_MS overall. */
  async function transfer<T>(run: (socket: Duplex, reader: Reader, progress: () => void) => Promise<T>): Promise<T> {
    const socket = await open();
    let idle: NodeJS.Timeout | undefined;
    let reject: (err: AgentError) => void = () => undefined;
    const expired = new Promise<never>((_, rej) => (reject = rej));
    const arm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => reject(new AgentError("timeout")), ioTimeoutMs);
    };
    const cap = setTimeout(() => reject(new AgentError("timeout")), transferMaxMs);
    arm();
    try {
      return await Promise.race([run(socket, new Reader(socket), arm), expired]);
    } finally {
      clearTimeout(idle);
      clearTimeout(cap);
      socket.destroy();
    }
  }
  const frame = (header: Record<string, unknown>): Buffer => {
    const json = Buffer.from(JSON.stringify(header));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    return Buffer.concat([length, json]);
  };
  const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
  return {
    ping: async () => void (await request({ op: "ping" }, Buffer.alloc(0), [], ioTimeoutMs)),
    put: async (req) => {
      const path = checkGuestPath(req.path);
      const mode = guestFileMode(req.mode);
      if (!Number.isSafeInteger(req.size) || req.size < 0 || req.size > MAX_FILE_BYTES) throw new AgentError("bad_request");
      await transfer(async (socket, reader, progress) => {
        await writeAll(socket, frame({ op: "put", path, mode, size: req.size }));
        let sent = 0;
        for await (const piece of pieces(req.content)) {
          sent += piece.length;
          if (sent > req.size) throw new AgentError("bad_request"); // the agent is told a size and waits for exactly that many bytes
          await writeAll(socket, piece);
          progress();
        }
        if (sent !== req.size) throw new AgentError("bad_request");
        await readReply(reader);
      });
    },
    get: async (rawPath, sink) => {
      const path = checkGuestPath(rawPath);
      return await transfer(async (socket, reader, progress) => {
        await writeAll(socket, frame({ op: "get", path }));
        const n = (await readReply(reader))["size"];
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_FILE_BYTES) throw new AgentError("bad_reply");
        await reader.stream(n, sink, FILE_PIECE, progress);
        return n;
      });
    },
    putToken: async (token) => {
      try {
        checkToken(token);
        await transfer(async (socket, reader) => {
          await writeAll(socket, frame({ op: "token_put", size: token.length }));
          await writeAll(socket, token); // straight from the caller's buffer: no JSON field, no copy of ours
          await readReply(reader);
        });
      } finally {
        token.fill(0);
      }
    },
    wipeToken: async () => {
      const { header } = await request({ op: "token_wipe" }, Buffer.alloc(0), [], ioTimeoutMs);
      const killed = intOrNull(header["killed"]);
      if (typeof header["removed"] !== "boolean" || killed === null || killed < 0) throw new AgentError("bad_reply");
      return { removed: header["removed"], killed };
    },
    runInGuest: async (req) => {
      if (req.token === true && req.user === "root") throw new AgentError("bad_request"); // a root descendant could leave the token's cgroup: refused before any connection
      const stdin = req.stdin ?? Buffer.alloc(0);
      const timeoutS = req.timeoutS ?? 600;
      const { header, blobs } = await request({ op: "exec", argv: req.argv, env: req.env, cwd: req.cwd, timeout_s: timeoutS, stdin_size: stdin.length, ...(req.token === true ? { token: true } : {}), ...(req.user === undefined ? {} : { user: req.user }) }, stdin, ["stdout_size", "stderr_size"], timeoutS * 1000 + ioTimeoutMs, req.onSent);
      const timedOut = header["timed_out"] === true;
      return { exit: timedOut ? null : intOrNull(header["exit"]), signal: intOrNull(header["signal"]), timedOut, stdout: blobs[0] ?? Buffer.alloc(0), stderr: blobs[1] ?? Buffer.alloc(0) };
    },
  };
}

/**
 * The agent of the VM whose verified vsock directory is `dir`. The host-side Firecracker socket is `v.sock` inside it; the helper's launcher
 * (B-2b-ii) must configure that name, and the one constant (in vsockFd.ts) is shared so the two cannot drift apart unseen. Every connection
 * goes through O_PATH|O_NOFOLLOW fds and an fd path (decision Correction 8), never through the plain path of the socket.
 */
export { VSOCK_SOCKET_NAME };
export const agentAtVsockDir = (dir: string, ops: FdOps): GuestAgent => createGuestAgent(viaFirecrackerVsock(() => dialVsockDir(dir, ops)));
