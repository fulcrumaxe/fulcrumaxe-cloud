/**
 * D#845 ON-13b1: the engine session's supervisor and its channel. The same module runs in two places: as `fx-engine-supervisor` inside a microVM (started by the guest's `engine-bridge.py`, which carries vsock port 5255 to the
 * unix socket below) and as the program held in an engine session's systemd unit on the standard tier (`fx-runner __engine-supervise`, which replaces the idle holder). It wraps EB-12a's `createSupervisor` and adds only:
 *  - the channel: ONE request per connection on a private unix socket, the frame being a 4-byte big-endian length and that many bytes of JSON (the guest agent's own frame; at most `FRAME_MAX`), and for `token_put` `size` raw bytes
 *    after it. The operations are a closed list, an unknown one or a key outside its shape is `bad_request`, and every reply is `{ok:true,...}` or `{ok:false,code}` with a code of `ChannelCode`: never text of the stream, a path or an error.
 *      - `tick {kind, name?}` (ON-13b2): `kind` is `loop`, `start_day` or `checkin` (with a row key as `name`); the first one starts the host (the session config is read, every EB-12a refusal still applies) and the ticker
 *        (`guestTicks.ts`: EB-12b's single flight, queued kinds and fixed templates; the loop, check-in and start-of-day ticks then come from its own timers). No text travels: every message the host gets is a template of `prompts.ts`.
 *      - `command {command}`: the signed `EngineCommand` the runner forwards is checked again here against the key this build pins for the cloud address `session.json` names (`verifyCommandWith`); anything that does not
 *        check out is `command_unverified` and reaches nothing. A verified one goes to the ticker, and its outcome is a line of `engine-host-outcomes.jsonl`.
 *      - `stop {reason?}`: wipes the credential FIRST, then ends the host through the supervisor's own stop (close stdin, then the kill path). A stopped session takes no further tick: the next start is a new supervisor.
 *      - `events_read {after, stream?}`: the engine events the supervisor wrote (`engine-host-events.jsonl`; `stream: "outcomes"` reads the command outcomes instead, and `stream: "engine"` the engine's OWN `engine-events.jsonl`, which the host never opens: it is the guest's file, read
 *        here and nowhere else), whole lines from byte `after`, at most `EVENTS_READ_MAX` bytes; `ends` is the byte offset just past each line, so the reader can keep an exact cursor; `reset` when the file is shorter than `after` (it rotated).
 *      - `token_put {name:"claude", size}`: 1..4096 printable ASCII bytes follow the frame (no JSON field carries them). They are held in ONE buffer that is zeroed by the next `token_put` and by every `stop`, handed to the host's
 *        environment at launch as the subscription variable and nowhere else, and never logged, echoed, spooled or put in an event. Node cannot zero the copies it makes (the latin1 string, the merged environment object and libuv's envp copy), so zeroing the buffer is NOT enough on its own. The guarantee the snapshot needs is that the PROGRAM ENDS:
 *        after a channel `stop` and after `crash_loop` the supervisor exits (`finished()`, which `runEngineSupervise` waits for), the bridge kills the group, the guest kernel's `init_on_free=1` zeroes the pages and init starts a fresh
 *        supervisor with no credential. The real-VM test greps a RAM snapshot taken after the channel `stop` for the token.
 *  - `usage_tick`: every `result` line with all four token totals becomes one `usage_tick` engine event (raw counts only; the cloud prices them, never the engine). A turn with no usage is not a tick ("not recorded", never zero).
 *  - the 20 MB rotating log (`openHostLog`) and the event spool, in the session's state directory (the guest root is read-only: `/vercel/sandbox/...` is the writable place).
 * Restarts (1, 2, 5 minutes) and `crash_loop` are the supervisor's. Nothing here starts a program: the runtime hands in `launch`, the kill path and the clock.
 */
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { ENGINE_DURATION_S_MAX, MODEL_TIER_PATTERN, ROW_KEY_PATTERN, type EngineCommandAck } from "@fulcrumaxe/runner-protocol";
import { SUBSCRIPTION_TOKEN_VAR } from "../job/cleanEnv.js";
import type { EngineHostHandle } from "../engineBridge/halt.js";
import { ensurePrivateDir, readJsonNoFollow } from "../engineBridge/stateFiles.js";
import { keyringFor, type PinnedKeyrings } from "../keyring.js";
import { openAnsweredStore } from "./answered.js";
import { credentialModeOf, tickSettingsOf } from "./hostConfig.js";
import { createAgentFeed, createEventSpool, ENGINE_EVENTS_FILE, SPOOL_FILE, SPOOL_MAX_BYTES } from "./hostFeeds.js";
import { acquireHostLock, isRepoGhId, openHostLog, type BridgeState } from "./hostFiles.js";
import { createGuestTicks, OUTCOMES_FILE, verifyCommandWith, type GuestTicks } from "./guestTicks.js";
import { openSessionStore } from "./session.js";
import { createSupervisor, type HostChild, type HostSpawnSpec, type StopReason, type Supervisor, type TurnResult } from "./supervisor.js";

/** The guest vsock port `engine-bridge.py` listens on (the agent's is 5252, the two relays' 5253 and 5254). */
export const CHANNEL_PORT = 5255;
export const CHANNEL_OPS = ["tick", "command", "stop", "events_read", "token_put"] as const;
export type ChannelOp = (typeof CHANNEL_OPS)[number];
export const TICK_KINDS = ["loop", "start_day", "checkin"] as const;
/** The reasons a channel `stop` may carry: the supervisor's own words, so the `host_stopped` event says which. A halt is `halted`. */
export const STOP_REASONS = ["stopped_by_person", "machine_shutdown", "halted", "operate_off"] as const;
export type ChannelStopReason = (typeof STOP_REASONS)[number];
export const FRAME_MAX = 128 * 1024;
export const TOKEN_MAX = 4096;
export const EVENTS_READ_MAX = 64 * 1024;
export const CONNECTION_IDLE_MS = 30_000;
/** The one line the program prints once it listens; the standard tier's unit waits for it (it said the same while it was an idle holder). */
export const SESSION_READY_LINE = "fx-engine-session-ready";
export const SESSION_CONFIG_FILE = "session.json";
export const CHANNEL_SOCKET = "channel.sock";

export type ChannelCode = "bad_request" | "command_unverified" | "no_session_config" | "stopped" | "refused" | "host_not_running" | "host_ended" | "internal";
export type ChannelReply = { ok: true; [key: string]: unknown } | { ok: false; code: ChannelCode; reason?: string };

/** What the machine gives the module; `scripts/engine-supervise-host.mjs` is the one real implementation (src/ never names a child-spawning module). */
export interface GuestRuntime {
  uid: number;
  ownPid: number;
  claudePath: string;
  /** A fixed allowlist, never a credential. */
  env: Record<string, string>;
  launch: (spec: HostSpawnSpec) => HostChild;
  isAlive: (pid: number) => boolean;
  startOf: (pid: number) => string | undefined;
  killHost: (handle: EngineHostHandle) => Promise<unknown>;
  killScope: (unit: string) => Promise<void>;
  now: () => number;
  after: (ms: number, fn: () => void) => () => void;
}

export interface GuestSessionOptions {
  /** The session's state directory (0700, owned by `runtime.uid`). */
  dir: string;
  runtime: GuestRuntime;
  /** ON-13b2: the pinned keys a signed command is checked against, by cloud address (the build's own table by default; a test hands in its own). */
  keyrings?: PinnedKeyrings | undefined;
}

export interface GuestSession {
  request(header: unknown, body?: Buffer): Promise<ChannelReply>;
  /** Listens on `socketPath` (0600, one request per connection). */
  serve(socketPath: string): Promise<{ close(): Promise<void> }>;
  /** The supervisor ended (a stop, `crash_loop`, a refusal while restarting); undefined while it runs or before it started. */
  ended(): StopReason | undefined;
  /** Settles once a channel `stop` has been answered or the supervisor has ended on its own (`crash_loop`): the credential is wiped and the PROGRAM must now exit, so no copy of the token survives in its memory. */
  finished(): Promise<void>;
}

const KEYS: Record<ChannelOp, readonly string[]> = { tick: ["kind", "name"], command: ["command"], stop: ["reason"], events_read: ["after", "stream"], token_put: ["name", "size"] };
const PRINTABLE = /^[\x21-\x7e]+$/;
const fail = (code: ChannelCode, reason?: string): ChannelReply => (reason === undefined ? { ok: false, code } : { ok: false, code, reason });
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

export function createGuestSession(options: GuestSessionOptions): GuestSession {
  const { dir, runtime: rt } = options;
  ensurePrivateDir(dir, rt.uid);
  const log = openHostLog(dir, rt.uid);
  const spool = createEventSpool({ dir, uid: rt.uid, now: rt.now });
  let secret: Buffer | undefined;
  let operating = true;
  let started = false;
  let ended: StopReason | undefined;
  let windowStart = rt.now();
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => void (finish = resolve));
  const wipe = (): void => {
    secret?.fill(0);
    secret = undefined;
  };
  let ticks: GuestTicks | undefined;
  const outcomes = openHostLog(dir, rt.uid, SPOOL_MAX_BYTES, OUTCOMES_FILE);
  const config = (): { repo_gh_id: string; repo_checkout: string; runner_id?: string; cloud_origin?: string } | undefined => {
    try {
      const raw = readJsonNoFollow(dir, SESSION_CONFIG_FILE, rt.uid) as { repo_gh_id?: unknown; repo_checkout?: unknown; runner_id?: unknown; cloud_origin?: unknown } | null | undefined;
      const id = raw?.repo_gh_id;
      const checkout = raw?.repo_checkout;
      const short = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 256 ? v : undefined);
      const [runner, origin] = [short(raw?.runner_id), short(raw?.cloud_origin)];
      return typeof id === "string" && isRepoGhId(id) && typeof checkout === "string" && path.isAbsolute(checkout) && path.normalize(checkout) === checkout ? { repo_gh_id: id, repo_checkout: checkout, ...(runner === undefined ? {} : { runner_id: runner }), ...(origin === undefined ? {} : { cloud_origin: origin }) } : undefined;
    } catch {
      // fx-swallow-ok: a config that cannot be read safely is no config; the tick answers `no_session_config` and nothing is started
      return undefined;
    }
  };
  /** Raw counts of one window of the host's model use; the window is the time since the previous `result`. */
  const usageTick = (turn: TurnResult): void => {
    const at = rt.now();
    const seconds = Math.min(ENGINE_DURATION_S_MAX, Math.max(0, Math.round((at - windowStart) / 1000)));
    windowStart = at;
    if (turn.usage === undefined) return;
    const tier = turn.model !== undefined && MODEL_TIER_PATTERN.test(turn.model) ? turn.model : "unknown";
    spool.write({ kind: "usage_tick", model_tier: tier, input_tokens: turn.usage.input, output_tokens: turn.usage.output, cache_read_tokens: turn.usage.cache_read, cache_write_tokens: turn.usage.cache_write, window_s: seconds });
  };
  const supervisor: Supervisor = createSupervisor({
    stateDir: dir,
    uid: rt.uid,
    platform: "linux",
    claudePath: rt.claudePath,
    // The VM (or the unit) is the boundary: the host is started directly, and the kill path is its group of programs.
    scopeAvailable: async () => true,
    wrapLaunch: (program, args) => ({ file: program, args }),
    readBridgeState: (): BridgeState | undefined => {
      const c = config();
      return c === undefined ? undefined : { ...c, bridge_enabled: true, operate_enabled: operating, written_at: rt.now() };
    },
    launch: rt.launch,
    env: rt.env,
    secretEnv: () => (secret === undefined ? undefined : { [SUBSCRIPTION_TOKEN_VAR]: secret.toString("latin1") }),
    log,
    emit: (e) => void spool.write(e),
    now: rt.now,
    after: rt.after,
    isAlive: rt.isAlive,
    startTimeOf: rt.startOf,
    isOurHost: (h) => rt.isAlive(h.pid) && h.start_time !== undefined && rt.startOf(h.pid) === h.start_time,
    claimer: { pid: rt.ownPid, start: rt.startOf(rt.ownPid) },
    acquireLock: () => acquireHostLock(dir, rt.uid, { ownPid: rt.ownPid, isAlive: rt.isAlive, startOf: rt.startOf }),
    killHost: rt.killHost,
    killScope: rt.killScope,
    sessionStore: openSessionStore(dir, rt.uid),
    observer: {
      onTurn: (turn) => {
        usageTick(turn);
        ticks?.ticker.onTurn(turn);
      },
      onExit: () => ticks?.ticker.onHostExit(),
      onCompaction: () => ticks?.ticker.onCompaction(),
    },
  });
  void supervisor.stopped.then((reason) => {
    ended = reason;
    wipe();
    ticks?.ticker.close();
    outcomes.close();
    finish();
  });
  /** The ticker, made once the host is up: it needs the repository id the config names. */
  function startTicks(repoGhId: number, checkout: string): GuestTicks {
    const feed = createAgentFeed({ dir, uid: rt.uid });
    const made = createGuestTicks({
      send: (text) => supervisor.send(text),
      touch: () => supervisor.touch(),
      emit: (e) => void spool.write(e),
      now: rt.now,
      after: rt.after,
      settings: () => tickSettingsOf(checkout, rt.uid),
      credentialMode: () => credentialModeOf(supervisor.keySource()),
      repoGhId,
      // the VM or the unit is the boundary; what can stop a command here is the session's own end (a halt is a stop of the session: nothing is applied after it)
      gate: () => (operating ? undefined : "operate_off"),
      answered: openAnsweredStore(dir, rt.uid),
      agentEvents: feed.poll,
      log: (line) => void log.write(`${line}\n`),
      outcome: (name, ack: EngineCommandAck) => outcomes.write(`${JSON.stringify({ name, ack })}\n`),
    });
    made.ticker.start();
    return made;
  }

  async function tick(kind: (typeof TICK_KINDS)[number], name: string | undefined): Promise<ChannelReply> {
    if (!operating) return fail("stopped");
    if (ended !== undefined) return fail("host_ended", ended);
    let first = false;
    if (!started) {
      const cfg = config();
      if (cfg === undefined) return fail("no_session_config");
      const result = await supervisor.start();
      if (!result.ok) return fail("refused", result.reason);
      started = first = true;
      ticks = startTicks(Number(cfg.repo_gh_id), cfg.repo_checkout);
    }
    return ticks?.ticker.request(kind, name) === true ? { ok: true, started: first } : fail("bad_request");
  }

  /** The signed command, checked again here (see `guestTicks.ts`), then applied by the ticker. `command_unverified` for everything that does not check out, and for a session with no key pinned for its cloud. */
  function command(raw: unknown): ChannelReply {
    const cfg = config();
    const keyring = cfg?.cloud_origin === undefined ? undefined : keyringFor(cfg.cloud_origin, options.keyrings);
    const verified = cfg?.runner_id === undefined || keyring === undefined ? undefined : verifyCommandWith(raw, { keyring, runnerId: cfg.runner_id, repoGhId: Number(cfg.repo_gh_id), now: new Date(rt.now()) });
    if (verified === undefined) return fail("command_unverified");
    if (!operating) return fail("stopped");
    if (ended !== undefined) return fail("host_ended", ended);
    return ticks === undefined ? fail("host_not_running") : { ok: true, name: ticks.submit(verified) };
  }

  async function stop(reason: ChannelStopReason): Promise<ChannelReply> {
    operating = false;
    wipe(); // before the host is touched: nothing that can still launch it holds the credential
    if (started) await supervisor.stop(reason);
    else {
      supervisor.cleanup();
      outcomes.close();
    }
    finish();
    // `pid` is this program's own: the guest answers before it exits, and the runner confirms it is gone (through the guest agent) before anything is snapshotted
    return { ok: true, survivors: supervisor.survivors(), token_wiped: secret === undefined, pid: rt.ownPid };
  }

  function eventsRead(after: number, file: string): ChannelReply {
    let fd = -1;
    try {
      fd = openSync(path.join(dir, file), constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.uid !== rt.uid || (st.mode & 0o022) !== 0) return { ok: true, lines: [], ends: [], next: 0, reset: false };
      const reset = after > st.size;
      const from = reset ? 0 : after;
      const buf = Buffer.alloc(Math.min(st.size - from, EVENTS_READ_MAX));
      const got = readSync(fd, buf, 0, buf.length, from);
      const whole = buf.subarray(0, buf.subarray(0, got).lastIndexOf(0x0a) + 1);
      // a window with no line end in it (a line longer than the window) would stall the reader for ever: it is handed over as one junk line spanning the window, which the reader judges and drops
      if (whole.length === 0 && got > 0 && got === buf.length && buf.length === EVENTS_READ_MAX) return { ok: true, lines: ["#"], ends: [from + got], next: from + got, reset };
      const lines = whole.toString("utf8").split("\n").slice(0, -1);
      // the end of each line in the FILE's bytes (a line of invalid UTF-8 would not re-encode to its own length, so the reader cannot work this out from the text)
      let end = from;
      const ends = whole.toString("latin1").split("\n").slice(0, -1).map((raw) => (end += raw.length + 1));
      return { ok: true, lines, ends, next: from + whole.length, reset };
    } catch {
      // fx-swallow-ok: no spool yet (nothing has happened) or one that cannot be read safely reads as no events; the caller asks again from where it was
      return { ok: true, lines: [], ends: [], next: after, reset: false };
    } finally {
      if (fd !== -1) closeSync(fd);
    }
  }

  async function request(header: unknown, body?: Buffer): Promise<ChannelReply> {
    if (typeof header !== "object" || header === null || Array.isArray(header)) return fail("bad_request");
    const h = header as Record<string, unknown>;
    const op = h["op"];
    if (typeof op !== "string" || !(CHANNEL_OPS as readonly string[]).includes(op)) return fail("bad_request");
    if (Object.keys(h).some((k) => k !== "op" && !KEYS[op as ChannelOp].includes(k))) return fail("bad_request");
    try {
      switch (op as ChannelOp) {
        case "tick": {
          const kind = h["kind"];
          const name = h["name"];
          const known = (TICK_KINDS as readonly unknown[]).includes(kind);
          const shaped = kind === "checkin" ? typeof name === "string" && ROW_KEY_PATTERN.test(name) : name === undefined;
          return known && shaped ? await tick(kind as (typeof TICK_KINDS)[number], name as string | undefined) : fail("bad_request");
        }
        case "command":
          return command(h["command"]);
        case "stop": {
          const reason = h["reason"] ?? "stopped_by_person";
          return (STOP_REASONS as readonly unknown[]).includes(reason) ? await stop(reason as ChannelStopReason) : fail("bad_request");
        }
        case "events_read": {
          const stream = h["stream"] ?? "events";
          return isInt(h["after"], 0, Number.MAX_SAFE_INTEGER) && (stream === "events" || stream === "outcomes" || stream === "engine") ? eventsRead(h["after"], stream === "events" ? SPOOL_FILE : stream === "engine" ? ENGINE_EVENTS_FILE : OUTCOMES_FILE) : fail("bad_request");
        }
        case "token_put": {
          const size = h["size"];
          if (h["name"] !== "claude" || !isInt(size, 1, TOKEN_MAX) || body === undefined || body.length !== size || !PRINTABLE.test(body.toString("latin1"))) return fail("bad_request");
          if (!operating) return fail("stopped");
          wipe();
          secret = Buffer.from(body);
          return { ok: true };
        }
      }
    } catch {
      // fx-swallow-ok: nothing a handler throws may reach the peer as text; the fixed code is the whole answer
      return fail("internal");
    }
  }

  async function serve(socketPath: string): Promise<{ close(): Promise<void> }> {
    // A socket a dead supervisor left is replaced; anything else at the name (a link, a file) is refused by the listen below.
    if (lstatSync(socketPath, { throwIfNoEntry: false })?.isSocket() === true) unlinkSync(socketPath);
    const server = net.createServer((sock) => void connection(sock));
    server.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: socketPath }, () => {
        chmodSync(socketPath, 0o600);
        resolve();
      });
    });
    return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  /** One request: frame, optional raw bytes (token_put), one reply frame, close. Every buffer a token passed through is zeroed. */
  async function connection(sock: net.Socket): Promise<void> {
    sock.setTimeout(CONNECTION_IDLE_MS, () => sock.destroy());
    sock.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    const iterator = sock[Symbol.asyncIterator]();
    const take = async (n: number): Promise<Buffer> => {
      while (buf.length < n) {
        const next = await iterator.next();
        if (next.done === true) throw new Error("closed");
        const old = buf;
        buf = Buffer.concat([old, next.value as Buffer]);
        old.fill(0);
        (next.value as Buffer).fill(0);
      }
      const out = Buffer.from(buf.subarray(0, n));
      buf.fill(0, 0, n);
      buf = buf.subarray(n);
      return out;
    };
    let reply: ChannelReply = fail("bad_request");
    let body: Buffer | undefined;
    try {
      const length = (await take(4)).readUInt32BE(0);
      if (length > 0 && length <= FRAME_MAX) {
        const header = JSON.parse((await take(length)).toString("utf8")) as unknown;
        const size = (header as { size?: unknown } | null)?.size;
        if ((header as { op?: unknown } | null)?.op === "token_put" && isInt(size, 1, TOKEN_MAX)) body = await take(size);
        reply = await request(header, body);
      }
    } catch {
      // fx-swallow-ok: a frame that does not parse, or a peer that went away, is `bad_request` (or nothing to answer to)
    } finally {
      body?.fill(0);
      buf.fill(0);
    }
    const out = Buffer.from(JSON.stringify(reply));
    const frame = Buffer.alloc(4 + out.length);
    frame.writeUInt32BE(out.length, 0);
    out.copy(frame, 4);
    sock.end(frame);
  }

  return { request, serve, ended: () => ended, finished: () => finished };
}
