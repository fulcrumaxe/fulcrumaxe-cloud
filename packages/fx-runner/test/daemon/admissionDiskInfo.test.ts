import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeHeld } from "../../src/commands/run.js";
import { createAdmission, cpuContextOf, waitingLoadOf, type Admission } from "../../src/daemon/admission.js";
import { GIB, createFootprintStore } from "../../src/daemon/footprints.js";
import type { ResourceReading } from "../../src/daemon/resources.js";
import { DEFAULT_SETTINGS, type RunnerSettings } from "../../src/runnerSettings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxreoffer-diskinfo-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A 12-core, 32 GB machine with plenty of memory, so that only the CPU can hold a class back. */
const host = (over: Partial<ResourceReading> = {}): ResourceReading => ({ totalMemBytes: 32 * GIB, availMemBytes: 28 * GIB, load1: 0, load5: 0, cores: 12, freeDiskBytes: 100 * GIB, ...over });

function admit(reading: ResourceReading, settings: RunnerSettings = { ...DEFAULT_SETTINGS }): Admission {
  return createAdmission({ probe: { read: () => reading }, footprints: createFootprintStore(dir), settings: () => settings, paused: () => false, now: () => 1_000_000, every: () => () => undefined });
}

describe("disk busyness is information, never a hold", () => {
  // The person keeps 11 of 12 cores, so the heavy class is held for CPU although the cores are mostly idle and the load is high from disk wait.
  const held = (over: Partial<ResourceReading>) => admit(host({ load1: 6.5, load5: 6.5, ...over }), { ...DEFAULT_SETTINGS, cpuReserve: 11 }).snapshot();

  it("waiting load is the load beyond the busy cores, and only with a busy-time reading", () => {
    expect(waitingLoadOf(host({ load1: 6.5, load5: 6.5, cpuBusyCores: 1.5 }))).toBeCloseTo(5);
    expect(waitingLoadOf(host({ load1: 6.5, load5: 6.5 }))).toBeUndefined();
    expect(waitingLoadOf(host({ load1: 1, load5: 1, cpuBusyCores: 4 }))).toBe(0);
  });

  it("a busy disk beside idle cores is reported as such and changes no admission count", () => {
    const calm = admit(host({ load1: 0, load5: 0, cpuBusyCores: 1.2 })).snapshot();
    const io = admit(host({ load1: 6.5, load5: 6.5, cpuBusyCores: 1.2 })).snapshot();
    expect(io.cpu).toEqual({ low: true, ioHigh: true });
    expect(calm.cpu).toEqual({ low: true, ioHigh: false });
    expect(io.free).toEqual(calm.free);
    expect(io.limits).toEqual(calm.limits);
  });

  it("a CPU hold with low measured CPU use does not say the CPU is busy, and mentions the disk as information", () => {
    const snap = held({ cpuBusyCores: 1.2 });
    expect(snap.limits.heavy).toBe("cpu");
    const line = describeHeld(snap.limits.light, snap.limits.heavy, false, snap.cpu);
    expect(line).not.toContain("the CPU is busy");
    expect(line).toContain("heavy jobs");
    expect(line).toContain("(disk is busy, informational)");
  });

  it("without a busy disk the wording drops the disk note, and a really busy CPU still says so", () => {
    const quiet = held({ load1: 0, load5: 0, cpuBusyCores: 0.4 });
    const line = describeHeld(quiet.limits.light, quiet.limits.heavy, false, quiet.cpu);
    expect(line).not.toContain("disk");
    expect(line).not.toContain("the CPU is busy");
    const busy = admit(host({ cpuBusyCores: 11 })).snapshot();
    expect(describeHeld(busy.limits.light, busy.limits.heavy, false, busy.cpu)).toContain("the CPU is busy");
    // The load-average fallback has no busy figure: the old wording.
    expect(describeHeld("cpu", "cpu", false, cpuContextOf(host({ load1: 14, load5: 14 })))).toBe("holding back all new jobs: the CPU is busy");
  });
});
