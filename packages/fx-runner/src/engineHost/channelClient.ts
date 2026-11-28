/**
 * D#845 ON-13b2: the runner's side of the engine session's channel (`guestSession.ts`). One request per connection, in the guest agent's own frame: a 4-byte big-endian length and that many bytes of JSON, then, for
 * `token_put` only, `size` raw bytes; the reply is one frame and the end of the stream. `connect` is the vsock dial of port 5255 (`Sandbox.connect`, through the vsock directory's checked descriptors) or, in a test,
 * a plain socket. Nothing here reads a name, a path or text out of a reply: a reply is `{ok:true, ...}` or a closed `ChannelCode`, and every failure of this client is one fixed word (`ChannelError`).
 * The credential only ever passes through the buffer the caller hands to `tokenPut`; the client writes it and keeps no copy, and the caller zeroes its own buffer.
 */
import type { Duplex } from "node:stream";
import type { ChannelCode, ChannelReply, ChannelStopReason } from "./guestSession.js";
import { FRAME_MAX, TOKEN_MAX } from "./guestSession.js";

export type ChannelFailure = ChannelCode | "unreachable" | "bad_reply" | "timeout";
export class ChannelError extends Error {
  constructor(readonly code: ChannelFailure) {
    super(`engine session channel: ${code}`);
    this.name = "ChannelError";
  }
}

/** How long one request may take, connect to the last byte of the reply. */
export const CHANNEL_REQUEST_MS = 30_000;

export interface SessionChannel {
  ask(header: Record<string, unknown>, body?: Buffer): Promise<ChannelReply>;
  /** One tick of a fixed kind; the first one starts the host. Throws `ChannelError` unless the guest said ok. */
  tick(kind: "loop" | "start_day" | "checkin", name?: string): Promise<{ started: boolean }>;
  /** Forwards a signed command exactly as the cloud made it; the guest checks it again. Returns the command's name (`<seq>-<id>`). */
  command(signed: unknown): Promise<string>;
  /** Wipes the credential and ends the host. Throws unless the guest said ok; the caller judges `survivors` and `tokenWiped`, and waits for the supervisor program (`pid`, the guest's own; undefined when the reply carried none) to be gone. */
  stop(reason: ChannelStopReason): Promise<{ survivors: number; tokenWiped: boolean; pid: number | undefined }>;
  eventsRead(after: number, stream?: "events" | "outcomes"): Promise<{ lines: string[]; next: number; reset: boolean }>;
  /** Hands the credential over (1 to 4096 printable ASCII bytes). */
  tokenPut(token: Buffer): Promise<void>;
}

function frameOf(header: Record<string, unknown>, body?: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  if (json.length > FRAME_MAX) throw new ChannelError("bad_request");
  const out = Buffer.alloc(4 + json.length + (body?.length ?? 0));
  out.writeUInt32BE(json.length, 0);
  json.copy(out, 4);
  body?.copy(out, 4 + json.length);
  return out;
}

export function createChannelClient(connect: () => Promise<Duplex>, options: { timeoutMs?: number } = {}): SessionChannel {
  const limit = options.timeoutMs ?? CHANNEL_REQUEST_MS;
  async function ask(header: Record<string, unknown>, body?: Buffer): Promise<ChannelReply> {
    const frame = frameOf(header, body);
    let timer: NodeJS.Timeout | undefined;
    let socket: Duplex | undefined;
    try {
      const work = (async (): Promise<ChannelReply> => {
        try {
          socket = await connect();
        } catch {
          // fx-swallow-ok: the dial's own error could name a path; one fixed word is the whole answer
          throw new ChannelError("unreachable");
        }
        const conn = socket;
        const chunks: Buffer[] = [];
        let received = 0;
        const done = new Promise<void>((resolve, reject) => {
          conn.on("data", (c: Buffer) => {
            // the guest is the untrusted side: what it may send is one frame, so the count is kept as chunks arrive and the connection is dropped (by the `finally` below) the moment it is past that, or its length prefix says it will be
            received += c.length;
            chunks.push(c);
            if (received > 4 + FRAME_MAX || (received >= 4 && Buffer.concat(chunks, Math.min(received, 4)).readUInt32BE(0) > FRAME_MAX)) reject(new ChannelError("bad_reply"));
          });
          conn.on("end", resolve);
          conn.on("close", resolve);
          conn.on("error", () => reject(new ChannelError("unreachable")));
        });
        await new Promise<void>((resolve, reject) => conn.write(frame, (error) => (error ? reject(new ChannelError("unreachable")) : resolve())));
        await done;
        const all = Buffer.concat(chunks);
        const length = all.length >= 4 ? all.readUInt32BE(0) : -1;
        if (length <= 0 || length > FRAME_MAX || all.length < 4 + length) throw new ChannelError("bad_reply");
        try {
          const reply = JSON.parse(all.subarray(4, 4 + length).toString("utf8")) as ChannelReply;
          if (typeof reply !== "object" || reply === null || typeof reply.ok !== "boolean") throw new Error("shape");
          return reply;
        } catch {
          // fx-swallow-ok: a reply that is not the shape is `bad_reply`, never its text
          throw new ChannelError("bad_reply");
        }
      })();
      const late = new Promise<never>((_, reject) => void (timer = setTimeout(() => reject(new ChannelError("timeout")), limit)));
      return await Promise.race([work, late]);
    } finally {
      frame.fill(0); // a token frame holds the credential
      clearTimeout(timer);
      socket?.destroy();
    }
  }
  const okOr = (reply: ChannelReply): Extract<ChannelReply, { ok: true }> => {
    if (!reply.ok) throw new ChannelError(reply.code);
    return reply;
  };
  const num = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new ChannelError("bad_reply");
    return v;
  };
  return {
    ask,
    async tick(kind, name) {
      const reply = okOr(await ask({ op: "tick", kind, ...(name === undefined ? {} : { name }) }));
      return { started: reply["started"] === true };
    },
    async command(signed) {
      const name = okOr(await ask({ op: "command", command: signed }))["name"];
      if (typeof name !== "string") throw new ChannelError("bad_reply");
      return name;
    },
    async stop(reason) {
      const reply = okOr(await ask({ op: "stop", reason }));
      const pid = reply["pid"];
      return { survivors: num(reply["survivors"]), tokenWiped: reply["token_wiped"] === true, pid: typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 ? pid : undefined };
    },
    async eventsRead(after, stream = "events") {
      const reply = okOr(await ask({ op: "events_read", after, ...(stream === "events" ? {} : { stream }) }));
      const lines = reply["lines"];
      if (!Array.isArray(lines) || !lines.every((l) => typeof l === "string")) throw new ChannelError("bad_reply");
      return { lines: lines as string[], next: num(reply["next"]), reset: reply["reset"] === true };
    },
    async tokenPut(token) {
      if (token.length < 1 || token.length > TOKEN_MAX) throw new ChannelError("bad_request");
      okOr(await ask({ op: "token_put", name: "claude", size: token.length }, token));
    },
  };
}
