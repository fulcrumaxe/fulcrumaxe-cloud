import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRUNE_EVERY_MS, PRUNE_FIRST_DELAY_MS, startWorkspacePruner } from "../src/daemon/workspacePruner.js";
import {
  DEFAULT_RETENTION_DAYS,
  LIVE_FILE,
  createLiveWorkspaces,
  formatBytes,
  isPrunableName,
  pruneWorkspaces,
  readLiveFile,
  retentionFor,
  summariseWorkspaces,
  treeFacts,
  writeLiveFile,
} from "../src/job/workspacePrune.js";
import { tempDir } from "./helpers/tempTree.js";

const DAY = 86_400_000;
const NOW = new Date("2026-12-01T12:00:00Z");
const RUN_A = "0f3c9a1e-5b7d-4c2a-9e18-6a4b2d7c1f01";
const RUN_B = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const RUN_C = "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e";
const SETUP = "setup-0123456789abcdef";

const newRoot = (): { base: string; root: string; outside: string } => {
  const base = tempDir("fx318-");
  const root = path.join(base, "workspaces");
  const outside = path.join(base, "outside");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(outside);
  return { base, root, outside };
};

/** Sets the mtime of `target` and everything under it (lstat-based: links are not followed) to `ageDays` before NOW. */
function age(target: string, ageDays: number): void {
  const when = new Date(NOW.getTime() - ageDays * DAY);
  const st = lstatSync(target);
  if (st.isDirectory()) for (const name of readdirSync(target)) age(path.join(target, name), ageDays);
  if (st.isSymbolicLink()) lutimesSync(target, when, when);
  else utimesSync(target, when, when);
}

/** A workspace with a nested file, a read-only directory and a file in it, all `ageDays` old. */
function workspace(root: string, name: string, ageDays: number): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
  writeFileSync(path.join(dir, "src", "deep", "file.txt"), "x".repeat(5000));
  mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1\n");
  chmodSync(path.join(dir, "node_modules", "pkg"), 0o500);
  age(dir, ageDays);
  return dir;
}

const none = createLiveWorkspaces();
const run = (root: string, over: Partial<Parameters<typeof pruneWorkspaces>[0]> = {}) => pruneWorkspaces({ root, now: NOW, live: none, dryRun: false, freeFraction: 0.5, isAlive: () => true, ...over });

describe("pruning finished runs' workspaces", () => {
  it("removes an old finished run, read-only directories and all, and keeps a recent one", async () => {
    const { root } = newRoot();
    const old = workspace(root, RUN_A, 10);
    const fresh = workspace(root, RUN_B, 2);
    const report = await run(root);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(report.removed.map((e) => e.name)).toEqual([RUN_A]);
    expect(report.removed[0]?.idleDays).toBe(10);
    expect(report.bytesFreed).toBeGreaterThan(5000);
    expect(report.kept).toEqual([{ name: RUN_B, reason: "recent" }]);
    expect(report.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("never removes a workspace a live run holds, however old, and removes it once the run releases it", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 90);
    const live = createLiveWorkspaces();
    expect(live.hold(RUN_A)).toBe(true);
    const held = await run(root, { live });
    expect(existsSync(dir)).toBe(true);
    expect(held.kept).toEqual([{ name: RUN_A, reason: "live" }]);
    live.release(RUN_A);
    const after = await run(root, { live });
    expect(existsSync(dir)).toBe(false);
    expect(after.removed).toHaveLength(1);
  });

  it("counts holds: two overlapping holds of one directory need two releases", () => {
    const live = createLiveWorkspaces();
    live.hold(RUN_A);
    live.hold(RUN_A);
    live.release(RUN_A);
    expect(live.has(RUN_A)).toBe(true);
    live.release(RUN_A);
    expect(live.has(RUN_A)).toBe(false);
    live.release(RUN_A);
    expect(live.names()).toEqual([]);
  });

  it("keeps a setup copy while any setup or job is in hand, and a run's directory is not held by that", async () => {
    const { root } = newRoot();
    const setup = workspace(root, SETUP, 30);
    const inHand = createLiveWorkspaces({ setupsRunning: () => 1 });
    const listed = await run(root, { live: inHand, dryRun: true });
    expect(listed.removed).toEqual([]);
    const held = await run(root, { live: inHand });
    expect(existsSync(setup)).toBe(true);
    expect(held.kept).toEqual([{ name: SETUP, reason: "live" }]);
    const idle = createLiveWorkspaces({ setupsRunning: () => 0 });
    await run(root, { live: idle });
    expect(existsSync(setup)).toBe(false);
  });

  it("a directory is old only when everything inside it is: one recent file deep down keeps the whole workspace", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 30);
    const recent = path.join(dir, "src", "deep", "touched.txt");
    writeFileSync(recent, "now");
    utimesSync(recent, new Date(NOW.getTime() - DAY), new Date(NOW.getTime() - DAY));
    const report = await run(root);
    expect(existsSync(dir)).toBe(true);
    expect(report.kept).toEqual([{ name: RUN_A, reason: "recent" }]);
  });

  it("dry run lists what would go with its size and age, and deletes nothing", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 12);
    workspace(root, RUN_B, 1);
    const report = await run(root, { dryRun: true });
    expect(existsSync(path.join(dir, "src", "deep", "file.txt"))).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(report.removed.map((e) => [e.name, e.idleDays])).toEqual([[RUN_A, 12]]);
    expect(report.bytesFreed).toBeGreaterThan(0);
    expect(readdirSync(root).sort()).toEqual([RUN_A, RUN_B].sort());
  });

  it("leaves what the runner did not make alone: other names, a stray file, a link named like a run", async () => {
    const { root, outside } = newRoot();
    writeFileSync(path.join(outside, "keep.txt"), "mine");
    const odd = workspace(root, "fx-probe", 50);
    writeFileSync(path.join(root, "notes.txt"), "x");
    symlinkSync(outside, path.join(root, RUN_C));
    writeFileSync(path.join(root, RUN_B), "a file with a run's name");
    const report = await run(root);
    expect(existsSync(odd)).toBe(true);
    expect(existsSync(path.join(root, "notes.txt"))).toBe(true);
    expect(lstatSync(path.join(root, RUN_C)).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("mine");
    expect(report.removed).toEqual([]);
    expect(Object.fromEntries(report.kept.map((k) => [k.name, k.reason]))).toEqual({ "fx-probe": "other_name", "notes.txt": "other_name", [RUN_C]: "not_directory", [RUN_B]: "not_directory" });
  });

  it("a link inside a workspace pointing outside is unlinked as a link: its target and the files in it are untouched", async () => {
    const { root, outside } = newRoot();
    const secret = path.join(outside, "secret.txt");
    writeFileSync(secret, "outside data");
    mkdirSync(path.join(outside, "sub"));
    writeFileSync(path.join(outside, "sub", "inner.txt"), "inner");
    chmodSync(path.join(outside, "sub"), 0o500);
    const dir = workspace(root, RUN_A, 20);
    symlinkSync(outside, path.join(dir, "escape-dir"));
    symlinkSync(secret, path.join(dir, "escape-file"));
    symlinkSync(path.join(root, ".."), path.join(dir, "up"));
    age(dir, 20);
    const report = await run(root);
    expect(report.removed.map((e) => e.name)).toEqual([RUN_A]);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(secret, "utf8")).toBe("outside data");
    expect(readFileSync(path.join(outside, "sub", "inner.txt"), "utf8")).toBe("inner");
    expect(lstatSync(path.join(outside, "sub")).mode & 0o777).toBe(0o500);
    chmodSync(path.join(outside, "sub"), 0o700);
  });

  it("a workspace that IS a link to a directory outside the root is never entered", async () => {
    const { root, outside } = newRoot();
    writeFileSync(path.join(outside, "keep.txt"), "mine");
    age(outside, 400);
    symlinkSync(outside, path.join(root, RUN_A));
    const report = await run(root);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("mine");
    expect(report.kept).toEqual([{ name: RUN_A, reason: "not_directory" }]);
  });

  it("path escapes: a root that is a link, a root with dots or a trailing slash, and a relative root touch nothing", async () => {
    const { base, root, outside } = newRoot();
    const victim = workspace(outside, RUN_A, 100);
    const link = path.join(base, "link-root");
    symlinkSync(outside, link);
    expect((await run(link)).rootRefused).toBe(true);
    expect((await run(`${root}/../outside`)).rootRefused).toBe(true);
    expect((await run(`${outside}/`)).rootRefused).toBe(true);
    expect((await run("relative/workspaces")).rootRefused).toBe(true);
    expect(existsSync(victim)).toBe(true);
    expect((await run(path.join(base, "nope"))).rootMissing).toBe(true);
  });

  it("run-id names that try to climb are not prunable names", () => {
    for (const bad of ["..", ".", "../x", `${RUN_A}/..`, `${RUN_A}/x`, `${RUN_A} `, RUN_A.toUpperCase(), "", "setup-../../etc", "setup-0123456789abcdeg", "fx-probe"]) expect(isPrunableName(bad), bad).toBe(false);
    for (const good of [RUN_A, SETUP, "setup-empty-0123456789abcdef.git"]) expect(isPrunableName(good), good).toBe(true);
  });

  it("refuses a directory that belongs to someone else", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 40);
    const other = (process.getuid?.() ?? 0) + 1;
    const foreignChild = await run(root, { uid: other });
    expect(foreignChild.kept).toEqual([{ name: RUN_A, reason: "not_ours" }]);
    const foreignRoot = await run(root, { rootUid: other });
    expect(foreignRoot.rootRefused).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect((await run(root)).removed).toHaveLength(1);
  });

  it("keeps a directory that was touched between the judgement and the removal", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 40);
    const report = await run(root, {
      afterJudged: async (judged) => {
        const f = path.join(judged, "late.txt");
        writeFileSync(f, "a run started writing here");
        utimesSync(judged, NOW, NOW);
      },
    });
    expect(existsSync(dir)).toBe(true);
    expect(report.removed).toEqual([]);
    expect(report.kept).toEqual([{ name: RUN_A, reason: "recent" }]);
  });

  it("keeps a directory that was swapped for another one (a different inode) after it was judged", async () => {
    const { root, base } = newRoot();
    const dir = workspace(root, RUN_A, 40);
    const report = await run(root, {
      afterJudged: async (judged) => {
        renameSync(judged, path.join(base, "moved"));
        mkdirSync(judged);
        writeFileSync(path.join(judged, "other.txt"), "someone else's");
        age(judged, 40);
      },
    });
    expect(existsSync(path.join(dir, "other.txt"))).toBe(true);
    expect(report.removed).toEqual([]);
    expect(existsSync(path.join(base, "moved", "src"))).toBe(true);
  });

  it("a run cannot take a directory the prune is removing, and the prune cannot take one a run holds", async () => {
    const { root } = newRoot();
    workspace(root, RUN_A, 40);
    const live = createLiveWorkspaces();
    let during: boolean | undefined;
    await run(root, {
      live,
      afterJudged: async () => {
        during = live.hold(RUN_A);
      },
    });
    expect(during).toBe(false);
    expect(live.hold(RUN_A)).toBe(true);
    expect(live.claimForPrune(RUN_A)).toBeUndefined();
    live.release(RUN_A);
    const release = live.claimForPrune(RUN_B);
    expect(release).toBeTypeOf("function");
    expect(live.claimForPrune(RUN_B)).toBeUndefined();
    release?.();
    expect(live.hold(RUN_B)).toBe(true);
  });
});

describe("retention and disk pressure", () => {
  it("is 7 days by default, the configured days otherwise, and 1 day under 10% free whatever was configured", () => {
    expect(retentionFor(undefined, 0.5)).toEqual({ days: 7, pressure: false });
    expect(retentionFor(30, 0.5)).toEqual({ days: 30, pressure: false });
    expect(retentionFor(undefined, 0.09)).toEqual({ days: 1, pressure: true });
    expect(retentionFor(30, 0.099)).toEqual({ days: 1, pressure: true });
    expect(retentionFor(30, 0.1)).toEqual({ days: 30, pressure: false });
    expect(retentionFor(1, 0.01)).toEqual({ days: 1, pressure: true });
    expect(retentionFor(30, undefined)).toEqual({ days: 30, pressure: false });
  });

  it("under pressure a 2-day-old finished workspace goes; with room it stays; a 12-hour-old one stays either way", async () => {
    const { root } = newRoot();
    const two = workspace(root, RUN_A, 2);
    const half = workspace(root, RUN_B, 0.5);
    const roomy = await run(root, { freeFraction: 0.3, dryRun: true });
    expect(roomy.removed).toEqual([]);
    const tight = await run(root, { freeFraction: 0.05 });
    expect(tight.pressure).toBe(true);
    expect(tight.retentionDays).toBe(1);
    expect(existsSync(two)).toBe(false);
    expect(existsSync(half)).toBe(true);
  });

  it("a configured retention shortens or lengthens the window", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 10);
    expect((await run(root, { retentionDays: 30, dryRun: true })).removed).toEqual([]);
    expect((await run(root, { retentionDays: 5 })).removed).toHaveLength(1);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("the list the command line reads", () => {
  it("round-trips, is private, and a missing, damaged or linked file reads as unknown", () => {
    const { base } = newRoot();
    writeLiveFile(base, [RUN_A, RUN_B]);
    expect(readLiveFile(base)).toEqual([RUN_A, RUN_B]);
    expect(lstatSync(path.join(base, LIVE_FILE)).mode & 0o777).toBe(0o600);
    writeFileSync(path.join(base, LIVE_FILE), "{not json");
    expect(readLiveFile(base)).toBeUndefined();
    writeFileSync(path.join(base, LIVE_FILE), JSON.stringify({ names: [1] }));
    expect(readLiveFile(base)).toBeUndefined();
    rmSync(path.join(base, LIVE_FILE));
    expect(readLiveFile(base)).toBeUndefined();
    writeFileSync(path.join(base, "elsewhere.json"), JSON.stringify({ names: [] }));
    symlinkSync(path.join(base, "elsewhere.json"), path.join(base, LIVE_FILE));
    expect(readLiveFile(base)).toBeUndefined();
  });

  it("the registry saves its list on every hold and release", () => {
    const saved: string[][] = [];
    const live = createLiveWorkspaces({ persist: (names) => saved.push(names) });
    live.hold(RUN_B);
    live.hold(RUN_A);
    live.release(RUN_B);
    expect(saved).toEqual([[RUN_B], [RUN_A, RUN_B], [RUN_A]]);
  });
});

describe("what doctor reports", () => {
  it("counts directories and disk bytes and finds the oldest idle age; a missing root reports nothing", async () => {
    const { root, base } = newRoot();
    workspace(root, RUN_A, 40);
    workspace(root, RUN_B, 3);
    writeFileSync(path.join(root, "stray"), "x");
    const summary = await summariseWorkspaces(root, NOW);
    expect(summary?.directories).toBe(2);
    expect(summary?.oldestIdleDays).toBe(40);
    expect(summary?.bytes).toBeGreaterThanOrEqual(10_000);
    expect(summary?.partial).toBe(false);
    expect(await summariseWorkspaces(path.join(base, "none"), NOW)).toBeUndefined();
    expect((await summariseWorkspaces(root, NOW, 3))?.partial).toBe(true);
  });

  it("measures a tree without following links", async () => {
    const { root, outside } = newRoot();
    writeFileSync(path.join(outside, "big.bin"), "y".repeat(1_000_000));
    const dir = workspace(root, RUN_A, 1);
    symlinkSync(outside, path.join(dir, "link"));
    const facts = await treeFacts(dir);
    expect(facts.bytes).toBeLessThan(200_000);
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(131 * 1024 ** 3)).toBe("131.0 GB");
  });
});

describe("the daemon's pass", () => {
  const fake = () => {
    const calls: { fn: () => void; ms: number }[] = [];
    const cancelled: object[] = [];
    return {
      calls,
      cancelled,
      schedule: (fn: () => void, ms: number) => {
        const handle = { unrefCalled: false, unref() { this.unrefCalled = true; } };
        calls.push({ fn, ms });
        return handle;
      },
      cancel: (h: object) => void cancelled.push(h),
    };
  };

  it("first pass after a minute, then hourly; each pass prunes and says what it did; stop cancels", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 20);
    const t = fake();
    const log: string[] = [];
    const pruner = startWorkspacePruner({ root, live: none, retentionDays: () => undefined, now: () => NOW, log: (l) => log.push(l), schedule: t.schedule, cancel: t.cancel, freeFraction: () => 0.5, isAlive: () => true });
    expect(t.calls.map((c) => c.ms)).toEqual([PRUNE_FIRST_DELAY_MS]);
    t.calls[0]?.fn();
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(dir)).toBe(false);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("pruned 1 finished workspace");
    expect(t.calls.map((c) => c.ms)).toEqual([PRUNE_FIRST_DELAY_MS, PRUNE_EVERY_MS]);
    pruner.stop();
    expect(t.cancelled).toHaveLength(1);
    expect(await pruner.runOnce()).toBeUndefined();
  });

  it("reads the retention again every pass, does not overlap two passes and says nothing when nothing went", async () => {
    const { root } = newRoot();
    workspace(root, RUN_A, 10);
    const t = fake();
    const log: string[] = [];
    let days: number | undefined = 30;
    const pruner = startWorkspacePruner({ root, live: none, retentionDays: () => days, now: () => NOW, log: (l) => log.push(l), schedule: t.schedule, cancel: t.cancel, freeFraction: () => 0.5, isAlive: () => true });
    const first = await pruner.runOnce();
    expect(first?.removed).toEqual([]);
    expect(log).toEqual([]);
    days = 5;
    const [a, b] = await Promise.all([pruner.runOnce(), pruner.runOnce()]);
    expect([a, b].filter((r) => r !== undefined)).toHaveLength(1);
    expect(log).toHaveLength(1);
    pruner.stop();
  });
});
