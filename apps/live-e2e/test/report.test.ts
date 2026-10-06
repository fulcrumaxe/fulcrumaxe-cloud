import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/plan.js";
import { OUTCOMES, buildResults, issueTitle, notRunFromPlan, summaryTable, writeReport, type PackResult } from "../src/report.js";
import { makePack, makeTarget, needsCtx } from "./helpers.js";

const pack = (o: Partial<PackResult> & { id: string; outcome: PackResult["outcome"] }): PackResult => ({
  duration_ms: 0,
  devices: [],
  cost_usd: 0,
  ...o,
});

const base = { target: "staging", started_at: "2026-10-05T10:00:00Z", finished_at: "2026-10-05T10:04:00Z" };

describe("buildResults", () => {
  it("counts every outcome, sorts packs by id and totals the measured cost", () => {
    const r = buildResults({
      ...base,
      trigger: "deploy",
      commit: "abc1234",
      packs: [
        pack({ id: "platform", outcome: "PASS", duration_ms: 42_000, devices: ["desktop", "phone"], cost_usd: 0.1 }),
        pack({ id: "auth-negative", outcome: "FLAKY", cost_usd: 0.2 }),
        pack({ id: "billing", outcome: "SKIPPED-NEED", need: "stripe-test" }),
      ],
    });
    expect(r.packs.map((p) => p.id)).toEqual(["auth-negative", "billing", "platform"]);
    expect(r.counts).toEqual({ PASS: 1, FAIL: 0, FLAKY: 1, "SKIPPED-NEED": 1, REFUSED: 0, RESERVED: 0, "ABORTED-BUDGET": 0 });
    expect(Object.keys(r.counts)).toEqual([...OUTCOMES]);
    expect(r.total_cost_usd).toBe(0.3);
    expect(r.trigger).toBe("deploy");
    expect(r.commit).toBe("abc1234");
  });

  it("uses null for a missing trigger and commit, never undefined", () => {
    const r = buildResults({ ...base, packs: [] });
    expect(JSON.parse(JSON.stringify(r))).toMatchObject({ trigger: null, commit: null });
  });
});

describe("summaryTable", () => {
  it("renders one row per pack with outcome, duration, devices and cost", () => {
    const r = buildResults({
      ...base,
      packs: [
        pack({ id: "platform", outcome: "PASS", duration_ms: 95_400, devices: ["desktop", "phone", "tablet"], cost_usd: 0 }),
        pack({ id: "billing", outcome: "SKIPPED-NEED", need: "stripe-test", duration_ms: 0 }),
        pack({ id: "danger", outcome: "REFUSED", reason: "destructive-on-production" }),
        pack({ id: "chat", outcome: "FAIL", duration_ms: 800, devices: ["desktop"], cost_usd: 1.234 }),
      ],
    });
    expect(summaryTable(r)).toBe(
      [
        "### Live end-to-end: staging",
        "",
        "| Pack | Outcome | Duration | Devices | Cost |",
        "| --- | --- | --- | --- | --- |",
        "| billing | SKIPPED-NEED stripe-test | 0 ms | - | $0.00 |",
        "| chat | FAIL | 800 ms | desktop | $1.23 |",
        "| danger | REFUSED destructive-on-production | 0 ms | - | $0.00 |",
        "| platform | PASS | 1 min 35 s | desktop, phone, tablet | $0.00 |",
        "",
        "1 PASS, 1 FAIL, 1 SKIPPED-NEED, 1 REFUSED. Total measured cost $1.23.",
        "Redacted before writing: 0 value(s).",
        "",
      ].join("\n"),
    );
  });

  it("cannot be broken out of its table by a pipe or newline in a cell", () => {
    const r = buildResults({ ...base, packs: [pack({ id: "a|b\nc", outcome: "PASS" })] });
    const row = summaryTable(r).split("\n").find((l) => l.includes("a\\|b"));
    expect(row).toBe("| a\\|b c | PASS | 0 ms | - | $0.00 |");
  });

  it("says so when there are no packs", () => {
    expect(summaryTable(buildResults({ ...base, packs: [] }))).toContain("no packs. Total measured cost $0.00.");
  });
});

describe("a debugging run that included unscanned files says so", () => {
  it("lists them in results.json and in the summary, and is silent otherwise", () => {
    const plain = buildResults({ ...base, packs: [] });
    expect(plain.included_unscanned).toEqual([]);
    expect(summaryTable(plain)).not.toContain("WITHOUT being scanned");
    const r = buildResults({ ...base, packs: [], included_unscanned: ["trace.zip", "a|b.har"] });
    expect(r.included_unscanned).toEqual(["trace.zip", "a|b.har"]);
    expect(summaryTable(r)).toContain("Debugging run: 2 file(s) were uploaded WITHOUT being scanned: trace.zip, a\\|b.har.");
  });
});

describe("issueTitle", () => {
  it("is the pack and the target, the same every time", () => {
    expect(issueTitle("platform", "staging")).toBe("live-e2e: platform on staging");
    expect(issueTitle("platform", "staging")).toBe(issueTitle("platform", "staging"));
  });

  it("refuses anything that is not a pack id and a target name, so a title can carry no free text", () => {
    for (const bad of ["", "Platform", "a b", "a/b", "-x", "x".repeat(65), "a\nb", "a: b"]) {
      expect(() => issueTitle(bad, "staging")).toThrow(/plain pack id/);
      expect(() => issueTitle("platform", bad)).toThrow(/plain target name/);
    }
  });
});

describe("notRunFromPlan", () => {
  it("turns the plan's skipped and refused packs into results, so they are reported and not dropped", () => {
    const target = makeTarget();
    const plan = buildPlan({
      packs: [
        makePack({ id: "ok" }),
        makePack({ id: "needs-stripe", needs: ["stripe-test"] }),
        makePack({ id: "wild", destructive: true, targets: ["staging", "production"], tier: "full" }),
      ],
      target,
      tier: "full",
      needs: needsCtx({ VERCEL_AUTOMATION_BYPASS_SECRET: "x".repeat(20) }),
    });
    expect(notRunFromPlan(plan)).toEqual([
      pack({ id: "needs-stripe", outcome: "SKIPPED-NEED", need: "stripe-test" }),
    ]);
  });

  it("includes refusals", () => {
    const plan = buildPlan({
      packs: [makePack({ id: "wild", destructive: true, targets: ["staging", "production"] })],
      target: makeTarget({ name: "production", origin: "https://prod.example.test", protected: false, env: [] }),
      named: ["wild"],
      needs: needsCtx(),
    });
    expect(notRunFromPlan(plan)).toEqual([pack({ id: "wild", outcome: "REFUSED", reason: "destructive-on-production" })]);
  });
});

describe("writeReport", () => {
  it("writes results.json and summary.md that match the in-memory results", () => {
    const dir = mkdtempSync(join(tmpdir(), "t2a_report_"));
    const r = buildResults({ ...base, packs: [pack({ id: "platform", outcome: "PASS", devices: ["desktop"] })] });
    const { resultsPath, summaryPath } = writeReport(dir, r, { env: {} });
    expect(JSON.parse(readFileSync(resultsPath, "utf8"))).toEqual(JSON.parse(JSON.stringify(r)));
    expect(readFileSync(summaryPath, "utf8")).toBe(summaryTable(r));
  });
});
