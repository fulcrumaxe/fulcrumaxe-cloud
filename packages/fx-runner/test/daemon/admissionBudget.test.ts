import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdmission } from "../../src/daemon/admission.js";
import { GIB, createFootprintStore } from "../../src/daemon/footprints.js";
import type { ResourceReading } from "../../src/daemon/resources.js";
import { DEFAULT_SETTINGS } from "../../src/runnerSettings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "c435-adm-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A 64 GB, 16-core idle machine with a 1 GB reserve set by the person, so the memory headroom is the available memory minus 1 GB. */
function rig(availGb: number, heavyBudgetGb: number) {
  const reading: ResourceReading = { totalMemBytes: 64 * GIB, availMemBytes: availGb * GIB, load1: 0, cores: 16, freeDiskBytes: 100 * GIB };
  const state = { heavyBudgetGb };
  const admission = createAdmission({
    probe: { read: () => reading },
    footprints: createFootprintStore(dir),
    settings: () => ({ ...DEFAULT_SETTINGS, reserveGb: 1 }),
    heavyBudgetBytes: () => state.heavyBudgetGb * GIB,
    paused: () => false,
    now: () => 1_000_000,
  });
  return { admission, state, reading };
}

describe("no heavy claim while free memory is below the heavy budget (D#6 C43-5, fake memory probe)", () => {
  it("with room by footprint (4 GB of headroom for a 3 GB heavy job) but only 5 GB free against a 6 GB budget, heavy gets no slot and light still does", () => {
    const { admission } = rig(5, 6);
    const snap = admission.snapshot();
    expect(snap.free.heavy).toBe(0);
    expect(snap.free.light).toBeGreaterThan(0);
    // Light work still flows, so the reason is named only when nothing at all can be claimed: it is not, here.
    expect(snap.limitedBy).toBeNull();
    expect(snap.capacity.heavy.limit).toBe(0);
  });

  it("the same machine claims a heavy job once the budget fits in the free memory, whether the memory rises or the budget is lowered", () => {
    const { admission, state } = rig(5, 6);
    expect(admission.snapshot().free.heavy).toBe(0);
    state.heavyBudgetGb = 4;
    expect(admission.snapshot().free.heavy).toBe(1);
    const roomy = rig(8, 6);
    expect(roomy.admission.snapshot().free.heavy).toBeGreaterThan(0);
  });

  it("exactly at the budget is enough", () => {
    expect(rig(6, 6).admission.snapshot().free.heavy).toBeGreaterThan(0);
  });

  it("it only stops new claims: a heavy job already in hand keeps its place when memory later drops below the budget", () => {
    const { admission, reading } = rig(8, 6);
    const end = admission.begin({ signedJob: { job: { role: "executor", repo: { owner: "acme", name: "w" } } } } as never);
    reading.availMemBytes = 5 * GIB;
    const snap = admission.snapshot();
    expect(snap.free.heavy).toBe(0);
    expect(snap.capacity.heavy.in_use).toBe(1);
    end();
    expect(admission.snapshot().capacity.heavy.in_use).toBe(0);
  });
});
