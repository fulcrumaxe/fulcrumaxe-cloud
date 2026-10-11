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
}
