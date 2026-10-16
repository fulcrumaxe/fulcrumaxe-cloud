import { describe, expect, it } from "vitest";
import { resolvePointer, parsePointer } from "../src/rulePointer.js";
import { RULE_LIMITS, evaluateRules, type Condition, type RuleDecision, type RuleOutcome, type RuleRequest } from "../src/rules.js";

const req = (args: unknown): RuleRequest => ({ tool: "run", server: "s", arguments: args, instanceName: "i" });
const rule = (id: string, outcome: RuleOutcome, when: Condition) => ({ id, outcome, when });
const run = (rules: ReturnType<typeof rule>[], args: unknown): RuleDecision => evaluateRules({ rules }, req(args), {});
const CMD = "/request/arguments/cmd";
const eq = (value: string): Condition => ({ op: "equals", field: CMD, value });
const SHAPE = { outcome: "ask", ruleId: null, reason: "rule_value_shape" };
const ASK = { outcome: "ask", ruleId: null };

describe("C17 (a): a value of the wrong shape ends the evaluation in ask / rule_value_shape, before any negation", () => {
  const ARRAY = ["/etc/passwd"];
  const OBJECT = { a: 1 };
  const comparing: Array<[string, Condition]> = [
    ["equals", { op: "equals", field: CMD, value: "x" }],
    ["not_equals", { op: "not_equals", field: CMD, value: "/etc/*" }],
    ["in", { op: "in", field: CMD, value: ["x"] }],
    ["not_in", { op: "not_in", field: CMD, value: ["rm *", "curl *"] }],
    ["starts_with", { op: "starts_with", field: CMD, value: "x" }],
    ["ends_with", { op: "ends_with", field: CMD, value: "x" }],
  ];
  for (const [name, when] of comparing) {
    for (const [shape, value] of [["array", ARRAY], ["object", OBJECT]] as const) {
      it(`${name} on an ${shape} asks with rule_value_shape (approve, deny and ask rules alike)`, () => {
        for (const outcome of ["approve", "deny", "ask"] as const) expect(run([rule("r", outcome, when)], { cmd: value })).toEqual(SHAPE);
        expect(run([rule("r", "approve", { op: "not", of: when })], { cmd: value })).toEqual(SHAPE);
      });
    }
  }
  it("contains on an object asks with rule_value_shape; on an array it still compares the elements", () => {
    const when: Condition = { op: "contains", field: CMD, value: "rm" };
    expect(run([rule("r", "approve", when)], { cmd: OBJECT })).toEqual(SHAPE);
    expect(run([rule("r", "approve", when)], { cmd: ["rm", "-rf"] })).toEqual({ outcome: "approve", ruleId: "r" });
  });
  it("the reproduced case: approve when not_equals '/etc/*' against ['/etc/passwd'] asks, it does not approve", () => {
    expect(run([rule("r", "approve", { op: "not_equals", field: CMD, value: "/etc/*" })], { cmd: ["/etc/passwd"] })).toEqual(SHAPE);
  });
  it("the argv case: approve when cmd not_in ['rm *','curl *'] against ['rm','-rf','/'] asks", () => {
    expect(run([rule("r", "approve", { op: "not_in", field: CMD, value: ["rm *", "curl *"] })], { cmd: ["rm", "-rf", "/"] })).toEqual(SHAPE);
  });
  it("not(equals) and not(in) around an array ask", () => {
    expect(run([rule("r", "approve", { op: "not", of: eq("x") })], { cmd: ["x"] })).toEqual(SHAPE);
    expect(run([rule("r", "approve", { op: "not", of: { op: "in", field: CMD, value: ["x"] } })], { cmd: ["x"] })).toEqual(SHAPE);
  });
  it("scalars of another type are unreadable, which is unknown (C19 amends C17): an approve rule does not match, a deny rule does", () => {
    expect(run([rule("r", "approve", eq("x"))], { cmd: 5 })).toEqual(ASK);
    expect(run([rule("r", "approve", { op: "not_equals", field: CMD, value: "x" })], { cmd: 5 })).toEqual(ASK);
    expect(run([rule("r", "deny", { op: "not_equals", field: CMD, value: "x" })], { cmd: 5 })).toEqual({ outcome: "deny", ruleId: "r" });
  });
  it("deny then approve: an array argument cannot skip the deny rule to reach the approve rule", () => {
    const rules = [rule("deny-rm", "deny", eq("rm *")), rule("allow", "approve", { op: "not_in", field: CMD, value: ["rm *", "curl *"] })];
    expect(run(rules, { cmd: ["rm", "-rf", "/"] })).toEqual(SHAPE);
    expect(run(rules, { cmd: "rm -rf /" })).toEqual({ outcome: "deny", ruleId: "deny-rm" });
    expect(run(rules, { cmd: "ls" })).toEqual({ outcome: "approve", ruleId: "allow" });
  });
  it("the missing-value twin: with cmd absent the approve rule does not match, so the call asks", () => {
    const rules = [rule("deny-rm", "deny", eq("rm *")), rule("allow", "approve", { op: "not_in", field: CMD, value: ["rm *", "curl *"] })];
    expect(run(rules, {})).toEqual(ASK);
  });
});

describe("C17 (b): a missing value is unknown under a negation, and unknown never approves", () => {
  const MISSING = "/request/arguments/nope";
  const e: Condition = { op: "equals", field: MISSING, value: "x" };
  const NOT_E: Condition = { op: "not", of: e };
  const known = (v: boolean): Condition => ({ op: "exists", field: v ? "/request/tool" : MISSING });
  const unknown: Condition = NOT_E;
  const outcomeFor = (when: Condition, outcome: RuleOutcome) => run([rule("r", outcome, when)], {});

  it("not(exists) on a missing field is known true, so it matches", () => {
    expect(outcomeFor({ op: "not", of: { op: "exists", field: MISSING } }, "approve")).toEqual({ outcome: "approve", ruleId: "r" });
  });
  it("not(equals) on a missing field: no match for approve, a match for deny, a match for ask", () => {
    expect(outcomeFor(NOT_E, "approve")).toEqual(ASK);
    expect(outcomeFor(NOT_E, "deny")).toEqual({ outcome: "deny", ruleId: "r" });
    expect(outcomeFor(NOT_E, "ask")).toEqual({ outcome: "ask", ruleId: "r" });
  });
  it("an approve rule that does not match falls through to the next rule", () => {
    expect(run([rule("a", "approve", NOT_E), rule("b", "approve", { op: "exists", field: "/request/tool" })], {})).toEqual({ outcome: "approve", ruleId: "b" });
  });
  it("not_equals and not_in on a missing field: no match in an approve rule, a match in a deny rule", () => {
    for (const op of [{ op: "not_equals", field: MISSING, value: "x" }, { op: "not_in", field: MISSING, value: ["x"] }] as Condition[]) {
      expect(outcomeFor(op, "approve")).toEqual(ASK);
      expect(outcomeFor(op, "deny")).toEqual({ outcome: "deny", ruleId: "r" });
    }
  });
  it("a plain equals on a missing field is false, not unknown (a deny rule does not match it)", () => {
    expect(outcomeFor(e, "deny")).toEqual(ASK);
  });
  it("double negation does not clear an unknown", () => {
    expect(outcomeFor({ op: "not", of: NOT_E }, "approve")).toEqual(ASK);
    expect(outcomeFor({ op: "not", of: NOT_E }, "deny")).toEqual({ outcome: "deny", ruleId: "r" });
  });
  it("and/or: and(false, unknown) is false; and(true, unknown) is unknown; or(true, unknown) is true; or(false, unknown) is unknown", () => {
    const m = (when: Condition) => [outcomeFor(when, "approve").outcome, outcomeFor(when, "deny").outcome];
    expect(m({ op: "all", of: [known(false), unknown] })).toEqual(["ask", "ask"]); // false: neither rule matches
    expect(m({ op: "all", of: [unknown, known(false)] })).toEqual(["ask", "ask"]); // order does not matter
    expect(m({ op: "all", of: [known(true), unknown] })).toEqual(["ask", "deny"]); // unknown: only deny matches
    expect(m({ op: "any", of: [known(true), unknown] })).toEqual(["approve", "deny"]); // true: both match
    expect(m({ op: "any", of: [unknown, known(true)] })).toEqual(["approve", "deny"]);
    expect(m({ op: "any", of: [known(false), unknown] })).toEqual(["ask", "deny"]); // unknown
  });
});

describe("C17: remaining notes from the review", () => {
  it("a value over the compared-string cap asks under contains, starts_with and ends_with", () => {
    const big = { cmd: "a".repeat(RULE_LIMITS.maxComparedString + 1) };
    for (const op of ["contains", "starts_with", "ends_with"] as const) {
      expect(run([rule("r", "approve", { op, field: CMD, value: "a" })], big)).toEqual({ outcome: "ask", ruleId: null, reason: "rule_budget_exceeded" });
    }
  });
  it("/…/array/length and /…/array/constructor are not found, and a real index is", () => {
    const doc = { list: ["a", "b"] };
    expect(resolvePointer(doc, parsePointer("/list/length")!)).toEqual({ found: false });
    expect(resolvePointer(doc, parsePointer("/list/constructor")!)).toEqual({ found: false });
    expect(resolvePointer(doc, parsePointer("/list/1")!)).toEqual({ found: true, value: "b" });
    for (const f of ["length", "constructor"]) {
      expect(run([rule("r", "approve", { op: "exists", field: `/request/arguments/list/${f}` })], { list: ["a"] })).toEqual(ASK);
    }
  });
});

describe("C17 (c): the glob takes the remaining work budget and charges as it runs", () => {
  it("a worst-case 256-character pattern against a 65,536-character value never takes work past the budget by more than one step", () => {
    const pattern = `*${"a".repeat(254)}b`;
    const set = { rules: [rule("r", "approve", { op: "equals", field: CMD, value: pattern })] };
    let work = -1;
    const decision = evaluateRules(set, req({ cmd: "a".repeat(RULE_LIMITS.maxComparedString) }), {}, { onMeter: (m) => (work = m.work) });
    expect(decision).toEqual({ outcome: "ask", ruleId: null, reason: "rule_budget_exceeded" });
    expect(work).toBeLessThanOrEqual(4_000_000 + 1);
    let small = -1;
    evaluateRules(set, req({ cmd: "a".repeat(RULE_LIMITS.maxComparedString) }), {}, { workBudget: 1_000, onMeter: (m) => (small = m.work) });
    expect(small).toBeLessThanOrEqual(1_001);
  });
});
