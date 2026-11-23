import { describe, expect, it } from "vitest";
import { HOST_LOAD_MIN_INTERVAL_SECONDS } from "@fulcrumaxe/runner-protocol";
import { LOAD_STALE_AFTER_INTERVALS, PLACEMENT_MIN_DISK_FREE_MB, PLACEMENT_MIN_MEM_AVAIL_MB, assessMachine, placementOrder, type MachineCapacity } from "../src/index.js";

/** D#845 MC-9: the pure rules: who is eligible, and the order auto-placement tries machines in. */
const base = { runner_id: "00000000-0000-4000-8000-000000000001", name: "alpha", tier: "microvm" as "microvm" | "standard" | null, kvm: null as "present" | "absent" | null, live: true, paused: false, draining: false, load_age_s: 10 as number | null, claude: true, mem_avail_mb: 8000 as number | null, disk_free_mb: 50000 as number | null, running: null as { repo_id: string; name: string } | null };
const m = (over: Partial<typeof base> = {}): MachineCapacity => assessMachine({ ...base, ...over });

describe("machine eligibility", () => {
  it("is live, Claude ready, nothing placed, 4096 MB of memory and 10240 MB of disk, on either tier", () => {
    expect(m()).toMatchObject({ eligible: true, reason: null });
    expect(m({ tier: "standard" })).toMatchObject({ eligible: true, reason: null });
    expect(m({ tier: null })).toMatchObject({ eligible: true, reason: null });
    expect(m({ mem_avail_mb: PLACEMENT_MIN_MEM_AVAIL_MB, disk_free_mb: PLACEMENT_MIN_DISK_FREE_MB })).toMatchObject({ eligible: true });
  });

  it.each([
    ["a project is placed", { running: { repo_id: "r1", name: "acme/widgets" } }, "has_project"],
    ["not live", { live: false }, "not_live"],
    ["paused", { paused: true }, "paused"],
    ["draining", { draining: true }, "draining"],
    ["its load was never stored", { load_age_s: null }, "load_unknown"],
    ["its load is over 3 report intervals old", { load_age_s: LOAD_STALE_AFTER_INTERVALS * HOST_LOAD_MIN_INTERVAL_SECONDS + 1 }, "load_unknown"],
    ["Claude not ready", { claude: false }, "claude_not_ready"],
    ["memory never reported", { mem_avail_mb: null }, "load_unknown"],
    ["disk never reported", { disk_free_mb: null }, "load_unknown"],
    ["one MB short of memory", { mem_avail_mb: PLACEMENT_MIN_MEM_AVAIL_MB - 1 }, "low_memory"],
    ["one MB short of disk", { disk_free_mb: PLACEMENT_MIN_DISK_FREE_MB - 1 }, "low_disk"],
  ] as const)("is not eligible when %s", (_label, over, reason) => {
    expect(m(over)).toMatchObject({ eligible: false, reason });
  });

  it("a load exactly 3 report intervals old still counts", () => {
    expect(m({ load_age_s: LOAD_STALE_AFTER_INTERVALS * HOST_LOAD_MIN_INTERVAL_SECONDS })).toMatchObject({ eligible: true });
    expect(LOAD_STALE_AFTER_INTERVALS).toBe(3);
  });

  it("names the project first when several things are wrong, so the screen can say what holds the machine", () => {
    expect(m({ running: { repo_id: "r1", name: "acme/widgets" }, live: false, claude: false, mem_avail_mb: null })).toMatchObject({ reason: "has_project" });
    expect(m({ live: false, claude: false })).toMatchObject({ reason: "not_live" });
  });

  it("is never eligible on a machine that has no host load, which is every real runner until a build reports it", () => {
    expect(m({ mem_avail_mb: null, disk_free_mb: null })).toMatchObject({ eligible: false, reason: "load_unknown" });
  });
});

describe("auto-placement order", () => {
  let n = 0;
  const e = (name: string, tier: "microvm" | "standard" | null, mem: number | null, over: Partial<typeof base> = {}) =>
    m({ runner_id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, name, tier, mem_avail_mb: mem, ...over });
  const names = (list: MachineCapacity[]) => placementOrder(list).map((x) => x.name);

  it("1. prefers a microVM machine over a standard one with more memory", () => {
    expect(names([e("big", "standard", 64000), e("small", "microvm", 4096)])).toEqual(["small", "big"]);
  });
  it("2. among microVM machines, takes the most free memory", () => {
    expect(names([e("a", "microvm", 5000), e("b", "microvm", 9000), e("c", "microvm", 7000)])).toEqual(["b", "c", "a"]);
  });
  it("3. on equal memory, takes the name that sorts first", () => {
    expect(names([e("zed", "microvm", 8000), e("amy", "microvm", 8000)])).toEqual(["amy", "zed"]);
  });
  it("4. among standard machines, the same memory then name rule", () => {
    expect(names([e("s2", "standard", 6000), e("s1", "standard", 9000), e("s0", "standard", 6000)])).toEqual(["s1", "s0", "s2"]);
  });
  it("5. skips every ineligible machine, whatever its tier or memory", () => {
    expect(names([e("busy", "microvm", 90000, { running: { repo_id: "r", name: "x/y" } }), e("off", "microvm", 90000, { live: false }), e("ok", "standard", 5000)])).toEqual(["ok"]);
  });
  it("6. is empty when nothing is eligible, and does not change its input", () => {
    const input = [e("a", "microvm", 1000), e("b", "standard", null)];
    expect(placementOrder(input)).toEqual([]);
    expect(input.map((x) => x.name)).toEqual(["a", "b"]);
  });
  it("7. a machine whose tier is unknown sorts with the standard ones", () => {
    expect(names([e("t", null, 9000), e("v", "microvm", 4500)])).toEqual(["v", "t"]);
  });
  it("8. is the same whatever order the machines arrive in", () => {
    const list = [e("a", "microvm", 8000), e("b", "microvm", 8000), e("c", "standard", 20000), e("d", "microvm", 9000)];
    expect(names(list)).toEqual(names([...list].reverse()));
    expect(names(list)).toEqual(["d", "a", "b", "c"]);
  });
});
