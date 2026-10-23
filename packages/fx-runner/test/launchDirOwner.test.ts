/**
 * D#6 RUNNER-CWD-1, CWE-283: the launch root, every launch directory and the daemon's directory must belong to the user the runner runs as. A test
 * process cannot make a directory another account owns, so `lstat` is stubbed for the paths a test names: it reports the real answer with the
 * owner moved to another uid, and everything else (type, mode, the real directory on disk) stays as it is. Each case has a control that passes.
 */
import type * as Fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchRefused, ensureLaunchRoot, inLaunchDir, openLaunchDir, prepareDaemonDir, type LaunchPlace } from "../src/launchDir.js";
import { tmpRoot } from "./helpers/tmpRoot.js";

const stub = vi.hoisted(() => ({ foreign: (_target: string): boolean => false }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof Fs>();
  const lstatSync = ((target: Fs.PathLike, ...rest: unknown[]) => {
    const info = (real.lstatSync as (p: Fs.PathLike, ...r: unknown[]) => Fs.Stats)(target, ...rest);
    if (!stub.foreign(String(target))) return info;
    return Object.assign(Object.create(Object.getPrototypeOf(info) as object) as Fs.Stats, info, { uid: info.uid + 1 });
  }) as typeof real.lstatSync;
  return { ...real, lstatSync, default: { ...real, lstatSync } };
});

const uid = process.getuid?.();
let scratch: string;
let place: LaunchPlace;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpRoot(), "fxr-launch-owner-"));
  const home = path.join(scratch, "home");
  mkdirSync(home);
  place = { root: path.join(scratch, "cache", "launch"), home, processCwd: () => scratch, uid };
  stub.foreign = () => false;
});
afterEach(() => {
  stub.foreign = () => false;
  rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(uid === undefined)("the launch directories must belong to the runner's own user", () => {
  it("control: with every directory its own, the root, a launch directory and the daemon's directory are all accepted", async () => {
    expect(() => ensureLaunchRoot(place)).not.toThrow();
    expect(await inLaunchDir(place, async (dir) => existsSync(dir))).toBe(true);
    expect(() => prepareDaemonDir(place)).not.toThrow();
  });

  it("refuses a launch root that belongs to another user, and starts nothing in it", async () => {
    stub.foreign = (target) => target === place.root;
    expect(() => ensureLaunchRoot(place)).toThrow(LaunchRefused);
    expect(() => openLaunchDir(place)).toThrow(LaunchRefused);
    const run = vi.fn(async () => 1);
    await expect(inLaunchDir(place, run)).rejects.toThrow(LaunchRefused);
    expect(run).not.toHaveBeenCalled();
    expect(() => prepareDaemonDir(place)).toThrow(LaunchRefused);
  });

  it("refuses a launch directory that belongs to another user and removes it, while the root is its own", () => {
    stub.foreign = (target) => path.basename(target).startsWith("l-");
    const rootReal = ensureLaunchRoot(place);
    expect(() => openLaunchDir(place)).toThrow(LaunchRefused);
    expect(readdirSync(rootReal)).toEqual([]);
  });

  it("refuses a daemon directory that belongs to another user, while the root is its own", () => {
    stub.foreign = (target) => path.basename(target) === "daemon";
    expect(() => ensureLaunchRoot(place)).not.toThrow();
    expect(() => prepareDaemonDir(place)).toThrow(LaunchRefused);
  });

  it("refuses a directory of another user however it is reached: the same root under a uid that is not the runner's", () => {
    // No stub here: the real directory is this process's, and the place says the runner is someone else.
    ensureLaunchRoot(place);
    expect(() => ensureLaunchRoot({ ...place, uid: uid! + 1 })).toThrow(LaunchRefused);
    expect(() => prepareDaemonDir({ ...place, uid: uid! + 1 })).toThrow(LaunchRefused);
  });
});
