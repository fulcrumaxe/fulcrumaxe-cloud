import net from "node:net";

/**
 * A host-side client for infra/microvm-image/guest/agent.py: one connection per request, the 4-byte-length JSON frame, raw bytes after
 * it. Test tooling for B-1; the sandbox daemon (B-2b) brings its own. `connect` is either Firecracker's vsock proxy (the host connects
 * to the VM's Unix socket and says `CONNECT <port>`) or a plain Unix socket, which is how the agent is run on a machine without vsock.
 */
export type Connect = () => Promise<net.Socket>;

export const VSOCK_PORT = 5252;

export function viaFirecrackerVsock(udsPath: string, port = VSOCK_PORT): Connect {
  return () =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(udsPath);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("vsock connection closed before the handshake finished")));
      let seen = "";
      const onData = (chunk: Buffer): void => {
        seen += chunk.toString("latin1");
        const end = seen.indexOf("\n");
        if (end === -1) return;
        socket.off("data", onData);
        if (!/^OK \d+$/.test(seen.slice(0, end))) return reject(new Error(`vsock handshake refused: ${seen.slice(0, 40)}`));
        // The handshake line is the only thing the proxy sends before the guest answers, so nothing past it has been read.
        socket.off("error", reject);
        resolve(socket);
      };
      socket.on("data", onData);
      socket.write(`CONNECT ${port}\n`);
    });
}

export const viaUnixSocket = (file: string): Connect => () =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });

class Reader {
  private chunks: Buffer[] = [];
  private have = 0;
  private waiting: Array<() => void> = [];
  private ended = false;
  constructor(socket: net.Socket) {
    socket.on("data", (c) => {
      this.chunks.push(c);
      this.have += c.length;
      this.wake();
    });
    socket.on("end", () => {
      this.ended = true;
      this.wake();
    });
    socket.on("error", () => {
      this.ended = true;
      this.wake();
    });
  }
  private wake(): void {
    for (const w of this.waiting.splice(0)) w();
  }
  async take(n: number): Promise<Buffer> {
    while (this.have < n) {
      if (this.ended) throw new Error("the agent closed the connection early");
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    const all = Buffer.concat(this.chunks);
    this.chunks = [all.subarray(n)];
    this.have = all.length - n;
    return all.subarray(0, n);
  }
}

export interface Reply {
  header: Record<string, unknown>;
  blobs: Buffer[];
}

export class AgentClient {
  constructor(private readonly connect: Connect) {}

  async request(header: Record<string, unknown>, body: Buffer = Buffer.alloc(0), blobKeys: readonly string[] = []): Promise<Reply> {
    const socket = await this.connect();
    try {
      const reader = new Reader(socket);
      const json = Buffer.from(JSON.stringify(header));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(json.length);
      socket.write(Buffer.concat([length, json, body]));
      const head = JSON.parse((await reader.take((await reader.take(4)).readUInt32BE(0))).toString("utf8")) as Record<string, unknown>;
      const blobs: Buffer[] = [];
      for (const key of blobKeys) if (head["ok"] === true) blobs.push(await reader.take(Number(head[key] ?? 0)));
      return { header: head, blobs };
    } finally {
      socket.destroy();
    }
  }

  ping = async (): Promise<Record<string, unknown>> => (await this.request({ op: "ping" })).header;
  counters = async (): Promise<Record<string, unknown>> => (await this.request({ op: "counters" })).header;

  async exec(argv: string[], opts: { env?: Record<string, string>; cwd?: string; user?: "root" | "ubuntu"; timeoutS?: number; stdin?: Buffer } = {}): Promise<{ exit: number | null; stdout: string; stderr: string; header: Record<string, unknown> }> {
    const stdin = opts.stdin ?? Buffer.alloc(0);
    const { header, blobs } = await this.request({ op: "exec", argv, env: opts.env, cwd: opts.cwd, user: opts.user, timeout_s: opts.timeoutS, stdin_size: stdin.length }, stdin, ["stdout_size", "stderr_size"]);
    if (header["ok"] !== true) throw new Error(`exec refused: ${String(header["error"])}`);
    return { exit: header["exit"] as number | null, stdout: blobs[0]?.toString("utf8") ?? "", stderr: blobs[1]?.toString("utf8") ?? "", header };
  }

  async put(path: string, data: Buffer, mode = 0o644): Promise<void> {
    const { header } = await this.request({ op: "put", path, mode, size: data.length }, data);
    if (header["ok"] !== true) throw new Error(`put refused: ${String(header["error"])}`);
  }

  async get(path: string): Promise<Buffer> {
    const { header, blobs } = await this.request({ op: "get", path }, Buffer.alloc(0), ["size"]);
    if (header["ok"] !== true) throw new Error(`get refused: ${String(header["error"])}`);
    return blobs[0] ?? Buffer.alloc(0);
  }

  /** `kill` on its own connection; the agent's whole reply, `ok` or not. */
  kill = async (id: string, signal?: string): Promise<Record<string, unknown>> => (await this.request({ op: "kill", id, ...(signal === undefined ? {} : { signal }) })).header;
}

export type StreamEvent = { ev: "data"; stream: "stdout" | "stderr"; seq: number; data: Buffer } | { ev: "exit"; seq: number; exit: number | null; signal: number | null; timed_out: boolean; error?: string };
export type StreamItem = StreamEvent | { ev: "error"; header: Record<string, unknown> };

/**
 * A streaming exec (`exec_stream`) read one frame at a time: the socket is read on demand, so a caller that is slow to ask
 * for the next frame really does leave bytes in the kernel buffer and the agent blocked on its send. `next` is null after the agent closes.
 */
export class ExecStream {
  private readonly chunks: AsyncIterator<Buffer>;
  private rest: Buffer = Buffer.alloc(0);
  private constructor(readonly socket: net.Socket) {
    // the async iterator reads from the socket only when asked for the next chunk, which is what lets a slow caller stall the agent
    this.chunks = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  static async open(connect: Connect, header: Record<string, unknown>, stdin: Buffer = Buffer.alloc(0)): Promise<ExecStream> {
    const socket = await connect();
    const json = Buffer.from(JSON.stringify({ ...header, op: "exec_stream", stdin_size: stdin.length }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    socket.write(Buffer.concat([length, json, stdin]));
    return new ExecStream(socket);
  }

  private async take(n: number): Promise<Buffer | null> {
    while (this.rest.length < n) {
      let step: IteratorResult<Buffer>;
      try {
        step = await this.chunks.next();
      } catch {
        return null; // fx-swallow-ok: a reset connection reads as closed
      }
      if (step.done === true) return null;
      this.rest = Buffer.concat([this.rest, step.value]);
    }
    const out = this.rest.subarray(0, n);
    this.rest = this.rest.subarray(n);
    return out;
  }

  async next(): Promise<StreamItem | null> {
    const len = await this.take(4);
    if (len === null) return null;
    const body = await this.take(len.readUInt32BE(0));
    if (body === null) throw new Error("the agent closed in the middle of a frame");
    const head = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    if (head["ev"] === "data") {
      const data = await this.take(Number(head["size"]));
      if (data === null) throw new Error("the agent closed in the middle of a data frame");
      return { ev: "data", stream: head["stream"] as "stdout" | "stderr", seq: head["seq"] as number, data };
    }
    if (head["ev"] === "exit") return head as unknown as StreamEvent;
    return { ev: "error", header: head };
  }

  async all(): Promise<StreamItem[]> {
    const out: StreamItem[] = [];
    for (let e = await this.next(); e !== null; e = await this.next()) out.push(e);
    this.socket.destroy(); // the agent waits for the host to end its side before it closes
    return out;
  }
}
