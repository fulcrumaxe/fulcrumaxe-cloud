import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyClear,
  applyHalt,
  ENGINE_HALT_FILE,
  ENGINE_HOST_FILE,
  haltAction,
  handleControl,
  haltAppliedPayload,
  killEngineHost,
  resumeEngineHostLocally,
  readHaltFile,
  readHostHandle,
  haltDepsFrom,
  startTimeOf,
  stopEngineHostLocally,
  writeHaltFile,
  type HaltDeps,
  type RunResult,
} from "../../src/engineBridge/halt.js";
import { EngineStateError, engineStateDir } from "../../src/engineBridge/stateFiles.js";
import { terminateGroup } from "../../src/engines/claude/processGroup.js";
import { runCli } from "../../src/cli.js";

/** The real machine, built the way bin/fx-runner.mjs builds it. */
function realHaltDeps(): HaltDeps {
  return haltDepsFrom({
    platform: process.platform,
    uid: process.getuid?.(),
    ownPid: process.pid,
    runFile: execFile as never,
    readFile: readFileSync,
    readPidStart: (pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      } catch {
        return undefined;
      }
    },
    readPidCgroup: (pid) => {
      try {
        return readFileSync(`/proc/${pid}/cgroup`, "utf8");
      } catch {
        return undefined;
      }
    },
    cgroupProcsFile: (controlGroup) => `/sys/fs/cgroup${controlGroup}/cgroup.procs`,
    terminateGroup: (pgid, graceMs) =>
      terminateGroup({ pid: pgid, exitCode: null, signalCode: null, kill: (s) => { try { return process.kill(pgid, s); } catch { return false; } } }, graceMs),
    env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS },
  });
}

const uid = process.getuid?.() ?? -1;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // fx-swallow-ok: ESRCH is the answer
    return false;
  }
};
/** A process that has exited but not been reaped by its parent still answers kill(0); read its state instead. */
const running = (pid: number): boolean => {
  if (!alive(pid)) return false;
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return stat !== "" && !stat.startsWith("Z");
};
const scopeAvailable = ((): boolean => {
  if (process.platform !== "linux") return false;
  const r = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "true"], { timeout: 10_000 });
  return r.status === 0;
})();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "fx-halt-"));
  chmodSync(dir, 0o700);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fastDeps = (over: Partial<HaltDeps> = {}): HaltDeps => ({ ...realHaltDeps(), termGraceMs: 300, scopeEmptyWaitMs: 3000, ...over });

describe("the halt file", () => {
  it("is written atomically at mode 0600, with exactly {halted, halt_epoch, at}", () => {
    writeHaltFile(dir, { halted: true, halt_epoch: 3, at: "2026-11-16T12:00:00.000Z" }, uid);
    const file = path.join(dir, ENGINE_HALT_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ halted: true, halt_epoch: 3, at: "2026-11-16T12:00:00.000Z" });
    expect(readHaltFile(dir, uid)).toEqual({ halted: true, halt_epoch: 3, at: "2026-11-16T12:00:00.000Z" });
    // No temp file is left behind.
    expect(spawnSync("ls", [dir], { encoding: "utf8" }).stdout.trim()).toBe(ENGINE_HALT_FILE);
  });

  it("a planted symlink at the name is replaced by the rename, never written through; a link is still refused on read, and a directory open to others or a linked directory is refused", () => {
    const real = path.join(dir, "real.json");
    writeFileSync(real, "{}", { mode: 0o600 });
    symlinkSync(real, path.join(dir, ENGINE_HALT_FILE));
    expect(() => readHaltFile(dir, uid)).toThrow(EngineStateError);
    writeHaltFile(dir, { halted: true, halt_epoch: 1, at: "x" }, uid);
    expect(readFileSync(real, "utf8")).toBe("{}");
    expect(readHaltFile(dir, uid)).toEqual({ halted: true, halt_epoch: 1, at: "x" });

    const outer = mkdtempSync(path.join(os.tmpdir(), "fx-halt-link-"));
    try {
      const link = path.join(outer, "state");
      symlinkSync(dir, link);
      expect(() => writeHaltFile(link, { halted: true, halt_epoch: 1, at: "x" }, uid)).toThrow(EngineStateError);
      expect(() => readHaltFile(link, uid)).toThrow(EngineStateError);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }

    const open = mkdtempSync(path.join(os.tmpdir(), "fx-halt-open-"));
    try {
      chmodSync(open, 0o755);
      expect(() => writeHaltFile(open, { halted: true, halt_epoch: 1, at: "x" }, uid)).toThrow(EngineStateError);
    } finally {
      rmSync(open, { recursive: true, force: true });
    }

    const clean = mkdtempSync(path.join(os.tmpdir(), "fx-halt-shape-"));
    try {
      chmodSync(clean, 0o700);
      writeFileSync(path.join(clean, ENGINE_HALT_FILE), JSON.stringify({ halted: true, halt_epoch: 1, at: "x", extra: 1 }), { mode: 0o600 });
      expect(() => readHaltFile(clean, uid)).toThrow(EngineStateError);
      writeFileSync(path.join(clean, ENGINE_HALT_FILE), JSON.stringify({ halted: "yes", halt_epoch: 1, at: "x" }), { mode: 0o600 });
      expect(() => readHaltFile(clean, uid)).toThrow(EngineStateError);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  it("the state directory is AUTONOMOUS_TEAM_STATE_DIR, else ~/.autonomous-forever-state, and never a relative path", () => {
    expect(engineStateDir({ AUTONOMOUS_TEAM_STATE_DIR: "/srv/state" }, "/home/x")).toBe("/srv/state");
    expect(engineStateDir({}, "/home/x")).toBe("/home/x/.autonomous-forever-state");
    expect(engineStateDir({ AUTONOMOUS_TEAM_STATE_DIR: "" }, "/home/x")).toBe("/home/x/.autonomous-forever-state");
    expect(() => engineStateDir({ AUTONOMOUS_TEAM_STATE_DIR: "state" }, "/home/x")).toThrow(EngineStateError);
  });
});

describe("the host handle file", () => {
  const put = (v: unknown) => writeFileSync(path.join(dir, ENGINE_HOST_FILE), JSON.stringify(v), { mode: 0o600 });
  it("accepts {pid} and {pid, unit} with a plain scope name, and refuses anything else", () => {
    put({ pid: 4242 });
    expect(readHostHandle(dir, uid)).toEqual({ pid: 4242 });
    put({ pid: 4242, unit: "fx-engine-host-1.scope" });
    expect(readHostHandle(dir, uid)).toEqual({ pid: 4242, unit: "fx-engine-host-1.scope" });
    // The unit is the supervisor's own naming: a desktop's app-*.scope or vte-spawn-*.scope, or any other scope, is not an engine host.
    for (const bad of [
      { pid: 1 }, { pid: 0 }, { pid: -5 }, { pid: 2.5 }, { pid: "9" },
      { pid: 5, unit: "--now.scope" }, { pid: 5, unit: "a b.scope" }, { pid: 5, unit: "x.service" }, { pid: 5, extra: true }, [1],
      { pid: 5, unit: "app-gnome-firefox-123.scope" }, { pid: 5, unit: "vte-spawn-1234.scope" }, { pid: 5, unit: "fx-engine-host-0.scope" },
      { pid: 5, unit: "fx-engine-host-abc.scope" }, { pid: 5, unit: "fx-engine-host-1.service" }, { pid: 5, unit: "fx-engine-host-12345678901234567890.scope" },
    ]) {
      put(bad);
      expect(() => readHostHandle(dir, uid), JSON.stringify(bad)).toThrow(EngineStateError);
    }
  });
});

describe("haltAction", () => {
  const file = (halted: boolean, halt_epoch: number) => ({ halted, halt_epoch, at: "t" });
  it("a higher epoch is a halt, even when the cloud has already cleared it", () => {
    expect(haltAction(undefined, { halt_epoch: 1, halted: true })).toBe("halt");
    expect(haltAction(file(false, 1), { halt_epoch: 2, halted: true })).toBe("halt");
    expect(haltAction(file(false, 1), { halt_epoch: 2, halted: false })).toBe("halt");
  });
  it("the same epoch with halted false while the file says halted is a clear; nothing else changes anything", () => {
    expect(haltAction(file(true, 2), { halt_epoch: 2, halted: false })).toBe("clear");
    expect(haltAction(file(true, 2), { halt_epoch: 2, halted: true })).toBe("none");
    expect(haltAction(file(false, 2), { halt_epoch: 2, halted: false })).toBe("none");
    expect(haltAction(undefined, { halt_epoch: 0, halted: false })).toBe("none");
    expect(haltAction(file(true, 3), { halt_epoch: 2, halted: true })).toBe("none");
  });
  it("a cloud that says halted at an epoch the file shows as cleared is treated as a halt (fail closed)", () => {
    expect(haltAction(file(false, 2), { halt_epoch: 2, halted: true })).toBe("halt");
  });
  it("with a local stop: only halted:true at a higher epoch hands control to the cloud; halted:false at any epoch, a higher one too, never clears it", () => {
    const stop = (halt_epoch: number) => ({ halted: true, halt_epoch, at: "t", local_stop: true as const });
    expect(haltAction(stop(2), { halt_epoch: 3, halted: true })).toBe("halt");
    expect(haltAction(stop(2), { halt_epoch: 3, halted: false })).toBe("stay_stopped");
    expect(haltAction(stop(2), { halt_epoch: 2, halted: false })).toBe("none");
    expect(haltAction(stop(2), { halt_epoch: 2, halted: true })).toBe("none");
    expect(haltAction(stop(2), { halt_epoch: 1, halted: false })).toBe("none");
  });
});

/** Waits for a detached process group to be gone, then makes sure of it. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // fx-swallow-ok: already gone
  }
}

/** Starts a host-like tree: a leader in its own process group that runs two sleeps, optionally one ignoring SIGTERM. Resolves with the pids. */
async function startTree(opts: { ignoreTerm?: boolean } = {}): Promise<{ leader: number; pids: number[] }> {
  const pidFile = path.join(dir, "pids");
  const trap = opts.ignoreTerm ? "trap '' TERM; " : "";
  const script = `${trap}sleep 300 & echo $! >> ${pidFile}; sleep 300 & echo $! >> ${pidFile}; wait`;
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 100 && !(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().split("\n").length >= 2); i++) await sleepMs(20);
  const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
  return { leader: child.pid!, pids };
}

describe("killEngineHost, group only (the macOS path, and Linux without a scope)", () => {
  it("TERM ends the group, survivors 0, method group_only, every pid gone", async () => {
    const { leader, pids } = await startTree();
    const out = await killEngineHost({ pid: leader }, fastDeps({ platform: "darwin" }));
    expect(out).toEqual({ method: "group_only", survivors: 0 });
    await sleepMs(100);
    for (const pid of [leader, ...pids]) expect(running(pid), `pid ${pid}`).toBe(false);
  });

  it("a member that ignores SIGTERM is killed after the grace period", async () => {
    const { leader, pids } = await startTree({ ignoreTerm: true });
    const started = Date.now();
    const out = await killEngineHost({ pid: leader }, fastDeps({ platform: "darwin", termGraceMs: 400 }));
    expect(out).toEqual({ method: "group_only", survivors: 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    await sleepMs(100);
    for (const pid of [leader, ...pids]) expect(running(pid), `pid ${pid}`).toBe(false);
  });

  it("a unit named on Linux with no usable systemctl falls back to group_only and counts survivors by a scan (the leader really is in that unit)", async () => {
    const { leader, pids } = await startTree();
    const real = realHaltDeps();
    const noSystemctl = fastDeps({
      capture: async (file: string, args: readonly string[]): Promise<RunResult> => (file === "systemctl" ? { code: null, stdout: "" } : real.capture(file, args)),
      // The leader's cgroup names the unit, as it would inside the real scope.
      readPidCgroup: (pid) => (pid === leader || pids.includes(pid) ? "0::/user.slice/user-1000.slice/user@1000.service/app.slice/fx-engine-host-77.scope\n" : real.readPidCgroup(pid)),
      platform: "linux",
    });
    const out = await killEngineHost({ pid: leader, unit: "fx-engine-host-77.scope" }, noSystemctl);
    expect(out).toEqual({ method: "group_only", survivors: 0 });
    await sleepMs(100);
    for (const pid of [leader, ...pids]) expect(running(pid)).toBe(false);
  });

  it("refuses pids that must never be signalled, and a unit that is not an engine host scope", async () => {
    for (const pid of [0, 1, -1, 2.5]) await expect(killEngineHost({ pid }, fastDeps())).rejects.toThrow(EngineStateError);
    await expect(killEngineHost({ pid: 4242, unit: "--user.scope" }, fastDeps())).rejects.toThrow(EngineStateError);
    for (const unit of ["app-gnome-terminal-1.scope", "vte-spawn-1.scope", "session-3.scope", "fx-engine-host-.scope"]) {
      await expect(killEngineHost({ pid: 4242, unit }, fastDeps()), unit).rejects.toThrow(EngineStateError);
    }
  });

  it("never signals its own process group, and says so", async () => {
    const out = await killEngineHost({ pid: process.pid }, fastDeps({ platform: "darwin" }));
    expect(out).toMatchObject({ method: "none", survivors: 1 });
    expect(out.refused?.join(" ")).toMatch(/own process group/);
    expect(running(process.pid)).toBe(true);
  });

  it("a pid that is not the leader of its own group (pgid !== pid) is not signalled, and the outcome is none with 1 survivor", async () => {
    // Not detached: the child is in this test process's group, so its pgid is not its pid.
    const child = spawn("sleep", ["300"], { stdio: "ignore" });
    try {
      for (let i = 0; i < 50 && !running(child.pid!); i++) await sleepMs(20);
      const out = await killEngineHost({ pid: child.pid! }, fastDeps({ platform: "darwin" }));
      expect(out).toMatchObject({ method: "none", survivors: 1 });
      expect(out.refused?.join(" ")).toMatch(/not the leader/);
      expect(running(child.pid!)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("a stale handle whose pid was reused by another group leader (a different start time) is not signalled, on Linux with a unit and without one, and on the `ps` path", async () => {
    const real = realHaltDeps();
    const readPidStart = (pid: number): string | undefined => real.readPidStart?.(pid);
    const mine = (pid: number): boolean => pid > 1; // the unit check is not what this test is about
    for (const [platform, unit] of [["linux", "fx-engine-host-77.scope"], ["linux", undefined], ["darwin", undefined]] as const) {
      // An unrelated process that happens to be a group leader now holds the recorded pid.
      const stranger = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
      stranger.unref();
      try {
        for (let i = 0; i < 50 && !running(stranger.pid!); i++) await sleepMs(20);
        const deps = fastDeps({ platform, readPidStart, readPidCgroup: (pid) => (mine(pid) ? "0::/user.slice/fx-engine-host-77.scope\n" : undefined) });
        const handle = { pid: stranger.pid!, ...(unit === undefined ? {} : { unit }), start_time: platform === "linux" ? "1" : "Thu Jan  1 00:00:00 1970" };
        const out = await killEngineHost(handle, deps);
        expect(out.refused?.join(" "), `${platform} ${unit}`).toMatch(/reused pid/);
        expect(running(stranger.pid!), `${platform} ${unit}: the stranger must not be signalled`).toBe(true);
      } finally {
        process.kill(-stranger.pid!, "SIGKILL");
      }
    }
  });

  it("the same handle with the process's real start time is signalled (the token matches), and the token round-trips through the handle file", async () => {
    const real = realHaltDeps();
    const host = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    host.unref();
    for (let i = 0; i < 50 && !running(host.pid!); i++) await sleepMs(20);
    const start = await startTimeOf(host.pid!, real);
    expect(start).toBeDefined();
    writeFileSync(path.join(dir, ENGINE_HOST_FILE), JSON.stringify({ pid: host.pid, start_time: start }), { mode: 0o600 });
    const handle = readHostHandle(dir, uid)!;
    expect(handle).toEqual({ pid: host.pid, start_time: start });
    const out = await killEngineHost(handle, fastDeps());
    expect(out.refused).toBeUndefined();
    await sleepMs(100);
    expect(running(host.pid!)).toBe(false);
    for (const bad of [{ pid: 4242, start_time: 5 }, { pid: 4242, start_time: "a;b" }, { pid: 4242, start_time: "" }, { pid: 4242, start_time: "x".repeat(65) }]) {
      writeFileSync(path.join(dir, ENGINE_HOST_FILE), JSON.stringify(bad), { mode: 0o600 });
      expect(() => readHostHandle(dir, uid)).toThrow(EngineStateError);
    }
  });

  it("a leader that has exited while its group lives is still signalled: the group is killed and survivors is 0 only because it was checked", async () => {
    const pidFile = path.join(dir, "orphan-pids");
    const leader = spawn("sh", ["-c", `sleep 300 & echo $! >> ${pidFile}; sleep 300 & echo $! >> ${pidFile}; exit 0`], { detached: true, stdio: "ignore" });
    leader.unref();
    for (let i = 0; i < 100 && !(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().split("\n").length >= 2); i++) await sleepMs(20);
    const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    try {
      for (let i = 0; i < 100 && running(leader.pid!); i++) await sleepMs(20);
      expect(running(leader.pid!), "the leader has exited").toBe(false);
      for (const pid of pids) expect(running(pid), `sleeper ${pid} lives on in the dead leader's group`).toBe(true);
      const out = await killEngineHost({ pid: leader.pid! }, fastDeps({ platform: "darwin" }));
      expect(out).toEqual({ method: "group_only", survivors: 0 });
      await sleepMs(100);
      for (const pid of pids) expect(running(pid), `sleeper ${pid}`).toBe(false);
    } finally {
      killGroup(leader.pid!);
    }
  });

  it("with the leader gone and a group that cannot be counted, the answer is 1, never 0", async () => {
    const leader = spawn("sh", ["-c", "sleep 300 & exit 0"], { detached: true, stdio: "ignore" });
    leader.unref();
    try {
      for (let i = 0; i < 100 && running(leader.pid!); i++) await sleepMs(20);
      const real = realHaltDeps();
      const out = await killEngineHost(
        { pid: leader.pid! },
        fastDeps({ platform: "darwin", capture: async (file, args) => (file === "ps" && args.includes("-A") ? { code: 1, stdout: "" } : real.capture(file, args)) }),
      );
      expect(out.survivors).toBe(1);
    } finally {
      killGroup(leader.pid!);
    }
  });

  describe.skipIf(process.platform !== "linux")("the target must be the engine host (Linux)", () => {
    const goneScope = async (file: string, args: readonly string[]): Promise<RunResult> =>
      file === "systemctl" && args.includes("show") ? { code: 0, stdout: "LoadState=not-found\nControlGroup=\n" } : realHaltDeps().capture(file, args);

    it("a stale pid reused by another process is not signalled: its cgroup is not the unit, so only the scope is trusted", async () => {
      const decoy = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
      decoy.unref();
      try {
        for (let i = 0; i < 50 && !running(decoy.pid!); i++) await sleepMs(20);
        const out = await killEngineHost({ pid: decoy.pid!, unit: "fx-engine-host-4242.scope" }, fastDeps({ platform: "linux", capture: goneScope }));
        // The scope is gone (checked), so nothing of the host lives; the unrelated process was refused and the refusal is reported.
        expect(out).toMatchObject({ method: "scope", survivors: 0 });
        expect(out.refused?.join(" ")).toMatch(/not inside the engine host's scope/);
        await sleepMs(100);
        expect(running(decoy.pid!), "the decoy was not signalled").toBe(true);
      } finally {
        killGroup(decoy.pid!);
      }
    });

    it("with no scope to vouch for it either, the refused pid is reported as none with 1 survivor and is still not signalled", async () => {
      const decoy = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
      decoy.unref();
      try {
        for (let i = 0; i < 50 && !running(decoy.pid!); i++) await sleepMs(20);
        const real = realHaltDeps();
        const out = await killEngineHost(
          { pid: decoy.pid!, unit: "fx-engine-host-4242.scope" },
          fastDeps({ platform: "linux", capture: async (file, args) => (file === "systemctl" ? { code: null, stdout: "" } : real.capture(file, args)) }),
        );
        expect(out).toMatchObject({ method: "none", survivors: 1 });
        expect(running(decoy.pid!)).toBe(true);
      } finally {
        killGroup(decoy.pid!);
      }
    });

    it("a unit equal to the runner's own scope is refused and nothing is killed in it", async () => {
      const real = realHaltDeps();
      const calls: string[][] = [];
      const out = await killEngineHost(
        { pid: 999_999, unit: "fx-engine-host-4242.scope" },
        fastDeps({
          platform: "linux",
          readPidCgroup: (pid) => (pid === process.pid ? "0::/user.slice/fx-engine-host-4242.scope\n" : real.readPidCgroup(pid)),
          capture: async (file, args) => {
            if (file === "systemctl") calls.push([...args]);
            return real.capture(file, args);
          },
        }),
      );
      expect(out.refused?.join(" ")).toMatch(/runner's own scope/);
      expect(calls).toEqual([]);
    });

    it("the scope is killed again while it still has processes (a fork after the first kill is caught)", async () => {
      const kills: number[] = [];
      let left = 2;
      const out = await killEngineHost(
        { pid: 999_999, unit: "fx-engine-host-4242.scope" },
        fastDeps({
          platform: "linux",
          scopeEmptyWaitMs: 5000,
          capture: async (file, args) => {
            if (file === "systemctl" && args.includes("show")) return { code: 0, stdout: "LoadState=loaded\nControlGroup=/user.slice/fx-engine-host-4242.scope\n" };
            if (file === "systemctl" && args.includes("kill")) {
              kills.push(1);
              // The third kill is the one that finds the last process.
              if (kills.length >= 2) left = 0;
              return { code: 0, stdout: "" };
            }
            return realHaltDeps().capture(file, args);
          },
          readText: () => (left === 0 ? "" : "4242\n4243\n"),
        }),
      );
      expect(out).toEqual({ method: "scope", survivors: 0 });
      expect(kills.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("survivors it cannot count are reported as 1, never as a clean 0", async () => {
    const { leader } = await startTree();
    try {
      const real = realHaltDeps();
      const out = await killEngineHost(
        { pid: leader },
        fastDeps({ platform: "darwin", capture: async (file, args) => (file === "ps" && args.includes("-A") ? { code: 1, stdout: "" } : real.capture(file, args)) }),
      );
      expect(out).toEqual({ method: "group_only", survivors: 1 });
    } finally {
      try {
        process.kill(-leader, "SIGKILL");
      } catch {
        // fx-swallow-ok: already gone
      }
    }
  });
});

describe.skipIf(!scopeAvailable)("killEngineHost, scope (Linux with a systemd user manager)", () => {
  /** A tree started INSIDE a transient user scope: the leader, a `setsid` child (own group and session) and a `nohup` child, all sleeping. */
  async function startScopedTree(): Promise<{ unit: string; leader: number; pids: number[] }> {
    const unit = `fx-engine-host-${Date.now()}.scope`;
    const pidFile = path.join(dir, "scoped-pids");
    const script = [
      `setsid sleep 300 > /dev/null 2>&1 & echo $! >> ${pidFile}`,
      `nohup sleep 300 > /dev/null 2>&1 & echo $! >> ${pidFile}`,
      `sleep 300 & echo $! >> ${pidFile}`,
      "wait",
    ].join("; ");
    const child = spawn("systemd-run", ["--user", "--scope", "--quiet", `--unit=${unit}`, "--collect", "sh", "-c", script], { detached: true, stdio: "ignore" });
    child.unref();
    for (let i = 0; i < 300 && !(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().split("\n").length >= 3); i++) await sleepMs(20);
    const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    return { unit, leader: child.pid!, pids };
  }

  it("a tree of three, one setsid'd and one nohup'd: after the kill path survivors is 0 and no pid of the tree is alive", async () => {
    const { unit, leader, pids } = await startScopedTree();
    try {
      // The setsid'd child is in a different process group from the leader: the group kill alone would not have reached it.
      const pgidOf = (pid: number) => Number(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
      // The pid is recorded right after the fork, before the child has called setsid: wait for it to leave the group.
      for (let i = 0; i < 100 && pgidOf(pids[0]!) === pgidOf(leader); i++) await sleepMs(20);
      expect(pgidOf(pids[0]!)).not.toBe(pgidOf(leader));
      for (const pid of pids) expect(running(pid)).toBe(true);

      const out = await killEngineHost({ pid: leader, unit }, fastDeps());
      expect(out).toEqual({ method: "scope", survivors: 0 });
      await sleepMs(150);
      for (const pid of [leader, ...pids]) expect(running(pid), `pid ${pid}`).toBe(false);
    } finally {
      spawnSync("systemctl", ["--user", "kill", "--signal=SIGKILL", "--", unit]);
    }
  });

  it("a scope that is already gone is an empty one (survivors 0, method scope)", async () => {
    const out = await killEngineHost({ pid: 999_999, unit: "fx-engine-host-999999999.scope" }, fastDeps());
    expect(out).toEqual({ method: "scope", survivors: 0 });
  });
});

describe("applyHalt, handleControl and the local stop", () => {
  it("writes the halt file BEFORE it signals anything", async () => {
    const order: string[] = [];
    const real = realHaltDeps();
    const deps = fastDeps({
      platform: "darwin",
      capture: async (file, args) => {
        if (order.length === 0) order.push(existsSync(path.join(dir, ENGINE_HALT_FILE)) ? "file-first" : "signal-first");
        return real.capture(file, args);
      },
    });
    const { leader } = await startTree();
    await applyHalt(dir, { pid: leader }, 4, deps);
    expect(order[0]).toBe("file-first");
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, halt_epoch: 4 });
  });

  it("a higher epoch halts and returns the halt_applied payload; a repeat of the same control does nothing", async () => {
    const { leader, pids } = await startTree();
    const deps = fastDeps({ platform: "darwin" });
    const applied = await handleControl(dir, { pid: leader }, { halt_epoch: 2, halted: true }, deps);
    expect(applied).toEqual({ halt_epoch: 2, method: "group_only", survivors: 0 });
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, halt_epoch: 2 });
    for (const pid of [leader, ...pids]) expect(running(pid)).toBe(false);
    expect(await handleControl(dir, { pid: leader }, { halt_epoch: 2, halted: true }, deps)).toBeUndefined();
  });

  it("a clear at the same epoch rewrites the file to halted:false, keeps the epoch and starts nothing", async () => {
    const deps = fastDeps({ platform: "darwin" });
    await handleControl(dir, undefined, { halt_epoch: 2, halted: true }, deps);
    const before = new Set(spawnSync("ps", ["-A", "-o", "pid="], { encoding: "utf8" }).stdout.split("\n").map((l) => l.trim()));
    expect(await handleControl(dir, undefined, { halt_epoch: 2, halted: false }, deps)).toBeUndefined();
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: false, halt_epoch: 2 });
    const after = spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" }).stdout;
    // Nothing named an engine host or started a loop; the only new processes are our own `ps`.
    expect(after).not.toMatch(/engine-host|fx-runner run/);
    expect(before.size).toBeGreaterThan(0);
  });

  it("a halt that was cleared before this pull is still killed, and the file ends halted:false at the new epoch", async () => {
    const { leader, pids } = await startTree();
    const applied = await handleControl(dir, { pid: leader }, { halt_epoch: 5, halted: false }, fastDeps({ platform: "darwin" }));
    expect(applied).toMatchObject({ halt_epoch: 5, survivors: 0 });
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: false, halt_epoch: 5 });
    for (const pid of [leader, ...pids]) expect(running(pid)).toBe(false);
  });

  it("with no host handle a halt still writes the file, but reports none with 1 survivor: nothing was checked, so it is not a clean halt", async () => {
    const out = await applyHalt(dir, undefined, 3, fastDeps({ platform: "darwin" }));
    expect(out).toMatchObject({ halt_epoch: 3, method: "none", survivors: 1 });
    expect(haltAppliedPayload(out)).toEqual({ halt_epoch: 3, method: "group_only", survivors: 1 });
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, halt_epoch: 3 });
    applyClear(dir, 3, fastDeps());
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: false, halt_epoch: 3 });
  });

  it("a clean 0 for no handle needs the caller to know no host was ever started, or a conventional unit that was checked and is empty", async () => {
    expect(await applyHalt(dir, undefined, 3, fastDeps({ platform: "darwin" }), { knownNoHost: true })).toEqual({ halt_epoch: 3, method: "group_only", survivors: 0 });
    const goneScope = async (file: string, args: readonly string[]): Promise<RunResult> =>
      file === "systemctl" && args.includes("show") ? { code: 0, stdout: "LoadState=not-found\nControlGroup=\n" } : realHaltDeps().capture(file, args);
    expect(await applyHalt(dir, undefined, 4, fastDeps({ platform: "linux", capture: goneScope }), { repoGhId: 424242 })).toEqual({ halt_epoch: 4, method: "scope", survivors: 0 });
    // An id that is not a plain number names no unit at all.
    expect(await applyHalt(dir, undefined, 5, fastDeps({ platform: "linux", capture: goneScope }), { repoGhId: "../x" })).toMatchObject({ method: "none", survivors: 1 });
  });

  it("the local stop reads the host handle, runs the same kill path and makes no network call", async () => {
    const { leader, pids } = await startTree();
    writeFileSync(path.join(dir, ENGINE_HOST_FILE), JSON.stringify({ pid: leader }), { mode: 0o600 });
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (() => {
      fetched++;
      throw new Error("no network in a local stop");
    }) as typeof fetch;
    try {
      const { applied, hostFound } = await stopEngineHostLocally(dir, fastDeps({ platform: "darwin" }));
      expect(hostFound).toBe(true);
      expect(applied).toEqual({ halt_epoch: 0, method: "group_only", survivors: 0 });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toBe(0);
    for (const pid of [leader, ...pids]) expect(running(pid)).toBe(false);
  });
});

describe("a local stop is sticky", () => {
  const deps = () => fastDeps({ platform: "darwin" });
  it("a cloud halted:false at the same or a lower epoch leaves it in place; a cloud halted:true at those epochs is not a new halt either", async () => {
    await stopEngineHostLocally(dir, deps());
    const stopped = readHaltFile(dir, uid)!;
    expect(stopped).toMatchObject({ halted: true, halt_epoch: 0, local_stop: true });
    for (const control of [{ halt_epoch: 0, halted: false }, { halt_epoch: 0, halted: true }]) {
      expect(await handleControl(dir, undefined, control, deps())).toBeUndefined();
      expect(readHaltFile(dir, uid)).toEqual(stopped);
    }
    // At a higher local epoch, the same rule holds for every lower or equal cloud epoch.
    writeHaltFile(dir, { halted: true, halt_epoch: 4, at: "t", local_stop: true }, uid);
    for (const control of [{ halt_epoch: 4, halted: false }, { halt_epoch: 3, halted: false }, { halt_epoch: 0, halted: false }]) {
      expect(await handleControl(dir, undefined, control, deps())).toBeUndefined();
      expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, halt_epoch: 4, local_stop: true });
    }
  });

  it("the exact lag sequence: the file {halted:false, epoch 2}, then engine-host stop, then a pull of {halted:false, epoch 3}: the stop stays, at epoch 3, and the host is killed again", async () => {
    const { leader, pids } = await startTree();
    writeHaltFile(dir, { halted: false, halt_epoch: 2, at: "t" }, uid);
    const stop = await stopEngineHostLocally(dir, deps());
    expect(stop.applied).toMatchObject({ halt_epoch: 2 });
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, halt_epoch: 2, local_stop: true });

    const applied = await handleControl(dir, { pid: leader }, { halt_epoch: 3, halted: false }, deps());
    expect(applied).toMatchObject({ halt_epoch: 3, survivors: 0 });
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, halt_epoch: 3, local_stop: true });
    for (const pid of [leader, ...pids]) expect(running(pid)).toBe(false);
    // Nothing a pull says with halted:false lifts it, at any epoch, however often it comes.
    for (const epoch of [3, 4, 9]) {
      await handleControl(dir, undefined, { halt_epoch: epoch, halted: false }, deps());
      expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, local_stop: true });
    }
  });

  it("only an observed halted:true at a higher epoch hands a local stop back to the cloud: it is written as a cloud halt, so the clear at that epoch works", async () => {
    writeHaltFile(dir, { halted: true, halt_epoch: 4, at: "t", local_stop: true }, uid);
    const applied = await handleControl(dir, undefined, { halt_epoch: 5, halted: true }, deps());
    expect(applied).toMatchObject({ halt_epoch: 5 });
    expect(readHaltFile(dir, uid)).toEqual(expect.objectContaining({ halted: true, halt_epoch: 5 }));
    expect(readHaltFile(dir, uid)).not.toHaveProperty("local_stop");
    expect(await handleControl(dir, undefined, { halt_epoch: 5, halted: false }, deps())).toBeUndefined();
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: false, halt_epoch: 5 });
  });

  it("engine-host resume lifts it at the same epoch and starts nothing; a halt from the workspace is not lifted by it", async () => {
    await stopEngineHostLocally(dir, deps());
    expect(resumeEngineHostLocally(dir, deps())).toBe("resumed");
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: false, halt_epoch: 0 });
    expect(readHaltFile(dir, uid)).not.toHaveProperty("local_stop");
    expect(resumeEngineHostLocally(dir, deps())).toBe("not_stopped");
    // A cloud halt: applied, no local_stop; resume refuses and leaves it.
    await handleControl(dir, undefined, { halt_epoch: 2, halted: true }, deps());
    expect(resumeEngineHostLocally(dir, deps())).toBe("cloud_halt");
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, halt_epoch: 2 });
  });

  it("the CLI's resume says what happened and exits 0, 0 and 1", async () => {
    const run = async (argv: string[]) => {
      const out: string[] = [];
      const code = await runCli({ argv, home: dir, stateDirOverride: path.join(dir, "rh"), engineStateDirOverride: dir, uid, stdout: (t) => out.push(t), stderr: () => {}, engineHaltDeps: deps() });
      return { code, out: out.join("") };
    };
    expect((await run(["engine-host", "stop"])).code).toBe(0);
    expect(await run(["engine-host", "resume"])).toMatchObject({ code: 0, out: expect.stringMatching(/local stop is lifted/) });
    expect(await run(["engine-host", "resume"])).toMatchObject({ code: 0, out: expect.stringMatching(/not stopped/) });
    await handleControl(dir, undefined, { halt_epoch: 1, halted: true }, deps());
    expect(await run(["engine-host", "resume"])).toMatchObject({ code: 1, out: expect.stringMatching(/only the workspace can clear/) });
  });
});

describe("fx-runner engine-host stop", () => {
  const io = (out: string[], err: string[], argv: string[], extra: Record<string, unknown> = {}) => ({
    argv,
    home: dir,
    stateDirOverride: path.join(dir, "runner-home"),
    engineStateDirOverride: dir,
    uid,
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => err.push(t),
    fetchFn: (() => {
      throw new Error("no network");
    }) as unknown as typeof fetch,
    engineHaltDeps: fastDeps({ platform: "darwin" }),
    ...extra,
  });

  it("stops the recorded host, prints what it could prove (group only: detached processes not verified) and exits 0", async () => {
    const { leader, pids } = await startTree();
    writeFileSync(path.join(dir, ENGINE_HOST_FILE), JSON.stringify({ pid: leader }), { mode: 0o600 });
    const out: string[] = [];
    const err: string[] = [];
    expect(await runCli(io(out, err, ["engine-host", "stop"]))).toBe(0);
    expect(out.join("")).toMatch(/detached processes not verified on this machine/);
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true });
    for (const pid of [leader, ...pids]) expect(running(pid)).toBe(false);
  });

  it("with no host recorded it says so, still writes the halt file, and exits 0", async () => {
    const out: string[] = [];
    expect(await runCli(io(out, [], ["engine-host", "stop"]))).toBe(0);
    expect(out.join("")).toMatch(/No engine host is recorded/);
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true });
  });

  it("refuses an unknown subcommand", async () => {
    expect(await runCli(io([], [], ["engine-host", "restart"]))).toBe(2);
  });

  it("a corrupt host file does not stop the halt: the halt file is written, the outcome is none with 1 survivor, nothing is signalled, and it exits 1 saying why", async () => {
    for (const bad of [{ pid: 1 }, { pid: 5, unit: "x.service" }, { pid: 5, unit: "app-gnome-1.scope" }, "not an object"]) {
      rmSync(path.join(dir, ENGINE_HALT_FILE), { force: true });
      writeFileSync(path.join(dir, ENGINE_HOST_FILE), JSON.stringify(bad), { mode: 0o600 });
      const out: string[] = [];
      const err: string[] = [];
      expect(await runCli(io(out, err, ["engine-host", "stop"])), JSON.stringify(bad)).toBe(1);
      expect(err.join("")).toMatch(/engine-host\.json/);
      expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, halt_epoch: 0, local_stop: true });
    }
    const unparsable = path.join(dir, ENGINE_HOST_FILE);
    writeFileSync(unparsable, "{not json", { mode: 0o600 });
    rmSync(path.join(dir, ENGINE_HALT_FILE), { force: true });
    expect(await runCli(io([], [], ["engine-host", "stop"]))).toBe(1);
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, local_stop: true });
  });

  it("an unreadable halt file (garbage, wrong shape, a planted link) is overwritten as a local stop, and the host in the handle is still killed", async () => {
    const { leader, pids } = await startTree();
    writeFileSync(path.join(dir, ENGINE_HOST_FILE), JSON.stringify({ pid: leader }), { mode: 0o600 });
    const planted = path.join(dir, "elsewhere.json");
    writeFileSync(planted, "keep", { mode: 0o600 });
    symlinkSync(planted, path.join(dir, ENGINE_HALT_FILE));
    const out: string[] = [];
    expect(await runCli(io(out, [], ["engine-host", "stop"]))).toBe(0);
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, local_stop: true });
    expect(readFileSync(planted, "utf8")).toBe("keep");
    for (const pid of [leader, ...pids]) expect(running(pid)).toBe(false);

    writeFileSync(path.join(dir, ENGINE_HALT_FILE), "{garbage", { mode: 0o600 });
    const second = await stopEngineHostLocally(dir, fastDeps({ platform: "darwin" }));
    expect(second.haltFileError).toBeUndefined();
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, local_stop: true });
  });

  it("when the halt file cannot be written at all the kill still runs, and the failure is reported (exit 1)", async () => {
    const { leader, pids } = await startTree();
    writeFileSync(path.join(dir, ENGINE_HOST_FILE), JSON.stringify({ pid: leader }), { mode: 0o600 });
    // A directory at the file's name cannot be replaced by a rename of a file.
    mkdirSync(path.join(dir, ENGINE_HALT_FILE), { mode: 0o700 });
    const err: string[] = [];
    expect(await runCli(io([], err, ["engine-host", "stop"]))).toBe(1);
    expect(err.join("")).toMatch(/halt file could not be written/);
    for (const pid of [leader, ...pids]) expect(running(pid)).toBe(false);
  });
});

describe("handleControl with a halt file that cannot be read", () => {
  it("a garbage or odd-shaped local halt file does not stop a higher-epoch halt: the kill runs and the file ends halted at that epoch, as a local stop", async () => {
    for (const bad of ["{garbage", JSON.stringify({ halted: "yes" }), JSON.stringify([1]), JSON.stringify({ halted: true, halt_epoch: 1, at: "t", extra: 1 })]) {
      const { leader, pids } = await startTree();
      writeFileSync(path.join(dir, ENGINE_HALT_FILE), bad, { mode: 0o600 });
      expect(() => readHaltFile(dir, uid), bad).toThrow(EngineStateError);
      const applied = await handleControl(dir, { pid: leader }, { halt_epoch: 6, halted: true }, fastDeps({ platform: "darwin" }));
      expect(applied, bad).toMatchObject({ halt_epoch: 6, method: "group_only", survivors: 0 });
      expect(readHaltFile(dir, uid), bad).toMatchObject({ halted: true, halt_epoch: 6, local_stop: true });
      for (const pid of [leader, ...pids]) expect(running(pid), bad).toBe(false);
    }
  });

  it("an unreadable file with a control that says cleared (halted:false) still kills and stays stopped as a local stop: a corrupted stop is never lifted without a person", async () => {
    const { leader, pids } = await startTree();
    writeFileSync(path.join(dir, ENGINE_HALT_FILE), "{garbage", { mode: 0o600 });
    const applied = await handleControl(dir, { pid: leader }, { halt_epoch: 2, halted: false }, fastDeps({ platform: "darwin" }));
    expect(applied).toMatchObject({ halt_epoch: 2, survivors: 0 });
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, halt_epoch: 2, local_stop: true });
    for (const pid of [leader, ...pids]) expect(running(pid)).toBe(false);
    // The next pull at the same epoch cannot clear it.
    expect(await handleControl(dir, undefined, { halt_epoch: 2, halted: false }, fastDeps({ platform: "darwin" }))).toBeUndefined();
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, halt_epoch: 2, local_stop: true });
    // Nor can a cleared control at a higher epoch: the stop is kept and re-written there.
    await handleControl(dir, undefined, { halt_epoch: 3, halted: false }, fastDeps({ platform: "darwin" }));
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: true, halt_epoch: 3, local_stop: true });
    // A person lifts it.
    expect(resumeEngineHostLocally(dir, fastDeps())).toBe("resumed");
    expect(readHaltFile(dir, uid)).toMatchObject({ halted: false, halt_epoch: 3 });
  });
});

describe("the real wiring's timings", () => {
  it("haltDepsFrom gives the host's group 10 s to exit on SIGTERM before SIGKILL, and polls the scope for 5 s", () => {
    const deps = realHaltDeps();
    expect(deps.termGraceMs).toBe(10_000);
    expect(deps.scopeEmptyWaitMs).toBe(5_000);
  });
});
