import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guestRuntime, runEngineSupervise } from "../../scripts/engine-supervise-host.mjs";
import { CHANNEL_OPS, CHANNEL_SOCKET, SESSION_READY_LINE, createGuestSession, EVENTS_READ_MAX, FRAME_MAX, SESSION_CONFIG_FILE, TOKEN_MAX, type ChannelReply, type GuestRuntime, type GuestSession } from "../../src/engineHost/guestSession.js";
import { EngineCommand, signEngineCommand } from "@fulcrumaxe/runner-protocol";
import { originHash, type PinnedKeyrings } from "../../src/keyring.js";
import { renderPrompt } from "../../src/engineHost/prompts.js";
import { HOST_LOG_FILE, HOST_LOG_MAX_BYTES } from "../../src/engineHost/hostFiles.js";
import { SPOOL_FILE } from "../../src/engineHost/hostFeeds.js";
import { BACKOFF_MS, CRASH_LIMIT, FILE_BEAT_MS, HOST_ARGS } from "../../src/engineHost/supervisor.js";
import { unixSocketsRefused } from "../helpers/needsHostSockets.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";
import { tempDir } from "../helpers/tempTree.js";

/**
 * D#845 ON-13b1: the engine session's supervisor and its channel, with a stand-in for the model CLI (no model is ever called). The stand-in is a node script that speaks the stream-json contract; it runs with a PRIVATE PATH
 * (a directory of its own and nothing that holds a `claude`, `gh` or git credential helper), and the supervisor module is the real one over the real spawn (`scripts/engine-supervise-host.mjs`).
 */
const TOKEN = `fake-synthetic-${"x".repeat(24)}`;
const SID = "e6a767e1-7e3f-44a4-bfb1-3c331803d4ee";

const FAKE = `#!${process.execPath}
const fs = require("fs");
const rec = process.env.FAKE_RECORD, mode = process.env.FAKE_MODE;
const log = (o) => fs.appendFileSync(rec, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
log({ event: "start", pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), tokenSeen: token === ${JSON.stringify(TOKEN)}, tokenEnvSet: token !== undefined });
out({ type: "system", subtype: "init", session_id: "${SID}", apiKeySource: "none" });
if (mode === "echo") {
  // a tool output that echoes the credential: whole on stdout, split across two writes, and on stderr
  process.stdout.write("tool said " + token + " done\\n");
  process.stdout.write("split " + token.slice(0, 20));
  setTimeout(() => process.stdout.write(token.slice(20) + " end\\n"), 150);
  process.stderr.write("err " + token + "\\n");
}
if (mode === "crash") process.exit(3);
if (mode === "late") {
  // the host leaves, and a process it started (sharing its stdout) writes the credential after the exit: that output must still be redacted and kept, including its held-back tail
  require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write('late ' + process.env.CLAUDE_CODE_OAUTH_TOKEN + ' end' + String.fromCharCode(10)), 300)"], { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  process.exit(0);
}
const result = (extra) => out({ type: "result", subtype: "success", is_error: false, session_id: "${SID}", usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 }, modelUsage: { [process.env.FAKE_MODEL || "claude-haiku-4-5"]: {} }, ...extra });
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    log({ event: "user", role: m.message.role, content: m.message.content });
    if (mode === "flood") { const line = JSON.stringify({ type: "assistant", pad: "x".repeat(1000) }) + "\\n"; for (let n = 0; n < 21 * 1024; n++) process.stdout.write(line); }
    if (mode === "hold") continue; // a turn that never ends (single flight)
    if (mode === "nousage") out({ type: "result", subtype: "error_max_turns", is_error: true });
    else if (mode === "echo") setTimeout(result, 400); // after the split write has completed its line
    else result();
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean | Promise<boolean>, what: string, tries = 400): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

interface Rig {
  dir: string;
  scratch: string;
  record: string;
  session: GuestSession;
  ask: (header: unknown, body?: Buffer) => Promise<ChannelReply>;
  starts: () => Array<{ pid: number; argv: string[]; cwd: string; tokenSeen: boolean; tokenEnvSet: boolean }>;
  users: () => string[];
  events: () => Array<Record<string, unknown>>;
}

const rigs: Rig[] = [];
/** A session over a fresh state directory, a checkout, the stand-in CLI and a PRIVATE PATH. `tune` may replace the clock and the timers. */
function rig(mode: string, tune: (rt: GuestRuntime) => GuestRuntime = (rt) => rt, config = true, model?: string, extra: { keyrings?: PinnedKeyrings; session?: Record<string, unknown> } = {}): Rig {
  const scratch = tempDir("fx-gs-");
  const bin = path.join(scratch, "bin");
  mkdirSync(bin);
  const claude = path.join(bin, "host-standin");
  writeFileSync(claude, FAKE);
  chmodSync(claude, 0o755);
  const checkout = path.join(scratch, "checkout");
  mkdirSync(checkout);
  const dir = path.join(scratch, "state");
  const record = path.join(scratch, "record.jsonl");
  const priv = path.join(scratch, "path");
  mkdirSync(priv);
  // the child's whole PATH is this empty directory: the real claude, gh and a credential helper are unreachable (asserted in the first test)
  const runtime = tune(guestRuntime({ claudePath: claude, env: { PATH: priv, HOME: scratch, FAKE_MODE: mode, FAKE_RECORD: record, ...(model === undefined ? {} : { FAKE_MODEL: model }) } }));
  const session = createGuestSession({ dir, runtime, ...(extra.keyrings === undefined ? {} : { keyrings: extra.keyrings }) });
  if (config) {
    writeFileSync(path.join(dir, SESSION_CONFIG_FILE), JSON.stringify({ repo_gh_id: "424242", repo_checkout: checkout, ...extra.session }), { mode: 0o600 });
  }
  const read = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");
  const r: Rig = {
    dir,
    scratch,
    record,
    session,
    ask: (header, body) => session.request(header, body),
    starts: () => read(record).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((o) => o["event"] === "start") as ReturnType<Rig["starts"]>,
    users: () => read(record).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((o) => o["event"] === "user").map((o) => String(o["content"])),
    events: () => read(path.join(dir, SPOOL_FILE)).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
  };
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.ask({ op: "stop" }).catch(() => undefined); // fx-swallow-ok: a session that already ended has nothing more to stop
});

const tokenBody = (t = TOKEN): Buffer => Buffer.from(t, "latin1");

describe("the stand-in's isolation", () => {
  it("runs with a private PATH that reaches no claude, gh or git credential helper", () => {
    const r = rig("ok");
    const priv = path.join(r.scratch, "path");
    expect(readdirSync(priv)).toEqual([]);
    for (const name of ["claude", "gh"]) expect(existsSync(path.join(priv, name))).toBe(false);
    expect(readdirSync(priv).filter((n) => n.startsWith("git-credential"))).toEqual([]);
  });
});

describe("the channel's closed messages", () => {
  it("the operations are exactly tick, command, stop, events_read and token_put", () => {
    expect([...CHANNEL_OPS]).toEqual(["tick", "command", "stop", "events_read", "token_put"]);
  });

  it("refuses anything that is not one of them, or carries a key outside its shape", async () => {
    const r = rig("ok");
    for (const bad of [null, [], "tick", 7, {}, { op: "exec", text: "x" }, { op: "tick" }, { op: "tick", text: "free text" }, { op: "tick", kind: "nap" }, { op: "tick", kind: "loop", name: "x" }, { op: "tick", kind: "checkin" }, { op: "tick", kind: "checkin", name: "Bad Name" }, { op: "tick", kind: "loop", extra: 1 }, { op: "stop", reason: "weekend" }, { op: "events_read", after: -1 }, { op: "events_read", after: 1.5 }, { op: "events_read" }, { op: "events_read", after: 0, stream: "x" }, { op: "command", command: {}, x: 1 }]) {
      expect(await r.ask(bad), JSON.stringify(bad)).toEqual({ ok: false, code: "bad_request" });
    }
    expect(r.starts()).toEqual([]);
  });

  it("tick answers no_session_config before the config exists, and starts nothing", async () => {
    const r = rig("ok", (rt) => rt, false);
    expect(await r.ask({ op: "tick", kind: "loop" })).toEqual({ ok: false, code: "no_session_config" });
    expect(r.starts()).toEqual([]);
  });

  it("tick starts the host on the first message and sends each tick as one stream-json user message with the fixed argument vector", async () => {
    const r = rig("ok");
    expect(await r.ask({ op: "tick", kind: "loop" })).toEqual({ ok: true, started: true });
    expect(await r.ask({ op: "tick", kind: "loop" })).toEqual({ ok: true, started: false });
    await until(() => r.users().length === 2, "both messages");
    expect(r.users()).toEqual([renderPrompt("loop"), renderPrompt("loop")]);
    const [start, ...more] = r.starts();
    expect(more).toEqual([]);
    expect(start?.argv).toEqual([...HOST_ARGS]);
    expect(start?.argv.join(" ")).not.toMatch(/permission|dangerous|bypass|skip/i);
    expect(start?.cwd).toBe(path.join(r.scratch, "checkout"));
    expect(start?.tokenEnvSet).toBe(false);
  });

});

describe("usage_tick", () => {
  it("each result with all four totals is one usage_tick event of raw counts, with the model and a window", async () => {
    const r = rig("ok");
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.events().some((e) => e["kind"] === "usage_tick"), "a usage_tick");
    const tick = r.events().find((e) => e["kind"] === "usage_tick");
    expect(tick).toMatchObject({ v: 1, kind: "usage_tick", model_tier: "claude-haiku-4-5", input_tokens: 11, output_tokens: 22, cache_read_tokens: 33, cache_write_tokens: 44 });
    expect(typeof tick?.["window_s"]).toBe("number");
    expect(Object.keys(tick ?? {}).sort()).toEqual(["cache_read_tokens", "cache_write_tokens", "engine_instance_id", "input_tokens", "kind", "model_tier", "output_tokens", "seq", "ts", "v", "window_s"]);
  });

  it("a model the tier pattern does not accept is 'unknown', and a result with no usage is not a tick at all", async () => {
    const odd = rig("ok", (rt) => rt, true, "Not A Model");
    await odd.ask({ op: "tick", kind: "loop" });
    await until(() => odd.events().some((e) => e["kind"] === "usage_tick"), "a usage_tick");
    expect(odd.events().find((e) => e["kind"] === "usage_tick")?.["model_tier"]).toBe("unknown");
    const none = rig("nousage");
    await none.ask({ op: "tick", kind: "loop" });
    await until(() => none.users().length === 1, "the message");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(none.events().filter((e) => e["kind"] === "usage_tick")).toEqual([]);
  });
});

describe("events_read", () => {
  it("returns whole lines from a byte offset, continues from `next`, and answers reset when the file is shorter than the offset", async () => {
    const r = rig("ok");
    expect(await r.ask({ op: "events_read", after: 0 })).toEqual({ ok: true, lines: [], ends: [], next: 0, reset: false });
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.events().some((e) => e["kind"] === "usage_tick"), "a usage_tick");
    const first = (await r.ask({ op: "events_read", after: 0 })) as unknown as { lines: string[]; next: number; reset: boolean };
    expect(first.reset).toBe(false);
    expect(first.lines.length).toBeGreaterThanOrEqual(2);
    expect(first.lines.map((l) => (JSON.parse(l) as { kind: string }).kind)).toContain("host_started");
    expect(first.next).toBe(statSync(path.join(r.dir, SPOOL_FILE)).size);
    expect(await r.ask({ op: "events_read", after: first.next })).toEqual({ ok: true, lines: [], ends: [], next: first.next, reset: false });
    const past = (await r.ask({ op: "events_read", after: first.next + 100000 })) as unknown as { lines: string[]; reset: boolean };
    expect(past.reset).toBe(true);
    expect(past.lines).toEqual(first.lines);
  });

  it("`engine` reads the engine's own events file inside the guest, with the exact end of each line, and no other stream reads it", async () => {
    const r = rig("ok");
    const file = path.join(r.dir, "engine-events.jsonl");
    expect(await r.ask({ op: "events_read", after: 0, stream: "engine" })).toEqual({ ok: true, lines: [], ends: [], next: 0, reset: false });
    writeFileSync(file, `{"a":1}\n{"é":2}\npartial`, { mode: 0o600 });
    const second = 8 + Buffer.byteLength('{"é":2}') + 1;
    expect(await r.ask({ op: "events_read", after: 0, stream: "engine" })).toEqual({ ok: true, lines: ['{"a":1}', '{"é":2}'], ends: [8, second], next: second, reset: false });
    expect(await r.ask({ op: "events_read", after: 8, stream: "engine" })).toMatchObject({ lines: ['{"é":2}'], ends: [second] });
    expect(await r.ask({ op: "events_read", after: second + 100, stream: "engine" })).toMatchObject({ reset: true, ends: [8, second] });
    // the host's own stream and the outcomes are other files
    expect(await r.ask({ op: "events_read", after: 0 })).toMatchObject({ lines: [] });
    expect(await r.ask({ op: "events_read", after: 0, stream: "outcomes" })).toMatchObject({ lines: [] });
    // a file open to others reads as nothing, as the other streams' do
    chmodSync(file, 0o666);
    expect(await r.ask({ op: "events_read", after: 0, stream: "engine" })).toEqual({ ok: true, lines: [], ends: [], next: 0, reset: false });
  });

  it("keeps the true byte end of a line that is not valid UTF-8, and hands over a window with no line end as one junk line", async () => {
    const r = rig("ok");
    const file = path.join(r.dir, "engine-events.jsonl");
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from("ok\n")]), { mode: 0o600 });
    const got = (await r.ask({ op: "events_read", after: 0, stream: "engine" })) as unknown as { lines: string[]; ends: number[]; next: number };
    expect(got.ends).toEqual([3, 6]);
    expect(got.next).toBe(6);
    writeFileSync(file, "x".repeat(EVENTS_READ_MAX + 10), { mode: 0o600 });
    expect(await r.ask({ op: "events_read", after: 0, stream: "engine" })).toEqual({ ok: true, lines: ["#"], ends: [EVENTS_READ_MAX], next: EVENTS_READ_MAX, reset: false });
  });

  it("never returns more than EVENTS_READ_MAX bytes at a time and never a partial line", async () => {
    const r = rig("ok");
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.events().length >= 2, "events");
    writeFileSync(path.join(r.dir, SPOOL_FILE), `${"a".repeat(1000)}\n`.repeat(200) + "partial", { mode: 0o600 });
    const got = (await r.ask({ op: "events_read", after: 0 })) as unknown as { lines: string[]; next: number };
    expect(got.next).toBeLessThanOrEqual(EVENTS_READ_MAX);
    expect(got.lines.every((l) => l === "a".repeat(1000))).toBe(true);
    expect(got.next).toBe(got.lines.length * 1001);
  });
});

describe("token_put and the wipe", () => {
  it("refuses a token that is not 1..4096 printable ASCII bytes of the stated size, or not named claude", async () => {
    const r = rig("ok");
    for (const [header, body] of [
      [{ op: "token_put", name: "claude", size: 5 }, tokenBody("abc")],
      [{ op: "token_put", name: "claude", size: 3 }, tokenBody("abcde")],
      [{ op: "token_put", name: "claude", size: 0 }, Buffer.alloc(0)],
      [{ op: "token_put", name: "claude", size: TOKEN_MAX + 1 }, Buffer.alloc(TOKEN_MAX + 1, 0x61)],
      [{ op: "token_put", name: "claude", size: 4 }, Buffer.from([0x61, 0x20, 0x62, 0x63])],
      [{ op: "token_put", name: "claude", size: 4 }, Buffer.from([0x61, 0x0a, 0x62, 0x63])],
      [{ op: "token_put", name: "github", size: 3 }, tokenBody("abc")],
      [{ op: "token_put", name: "claude", size: 3, token: "abc" }, tokenBody("abc")],
      [{ op: "token_put", name: "claude", size: 3 }, undefined],
    ] as Array<[Record<string, unknown>, Buffer | undefined]>) {
      expect(await r.ask(header, body), JSON.stringify(header)).toEqual({ ok: false, code: "bad_request" });
    }
  });

  it("a token reaches the host's environment at launch only, and is in no reply, log, spool or event", async () => {
    const r = rig("ok");
    const replies: ChannelReply[] = [await r.ask({ op: "token_put", name: "claude", size: TOKEN.length }, tokenBody())];
    replies.push(await r.ask({ op: "tick", kind: "loop" }));
    await until(() => r.events().some((e) => e["kind"] === "usage_tick"), "a usage_tick");
    replies.push(await r.ask({ op: "events_read", after: 0 }));
    expect(r.starts()[0]?.tokenSeen).toBe(true);
    replies.push(await r.ask({ op: "stop" }));
    expect(JSON.stringify(replies)).not.toContain(TOKEN);
    const all = (d: string): string[] => readdirSync(d).map((f) => path.join(d, f));
    for (const file of all(r.dir)) expect(readFileSync(file, "latin1"), file).not.toContain(TOKEN);
  });

  it("stop wipes first: the reply says so, the host process is gone, and nothing more is accepted or started", async () => {
    const r = rig("ok");
    await r.ask({ op: "token_put", name: "claude", size: TOKEN.length }, tokenBody());
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.users().length === 1, "the message");
    const pid = r.starts()[0]?.pid ?? -1;
    expect(alive(pid)).toBe(true);
    expect(await r.ask({ op: "stop", reason: "machine_shutdown" })).toEqual({ ok: true, survivors: 0, token_wiped: true, pid: process.pid });
    await until(() => !alive(pid), "the host to be gone");
    expect(await r.ask({ op: "tick", kind: "loop" })).toEqual({ ok: false, code: "stopped" });
    expect(await r.ask({ op: "token_put", name: "claude", size: 3 }, tokenBody("abc"))).toEqual({ ok: false, code: "stopped" });
    expect(r.events().map((e) => e["kind"])).toContain("host_stopped");
    expect(r.events().find((e) => e["kind"] === "host_stopped")?.["reason"]).toBe("machine_shutdown");
  });

  it("a second token_put replaces the first, and a host started afterwards carries only the second", async () => {
    const r = rig("ok");
    await r.ask({ op: "token_put", name: "claude", size: 3 }, tokenBody("one"));
    await r.ask({ op: "token_put", name: "claude", size: TOKEN.length }, tokenBody());
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.starts().length === 1, "the start");
    expect(r.starts()[0]?.tokenSeen).toBe(true);
  });

  it("stop without a start still wipes and answers", async () => {
    const r = rig("ok");
    await r.ask({ op: "token_put", name: "claude", size: 3 }, tokenBody("abc"));
    expect(await r.ask({ op: "stop" })).toEqual({ ok: true, survivors: 0, token_wiped: true, pid: process.pid });
    expect(r.starts()).toEqual([]);
  });
});

describe("restarts and crash_loop", () => {
  it("a crashing host restarts after 1, 2, then 5 minutes (with --resume), and the sixth crash is crash_loop: the session ends and takes no more ticks", async () => {
    const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
    let clock = Date.parse("2026-11-26T12:00:00Z");
    const r = rig("crash", (rt) => ({
      ...rt,
      now: () => clock,
      after: (ms, fn) => {
        const t = { ms, fn, cancelled: false };
        timers.push(t);
        return () => void (t.cancelled = true);
      },
    }));
    expect(await r.ask({ op: "tick", kind: "loop" })).toMatchObject({ ok: true, started: true });
    const waits: number[] = [];
    for (let crash = 1; crash < CRASH_LIMIT; crash++) {
      // the dead host's own 15 s file beat is cancelled when its exit is seen: only then is the one live timer the back-off
      await until(() => !timers.some((t) => !t.cancelled && t.ms === FILE_BEAT_MS) && timers.some((t) => !t.cancelled && (BACKOFF_MS as readonly number[]).includes(t.ms)), `back-off ${crash}`);
      const t = timers.find((x) => !x.cancelled && (BACKOFF_MS as readonly number[]).includes(x.ms)) as { ms: number; fn: () => void; cancelled: boolean };
      waits.push(t.ms);
      t.cancelled = true;
      clock += t.ms;
      t.fn();
      await until(() => r.starts().length === crash + 1, `restart ${crash}`);
    }
    expect(waits).toEqual([60_000, 120_000, 300_000, 300_000, 300_000]);
    await until(() => r.session.ended() === "crash_loop", "crash_loop");
    expect(r.starts().length).toBe(CRASH_LIMIT);
    expect(r.starts()[0]?.argv).toEqual([...HOST_ARGS]);
    expect(r.starts()[1]?.argv).toEqual([...HOST_ARGS, "--resume", SID]);
    expect(await r.ask({ op: "tick", kind: "loop" })).toEqual({ ok: false, code: "host_ended", reason: "crash_loop" });
    const stopped = r.events().filter((e) => e["kind"] === "host_stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.["reason"]).toBe("crash_loop");
  });
});

describe("the 20 MB rotating guest log", () => {
  it("is the host log's own default size and rotates to .1 when the host's stream passes it, never growing past it", async () => {
    expect(HOST_LOG_MAX_BYTES).toBe(20 * 1024 * 1024);
    const r = rig("flood");
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => existsSync(path.join(r.dir, `${HOST_LOG_FILE}.1`)), "the log to rotate", 800);
    await until(() => r.events().some((e) => e["kind"] === "usage_tick"), "the turn to end", 800);
    expect(statSync(path.join(r.dir, HOST_LOG_FILE)).size).toBeLessThanOrEqual(HOST_LOG_MAX_BYTES);
    expect(statSync(path.join(r.dir, `${HOST_LOG_FILE}.1`)).size).toBeLessThanOrEqual(HOST_LOG_MAX_BYTES);
    expect(statSync(path.join(r.dir, HOST_LOG_FILE)).mode & 0o077).toBe(0);
  }, 60_000);
});

/** The socket framing, over a real unix socket: one request per connection. */
const sockets = unixSocketsRefused();
describe.skipIf(sockets)("the socket", () => {
  const ask = (file: string, parts: Buffer[]): Promise<ChannelReply | undefined> =>
    new Promise((resolve) => {
      const c = net.connect(file);
      const got: Buffer[] = [];
      c.on("error", () => resolve(undefined));
      c.on("data", (d) => got.push(d));
      c.on("close", () => {
        const all = Buffer.concat(got);
        resolve(all.length < 4 ? undefined : (JSON.parse(all.subarray(4, 4 + all.readUInt32BE(0)).toString("utf8")) as ChannelReply));
      });
      for (const p of parts) c.write(p);
    });
  const frame = (o: unknown): Buffer => {
    const body = Buffer.from(JSON.stringify(o));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    return Buffer.concat([head, body]);
  };

  it("answers one framed request per connection, takes the token's raw bytes after the frame, and refuses an oversize or unparseable frame", async () => {
    const r = rig("ok");
    const sockDir = tempDir("fxs-", socketTmpRoot());
    const file = path.join(sockDir, CHANNEL_SOCKET);
    const listening = await r.session.serve(file);
    try {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(await ask(file, [frame({ op: "events_read", after: 0 })])).toEqual({ ok: true, lines: [], ends: [], next: 0, reset: false });
      expect(await ask(file, [frame({ op: "token_put", name: "claude", size: TOKEN.length }), tokenBody()])).toEqual({ ok: true });
      // the frame and the token split across writes, the way a vsock bridge delivers them
      const split = Buffer.concat([frame({ op: "token_put", name: "claude", size: 3 }), tokenBody("abc")]);
      expect(await ask(file, [split.subarray(0, 3), split.subarray(3, 9), split.subarray(9)])).toEqual({ ok: true });
      const head = Buffer.alloc(4);
      head.writeUInt32BE(FRAME_MAX + 1, 0);
      expect(await ask(file, [head])).toEqual({ ok: false, code: "bad_request" });
      expect(await ask(file, [Buffer.from([0, 0, 0, 3]), Buffer.from("{x}")])).toEqual({ ok: false, code: "bad_request" });
      expect(await ask(file, [frame({ op: "tick", kind: "loop" })])).toEqual({ ok: true, started: true });
      await until(() => r.users().length === 1, "the message");
    } finally {
      await listening.close();
    }
  });

  it("replaces a socket a dead supervisor left, and refuses a name that is a file", async () => {
    const r = rig("ok");
    const sockDir = tempDir("fxs-", socketTmpRoot());
    const file = path.join(sockDir, CHANNEL_SOCKET);
    const first = await r.session.serve(file);
    await first.close();
    const again = await r.session.serve(file);
    await again.close();
    const plain = path.join(sockDir, "plain");
    writeFileSync(plain, "x");
    await expect(r.session.serve(plain)).rejects.toBeDefined();
  });
});

/** The tests that need to see the secret's own buffer: every buffer made while the token was handed in that holds the token's bytes (the copy the session keeps). */
function secretCopies(): { copies: Buffer[]; stop: () => void } {
  const real = Buffer.from.bind(Buffer);
  const copies: Buffer[] = [];
  const spy = vi.spyOn(Buffer, "from").mockImplementation(((...args: unknown[]) => {
    const made = (real as (...a: unknown[]) => Buffer)(...args);
    if (made.length === TOKEN.length && made.toString("latin1") === TOKEN && typeof args[0] !== "string") copies.push(made);
    return made;
  }) as typeof Buffer.from);
  return { copies, stop: () => spy.mockRestore() };
}
const zeroed = (b: Buffer): boolean => b.every((x) => x === 0);

describe("the wipe zeroes the buffer itself", () => {
  it("a channel stop leaves no byte of the token in the buffer the session held (a wipe that only drops the reference fails)", async () => {
    const r = rig("ok");
    const body = tokenBody();
    const seen = secretCopies();
    try {
      expect(await r.ask({ op: "token_put", name: "claude", size: TOKEN.length }, body)).toEqual({ ok: true });
    } finally {
      seen.stop();
    }
    const held = seen.copies.filter((b) => b !== body);
    expect(held.length, "the session's copy was seen").toBeGreaterThanOrEqual(1);
    expect(
      held.some((b) => !zeroed(b)),
      "control: the copy holds the token until the stop",
    ).toBe(true);
    expect(await r.ask({ op: "stop" })).toMatchObject({ ok: true, token_wiped: true });
    expect(held.every(zeroed)).toBe(true);
  });

  it("a second token_put zeroes the first copy", async () => {
    const r = rig("ok");
    const body = tokenBody();
    const seen = secretCopies();
    try {
      await r.ask({ op: "token_put", name: "claude", size: TOKEN.length }, body);
    } finally {
      seen.stop();
    }
    const first = seen.copies.filter((b) => b !== body);
    expect(first.length).toBeGreaterThanOrEqual(1);
    await r.ask({ op: "token_put", name: "claude", size: 3 }, tokenBody("abc"));
    expect(first.every(zeroed)).toBe(true);
  });
});

/** Fake timers and clock for a crashing host: `drive` walks it through its back-offs until the supervisor gives up (the sixth crash). */
function crashTimers(): { tune: (rt: GuestRuntime) => GuestRuntime; drive: (starts: () => number) => Promise<void> } {
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  let clock = Date.parse("2026-11-26T12:00:00Z");
  return {
    tune: (rt) => ({
      ...rt,
      now: () => clock,
      after: (ms, fn) => {
        const t = { ms, fn, cancelled: false };
        timers.push(t);
        return () => void (t.cancelled = true);
      },
    }),
    drive: async (starts) => {
      for (let crash = 1; crash < CRASH_LIMIT; crash++) {
        await until(() => !timers.some((t) => !t.cancelled && t.ms === FILE_BEAT_MS) && timers.some((t) => !t.cancelled && (BACKOFF_MS as readonly number[]).includes(t.ms)), `back-off ${crash}`);
        const t = timers.find((x) => !x.cancelled && (BACKOFF_MS as readonly number[]).includes(x.ms)) as { ms: number; fn: () => void; cancelled: boolean };
        t.cancelled = true;
        clock += t.ms;
        t.fn();
        await until(() => starts() === crash + 1, `restart ${crash}`);
      }
    },
  };
}

describe("crash_loop wipes the credential and ends the program", () => {
  it("after crash_loop the token buffer is zeroed WITHOUT any stop, and finished() settles (a supervisor that ends on its own must not keep the credential)", async () => {
    const crash = crashTimers();
    const r = rig("crash", crash.tune);
    const body = tokenBody();
    const seen = secretCopies();
    try {
      await r.ask({ op: "token_put", name: "claude", size: TOKEN.length }, body);
    } finally {
      seen.stop();
    }
    const held = seen.copies.filter((b) => b !== body);
    expect(held.length).toBeGreaterThanOrEqual(1);
    expect(
      held.some((b) => !zeroed(b)),
      "control: the copy holds the token before the loop ends",
    ).toBe(true);
    expect(await r.ask({ op: "tick", kind: "loop" })).toMatchObject({ ok: true, started: true });
    let settled = false;
    void r.session.finished().then(() => void (settled = true));
    await crash.drive(() => r.starts().length);
    await until(() => r.session.ended() === "crash_loop", "crash_loop");
    await until(() => settled, "finished() to settle");
    expect(held.every(zeroed)).toBe(true);
  });
});

describe("finished()", () => {
  it("settles after a channel stop and not before", async () => {
    const r = rig("ok");
    let settled = false;
    void r.session.finished().then(() => void (settled = true));
    await r.ask({ op: "token_put", name: "claude", size: 3 }, tokenBody("abc"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await r.ask({ op: "stop" });
    await until(() => settled, "finished()");
  });
});

describe("the host log never keeps the credential", () => {
  it("redacts every exact copy of the token an echoing host writes, on stdout, stderr and split across two chunks, and keeps the rest of the text", async () => {
    const r = rig("echo");
    await r.ask({ op: "token_put", name: "claude", size: TOKEN.length }, tokenBody());
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.events().some((e) => e["kind"] === "usage_tick"), "the turn to end");
    await new Promise((resolve) => setTimeout(resolve, 400)); // the split write arrives
    await r.ask({ op: "stop" });
    await until(() => r.events().some((e) => e["kind"] === "host_stopped"), "the host to stop");
    const log = readFileSync(path.join(r.dir, HOST_LOG_FILE), "latin1");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(TOKEN.slice(0, 16));
    expect(log).not.toContain(TOKEN.slice(20));
    expect(log).toContain("tool said [redacted] done");
    expect(log).toContain("split [redacted] end");
    expect(log).toContain("err [redacted]");
  });
});

describe("output that arrives after the host has exited", () => {
  it("is still redacted and written to the host log (the held-back tail is flushed when the streams close, not when the process exits)", async () => {
    const r = rig("late");
    await r.ask({ op: "token_put", name: "claude", size: TOKEN.length }, tokenBody());
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => readFileSync(path.join(r.dir, HOST_LOG_FILE), "latin1").includes("late [redacted] end"), "the late output in the host log");
    const log = readFileSync(path.join(r.dir, HOST_LOG_FILE), "latin1");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(TOKEN.slice(0, 16));
    await r.ask({ op: "stop" });
  });
});

/** The program itself ends: `runEngineSupervise` is what `fx-engine-supervisor` and `__engine-supervise` run, and its promise settling (the callers then `process.exit`) is the program's end. */
describe.skipIf(sockets)("the program exits", () => {
  const ask = (file: string, header: unknown): Promise<ChannelReply | undefined> =>
    new Promise((resolve) => {
      const c = net.connect(file);
      const got: Buffer[] = [];
      c.on("error", () => resolve(undefined));
      c.on("data", (d) => got.push(d));
      c.on("close", () => {
        const all = Buffer.concat(got);
        resolve(all.length < 4 ? undefined : (JSON.parse(all.subarray(4, 4 + all.readUInt32BE(0)).toString("utf8")) as ChannelReply));
      });
      const body = Buffer.from(JSON.stringify(header));
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length, 0);
      c.write(Buffer.concat([head, body]));
    });
  function program(mode: string, tune?: (rt: GuestRuntime) => GuestRuntime): { scratch: string; dir: string; socket: string; checkout: string; lines: string[]; done: Promise<number> } {
    const scratch = tempDir("fx-gs-exit-");
    const bin = path.join(scratch, "bin");
    mkdirSync(bin);
    const standin = path.join(bin, "host-standin");
    writeFileSync(standin, FAKE);
    chmodSync(standin, 0o755);
    const priv = path.join(scratch, "path");
    mkdirSync(priv);
    const checkout = path.join(scratch, "checkout");
    mkdirSync(checkout);
    const socket = path.join(tempDir("fxs-", socketTmpRoot()), CHANNEL_SOCKET);
    const dir = path.join(scratch, "state");
    const lines: string[] = [];
    const done = runEngineSupervise({ dir, socket, claudePath: standin, env: { PATH: priv, HOME: scratch, FAKE_MODE: mode, FAKE_RECORD: path.join(scratch, "rec.jsonl") }, out: (l) => lines.push(l) > 0, ...(tune === undefined ? {} : { tune }) });
    return { scratch, dir, socket, checkout, lines, done };
  }
  const settled = (p: Promise<number>): Promise<number | "still running"> => Promise.race([p, new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 8000))]);

  it("after a channel stop the program ends (exit code 0) and its socket answers no more, with no signal sent", async () => {
    const p = program("ok");
    await until(() => p.lines.includes(SESSION_READY_LINE), "the ready line");
    await until(() => existsSync(p.socket), "the socket");
    expect(await ask(p.socket, { op: "stop" })).toMatchObject({ ok: true, token_wiped: true });
    expect(await settled(p.done)).toBe(0);
    expect(await ask(p.socket, { op: "events_read", after: 0 })).toBeUndefined();
  }, 30_000);

  it("after crash_loop the program ends by itself (no stop, no signal)", async () => {
    const crash = crashTimers();
    const p = program("crash", crash.tune);
    await until(() => p.lines.includes(SESSION_READY_LINE), "the ready line");
    writeFileSync(path.join(p.dir, SESSION_CONFIG_FILE), JSON.stringify({ repo_gh_id: "424242", repo_checkout: p.checkout }), { mode: 0o600 });
    expect(await ask(p.socket, { op: "tick", kind: "loop" })).toMatchObject({ ok: true, started: true });
    const record = path.join(p.scratch, "rec.jsonl");
    const starts = (): number => (existsSync(record) ? readFileSync(record, "utf8").split("\n").filter((l) => l.includes('"start"')).length : 0);
    await crash.drive(starts);
    expect(await settled(p.done)).toBe(0);
  }, 60_000);
});

/** ON-13b2: ticks and signed commands, with the stand-in host. Commands are signed with a key made here, pinned under a fictional cloud address through the session's `keyrings`. */
const ORIGIN = "https://cloud.fictional.invalid";
const RUNNER = randomUUID();
const REPO = 424242;
const keys = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const pinned: PinnedKeyrings = { [originHash(ORIGIN) as string]: { "job-key-1": keys.publicKey } };
const sessionExtra = { keyrings: pinned, session: { runner_id: RUNNER, cloud_origin: ORIGIN } };
const signedCommand = (over: Record<string, unknown> = {}, key = keys.privateKey): unknown =>
  signEngineCommand(
    EngineCommand.parse({ v: 1, purpose: "engine_command_v1", command_id: randomUUID(), command_seq: 1, runner_id: RUNNER, repo_gh_id: REPO, kind: "start_day", args: {}, issued_by: randomUUID(), issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), halt_epoch: 0, ...over }),
    "job-key-1",
    key,
  );
const outcomes = async (r: Rig): Promise<Array<{ name: string; ack: { outcome: string; refusal?: string } }>> => {
  const reply = (await r.ask({ op: "events_read", after: 0, stream: "outcomes" })) as unknown as { lines: string[] };
  return reply.lines.map((l) => JSON.parse(l) as { name: string; ack: { outcome: string } });
};

describe("ticks (EB-12b's rules over the channel)", () => {
  it("each kind is its fixed template, and no text of the peer's is ever sent", async () => {
    const r = rig("ok");
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.users().length === 1, "the loop tick");
    await r.ask({ op: "tick", kind: "checkin", name: "pm-sweep" });
    await r.ask({ op: "tick", kind: "start_day" });
    await until(() => r.users().length === 3, "all three ticks");
    expect(r.users()).toEqual([renderPrompt("loop"), renderPrompt("checkin", { name: "pm-sweep" }), renderPrompt("start_day_scheduled")]);
    await until(() => r.events().filter((e) => e["kind"] === "tick_ended").length === 3, "three tick_ended events");
    expect(r.events().filter((e) => e["kind"] === "tick_started").map((e) => e["tick_kind"])).toEqual(["loop", "checkin", "start_day"]);
  });

  it("single flight: while a turn has not ended the next tick waits, and a second of a kind that is already queued is dropped", async () => {
    const r = rig("hold");
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.users().length === 1, "the first message");
    for (const kind of ["loop", "loop", "loop"]) await r.ask({ op: "tick", kind });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(r.users()).toEqual([renderPrompt("loop")]); // nothing else went out, and the three requests were one queued tick
    expect(r.events().filter((e) => e["kind"] === "tick_started")).toHaveLength(1);
  });

  it("a verified pause_loop stops loop ticks and resume_loop lets them go on", async () => {
    const r = rig("ok", (rt) => rt, true, undefined, sessionExtra);
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.users().length === 1, "the first tick");
    expect(await r.ask({ op: "command", command: signedCommand({ kind: "pause_loop", command_seq: 1 }) })).toMatchObject({ ok: true });
    await until(async () => (await outcomes(r)).some((o) => o.ack.outcome === "applied"), "pause_loop applied");
    await r.ask({ op: "tick", kind: "loop" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(r.users()).toHaveLength(1);
    expect(await r.ask({ op: "command", command: signedCommand({ kind: "resume_loop", command_seq: 2 }) })).toMatchObject({ ok: true });
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.users().length === 2, "the loop tick after resume");
  });
});

describe("signed commands, checked again in the guest", () => {
  it("a command the pinned key signed is applied by the ticker, answered once, and its outcome is read back", async () => {
    const r = rig("ok", (rt) => rt, true, undefined, sessionExtra);
    expect(await r.ask({ op: "command", command: signedCommand({ command_seq: 7 }) })).toEqual({ ok: false, code: "host_not_running" }); // verified, but no host yet: nothing is applied
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.users().length === 1, "the first tick");
    const reply = await r.ask({ op: "command", command: signedCommand({ kind: "start_day", command_seq: 8 }) });
    expect(reply).toMatchObject({ ok: true, name: expect.stringMatching(/^8-[0-9a-f-]{36}$/) as unknown });
    await until(async () => (await outcomes(r)).length === 1, "the outcome");
    expect(await outcomes(r)).toEqual([{ name: (reply as unknown as { name: string }).name, ack: { outcome: "applied" } }]);
    expect(r.users()).toHaveLength(2);
  });

  it("a forged signature, a tampered body, a stranger's key, an unsigned or expired command, another runner's or repository's, and a bridge kind are all command_unverified and reach nothing", async () => {
    const r = rig("ok", (rt) => rt, true, undefined, sessionExtra);
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.users().length === 1, "the first tick");
    const good = signedCommand({ kind: "start_day" }) as { command: Record<string, unknown>; key_id: string; signature: string };
    const forged = { ...good, signature: Buffer.alloc(64, 1).toString("base64url") };
    const tampered = { ...good, command: { ...good.command, kind: "request_spawn", args: { role: "executor", discussion: 1 } } };
    const unsigned = { command: good.command, key_id: good.key_id };
    const cases: Array<[string, unknown]> = [
      ["forged signature", forged],
      ["tampered body", tampered],
      ["another key", signedCommand({}, stranger.privateKey)],
      ["unsigned", unsigned],
      ["unknown key id", { ...good, key_id: "job-key-9" }],
      ["expired", signedCommand({ issued_at: new Date(Date.now() - 120_000).toISOString(), expires_at: new Date(Date.now() - 60_000).toISOString() })],
      ["another runner", signedCommand({ runner_id: randomUUID() })],
      ["another repository", signedCommand({ repo_gh_id: REPO + 1 })],
      ["a bridge kind", signedCommand({ kind: "bridge_enable", args: {} })],
      ["not an object", "start_day"],
    ];
    for (const [what, command] of cases) expect(await r.ask({ op: "command", command }), what).toEqual({ ok: false, code: "command_unverified" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(r.users()).toHaveLength(1);
    expect(await outcomes(r)).toEqual([]);
  });

  it("a session whose config names no pinned cloud (or no runner) verifies nothing, whatever is signed", async () => {
    const none = rig("ok", (rt) => rt, true, undefined, { keyrings: pinned, session: { runner_id: RUNNER, cloud_origin: "https://other.fictional.invalid" } });
    await none.ask({ op: "tick", kind: "loop" });
    expect(await none.ask({ op: "command", command: signedCommand() })).toEqual({ ok: false, code: "command_unverified" });
    const noRunner = rig("ok", (rt) => rt, true, undefined, { keyrings: pinned, session: { cloud_origin: ORIGIN } });
    await noRunner.ask({ op: "tick", kind: "loop" });
    expect(await noRunner.ask({ op: "command", command: signedCommand() })).toEqual({ ok: false, code: "command_unverified" });
    const plain = rig("ok");
    expect(await plain.ask({ op: "command", command: signedCommand() })).toEqual({ ok: false, code: "command_unverified" });
  });
});

describe("halt", () => {
  it("a channel stop with reason halted wipes the credential, ends the host with no survivor and says halted in the host's own event", async () => {
    const r = rig("ok");
    await r.ask({ op: "token_put", name: "claude", size: TOKEN.length }, tokenBody());
    await r.ask({ op: "tick", kind: "loop" });
    await until(() => r.starts().length === 1, "the host");
    const pid = r.starts()[0]?.pid as number;
    expect(await r.ask({ op: "stop", reason: "halted" })).toEqual({ ok: true, survivors: 0, token_wiped: true, pid: process.pid });
    await until(() => !alive(pid), "the host to be gone");
    await until(() => r.events().some((e) => e["kind"] === "host_stopped"), "host_stopped");
    expect(r.events().find((e) => e["kind"] === "host_stopped")).toMatchObject({ reason: "halted" });
    expect(await r.ask({ op: "tick", kind: "loop" })).toEqual({ ok: false, code: "stopped" });
  });
});
