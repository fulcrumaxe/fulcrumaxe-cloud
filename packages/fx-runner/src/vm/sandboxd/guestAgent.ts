/**
 * The host side of the in-guest agent's protocol (infra/microvm-image/guest/agent.py, D#587 B-1): one request per connection, a 4-byte
 * big-endian length and that many bytes of JSON, then raw bytes the JSON names. `connect` is Firecracker's vsock proxy (the host connects to the
 * VM's Unix socket and says `CONNECT <port>`); a test hands it a plain Unix socket.
 */
import net from "node:net";
import type { Duplex } from "node:stream";

export const AGENT_PORT = 5252;
const MAX_HEADER = 1 << 20;

export type Connect = () => Promise<Duplex>;

export class AgentError extends Error {
  constructor(readonly code: "unreachable" | "bad_reply" | "refused" | "timeout") {
    super(`the guest agent failed: ${code}`);
    this.name = "AgentError";
  }
}

/** Connects to a Firecracker vsock Unix socket and finishes the `CONNECT` handshake; nothing past the `OK <port>` line has been read. */
export function viaFirecrackerVsock(udsPath: string, port = AGENT_PORT, handshakeMs = 10_000): Connect {
  return () =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(udsPath);
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
}

class Reader {
  private chunks: Buffer[] = [];
  private have = 0;
  private ended = false;
  private wake: (() => void) | undefined;
  constructor(socket: Duplex) {
    const end = (): void => {
      this.ended = true;
      this.wake?.();
    };
    socket.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.have += chunk.length;
      this.wake?.();
    });
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
  }
  async take(n: number): Promise<Buffer> {
    while (this.have < n) {
      if (this.ended) throw new AgentError("bad_reply");
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
    const all = Buffer.concat(this.chunks);
    this.chunks = [all.subarray(n)];
    this.have = all.length - n;
    return all.subarray(0, n);
  }
}

export interface AgentReply {
  header: Record<string, unknown>;
  blobs: Buffer[];
}

export interface ExecRequest {
  argv: string[];
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
}

/**
 * `ioTimeoutMs` bounds every answer except `runInGuest` (the "exec" op on the wire), which the agent answers only when the process has ended and so waits its own `timeout_s`
 * (600 s by default in the agent) plus this slack.
 */
export function createGuestAgent(connect: Connect, ioTimeoutMs = 30_000): GuestAgent {
  async function request(header: Record<string, unknown>, body: Buffer, blobKeys: readonly string[], timeoutMs: number, onSent?: () => void): Promise<AgentReply> {
    // `connect` is bounded here as well, so a Connect without a deadline of its own cannot leave a request pending for ever
    let connectTimer: NodeJS.Timeout | undefined;
    const connecting = connect();
    const socket = await Promise.race([connecting, new Promise<never>((_, reject) => (connectTimer = setTimeout(() => reject(new AgentError("timeout")), ioTimeoutMs)))]).catch((err: unknown) => {
      connecting.then((late) => late.destroy(), () => undefined);
      throw err;
    }).finally(() => clearTimeout(connectTimer));
    let timer: NodeJS.Timeout | undefined;
    try {
      const reader = new Reader(socket);
      const json = Buffer.from(JSON.stringify(header));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(json.length);
      socket.write(Buffer.concat([length, json, body]));
      onSent?.();
      const answer = (async (): Promise<AgentReply> => {
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
        const header = head as Record<string, unknown>;
        if (header["ok"] !== true) throw new AgentError("refused");
        const blobs: Buffer[] = [];
        for (const key of blobKeys) {
          const n = header[key] ?? 0; // the agent names no size on a timeout or a program it could not start, and sends no bytes
          if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new AgentError("bad_reply");
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
  const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
  return {
    ping: async () => void (await request({ op: "ping" }, Buffer.alloc(0), [], ioTimeoutMs)),
    runInGuest: async (req) => {
      const stdin = req.stdin ?? Buffer.alloc(0);
      const timeoutS = req.timeoutS ?? 600;
      const { header, blobs } = await request({ op: "exec", argv: req.argv, env: req.env, cwd: req.cwd, timeout_s: timeoutS, stdin_size: stdin.length }, stdin, ["stdout_size", "stderr_size"], timeoutS * 1000 + ioTimeoutMs, req.onSent);
      const timedOut = header["timed_out"] === true;
      return { exit: timedOut ? null : intOrNull(header["exit"]), signal: intOrNull(header["signal"]), timedOut, stdout: blobs[0] ?? Buffer.alloc(0), stderr: blobs[1] ?? Buffer.alloc(0) };
    },
  };
}

/**
 * The agent of the VM whose verified vsock directory is `dir`. The host-side Firecracker socket is `v.sock` inside it; the helper's launcher
 * (B-2b-ii) must configure that name, and the one constant is here so the two cannot drift apart unseen.
 */
export const VSOCK_SOCKET_NAME = "v.sock";
export const agentAtVsockDir = (dir: string): GuestAgent => createGuestAgent(viaFirecrackerVsock(`${dir}/${VSOCK_SOCKET_NAME}`));
