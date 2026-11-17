import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_HALT_FILE, ENGINE_HOST_FILE, readHostHandle, writeHaltFile } from "../../src/engineBridge/halt.js";
import { engineHostCommand, type EngineHostRuntime } from "../../src/commands/engineHost.js";
import { acquireHostLock, TAKEOVER_GUARD_MS, BRIDGE_STATE_FILE, HOST_LOCK_FILE, HOST_LOG_FILE, openHostLog, readBridgeState, isRepoGhId, type BridgeState, type HostLog } from "../../src/engineHost/hostFiles.js";
import { assertHostArgv, BACKOFF_MS, createSupervisor, CRASH_LIMIT, HEARTBEAT_MS, HOST_ARGS, STOP_GRACE_MS, type HostChild, type HostEvent, type HostSpawnSpec, type StopReason, type Supervisor } from "../../src/engineHost/supervisor.js";

const uid = process.getuid?.() ?? -1;
const SID = "e6a767e1-7e3f-44a4-bfb1-3c331803d4ee";
const STREAM_CANARY = "STREAM_CANARY_5521";
const PROMPT_CANARY = "PROMPT_CANARY_8830";

/** A stand-in for the installed CLI that speaks the stream-json contract (event shapes read off the real CLI 2.1.325 spike): an `init` line, one `result` per user line, a `task_notification` and a result with no input. */
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
const rec = process.env.FAKE_RECORD, mode = process.env.FAKE_MODE, sid = process.env.FAKE_SESSION;
const log = (o) => fs.appendFileSync(rec, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
log({ event: "start", argv: process.argv.slice(2), cwd: process.cwd() });
const init = () => out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, tools: ["Agent", "Bash"] });
const result = () => out({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", session_id: sid });
init();
process.stderr.write("${STREAM_CANARY}\\n");
if (mode === "crash") process.exit(3);
let buf = "", turns = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    log({ event: "user", type: m.type, role: m.message.role });
    init();
    result();
    if (++turns === 1) setTimeout(() => { out({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed", summary: "done" }); result(); log({ event: "autonomous_turn" }); }, 100);
  }
});
process.stdin.on("end", () => { log({ event: "stdin_end" }); if (mode !== "stubborn") process.exit(0); });
if (mode === "stubborn") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
`;

const until = async (cond: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface MakeOver {
  platform?: NodeJS.Platform;
  scope?: boolean;
  uid?: number;
  log?: HostLog;
}

interface World {
  dir: string;
  state: string;
  checkout: string;
  claude: string;
  record: string;
  specs: HostSpawnSpec[];
  pids: number[];
  events: HostEvent[];
  killed: string[];
  scoped: string[];
  timers: Array<{ ms: number; fn: () => void; live: boolean }>;
  now: { t: number };
  sup: Supervisor;
  records: () => Array<Record<string, unknown>>;
  fire: (ms: number) => void;
  setState: (s: Partial<BridgeState>) => void;
  make: (modes: string[], over?: MakeOver) => Supervisor;
  /** What `isOurHost` answers, by pid. */
  ours: Set<number>;
  /** The start time each pid reports (the lock compares it); this process is "T0". */
  starts: Map<number, string>;
  /** Runs once the host process exists and before the supervisor learns its pid: a halt written here lands between the spawn and the handle write. */
  afterSpawn: (() => void) | undefined;
  killResult: unknown;
}

let w: World;

function setup(): World {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fx-eb12a-"));
  const state = path.join(dir, "state");
  mkdirSync(state, { mode: 0o700 });
  const checkout = path.join(dir, "repo");
  mkdirSync(checkout);
  const claude = path.join(dir, "fake-agent");
  writeFileSync(claude, FAKE);
  chmodSync(claude, 0o755);
  const world = { dir, state, checkout, claude, record: path.join(dir, "record.jsonl"), specs: [], pids: [], events: [], killed: [], scoped: [], timers: [], now: { t: 1_000_000 }, ours: new Set<number>(), starts: new Map<number, string>(), afterSpawn: undefined, killResult: undefined } as unknown as World;
  const gate: BridgeState = { repo_gh_id: "123", bridge_enabled: true, operate_enabled: true, repo_checkout: checkout };
  const writeGate = (g: BridgeState): void => writeFileSync(path.join(state, BRIDGE_STATE_FILE), JSON.stringify(g), { mode: 0o600 });
  writeGate(gate);
  world.setState = (s) => writeGate({ ...gate, ...s });
  world.records = () => (existsSync(world.record) ? readFileSync(world.record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  world.fire = (ms) => {
    const t = [...world.timers].reverse().find((x) => x.live && x.ms === ms);
    if (t === undefined) throw new Error(`no timer of ${ms} ms`);
    t.live = false;
    t.fn();
  };
  world.make = (modes, over = {}) => {
    let n = 0;
    world.sup = createSupervisor({
      stateDir: state,
      uid: over.uid ?? uid,
      platform: over.platform ?? "linux",
      claudePath: claude,
      readBridgeState: () => readBridgeState(state, uid),
      env: { PATH: process.env.PATH ?? "" },
      log: over.log ?? openHostLog(state, uid),
      emit: (e) => world.events.push(e),
      now: () => world.now.t,
      after: (ms, fn) => {
        const t = { ms, fn, live: true };
        world.timers.push(t);
        return () => void (t.live = false);
      },
      isAlive: alive,
      startTimeOf: (pid) => `st-${pid}`,
      isOurHost: (h) => world.ours.has(h.pid),
      acquireLock: () => acquireHostLock(state, uid, { ownPid: process.pid, isAlive: alive, startOf: (pid) => (pid === process.pid ? "T0" : world.starts.get(pid)) }),
      scopeAvailable: async () => over.scope ?? true,
      killHost: async (h) => {
        world.killed.push(`${h.pid}:${h.unit}`);
        process.kill(-h.pid, "SIGKILL");
        return world.killResult;
      },
      killScope: async (u) => void world.scoped.push(u),
      launch: (spec) => {
        world.specs.push(spec);
        const mode = modes[Math.min(n++, modes.length - 1)] ?? "serve";
        const sep = spec.args.indexOf("--");
        const [file, ...rest] = spec.args.slice(sep + 1);
        const child = spawn(file ?? "", rest, { cwd: spec.cwd, env: { ...spec.env, FAKE_MODE: mode, FAKE_RECORD: world.record, FAKE_SESSION: SID }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdin.on("error", () => undefined);
        child.on("error", () => undefined);
        if (child.pid !== undefined) world.pids.push(child.pid);
        world.afterSpawn?.();
        return {
          pid: child.pid,
          write: (t) => void child.stdin.write(t),
          closeStdin: () => child.stdin.end(),
          onStdout: (cb) => child.stdout.on("data", cb),
          onStderr: (cb) => child.stderr.on("data", cb),
          onExit: (cb) => child.on("exit", () => cb()),
        };
      },
    });
    return world.sup;
  };
  return world;
}

const stoppedReasons = (): StopReason[] => w.events.flatMap((e) => (e.kind === "host_stopped" ? [e.reason] : []));
/** The host has died and its back-off timer is set (the dead host's handle is gone and the heartbeat is cancelled). */
const inBackoff = (ms?: number): boolean => !existsSync(path.join(w.state, ENGINE_HOST_FILE)) && w.timers.some((t) => t.live && (ms === undefined || t.ms === ms));
const started = (): number => w.events.filter((e) => e.kind === "host_started").length;

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

describe("EB-12a start refusals", () => {
  const refuses = async (reason: string, over?: Parameters<World["make"]>[1]): Promise<void> => {
    const r = await w.make(["serve"], over).start();
    expect(r).toEqual({ ok: false, reason });
    expect(w.specs).toHaveLength(0);
  };
  it("refuses when the bridge is off, when operate is off, and when the bridge state is missing or malformed", async () => {
    w.setState({ bridge_enabled: false });
    await refuses("bridge_disabled");
    w.setState({ operate_enabled: false });
    await refuses("operate_off");
    writeFileSync(path.join(w.state, BRIDGE_STATE_FILE), JSON.stringify({ repo_gh_id: "1; rm", bridge_enabled: true, operate_enabled: true, repo_checkout: w.checkout }), { mode: 0o600 });
    await refuses("state_unreadable");
    rmSync(path.join(w.state, BRIDGE_STATE_FILE));
    await refuses("bridge_disabled");
  });
  it("refuses while a halt file says halted, a cloud halt and a local stop alike, and starts once it is cleared", async () => {
    writeHaltFile(w.state, { halted: true, halt_epoch: 4, at: "2026-11-16T10:00:00.000Z" }, uid);
    await refuses("halted");
    writeHaltFile(w.state, { halted: true, halt_epoch: 4, at: "2026-11-16T10:00:00.000Z", local_stop: true }, uid);
    await refuses("halted");
    writeFileSync(path.join(w.state, ENGINE_HALT_FILE), "{not json", { mode: 0o600 });
    await refuses("state_unreadable");
    writeHaltFile(w.state, { halted: false, halt_epoch: 4, at: "2026-11-16T10:00:00.000Z" }, uid);
    expect(await w.make(["serve"]).start()).toEqual({ ok: true });
    await w.sup.stop("stopped_by_person");
  });
  it("refuses off Linux or without a usable scope (platform_kill_unverified), and as root", async () => {
    await refuses("platform_kill_unverified", { platform: "darwin" });
    await refuses("platform_kill_unverified", { scope: false });
    await refuses("running_as_root", { uid: 0 });
  });
  it("refuses while the recorded host is alive and is really in its scope, and replaces a record that is dead or whose pid was reused", async () => {
    const unit = "fx-engine-host-123.scope";
    writeFileSync(path.join(w.state, ENGINE_HOST_FILE), JSON.stringify({ pid: process.pid, unit }), { mode: 0o600 });
    w.ours.add(process.pid);
    await refuses("already_running");
    expect(existsSync(path.join(w.state, HOST_LOCK_FILE))).toBe(false); // a refusal gives the lock back
    // The pid is alive but its cgroup is not the scope (a reused pid): stale, replaced.
    w.ours.clear();
    expect(await w.make(["serve"]).start()).toEqual({ ok: true });
    expect(readHostHandle(w.state, uid)?.pid).toBe(w.pids[0]);
    await w.sup.stop("stopped_by_person");
    writeFileSync(path.join(w.state, ENGINE_HOST_FILE), JSON.stringify({ pid: 2 ** 22 - 1, unit }), { mode: 0o600 });
    expect(await w.make(["serve"]).start()).toEqual({ ok: true });
    await w.sup.stop("stopped_by_person");
  });
});

describe("EB-12a how the host is started", () => {
  it("runs the fixed vector in a scope named for the repo, in the checkout, with the given environment and no permission-skipping flag", async () => {
    expect(await w.make(["serve"]).start()).toEqual({ ok: true });
    const spec = w.specs[0]!;
    expect(spec.file).toBe("systemd-run");
    expect(spec.args).toEqual(["--user", "--scope", "--quiet", "--unit=fx-engine-host-123", "--", w.claude, ...HOST_ARGS]);
    expect(HOST_ARGS).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
    expect(spec.cwd).toBe(w.checkout);
    expect(spec.env).toEqual({ PATH: process.env.PATH ?? "" });
    expect(spec.args.join(" ")).not.toMatch(/permission|dangerous|bypass|allowedTools/i);
    await until(() => w.records().some((r) => r.event === "start"), "the host to start");
    expect(w.records()[0]).toMatchObject({ argv: [...HOST_ARGS] });
    expect(statSync(String(w.records()[0]?.cwd)).ino).toBe(statSync(w.checkout).ino);
    await w.sup.stop("stopped_by_person");
  });
  it("refuses any added flag, and a resume id that is not a uuid", () => {
    expect(() => assertHostArgv([...HOST_ARGS])).not.toThrow();
    expect(() => assertHostArgv([...HOST_ARGS, "--resume", SID])).not.toThrow();
    for (const extra of [["--dangerously-skip-permissions"], ["--permission-mode", "bypassPermissions"], ["--allowedTools", "Bash"], ["--resume", "latest"], ["--resume", SID, "--model", "x"]]) {
      expect(() => assertHostArgv([...HOST_ARGS, ...extra])).toThrow();
    }
    expect(() => assertHostArgv(["--dangerously-skip-permissions", ...HOST_ARGS])).toThrow();
  });
  it("writes engine-host.json {pid, unit} at 0600 for EB-11b's kill path, and removes it when the host ends", async () => {
    await w.make(["serve"]).start();
    const file = path.join(w.state, ENGINE_HOST_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readHostHandle(w.state, uid)).toEqual({ pid: w.pids[0], unit: "fx-engine-host-123.scope", start_time: `st-${w.pids[0]}` });
    await w.sup.stop("stopped_by_person");
    expect(existsSync(file)).toBe(false);
  });
});

describe("EB-12a stdin stays open", () => {
  it("keeps stdin open across turns, a completion notice and an autonomous turn, and closes it only at stop", async () => {
    await w.make(["serve"]).start();
    expect(w.sup.send("turn one")).toBe(true);
    await until(() => w.records().some((r) => r.event === "autonomous_turn"), "the notification turn");
    expect(w.sup.send("turn two")).toBe(true);
    await until(() => w.records().filter((r) => r.event === "user").length === 2, "turn two");
    expect(w.records().some((r) => r.event === "stdin_end")).toBe(false);
    expect(alive(w.pids[0]!)).toBe(true);
    await w.sup.stop("stopped_by_person");
    expect(w.records().filter((r) => r.event === "stdin_end")).toHaveLength(1);
  });
  it("keeps stdin open on a restarted host as well, and sends nothing when there is no host", async () => {
    await w.make(["crash", "serve"]).start();
    await until(() => inBackoff(BACKOFF_MS[0]), "the first back-off");
    expect(w.sup.send("nobody home")).toBe(false);
    w.fire(BACKOFF_MS[0]!);
    await until(() => started() === 2, "the restart");
    expect(w.sup.send("hello")).toBe(true);
    await until(() => w.records().some((r) => r.event === "user"), "the user line");
    expect(w.records().some((r) => r.event === "stdin_end")).toBe(false);
    await w.sup.stop("stopped_by_person");
  });
});

describe("EB-12a crashes", () => {
  it("restarts with --resume <session id> after 1, 2 and 5 minutes", async () => {
    await w.make(["crash", "crash", "crash", "serve"]).start();
    for (const [i, ms] of [60_000, 120_000, 300_000].entries()) {
      await until(() => inBackoff(ms), `back-off ${ms}`);
      expect(existsSync(path.join(w.state, ENGINE_HOST_FILE))).toBe(false);
      expect(w.specs).toHaveLength(i + 1);
      w.fire(ms);
      await until(() => w.specs.length === i + 2, "the restart");
    }
    expect(BACKOFF_MS).toEqual([60_000, 120_000, 300_000]);
    expect(w.specs[0]!.args).not.toContain("--resume");
    for (const spec of w.specs.slice(1)) expect(spec.args.slice(-2)).toEqual(["--resume", SID]);
    await until(() => started() === 4 && existsSync(path.join(w.state, ENGINE_HOST_FILE)), "the fourth host");
    expect(w.scoped).toContain("fx-engine-host-123.scope");
    await w.sup.stop("stopped_by_person");
  });
  it("stops for good on the sixth crash within an hour (crash_loop) and starts nothing more", async () => {
    await w.make(["crash"]).start();
    for (let i = 1; i < CRASH_LIMIT; i++) {
      await until(() => inBackoff(), `back-off ${i}`);
      w.fire(w.timers.filter((t) => t.live).at(-1)!.ms);
      await until(() => w.specs.length === i + 1, "the restart");
    }
    expect(await w.sup.stopped).toBe("crash_loop");
    expect(w.specs).toHaveLength(CRASH_LIMIT);
    expect(w.timers.filter((t) => t.live)).toHaveLength(0);
    expect(existsSync(path.join(w.state, ENGINE_HOST_FILE))).toBe(false);
    expect(stoppedReasons()).toEqual(["crash_loop"]);
  });
  it("does not count crashes more than an hour apart", async () => {
    await w.make(["crash"]).start();
    for (let i = 1; i < CRASH_LIMIT + 2; i++) {
      await until(() => inBackoff(), `back-off ${i}`);
      w.now.t += 61 * 60_000;
      w.fire(w.timers.filter((t) => t.live).at(-1)!.ms);
      await until(() => w.specs.length === i + 1, "the restart");
    }
    expect(stoppedReasons()).toEqual([]);
    await w.sup.stop("machine_shutdown");
  });
  it("does not restart a halted host, whether the halt arrives while it runs or during the back-off", async () => {
    await w.make(["serve"]).start();
    writeHaltFile(w.state, { halted: true, halt_epoch: 9, at: "2026-11-16T10:00:00.000Z" }, uid);
    process.kill(-w.pids[0]!, "SIGKILL"); // what EB-11b's kill path does
    expect(await w.sup.stopped).toBe("halted");
    expect(w.specs).toHaveLength(1);
    rmSync(path.join(w.state, ENGINE_HALT_FILE));
    w.events.length = w.specs.length = w.timers.length = 0;
    const sup = w.make(["crash"]);
    await sup.start();
    await until(() => inBackoff(), "the back-off");
    writeHaltFile(w.state, { halted: true, halt_epoch: 10, at: "2026-11-16T10:00:00.000Z" }, uid);
    w.fire(60_000);
    expect(await sup.stopped).toBe("halted");
    expect(w.specs).toHaveLength(1);
  });
  it("stops with operate_off when operate is turned off before a restart", async () => {
    await w.make(["crash"]).start();
    await until(() => inBackoff(), "the back-off");
    w.setState({ operate_enabled: false });
    w.fire(60_000);
    expect(await w.sup.stopped).toBe("operate_off");
    expect(w.specs).toHaveLength(1);
  });
});

describe("EB-12a events, heartbeat and shutdown", () => {
  it("emits host_started, a host_heartbeat per 60 s and host_stopped with the reason", async () => {
    await w.make(["serve"]).start();
    expect(w.events).toEqual([{ kind: "host_started" }]);
    w.fire(60_000);
    w.fire(60_000);
    expect(w.events.filter((e) => e.kind === "host_heartbeat")).toHaveLength(2);
    await w.sup.stop("machine_shutdown");
    expect(w.events.at(-1)).toEqual({ kind: "host_stopped", reason: "machine_shutdown" });
    expect(w.timers.filter((t) => t.live)).toHaveLength(0);
    await w.sup.stop("stopped_by_person");
    expect(stoppedReasons()).toEqual(["machine_shutdown"]);
  });
  it("ends a clean stop by closing stdin, and uses the kill path only when the host outlives the grace", async () => {
    await w.make(["serve"]).start();
    await w.sup.stop("stopped_by_person");
    expect(w.killed).toEqual([]);
    expect(alive(w.pids[0]!)).toBe(false);
    rmSync(w.record);
    w.events.length = w.specs.length = w.timers.length = w.pids.length = 0;
    const sup = w.make(["stubborn"]);
    await sup.start();
    await until(() => w.records().some((r) => r.event === "start"), "the host");
    const stopping = sup.stop("machine_shutdown");
    await until(() => w.timers.some((t) => t.live && t.ms === STOP_GRACE_MS), "the grace timer");
    await until(() => w.records().some((r) => r.event === "stdin_end"), "stdin to close");
    w.fire(STOP_GRACE_MS);
    await stopping;
    expect(w.killed).toEqual([`${w.pids[0]}:fx-engine-host-123.scope`]);
    expect(await sup.stopped).toBe("machine_shutdown");
  });
});

describe("EB-12a what is logged", () => {
  it("writes the stream only to a 0600 local log, and the prompt and stream reach no event, record or file besides it", async () => {
    await w.make(["serve"]).start();
    w.sup.send(PROMPT_CANARY);
    await until(() => w.records().some((r) => r.event === "user"), "the user line");
    await w.sup.stop("stopped_by_person");
    const log = path.join(w.state, HOST_LOG_FILE);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    const text = readFileSync(log, "utf8");
    expect(text).toContain(STREAM_CANARY);
    expect(text).toContain('"subtype":"init"');
    expect(text).not.toContain(PROMPT_CANARY);
    expect(JSON.stringify(w.events)).not.toMatch(new RegExp(`${STREAM_CANARY}|${PROMPT_CANARY}|${SID}|result`));
    expect(JSON.stringify(w.specs)).not.toContain(PROMPT_CANARY);
    expect(readFileSync(path.join(w.dir, "record.jsonl"), "utf8")).not.toContain(PROMPT_CANARY);
  });
  it("rotates at the cap, refuses a link and a wide file, and never follows a link", () => {
    const log = openHostLog(w.state, uid, 100);
    log.write("a".repeat(60));
    log.write("b".repeat(60));
    log.close();
    expect(readFileSync(path.join(w.state, `${HOST_LOG_FILE}.1`), "utf8")).toBe("a".repeat(60));
    expect(readFileSync(path.join(w.state, HOST_LOG_FILE), "utf8")).toBe("b".repeat(60));
    rmSync(path.join(w.state, HOST_LOG_FILE));
    symlinkSync(path.join(w.dir, "elsewhere"), path.join(w.state, HOST_LOG_FILE));
    expect(() => openHostLog(w.state, uid)).toThrow(/link/);
    expect(existsSync(path.join(w.dir, "elsewhere"))).toBe(false);
    rmSync(path.join(w.state, HOST_LOG_FILE));
    writeFileSync(path.join(w.state, HOST_LOG_FILE), "", { mode: 0o644 });
    chmodSync(path.join(w.state, HOST_LOG_FILE), 0o644);
    expect(() => openHostLog(w.state, uid)).toThrow(/not safe/);
  });
  it("reads the bridge state only in its exact shape", () => {
    const put = (o: unknown): void => writeFileSync(path.join(w.state, BRIDGE_STATE_FILE), JSON.stringify(o), { mode: 0o600 });
    const ok = { repo_gh_id: "9", bridge_enabled: true, operate_enabled: false, repo_checkout: w.checkout };
    put(ok);
    expect(readBridgeState(w.state, uid)).toEqual(ok);
    for (const bad of [{ ...ok, extra: 1 }, { ...ok, repo_checkout: "relative/dir" }, { ...ok, repo_gh_id: "x" }, { ...ok, operate_enabled: "yes" }, [], null]) {
      put(bad);
      expect(() => readBridgeState(w.state, uid)).toThrow();
    }
  });
});

describe("EB-12a fx-runner engine-host start", () => {
  const runtimeFor = (shutdown: () => Promise<"stopped_by_person" | "machine_shutdown">): EngineHostRuntime => {
    return {
      platform: "linux",
      locateClaude: () => w.claude,
      inspectClaude: async () => true,
      ownPid: process.pid,
      processStart: (pid) => (pid === process.pid ? "T0" : undefined),
      readCgroup: () => undefined,
      onProcessExit: () => undefined,
      launch: () => {
        throw new Error("a refused start must not spawn");
      },
      env: {},
      isAlive: alive,
      scopeAvailable: async () => true,
      killHost: async () => undefined,
      killScope: async () => undefined,
      now: () => Date.now(),
      after: () => () => undefined,
      shutdown,
    };
  };
  it("prints only fixed sentences, and refuses with a fixed reason while halted", async () => {
    const out: string[] = [];
    const ctx = { out: (t: string) => out.push(t), stateDir: w.dir } as never;
    writeHaltFile(w.state, { halted: true, halt_epoch: 2, at: "2026-11-16T10:00:00.000Z" }, uid);
    const deps = { platform: "linux", uid } as never;
    const code = await engineHostCommand(["start"], ctx, { engineStateDirOverride: w.state, home: w.dir, deps, runtime: runtimeFor(() => new Promise(() => undefined)) });
    expect(code).toBe(1);
    expect(out).toEqual(["The engine is halted (a halt file says so), so the engine host will not start. Clear the halt first."]);
    out.length = 0;
    expect(await engineHostCommand(["status"], ctx, { engineStateDirOverride: w.state, home: w.dir, deps })).toBe(0);
    expect(out).toEqual(["Engine host: no host is recorded on this machine.", "Halt: halted (epoch 2)."]);
  });
});

const haltNow = (epoch = 9): void => writeHaltFile(w.state, { halted: true, halt_epoch: epoch, at: "2026-11-16T10:00:00.000Z" }, uid);
const handleFile = (): string => path.join(w.state, ENGINE_HOST_FILE);

describe("EB-12a a halt always stops the host", () => {
  it("stops a host whose halt landed between the spawn and the handle write: killed, no host_started, host_stopped halted, handle gone", async () => {
    w.afterSpawn = () => haltNow();
    expect(await w.make(["serve"]).start()).toEqual({ ok: true });
    expect(await w.sup.stopped).toBe("halted");
    expect(w.killed).toEqual([`${w.pids[0]}:fx-engine-host-123.scope`]);
    expect(w.scoped).toContain("fx-engine-host-123.scope");
    expect(w.events).toEqual([{ kind: "host_stopped", reason: "halted", survivors: 0 }]);
    expect(existsSync(handleFile())).toBe(false);
    expect(existsSync(path.join(w.state, HOST_LOCK_FILE))).toBe(false);
    await until(() => !alive(w.pids[0]!), "the host to be gone");
    expect(w.specs).toHaveLength(1);
  });
  it("does the same when operate is turned off between the spawn and the handle write, and when the files become unreadable", async () => {
    w.afterSpawn = () => w.setState({ operate_enabled: false });
    await w.make(["serve"]).start();
    expect(await w.sup.stopped).toBe("operate_off");
    expect(w.killed).toHaveLength(1);
    w.afterSpawn = () => writeFileSync(path.join(w.state, ENGINE_HALT_FILE), "{not json", { mode: 0o600 });
    w.setState({ operate_enabled: true });
    w.events.length = 0;
    await w.make(["serve"]).start();
    expect(await w.sup.stopped).toBe("halted"); // fail closed
    expect(w.killed).toHaveLength(2);
  });
  it("does not spawn at all when the halt landed after the refusal check but before the launch", async () => {
    let reads = 0;
    const sup = createSupervisor({
      stateDir: w.state,
      uid,
      platform: "linux",
      claudePath: w.claude,
      readBridgeState: () => {
        if (++reads === 2) haltNow(); // the second read is the launch's own check; the halt lands just before it
        return readBridgeState(w.state, uid);
      },
      env: {},
      log: openHostLog(w.state, uid),
      emit: () => undefined,
      now: () => 0,
      after: () => () => undefined,
      isAlive: alive,
      startTimeOf: () => "st",
      isOurHost: () => false,
      acquireLock: () => acquireHostLock(w.state, uid, { ownPid: process.pid, isAlive: alive, startOf: () => "T0" }),
      scopeAvailable: async () => true,
      killHost: async () => undefined,
      killScope: async () => undefined,
      launch: () => {
        throw new Error("must not spawn");
      },
    });
    expect(await sup.start()).toEqual({ ok: false, reason: "halted" });
    expect(existsSync(path.join(w.state, HOST_LOCK_FILE))).toBe(false);
  });
  it("stops a running host on the next heartbeat when a halt arrives mid-run, and the same for operate turned off", async () => {
    await w.make(["serve"]).start();
    w.fire(HEARTBEAT_MS);
    expect(w.events.filter((e) => e.kind === "host_heartbeat")).toHaveLength(1);
    haltNow();
    w.fire(HEARTBEAT_MS);
    expect(await w.sup.stopped).toBe("halted");
    expect(w.killed).toEqual([`${w.pids[0]}:fx-engine-host-123.scope`]);
    expect(w.events.filter((e) => e.kind === "host_heartbeat")).toHaveLength(1);
    expect(existsSync(handleFile())).toBe(false);
    await until(() => !alive(w.pids[0]!), "the host to be gone");
    rmSync(path.join(w.state, ENGINE_HALT_FILE));
    w.events.length = w.killed.length = w.timers.length = 0;
    await w.make(["serve"]).start();
    w.setState({ operate_enabled: false });
    w.fire(HEARTBEAT_MS);
    expect(await w.sup.stopped).toBe("operate_off");
    expect(w.killed).toHaveLength(1);
    expect(stoppedReasons()).toEqual(["operate_off"]);
  });
});

describe("EB-12a the repo id and the handle", () => {
  it("accepts only a plain decimal of at most 19 digits with no leading zero, the pattern the kill path reads the unit back with", async () => {
    for (const bad of ["0", "0123", "12345678901234567890", "", "-1", "1e3", " 1"]) expect(isRepoGhId(bad)).toBe(false);
    for (const good of ["1", "123", "9223372036854775807"]) expect(isRepoGhId(good)).toBe(true);
    for (const bad of ["0", "0123", "12345678901234567890"]) {
      writeFileSync(path.join(w.state, BRIDGE_STATE_FILE), JSON.stringify({ repo_gh_id: bad, bridge_enabled: true, operate_enabled: true, repo_checkout: w.checkout }), { mode: 0o600 });
      expect(await w.make(["serve"]).start()).toEqual({ ok: false, reason: "state_unreadable" });
    }
    expect(w.specs).toHaveLength(0);
  });
  it("writes a handle that passes the kill path's reader and its unit pattern, for the widest accepted id too", async () => {
    for (const id of ["123", "9223372036854775807"]) {
      w.setState({ repo_gh_id: id });
      await w.make(["serve"]).start();
      const h = readHostHandle(w.state, uid);
      expect(h).toEqual({ pid: w.pids.at(-1), unit: `fx-engine-host-${id}.scope`, start_time: `st-${w.pids.at(-1)}` });
      expect(h?.unit).toMatch(/^fx-engine-host-[1-9][0-9]{0,18}\.scope$/);
      await w.sup.stop("stopped_by_person");
    }
  });
});

describe("EB-12a one supervisor at a time", () => {
  it("refuses a second start while the first runs and while it has no host and no handle (back-off), then lets one start after the first ends", async () => {
    const first = w.make(["crash", "serve"]);
    expect(await first.start()).toEqual({ ok: true });
    await until(() => inBackoff(BACKOFF_MS[0]), "the back-off");
    expect(existsSync(handleFile())).toBe(false);
    const second = w.make(["serve"]);
    expect(await second.start()).toEqual({ ok: false, reason: "already_running" });
    expect(w.specs).toHaveLength(1);
    await first.stop("stopped_by_person");
    expect(existsSync(path.join(w.state, HOST_LOCK_FILE))).toBe(false);
    expect(await w.make(["serve"]).start()).toEqual({ ok: true });
    await w.sup.stop("stopped_by_person");
  });
  it("takes over a lock whose owner is dead, or whose pid now belongs to a process that started later, and refuses one whose owner is alive", () => {
    const put = (o: unknown): void => writeFileSync(path.join(w.state, HOST_LOCK_FILE), JSON.stringify(o), { mode: 0o600 });
    const deps = { ownPid: process.pid, isAlive: alive, startOf: (pid: number) => (pid === process.pid ? "T0" : undefined) };
    put({ pid: 2 ** 22 - 1, start: "T0" });
    const taken = acquireHostLock(w.state, uid, deps);
    expect(taken).toBeDefined();
    expect(JSON.parse(readFileSync(path.join(w.state, HOST_LOCK_FILE), "utf8"))).toEqual({ pid: process.pid, start: "T0" });
    expect(acquireHostLock(w.state, uid, deps)).toBeUndefined(); // we are alive and started when the file says
    taken?.release();
    expect(existsSync(path.join(w.state, HOST_LOCK_FILE))).toBe(false);
    put({ pid: process.pid, start: "an earlier life of this pid" });
    expect(acquireHostLock(w.state, uid, deps)).toBeDefined();
  });
  it("refuses a lock that is a link and never follows it", () => {
    symlinkSync(path.join(w.dir, "elsewhere"), path.join(w.state, HOST_LOCK_FILE));
    expect(() => acquireHostLock(w.state, uid, { ownPid: process.pid, isAlive: alive, startOf: () => "T0" })).toThrow();
    expect(existsSync(path.join(w.dir, "elsewhere"))).toBe(false);
  });
  it("cleanup removes the handle file and the lock, for a process that is exiting", async () => {
    await w.make(["serve"]).start();
    expect(existsSync(handleFile())).toBe(true);
    expect(existsSync(path.join(w.state, HOST_LOCK_FILE))).toBe(true);
    w.sup.cleanup();
    expect(existsSync(handleFile())).toBe(false);
    expect(existsSync(path.join(w.state, HOST_LOCK_FILE))).toBe(false);
    w.sup.cleanup();
  });
});

describe("EB-12a a log that cannot be written", () => {
  it("stops the host cleanly, counts the failure, throws nowhere and leaves no handle", async () => {
    const failing: HostLog = { write: () => false, close: () => undefined };
    await w.make(["serve"], { log: failing }).start();
    expect(await w.sup.stopped).toBe("log_failed");
    expect(w.sup.logFailures()).toBeGreaterThanOrEqual(1);
    expect(existsSync(handleFile())).toBe(false);
    expect(existsSync(path.join(w.state, HOST_LOCK_FILE))).toBe(false);
    await until(() => !alive(w.pids[0]!), "the host to be gone");
    expect(stoppedReasons()).toEqual(["log_failed"]);
  });
  it("never throws from the real log: a rotation that is blocked gives false, then the log stays closed", () => {
    const log = openHostLog(w.state, uid, 100);
    mkdirSync(path.join(w.state, `${HOST_LOG_FILE}.1`));
    writeFileSync(path.join(w.state, `${HOST_LOG_FILE}.1`, "keep"), "x");
    expect(log.write("a".repeat(60))).toBe(true);
    expect(log.write("b".repeat(60))).toBe(false);
    expect(log.write("c")).toBe(false);
    expect(() => log.close()).not.toThrow();
  });
});

describe("EB-12a the stop and the stream", () => {
  it("reports the kill path's survivors in host_stopped after a forced stop, and not when the host left on its own", async () => {
    w.killResult = { method: "scope", survivors: 2 };
    const sup = w.make(["stubborn"]);
    await sup.start();
    await until(() => w.records().some((r) => r.event === "start"), "the host");
    const stopping = sup.stop("machine_shutdown");
    await until(() => w.timers.some((t) => t.live && t.ms === STOP_GRACE_MS), "the grace timer");
    w.fire(STOP_GRACE_MS);
    await stopping;
    expect(w.events.at(-1)).toEqual({ kind: "host_stopped", reason: "machine_shutdown", survivors: 2 });
    expect(sup.survivors()).toBe(2);
    rmSync(w.record);
    w.events.length = w.timers.length = 0;
    await w.make(["serve"]).start();
    await w.sup.stop("stopped_by_person");
    expect(w.events.at(-1)).toEqual({ kind: "host_stopped", reason: "stopped_by_person" });
  });
  it("takes the session id from a parsed init line only: a look-alike inside another field or a line that is not JSON changes nothing", async () => {
    const OTHER = "11111111-2222-3333-4444-555555555555";
    const lines = [
      `{"type":"system","subtype":"init","note":"\\"session_id\\":\\"${OTHER}\\"","session_id":"${SID}"}`,
      `{"type":"system","subtype":"init","session_id":"${OTHER}" BROKEN`,
      `{"type":"system","subtype":"init","session_id":"not-a-uuid"}`,
    ];
    let emit: ((t: string) => void) | undefined;
    const fake: HostChild = { pid: undefined, write: () => undefined, closeStdin: () => undefined, onStdout: (cb) => (emit = cb), onStderr: () => undefined, onExit: () => undefined };
    const sup = createSupervisor({
      stateDir: w.state,
      uid,
      platform: "linux",
      claudePath: w.claude,
      readBridgeState: () => readBridgeState(w.state, uid),
      env: {},
      log: openHostLog(w.state, uid),
      emit: () => undefined,
      now: () => 0,
      after: () => () => undefined,
      isAlive: alive,
      startTimeOf: () => "st",
      isOurHost: () => false,
      acquireLock: () => acquireHostLock(w.state, uid, { ownPid: process.pid, isAlive: alive, startOf: () => "T0" }),
      scopeAvailable: async () => true,
      killHost: async () => undefined,
      killScope: async () => undefined,
      launch: () => fake,
    });
    await sup.start();
    emit?.(`${lines[0]}\n`);
    expect(sup.sessionId()).toBe(SID);
    emit?.(`${lines[1]}\n${lines[2]}\n`);
    expect(sup.sessionId()).toBe(SID);
    sup.cleanup();
  });
});

describe("EB-12a fx-runner engine-host start: claude and exit paths", () => {
  const baseRuntime = (over: Partial<EngineHostRuntime>): EngineHostRuntime => ({
    platform: "linux",
    locateClaude: () => w.claude,
    inspectClaude: async () => true,
    ownPid: process.pid,
    processStart: () => "T0",
    readCgroup: () => undefined,
    onProcessExit: () => undefined,
    launch: () => {
      throw new Error("must not spawn");
    },
    env: {},
    isAlive: alive,
    scopeAvailable: async () => true,
    killHost: async () => undefined,
    killScope: async () => undefined,
    now: () => Date.now(),
    after: () => () => undefined,
    shutdown: () => new Promise(() => undefined),
    ...over,
  });
  const run = (rt: EngineHostRuntime): Promise<number> =>
    engineHostCommand(["start"], { out: () => undefined, stateDir: w.dir } as never, { engineStateDirOverride: w.state, home: w.dir, deps: { platform: "linux", uid } as never, runtime: rt });
  it("refuses with one fixed sentence when there is no runnable claude, an unsupported build or a missing flag, and never opens the log", async () => {
    const sentence = "no runnable claude CLI was found; run fx-runner doctor";
    const throwing = (): string => {
      throw new Error("SECRET_SEARCH_PATH");
    };
    await expect(run(baseRuntime({ locateClaude: throwing }))).rejects.toThrow(sentence);
    await expect(run(baseRuntime({ inspectClaude: async () => false }))).rejects.toThrow(sentence);
    expect(existsSync(path.join(w.state, HOST_LOG_FILE))).toBe(false);
  });
  it("registers its exit cleanup only after a start succeeded, and a refused start never touches another host's handle", async () => {
    let exitFn: (() => void) | undefined;
    writeHaltFile(w.state, { halted: true, halt_epoch: 1, at: "2026-11-16T10:00:00.000Z" }, uid);
    writeFileSync(handleFile(), JSON.stringify({ pid: 4242, unit: "fx-engine-host-123.scope" }), { mode: 0o600 });
    expect(await run(baseRuntime({ onProcessExit: (fn) => (exitFn = fn) }))).toBe(1);
    expect(exitFn).toBeUndefined();
    expect(JSON.parse(readFileSync(handleFile(), "utf8"))).toEqual({ pid: 4242, unit: "fx-engine-host-123.scope" });
  });
  it("registers the exit cleanup once the host is running, and that cleanup removes its own handle file", async () => {
    let exitFn: (() => void) | undefined;
    let exited: (() => void) | undefined;
    let stop: ((r: "machine_shutdown") => void) | undefined;
    const child: HostChild = {
      pid: process.pid,
      write: () => undefined,
      closeStdin: () => queueMicrotask(() => exited?.()),
      onStdout: () => undefined,
      onStderr: () => undefined,
      onExit: (cb) => void (exited = cb),
    };
    const done = run(baseRuntime({ onProcessExit: (fn) => (exitFn = fn), launch: () => child, shutdown: () => new Promise((resolve) => (stop = resolve)) }));
    await until(() => exitFn !== undefined, "the exit hook");
    expect(existsSync(handleFile())).toBe(true);
    exitFn?.();
    expect(existsSync(handleFile())).toBe(false);
    stop?.("machine_shutdown");
    expect(await done).toBe(0);
  });
  it("is told to end by SIGHUP like SIGTERM and Ctrl-C, takes the claude path the job runner uses, and registers the exit hook (bin/fx-runner.mjs)", () => {
    const bin = readFileSync(path.join(import.meta.dirname, "..", "..", "bin", "fx-runner.mjs"), "utf8");
    expect(bin).toContain('process.once("SIGHUP", () => resolve("machine_shutdown"))');
    expect(bin).toContain('process.once("exit", fn)');
    expect(bin).not.toContain("resolveClaudePath(process.env");
    expect(bin).toContain("inspectClaude");
  });
});

describe("EB-12a a refused start leaves the running host's handle alone", () => {
  const firstHostHandle = async (): Promise<string> => {
    const first = w.make(["serve"]);
    expect(await first.start()).toEqual({ ok: true });
    const text = readFileSync(handleFile(), "utf8");
    expect(JSON.parse(text).pid).toBe(w.pids[0]);
    return text;
  };
  const secondRefused = async (reason: string, text: string): Promise<void> => {
    const first = w.sup;
    const second = w.make(["serve"]);
    expect(await second.start()).toEqual({ ok: false, reason });
    expect(readFileSync(handleFile(), "utf8")).toBe(text);
    second.cleanup(); // what the process-exit hook would do, had one been registered
    second.cleanup();
    expect(readFileSync(handleFile(), "utf8")).toBe(text);
    expect(w.specs).toHaveLength(1);
    w.sup = first;
  };
  afterEach(async () => {
    await w.sup.stop("stopped_by_person");
  });
  it("already_running: the second supervisor is refused and the first host's handle stays", async () => {
    const text = await firstHostHandle();
    await secondRefused("already_running", text);
  });
  it("halted: a start refused for a halt does not delete the handle", async () => {
    const text = await firstHostHandle();
    haltNow();
    await secondRefused("halted", text);
  });
  it("operate_off: a start refused for operate off does not delete the handle", async () => {
    const text = await firstHostHandle();
    w.setState({ operate_enabled: false });
    await secondRefused("operate_off", text);
  });
  it("state_unreadable: a start refused for unreadable state does not delete the handle", async () => {
    const text = await firstHostHandle();
    writeFileSync(path.join(w.state, BRIDGE_STATE_FILE), "{not json", { mode: 0o600 });
    await secondRefused("state_unreadable", text);
  });
  it("a refusal after the lock was taken (a live recorded host) gives the lock back and keeps the handle", async () => {
    const text = await firstHostHandle();
    rmSync(path.join(w.state, HOST_LOCK_FILE)); // as if the first supervisor's own lock were gone: only the live recorded host stops the second
    w.ours.add(w.pids[0]!);
    await secondRefused("already_running", text);
    expect(existsSync(path.join(w.state, HOST_LOCK_FILE))).toBe(false);
  });
});

describe("EB-12a a handle that cannot be written ends the new host", () => {
  const breakHandle = (): void => {
    w.afterSpawn = () => mkdirSync(handleFile()); // a directory where the file goes: the atomic write is refused
  };
  it("kills the host through the kill path, emits host_stopped with a fixed reason and holds nothing", async () => {
    breakHandle();
    expect(await w.make(["serve"]).start()).toEqual({ ok: true });
    expect(await w.sup.stopped).toBe("host_failed");
    expect(w.killed).toEqual([`${w.pids[0]}:fx-engine-host-123.scope`]);
    expect(w.scoped).toContain("fx-engine-host-123.scope");
    expect(w.events).toEqual([{ kind: "host_stopped", reason: "host_failed", survivors: 0 }]);
    expect(existsSync(path.join(w.state, HOST_LOCK_FILE))).toBe(false);
    await until(() => !alive(w.pids[0]!), "the host to be gone");
    expect(started()).toBe(0);
  });
  it("does the same from the back-off timer, with no unhandled rejection", async () => {
    const first = w.make(["crash", "serve"]);
    expect(await first.start()).toEqual({ ok: true });
    await until(() => inBackoff(BACKOFF_MS[0]), "the back-off");
    breakHandle();
    w.fire(BACKOFF_MS[0]!);
    expect(await first.stopped).toBe("host_failed");
    expect(w.specs).toHaveLength(2);
    expect(w.killed).toEqual([`${w.pids[1]}:fx-engine-host-123.scope`]);
    await until(() => !alive(w.pids[1]!), "the second host to be gone");
    expect(existsSync(path.join(w.state, HOST_LOCK_FILE))).toBe(false);
  });
});

describe("EB-12a two simultaneous takeovers of one stale lock", () => {
  const lockPath = (): string => path.join(w.state, HOST_LOCK_FILE);
  it("lets exactly one claimant win, even when the second judged the lock stale before the first finished", () => {
    writeFileSync(lockPath(), JSON.stringify({ pid: 2 ** 22 - 1, start: "gone" }), { mode: 0o600 });
    const rival = process.ppid; // alive, and not this process
    let winnerB: ReturnType<typeof acquireHostLock>;
    let nested = false;
    const depsA = {
      ownPid: process.pid,
      // The first claimant is judging the stale lock: the second claimant runs its whole acquire right here, then the first goes on to remove "the stale lock".
      isAlive: (pid: number) => {
        if (pid === 2 ** 22 - 1 && !nested) {
          nested = true;
          winnerB = acquireHostLock(w.state, uid, { ownPid: rival, isAlive: alive, startOf: (p) => (p === rival ? "T1" : undefined) });
        }
        return alive(pid);
      },
      startOf: (pid: number) => (pid === process.pid ? "T0" : pid === rival ? "T1" : undefined),
    };
    const winnerA = acquireHostLock(w.state, uid, depsA);
    expect(winnerB!).toBeDefined();
    expect(winnerA).toBeUndefined();
    expect(JSON.parse(readFileSync(lockPath(), "utf8"))).toEqual({ pid: rival, start: "T1" });
    expect(existsSync(`${lockPath()}.takeover`)).toBe(false);
    winnerB!.release();
    expect(existsSync(lockPath())).toBe(false);
  });
  it("creates the lock whole, leaves no temp or guard file behind and refuses while a fresh takeover guard is held", () => {
    const deps = { ownPid: process.pid, isAlive: alive, startOf: (pid: number) => (pid === process.pid ? "T0" : undefined) };
    writeFileSync(lockPath(), JSON.stringify({ pid: 2 ** 22 - 1, start: "gone" }), { mode: 0o600 });
    writeFileSync(`${lockPath()}.takeover`, "", { mode: 0o600 });
    expect(acquireHostLock(w.state, uid, deps)).toBeUndefined(); // another claimant is mid-takeover
    const old = new Date(Date.now() - 2 * TAKEOVER_GUARD_MS);
    utimesSync(`${lockPath()}.takeover`, old, old); // its claimant died: the guard ages out, and a later start succeeds
    expect(acquireHostLock(w.state, uid, deps)).toBeUndefined();
    const got = acquireHostLock(w.state, uid, deps);
    expect(got).toBeDefined();
    got?.release();
    expect(readdirSync(w.state).filter((f) => f.includes("lock"))).toEqual([]);
  });
});
