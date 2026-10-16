import { describe, expect, it } from "vitest";
import { globMatch } from "../src/ruleGlob.js";
import { parsePointer, resolvePointer } from "../src/rulePointer.js";
import {
  DEFAULT_NODE_BUDGET,
  DEFAULT_WORK_BUDGET,
  RULE_LIMITS,
  evaluateRules,
  type Condition,
  type RuleRequest,
} from "../src/rules.js";

const request = (args: unknown): RuleRequest => ({ tool: "t", server: "s", arguments: args, instanceName: "i" });
const meterOf = (set: unknown, req: RuleRequest, options: Parameters<typeof evaluateRules>[3] = {}) => {
  let meter = { nodes: -1, work: -1 };
  const decision = evaluateRules(set, req, {}, { ...options, onMeter: (m) => (meter = m) });
  return { decision, meter };
};

describe("AAP-a1 criterion 4: RFC 6901 JSON Pointer, through the RFC's own examples (section 5)", () => {
  const doc = {
    foo: ["bar", "baz"],
    "": 0,
    "a/b": 1,
    "c%d": 2,
    "e^f": 3,
    "g|h": 4,
    "i\\j": 5,
    'k"l': 6,
    " ": 7,
    "m~n": 8,
  };
  const examples: Array<[string, unknown]> = [
    ["", doc],
    ["/foo", ["bar", "baz"]],
    ["/foo/0", "bar"],
    ["/", 0],
    ["/a~1b", 1],
    ["/c%d", 2],
    ["/e^f", 3],
    ["/g|h", 4],
    ["/i\\j", 5],
    ['/k"l', 6],
    ["/ ", 7],
    ["/m~0n", 8],
  ];
  for (const [pointer, expected] of examples) {
    it(`resolves "${pointer}"`, () => {
      const tokens = parsePointer(pointer);
      expect(tokens).not.toBeNull();
      expect(resolvePointer(doc, tokens!)).toEqual({ found: true, value: expected });
    });
  }
  it("decodes ~1 before ~0, so ~01 is the two characters ~1", () => {
    expect(parsePointer("/~01")).toEqual(["~1"]);
  });
  it("refuses a pointer with no leading slash or a bad escape", () => {
    expect(parsePointer("foo")).toBeNull();
    expect(parsePointer("/a~")).toBeNull();
    expect(parsePointer("/a~2")).toBeNull();
  });
  it("the '-' array token refers to nothing", () => {
    expect(resolvePointer(doc, ["foo", "-"])).toEqual({ found: false });
  });
});

describe("AAP-a1 criterion 6: the bounded glob", () => {
  it("* matches any run, ? matches one character, everything else is literal", () => {
    const table: Array<[string, string, boolean]> = [
      ["a*c", "abbbc", true], ["a*c", "ac", true], ["a*c", "abbbd", false], ["a?c", "abc", true], ["a?c", "ac", false],
      ["*", "", true], ["*", "anything", true], ["", "", true], ["", "a", false], ["a.c", "abc", false], ["a.c", "a.c", true],
      ["[ab]", "a", false], ["a+b", "aab", false], ["(a)", "a", false], ["**", "x", true], ["a*", "a", true], ["*a", "ba", true], ["*a", "bab", false],
    ];
    for (const [pattern, text, expected] of table) expect(globMatch(pattern, text).matched, `${pattern} vs ${text}`).toBe(expected);
  });

  it("a pathological pattern against a 64 KiB string takes a number of steps linear in the input", () => {
    const pattern = `${"*a".repeat(60)}*b`;
    const steps = (n: number) => globMatch(pattern, "a".repeat(n)).steps;
    const small = steps(8_192);
    const big = steps(65_536);
    expect(globMatch(pattern, "a".repeat(65_536)).matched).toBe(false);
    expect(big).toBeLessThanOrEqual((pattern.length + 1) * (65_536 + 1));
    expect(big / small).toBeLessThanOrEqual(8.5); // 8x the input costs about 8x the steps
    expect(big / small).toBeGreaterThanOrEqual(7);
  });

  it("the steps are the same on every run (counted, not timed)", () => {
    const text = "ab".repeat(30_000);
    expect(globMatch("*a*b*", text).steps).toBe(globMatch("*a*b*", text).steps);
  });
});

describe("AAP-a1 criterion 5: evaluation is counted and capped", () => {
  const leaf = (i: number): Condition => ({ op: "equals", field: `/request/arguments/f${i % 1000}`, value: "v*" });
  const worstCaseSet = () => ({
    rules: Array.from({ length: RULE_LIMITS.maxRules }, (_, r) => ({
      id: `r${r}`,
      outcome: "approve" as const,
      when: { op: "any" as const, of: Array.from({ length: RULE_LIMITS.maxNodesPerRule - 1 }, (_, i) => leaf(r + i)) },
    })),
  });
  // a 64 KiB document of 1000 fields of 64 bytes each; none of them match and an any visits every child, so every node of every rule is visited
  const bigDocument = () => Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`f${i}`, `x${"y".repeat(62)}`]));

  it("200 rules of 64 nodes against a 64 KiB document stays under both budgets", () => {
    const doc = bigDocument();
    expect(JSON.stringify(doc).length).toBeGreaterThan(64_000);
    const { decision, meter } = meterOf(worstCaseSet(), request(doc));
    expect(decision).toEqual({ outcome: "ask", ruleId: null });
    expect(meter.nodes).toBe(RULE_LIMITS.maxRules * RULE_LIMITS.maxNodesPerRule);
    expect(meter.nodes).toBeLessThan(DEFAULT_NODE_BUDGET);
    expect(meter.work).toBeLessThan(DEFAULT_WORK_BUDGET);
    expect(meterOf(worstCaseSet(), request(doc)).meter).toEqual(meter); // counted, so identical on every run
  });

  it("past the node budget the answer is ask with rule_budget_exceeded, even when a later rule would approve", () => {
    const set = { rules: [{ id: "a", outcome: "deny" as const, when: leaf(0) }, { id: "b", outcome: "approve" as const, when: { op: "exists" as const, field: "/request/tool" } }] };
    expect(meterOf(set, request({}), { nodeBudget: 1 }).decision).toEqual({ outcome: "ask", ruleId: null, reason: "rule_budget_exceeded" });
    expect(meterOf(set, request({}), { nodeBudget: 2 }).decision).toEqual({ outcome: "approve", ruleId: "b" });
  });

  it("past the work budget the answer is ask with rule_budget_exceeded", () => {
    const set = { rules: [{ id: "a", outcome: "approve" as const, when: { op: "equals" as const, field: "/request/arguments/s", value: "*q*r*" } }] };
    const args = { s: "a".repeat(50_000) };
    expect(meterOf(set, request(args), { workBudget: 1_000 }).decision.reason).toBe("rule_budget_exceeded");
    expect(meterOf(set, request(args)).meter.work).toBeGreaterThan(50_000);
    expect(meterOf(set, request(args)).decision).toEqual({ outcome: "ask", ruleId: null });
  });

  it("a string longer than the compared-string cap is never compared: padding cannot push a deny rule past a later approve", () => {
    const set = {
      rules: [
        { id: "no-drop", outcome: "deny" as const, when: { op: "equals" as const, field: "/request/arguments/sql", value: "*DROP*" } },
        { id: "allow-all", outcome: "approve" as const, when: { op: "exists" as const, field: "/request/tool" } },
      ],
    };
    const padded = { sql: `DROP TABLE x; ${"-".repeat(RULE_LIMITS.maxComparedString)}` };
    expect(evaluateRules(set, request({ sql: "DROP TABLE x" }), {}).outcome).toBe("deny");
    expect(evaluateRules(set, request(padded), {})).toEqual({ outcome: "ask", ruleId: null, reason: "rule_budget_exceeded" });
  });
});
