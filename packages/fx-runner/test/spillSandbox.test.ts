import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { outcomeOf } from "../src/engines/claude/engine.js";
import { denyRules, workspaceProtectedEditRules } from "../src/engines/claude/filePermissions.js";
import { settingsFor } from "../src/engines/claude/settingsFile.js";
import { SandboxGrantRefused, sandboxSettings } from "../src/sandbox/sandboxSettings.js";
import { cacheRootsFor } from "../src/daemon/mirror.js";
import { RUN_ID, engineFor, makeRig } from "./engines/claude/rig.js";

/**
 * D#600 CX-4b: what the agent is allowed to read of the run's spill directory. The shell sandbox gets it as one read-only grant under the spill root; the file
 * tools get a `Read` rule for it and no `Edit` rule; the runner's state directory stays closed to both.
 */
const HOME = "/home/jane";
const STATE = "/home/jane/.fx-runner";
const BIN = "/home/jane/.local/bin";
const SPILL_ROOT = "/home/jane/.cache/fx-runner/spill";
const DIR = `${SPILL_ROOT}/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d`;
const base = { workspace: "/home/jane/.cache/fx-runner/workspaces/run-1", tempDir: "/home/jane/.cache/fx-runner/tmp/run-1", home: HOME, stateDir: STATE, binaryDir: BIN, workspaceRoot: "/home/jane/.cache/fx-runner/workspaces", tempRoot: "/home/jane/.cache/fx-runner/tmp" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const block = (over: Partial<Parameters<typeof sandboxSettings>[0]> = {}) => sandboxSettings({ ...base, ...over }) as Record<string, any>;

describe("the shell sandbox's read grant for a run's spill directory", () => {
  it("is one read-only grant under the spill root: readable, never writable", () => {
    const s = block({ spillRoot: SPILL_ROOT, extraReadPaths: [DIR] });
    expect(s.filesystem.allowRead).toContain(DIR);
    expect(s.filesystem.allowRead).not.toContain(SPILL_ROOT);
    expect(s.filesystem.allowWrite).not.toContain(DIR);
  });

  it("is refused without the root, outside the root, or for the root itself", () => {
    expect(() => block({ extraReadPaths: [DIR] })).toThrow(SandboxGrantRefused);
    expect(() => block({ spillRoot: SPILL_ROOT, extraReadPaths: ["/home/jane/other/run"] })).toThrow(SandboxGrantRefused);
    expect(() => block({ spillRoot: SPILL_ROOT, extraReadPaths: [SPILL_ROOT] })).toThrow(SandboxGrantRefused);
    expect(() => block({ spillRoot: SPILL_ROOT, extraReadPaths: [`${SPILL_ROOT}/../.fx-runner`] })).toThrow(SandboxGrantRefused);
  });

  it("can never be made to reach the runner's state directory: a spill root there is refused (the reason the root sits in the cache directory)", () => {
    expect(() => block({ spillRoot: `${STATE}/spill`, extraReadPaths: [`${STATE}/spill/run`] })).toThrow(SandboxGrantRefused);
  });

  it("the daemon's spill root is a sibling of the workspaces, mirrors and temp directories, and outside the state directory", () => {
    const roots = cacheRootsFor({ home: HOME, platform: "linux" });
    expect(path.dirname(roots.spillRoot)).toBe(path.dirname(roots.workspaceRoot));
    expect(path.basename(roots.spillRoot)).toBe("spill");
    expect(roots.spillRoot.startsWith(STATE)).toBe(false);
  });
});

describe("a cache directory outside the home directory (XDG_CACHE_HOME=/var/cache)", () => {
  const CACHE = "/var/cache/fx-runner";
  const OUT = { ...base, workspace: `${CACHE}/workspaces/run-1`, tempDir: `${CACHE}/tmp/run-1`, workspaceRoot: `${CACHE}/workspaces`, tempRoot: `${CACHE}/tmp` };
  const ROOT = `${CACHE}/spill`;
  const MINE = `${ROOT}/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d`;
  const OTHER = `${ROOT}/6c1f7d2b-3a5e-4b8f-8d42-9e7a1b2c3d4e`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = (over: Partial<Parameters<typeof sandboxSettings>[0]> = {}) => sandboxSettings({ ...OUT, spillRoot: ROOT, ...over }) as Record<string, any>;

  it("denies reading the whole spill root, and re-allows only this run's directory: another run's directory is unreadable", () => {
    const s = out({ extraReadPaths: [MINE] });
    expect(s.filesystem.denyRead).toEqual(expect.arrayContaining([ROOT, OUT.workspaceRoot, OUT.tempRoot]));
    expect(s.filesystem.allowRead).toContain(MINE);
    expect(s.filesystem.allowRead).not.toContain(OTHER);
    expect(s.filesystem.allowRead).not.toContain(ROOT);
    expect(s.filesystem.allowWrite).not.toContain(MINE);
  });

  it("refuses an allowance read or write path that is, contains or sits under the spill root", () => {
    for (const grant of [ROOT, CACHE, "/var/cache", MINE, OTHER]) {
      expect(() => out({ allowanceReadPaths: [grant] }), `read ${grant}`).toThrow(SandboxGrantRefused);
      expect(() => out({ allowanceWritePaths: [grant] }), `write ${grant}`).toThrow(SandboxGrantRefused);
    }
  });

  it("refuses a spill root that overlaps a runner root, the state directory or the home directory", () => {
    for (const bad of [OUT.workspaceRoot, OUT.tempRoot, `${OUT.workspaceRoot}/x`, STATE, `${STATE}/s`, HOME, "/"]) expect(() => out({ spillRoot: bad }), bad).toThrow(SandboxGrantRefused);
  });

  it("a job without a spill root has the settings it had before: no spill entry anywhere", () => {
    const s = sandboxSettings(OUT) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(JSON.stringify(s)).not.toContain("spill");
  });
});

describe("the file tools' rule for a run's spill directory", () => {
  const protectedList = { noAccess: [STATE, BIN], noEdit: [] as string[] };
  const settings = (spillDir?: string) => settingsFor("executor", {}, base.workspace, protectedList, [], spillDir) as { permissions: { allow: string[]; deny: string[] } };

  it("adds Read for the directory and what is under it, and no Edit rule for it", () => {
    const s = settings(DIR);
    expect(s.permissions.allow).toEqual(expect.arrayContaining([`Read(/${DIR})`, `Read(/${DIR}/**)`]));
    expect(s.permissions.allow.filter((rule) => rule.includes(DIR) && !rule.startsWith("Read("))).toEqual([]);
    expect(s.permissions.deny).toEqual([...denyRules(protectedList), ...workspaceProtectedEditRules(base.workspace)]);
  });

  it("the state directory stays denied, and no allow rule reaches it", () => {
    const s = settings(DIR);
    expect(s.permissions.deny).toEqual(expect.arrayContaining([`Read(/${STATE})`, `Read(/${STATE}/**)`]));
    expect(s.permissions.allow.some((rule) => rule.includes(STATE))).toBe(false);
  });

  it("a job without a spill gets exactly the settings it got before", () => {
    expect(settings(undefined)).toEqual(settingsFor("executor", {}, base.workspace, protectedList));
    expect(JSON.stringify(settings(undefined))).not.toContain("spill");
  });

  it("a directory that cannot be written as a literal rule refuses the start (fail closed)", () => {
    expect(() => settings("/home/jane/.cache/fx-runner/spill/a[b]")).toThrow();
  });

  it("the real engine writes the rule to the settings file for the directory it was given", async () => {
    const rig = makeRig();
    const start = { ...rig.startOptions(), spillDir: DIR };
    await outcomeOf((await engineFor(rig).start(start)).handle);
    const file = JSON.parse(readFileSync(path.join(rig.config.jobsDir, RUN_ID, "settings.json"), "utf8")) as { permissions: { allow: string[] } };
    expect(file.permissions.allow).toEqual(expect.arrayContaining([`Read(/${DIR})`, `Read(/${DIR}/**)`]));
  });
});
