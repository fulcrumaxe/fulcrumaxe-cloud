import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdmission, type Admission } from "../../src/daemon/admission.js";
import type { Claimed } from "../../src/daemon/client.js";
import { DEFAULT_FOOTPRINT, FOOTPRINT_FILE, GIB, createFootprintStore, p90 } from "../../src/daemon/footprints.js";
import { parseVmStat, realResourceProbe, type ResourceReading } from "../../src/daemon/resources.js";
import { DEFAULT_SETTINGS, type RunnerSettings } from "../../src/runnerSettings.js";
import { signedJob } from "../helpers/signedJob.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxc434-adm-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A 16 GB, 16-core machine, idle, with plenty of disk: reserve 4 GB. */
const idle = (over: Partial<ResourceReading> = {}): ResourceReading => ({ totalMemBytes: 16 * GIB, availMemBytes: 14 * GIB, load1: 0, cores: 16, freeDiskBytes: 100 * GIB, ...over });

interface Rig {
  admission: Admission;
  reading: ResourceReading;
  settings: RunnerSettings;
  paused: { value: boolean };
  clock: { ms: number };
  samplers: Array<() => void>;
}

function rig(over: Partial<ResourceReading> = {}): Rig {
  const state: Rig = { reading: idle(over), settings: { ...DEFAULT_SETTINGS }, paused: { value: false }, clock: { ms: 1_000_000 }, samplers: [], admission: undefined as never };
  state.admission = createAdmission({
    probe: { read: () => state.reading },
    footprints: createFootprintStore(dir),
    settings: () => state.settings,
    paused: () => state.paused.value,
    now: () => state.clock.ms,
    every: (fn) => {
      state.samplers.push(fn);
      return () => undefined;
    },
  });
  return state;
}

const claimed = (role: string, repoName = "widgets"): Claimed => {
  const signed = signedJob({ role, repo: { id: "11111111-1111-4111-8111-111111111111", owner: "acme", name: repoName, private: true } } as never);
  return { kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 };
};

describe("admission by headroom (fake resource probe)", () => {
  it("an idle machine offers slots for both classes, bounded by the ceilings", () => {
    const r = rig();
    const snap = r.admission.snapshot();
    // 14 GB free minus a 4 GB reserve = 10 GB: 10 light jobs by memory, 3 heavy ones; the total ceiling is 8 and the heavy ceiling 4.
    expect(snap.free).toEqual({ light: 8, heavy: 3 });
    expect(snap.capacity).toEqual({ light: { limit: 8, in_use: 0 }, heavy: { limit: 3, in_use: 0 }, limited_by: null });
  });

  it("with headroom for two heavy jobs, a third is not offered a slot; the reason is memory", () => {
    const r = rig({ availMemBytes: 4 * GIB + 6.5 * GIB });
    expect(r.admission.snapshot().free.heavy).toBe(2);
    r.admission.begin(claimed("executor"));
    expect(r.admission.snapshot().free.heavy).toBe(1);
    r.admission.begin(claimed("executor"));
    // The probe still shows the same free memory (the jobs have not grown yet), but their footprints are held back while they start up.
    const snap = r.admission.snapshot();
    expect(snap.free).toEqual({ light: 0, heavy: 0 });
    expect(snap.capacity.heavy).toEqual({ limit: 2, in_use: 2 });
    expect(snap.limitedBy).toBe("memory");
    expect(snap.capacity.limited_by).toBe("memory");
  });

  it("once the jobs are past their start-up ramp, what they really use is in the reading", () => {
    const r = rig({ availMemBytes: 4 * GIB + 6.5 * GIB });
    r.admission.begin(claimed("executor"));
    r.admission.begin(claimed("executor"));
    expect(r.admission.snapshot().free.heavy).toBe(0);
    r.clock.ms += 120_000;
    r.reading = idle({ availMemBytes: 4 * GIB + 0.5 * GIB });
    expect(r.admission.snapshot().free.heavy).toBe(0);
    r.reading = idle({ availMemBytes: 4 * GIB + 3.5 * GIB });
    expect(r.admission.snapshot().free.heavy).toBe(1);
  });

  it("a reserve breach mid-run stops new slots and touches no job in hand", () => {
    const r = rig();
    const ends = [r.admission.begin(claimed("code-reviewer")), r.admission.begin(claimed("code-reviewer"))];
    expect(r.admission.snapshot().free.light).toBeGreaterThan(0);
    r.clock.ms += 120_000;
    // The person starts heavy work: available memory falls below the reserve.
    r.reading = idle({ availMemBytes: 3 * GIB });
    const snap = r.admission.snapshot();
    expect(snap.free).toEqual({ light: 0, heavy: 0 });
    expect(snap.limitedBy).toBe("memory");
    // The two jobs are still counted in hand: the admission object has no way to stop one, and its answer still shows them.
    expect(snap.capacity.light.in_use).toBe(2);
    expect(snap.capacity.light.limit).toBe(2);
    for (const end of ends) end();
    expect(r.admission.snapshot().capacity.light.in_use).toBe(0);
  });

  it("the reserve is 25% of RAM with a 2 GB minimum, or the person's setting", () => {
    const small = rig({ totalMemBytes: 4 * GIB, availMemBytes: 4 * GIB });
    // 4 GB machine: 25% is 1 GB, so the 2 GB minimum holds: 2 GB left, two light jobs and no heavy one.
    expect(small.admission.snapshot().free).toEqual({ light: 2, heavy: 0 });
    const set = rig({ availMemBytes: 14 * GIB });
    set.settings = { ...DEFAULT_SETTINGS, reserveGb: 12 };
    expect(set.admission.snapshot().free).toEqual({ light: 2, heavy: 0 });
  });

  it("CPU: a busy machine takes no job, and the cores of jobs still starting count", () => {
    const busy = rig({ load1: 13 });
    busy.admission.begin(claimed("code-reviewer"));
    expect(busy.admission.snapshot()).toMatchObject({ free: { light: 0, heavy: 0 }, limitedBy: "cpu" });
    // 16 cores x 0.8 = 12.8; load 10.5 leaves 2.3 cores: one heavy job (2 cores), then none.
    const r = rig({ load1: 10.5 });
    expect(r.admission.snapshot().free.heavy).toBe(1);
    r.admission.begin(claimed("executor"));
    expect(r.admission.snapshot().free.heavy).toBe(0);
  });

  it("disk: low free space on the workspace volume takes no job", () => {
    const r = rig({ freeDiskBytes: 1 * GIB });
    expect(r.admission.snapshot()).toMatchObject({ free: { light: 0, heavy: 0 }, limitedBy: "disk" });
  });

  it("paused by the person: no slots, the reason is paused, and resume restores them", () => {
    const r = rig();
    r.paused.value = true;
    expect(r.admission.snapshot()).toMatchObject({ free: { light: 0, heavy: 0 }, limitedBy: "paused" });
    r.paused.value = false;
    expect(r.admission.snapshot().limitedBy).toBeNull();
  });

  it("ceilings: the person can lower the total and the heavy maximum; the reason is ceiling", () => {
    const r = rig();
    r.settings = { ceilingTotal: 2, ceilingHeavy: 1 };
    r.admission.begin(claimed("executor"));
    // Heavy is at its ceiling but a light job still fits: nothing is "limited" yet.
    expect(r.admission.snapshot()).toMatchObject({ free: { light: 1, heavy: 0 }, limitedBy: null });
    r.admission.begin(claimed("code-reviewer"));
    expect(r.admission.snapshot()).toMatchObject({ free: { light: 0, heavy: 0 }, limitedBy: "ceiling" });
  });

  it("a ceiling lowered below what is in hand stops new slots and ends nothing", () => {
    const r = rig();
    r.admission.begin(claimed("code-reviewer"));
    r.admission.begin(claimed("code-reviewer"));
    r.settings = { ceilingTotal: 1, ceilingHeavy: 1 };
    const snap = r.admission.snapshot();
    expect(snap.free).toEqual({ light: 0, heavy: 0 });
    expect(snap.capacity.light.in_use).toBe(2);
  });

  it("the class comes from the signed role; a role the table lacks is heavy", () => {
    const r = rig();
    expect(r.admission.classOf(claimed("code-reviewer"))).toBe("light");
    expect(r.admission.classOf(claimed("acceptance-tester"))).toBe("heavy");
    // A role the protocol does not know cannot be signed, so it is built by hand: only the class table is under test.
    expect(r.admission.classOf({ signedJob: { job: { role: "some-new-role" } } } as unknown as Claimed)).toBe("heavy");
  });
});

describe("the progress floor", () => {
  it("tight memory and nothing in hand: exactly one light slot, no heavy, and no reason given", () => {
    const r = rig({ availMemBytes: 1 * GIB });
    const snap = r.admission.snapshot();
    expect(snap.free).toEqual({ light: 1, heavy: 0 });
    expect(snap.capacity).toEqual({ light: { limit: 1, in_use: 0 }, heavy: { limit: 0, in_use: 0 }, limited_by: null });
  });

  it("tight memory and one job in hand: no slot, and memory is the reason", () => {
    const r = rig({ availMemBytes: 1 * GIB });
    r.admission.begin(claimed("code-reviewer"));
    expect(r.admission.snapshot()).toMatchObject({ free: { light: 0, heavy: 0 }, limitedBy: "memory" });
  });

  it("a busy CPU with nothing in hand gets the floor too", () => {
    expect(rig({ load1: 15 }).admission.snapshot().free).toEqual({ light: 1, heavy: 0 });
  });

  it("low disk blocks it completely, and so does a pause", () => {
    expect(rig({ availMemBytes: 1 * GIB, freeDiskBytes: 1 * GIB }).admission.snapshot()).toMatchObject({ free: { light: 0, heavy: 0 }, limitedBy: "disk" });
    const r = rig({ availMemBytes: 1 * GIB });
    r.paused.value = true;
    expect(r.admission.snapshot()).toMatchObject({ free: { light: 0, heavy: 0 }, limitedBy: "paused" });
  });

  it("when the headroom is there the floor changes nothing", () => {
    expect(rig().admission.snapshot().free).toEqual({ light: 8, heavy: 3 });
  });
});

describe("footprint learning", () => {
  it("starts at the defaults and moves toward the measured peaks as jobs finish", () => {
    const store = createFootprintStore(dir);
    expect(store.estimate("acme/widgets", "executor")).toEqual(DEFAULT_FOOTPRINT.heavy);
    const seen: number[] = [store.estimate("acme/widgets", "executor").memBytes];
    for (let i = 0; i < 6; i++) {
      store.record("acme/widgets", "executor", 5 * GIB);
      seen.push(store.estimate("acme/widgets", "executor").memBytes);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    expect(seen.at(-1)!).toBeGreaterThan(4.4 * GIB);
    expect(seen.at(-1)!).toBeLessThanOrEqual(5 * GIB);
    // Per repo and role: another repo and another role are untouched.
    expect(store.estimate("acme/other", "executor")).toEqual(DEFAULT_FOOTPRINT.heavy);
    expect(store.estimate("acme/widgets", "code-reviewer")).toEqual(DEFAULT_FOOTPRINT.light);
  });

  it("the estimate follows the p90, not the mean or the maximum", () => {
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])).toBe(9);
    const store = createFootprintStore(dir);
    for (const peak of [1, 1, 1, 1, 1, 1, 1, 1, 1, 30]) store.record("acme/widgets", "executor", peak * GIB);
    // Nine of ten samples are 1 GB: the outlier does not set the estimate.
    expect(store.estimate("acme/widgets", "executor").memBytes).toBeLessThan(3 * GIB);
  });

  it("is stored locally in the state directory, survives a new store, and is private", () => {
    createFootprintStore(dir).record("acme/widgets", "executor", 5 * GIB);
    expect(createFootprintStore(dir).estimate("acme/widgets", "executor").memBytes).toBeGreaterThan(DEFAULT_FOOTPRINT.heavy.memBytes);
    expect(lstatSync(path.join(dir, FOOTPRINT_FILE)).mode & 0o777).toBe(0o600);
  });

  it("a damaged file counts as none; a link in its place is never read or written through", () => {
    writeFileSync(path.join(dir, FOOTPRINT_FILE), "{ not json");
    expect(createFootprintStore(dir).estimate("acme/widgets", "executor")).toEqual(DEFAULT_FOOTPRINT.heavy);
    rmSync(path.join(dir, FOOTPRINT_FILE));
    const outside = path.join(dir, "outside.json");
    writeFileSync(outside, JSON.stringify({ version: 1, entries: { "acme/widgets|executor": [20 * GIB, 20 * GIB, 20 * GIB] } }));
    symlinkSync(outside, path.join(dir, FOOTPRINT_FILE));
    const store = createFootprintStore(dir);
    expect(store.estimate("acme/widgets", "executor")).toEqual(DEFAULT_FOOTPRINT.heavy);
    store.record("acme/widgets", "executor", 2 * GIB);
    // The link was replaced by a plain file; the file it pointed at is unchanged.
    expect(lstatSync(path.join(dir, FOOTPRINT_FILE)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(outside, "utf8")).entries["acme/widgets|executor"]).toHaveLength(3);
  });

  it("a finished job's measured peak is recorded, and the class estimate then admits by it", () => {
    const r = rig({ availMemBytes: 14 * GIB });
    const end = r.admission.begin(claimed("executor"));
    r.reading = idle({ availMemBytes: 14 * GIB - 6 * GIB });
    r.samplers[0]!();
    end();
    const store = createFootprintStore(dir);
    expect(store.estimate("acme/widgets", "executor").memBytes).toBeGreaterThan(DEFAULT_FOOTPRINT.heavy.memBytes);
    expect(store.classEstimate("heavy").memBytes).toBe(store.estimate("acme/widgets", "executor").memBytes);
    // Heavier than the default 3 GB: a machine with 6.5 GB of headroom now fits one heavy job, not two.
    r.reading = idle({ availMemBytes: 4 * GIB + 6.5 * GIB });
    expect(r.admission.snapshot().free.heavy).toBe(1);
  });
});

describe("reading the machine", () => {
  it("the macOS pages from vm_stat: free + inactive + speculative", () => {
    const vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               1000.\nPages active:                             5000.\nPages inactive:                           2000.\nPages speculative:                         500.\n";
    expect(parseVmStat(vm)).toBe(3500 * 16384);
    expect(parseVmStat("nothing")).toBeUndefined();
  });

  it("the real probe returns sane numbers on this machine, and macOS uses the supplied vm_stat text", () => {
    const real = realResourceProbe({ platform: process.platform, diskPaths: [path.join(dir, "not", "made", "yet")] }).read();
    expect(real.totalMemBytes).toBeGreaterThan(real.availMemBytes);
    expect(real.availMemBytes).toBeGreaterThan(0);
    expect(real.cores).toBeGreaterThanOrEqual(1);
    expect(real.load1).toBeGreaterThanOrEqual(0);
    // A directory that does not exist yet is judged by the volume it will be made on.
    expect(real.freeDiskBytes).toBeGreaterThan(0);
    const vm = "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nPages inactive: 5.\nPages speculative: 1.\n";
    expect(realResourceProbe({ platform: "darwin", diskPaths: [], vmStatText: () => vm }).read().availMemBytes).toBe(16 * 4096);
    expect(realResourceProbe({ platform: "darwin", diskPaths: [], vmStatText: () => undefined }).read().availMemBytes).toBeGreaterThan(0);
  });
});
