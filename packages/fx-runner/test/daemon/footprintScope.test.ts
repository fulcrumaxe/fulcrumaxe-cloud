import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdmission } from "../../src/daemon/admission.js";
import type { Claimed } from "../../src/daemon/client.js";
import { DEFAULT_FOOTPRINT, FOOTPRINT_FILE, FOOTPRINT_VERSION, GIB, createFootprintStore } from "../../src/daemon/footprints.js";
import type { ResourceReading } from "../../src/daemon/resources.js";
import { runnerResetFootprintsCommand } from "../../src/commands/claiming.js";
import { DEFAULT_BUDGET, DEFAULT_SETTINGS } from "../../src/runnerSettings.js";
import { budgetsOf, createScopeLimits } from "../../src/sandbox/jobLimits.js";
import { signedJob } from "../helpers/signedJob.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fxfp-scope-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const idle = (over: Partial<ResourceReading> = {}): ResourceReading => ({ totalMemBytes: 16 * GIB, availMemBytes: 14 * GIB, load1: 0, cores: 16, freeDiskBytes: 100 * GIB, ...over });
const claimed = (role = "executor"): Claimed => {
  const signed = signedJob({ role, repo: { id: "11111111-1111-4111-8111-111111111111", owner: "acme", name: "widgets", private: true } } as never);
  return { kind: "claimed", signedJob: signed, runId: signed.job.run_id, leaseGeneration: 1 };
};
const samplesOf = (key: string): unknown => JSON.parse(readFileSync(path.join(dir, FOOTPRINT_FILE), "utf8")).entries[key];

function rig(scopePeak?: (runId: string) => number | undefined) {
  const state = { reading: idle(), tick: undefined as undefined | (() => void), released: [] as string[] };
  const admission = createAdmission({
    probe: { read: () => state.reading },
    footprints: createFootprintStore(dir),
    settings: () => ({ ...DEFAULT_SETTINGS }),
    paused: () => false,
    now: () => 1_000_000,
    every: (fn) => {
      state.tick = fn;
      return () => undefined;
    },
    ...(scopePeak === undefined ? {} : { scopePeak, releaseScope: (id: string) => state.released.push(id) }),
  });
  return { state, admission };
}

describe("a job's footprint is its own scope's peak", () => {
  it("records the scope peak, not the machine-wide drop, and an outside memory spike does not change it", () => {
    let peak = 0.5 * GIB;
    const r = rig(() => peak);
    const end = r.admission.begin(claimed());
    // Another build on the host takes 7 GB while the job uses 0.5 GB.
    r.state.reading = idle({ availMemBytes: 7 * GIB });
    r.state.tick!();
    peak = 1.2 * GIB;
    r.state.tick!();
    r.state.reading = idle({ availMemBytes: 14 * GIB });
    end();
    expect(JSON.parse(readFileSync(path.join(dir, FOOTPRINT_FILE), "utf8")).version).toBe(FOOTPRINT_VERSION);
    expect(samplesOf("acme/widgets|executor")).toEqual([Math.round(1.2 * GIB)]);
    expect(r.state.released).toHaveLength(1);
  });

  it("falls back to the machine drop when the scope cannot be read, or when there is no scope reader", () => {
    const r = rig(() => undefined);
    const end = r.admission.begin(claimed());
    r.state.reading = idle({ availMemBytes: 14 * GIB - 2 * GIB });
    r.state.tick!();
    end();
    expect(samplesOf("acme/widgets|executor")).toEqual([2 * GIB]);
    const none = rig();
    const endNone = none.admission.begin(claimed("docs-writer"));
    none.state.reading = idle({ availMemBytes: 13 * GIB });
    endNone();
    expect(samplesOf("acme/widgets|docs-writer")).toEqual([1 * GIB]);
  });

  it("once the scope has answered, an outside drop is never used, even if the scope later goes quiet", () => {
    let answer: number | undefined = 0.3 * GIB;
    const r = rig(() => answer);
    const end = r.admission.begin(claimed());
    r.state.tick!();
    answer = undefined;
    r.state.reading = idle({ availMemBytes: 2 * GIB });
    r.state.tick!();
    end();
    expect(samplesOf("acme/widgets|executor")).toEqual([Math.round(0.3 * GIB)]);
  });
});

describe("old samples are migrated away", () => {
  it("a version 1 file (machine-drop samples) is ignored: the estimate is the default and relearns from real peaks", () => {
    writeFileSync(path.join(dir, FOOTPRINT_FILE), JSON.stringify({ version: 1, entries: { "acme/widgets|executor": [9 * GIB, 9 * GIB, 9 * GIB] } }));
    const store = createFootprintStore(dir);
    expect(store.estimate("acme/widgets", "executor")).toEqual(DEFAULT_FOOTPRINT.heavy);
    expect(store.classEstimate("heavy")).toEqual(DEFAULT_FOOTPRINT.heavy);
    store.record("acme/widgets", "executor", 1 * GIB);
    expect(JSON.parse(readFileSync(path.join(dir, FOOTPRINT_FILE), "utf8")).version).toBe(FOOTPRINT_VERSION);
    expect(samplesOf("acme/widgets|executor")).toEqual([GIB]);
    // A file with no version at all is old too.
    writeFileSync(path.join(dir, FOOTPRINT_FILE), JSON.stringify({ entries: { "acme/widgets|executor": [9 * GIB] } }));
    expect(createFootprintStore(dir).classEstimate("heavy")).toEqual(DEFAULT_FOOTPRINT.heavy);
  });

  it("config reset footprints clears what was learned", () => {
    const store = createFootprintStore(dir);
    for (let i = 0; i < 5; i++) store.record("acme/widgets", "executor", 8 * GIB);
    expect(store.classEstimate("heavy").memBytes).toBeGreaterThan(DEFAULT_FOOTPRINT.heavy.memBytes);
    const out: string[] = [];
    expect(runnerResetFootprintsCommand({ stateDir: dir, out: (line: string) => out.push(line) } as never)).toBe(0);
    expect(existsSync(path.join(dir, FOOTPRINT_FILE))).toBe(false);
    expect(createFootprintStore(dir).classEstimate("heavy")).toEqual(DEFAULT_FOOTPRINT.heavy);
    expect(out.join("\n")).toMatch(/cleared/);
    // Nothing learned yet: still fine.
    expect(runnerResetFootprintsCommand({ stateDir: dir, out: () => undefined } as never)).toBe(0);
  });

  it("a stale heavy estimate no longer inflates the derived budget after migration", () => {
    writeFileSync(path.join(dir, FOOTPRINT_FILE), JSON.stringify({ version: 1, entries: { "acme/widgets|executor": Array(10).fill(9 * GIB) } }));
    const heavy = createFootprintStore(dir).classEstimate("heavy").memBytes;
    expect(heavy).toBe(DEFAULT_FOOTPRINT.heavy.memBytes);
    const settings = { ...DEFAULT_SETTINGS, budget: { light: { ...DEFAULT_BUDGET.light }, heavy: { ...DEFAULT_BUDGET.heavy } } };
    expect(budgetsOf(settings, heavy).heavy.memoryBytes).toBe(5 * GIB);
  });
});

describe("the scope limits read the job's own cgroup", () => {
  const RUN = "3f6c1a52-8d0e-4b7a-9c14-0a5e6d2b7f38";
  const TOOLS = { systemdRun: "/bin/systemd-run", systemctl: "/bin/systemctl", env: "/bin/env" };
  const CG = "/user.slice/user-1000.slice/user@1000.service/app.slice/fxr-test.scope";
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  function limits(files: Record<string, string>, control = `ControlGroup=${CG}\n`) {
    const shows: string[][] = [];
    const l = createScopeLimits({
      tools: TOOLS,
      runtimeDir: "/run/user/1000",
      budgets: () => budgetsOf({ ...DEFAULT_SETTINGS, budget: { light: { ...DEFAULT_BUDGET.light }, heavy: { ...DEFAULT_BUDGET.heavy } } }),
      capture: async (_cmd, args) => {
        shows.push([...args]);
        return { code: control === "" ? 1 : 0, stdout: control, timedOut: false };
      },
      cgroupRoot: "/cg",
      readText: (target) => files[target],
    });
    return { l, shows };
  }

  it("finds the scope's cgroup through systemctl, then reads memory.peak; the last figure outlives the cgroup", async () => {
    const files: Record<string, string> = {};
    const { l, shows } = limits(files);
    l.wrap({ runId: RUN, role: "executor" }, "/opt/claude", [], {});
    expect(l.peak?.(RUN)).toBeUndefined();
    await flush();
    expect(shows[0]).toEqual(["--user", "show", expect.stringMatching(/^fxr-.*\.scope$/), "-p", "ControlGroup"]);
    files[`/cg${CG}/memory.peak`] = "1500000000\n";
    expect(l.peak?.(RUN)).toBe(1500000000);
    files[`/cg${CG}/memory.peak`] = "900\n";
    expect(l.peak?.(RUN)).toBe(1500000000);
    delete files[`/cg${CG}/memory.peak`];
    expect(l.peak?.(RUN)).toBe(1500000000);
    l.release?.(RUN);
    expect(l.peak?.(RUN)).toBeUndefined();
  });

  it("uses memory.max_usage_in_bytes where memory.peak is missing, and answers undefined where nothing is readable", async () => {
    const { l } = limits({ [`/cg${CG}/memory.max_usage_in_bytes`]: "42" });
    l.wrap({ runId: RUN, role: "executor" }, "c", [], {});
    l.peak?.(RUN);
    await flush();
    expect(l.peak?.(RUN)).toBe(42);
    const none = limits({}, "");
    none.l.wrap({ runId: RUN, role: "executor" }, "c", [], {});
    none.l.peak?.(RUN);
    await flush();
    expect(none.l.peak?.(RUN)).toBeUndefined();
  });

  it("refuses a cgroup path that climbs out of the mount", async () => {
    const { l } = limits({ "/cg/a/../memory.peak": "7" }, "ControlGroup=/a/..\n");
    l.wrap({ runId: RUN, role: "executor" }, "c", [], {});
    l.peak?.(RUN);
    await flush();
    expect(l.peak?.(RUN)).toBeUndefined();
  });
});
