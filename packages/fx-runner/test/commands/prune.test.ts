import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CliError } from "../../src/cliError.js";
import { LEDGER_FILE } from "../../src/commands/run.js";
import { pruneCommand } from "../../src/commands/prune.js";
import type { CommandContext } from "../../src/context.js";
import { LedgerLockedError, createFileLedger } from "../../src/daemon/ledger.js";
import { holdOnDisk } from "../../src/job/workspaceHolds.js";
import { writeLiveFile } from "../../src/job/workspacePrune.js";
import { DEFAULT_SETTINGS, loadSettings, setSetting, unsetSetting } from "../../src/runnerSettings.js";
import { tempDir } from "../helpers/tempTree.js";

const RUN_OLD = "0f3c9a1e-5b7d-4c2a-9e18-6a4b2d7c1f01";
const RUN_HELD = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const RUN_NEW = "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e";
const NOW = new Date("2026-12-01T12:00:00Z");
const DAY = 86_400_000;

function machine() {
  const home = tempDir("fx318-cmd-");
  const stateDir = path.join(home, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const root = path.join(home, ".cache", "fx-runner", "workspaces");
  mkdirSync(root, { recursive: true });
  const make = (name: string, ageDays: number): string => {
    const dir = path.join(root, name);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "f.txt"), "x");
    const when = new Date(NOW.getTime() - ageDays * DAY);
    utimesSync(path.join(dir, "f.txt"), when, when);
    utimesSync(dir, when, when);
    return dir;
  };
  const lines: string[] = [];
  const ctx: CommandContext = { stateDir, out: (l) => lines.push(l), err: (l) => lines.push(l), now: () => NOW, fetchFn: fetch };
  const daemonRunning = (): void => writeFileSync(path.join(stateDir, `${LEDGER_FILE}.lock`), `${process.pid}\n`);
  const host = { home, platform: "linux" as const, freeFraction: 0.5, pid: process.pid, kill: (pid: number, signal: 0) => process.kill(pid, signal) };
  return { home, stateDir, root, make, lines, ctx, daemonRunning, host };
}

describe("fx-runner prune", () => {
  it("with no runner running removes the old finished workspaces and says what it did", async () => {
    const m = machine();
    const old = m.make(RUN_OLD, 20);
    const fresh = m.make(RUN_NEW, 1);
    expect(await pruneCommand(m.ctx, new Map(), m.host)).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(m.lines[0]).toContain("Removed 1 workspace idle for 7+ days");
    expect(m.lines.join("\n")).toContain(RUN_OLD);
  });

  it("--dry-run lists and deletes nothing", async () => {
    const m = machine();
    const old = m.make(RUN_OLD, 20);
    expect(await pruneCommand(m.ctx, new Map([["dry-run", true]]), m.host)).toBe(0);
    expect(existsSync(old)).toBe(true);
    expect(m.lines[0]).toContain("Would remove 1 workspace");
    expect(readdirSync(m.root)).toEqual([RUN_OLD]);
  });

  it("refuses a real prune while a runner is running (it prunes by itself), but a dry run reads the runner's list of workspaces in use", async () => {
    const m = machine();
    const held = m.make(RUN_HELD, 40);
    const old = m.make(RUN_OLD, 40);
    m.daemonRunning();
    writeLiveFile(m.stateDir, [RUN_HELD]);
    await expect(pruneCommand(m.ctx, new Map(), m.host)).rejects.toThrow("prunes by itself");
    expect(existsSync(old)).toBe(true);
    await pruneCommand(m.ctx, new Map([["dry-run", true]]), m.host);
    expect(m.lines.join("\n")).toContain(RUN_OLD);
    expect(m.lines.join("\n")).not.toContain(RUN_HELD);
    expect(existsSync(held)).toBe(true);
  });

  it("with a runner running and its list unreadable, even a dry run judges nothing", async () => {
    const m = machine();
    m.make(RUN_OLD, 40);
    m.daemonRunning();
    await expect(pruneCommand(m.ctx, new Map([["dry-run", true]]), m.host)).rejects.toThrow("cannot be read");
  });

  it("a lock left by a runner that is gone does not count as running", async () => {
    const m = machine();
    const old = m.make(RUN_OLD, 40);
    writeFileSync(path.join(m.stateDir, `${LEDGER_FILE}.lock`), "999999999\n");
    await pruneCommand(m.ctx, new Map(), { ...m.host, kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } });
    expect(existsSync(old)).toBe(false);
  });

  it("no workspaces directory: says so and exits 0", async () => {
    const m = machine();
    const home = tempDir("fx318-empty-");
    expect(await pruneCommand(m.ctx, new Map(), { ...m.host, home })).toBe(0);
    expect(m.lines).toEqual(["No workspaces directory yet; nothing to prune."]);
  });

  it("the configured retention is read from the settings", async () => {
    const m = machine();
    const mid = m.make(RUN_OLD, 10);
    setSetting(m.stateDir, "workspace-retention-days", "30");
    await pruneCommand(m.ctx, new Map(), m.host);
    expect(existsSync(mid)).toBe(true);
    setSetting(m.stateDir, "workspace-retention-days", "5");
    await pruneCommand(m.ctx, new Map(), m.host);
    expect(existsSync(mid)).toBe(false);
  });
});

describe("a real prune holds the runner's single-instance lock (D#587 FU-318)", () => {
  const lockFile = (m: { stateDir: string }): string => path.join(m.stateDir, `${LEDGER_FILE}.lock`);
  const starter = (m: { stateDir: string }) => createFileLedger(path.join(m.stateDir, LEDGER_FILE), { pid: 424_242, isAlive: (pid) => pid === process.pid });

  it("a runner that starts while the prune is deleting is refused, as when another runner is using the state directory; it starts once the prune is over", async () => {
    const m = machine();
    m.make(RUN_OLD, 40);
    let during: unknown;
    let lockText: string | undefined;
    await pruneCommand(m.ctx, new Map(), {
      ...m.host,
      afterJudged: async () => {
        lockText = readFileSync(lockFile(m), "utf8").trim();
        try {
          starter(m).close();
        } catch (error) {
          during = error;
        }
      },
    });
    expect(lockText).toBe(String(process.pid));
    expect(during).toBeInstanceOf(LedgerLockedError);
    expect(existsSync(lockFile(m))).toBe(false);
    starter(m).close();
  });

  it("is released when the pass throws, so a crashed runner's unit can start again", async () => {
    const m = machine();
    m.make(RUN_OLD, 40);
    chmodSync(m.root, 0o000);
    try {
      await expect(pruneCommand(m.ctx, new Map(), m.host)).rejects.toThrow();
    } finally {
      chmodSync(m.root, 0o700);
    }
    expect(existsSync(lockFile(m))).toBe(false);
    starter(m).close();
  });

  it("a second prune started meanwhile is refused and does not remove the first one's lock", async () => {
    const m = machine();
    m.make(RUN_OLD, 40);
    let second: unknown;
    await pruneCommand(m.ctx, new Map(), {
      ...m.host,
      afterJudged: async () => {
        second = await pruneCommand(m.ctx, new Map(), { ...m.host, pid: 424_242 }).catch((error: unknown) => error);
        expect(readFileSync(lockFile(m), "utf8").trim()).toBe(String(process.pid));
      },
    });
    expect(second).toBeInstanceOf(CliError);
    expect(existsSync(lockFile(m))).toBe(false);
  });

  it("a dry run takes no lock and writes nothing into the state directory", async () => {
    const m = machine();
    m.make(RUN_OLD, 40);
    let seen: boolean | undefined;
    await pruneCommand(m.ctx, new Map([["dry-run", true]]), { ...m.host, afterJudged: async () => void (seen = existsSync(lockFile(m))) });
    expect(existsSync(lockFile(m))).toBe(false);
    expect(readdirSync(m.stateDir)).toEqual([]);
    expect(seen).toBeUndefined();
  });

  it("honours the holds another runner (another state directory) keeps in the shared workspaces directory; a hold of a process that is gone is ignored", async () => {
    const m = machine();
    const held = m.make(RUN_HELD, 40);
    const dead = m.make(RUN_OLD, 40);
    holdOnDisk(m.root, RUN_HELD, process.pid);
    holdOnDisk(m.root, RUN_OLD, 4_333_333);
    await pruneCommand(m.ctx, new Map(), m.host);
    expect(existsSync(held)).toBe(true);
    expect(existsSync(dead)).toBe(false);
    expect(m.lines.join("\n")).toContain("1 in use");
  });
});

describe("the workspace-retention-days setting", () => {
  it("is 1 to 365 whole days, saved, and unset returns it to the default", () => {
    const m = machine();
    expect(loadSettings(m.stateDir).workspaceRetentionDays).toBeUndefined();
    expect(setSetting(m.stateDir, "workspace-retention-days", "14")).toContain("14");
    expect(loadSettings(m.stateDir).workspaceRetentionDays).toBe(14);
    setSetting(m.stateDir, "workspace-retention-days", "1");
    setSetting(m.stateDir, "workspace-retention-days", "365");
    expect(loadSettings(m.stateDir).workspaceRetentionDays).toBe(365);
    for (const bad of ["0", "366", "-1", "1.5", "abc", "", "7d"]) expect(() => setSetting(m.stateDir, "workspace-retention-days", bad), bad).toThrow();
    expect(loadSettings(m.stateDir).workspaceRetentionDays).toBe(365);
    unsetSetting(m.stateDir, "workspace-retention-days");
    expect(loadSettings(m.stateDir).workspaceRetentionDays).toBeUndefined();
    expect(loadSettings(m.stateDir).ceilingTotal).toBe(DEFAULT_SETTINGS.ceilingTotal);
  });
});
