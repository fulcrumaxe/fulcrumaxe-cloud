import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeHeld } from "../src/commands/run.js";
import { DEFAULT_FOOTPRINT, GIB, createFootprintStore } from "../src/daemon/footprints.js";
import { DEFAULT_SETTINGS, HEAVY_AUTO_FLOOR_GB, SETTINGS_FILE, loadSettings, setSetting, unsetSetting } from "../src/runnerSettings.js";
import { budgetsOf } from "../src/sandbox/jobLimits.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxreoffer-set-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("cpu-reserve", () => {
  it("is a whole number of cores from 0 to 256, saved, and auto (or unset) returns it to the default", () => {
    expect(loadSettings(dir).cpuReserve).toBeUndefined();
    expect(setSetting(dir, "cpu-reserve", "4")).toContain("applies from the next claim");
    expect(loadSettings(dir).cpuReserve).toBe(4);
    setSetting(dir, "cpu-reserve", "0");
    expect(loadSettings(dir).cpuReserve).toBe(0);
    setSetting(dir, "cpu-reserve", "256");
    expect(loadSettings(dir).cpuReserve).toBe(256);
    setSetting(dir, "cpu-reserve", "auto");
    expect(loadSettings(dir).cpuReserve).toBeUndefined();
    setSetting(dir, "cpu-reserve", "3");
    unsetSetting(dir, "cpu-reserve");
    expect(loadSettings(dir).cpuReserve).toBeUndefined();
  });

  it.each(["257", "-1", "2.5", "some", ""])("refuses %j and writes nothing", (value) => {
    expect(() => setSetting(dir, "cpu-reserve", value)).toThrow();
    expect(loadSettings(dir).cpuReserve).toBeUndefined();
  });
});

describe("the heavy memory budget is derived unless the person set one", () => {
  it("a fresh runner (nothing learned: the default 3 GB footprint) gets 1.5 times that, 5 GB, instead of the old fixed 6", () => {
    expect(budgetsOf(DEFAULT_SETTINGS, DEFAULT_FOOTPRINT.heavy.memBytes).heavy.memoryBytes).toBe(5 * GIB);
  });

  it("follows the learned footprint, with a floor and the settable maximum as its ends", () => {
    expect(budgetsOf(DEFAULT_SETTINGS, 1 * GIB).heavy.memoryBytes).toBe(HEAVY_AUTO_FLOOR_GB * GIB);
    expect(budgetsOf(DEFAULT_SETTINGS, 6 * GIB).heavy.memoryBytes).toBe(9 * GIB);
    expect(budgetsOf(DEFAULT_SETTINGS, 40 * GIB).heavy.memoryBytes).toBe(32 * GIB);
  });

  it("a derived budget is held to half the RAM: a huge learned footprint gives 8 GB on a 16 GB host and 3 GB on a 6 GB host; a set figure is untouched", () => {
    expect(budgetsOf(DEFAULT_SETTINGS, 40 * GIB, 16 * GIB).heavy.memoryBytes).toBe(8 * GIB);
    expect(budgetsOf(DEFAULT_SETTINGS, 40 * GIB, 6 * GIB).heavy.memoryBytes).toBe(3 * GIB);
    expect(budgetsOf(DEFAULT_SETTINGS, 1 * GIB, 6 * GIB).heavy.memoryBytes).toBe(3 * GIB);
    expect(budgetsOf(DEFAULT_SETTINGS, 1 * GIB, 3 * GIB).heavy.memoryBytes).toBe(2 * GIB);
    expect(budgetsOf(DEFAULT_SETTINGS, 1 * GIB, 64 * GIB).heavy.memoryBytes).toBe(HEAVY_AUTO_FLOOR_GB * GIB);
    expect(budgetsOf({ ...DEFAULT_SETTINGS, heavyMemorySet: true, budget: { ...DEFAULT_SETTINGS.budget, heavy: { memoryGb: 12, tasks: 4096 } } }, 40 * GIB, 16 * GIB).heavy.memoryBytes).toBe(12 * GIB);
  });

  it("measured peaks recorded by finished heavy jobs move the budget through the footprint store", () => {
    const store = createFootprintStore(dir);
    const before = budgetsOf(DEFAULT_SETTINGS, store.classEstimate("heavy").memBytes).heavy.memoryBytes;
    for (let i = 0; i < 10; i++) store.record("acme/widgets", "executor", 8 * GIB);
    const after = budgetsOf(DEFAULT_SETTINGS, store.classEstimate("heavy").memBytes).heavy.memoryBytes;
    expect(after).toBeGreaterThan(before);
  });

  it("the person's own figure always wins, and unsetting it returns to the derived one; the file holds the figure only while it is set", () => {
    setSetting(dir, "budget.heavy.memory", "12");
    expect(budgetsOf(loadSettings(dir), 1 * GIB).heavy.memoryBytes).toBe(12 * GIB);
    expect(readFileSync(path.join(dir, SETTINGS_FILE), "utf8")).toContain('"memoryGb":12');
    unsetSetting(dir, "budget.heavy.memory");
    expect(budgetsOf(loadSettings(dir), 1 * GIB).heavy.memoryBytes).toBe(HEAVY_AUTO_FLOOR_GB * GIB);
    expect(readFileSync(path.join(dir, SETTINGS_FILE), "utf8")).not.toContain('"memoryGb":12');
  });

  it("changing another setting does not turn the derived heavy budget into a set one", () => {
    setSetting(dir, "concurrency.total", "3");
    expect(loadSettings(dir).heavyMemorySet).toBeUndefined();
    expect(readFileSync(path.join(dir, SETTINGS_FILE), "utf8")).not.toContain("memoryGb\":6");
  });

  it("without a learned figure to pass (a caller that has none), the setting's own number is used as before", () => {
    expect(budgetsOf(DEFAULT_SETTINGS).heavy.memoryBytes).toBe(6 * GIB);
  });
});

describe("the journal words for what is held back", () => {
  it("names the class and the cause", () => {
    expect(describeHeld(null, "memory")).toBe("holding back heavy jobs (reviews and builds): memory is short; light jobs are still taken");
    expect(describeHeld("cpu", "cpu")).toBe("holding back all new jobs: the CPU is busy");
    expect(describeHeld("ceiling", "memory")).toBe("holding back all new jobs: at the job limit (heavy jobs: memory is short)");
    expect(describeHeld("disk", null)).toBe("holding back light jobs: disk space is low");
    expect(describeHeld(null, null)).toBe("taking all kinds of jobs again");
  });
});
