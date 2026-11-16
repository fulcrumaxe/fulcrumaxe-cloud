// apps/workspace/test/budget-billing-roles.test.mjs
//
// D#31 API-7f: "Spend by role" in the Budget & Billing app. budget-billing-app.js holds its own copy of the
// Runs app's role-word map (it cannot import apps/runs/runs-detail.js: each first-party app has its own
// boot-file ceiling, and apps/_lib/ is at its own). This test is what holds the two in step: roleWords()
// here must equal titleOf() there for every role either file knows, plus an unknown and a non-string role.
//
// Same import style as budget-billing-period.test.mjs: the module registers itself with window.FULC on
// import, and its live-client import needs a real browser, so both are stood in for first.
import { describe, expect, it, vi } from "vitest";

vi.mock("../shell/core/cloud-live.js", () => ({ on: () => () => {}, onRefresh: () => () => {} }));
globalThis.window = { FULC: { register: () => {} } };
const { roleWords, roleBreakdownRows } = await import("../apps/budget-billing/budget-billing-app.js");
const { titleOf } = await import("../apps/runs/runs-detail.js");

const KNOWN_ROLES = [
  "project-manager",
  "technical-architect",
  "product-owner",
  "performance-expert",
  "security-expert",
  "cost-analyst",
  "executor",
  "code-reviewer",
  "acceptance-tester",
  "security-reviewer",
  "debater",
  "accessibility-reviewer",
  "browser-tester",
  "deploy-verifier",
  "proposal-verifier",
  "discovery-analyst",
];

describe("roleWords() matches the Runs app's titleOf()", () => {
  it("for every role the Runs app knows", () => {
    for (const role of KNOWN_ROLES) expect(roleWords(role)).toBe(titleOf(role));
  });

  it("for an unknown role and a non-string role", () => {
    expect(roleWords("some_unknown-role")).toBe(titleOf("some_unknown-role"));
    expect(roleWords(42)).toBe(titleOf(42));
    expect(roleWords(null)).toBe(titleOf(null));
    expect(roleWords(undefined)).toBe(titleOf(undefined));
    expect(roleWords("")).toBe(titleOf(""));
  });
});

describe("roleBreakdownRows()", () => {
  it("builds each row's text: runs then spend, singular/plural", () => {
    const rb = roleBreakdownRows([
      { role: "code-reviewer", runs: 1, spend_usd: 4, own_plan_api_equivalent_usd: 0 },
      { role: "executor", runs: 2, spend_usd: 12.75, own_plan_api_equivalent_usd: 0 },
    ]);
    expect(rb.rows.map((r) => r.text)).toEqual(["1 run · $4.00", "2 runs · $12.75"]);
    expect(rb.rows.map((r) => r.label)).toEqual([titleOf("code-reviewer"), titleOf("executor")]);
  });

  it("adds the API-equivalent tail only when that figure is finite and above 0", () => {
    const row = (own) => roleBreakdownRows([{ role: "executor", runs: 1, spend_usd: 2, own_plan_api_equivalent_usd: own }]).rows[0].text;
    expect(row(5.5)).toBe("1 run · $2.00 · API-equivalent $5.50 on your own plan");
    for (const own of [0, -1, NaN, Infinity, undefined, null, "5"]) expect(row(own)).toBe("1 run · $2.00");
  });

  it("skips an entry whose role is not a non-empty string, or whose runs or spend_usd is not a finite number", () => {
    const bad = [
      { role: "", runs: 1, spend_usd: 1, own_plan_api_equivalent_usd: 0 },
      { role: 7, runs: 1, spend_usd: 1, own_plan_api_equivalent_usd: 0 },
      { role: "executor", runs: "1", spend_usd: 1, own_plan_api_equivalent_usd: 0 },
      { role: "executor", runs: NaN, spend_usd: 1, own_plan_api_equivalent_usd: 0 },
      { role: "executor", runs: 1, spend_usd: "1", own_plan_api_equivalent_usd: 0 },
      { role: "executor", runs: 1, spend_usd: Infinity, own_plan_api_equivalent_usd: 0 },
      null,
      undefined,
    ];
    const ok = { role: "code-reviewer", runs: 1, spend_usd: 1, own_plan_api_equivalent_usd: 0 };
    expect(roleBreakdownRows([...bad, ok]).rows.map((r) => r.role)).toEqual(["code-reviewer"]);
  });

  it("returns the no-runs line for []", () => {
    expect(roleBreakdownRows([])).toEqual({ empty: "No runs this month yet." });
  });

  it("returns the no-runs line when every entry is malformed", () => {
    expect(roleBreakdownRows([{ role: "", runs: 1, spend_usd: 1 }])).toEqual({ empty: "No runs this month yet." });
  });

  it("returns the error line when the field is absent or not an array", () => {
    const err = { error: "Spend by role couldn't be loaded." };
    expect(roleBreakdownRows(undefined)).toEqual(err);
    expect(roleBreakdownRows(null)).toEqual(err);
    expect(roleBreakdownRows({})).toEqual(err);
    expect(roleBreakdownRows("none")).toEqual(err);
  });

  it("carries the caption only beside rows, never beside the empty or error states", () => {
    const rb = roleBreakdownRows([{ role: "executor", runs: 1, spend_usd: 1, own_plan_api_equivalent_usd: 0 }]);
    expect(rb.note).toBe("Runs only. Spend not recorded against a run is in the totals above but not here.");
    expect(roleBreakdownRows([]).note).toBeUndefined();
    expect(roleBreakdownRows(null).note).toBeUndefined();
  });
});
