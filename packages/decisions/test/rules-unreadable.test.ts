import { describe, expect, it } from "vitest";
import { evaluateRules, type Condition, type RuleOutcome, type RuleRequest } from "../src/rules.js";

const rule = (id: string, outcome: RuleOutcome, when: Condition) => ({ id, outcome, when });
const run = (rules: ReturnType<typeof rule>[], args: unknown, options: Parameters<typeof evaluateRules>[3] = {}) =>
  evaluateRules({ rules }, { tool: "run", server: "s", arguments: args, instanceName: "i" } satisfies RuleRequest, {}, options);
const A = (name: string) => `/request/arguments/${name}`;
const RUN: Condition = { op: "equals", field: "/request/tool", value: "run" };
const allowRun = rule("allow", "approve", RUN);
const DENY = { outcome: "deny", ruleId: "d" };
const APPROVE = { outcome: "approve", ruleId: "allow" };
const ASK = { outcome: "ask", ruleId: null };
const T: Condition = { op: "exists", field: "/request/tool" };
const F: Condition = { op: "exists", field: A("never_there") };

describe("C19 (1): an unreadable value is unknown, wherever it sits", () => {
  const gt: Condition = { op: "gt", field: A("amount"), value: 100 };
  const denyGt = rule("d", "deny", gt);
  it("deny amount gt 100 is not skipped by an array, an object, a string, a boolean or null; the allow rule never runs", () => {
    for (const amount of [[1000], { a: 1000 }, "1000", true, null]) expect(run([denyGt, allowRun], { amount }), JSON.stringify(amount)).toEqual(DENY);
  });
  it("controls: 1000 denies, 50 approves, a missing amount approves (missing outside a negation is false)", () => {
    expect(run([denyGt, allowRun], { amount: 1000 })).toEqual(DENY);
    expect(run([denyGt, allowRun], { amount: 50 })).toEqual(APPROVE);
    expect(run([denyGt, allowRun], {})).toEqual(APPROVE);
  });
  it("approve when not(gt n 100): unreadable asks; 50 approves; 500 asks", () => {
    const r = rule("a", "approve", { op: "not", of: { op: "gt", field: A("n"), value: 100 } });
    for (const n of [[1], { a: 1 }, "1"]) expect(run([r], { n }), JSON.stringify(n)).toEqual(ASK);
    expect(run([r], { n: 50 })).toEqual({ outcome: "approve", ruleId: "a" });
    expect(run([r], { n: 500 })).toEqual(ASK);
  });
  it("every number operator treats a non-number as unknown", () => {
    for (const op of ["lt", "lte", "gt", "gte"] as const) {
      expect(run([rule("d", "deny", { op, field: A("n"), value: 5 }), allowRun], { n: "5" }), op).toEqual(DENY);
    }
  });
  it("contains on an array: a nested array, an object, or one non-string element is unknown", () => {
    const d = rule("d", "deny", { op: "contains", field: A("cmd"), value: "rm" });
    for (const cmd of [[["rm"]], [{ x: "rm" }], ["rm", 5], [5, "rm"]]) expect(run([d, allowRun], { cmd }), JSON.stringify(cmd)).toEqual(DENY);
    expect(run([d, allowRun], { cmd: ["rm"] })).toEqual(DENY); // a plain match
    expect(run([d, allowRun], { cmd: ["ls"] })).toEqual(APPROVE);
    expect(run([d, allowRun], { cmd: [] })).toEqual(APPROVE);
  });
  it("approve when not(contains files '/etc/passwd'): nested or object elements ask; strings approve", () => {
    const r = rule("a", "approve", { op: "not", of: { op: "contains", field: A("files"), value: "/etc/passwd" } });
    for (const files of [[["/etc/passwd"]], [{ p: "/etc/passwd" }]]) expect(run([r], { files }), JSON.stringify(files)).toEqual(ASK);
    expect(run([r], { files: ["a", "b"] })).toEqual({ outcome: "approve", ruleId: "a" });
  });
  it("contains, starts_with and ends_with on a number, boolean or null are unknown", () => {
    for (const op of ["contains", "starts_with", "ends_with"] as const) {
      for (const cmd of [5, true, null]) expect(run([rule("d", "deny", { op, field: A("cmd"), value: "5" }), allowRun], { cmd }), `${op} ${cmd}`).toEqual(DENY);
    }
    expect(run([rule("d", "deny", { op: "starts_with", field: A("cmd"), value: "rm" }), allowRun], { cmd: "ls" })).toEqual(APPROVE); // control
  });
  it("an unreadable leaf in an ask rule matches and asks", () => {
    expect(run([rule("k", "ask", gt)], { amount: "1000" })).toEqual({ outcome: "ask", ruleId: "k" });
    expect(run([rule("k", "ask", gt)], { amount: 5 })).toEqual(ASK);
  });
  it("unknown outside a negation: deny when all(T, any(F, gt amount 100)) with amount [1] denies", () => {
    const when: Condition = { op: "all", of: [T, { op: "any", of: [F, gt] }] };
    expect(run([rule("d", "deny", when), allowRun], { amount: [1] })).toEqual(DENY);
    expect(run([rule("d", "deny", when), allowRun], { amount: 1 })).toEqual(APPROVE);
  });
  it("a read that throws is unknown, never a match", () => {
    const hostile = {
      get boom(): never {
        throw new Error("no");
      },
    };
    expect(run([rule("d", "deny", { op: "equals", field: A("boom"), value: "x" }), allowRun], hostile)).toEqual(DENY);
    expect(run([rule("a", "approve", { op: "equals", field: A("boom"), value: "x" })], hostile)).toEqual(ASK);
  });
});

describe("C19 (2): a scalar type mismatch under equals / in is unknown", () => {
  it("deny amount equals 1000 is not skipped by the string '1000'", () => {
    const d = rule("d", "deny", { op: "equals", field: A("amount"), value: 1000 });
    expect(run([d, allowRun], { amount: "1000" })).toEqual(DENY);
    expect(run([d, allowRun], { amount: 1000 })).toEqual(DENY);
    expect(run([d, allowRun], { amount: 999 })).toEqual(APPROVE); // right type, different value: an ordinary false
  });
  it("approve when mode not_equals 'off' asks for 0 and null, and approves 'on'", () => {
    const r = rule("a", "approve", { op: "not_equals", field: A("mode"), value: "off" });
    expect(run([r], { mode: 0 })).toEqual(ASK);
    expect(run([r], { mode: null })).toEqual(ASK);
    expect(run([r], { mode: "on" })).toEqual({ outcome: "approve", ruleId: "a" });
    expect(run([r], { mode: "off" })).toEqual(ASK);
  });
  it("in / not_in with a list of strings against a number: unknown (deny fires, approve does not); a string behaves as before", () => {
    for (const op of ["in", "not_in"] as const) {
      expect(run([rule("d", "deny", { op, field: A("x"), value: ["a", "b"] }), allowRun], { x: 5 }), op).toEqual(DENY);
      expect(run([rule("a", "approve", { op, field: A("x"), value: ["a", "b"] })], { x: 5 }), op).toEqual(ASK);
    }
    expect(run([rule("a", "approve", { op: "in", field: A("x"), value: ["a", "b"] })], { x: "a" })).toEqual({ outcome: "approve", ruleId: "a" });
    expect(run([rule("a", "approve", { op: "not_in", field: A("x"), value: ["a", "b"] })], { x: "c" })).toEqual({ outcome: "approve", ruleId: "a" });
  });
  it("a mixed list is readable for each of its types", () => {
    const r = rule("a", "approve", { op: "in", field: A("x"), value: ["a", 5] });
    expect(run([r], { x: 5 })).toEqual({ outcome: "approve", ruleId: "a" });
    expect(run([r], { x: true })).toEqual(ASK);
  });
  it("an array under equals still ends in ask / rule_value_shape (C17 regression)", () => {
    expect(run([rule("d", "deny", { op: "equals", field: A("x"), value: "a" })], { x: ["a"] })).toEqual({ outcome: "ask", ruleId: null, reason: "rule_value_shape" });
  });
});

describe("C19 (4): unknown reaches a nested leaf at depth 3 or more, inside and outside a negation", () => {
  // all cannot stop early (its first child is true) and any cannot stop early (its first child is false), so the leaf is always evaluated
  const nested = (leaf: Condition): Condition => ({ op: "not", of: { op: "all", of: [T, { op: "any", of: [F, leaf] }] } });
  const missing: Condition = { op: "equals", field: A("missing"), value: "x" };
  const unreadable: Condition = { op: "gt", field: A("n"), value: 100 };
  it("not(all(T, any(F, missing))): the rule does not match for approve and asks; the deny twin denies; the ask twin asks", () => {
    expect(run([rule("a", "approve", nested(missing))], {})).toEqual(ASK);
    expect(run([rule("d", "deny", nested(missing))], {})).toEqual(DENY);
    expect(run([rule("k", "ask", nested(missing))], {})).toEqual({ outcome: "ask", ruleId: "k" });
  });
  it("the same with an unreadable value in place of the missing one", () => {
    expect(run([rule("a", "approve", nested(unreadable))], { n: [1] })).toEqual(ASK);
    expect(run([rule("d", "deny", nested(unreadable))], { n: [1] })).toEqual(DENY);
  });
  it("control: with a readable value the nesting is an ordinary known result (any(F,T)=T, all=T, not=F, so no match)", () => {
    expect(run([rule("d", "deny", nested(unreadable))], { n: 500 })).toEqual(ASK);
    expect(run([rule("d", "deny", nested(unreadable))], { n: 5 })).toEqual(DENY); // any(F,F)=F, all=F, not=T
  });
  it("outside a negation the same nesting with an unreadable leaf denies", () => {
    const plain: Condition = { op: "all", of: [T, { op: "any", of: [F, unreadable] }] };
    expect(run([rule("d", "deny", plain)], { n: [1] })).toEqual(DENY);
    expect(run([rule("a", "approve", plain)], { n: [1] })).toEqual(ASK);
  });
});

describe("C19 (3): spend() checks the cap before adding, so the meter never reads above the budget", () => {
  const meter = (rules: ReturnType<typeof rule>[], args: unknown, workBudget: number) => {
    let work = -1;
    const decision = run(rules, args, { workBudget, onMeter: (m) => (work = m.work) });
    return { decision, work };
  };
  const BUDGET = { outcome: "ask", ruleId: null, reason: "rule_budget_exceeded" };
  const big = "a".repeat(65_536);
  it("contains over a 65,536-character string with a budget of 100 asks and leaves work at or under 100", () => {
    const r = meter([rule("r", "approve", { op: "contains", field: A("s"), value: "b" })], { s: big }, 100);
    expect(r.decision).toEqual(BUDGET);
    expect(r.work).toBeLessThanOrEqual(100);
  });
  it("starts_with, ends_with, a long array under contains, and a long in list are refused the same way", () => {
    const cases: Array<[Condition, unknown]> = [
      [{ op: "starts_with", field: A("s"), value: "b" }, { s: big }],
      [{ op: "ends_with", field: A("s"), value: "b" }, { s: big }],
      [{ op: "contains", field: A("l"), value: "b" }, { l: Array.from({ length: 500 }, () => "a") }],
      [{ op: "in", field: A("s"), value: Array.from({ length: 64 }, (_, i) => `v${i}`) }, { s: "q" }],
    ];
    for (const [when, args] of cases) {
      const r = meter([rule("r", "approve", when)], args, 20);
      expect(r.decision, when.op).toEqual(BUDGET);
      expect(r.work, when.op).toBeLessThanOrEqual(20);
    }
  });
  it("the glob worst case (256-character pattern, 65,536-character value) leaves work at or under the budget", () => {
    const r = meter([rule("r", "approve", { op: "equals", field: A("s"), value: `*${"a".repeat(254)}b` })], { s: big }, 100);
    expect(r.decision).toEqual(BUDGET);
    expect(r.work).toBeLessThanOrEqual(100);
  });
  it("a charge exactly equal to the remaining budget passes", () => {
    const when: Condition = { op: "contains", field: A("s"), value: "b" };
    // pointer tokens (3) + string length (10)
    const ok = meter([rule("r", "approve", when)], { s: "aaaaaaaaab" }, 13);
    expect(ok.decision).toEqual({ outcome: "approve", ruleId: "r" });
    expect(ok.work).toBe(13);
    expect(meter([rule("r", "approve", when)], { s: "aaaaaaaaab" }, 12).decision).toEqual(BUDGET);
  });
});
