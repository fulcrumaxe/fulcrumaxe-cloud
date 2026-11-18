import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineEvent } from "@fulcrumaxe/runner-protocol";
import { readHostHandle } from "../../src/engineBridge/halt.js";
import { engineHostCommand, type EngineHostRuntime } from "../../src/commands/engineHost.js";
import { credentialModeOf, readCheckins, tickSettingsFor } from "../../src/engineHost/hostConfig.js";
import { acquireHostLock, BRIDGE_STATE_FILE, openHostLog, readBridgeState } from "../../src/engineHost/hostFiles.js";
import { createAgentFeed, createEventSpool, ENGINE_EVENTS_FILE, SPOOL_FILE } from "../../src/engineHost/hostFeeds.js";
import { HOST_INBOX_DIR, openHostInbox } from "../../src/engineHost/hostInbox.js";
import { PROMPT_KINDS, renderPrompt, TEMPLATES } from "../../src/engineHost/prompts.js";
import { openSessionStore, SESSION_FILE } from "../../src/engineHost/session.js";
import { createSupervisor, RESUME_FAIL_WITHIN_MS, type HostEvent, type HostSpawnSpec, type Supervisor } from "../../src/engineHost/supervisor.js";
import { createTicker, POLL_MS, TURN_MAX_MS, type TickEvent, type Ticker } from "../../src/engineHost/ticks.js";
import { ENGINE_LOOP_MINUTES_KEY, ENGINE_START_DAY_KEY, loadSettings, SETTING_KEYS, SETTINGS_FILE, setSetting, unsetSetting } from "../../src/runnerSettings.js";

const uid = process.getuid?.() ?? -1;
const SID = "5a7c1d0e-3b2f-4c8a-9d41-6e0b7f2a9c13";
const MIN = 60_000;
const START = Date.parse("2026-11-16T12:00:00.000Z");
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A stand-in for the installed CLI (never the real one): an `init` line, a compact boundary before the result of its FAKE_COMPACT_AFTER-th message, and one `result` per user line. */
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
const rec = process.env.FAKE_RECORD, sid = process.env.FAKE_SESSION, after = Number(process.env.FAKE_COMPACT_AFTER || 0), silent = Number(process.env.FAKE_SILENT_ON || 0);
if (process.env.FAKE_RESUME_FAILS && process.argv.includes("--resume")) { fs.appendFileSync(rec, JSON.stringify({ event: "start", argv: process.argv.slice(2) }) + "\\n"); process.exit(1); }
const log = (o) => fs.appendFileSync(rec, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
log({ event: "start", argv: process.argv.slice(2) });
if (!process.env.FAKE_NO_INIT) out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, ...(process.env.FAKE_KEY_SOURCE ? { apiKeySource: process.env.FAKE_KEY_SOURCE } : {}) });
let buf = "", n = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    n++;
    log({ event: "user", text: m.message.content });
    if (after && n === after) out({ type: "system", subtype: "compact_boundary", session_id: sid, compact_metadata: { trigger: "auto", pre_tokens: 1 } });
    if (silent && n === silent) continue;
    out({ type: "result", subtype: "success", is_error: false, session_id: sid, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, modelUsage: { "claude-haiku-4": {} } });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

interface World {
  dir: string;
  state: string;
  runnerState: string;
  checkout: string;
  claude: string;
  record: string;
  pids: number[];
  specs: HostSpawnSpec[];
  timers: Array<{ ms: number; fn: () => void; live: boolean }>;
  now: { t: number };
  fakeEnv: Record<string, string>;
  records: () => Array<Record<string, unknown>>;
  users: () => string[];
}
let w: World;

function setup(): World {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fx-eb12c-"));
  const state = path.join(dir, "state");
  const runnerState = path.join(dir, "runner");
  const checkout = path.join(dir, "repo");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(runnerState, { mode: 0o700 });
  mkdirSync(path.join(checkout, ".autonomous-team"), { recursive: true });
  mkdirSync(path.join(state, "engine-inbox", "done"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(state, HOST_INBOX_DIR), { mode: 0o700 });
  const claude = path.join(dir, "fake-agent");
  writeFileSync(claude, FAKE);
  chmodSync(claude, 0o755);
  writeFileSync(path.join(state, BRIDGE_STATE_FILE), JSON.stringify({ repo_gh_id: "4242", bridge_enabled: true, operate_enabled: true, repo_checkout: checkout }), { mode: 0o600 });
  const record = path.join(dir, "record.jsonl");
  const world: World = {
    dir, state, runnerState, checkout, claude, record, pids: [], specs: [], timers: [], now: { t: START },
    fakeEnv: { PATH: process.env.PATH ?? "", FAKE_RECORD: record, FAKE_SESSION: SID },
    records: () => (existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []),
    users: () => world.records().filter((r) => r.event === "user").map((r) => String(r.text)),
  };
  return world;
}

/** Starts the fake CLI the way the real launch does (its own process group), from the argument vector the supervisor built. */
const launchFake = (spec: HostSpawnSpec, extraEnv: Record<string, string> = {}) => {
  w.specs.push(spec);
  const sep = spec.args.indexOf("--");
  const [file, ...rest] = spec.args.slice(sep + 1);
  const child = spawn(file ?? "", rest, { cwd: spec.cwd, env: { ...spec.env, ...extraEnv }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdin.on("error", () => undefined);
  child.on("error", () => undefined);
  if (child.pid !== undefined) w.pids.push(child.pid);
  return {
    pid: child.pid,
    write: (t: string) => void child.stdin.write(t),
    closeStdin: () => child.stdin.end(),
    onStdout: (cb: (t: string) => void) => child.stdout.on("data", cb),
    onStderr: (cb: (t: string) => void) => child.stderr.on("data", cb),
    onExit: (cb: () => void) => child.on("exit", () => cb()),
  };
};
const after = (ms: number, fn: () => void): (() => void) => {
  const t = { ms, fn, live: true };
  w.timers.push(t);
  return () => void (t.live = false);
};

function makeSupervisor(events: HostEvent[], over: Partial<Parameters<typeof createSupervisor>[0]> = {}): Supervisor {
  return createSupervisor({
    stateDir: w.state,
    uid,
    platform: "linux",
    claudePath: w.claude,
    readBridgeState: () => readBridgeState(w.state, uid),
    env: w.fakeEnv,
    log: openHostLog(w.state, uid),
    emit: (e) => events.push(e),
    now: () => w.now.t,
    after,
    isAlive: alive,
    startTimeOf: (pid) => `st-${pid}`,
    isOurHost: () => false,
    acquireLock: () => acquireHostLock(w.state, uid, { ownPid: process.pid, isAlive: alive, startOf: (pid) => (pid === process.pid ? "T0" : undefined) }),
    scopeAvailable: async () => true,
    killHost: async (h) => {
      process.kill(-h.pid, "SIGKILL");
    },
    killScope: async () => undefined,
    launch: (spec) => launchFake(spec),
    ...over,
  });
}

beforeEach(() => {
  w = setup();
});
afterEach(() => {
  for (const pid of w.pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // fx-swallow-ok: already gone
    }
  }
  rmSync(w.dir, { recursive: true, force: true });
});

describe("EB-12c.1 the session id is kept and reused", () => {
  it("saves a uuid at 0600 through a rename, loads it back, and replaces a link at its name without writing through it", () => {
    const store = openSessionStore(w.state, uid);
    expect(store.load()).toBeUndefined();
    store.save(SID);
    const file = path.join(w.state, SESSION_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(store.load()).toBe(SID);
    expect(() => store.save("not-a-uuid")).toThrow();
    expect(store.load()).toBe(SID);
    const victim = path.join(w.dir, "victim.json");
    writeFileSync(victim, "keep");
    rmSync(file);
    symlinkSync(victim, file);
    expect(store.load()).toBeUndefined(); // a link is never followed, so it is no session
    store.save(SID);
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(store.load()).toBe(SID);
    store.clear();
    expect(store.load()).toBeUndefined();
  });
  it("treats anything that is not exactly a uuid, a file open to others, or damaged JSON as no session", () => {
    const store = openSessionStore(w.state, uid);
    const file = path.join(w.state, SESSION_FILE);
    for (const body of ['{"session_id":"../../etc/passwd"}', '{"session_id":7}', "not json", '{"session_id":"' + SID + 'x"}', "[]"]) {
      writeFileSync(file, body, { mode: 0o600 });
      expect(store.load()).toBeUndefined();
    }
    writeFileSync(file, JSON.stringify({ session_id: SID }), { mode: 0o600 });
    chmodSync(file, 0o644);
    expect(store.load()).toBeUndefined();
  });
  it("a supervisor that starts later (after a crash of the runner or a reboot) runs the host with --resume <saved id>, and a first start has none", async () => {
    const first = makeSupervisor([], { sessionStore: openSessionStore(w.state, uid) });
    expect(await first.start()).toEqual({ ok: true });
    await until(() => first.sessionId() === SID, "the init line");
    expect(w.specs[0]!.args).not.toContain("--resume");
    await until(() => existsSync(path.join(w.state, SESSION_FILE)), "the session file");
    expect(JSON.parse(readFileSync(path.join(w.state, SESSION_FILE), "utf8"))).toEqual({ session_id: SID });
    await first.stop("machine_shutdown");
    // A whole new supervisor, as after a reboot: it knows the id only from the file.
    const second = makeSupervisor([], { sessionStore: openSessionStore(w.state, uid) });
    expect(second.sessionId()).toBe(SID);
    expect(await second.start()).toEqual({ ok: true });
    const args = w.specs[1]!.args;
    expect(args.slice(args.indexOf("--resume"))).toEqual(["--resume", SID]);
    await until(() => w.records().filter((r) => r.event === "start").length === 2, "the second host");
    expect((w.records()[1]!.argv as string[]).slice(-2)).toEqual(["--resume", SID]);
    await second.stop("machine_shutdown");
  });
  it("starts fresh when the saved file is damaged, and a save that fails is counted and never stops the host", async () => {
    writeFileSync(path.join(w.state, SESSION_FILE), "garbage", { mode: 0o600 });
    const sup = makeSupervisor([], {
      sessionStore: {
        load: () => openSessionStore(w.state, uid).load(),
        save: () => {
          throw new Error("disk full");
        },
        clear: () => undefined,
      },
    });
    expect(await sup.start()).toEqual({ ok: true });
    expect(w.specs[0]!.args).not.toContain("--resume");
    await until(() => sup.sessionSaveFailures() === 1, "the failed save");
    expect(sup.sessionId()).toBe(SID);
    expect(await Promise.race([sup.stopped.then(() => "stopped"), new Promise((r) => setTimeout(() => r("running"), 100))])).toBe("running");
    await sup.stop("machine_shutdown");
  });
});

describe("EB-12c.2 a compact boundary emits compaction_detected and the next tick re-orients", () => {
  it("emits the event once, calls the observer, and sends the fixed re-orient message next on the real stream", async () => {
    const events: HostEvent[] = [];
    const tickEvents: TickEvent[] = [];
    const hold: { ticker?: Ticker } = {};
    const sup = makeSupervisor(events, {
      observer: { onTurn: (t) => hold.ticker?.onTurn(t), onExit: () => hold.ticker?.onHostExit(), onCompaction: () => hold.ticker?.onCompaction() },
      launch: (spec) => launchFake(spec, { FAKE_COMPACT_AFTER: "1" }),
    });
    expect(await sup.start()).toEqual({ ok: true });
    const ticker = createTicker({ send: (t) => sup.send(t), touch: () => sup.touch(), emit: (e) => tickEvents.push(e), now: () => w.now.t, after, settings: () => ({}), localClock: () => ({ date: "2026-11-16", hhmm: "10:00" }), credentialMode: () => "subscription", repoGhId: 4242, gate: () => undefined, inbox: openHostInbox(w.state, uid) });
    hold.ticker = ticker;
    ticker.start();
    w.now.t += 15 * MIN;
    ticker.poll(); // the loop tick; the fake CLI compacts during its turn
    await until(() => tickEvents.some((e) => e.kind === "tick_started" && e.tick_kind === "reorient"), "the re-orient tick");
    expect(events.filter((e) => e.kind === "compaction_detected")).toHaveLength(1);
    await until(() => tickEvents.filter((e) => e.kind === "tick_ended").length === 2, "both turns");
    expect(tickEvents.filter((e) => e.kind === "tick_started").map((e) => e.tick_kind)).toEqual(["loop", "reorient"]);
    expect(w.users()).toEqual([renderPrompt("loop"), renderPrompt("reorient")]);
    ticker.close();
    await sup.stop("machine_shutdown");
  });
  it("reads only a system line whose subtype is compact_boundary: look-alikes in other lines and non-JSON change nothing", async () => {
    const events: HostEvent[] = [];
    let sent = 0;
    let emitOut: ((t: string) => void) | undefined;
    const sup = makeSupervisor(events, {
      observer: { onTurn: () => undefined, onExit: () => undefined, onCompaction: () => void sent++ },
      launch: () => ({ pid: process.pid, write: () => undefined, closeStdin: () => undefined, onStdout: (cb) => void (emitOut = cb), onStderr: () => undefined, onExit: () => undefined }),
    });
    expect(await sup.start()).toEqual({ ok: true });
    emitOut?.('{"type":"assistant","message":"compact_boundary"}\n{"type":"system","subtype":"init","note":"compact_boundary","session_id":"' + SID + '"}\n{"type":"system" compact_boundary\n');
    expect(events.some((e) => e.kind === "compaction_detected")).toBe(false);
    expect(sent).toBe(0);
    emitOut?.('{"type":"system","subtype":"compact_boundary","session_id":"' + SID + '"}\n');
    expect(events.filter((e) => e.kind === "compaction_detected")).toHaveLength(1);
    expect(sent).toBe(1);
    sup.cleanup();
  });
  it("a sink or observer that throws on a compaction never stops the stream", async () => {
    let emitOut: ((t: string) => void) | undefined;
    const sup = makeSupervisor([], {
      emit: (e) => {
        if (e.kind === "compaction_detected") throw new Error("sink down");
      },
      launch: () => ({ pid: process.pid, write: () => undefined, closeStdin: () => undefined, onStdout: (cb) => void (emitOut = cb), onStderr: () => undefined, onExit: () => undefined }),
    });
    expect(await sup.start()).toEqual({ ok: true });
    expect(() => emitOut?.('{"type":"system","subtype":"compact_boundary"}\n')).not.toThrow();
    sup.cleanup();
  });
});

/** The ticker on its own, with a controllable host (the way ticks.test.ts drives it). */
function tickerWorld(over: { turnTimeoutMs?: number } = {}) {
  const sent: string[] = [];
  const events: TickEvent[] = [];
  const t = { now: START };
  const timers: Array<{ ms: number; fn: () => void; live: boolean }> = [];
  const ticker = createTicker({
    send: (text) => (sent.push(text), true),
    touch: () => true,
    emit: (e) => events.push(e),
    now: () => t.now,
    after: (ms, fn) => {
      const x = { ms, fn: () => { x.live = false; fn(); }, live: true };
      timers.push(x);
      return () => void (x.live = false);
    },
    settings: () => ({}),
    localClock: () => ({ date: "2026-11-16", hhmm: "10:00" }),
    credentialMode: () => "subscription",
    repoGhId: 4242,
    gate: () => undefined,
    inbox: openHostInbox(w.state, uid),
    ...over,
  });
  const kinds = (): string[] => events.flatMap((e) => (e.kind === "tick_started" ? [e.tick_kind] : []));
  const fireTimer = (ms: number): void => {
    const x = [...timers].reverse().find((y) => y.live && y.ms === ms);
    if (x === undefined) throw new Error(`no live timer of ${ms} ms`);
    x.fn();
  };
  ticker.start();
  return { ticker, sent, events, t, timers, kinds, fireTimer };
}

describe("EB-12c.2 the re-orient tick", () => {
  it("has the fixed words: the PM Brain issue, the last 20 team-log lines, memory and today's plan, and no placeholder", () => {
    expect(PROMPT_KINDS).toContain("reorient");
    expect(TEMPLATES.reorient.slots).toEqual({});
    const text = renderPrompt("reorient");
    for (const part of ["PM Brain issue", "last 20 team-log lines", "memory", "today's plan"]) expect(text).toContain(part);
    expect(text).not.toMatch(/[{}]/);
  });
  it("goes first, ahead of queued ticks, and is not held back by pause_loop; a second compaction while one is queued is dropped and counted", () => {
    const x = tickerWorld();
    x.ticker.poll(); // nothing is due
    expect(x.sent).toEqual([]);
    // A turn in flight, a start_day tick queued behind it, then the compaction.
    const id = "00000000-0000-4000-8000-0000000000d1";
    const put = (name: string, kind: string): void =>
      writeFileSync(path.join(w.state, HOST_INBOX_DIR, `${name}.json`), JSON.stringify({ v: 1, purpose: "engine_command_v1", command_id: id, command_seq: 1, runner_id: id, repo_gh_id: 4242, issued_by: id, issued_at: new Date(x.t.now - 1000).toISOString(), expires_at: new Date(x.t.now + 5 * MIN).toISOString(), halt_epoch: 0, kind, args: {} }), { mode: 0o600 });
    x.t.now += 15 * MIN;
    x.ticker.poll();
    expect(x.kinds()).toEqual(["loop"]);
    put(`1-${id}`, "start_day");
    x.ticker.poll();
    expect(x.ticker.counts().queued).toBe(1);
    x.ticker.onCompaction();
    x.ticker.onCompaction();
    expect(x.ticker.counts().dropped).toBe(1);
    x.ticker.onTurn({ ok: true });
    expect(x.kinds()).toEqual(["loop", "reorient"]);
    x.ticker.onTurn({ ok: true });
    expect(x.kinds()).toEqual(["loop", "reorient", "start_day"]);
    x.ticker.close();
  });
  it("is sent while the loop is paused", () => {
    const x = tickerWorld();
    const id = "00000000-0000-4000-8000-0000000000d2";
    writeFileSync(path.join(w.state, HOST_INBOX_DIR, `1-${id}.json`), JSON.stringify({ v: 1, purpose: "engine_command_v1", command_id: id, command_seq: 1, runner_id: id, repo_gh_id: 4242, issued_by: id, issued_at: new Date(x.t.now - 1000).toISOString(), expires_at: new Date(x.t.now + 5 * MIN).toISOString(), halt_epoch: 0, kind: "pause_loop", args: {} }), { mode: 0o600 });
    x.ticker.poll();
    expect(x.ticker.counts().paused).toBe(true);
    x.ticker.onCompaction();
    expect(x.kinds()).toEqual(["reorient"]);
    expect(x.sent).toEqual([renderPrompt("reorient")]);
    x.ticker.close();
  });
});

describe("EB-12c.3 a tick has a turn timeout, and a late result never ends the next tick", () => {
  const specCommand = (x: ReturnType<typeof tickerWorld>, kind: string, args: Record<string, unknown>): string => {
    const id = "00000000-0000-4000-8000-0000000000e1";
    const name = `1-${id}`;
    writeFileSync(path.join(w.state, HOST_INBOX_DIR, `${name}.json`), JSON.stringify({ v: 1, purpose: "engine_command_v1", command_id: id, command_seq: 1, runner_id: id, repo_gh_id: 4242, issued_by: id, issued_at: new Date(x.t.now - 1000).toISOString(), expires_at: new Date(x.t.now + 5 * MIN).toISOString(), halt_epoch: 0, kind, args }), { mode: 0o600 });
    return name;
  };
  const outcome = (name: string): unknown => {
    const file = path.join(w.state, "engine-inbox", "done", `${name}.outcome.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  };
  it("ends a tick whose turn has not ended in time as an error, and its command as not_confirmed", () => {
    const x = tickerWorld();
    const name = specCommand(x, "request_spawn", { role: "executor", discussion: 77 });
    x.ticker.poll();
    expect(x.kinds()).toEqual(["command"]);
    x.t.now += 29 * MIN;
    expect(x.events.some((e) => e.kind === "tick_ended")).toBe(false);
    x.t.now += 1 * MIN;
    x.fireTimer(TURN_MAX_MS);
    const ended = x.events.find((e) => e.kind === "tick_ended");
    expect(ended).toMatchObject({ kind: "tick_ended", tick_kind: "command", outcome: "error", duration_s: 1800, credential_mode: "subscription" });
    expect(outcome(name)).toEqual({ outcome: "not_confirmed" });
    expect(x.ticker.counts().timedOut).toBe(1);
    x.ticker.close();
  });
  it("sends nothing else until the abandoned turn's own result arrives, then consumes that result without counting it as any tick's", () => {
    const x = tickerWorld();
    x.t.now += 15 * MIN;
    x.ticker.poll();
    expect(x.kinds()).toEqual(["loop"]);
    x.t.now += 30 * MIN;
    x.fireTimer(TURN_MAX_MS);
    expect(x.events.filter((e) => e.kind === "tick_ended")).toHaveLength(1);
    // Another tick comes due; the host may still be in the first turn, so it waits.
    x.t.now += 15 * MIN;
    x.ticker.poll();
    expect(x.kinds()).toEqual(["loop"]);
    expect(x.ticker.counts().queued).toBe(1);
    x.ticker.onTurn({ ok: true }); // the abandoned turn finally ends
    expect(x.events.filter((e) => e.kind === "tick_ended")).toHaveLength(1);
    expect(x.kinds()).toEqual(["loop", "loop"]);
    // The second tick's own result ends it normally.
    x.ticker.onTurn({ ok: true });
    expect(x.events.filter((e) => e.kind === "tick_ended")).toHaveLength(2);
    expect(x.events.filter((e) => e.kind === "tick_ended").map((e) => e.kind === "tick_ended" && e.outcome)).toEqual(["error", "ok"]);
    x.ticker.close();
  });
  it("gives up waiting for an abandoned turn after one more timeout, and a host restart clears the wait at once", () => {
    const x = tickerWorld();
    x.t.now += 15 * MIN;
    x.ticker.poll();
    x.fireTimer(TURN_MAX_MS);
    x.t.now += 15 * MIN;
    x.ticker.poll();
    expect(x.kinds()).toEqual(["loop"]);
    x.fireTimer(TURN_MAX_MS); // the orphan wait
    expect(x.kinds()).toEqual(["loop", "loop"]);
    // And a new host process has no abandoned turn.
    x.fireTimer(TURN_MAX_MS);
    x.ticker.onHostExit();
    x.t.now += 15 * MIN;
    x.ticker.poll();
    x.ticker.onTurn({ ok: true });
    expect(x.events.filter((e) => e.kind === "tick_ended").at(-1)).toMatchObject({ outcome: "ok" });
    x.ticker.close();
  });
  it("a turn that ends in time cancels its timeout, and a result with no tick in flight and no abandoned turn is ignored", () => {
    const x = tickerWorld({ turnTimeoutMs: 5 * MIN });
    x.t.now += 15 * MIN;
    x.ticker.poll();
    x.ticker.onTurn({ ok: true });
    expect(x.timers.filter((y) => y.live && y.ms === 5 * MIN)).toHaveLength(0);
    x.ticker.onTurn({ ok: true }); // the host's own turn, no tick
    expect(x.events.filter((e) => e.kind === "tick_ended")).toHaveLength(1);
    expect(x.ticker.counts().timedOut).toBe(0);
    x.ticker.close();
  });
  it("on the real stream: a host that never answers ends the tick as not_confirmed at the timeout, and the next tick goes out after its late result", async () => {
    const events: TickEvent[] = [];
    const hold: { ticker?: Ticker } = {};
    const sup = makeSupervisor([], {
      observer: { onTurn: (t) => hold.ticker?.onTurn(t), onExit: () => hold.ticker?.onHostExit() },
      launch: (spec) => launchFake(spec, { FAKE_SILENT_ON: "1" }), // the first message gets no result (a turn that never ends)
    });
    expect(await sup.start()).toEqual({ ok: true });
    const ticker = createTicker({ send: (t) => sup.send(t), touch: () => sup.touch(), emit: (e) => events.push(e), now: () => w.now.t, after, settings: () => ({}), localClock: () => ({ date: "2026-11-16", hhmm: "10:00" }), credentialMode: () => "subscription", repoGhId: 4242, gate: () => undefined, inbox: openHostInbox(w.state, uid) });
    hold.ticker = ticker;
    ticker.start();
    w.now.t += 15 * MIN;
    ticker.poll();
    await until(() => w.users().length === 1, "the first tick to reach the host");
    w.now.t += 30 * MIN;
    [...w.timers].reverse().find((x) => x.live && x.ms === TURN_MAX_MS)!.fn();
    expect(events.find((e) => e.kind === "tick_ended")).toMatchObject({ outcome: "error", duration_s: 1800 });
    ticker.close();
    await sup.stop("machine_shutdown");
  });
});

describe("EB-12c.4 feeds: the event spool", () => {
  it("writes every host and tick event as a valid EB-1 event in a session of its own, seq from 0, at 0600", () => {
    const spool = createEventSpool({ dir: w.state, uid, now: () => w.now.t, newId: () => "11111111-2222-4333-8444-555555555555" });
    const sent: Array<HostEvent | TickEvent> = [
      { kind: "host_started" },
      { kind: "tick_started", tick_kind: "reorient" },
      { kind: "tick_ended", tick_kind: "reorient", outcome: "ok", duration_s: 12, credential_mode: "subscription", model: "claude-haiku-4", usage: { input: 1, output: 2, cache_read: 3, cache_write: 4 } },
      { kind: "compaction_detected" },
      { kind: "host_heartbeat" },
      { kind: "host_stopped", reason: "crash_loop", survivors: 2 },
      { kind: "host_stopped", reason: "log_failed" },
    ];
    for (const e of sent) expect(spool.write(e)).toBe(true);
    const file = path.join(w.state, SPOOL_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => EngineEvent.parse(JSON.parse(l)));
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(lines.map((l) => l.engine_instance_id))).toEqual(new Set(["11111111-2222-4333-8444-555555555555"]));
    expect(lines.map((l) => l.kind)).toEqual(["host_started", "tick_started", "tick_ended", "compaction_detected", "host_heartbeat", "host_stopped", "host_stopped"]);
    expect(lines[5]).toMatchObject({ reason: "crash_loop" });
    expect(lines[5]).not.toHaveProperty("survivors"); // EB-1's host_stopped has no such field
    expect(lines[6]).not.toHaveProperty("reason"); // a reason EB-1 has no word for is left off, the event is still sent
    expect(lines[0]!.ts).toBe(new Date(w.now.t).toISOString());
    spool.close();
  });
  it("never writes an event the schema refuses (counted), rotates at its cap, and refuses a link at its name", () => {
    const spool = createEventSpool({ dir: w.state, uid, now: () => w.now.t, maxBytes: 600 });
    expect(spool.write({ kind: "tick_ended", tick_kind: "loop", outcome: "ok", duration_s: -1, credential_mode: "subscription" })).toBe(false);
    expect(spool.failed()).toBe(1);
    for (let i = 0; i < 12; i++) spool.write({ kind: "host_heartbeat" });
    spool.close();
    expect(existsSync(path.join(w.state, `${SPOOL_FILE}.1`))).toBe(true);
    expect(statSync(path.join(w.state, SPOOL_FILE)).size).toBeLessThanOrEqual(600);
    const first = EngineEvent.parse(JSON.parse(readFileSync(path.join(w.state, SPOOL_FILE), "utf8").split("\n")[0]!));
    expect(first.seq).toBeGreaterThan(0); // the older lines are in .1 or gone: the gap in seq shows it
    rmSync(path.join(w.state, SPOOL_FILE));
    const victim = path.join(w.dir, "victim.jsonl");
    writeFileSync(victim, "keep");
    symlinkSync(victim, path.join(w.state, SPOOL_FILE));
    expect(() => createEventSpool({ dir: w.state, uid, now: () => w.now.t })).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });
});

describe("EB-12c.4 feeds: the agent-event reader", () => {
  const line = (o: Record<string, unknown>, seq: number): string => `${JSON.stringify({ v: 1, engine_instance_id: "11111111-2222-4333-8444-555555555555", seq, ts: "2026-11-16T12:00:00.000Z", ...o })}\n`;
  const started = (seq: number, role = "executor", discussion = 77): string => line({ kind: "agent_started", spawn_id: "toolu_abc", role, discussion, background: true, isolation: "worktree" }, seq);
  const stopped = (seq: number, agent_id = "a1b2"): string => line({ kind: "agent_stopped", agent_id, role: "executor", verdict: "done", credential_mode: "subscription" }, seq);
  const file = (): string => path.join(w.state, ENGINE_EVENTS_FILE);
  it("starts at the end of the file (history is not news), then returns agent_started and agent_stopped only, once each", () => {
    writeFileSync(file(), started(0) + stopped(1), { mode: 0o600 });
    const feed = createAgentFeed({ dir: w.state, uid });
    expect(feed.poll()).toEqual([]);
    expect(feed.poll()).toEqual([]);
    appendFileSync(file(), started(2, "code-reviewer", 12) + line({ kind: "loop_tick", origin: "host", duration_s: 1 }, 3) + stopped(4, "zz9"));
    expect(feed.poll()).toEqual([
      { kind: "agent_started", role: "code-reviewer", discussion: 12 },
      { kind: "agent_stopped", agent_id: "zz9" },
    ]);
    expect(feed.poll()).toEqual([]);
  });
  it("waits for the newline of a partial line, skips junk and lines the schema refuses, and reads a rotated or truncated file from its start", () => {
    writeFileSync(file(), "", { mode: 0o600 });
    const feed = createAgentFeed({ dir: w.state, uid });
    feed.poll();
    const whole = started(0);
    appendFileSync(file(), whole.slice(0, 30));
    expect(feed.poll()).toEqual([]);
    appendFileSync(file(), `${whole.slice(30)}not json\n{"v":1,"kind":"agent_started","role":"executor"}\n${JSON.stringify({ x: "y".repeat(70_000) })}\n`);
    expect(feed.poll()).toEqual([{ kind: "agent_started", role: "executor", discussion: 77 }]);
    renameSync(file(), `${file()}.1`);
    writeFileSync(file(), stopped(0, "after-rotation"), { mode: 0o600 });
    expect(feed.poll()).toEqual([{ kind: "agent_stopped", agent_id: "after-rotation" }]);
    writeFileSync(file(), stopped(1, "t"), { mode: 0o600 }); // shorter than what was read: a truncation
    expect(feed.poll()).toEqual([{ kind: "agent_stopped", agent_id: "t" }]);
  });
  it("reads nothing from a link, a file open to others or a missing file, and never throws", () => {
    const feed = createAgentFeed({ dir: w.state, uid });
    expect(feed.poll()).toEqual([]);
    const victim = path.join(w.dir, "events-elsewhere.jsonl");
    writeFileSync(victim, "", { mode: 0o600 });
    symlinkSync(victim, file());
    expect(feed.poll()).toEqual([]);
    appendFileSync(victim, started(0));
    expect(feed.poll()).toEqual([]);
    rmSync(file());
    writeFileSync(file(), "", { mode: 0o600 });
    const open = createAgentFeed({ dir: w.state, uid });
    open.poll();
    appendFileSync(file(), started(0));
    chmodSync(file(), 0o666);
    expect(open.poll()).toEqual([]);
  });
});

describe("EB-12c.4 feeds: the check-in list, the runner settings and the credential mode", () => {
  const configFile = (): string => path.join(w.checkout, ".autonomous-team", "config.json");
  const put = (ticks: unknown, mode = 0o644): void => {
    writeFileSync(configFile(), JSON.stringify({ other: 1, cloud_bridge: { enabled: true, ticks } }), { mode });
    chmodSync(configFile(), mode);
  };
  it("reads cloud_bridge.ticks[], keeping only {name: row key, every_min: 5..1440}, one per name, at most 50", () => {
    put([{ name: "EB-12c", every_min: 30 }, { name: "bad name", every_min: 30 }, { name: "ok", every_min: 0 }, { name: "ok", every_min: 1441 }, { name: "ok", every_min: 1.5 }, { name: "ok2", every_min: "5" }, { name: "EB-12c", every_min: 60 }, null, 7, { name: "fine", every_min: 1440 }]);
    expect(readCheckins(w.checkout, uid)).toEqual([{ name: "EB-12c", every_min: 30 }, { name: "fine", every_min: 1440 }]);
    put(Array.from({ length: 80 }, (_, i) => ({ name: `row${i}`, every_min: 5 })));
    expect(readCheckins(w.checkout, uid)).toHaveLength(50);
    put("not an array");
    expect(readCheckins(w.checkout, uid)).toEqual([]);
  });
  it("reads no check-ins from a missing, linked, group-writable, oversized or damaged config, or a linked .autonomous-team", () => {
    expect(readCheckins(w.checkout, uid)).toEqual([]);
    const elsewhere = path.join(w.dir, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ cloud_bridge: { ticks: [{ name: "x", every_min: 5 }] } }), { mode: 0o644 });
    symlinkSync(elsewhere, configFile());
    expect(readCheckins(w.checkout, uid)).toEqual([]);
    rmSync(configFile());
    put([{ name: "x", every_min: 5 }], 0o664);
    expect(readCheckins(w.checkout, uid)).toEqual([]);
    writeFileSync(configFile(), `{"pad":"${"a".repeat(300_000)}"}`, { mode: 0o644 });
    expect(readCheckins(w.checkout, uid)).toEqual([]);
    writeFileSync(configFile(), "{", { mode: 0o644 });
    expect(readCheckins(w.checkout, uid)).toEqual([]);
    const other = path.join(w.dir, "other-checkout");
    mkdirSync(other);
    mkdirSync(path.join(w.dir, "real-dir"));
    writeFileSync(path.join(w.dir, "real-dir", "config.json"), JSON.stringify({ cloud_bridge: { ticks: [{ name: "x", every_min: 5 }] } }), { mode: 0o644 });
    symlinkSync(path.join(w.dir, "real-dir"), path.join(other, ".autonomous-team"));
    expect(readCheckins(other, uid)).toEqual([]);
  });
  it("sets and clears the loop minutes (5 to 60) and the start-of-day time (HH:MM) as runner settings, read again at each look", () => {
    expect(SETTING_KEYS).toEqual(expect.arrayContaining([ENGINE_LOOP_MINUTES_KEY, ENGINE_START_DAY_KEY]));
    expect(loadSettings(w.runnerState).engineHost).toBeUndefined();
    for (const bad of ["4", "61", "abc", "", "5.5", "0005x", "-5"]) expect(() => setSetting(w.runnerState, ENGINE_LOOP_MINUTES_KEY, bad)).toThrow();
    for (const bad of ["24:00", "8:30", "08:60", "noon", "08:30 "]) expect(() => setSetting(w.runnerState, ENGINE_START_DAY_KEY, bad)).toThrow();
    expect(loadSettings(w.runnerState).engineHost).toBeUndefined();
    setSetting(w.runnerState, ENGINE_LOOP_MINUTES_KEY, "7");
    setSetting(w.runnerState, ENGINE_START_DAY_KEY, "08:30");
    expect(statSync(path.join(w.runnerState, SETTINGS_FILE)).mode & 0o777).toBe(0o600);
    put([{ name: "EB-12c", every_min: 30 }]);
    const s = tickSettingsFor(w.runnerState, w.checkout, uid);
    expect({ loopMin: s.loopMin, startDayAt: s.startDayAt, checkins: s.checkins }).toEqual({ loopMin: 7, startDayAt: "08:30", checkins: [{ name: "EB-12c", every_min: 30 }] });
    setSetting(w.runnerState, ENGINE_LOOP_MINUTES_KEY, "60");
    expect(tickSettingsFor(w.runnerState, w.checkout, uid).loopMin).toBe(60);
    unsetSetting(w.runnerState, ENGINE_LOOP_MINUTES_KEY);
    expect(loadSettings(w.runnerState).engineHost).toEqual({ startDayAt: "08:30" });
    unsetSetting(w.runnerState, ENGINE_START_DAY_KEY);
    expect(loadSettings(w.runnerState).engineHost).toBeUndefined();
    // A settings file edited by hand to an out-of-range value reads as unset, never as a guess.
    writeFileSync(path.join(w.runnerState, SETTINGS_FILE), JSON.stringify({ engineHost: { loopMin: 3, startDayAt: "25:00" } }), { mode: 0o600 });
    expect(loadSettings(w.runnerState).engineHost).toBeUndefined();
  });
  it("reads the credential mode from the host's own init line: none is a subscription, any other source or no value is api_key", () => {
    expect(credentialModeOf("none")).toBe("subscription");
    expect(credentialModeOf("apiKeyHelper")).toBe("api_key");
    expect(credentialModeOf("ANTHROPIC_API_KEY")).toBe("api_key");
    expect(credentialModeOf(undefined)).toBe("api_key");
    expect(credentialModeOf("")).toBe("api_key");
    const bin = readFileSync(path.join(import.meta.dirname, "..", "..", "bin", "fx-runner.mjs"), "utf8");
    const allow = bin.slice(bin.indexOf("const engineHostEnv"), bin.indexOf("const engineHostRuntime"));
    expect(allow).not.toMatch(/ANTHROPIC/);
  });
  it("a fake CLI whose init line says apiKeySource apiKeyHelper is api_key although its environment is clean; none is a subscription; no field is never a subscription", async () => {
    for (const [source, mode] of [["apiKeyHelper", "api_key"], ["none", "subscription"], [undefined, "api_key"]] as const) {
      expect(Object.keys(w.fakeEnv).filter((k) => /ANTHROPIC/.test(k))).toEqual([]);
      const sup = makeSupervisor([], { launch: (spec) => launchFake(spec, source === undefined ? {} : { FAKE_KEY_SOURCE: source }) });
      expect(sup.keySource()).toBeUndefined();
      expect(credentialModeOf(sup.keySource())).toBe("api_key"); // before the init line: not a subscription
      expect(await sup.start()).toEqual({ ok: true });
      await until(() => sup.sessionId() === SID, "the init line");
      expect(sup.keySource()).toBe(source);
      expect(credentialModeOf(sup.keySource())).toBe(mode);
      await sup.stop("machine_shutdown");
    }
  });
});

describe("EB-12c.4 the loop minutes are read again at every poll", () => {
  it("a change of engine-host.loop-minutes while the host runs sets the next interval, up and down", () => {
    setSetting(w.runnerState, ENGINE_LOOP_MINUTES_KEY, "15");
    const sent: string[] = [];
    const ticker = createTicker({ send: (t) => (sent.push(t), true), touch: () => true, emit: () => undefined, now: () => w.now.t, after, settings: () => tickSettingsFor(w.runnerState, w.checkout, uid), localClock: () => ({ date: "2026-11-16", hhmm: "10:00" }), credentialMode: () => "subscription", repoGhId: 4242, gate: () => undefined, inbox: openHostInbox(w.state, uid) });
    ticker.start();
    w.now.t += 4 * MIN;
    ticker.poll();
    expect(sent).toEqual([]);
    setSetting(w.runnerState, ENGINE_LOOP_MINUTES_KEY, "5"); // mid-run: counted from the start of this interval, so it is due one minute from now
    w.now.t += 1 * MIN;
    ticker.poll();
    expect(sent).toEqual([renderPrompt("loop")]);
    ticker.onTurn({ ok: true });
    w.now.t += 4 * MIN;
    ticker.poll();
    expect(sent).toHaveLength(1);
    w.now.t += 1 * MIN;
    ticker.poll();
    expect(sent).toHaveLength(2); // the new 5-minute interval
    ticker.onTurn({ ok: true });
    setSetting(w.runnerState, ENGINE_LOOP_MINUTES_KEY, "60");
    w.now.t += 30 * MIN;
    ticker.poll();
    expect(sent).toHaveLength(2); // the longer interval holds it back
    w.now.t += 30 * MIN;
    ticker.poll();
    expect(sent).toHaveLength(3);
    ticker.close();
  });
  it("a check-in below the loop's floor of 5 minutes is left out", () => {
    writeFileSync(path.join(w.checkout, ".autonomous-team", "config.json"), JSON.stringify({ cloud_bridge: { ticks: [{ name: "EB-12c", every_min: 4 }, { name: "EB-12d", every_min: 5 }] } }), { mode: 0o644 });
    expect(readCheckins(w.checkout, uid)).toEqual([{ name: "EB-12d", every_min: 5 }]);
  });
});

describe("EB-12c.5 a stored session that cannot be resumed is dropped", () => {
  it("clears the session file when a --resume start ends before its init line, logs it, and the next launch is fresh", async () => {
    const store = openSessionStore(w.state, uid);
    store.save(SID);
    const sup = makeSupervisor([], { sessionStore: store, launch: (spec) => launchFake(spec, spec.args.includes("--resume") ? { FAKE_RESUME_FAILS: "1" } : {}) });
    expect(await sup.start()).toEqual({ ok: true });
    expect(w.specs[0]!.args).toContain("--resume");
    await until(() => !existsSync(path.join(w.state, SESSION_FILE)), "the session file to be cleared");
    expect(sup.sessionId()).toBeUndefined();
    expect(readFileSync(path.join(w.state, "engine-host.log"), "utf8")).toContain("the stored session could not be resumed");
    await until(() => w.timers.some((t) => t.live && t.ms === 60_000), "the restart timer");
    w.timers.find((t) => t.live && t.ms === 60_000)!.fn();
    await until(() => w.specs.length === 2, "the second launch");
    expect(w.specs[1]!.args).not.toContain("--resume");
    await until(() => w.records().filter((r) => r.event === "start").length === 2, "the fresh host");
    expect((w.records()[1]!.argv as string[]).includes("--resume")).toBe(false);
    await until(() => sup.sessionId() === SID, "the fresh init line");
    await sup.stop("machine_shutdown");
  });
  it("a host that did print its init line and then crashes is resumed again, not forgotten", async () => {
    const store = openSessionStore(w.state, uid);
    store.save(SID); // the first launch is itself a resume
    const sup = makeSupervisor([], { sessionStore: store });
    expect(await sup.start()).toEqual({ ok: true });
    expect(w.specs[0]!.args.slice(-2)).toEqual(["--resume", SID]);
    await until(() => sup.sessionId() === SID && existsSync(path.join(w.state, SESSION_FILE)), "the init line");
    await until(() => existsSync(path.join(w.state, "engine-host.log")) && readFileSync(path.join(w.state, "engine-host.log"), "utf8").includes('"subtype":"init"'), "the init line in the host log");
    process.kill(-w.pids[0]!, "SIGKILL");
    await until(() => !alive(w.pids[0]!), "the host to be gone");
    await new Promise((r) => setTimeout(r, 150));
    await until(() => w.timers.some((t) => t.live && t.ms === 60_000), "the restart timer");
    expect(store.load()).toBe(SID);
    [...w.timers].reverse().find((t) => t.live && t.ms === 60_000)!.fn();
    await until(() => w.specs.length === 2, "the second launch");
    expect(w.specs[1]!.args.slice(-2)).toEqual(["--resume", SID]);
    await sup.stop("machine_shutdown");
  });
  it("counts a resume as failed only when the process exits within RESUME_FAIL_WITHIN_MS of its launch, before any init line and before any input: later, or after a message, the session is kept", async () => {
    expect(RESUME_FAIL_WITHIN_MS).toBe(30_000);
    // (a) no init line, exits, but only after 31 s: an ordinary crash of a host that was waiting for its first message.
    {
      const store = openSessionStore(w.state, uid);
      store.save(SID);
      const slow = (spec: HostSpawnSpec) => {
        const child = launchFake(spec, { FAKE_RESUME_FAILS: "1" });
        return { ...child, onExit: (cb: () => void) => child.onExit(() => { w.now.t += RESUME_FAIL_WITHIN_MS + 1_000; cb(); }) };
      };
      const sup = makeSupervisor([], { sessionStore: store, launch: slow });
      const t0 = w.now.t;
      expect(await sup.start()).toEqual({ ok: true });
      // The heartbeat timer is also 60 s, so a timer proves nothing: wait for the host itself to be gone and for the exit path (the wrapper above moved the clock) to have run.
      await until(() => w.records().some((r) => r.event === "start") && !alive(w.pids[0]!), "the host to have exited");
      await until(() => w.now.t >= t0 + RESUME_FAIL_WITHIN_MS, "the exit handler to have run");
      await new Promise((r) => setTimeout(r, 150));
      expect(store.load()).toBe(SID);
      expect(readFileSync(path.join(w.state, "engine-host.log"), "utf8")).not.toContain("could not be resumed");
      await sup.stop("machine_shutdown");
    }
    // (b) exits just inside the window: failed.
    w = setup();
    {
      const store = openSessionStore(w.state, uid);
      store.save(SID);
      const quick = (spec: HostSpawnSpec) => {
        const child = launchFake(spec, { FAKE_RESUME_FAILS: "1" });
        return { ...child, onExit: (cb: () => void) => child.onExit(() => { w.now.t += RESUME_FAIL_WITHIN_MS - 1; cb(); }) };
      };
      const sup = makeSupervisor([], { sessionStore: store, launch: quick });
      expect(await sup.start()).toEqual({ ok: true });
      await until(() => store.load() === undefined, "the session to be dropped");
      await sup.stop("machine_shutdown");
    }
    // (c) no init line at all (the CLI may print it only after its first input), a message is sent, then it crashes at once: kept.
    w = setup();
    {
      const store = openSessionStore(w.state, uid);
      store.save(SID);
      const sup = makeSupervisor([], { sessionStore: store, launch: (spec) => launchFake(spec, { FAKE_NO_INIT: "1" }) });
      expect(await sup.start()).toEqual({ ok: true });
      await until(() => w.records().some((r) => r.event === "start"), "the host");
      expect(sup.send("hello")).toBe(true);
      await until(() => w.users().length === 1, "the message at the host");
      process.kill(-w.pids[0]!, "SIGKILL");
      await until(() => !alive(w.pids[0]!), "the host to be gone");
      await until(() => w.timers.some((t) => t.live && t.ms === 60_000), "the restart timer");
      expect(store.load()).toBe(SID);
      await sup.stop("machine_shutdown");
    }
  });
});

describe("EB-12c hardening round", () => {
  const command = (id: string, seq: number, kind: string, args: Record<string, unknown>): string => {
    const name = `${seq}-${id}`;
    writeFileSync(path.join(w.state, HOST_INBOX_DIR, `${name}.json`), JSON.stringify({ v: 1, purpose: "engine_command_v1", command_id: id, command_seq: seq, runner_id: id, repo_gh_id: 4242, issued_by: id, issued_at: new Date(w.now.t - 1000).toISOString(), expires_at: new Date(w.now.t + 5 * MIN).toISOString(), halt_epoch: 0, kind, args }), { mode: 0o600 });
    return name;
  };
  const runtime = (stopBox: { stop?: (r: "machine_shutdown") => void }): EngineHostRuntime => ({
    platform: "linux",
    locateClaude: () => w.claude,
    inspectClaude: async () => true,
    ownPid: process.pid,
    processStart: (pid) => (pid === process.pid ? "T0" : `st-${pid}`),
    readCgroup: () => undefined,
    onProcessExit: () => undefined,
    launch: (spec) => launchFake(spec, { FAKE_KEY_SOURCE: "none" }),
    env: w.fakeEnv,
    isAlive: alive,
    scopeAvailable: async () => true,
    killHost: async (h) => void process.kill(-h.pid, "SIGKILL"),
    killScope: async () => undefined,
    now: () => w.now.t,
    after,
    shutdown: () => new Promise((resolve) => (stopBox.stop = resolve)),
  });

  it("S1 when the bridge state cannot be read, a command that needs the host up is refused operate_off, and none of answer_ask, pause_loop or stop_agent is applied as if halted", async () => {
    const box: { stop?: (r: "machine_shutdown") => void } = {};
    const done = engineHostCommand(["start"], { out: () => undefined, stateDir: w.runnerState } as never, { engineStateDirOverride: w.state, home: w.dir, deps: { platform: "linux", uid } as never, runtime: runtime(box) });
    await until(() => w.timers.some((t) => t.live && t.ms === POLL_MS), "the ticker's poll timer");
    // The state file turns unreadable (a group-writable mode) after the host started.
    chmodSync(path.join(w.state, BRIDGE_STATE_FILE), 0o666);
    const ids = ["00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000b3"];
    const names = [
      command(ids[0]!, 1, "answer_ask", { ask_id: "0123456789abcdef", choice: "approve" }),
      command(ids[1]!, 2, "pause_loop", {}),
      command(ids[2]!, 3, "stop_agent", { agent_id: "agent_4" }),
    ];
    [...w.timers].reverse().find((t) => t.live && t.ms === POLL_MS)!.fn();
    for (const name of names) {
      const file = path.join(w.state, "engine-inbox", "done", `${name}.outcome.json`);
      await until(() => existsSync(file), `the outcome of ${name}`);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ outcome: "refused", refusal: "operate_off" });
    }
    expect(w.users()).toEqual([]);
    box.stop?.("machine_shutdown");
    await done;
  });

  it("S3 a host that exits settles its commands first: the queued one is refused and the one in flight is not_confirmed before engine-host.json is removed", async () => {
    const handleFile = path.join(w.state, "engine-host.json");
    const seen: Array<{ atEntry: boolean; atReturn: boolean; outcomesAtReturn: string[] }> = [];
    const doneDir = path.join(w.state, "engine-inbox", "done");
    const store = openSessionStore(w.state, uid);
    const held: { ticker?: Ticker } = {};
    const sup = makeSupervisor([], {
      sessionStore: store,
      launch: (spec) => launchFake(spec, { FAKE_SILENT_ON: "1" }), // the first message never gets a result
      observer: {
        onTurn: (t) => held.ticker?.onTurn(t),
        onExit: () => {
          const atEntry = existsSync(handleFile);
          held.ticker?.onHostExit();
          seen.push({ atEntry, atReturn: existsSync(handleFile), outcomesAtReturn: readdirSync(doneDir).filter((f) => f.endsWith(".outcome.json")).sort() });
        },
      },
    });
    const ticker = (held.ticker = createTicker({ send: (t) => sup.send(t), touch: () => sup.touch(), emit: () => undefined, now: () => w.now.t, after, settings: () => ({}), localClock: () => ({ date: "2026-11-16", hhmm: "10:00" }), credentialMode: () => "subscription", repoGhId: 4242, gate: () => undefined, inbox: openHostInbox(w.state, uid) }));
    expect(await sup.start()).toEqual({ ok: true });
    await until(() => w.records().some((r) => r.event === "start"), "the host");
    const inFlight = command("00000000-0000-4000-8000-0000000000c1", 1, "answer_ask", { ask_id: "0123456789abcdef", choice: "approve" });
    const queued = command("00000000-0000-4000-8000-0000000000c2", 2, "answer_ask", { ask_id: "fedcba9876543210", choice: "decline" }); // another ask: a second answer to the same ask is refused earlier
    ticker.poll();
    await until(() => w.users().length === 1, "the first message at the host");
    process.kill(-w.pids[0]!, "SIGKILL");
    await until(() => seen.length === 1, "the observer's exit call");
    expect(seen[0]!.atEntry).toBe(true); // the handle is still there when the ticker is told
    expect(seen[0]!.atReturn).toBe(true);
    expect(seen[0]!.outcomesAtReturn).toEqual([`${inFlight}.outcome.json`, `${queued}.outcome.json`].sort());
    expect(JSON.parse(readFileSync(path.join(doneDir, `${inFlight}.outcome.json`), "utf8"))).toEqual({ outcome: "not_confirmed" });
    expect(JSON.parse(readFileSync(path.join(doneDir, `${queued}.outcome.json`), "utf8"))).toEqual({ outcome: "refused", refusal: "host_not_running" });
    await until(() => !existsSync(handleFile), "the handle to be removed after the outcomes");
    ticker.close();
    await sup.stop("machine_shutdown");
  });

  it("the handle names the supervisor as claimer_pid and claimer_start next to the host's pid and start_time, all as strings of /proc/<pid>/stat field 22", async () => {
    // The reader the real command uses, taken from the program's own text so the test pins what ships.
    const bin = readFileSync(path.join(import.meta.dirname, "..", "..", "bin", "fx-runner.mjs"), "utf8");
    const src = bin.slice(bin.indexOf("const processStartTime"), bin.indexOf("const engineHaltDeps"));
    const make = (read: (file: string) => string): ((pid: number) => string | undefined) => new Function("readFileSync", `${src}\nreturn processStartTime;`)(read) as (pid: number) => string | undefined;
    // The name (field 2) holds spaces and a closing bracket: the fields are counted after the LAST bracket, like Python's rsplit(")", 1)[1].split()[19].
    const stat = "4242 (a b) c) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654321 1000 100 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0";
    const reference = stat.split(")").at(-1)!.split(/\s+/).filter(Boolean)[19];
    expect(reference).toBe("987654321");
    expect(make(() => stat)(4242)).toBe(reference);
    expect(make(() => { throw new Error("gone"); })(4242)).toBeUndefined();
    // The real thing, on this machine: a string of digits, equal to the reference reading of /proc/self/stat.
    const real = make((file) => readFileSync(file, "utf8"));
    const self = readFileSync("/proc/self/stat", "utf8");
    const own = real(process.pid);
    expect(typeof own).toBe("string");
    expect(own).toMatch(/^[0-9]+$/);
    expect(own).toBe(self.split(")").at(-1)!.split(/\s+/).filter(Boolean)[19]);
    // The handle and the lock written with that reader.
    const startOf = (pid: number): string | undefined => real(pid);
    const sup = makeSupervisor([], {
      startTimeOf: startOf,
      claimer: { pid: process.pid, start: startOf(process.pid) },
      acquireLock: () => acquireHostLock(w.state, uid, { ownPid: process.pid, isAlive: alive, startOf }),
    });
    expect(await sup.start()).toEqual({ ok: true });
    const handle = JSON.parse(readFileSync(path.join(w.state, "engine-host.json"), "utf8")) as Record<string, unknown>;
    const lock = JSON.parse(readFileSync(path.join(w.state, "engine-host.lock"), "utf8")) as Record<string, unknown>;
    expect(handle.pid).toBe(w.pids[0]);
    expect(typeof handle.start_time).toBe("string");
    expect(handle.start_time).toMatch(/^[0-9]+$/);
    expect(handle.start_time).toBe(startOf(w.pids[0]!));
    expect(handle.claimer_pid).toBe(process.pid);
    expect(typeof handle.claimer_start).toBe("string");
    expect(handle.claimer_start).toMatch(/^[0-9]+$/);
    expect(handle.claimer_start).toBe(own);
    expect(lock.pid).toBe(process.pid);
    expect(typeof lock.start).toBe("string");
    expect(lock.start).toMatch(/^[0-9]+$/);
    expect(lock.start).toBe(own);
    // The reader accepts exactly these, and refuses a claimer pid or start that is not of that shape.
    expect(readHostHandle(w.state, uid)).toMatchObject({ pid: w.pids[0], start_time: handle.start_time, claimer_pid: process.pid, claimer_start: own });
    await sup.stop("machine_shutdown");
    for (const bad of [{ claimer_pid: "12" }, { claimer_pid: 1 }, { claimer_start: 5 }, { claimer_start: "a;b" }]) {
      writeFileSync(path.join(w.state, "engine-host.json"), JSON.stringify({ pid: 4242, ...bad }), { mode: 0o600 });
      expect(() => readHostHandle(w.state, uid), JSON.stringify(bad)).toThrow();
    }
  });

  it("the real command writes the claimer into engine-host.json", async () => {
    const box: { stop?: (r: "machine_shutdown") => void } = {};
    const done = engineHostCommand(["start"], { out: () => undefined, stateDir: w.runnerState } as never, { engineStateDirOverride: w.state, home: w.dir, deps: { platform: "linux", uid } as never, runtime: runtime(box) });
    await until(() => existsSync(path.join(w.state, "engine-host.json")), "the handle");
    expect(JSON.parse(readFileSync(path.join(w.state, "engine-host.json"), "utf8"))).toMatchObject({ claimer_pid: process.pid, claimer_start: "T0" });
    box.stop?.("machine_shutdown");
    await done;
  });
});

describe("EB-12c.6 the tick label follows the init line through the real command", () => {
  it("labels every tick api_key when the host's init line says apiKeyHelper, with no key variable in the environment", async () => {
    setSetting(w.runnerState, ENGINE_LOOP_MINUTES_KEY, "5");
    let stop: ((r: "machine_shutdown") => void) | undefined;
    const rt: EngineHostRuntime = {
      platform: "linux",
      locateClaude: () => w.claude,
      inspectClaude: async () => true,
      ownPid: process.pid,
      processStart: (pid) => (pid === process.pid ? "T0" : `st-${pid}`),
      readCgroup: () => undefined,
      onProcessExit: () => undefined,
      launch: (spec) => launchFake(spec, { FAKE_KEY_SOURCE: "apiKeyHelper" }),
      env: w.fakeEnv,
      isAlive: alive,
      scopeAvailable: async () => true,
      killHost: async (h) => void process.kill(-h.pid, "SIGKILL"),
      killScope: async () => undefined,
      now: () => w.now.t,
      after,
      shutdown: () => new Promise((resolve) => (stop = resolve)),
    };
    const done = engineHostCommand(["start"], { out: () => undefined, stateDir: w.runnerState } as never, { engineStateDirOverride: w.state, home: w.dir, deps: { platform: "linux", uid } as never, runtime: rt });
    await until(() => w.timers.some((t) => t.live && t.ms === POLL_MS), "the ticker's poll timer");
    await until(() => w.records().some((r) => r.event === "start"), "the host");
    await new Promise((r) => setTimeout(r, 100)); // its init line
    w.now.t += 5 * MIN;
    [...w.timers].reverse().find((t) => t.live && t.ms === POLL_MS)!.fn();
    await until(() => w.users().length >= 1, "the loop tick");
    await new Promise((r) => setTimeout(r, 100));
    stop?.("machine_shutdown");
    expect(await done).toBe(0);
    const ended = readFileSync(path.join(w.state, SPOOL_FILE), "utf8").trim().split("\n").map((l) => EngineEvent.parse(JSON.parse(l))).filter((l) => l.kind === "tick_ended");
    expect(ended.length).toBeGreaterThan(0);
    for (const l of ended) expect(l.credential_mode).toBe("api_key");
  });
});

describe("EB-12c fx-runner engine-host start: every feed is wired to a real source", () => {
  it("runs the loop at the runner's minutes, a configured check-in, a re-orient after a compaction, writes the spool and the session file, and settles a spawn command on the engine's own agent event", async () => {
    // The person's settings and the repo's config.
    setSetting(w.runnerState, ENGINE_LOOP_MINUTES_KEY, "5");
    writeFileSync(path.join(w.checkout, ".autonomous-team", "config.json"), JSON.stringify({ cloud_bridge: { enabled: true, operate: true, ticks: [{ name: "EB-12c", every_min: 10 }] } }), { mode: 0o644 });
    const eventsFile = path.join(w.state, ENGINE_EVENTS_FILE);
    writeFileSync(eventsFile, "", { mode: 0o600 });
    let stop: ((r: "machine_shutdown") => void) | undefined;
    const rt: EngineHostRuntime = {
      platform: "linux",
      locateClaude: () => w.claude,
      inspectClaude: async () => true,
      ownPid: process.pid,
      processStart: (pid) => (pid === process.pid ? "T0" : `st-${pid}`),
      readCgroup: () => undefined,
      onProcessExit: () => undefined,
      launch: (spec) => launchFake(spec, { FAKE_COMPACT_AFTER: "3", FAKE_KEY_SOURCE: "none" }),
      env: w.fakeEnv,
      isAlive: alive,
      scopeAvailable: async () => true,
      killHost: async (h) => void process.kill(-h.pid, "SIGKILL"),
      killScope: async () => undefined,
      now: () => w.now.t,
      after,
      shutdown: () => new Promise((resolve) => (stop = resolve)),
    };
    const out: string[] = [];
    const done = engineHostCommand(["start"], { out: (t: string) => out.push(t), stateDir: w.runnerState } as never, { engineStateDirOverride: w.state, home: w.dir, deps: { platform: "linux", uid } as never, runtime: rt });
    await until(() => w.timers.some((t) => t.live && t.ms === POLL_MS), "the ticker's poll timer");
    const poll = async (ms: number, users: number): Promise<void> => {
      w.now.t += ms;
      [...w.timers].reverse().find((t) => t.live && t.ms === POLL_MS)!.fn();
      await until(() => w.users().length >= users, `${users} message(s) at the host`);
      await new Promise((r) => setTimeout(r, 60)); // its result line
    };
    await poll(5 * MIN, 1); // the loop tick, at the runner's 5 minutes (the default would be 15)
    expect(w.users()).toEqual([renderPrompt("loop")]);
    await poll(5 * MIN, 2); // 10 min: the check-in of the engine config (its loop tick is also due; they are queued one after another)
    await until(() => w.users().length >= 3, "the second tick");
    expect(w.users()).toEqual(expect.arrayContaining([renderPrompt("loop"), renderPrompt("checkin", { name: "EB-12c" })]));
    // The third message makes the fake CLI compact: the next tick is the re-orient one.
    await until(() => w.users().includes(renderPrompt("reorient")), "the re-orient tick");
    // A spawn command is settled by the engine's own agent_started line, read from the engine's events file.
    const id = "00000000-0000-4000-8000-0000000000f1";
    const name = `1-${id}`;
    writeFileSync(path.join(w.state, HOST_INBOX_DIR, `${name}.json`), JSON.stringify({ v: 1, purpose: "engine_command_v1", command_id: id, command_seq: 1, runner_id: id, repo_gh_id: 4242, issued_by: id, issued_at: new Date(w.now.t - 1000).toISOString(), expires_at: new Date(w.now.t + 5 * MIN).toISOString(), halt_epoch: 0, kind: "request_spawn", args: { role: "executor", discussion: 77 } }), { mode: 0o600 });
    await poll(5_000, 5);
    await until(() => w.users().some((u) => u.startsWith("Owner requested executor for D#77")), "the spawn command's tick");
    await new Promise((r) => setTimeout(r, 100));
    appendFileSync(eventsFile, `${JSON.stringify({ v: 1, engine_instance_id: "11111111-2222-4333-8444-555555555555", seq: 0, ts: new Date(w.now.t).toISOString(), kind: "agent_started", spawn_id: "toolu_x1", role: "executor", discussion: 77, background: true, isolation: "worktree" })}\n`);
    w.now.t += 5_000;
    [...w.timers].reverse().find((t) => t.live && t.ms === POLL_MS)!.fn();
    const outcomeFile = path.join(w.state, "engine-inbox", "done", `${name}.outcome.json`);
    await until(() => existsSync(outcomeFile), "the spawn outcome");
    expect(JSON.parse(readFileSync(outcomeFile, "utf8"))).toEqual({ outcome: "applied" });
    // The host ends; what it emitted is in the spool, valid, and the session id is on disk for the next start.
    stop?.("machine_shutdown");
    expect(await done).toBe(0);
    const lines = readFileSync(path.join(w.state, SPOOL_FILE), "utf8").trim().split("\n").map((l) => EngineEvent.parse(JSON.parse(l)));
    const kinds = lines.map((l) => l.kind);
    expect(kinds[0]).toBe("host_started");
    expect(kinds.at(-1)).toBe("host_stopped");
    expect(kinds).toContain("compaction_detected");
    expect(lines.filter((l) => l.kind === "tick_started").map((l) => (l.kind === "tick_started" ? l.tick_kind : ""))).toEqual(expect.arrayContaining(["loop", "checkin", "reorient", "command"]));
    for (const l of lines) if (l.kind === "tick_ended") expect(l.credential_mode).toBe("subscription");
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i));
    expect(JSON.parse(readFileSync(path.join(w.state, SESSION_FILE), "utf8"))).toEqual({ session_id: SID });
    expect(out).toContain("Engine host started.");
  });
  it("a refused start leaves no spool and no session file behind", async () => {
    writeFileSync(path.join(w.state, BRIDGE_STATE_FILE), JSON.stringify({ repo_gh_id: "4242", bridge_enabled: true, operate_enabled: false, repo_checkout: w.checkout }), { mode: 0o600 });
    const rt = { platform: "linux", locateClaude: () => w.claude, inspectClaude: async () => true, ownPid: process.pid, processStart: () => "T0", readCgroup: () => undefined, onProcessExit: () => undefined, launch: () => { throw new Error("no spawn"); }, env: {}, isAlive: alive, scopeAvailable: async () => true, killHost: async () => undefined, killScope: async () => undefined, now: () => w.now.t, after, shutdown: () => new Promise(() => undefined) } as EngineHostRuntime;
    expect(await engineHostCommand(["start"], { out: () => undefined, stateDir: w.runnerState } as never, { engineStateDirOverride: w.state, home: w.dir, deps: { platform: "linux", uid } as never, runtime: rt })).toBe(1);
    expect(existsSync(path.join(w.state, SPOOL_FILE))).toBe(false);
    expect(existsSync(path.join(w.state, SESSION_FILE))).toBe(false);
  });
});
