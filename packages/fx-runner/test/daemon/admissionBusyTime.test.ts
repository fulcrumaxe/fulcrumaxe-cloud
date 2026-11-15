import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdmission, cpuInUse, type Admission } from "../../src/daemon/admission.js";
import { GIB, createFootprintStore } from "../../src/daemon/footprints.js";
import { realResourceProbe, type ResourceReading } from "../../src/daemon/resources.js";
import { DEFAULT_SETTINGS, type RunnerSettings } from "../../src/runnerSettings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxreoffer-busy-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A 12-core, 32 GB machine with plenty of memory, so that only the CPU can hold a class back. */
const host = (over: Partial<ResourceReading> = {}): ResourceReading => ({ totalMemBytes: 32 * GIB, availMemBytes: 28 * GIB, load1: 0, load5: 0, cores: 12, freeDiskBytes: 100 * GIB, ...over });

function admit(reading: ResourceReading, settings: RunnerSettings = { ...DEFAULT_SETTINGS }): Admission {
  return createAdmission({ probe: { read: () => reading }, footprints: createFootprintStore(dir), settings: () => settings, paused: () => false, now: () => 1_000_000, every: () => () => undefined });
}

describe("admission judges the CPU by busy time", () => {
  it("an IO-bound but CPU-idle host (load 6.5 on 12 cores, 10% busy) admits a heavy job", () => {
    const snap = admit(host({ load1: 6.5, load5: 6.5, cpuBusyCores: 1.2 })).snapshot();
    expect(snap.free.heavy).toBeGreaterThan(0);
    expect(snap.limits.heavy).toBeNull();
  });

  it("the same load average with no busy-time reading is still held (the old behaviour)", () => {
    const snap = admit(host({ load1: 6.5, load5: 6.5 })).snapshot();
    expect(snap.free.heavy).toBe(1);
    expect(admit(host({ load1: 11, load5: 11 })).snapshot().free.heavy).toBe(0);
  });

  it("a CPU-bound host holds the heavy class back and names the CPU", () => {
    const snap = admit(host({ load1: 0, load5: 0, cpuBusyCores: 11 })).snapshot();
    expect(snap.free.heavy).toBe(0);
    expect(snap.limits.heavy).toBe("cpu");
  });

  it("the person's cpu-reserve is still applied on top of the busy cores", () => {
    const reading = host({ cpuBusyCores: 2 });
    // 12 - 2 busy - 2.4 default reserve = 7.6 cores: three heavy jobs of 2 cores; reserve 8 leaves 12 - 2 - 8 = 2 cores: one.
    expect(admit(reading).snapshot().free.heavy).toBe(3);
    expect(admit(reading, { ...DEFAULT_SETTINGS, cpuReserve: 8 }).snapshot().free.heavy).toBe(1);
  });

  it("cpuInUse is the busy cores when measured, else the sustained load", () => {
    expect(cpuInUse(host({ load1: 9, load5: 8, cpuBusyCores: 1 }))).toBe(1);
    expect(cpuInUse(host({ load1: 9, load5: 8 }))).toBe(8);
  });
});

describe("the real probe's busy-time reading", () => {
  /** Readings of [busy ms of all cores, wall clock ms]; `null` makes the CPU times unreadable. */
  const probeOver = (steps: Array<[number, number] | null>, platform: NodeJS.Platform = "linux") => {
    let i = 0;
    let at = 0;
    const next = (): [number, number] | null => steps[Math.min(i++, steps.length - 1)] ?? null;
    let current: [number, number] | null = null;
    return realResourceProbe({
      platform,
      diskPaths: [dir],
      cores: () => 4,
      cpuTimes: () => {
        current = next();
        if (current === null) throw new Error("unreadable");
        at = current[1];
        return [{ times: { user: current[0], nice: 0, sys: 0, irq: 0 } }];
      },
      nowMs: () => at,
    });
  };

  it("gives no busy figure on the first reading, then busy time over wall time", () => {
    const probe = probeOver([[0, 0], [2000, 1000]]);
    expect(probe.read().cpuBusyCores).toBeUndefined();
    expect(probe.read().cpuBusyCores).toBeCloseTo(2); // 2000 ms of CPU in 1000 ms: two cores
  });

  it("an idle machine reads near zero busy cores however high its load average", () => {
    const probe = probeOver([[0, 0], [50, 1000]]);
    probe.read();
    expect(probe.read().cpuBusyCores).toBeCloseTo(0.05);
  });

  it("never reports more busy cores than the machine has", () => {
    const probe = probeOver([[0, 0], [90_000, 1000]]);
    probe.read();
    expect(probe.read().cpuBusyCores).toBe(4);
  });

  it("a window too short to measure keeps the last good figure and the old sample", () => {
    const probe = probeOver([[0, 0], [1000, 1000], [1010, 1010], [3000, 2000]]);
    probe.read();
    const first = probe.read().cpuBusyCores;
    expect(first).toBeCloseTo(1);
    expect(probe.read().cpuBusyCores).toBe(first);
    expect(probe.read().cpuBusyCores).toBeCloseTo(2); // 2000 ms of CPU since the sample taken at 1000 ms
  });

  it("falls back to the load average when the CPU times are unreadable or the platform is not Linux", () => {
    const gone = probeOver([null, null]);
    expect(gone.read().cpuBusyCores).toBeUndefined();
    expect(gone.read().cpuBusyCores).toBeUndefined();
    const mac = probeOver([[0, 0], [2000, 1000]], "darwin");
    mac.read();
    const reading = mac.read();
    expect(reading.cpuBusyCores).toBeUndefined();
    expect(typeof reading.load1).toBe("number");
  });

  it("counters that go backwards start a new window instead of a negative figure", () => {
    const probe = probeOver([[5000, 0], [10, 1000], [1010, 2000]]);
    probe.read();
    expect(probe.read().cpuBusyCores).toBeUndefined();
    expect(probe.read().cpuBusyCores).toBeCloseTo(1);
  });
});
