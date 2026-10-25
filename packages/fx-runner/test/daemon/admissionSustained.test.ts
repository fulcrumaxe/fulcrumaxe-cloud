import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdmission, cpuReserveOf, sustainedLoad, DEFAULT_ADMISSION, type Admission } from "../../src/daemon/admission.js";
import { GIB, createFootprintStore } from "../../src/daemon/footprints.js";
import type { ResourceReading } from "../../src/daemon/resources.js";
import { DEFAULT_SETTINGS, type RunnerSettings } from "../../src/runnerSettings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxreoffer-adm-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A 12-core, 32 GB machine with plenty of free memory, so that only the CPU can hold a class back. */
const host = (over: Partial<ResourceReading> = {}): ResourceReading => ({ totalMemBytes: 32 * GIB, availMemBytes: 28 * GIB, load1: 0, load5: 0, cores: 12, freeDiskBytes: 100 * GIB, ...over });

function rig(reading: ResourceReading, settings: RunnerSettings = { ...DEFAULT_SETTINGS }): { admission: Admission; reading: ResourceReading; settings: RunnerSettings } {
  const state = { reading, settings, admission: undefined as never as Admission };
  state.admission = createAdmission({ probe: { read: () => state.reading }, footprints: createFootprintStore(dir), settings: () => state.settings, paused: () => false, now: () => 1_000_000, every: () => () => undefined });
  return state;
}

describe("the CPU gate uses the sustained load", () => {
  it("is the smaller of the 1-minute and 5-minute averages, and the 1-minute one when a reading has no 5-minute figure", () => {
    expect(sustainedLoad(host({ load1: 35, load5: 3 }))).toBe(3);
    expect(sustainedLoad(host({ load1: 1, load5: 9 }))).toBe(1);
    const bare = host({ load1: 4 });
    delete bare.load5;
    expect(sustainedLoad(bare)).toBe(4);
  });

  it("a brief spike (1-minute load 35, 5-minute load 3) does not zero the heavy class", () => {
    const r = rig(host({ load1: 35, load5: 3 }));
    // 12 cores keep 20% (2.4) free: 12 - 2.4 - 3 = 6.6 cores, 3 heavy jobs of 2 cores each.
    expect(r.admission.snapshot().free.heavy).toBe(3);
  });

  it("a load that is high on both averages holds the heavy class back and names the CPU", () => {
    const r = rig(host({ load1: 14, load5: 12 }));
    const snap = r.admission.snapshot();
    expect(snap.free.heavy).toBe(0);
    expect(snap.limits.heavy).toBe("cpu");
    // Nothing in hand, so the progress floor still admits one light job.
    expect(snap.free.light).toBe(1);
  });

  it("the old threshold is unchanged for a steady load: load 4 on 12 cores leaves the same headroom as 0.8 per core did", () => {
    const r = rig(host({ load1: 4, load5: 4 }));
    // 12 * 0.8 - 4 = 5.6 cores: two heavy jobs.
    expect(r.admission.snapshot().free.heavy).toBe(2);
  });
});

describe("cpu-reserve", () => {
  it("defaults to 20% of the cores and is replaced by the person's whole number of cores", () => {
    expect(cpuReserveOf(host(), DEFAULT_ADMISSION, DEFAULT_SETTINGS)).toBeCloseTo(2.4);
    expect(cpuReserveOf(host(), DEFAULT_ADMISSION, { ...DEFAULT_SETTINGS, cpuReserve: 5 })).toBe(5);
  });

  it("a larger reserve admits fewer heavy jobs, a smaller one more, and 0 lets the whole machine be used", () => {
    const steady = host({ load1: 2, load5: 2 });
    expect(rig(steady).admission.snapshot().free.heavy).toBe(3); // 12 - 2.4 - 2 = 7.6 -> 3
    expect(rig(steady, { ...DEFAULT_SETTINGS, cpuReserve: 8 }).admission.snapshot().free.heavy).toBe(1); // 12 - 8 - 2 = 2 -> 1
    expect(rig(steady, { ...DEFAULT_SETTINGS, cpuReserve: 0 }).admission.snapshot().free.heavy).toBe(4); // 12 - 0 - 2 = 10 -> 5, held to the heavy ceiling of 4
  });
});

describe("the capacity a claim reports names why the heavy class has no slot", () => {
  it("light has room, heavy does not: limited_by is the heavy reason (memory here), while the machine-wide limitedBy stays null", () => {
    // 16 GB, 25% reserve = 4 GB; 6 GB free leaves 2 GB: light fits (1 GB each), heavy (3 GB) does not.
    const r = rig(host({ totalMemBytes: 16 * GIB, availMemBytes: 6 * GIB }));
    const snap = r.admission.snapshot();
    expect(snap.free.light).toBeGreaterThan(0);
    expect(snap.free.heavy).toBe(0);
    expect(snap.capacity.limited_by).toBe("memory");
    expect(snap.limitedBy).toBeNull();
    expect(snap.limits).toEqual({ light: null, heavy: "memory" });
  });

  it("nothing held back: no reason anywhere", () => {
    const snap = rig(host()).admission.snapshot();
    expect(snap.capacity.limited_by).toBeNull();
    expect(snap.limits).toEqual({ light: null, heavy: null });
  });
});
