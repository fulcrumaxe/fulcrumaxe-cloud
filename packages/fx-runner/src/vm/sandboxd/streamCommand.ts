/**
 * The host side of the guest agent's streaming exec op, `exec_stream`, and its `kill` (D#587 B-5a-RT-1). One connection carries one command: the
 * request, then frames in the order the guest read the bytes (`data` frames of 1..64 KiB with a `seq` counting up from 0, and exactly one `exit`).
 *
 * Everything the guest sends is hostile data, so the reader is strict and bounded:
 *  - It reads on demand. The socket stays in paused mode and a frame is read only when the consumer asks for it, so a slow consumer leaves bytes in
 *    the kernel buffer and stalls the guest's pipe; the host holds at most one frame (a header of at most MAX_HEAD bytes and 64 KiB of data) plus
 *    the socket's own small buffer. Nothing is queued.
 *  - Any frame that is not `data` or `exit`, a `seq` that is not the next integer, a size of 0 or over 64 KiB, a body shorter than its size, a second
 *    `exit` or bytes after it, and a close with no `exit`, end the stream as `AgentError("lost")`. A close is never a clean end.
 *  - The only text that leaves this module is a closed code. A guest's own words (an `error` field, a parse failure) are never copied out.
 *
 * `done` settles only as frames are read: a caller that wants the exit status reads the frames (or aborts the stream) first.
 */
import type { Duplex } from "node:stream";
import { SUBSCRIPTION_TOKEN_VAR } from "../../job/cleanEnv.js";
import { AgentError } from "./agentError.js";

export type StreamSignal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
const SIGNALS: readonly StreamSignal[] = ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"];
/** The guest's id rule (ID_RE in agent.py). */
export const STREAM_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The most data bytes in one frame (CHUNK in agent.py). */
export const MAX_FRAME_DATA = 64 << 10;
/** A frame's JSON is tiny; one longer than this is not the agent's. */
const MAX_HEAD = 4096;
/** The most stdin the agent takes (MAX_BYTES in agent.py). */
const MAX_STDIN = 256 << 20;
const MAX_TIMEOUT_S = 7 * 24 * 3600;
/** The name the agent refuses in `env`: a token travels only by its own op. */
const TOKEN_VAR = SUBSCRIPTION_TOKEN_VAR;
/** How long after the `exit` frame the reader looks for bytes that should not be there. */
const TRAILING_LOOK_MS = 100;
/** A `kill` that finds no such id is retried this often, for this long, while the stream has shown nothing (the agent may not have read the request yet). */
const KILL_RETRY_MS = 50;
const KILL_RETRY_FOR_MS = 1000;

export interface StreamRequest {
  /** 1..64 of `A-Za-z0-9_-`, unique per guest agent run; the id `kill` names. */
  id: string;
  argv: string[];
  /** Runs the command with the delivered subscription token in its environment. Refused with `user: "root"`, and `env` may not name the token. */
  token?: boolean;
  user?: "root" | "ubuntu";
  env?: Record<string, string>;
  cwd?: string;
  stdin?: Buffer;
  /** The command's own limit in the guest (default 600): it arrives as `timedOut` on the `exit` frame. */
  timeoutS?: number;
}

export interface StreamFrame { stream: "stdout" | "stderr"; data: Buffer }
export interface StreamDone { exit: number | null; signal: number | null; timedOut: boolean }

export interface GuestStream {
  readonly id: string;
  /** Read once, in order. Throws the stream's `AgentError` if it ends any way but with the guest's `exit` frame. Leaving the loop early abandons the stream (the guest then kills the command). */
  readonly frames: AsyncIterable<StreamFrame>;
  /** Resolves with the `exit` frame's content once every frame is read; rejects with the `AgentError` that ended the stream otherwise. */
  readonly done: Promise<StreamDone>;
  /** Sends the guest's `kill` for this id on a connection of its own. A command that is not running (not started, or ended) is not an error. */
  kill(signal: StreamSignal): Promise<void>;
  /** Drops the connection now; `done` rejects as `lost` unless it has settled. Safe to repeat. */
  abort(): void;
}

/** What the stream needs from the agent client; `guestAgent.ts` supplies it. */
export interface StreamLink {
  /** A bounded connection with the handshake finished. */
  open(): Promise<Duplex>;
  /** The ops the guest advertises in `ping`. */
  caps(): Promise<readonly string[]>;
  /** The guest's `kill`: "unknown_id" is the one normal refusal; any other refusal throws. */
  kill(id: string, signal: StreamSignal): Promise<"signalled" | "unknown_id">;
  ioTimeoutMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const intOrNull = (v: unknown): number | null | undefined => (v === null ? null : isInt(v) ? v : undefined);

/** Whole frames off a paused socket, one `read(n)` at a time. */
class PullReader {
  private ended = false;
  private wake: (() => void) | undefined;
  constructor(private readonly socket: Duplex) {
    socket.pause(); // nothing is read, or dropped, until a frame is asked for
    const end = (): void => {
      this.ended = true;
      this.wake?.();
    };
    socket.on("readable", () => this.wake?.());
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
  }
  /** Exactly `n` bytes, or `lost`. While it waits it holds one idle timer: bytes that stop for `idleMs` end the stream. */
  async take(n: number, idleMs: number): Promise<Buffer> {
    for (;;) {
      const chunk = this.socket.read(n) as Buffer | null;
      if (chunk !== null) {
        if (chunk.length < n) throw new AgentError("lost"); // the connection ended inside a frame
        return chunk;
      }
      if (this.ended) throw new AgentError("lost");
      let timer: NodeJS.Timeout | undefined;
      let idle = false;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        timer = setTimeout(() => {
          idle = true;
          resolve();
        }, idleMs);
      });
      clearTimeout(timer);
      this.wake = undefined;
      if (idle) throw new AgentError("lost");
    }
  }
  /**
   * What follows the `exit` frame within `ms`: more bytes (a guest breaking the framing), the end of the connection, or nothing. It waits out the
   * whole window: a wake-up that brings neither bytes nor the end (a stale `readable`) does not end the wait early.
   */
  async trailing(ms: number): Promise<"bytes" | "ended" | "quiet"> {
    const until = performance.now() + ms;
    for (;;) {
      if (this.socket.read(1) !== null) return "bytes";
      if (this.ended) return "ended";
      const left = until - performance.now();
      if (left <= 0) return "quiet";
      let timer: NodeJS.Timeout | undefined;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        timer = setTimeout(resolve, left);
      });
      clearTimeout(timer);
      this.wake = undefined;
    }
  }
}

function check(req: StreamRequest): void {
  if (typeof req.id !== "string" || !STREAM_ID.test(req.id)) throw new AgentError("bad_request");
  if (!Array.isArray(req.argv) || req.argv.length === 0 || !req.argv.every((a) => typeof a === "string" && !a.includes("\0"))) throw new AgentError("bad_request");
  if (req.token === true && req.user === "root") throw new AgentError("bad_request"); // a root descendant could leave the token's cgroup
  if (req.env !== undefined && Object.prototype.hasOwnProperty.call(req.env, TOKEN_VAR)) throw new AgentError("bad_request");
  if (req.timeoutS !== undefined && (!Number.isFinite(req.timeoutS) || req.timeoutS <= 0 || req.timeoutS > MAX_TIMEOUT_S)) throw new AgentError("bad_request");
  if (req.stdin !== undefined && req.stdin.length > MAX_STDIN) throw new AgentError("bad_request");
}

function write(socket: Duplex, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (err) => (err === null || err === undefined ? resolve() : reject(new AgentError("unreachable"))));
  });
}

/** Starts the command; resolves once its request is written (a kill is possible from then on). Nothing is sent to a guest that does not advertise `exec_stream`. */
export async function startStream(link: StreamLink, req: StreamRequest): Promise<GuestStream> {
  check(req);
  const caps = await link.caps();
  if (!caps.includes("exec_stream")) throw new AgentError("unsupported");
  const timeoutS = req.timeoutS ?? 600;
  const stdin = req.stdin ?? Buffer.alloc(0);
  const head = Buffer.from(JSON.stringify({ op: "exec_stream", id: req.id, argv: req.argv, env: req.env, cwd: req.cwd, timeout_s: timeoutS, stdin_size: stdin.length, ...(req.token === true ? { token: true } : {}), ...(req.user === undefined ? {} : { user: req.user }) }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(head.length);
  const socket = await link.open();
  const reader = new PullReader(socket);
  try {
    await write(socket, Buffer.concat([length, head]));
    if (stdin.length > 0) await write(socket, stdin);
  } catch (err) {
    socket.destroy();
    throw err;
  }
  // a silent command may be quiet for its whole limit, and the guest then still owes its exit frame: that is the longest a live guest can be quiet
  const idleMs = timeoutS * 1000 + link.ioTimeoutMs;
  const canKill = caps.includes("kill");

  let settled = false;
  let sawFrame = false;
  let expectSeq = 0;
  let failure: AgentError | undefined;
  let resolveDone!: (d: StreamDone) => void;
  let rejectDone!: (e: AgentError) => void;
  const done = new Promise<StreamDone>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => undefined); // fx-swallow-ok: marks it handled; the frames loop and every awaiting caller still see the rejection

  const fail = (err: AgentError): AgentError => {
    if (!settled) {
      settled = true;
      failure = err;
      rejectDone(err);
    }
    socket.destroy();
    return failure ?? err;
  };

  async function nextFrame(): Promise<StreamFrame | undefined> {
    if (failure !== undefined) throw failure;
    if (settled) return undefined;
    try {
      const size = (await reader.take(4, idleMs)).readUInt32BE(0);
      if (size < 2 || size > MAX_HEAD) throw new AgentError("lost");
      let frame: unknown;
      try {
        frame = JSON.parse((await reader.take(size, idleMs)).toString("utf8"));
      } catch (err) {
        if (err instanceof AgentError) throw err;
        // fx-swallow-ok: the parser's message could echo guest bytes
        throw new AgentError("lost");
      }
      if (typeof frame !== "object" || frame === null || Array.isArray(frame)) throw new AgentError("lost");
      const f = frame as Record<string, unknown>;
      if (f["ok"] === false && expectSeq === 0) throw new AgentError("refused"); // the guest refused the request before it started anything
      if (f["seq"] !== expectSeq) throw new AgentError("lost");
      expectSeq += 1;
      sawFrame = true;
      if (f["ev"] === "data") {
        const n = f["size"];
        if (!isInt(n) || n < 1 || n > MAX_FRAME_DATA || (f["stream"] !== "stdout" && f["stream"] !== "stderr")) throw new AgentError("lost");
        return { stream: f["stream"], data: await reader.take(n, idleMs) };
      }
      if (f["ev"] !== "exit") throw new AgentError("lost");
      const exit = intOrNull(f["exit"]);
      const signal = intOrNull(f["signal"]);
      if (exit === undefined || signal === undefined || typeof f["timed_out"] !== "boolean") throw new AgentError("lost");
      socket.end(); // the agent waits for the host to end its side before it closes
      if ((await reader.trailing(Math.min(TRAILING_LOOK_MS, link.ioTimeoutMs))) === "bytes") throw new AgentError("lost");
      settled = true;
      resolveDone({ exit, signal, timedOut: f["timed_out"] });
      socket.destroy();
      return undefined;
    } catch (err) {
      throw fail(err instanceof AgentError ? err : new AgentError("lost"));
    }
  }

  let tail: Promise<unknown> = Promise.resolve();
  const pull = (): Promise<StreamFrame | undefined> => {
    const next = tail.then(nextFrame, nextFrame);
    tail = next.catch(() => undefined); // fx-swallow-ok: the chain only orders reads; each caller gets its own result
    return next;
  };
  const abort = (): void => void fail(new AgentError("lost"));

  return {
    id: req.id,
    done,
    abort,
    frames: {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<StreamFrame>> => {
          const frame = await pull();
          return frame === undefined ? { done: true, value: undefined } : { done: false, value: frame };
        },
        return: async (): Promise<IteratorResult<StreamFrame>> => {
          abort(); // a consumer that leaves early abandons the stream; the guest kills a command nobody reads
          return { done: true, value: undefined };
        },
      }),
    },
    async kill(signal) {
      if (!SIGNALS.includes(signal)) throw new AgentError("bad_request");
      if (!canKill) throw new AgentError("unsupported");
      for (let waited = 0; !settled; waited += KILL_RETRY_MS) {
        if ((await link.kill(req.id, signal)) === "signalled") return;
        // no such id: the command ended, or the agent has not read this stream's request yet
        if (settled || sawFrame || waited >= KILL_RETRY_FOR_MS) return;
        await sleep(KILL_RETRY_MS);
      }
    },
  };
}
