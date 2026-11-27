import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startWorkspacePruner, stopWithin } from "../src/daemon/workspacePruner.js";
import { createLiveWorkspaces, isPrunableName, makeOwnerAccessible, pruneWorkspaces, tombstoneOf } from "../src/job/workspacePrune.js";
import { tempDir } from "./helpers/tempTree.js";

/** A switch on `unlink`, so a test can make one file impossible to remove, or run code when the deletion starts, as an immutable file or a shutdown would. */
const hooks = vi.hoisted(() => ({ failOn: undefined as ((p: string) => boolean) | undefined, onUnlink: undefined as (() => void) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (p: string) => {
      hooks.onUnlink?.();
      if (hooks.failOn?.(String(p)) === true) throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
      return actual.unlink(p);
    },
  };
});

const DAY = 86_400_000;
const NOW = new Date("2026-12-01T12:00:00Z");
const RUN_A = "0f3c9a1e-5b7d-4c2a-9e18-6a4b2d7c1f01";
const RUN_B = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";

const newRoot = (): { base: string; root: string; outside: string } => {
  const base = tempDir("fx318t-");
  const root = path.join(base, "workspaces");
  const outside = path.join(base, "outside");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(outside);
  return { base, root, outside };
};

function workspace(root: string, name: string, ageDays: number): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  for (const f of ["a.txt", "b.txt", "z-stuck.txt"]) writeFileSync(path.join(dir, "src", f), "x".repeat(2000));
  const when = new Date(NOW.getTime() - ageDays * DAY);
  for (const p of [path.join(dir, "src", "a.txt"), path.join(dir, "src", "b.txt"), path.join(dir, "src", "z-stuck.txt"), path.join(dir, "src"), dir]) utimesSync(p, when, when);
  return dir;
}

const none = createLiveWorkspaces();
const run = (root: string, over: Partial<Parameters<typeof pruneWorkspaces>[0]> = {}) => pruneWorkspaces({ root, now: NOW, live: none, dryRun: false, freeFraction: 0.5, isAlive: () => true, ...over });
const names = (root: string): string[] => readdirSync(root).sort();
const resumable = (root: string): string[] => names(root).filter((n) => isPrunableName(n));
const tombstones = (root: string): string[] => names(root).filter((n) => tombstoneOf(n) !== undefined);

describe("a removal that stops part-way never leaves a workspace a run could resume (D#587 FU-318)", () => {
  it("one file that cannot be removed leaves a tombstone, not a half directory under the run's name; the next pass finishes it", async () => {
    const { root } = newRoot();
    workspace(root, RUN_A, 30);
    hooks.failOn = (p) => p.endsWith("z-stuck.txt");
    try {
      const report = await run(root);
      expect(report.failed).toEqual([RUN_A]);
      expect(report.removed).toEqual([]);
      // The name a resume looks for is gone; what is left carries the tombstone name and holds the part that could not go.
      expect(resumable(root)).toEqual([]);
      expect(existsSync(path.join(root, RUN_A))).toBe(false);
      const left = tombstones(root);
      expect(left).toHaveLength(1);
      expect(left[0]).toMatch(new RegExp(`^\\.pruning-${RUN_A}-[0-9a-f]{12}$`));
      expect(existsSync(path.join(root, left[0] as string, "src", "z-stuck.txt"))).toBe(true);
    } finally {
      hooks.failOn = undefined;
    }
    const next = await run(root);
    expect(next.finishedLeftovers).toBe(1);
    expect(names(root)).toEqual([]);
  });

  it("a shutdown in the middle of a deletion leaves a tombstone, never the half-deleted name", async () => {
    const { root } = newRoot();
    workspace(root, RUN_A, 30);
    const stop = new AbortController();
    hooks.onUnlink = () => stop.abort();
    try {
      const report = await run(root, { signal: stop.signal });
      expect(report.removed).toEqual([]);
      expect(report.failed).toEqual([]);
    } finally {
      hooks.onUnlink = undefined;
    }
    expect(resumable(root)).toEqual([]);
    expect(tombstones(root)).toHaveLength(1);
    expect((await run(root)).finishedLeftovers).toBe(1);
    expect(names(root)).toEqual([]);
  });

  it("a leftover tombstone is finished by the next pass, however recent; a dry run leaves it; names that are not ours and links are never followed", async () => {
    const { root, outside } = newRoot();
    writeFileSync(path.join(outside, "keep.txt"), "mine");
    const left = path.join(root, `.pruning-${RUN_A}-0123456789ab`);
    mkdirSync(path.join(left, "src"), { recursive: true });
    writeFileSync(path.join(left, "src", "f.txt"), "x");
    // Not ours: an inner name that is no workspace name, a tombstone that is a link, and one that is a file.
    mkdirSync(path.join(root, ".pruning-notmine-0123456789ab"));
    symlinkSync(outside, path.join(root, `.pruning-${RUN_B}-ba9876543210`));
    writeFileSync(path.join(root, `.pruning-${RUN_B}-aaaaaaaaaaaa`), "file");
    expect((await run(root, { dryRun: true })).finishedLeftovers).toBe(0);
    expect(existsSync(left)).toBe(true);
    const report = await run(root);
    expect(report.finishedLeftovers).toBe(1);
    expect(existsSync(left)).toBe(false);
    expect(existsSync(path.join(root, ".pruning-notmine-0123456789ab"))).toBe(true);
    expect(lstatSync(path.join(root, `.pruning-${RUN_B}-ba9876543210`)).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(outside, "keep.txt"))).toBe(true);
    expect(existsSync(path.join(root, `.pruning-${RUN_B}-aaaaaaaaaaaa`))).toBe(true);
  });

  it("a tombstone and the holds directory are not counted among what was kept", async () => {
    const { root } = newRoot();
    mkdirSync(path.join(root, ".holds"));
    workspace(root, RUN_B, 1);
    const report = await run(root);
    expect(report.kept).toEqual([{ name: RUN_B, reason: "recent" }]);
  });

  it("two passes finishing the same tombstone do not fail each other", async () => {
    const { root } = newRoot();
    const left = path.join(root, `.pruning-${RUN_A}-0123456789ab`);
    mkdirSync(path.join(left, "a", "b"), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(path.join(left, "a", "b", `f${i}.txt`), "x");
    const [one, two] = await Promise.all([run(root), run(root)]);
    expect(one.failed).toEqual([]);
    expect(two.failed).toEqual([]);
    expect(existsSync(left)).toBe(false);
  });
});

describe("the daemon's shutdown waits for the pass in progress", () => {
  it("stop() returns the pass: it resolves only once the pass has ended, and the pass does not delete after the stop", async () => {
    const { root } = newRoot();
    workspace(root, RUN_A, 30);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    const pruner = startWorkspacePruner({
      root,
      live: none,
      retentionDays: () => undefined,
      now: () => NOW,
      log: () => undefined,
      schedule: () => ({}),
      cancel: () => undefined,
      freeFraction: () => 0.5,
      isAlive: () => true,
      afterJudged: async () => {
        reached();
        await gate;
      },
    });
    const pass = pruner.runOnce();
    await atGate;
    let stopped = false;
    const stopping = pruner.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBe(false);
    open();
    await stopping;
    expect(stopped).toBe(true);
    expect(await pass).toMatchObject({ removed: [] });
    // Nothing was moved or deleted after the stop; the workspace is whole.
    expect(resumable(root)).toEqual([RUN_A]);
    expect(existsSync(path.join(root, RUN_A, "src", "a.txt"))).toBe(true);
    expect(tombstones(root)).toEqual([]);
  });

  it("stop() with no pass running resolves at once, and the bounded wait gives up on a pass that never ends", async () => {
    const { root } = newRoot();
    const pruner = startWorkspacePruner({ root, live: none, retentionDays: () => undefined, now: () => NOW, log: () => undefined, schedule: () => ({}), cancel: () => undefined, isAlive: () => true });
    await pruner.stop();
    const started = Date.now();
    await stopWithin({ stop: () => new Promise<void>(() => undefined) }, 40);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("making a directory accessible never follows a link", () => {
  it("a link is refused and its target keeps its mode; a read-only directory and one with no bits at all are made usable", async () => {
    const { base, root } = newRoot();
    const target = path.join(base, "target");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    const link = path.join(root, "link");
    symlinkSync(target, link);
    await expect(makeOwnerAccessible(link)).rejects.toThrow();
    expect(lstatSync(target).mode & 0o777).toBe(0o755);
    const ro = path.join(root, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    await makeOwnerAccessible(ro);
    expect(lstatSync(ro).mode & 0o777).toBe(0o700);
    const dark = path.join(root, "dark");
    mkdirSync(dark);
    chmodSync(dark, 0o000);
    await makeOwnerAccessible(dark);
    expect(lstatSync(dark).mode & 0o777).toBe(0o700);
  });

  it("a workspace with directories that have no permission bits is still removed", async () => {
    const { root } = newRoot();
    const dir = workspace(root, RUN_A, 30);
    mkdirSync(path.join(dir, "locked", "inner"), { recursive: true });
    writeFileSync(path.join(dir, "locked", "inner", "f"), "x");
    const when = new Date(NOW.getTime() - 30 * DAY);
    utimesSync(path.join(dir, "locked", "inner", "f"), when, when);
    utimesSync(path.join(dir, "locked", "inner"), when, when);
    utimesSync(path.join(dir, "locked"), when, when);
    utimesSync(dir, when, when);
    chmodSync(path.join(dir, "locked", "inner"), 0o000);
    chmodSync(path.join(dir, "locked"), 0o000);
    const report = await run(root);
    expect(report.removed.map((e) => e.name)).toEqual([RUN_A]);
    expect(names(root)).toEqual([]);
  });
});
