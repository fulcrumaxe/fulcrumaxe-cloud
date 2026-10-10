import { existsSync, lstatSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PAUSE_FILE, SETTINGS_FILE, isPaused, loadSettings } from "../../src/runnerSettings.js";
import { useRig } from "./harness.js";

const rig = useRig();

describe("fx-runner pause and resume (D#6 C43-4)", () => {
  it("pause writes a private marker the daemon looks for; resume removes it; both are idempotent", async () => {
    expect(isPaused(rig.dir)).toBe(false);
    const paused = await rig.run(["pause"]);
    expect(paused.code).toBe(0);
    expect(paused.out).toContain("Claiming paused");
    expect(isPaused(rig.dir)).toBe(true);
    expect(lstatSync(path.join(rig.dir, PAUSE_FILE)).mode & 0o777).toBe(0o600);
    expect((await rig.run(["pause"])).out).toContain("already paused");
    const resumed = await rig.run(["resume"]);
    expect(resumed.code).toBe(0);
    expect(isPaused(rig.dir)).toBe(false);
    expect((await rig.run(["resume"])).out).toContain("not paused");
  });

  it("status says so while claiming is paused, with the ceilings", async () => {
    await rig.register("subscription");
    expect((await rig.run(["status"])).out).toContain("Claiming:        on (at most 8 jobs, 4 heavy)");
    await rig.run(["pause"]);
    expect((await rig.run(["status"])).out).toContain("paused by you; run: fx-runner resume");
  });

  it("takes no argument", async () => {
    const result = await rig.run(["pause", "now"]);
    expect(result.code).toBe(2);
    expect(isPaused(rig.dir)).toBe(false);
  });
});

describe("config set concurrency (D#6 C43-4)", () => {
  it("lowers the ceilings, saved privately, applying from the next claim", async () => {
    expect((await rig.run(["config", "set", "concurrency.total", "3"])).out).toContain("applies from the next claim");
    expect((await rig.run(["config", "set", "concurrency.heavy", "2"])).code).toBe(0);
    expect((await rig.run(["config", "set", "reserve-gb", "6"])).code).toBe(0);
    expect(loadSettings(rig.dir)).toEqual({ ceilingTotal: 3, ceilingHeavy: 2, reserveGb: 6 });
    expect(lstatSync(path.join(rig.dir, SETTINGS_FILE)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["concurrency.total", "9"],
    ["concurrency.total", "0"],
    ["concurrency.heavy", "5"],
    ["concurrency.heavy", "-1"],
    ["concurrency.heavy", "2.5"],
    ["concurrency.heavy", "many"],
    ["reserve-gb", "0"],
  ])("refuses %s %s with a message and writes nothing", async (key, value) => {
    const result = await rig.run(["config", "set", key, value]);
    expect(result.code).toBe(2);
    expect(result.err).toContain(`${key} takes a whole number from`);
    expect(existsSync(path.join(rig.dir, SETTINGS_FILE))).toBe(false);
  });

  it("config unset returns each setting to its automatic default, and reserve-gb auto does the same", async () => {
    await rig.run(["config", "set", "concurrency.total", "3"]);
    await rig.run(["config", "set", "concurrency.heavy", "2"]);
    await rig.run(["config", "set", "reserve-gb", "6"]);
    expect((await rig.run(["config", "unset", "concurrency.total"])).out).toContain("back to automatic");
    expect(loadSettings(rig.dir)).toEqual({ ceilingTotal: 8, ceilingHeavy: 2, reserveGb: 6 });
    expect((await rig.run(["config", "unset", "concurrency.heavy"])).code).toBe(0);
    expect(loadSettings(rig.dir)).toEqual({ ceilingTotal: 8, ceilingHeavy: 4, reserveGb: 6 });
    expect((await rig.run(["config", "unset", "reserve-gb"])).code).toBe(0);
    expect(loadSettings(rig.dir)).toEqual({ ceilingTotal: 8, ceilingHeavy: 4 });
    await rig.run(["config", "set", "reserve-gb", "6"]);
    expect((await rig.run(["config", "set", "reserve-gb", "auto"])).code).toBe(0);
    expect(loadSettings(rig.dir).reserveGb).toBeUndefined();
    // "auto" belongs to the reserve only.
    expect((await rig.run(["config", "set", "concurrency.total", "auto"])).code).toBe(2);
    // An unset of a key that is not a runner setting is not taken for one.
    expect((await rig.run(["config", "unset", "whatever"])).code).not.toBe(0);
  });

  it("a settings file over 64 KB counts as none", async () => {
    await rig.run(["pause"]);
    writeFileSync(path.join(rig.dir, SETTINGS_FILE), JSON.stringify({ ceilingTotal: 2, pad: "x".repeat(70_000) }));
    expect(loadSettings(rig.dir)).toEqual({ ceilingTotal: 8, ceilingHeavy: 4 });
  });

  it("a value is needed", async () => {
    const result = await rig.run(["config", "set", "concurrency.total"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("usage: fx-runner config set concurrency.total");
  });

  it("a damaged settings file means the defaults, and a hand-edited bad number is ignored", async () => {
    await rig.run(["pause"]); // makes the state directory
    writeFileSync(path.join(rig.dir, SETTINGS_FILE), "{ nope");
    expect(loadSettings(rig.dir)).toEqual({ ceilingTotal: 8, ceilingHeavy: 4 });
    // Out-of-range numbers in a hand-edited file are ignored one by one, not trusted.
    writeFileSync(path.join(rig.dir, SETTINGS_FILE), JSON.stringify({ ceilingTotal: 99, ceilingHeavy: 2 }));
    expect(loadSettings(rig.dir)).toEqual({ ceilingTotal: 8, ceilingHeavy: 2 });
  });

  it("the help text names the new commands", async () => {
    const help = (await rig.run(["--help"])).out;
    expect(help).toContain("pause | resume");
    expect(help).toContain("config set concurrency.total");
  });
});
