import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run as checkFreshness } from "../../src/extra/freshness.js";
import { CHECKS } from "../../src/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "check-freshness");

// Every test injects `now`; the committed fixtures carry fixed dates, so no
// verdict here depends on the system clock.
const NOW = new Date("2026-09-29T00:00:00Z");
const STATS = { path: "stats.json", timestampKey: "generatedAt", maxAgeDays: 14 };
const GRAPH = { path: "graph.json", timestampKey: "project.analyzedAt", maxAgeDays: 45 };

describe("check-freshness", () => {
  it("is registered under its os-site-v2 name", () => {
    expect(CHECKS["check-freshness"]).toBe(checkFreshness);
  });

  it("passes with no sidecars declared, checked = 0", async () => {
    const result = await checkFreshness(path.join(FIXTURES, "pass"), { now: NOW, securityTxtMinDays: 0 });
    expect(result.ok).toBe(true);
    expect(result.summary?.checked).toBe(0);
  });

  it("passes fresh declared sidecars (dotted key, +00:00 offset, Z) and a far-off security.txt", async () => {
    const result = await checkFreshness(path.join(FIXTURES, "pass"), { now: NOW, sidecars: [STATS, GRAPH] });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary?.checked).toBe(2);
  });

  it("flags a stale sidecar with its age and limit", async () => {
    const result = await checkFreshness(path.join(FIXTURES, "fail"), { now: NOW, sidecars: [STATS] });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(["sidecar_stale"]);
    expect(result.findings[0].message).toContain("271d old, limit 14d");
  });

  it("flags a missing sidecar", async () => {
    const result = await checkFreshness(path.join(FIXTURES, "fail"), {
      now: NOW,
      sidecars: [{ path: "gone.json", timestampKey: "generatedAt", maxAgeDays: 14 }],
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(["sidecar_missing"]);
  });

  it("gives an advisory, not a pass and not a failure, when no age is declared", async () => {
    const dir = path.join(FIXTURES, "undeclared");
    for (const sidecar of [
      { path: "apps.json", maxAgeDays: 30 }, // no timestampKey
      { path: "apps.json", timestampKey: "generatedAt", maxAgeDays: 30 }, // key absent from the file
    ]) {
      const result = await checkFreshness(dir, { now: NOW, sidecars: [sidecar] });
      expect(result.ok).toBe(true);
      expect(result.findings.map((f) => [f.kind, f.severity])).toEqual([["sidecar_age_undeclared", "advisory"]]);
    }
  });

  it("takes its verdict from the injected clock: moving now forward flips pass to fail", async () => {
    const opts = { sidecars: [STATS] };
    expect((await checkFreshness(path.join(FIXTURES, "pass"), { ...opts, now: NOW })).ok).toBe(true);
    const later = new Date("2026-11-01T00:00:00Z");
    const result = await checkFreshness(path.join(FIXTURES, "pass"), { ...opts, now: later });
    expect(result.ok).toBe(false);
    expect(result.findings[0].kind).toBe("sidecar_stale");
  });

  it("flags a security.txt expiring within securityTxtMinDays", async () => {
    const result = await checkFreshness(path.join(FIXTURES, "expiring"), { now: new Date("2026-09-30T00:00:00Z") });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(["security_txt_expiring"]);
    expect(result.findings[0].message).toContain("expires in 10d");
    // A lower threshold accepts the same file.
    const relaxed = await checkFreshness(path.join(FIXTURES, "expiring"), {
      now: new Date("2026-09-30T00:00:00Z"),
      securityTxtMinDays: 5,
    });
    expect(relaxed.ok).toBe(true);
  });

  it("flags an already-expired security.txt", async () => {
    const result = await checkFreshness(path.join(FIXTURES, "expiring"), { now: new Date("2026-11-01T00:00:00Z") });
    expect(result.findings.map((f) => f.kind)).toEqual(["security_txt_expiring"]);
    expect(result.findings[0].message).toContain("expired");
  });
});
