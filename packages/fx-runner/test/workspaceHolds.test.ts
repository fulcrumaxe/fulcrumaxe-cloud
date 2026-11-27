import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOLDS_DIR, heldOnDisk, holdOnDisk } from "../src/job/workspaceHolds.js";
import { createLiveWorkspaces, pruneWorkspaces } from "../src/job/workspacePrune.js";
import { createJobsInHand } from "../src/daemon/jobsInHand.js";
import { runHeldTakeover } from "../src/engines/claude/takeover.js";
import { tempDir } from "./helpers/tempTree.js";

const DAY = 86_400_000;
const NOW = new Date("2026-12-01T12:00:00Z");
const RUN_A = "0f3c9a1e-5b7d-4c2a-9e18-6a4b2d7c1f01";
const RUN_B = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const PID_A = 4_111_111;
const PID_B = 4_222_222;
const alive = new Set<number>([PID_A, PID_B]);
const isAlive = (pid: number): boolean => alive.has(pid);

const newRoot = (): { base: string; root: string; outside: string } => {
  const base = tempDir("fx318h-");
  const root = path.join(base, "workspaces");
  const outside = path.join(base, "outside");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(outside);
  return { base, root, outside };
};

function workspace(root: string, name: string, ageDays: number): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "f.txt"), "x".repeat(2000));
  const when = new Date(NOW.getTime() - ageDays * DAY);
  utimesSync(path.join(dir, "src", "f.txt"), when, when);
  utimesSync(path.join(dir, "src"), when, when);
  utimesSync(dir, when, when);
  return dir;
}

const prune = (root: string, live: ReturnType<typeof createLiveWorkspaces>, over: Partial<Parameters<typeof pruneWorkspaces>[0]> = {}) =>
  pruneWorkspaces({ root, now: NOW, live, dryRun: false, freeFraction: 0.5, isAlive, ...over });

describe("holds that every runner process of this user can see (D#587 FU-318)", () => {
  it("a hold is a private file named for the workspace and the process, written on the first hold and removed on the last release", () => {
    const { root } = newRoot();
    const a = createLiveWorkspaces({ disk: { root, pid: PID_A } });
    expect(a.hold(RUN_A)).toBe(true);
    expect(a.hold(RUN_A)).toBe(true);
    const file = path.join(root, HOLDS_DIR, `${RUN_A}.${PID_A}`);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.join(root, HOLDS_DIR)).mode & 0o777).toBe(0o700);
    a.release(RUN_A);
    expect(existsSync(file)).toBe(true);
    a.release(RUN_A);
    expect(existsSync(file)).toBe(false);
  });

  it("two runners: a workspace runner A holds is kept by runner B's prune, however old, and goes once A releases it", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 40);
    const a = createLiveWorkspaces({ disk: { root, pid: PID_A } });
    const b = createLiveWorkspaces({ disk: { root, pid: PID_B } });
    expect(a.hold(RUN_A)).toBe(true);
    // B knows nothing of A's memory; only the file tells it.
    expect(b.has(RUN_A)).toBe(false);
    const kept = await prune(root, b);
    expect(kept.removed).toEqual([]);
    expect(kept.kept).toEqual([{ name: RUN_A, reason: "live" }]);
    expect(existsSync(dir)).toBe(true);
    a.release(RUN_A);
    const gone = await prune(root, b);
    expect(gone.removed.map((e) => e.name)).toEqual([RUN_A]);
    expect(existsSync(dir)).toBe(false);
  });

  it("the command line's prune (no memory of its own) honours them too, and a runner in the other direction cannot take a directory being pruned", async () => {
    const { root } = newRoot();
    workspace(root, RUN_A, 40);
    const a = createLiveWorkspaces({ disk: { root, pid: PID_A } });
    a.hold(RUN_A);
    expect((await prune(root, createLiveWorkspaces())).removed).toEqual([]);
    a.release(RUN_A);
    const b = createLiveWorkspaces({ disk: { root, pid: PID_B } });
    let during: boolean | undefined;
    await prune(root, b, { afterJudged: async () => void (during = b.hold(RUN_A)) });
    expect(during).toBe(false);
    expect(existsSync(path.join(root, HOLDS_DIR, `${RUN_A}.${PID_B}`))).toBe(false);
  });

  it("a hold whose process is gone is ignored and removed, so a crash keeps nothing", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 40);
    mkdirSync(path.join(root, HOLDS_DIR), { mode: 0o700 });
    const stale = path.join(root, HOLDS_DIR, `${RUN_A}.3999999`);
    writeFileSync(stale, "");
    expect(heldOnDisk(root, RUN_A, isAlive)).toBe(false);
    expect(existsSync(stale)).toBe(false);
    writeFileSync(stale, "");
    expect((await prune(root, createLiveWorkspaces())).removed.map((e) => e.name)).toEqual([RUN_A]);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(stale)).toBe(false);
  });

  it("a hold taken by another runner just before the directory is moved aside puts it back, whole", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 40);
    const b = createLiveWorkspaces({ disk: { root, pid: PID_B } });
    const report = await prune(root, b, {
      // Runner A takes its hold in the gap between the prune's look and its move.
      afterJudged: async () => void holdOnDisk(root, RUN_A, PID_A),
    });
    expect(report.removed).toEqual([]);
    expect(report.kept).toEqual([{ name: RUN_A, reason: "live" }]);
    expect(existsSync(path.join(dir, "src", "f.txt"))).toBe(true);
    expect(readdirSync(root).filter((n) => n.startsWith(".pruning-"))).toEqual([]);
  });

  it("a hold that cannot be written is a refusal (the resume starts fresh), never a link followed: a planted link at the hold's name, or a holds directory that is a link", () => {
    const { root, outside } = newRoot();
    const target = path.join(outside, "victim.txt");
    writeFileSync(target, "important");
    chmodSync(target, 0o644);
    mkdirSync(path.join(root, HOLDS_DIR), { mode: 0o700 });
    symlinkSync(target, path.join(root, HOLDS_DIR, `${RUN_A}.${PID_A}`));
    const a = createLiveWorkspaces({ disk: { root, pid: PID_A } });
    expect(a.hold(RUN_A)).toBe(false);
    expect(a.names()).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("important");
    expect(lstatSync(target).mode & 0o777).toBe(0o644);
    // The directory itself replaced by a link to somewhere else.
    renameSync(path.join(root, HOLDS_DIR), path.join(outside, "elsewhere"));
    symlinkSync(path.join(outside, "elsewhere"), path.join(root, HOLDS_DIR));
    expect(a.hold(RUN_B)).toBe(false);
    expect(readdirSync(path.join(outside, "elsewhere"))).toEqual([`${RUN_A}.${PID_A}`]);
  });

  it("a holds directory that cannot be read holds everything", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 40);
    mkdirSync(path.join(root, HOLDS_DIR), { mode: 0o700 });
    chmodSync(path.join(root, HOLDS_DIR), 0o000);
    try {
      const report = await prune(root, createLiveWorkspaces());
      expect(report.removed).toEqual([]);
      expect(existsSync(dir)).toBe(true);
    } finally {
      chmodSync(path.join(root, HOLDS_DIR), 0o700);
    }
  });
});

describe("setup copies are held across runners while a job is in hand (D#587 FU-318)", () => {
  const SETUP = "setup-0123456789abcdef";

  it("two runners: runner A's setup copy is kept by runner B's prune while A has a job in hand, however old, and goes once A has none or is gone", async () => {
    const { root } = newRoot();
    const dir = workspace(root, SETUP, 40);
    const other = workspace(root, RUN_A, 40);
    let jobsA = 1;
    const a = createLiveWorkspaces({ setupsRunning: () => jobsA, disk: { root, pid: PID_A } });
    const b = createLiveWorkspaces({ setupsRunning: () => 0, disk: { root, pid: PID_B } });
    a.syncSetups();
    expect(existsSync(path.join(root, HOLDS_DIR, `setups-in-hand.${PID_A}`))).toBe(true);
    expect(b.has(SETUP)).toBe(false);
    const kept = await prune(root, b);
    expect(kept.kept).toEqual([{ name: SETUP, reason: "live" }]);
    // Only setup copies are covered by it: a run's directory is not held by "a job is in hand".
    expect(kept.removed.map((e) => e.name)).toEqual([RUN_A]);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(other)).toBe(false);
    jobsA = 0;
    a.syncSetups();
    expect(existsSync(path.join(root, HOLDS_DIR, `setups-in-hand.${PID_A}`))).toBe(false);
    expect((await prune(root, b)).removed.map((e) => e.name)).toEqual([SETUP]);
  });

  it("the daemon's job counter drives the hold: written when a job starts, removed when the last one ends, whatever way it ends", async () => {
    const { root } = newRoot();
    const jobs = createJobsInHand(() => live.syncSetups());
    const live = createLiveWorkspaces({ setupsRunning: () => jobs.count(), disk: { root, pid: PID_A } });
    const file = path.join(root, HOLDS_DIR, `setups-in-hand.${PID_A}`);
    let release!: () => void;
    const first = jobs.track(() => new Promise<void>((resolve) => (release = resolve)));
    const second = jobs.track(() => Promise.reject(new Error("job failed"))).catch(() => undefined);
    await second;
    expect(existsSync(file)).toBe(true);
    release();
    await first;
    expect(existsSync(file)).toBe(false);
  });

  it("a runner that died with a job in hand holds nothing; a hold taken just before the move puts the setup copy back; without a disk nothing is written", async () => {
    const { root } = newRoot();
    const dir = workspace(root, SETUP, 40);
    mkdirSync(path.join(root, HOLDS_DIR), { mode: 0o700 });
    writeFileSync(path.join(root, HOLDS_DIR, "setups-in-hand.3999999"), "");
    const b = createLiveWorkspaces({ disk: { root, pid: PID_B } });
    const gap = await prune(root, b, { afterJudged: async () => void holdOnDisk(root, "setups-in-hand", PID_A) });
    // The dead runner's file was ignored (and removed), then A's hold appeared between the look and the move.
    expect(gap.removed).toEqual([]);
    expect(gap.kept).toEqual([{ name: SETUP, reason: "live" }]);
    expect(existsSync(path.join(dir, "src", "f.txt"))).toBe(true);
    createLiveWorkspaces({ setupsRunning: () => 1 }).syncSetups();
    expect(readdirSync(path.join(root, HOLDS_DIR)).sort()).toEqual([`setups-in-hand.${PID_A}`]);
  });
});

describe("a taken-over session holds its workspace (D#587 FU-318)", () => {
  it("the workspace is held while the session runs, kept by any prune however long it sits, and released after, even when the session fails", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 40);
    let during: Awaited<ReturnType<typeof prune>> | undefined;
    const result = await runHeldTakeover(dir, PID_A, async () => {
      expect(existsSync(path.join(root, HOLDS_DIR, `${RUN_A}.${PID_A}`))).toBe(true);
      during = await prune(root, createLiveWorkspaces());
      return 7;
    });
    expect(result).toBe(7);
    expect(during?.removed).toEqual([]);
    expect(during?.kept).toEqual([{ name: RUN_A, reason: "live" }]);
    expect(existsSync(path.join(root, HOLDS_DIR, `${RUN_A}.${PID_A}`))).toBe(false);
    await expect(runHeldTakeover(dir, PID_A, async () => Promise.reject(new Error("session crashed")))).rejects.toThrow("crashed");
    expect(existsSync(path.join(root, HOLDS_DIR, `${RUN_A}.${PID_A}`))).toBe(false);
    expect((await prune(root, createLiveWorkspaces())).removed.map((e) => e.name)).toEqual([RUN_A]);
  });

  it("a workspace the prune never removes is not held, and a hold that cannot be written refuses the takeover before it starts", async () => {
    const { root } = newRoot();
    const other = path.join(root, "my-own-checkout");
    mkdirSync(other);
    let started = false;
    await runHeldTakeover(other, PID_A, async () => void (started = true));
    expect(started).toBe(true);
    expect(existsSync(path.join(root, HOLDS_DIR))).toBe(false);
    mkdirSync(path.join(root, RUN_B));
    writeFileSync(path.join(root, HOLDS_DIR), "a file where the directory belongs");
    started = false;
    await expect(runHeldTakeover(path.join(root, RUN_B), PID_A, async () => void (started = true))).rejects.toThrow();
    expect(started).toBe(false);
  });
});
