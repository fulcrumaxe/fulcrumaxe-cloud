import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jobDirFor, outcomeOf } from "../../../src/engines/claude/engine.js";
import { RUN_ID, engineFor, makeFake, makeRig, streamWith } from "./rig.js";

/** Every file and directory under `dir`, relative to it. */
function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe("run id: only a uuid names a job directory", () => {
  it.each([
    ["a single dot", "."],
    ["two dots", ".."],
    ["a parent path", "../x"],
    ["a nested path", "a/b"],
    ["an absolute path", "/etc/cron.d"],
    ["an over-long id", "a".repeat(200)],
    ["a plain name that is not a uuid", "run-0001"],
    ["a uuid with a path tail", `${RUN_ID}/..`],
    ["an empty id", ""],
  ])("%s is refused as bad_start_options with zero spawns and no file written", async (_name, runId) => {
    const rig = makeRig();
    const before = listing(rig.root);
    await expect(engineFor(rig).start(rig.startOptions({ runId }))).rejects.toMatchObject({ code: "bad_start_options" });
    expect(rig.spawns).toEqual([]);
    expect(rig.fake.spawnCount()).toBe(0);
    expect(listing(rig.root)).toEqual(before);
    expect(existsSync(rig.config.jobsDir)).toBe(false);
    expect(existsSync(rig.config.logDir)).toBe(false);
  });

  it("a uuid is accepted and its files land in exactly one directory under jobsDir", async () => {
    const rig = makeRig();
    const { handle } = await engineFor(rig).start(rig.startOptions());
    await outcomeOf(handle);
    expect(readdirSync(rig.config.jobsDir)).toEqual([RUN_ID]);
    expect(readdirSync(path.join(rig.config.jobsDir, RUN_ID)).sort()).toEqual(["mcp.json", "settings.json"]);
  });

  it("jobDirFor, the second lock, refuses anything that is not one plain segment under jobsDir", () => {
    const jobs = path.join("/srv", "jobs");
    for (const bad of [".", "..", "../x", "a/b", "/abs", "", "x/.."]) expect(() => jobDirFor(jobs, bad), bad).toThrow(/bad_start_options/);
    expect(jobDirFor(jobs, RUN_ID)).toBe(path.join(jobs, RUN_ID));
  });
});

describe("sandbox block: the engine refuses to start an agent without the OS sandbox on", () => {
  it.each([
    ["an empty block", {}],
    ["enabled false", { enabled: false }],
    ["enabled as a string", { enabled: "true" }],
    ["a block with other keys but no enabled", { allowUnsandboxedCommands: false }],
    ["enabled with the unsandboxed escape open", { enabled: true, allowUnsandboxedCommands: true }],
  ])("%s is bad_start_options with zero spawns and no file written", async (_name, sandbox) => {
    const rig = makeRig({ sandbox });
    const before = listing(rig.root);
    await expect(engineFor(rig).start(rig.startOptions())).rejects.toMatchObject({ code: "bad_start_options" });
    expect(rig.spawns).toEqual([]);
    expect(listing(rig.root)).toEqual(before);
  });
});

describe("stop ends the whole process group", () => {
  it("a background process that ignores SIGTERM is killed after the grace period", async () => {
    const fake = makeFake();
    fake.set("hang", "1");
    fake.set("grandchild", "1");
    const rig = makeRig({ fake });
    rig.config.killGraceMs = 300;
    const engine = engineFor(rig);
    const { handle } = await engine.start(rig.startOptions());
    expect(await until(() => fake.grandchildPid() !== undefined)).toBe(true);
    const grandchild = fake.grandchildPid()!;
    expect(alive(grandchild)).toBe(true);
    try {
      await engine.stop(handle);
      expect(await until(() => !alive(grandchild), 3000)).toBe(true);
    } finally {
      if (alive(grandchild)) process.kill(grandchild, "SIGKILL");
    }
  }, 15_000);

  it("a credential mismatch ends the group too", async () => {
    const fake = makeFake({ stream: streamWith("ANTHROPIC_API_KEY") });
    fake.set("hang", "1");
    fake.set("grandchild", "1");
    const rig = makeRig({ fake });
    rig.config.killGraceMs = 300;
    const { handle } = await engineFor(rig).start(rig.startOptions());
    const outcome = await outcomeOf(handle);
    expect(outcome.failureReason).toBe("credential_mismatch");
    const grandchild = fake.grandchildPid()!;
    try {
      expect(await until(() => !alive(grandchild), 3000)).toBe(true);
    } finally {
      if (alive(grandchild)) process.kill(grandchild, "SIGKILL");
    }
  }, 15_000);
});
