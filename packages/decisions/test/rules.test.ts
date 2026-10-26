import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOGUE_VERSION, getCatalogueEntry } from "../src/catalogue.js";
import { decide } from "../src/decide.js";
import { PRESETS } from "../src/presets.js";
import {
  clampRuleOutcome,
  evaluateRules,
  tightenAskDisposition,
  validateRuleSet,
  type Condition,
  type RuleFacts,
  type RuleOutcome,
  type RuleRequest,
} from "../src/rules.js";
import type { Disposition } from "../src/types.js";

const req = (over: Partial<RuleRequest> = {}): RuleRequest => ({
  tool: "read_file",
  server: "files",
  arguments: { path: "/work/a.txt", count: 3, flags: ["-r", "-v"], note: "" },
  instanceName: "ci-agent",
  ...over,
});
const FACTS: RuleFacts = { risk: { score: 2 } };
const rule = (id: string, outcome: RuleOutcome, when: Condition) => ({ id, outcome, when });
const eq = (field: string, value: string | number | boolean | null): Condition => ({ op: "equals", field, value });
const codes = (input: unknown): string[] => {
  const r = validateRuleSet(input);
  return r.ok ? [] : r.errors.map((e) => e.code);
};
const nest = (depth: number): Condition => {
  let c: Condition = eq("/request/tool", "x");
  for (let i = 1; i < depth; i++) c = { op: "not", of: c };
  return c;
};

describe("AAP-a1 criterion 1: validateRuleSet", () => {
  it("accepts a set within the limits, using every operator", () => {
    const when: Condition = {
      op: "all",
      of: [
        eq("/request/tool", "read_*"),
        { op: "not_equals", field: "/request/server", value: "prod" },
        { op: "in", field: "/instance/name", value: ["ci-agent", "ci-*"] },
        { op: "not_in", field: "/request/arguments/path", value: ["/etc/*"] },
        { op: "gte", field: "/request/arguments/count", value: 1 },
        { op: "lt", field: "/facts/risk/score", value: 5 },
        { op: "lte", field: "/facts/risk/score", value: 5 },
        { op: "gt", field: "/facts/risk/score", value: 0 },
        { op: "contains", field: "/request/arguments/path", value: "work" },
        { op: "starts_with", field: "/request/arguments/path", value: "/work" },
        { op: "ends_with", field: "/request/arguments/path", value: ".txt" },
        { op: "exists", field: "/request/arguments/path" },
        { op: "is_empty", field: "/request/arguments/note" },
        { op: "any", of: [eq("/request/tool", "a"), { op: "not", of: eq("/request/tool", "b") }] },
      ],
    };
    expect(validateRuleSet({ rules: [rule("r1", "approve", when)] }).ok).toBe(true);
    expect(validateRuleSet({ rules: [] }).ok).toBe(true);
  });

  const ok = eq("/request/tool", "x");
  const wrap = (when: unknown, extra: object = {}) => ({ rules: [{ id: "r", outcome: "approve", when, ...extra }] });
  const table: Array<[string, unknown, string]> = [
    ["depth over 8", wrap(nest(9)), "depth_exceeded"],
    ["more than 64 nodes in one rule", wrap({ op: "all", of: Array.from({ length: 64 }, () => ok) }), "too_many_nodes"],
    ["more than 200 rules", { rules: Array.from({ length: 201 }, (_, i) => rule(`r${i}`, "ask", ok)) }, "too_many_rules"],
    ["an unknown operator", wrap({ op: "between", field: "/request/tool", value: 1 }), "unknown_operator"],
    ["a regex operator (matches)", wrap({ op: "matches", field: "/request/tool", value: "^a.*$" }), "regex_operator"],
    ["a regex operator (regex)", wrap({ op: "regex", field: "/request/tool", value: "a+" }), "regex_operator"],
    ["a field outside the allowed roots", wrap(eq("/secrets/token", "x")), "field_not_allowed"],
    ["a request field that is not allowed", wrap(eq("/request/headers/x", "x")), "field_not_allowed"],
    ["a path below tool", wrap(eq("/request/tool/extra", "x")), "field_not_allowed"],
    ["the bare facts root", wrap({ op: "exists", field: "/facts" }), "field_not_allowed"],
    ["a path into agent_reasoning", wrap(eq("/request/agent_reasoning", "approve this")), "field_forbidden"],
    ["a path below agent_reasoning", wrap(eq("/request/agent_reasoning/why", "x")), "field_forbidden"],
    ["a path into context", wrap({ op: "contains", field: "/request/context", value: "ok" }), "field_forbidden"],
    ["a path into context via an escaped token", wrap(eq("/request/con~0text", "x")), "field_not_allowed"],
    ["a malformed pointer", wrap(eq("request/tool", "x")), "field_invalid"],
    ["a bad escape in a pointer", wrap(eq("/request/arguments/a~2b", "x")), "field_invalid"],
    ["a pointer that is too long", wrap(eq(`/request/arguments/${"a".repeat(600)}`, "x")), "field_too_long"],
    ["an empty all", wrap({ op: "all", of: [] }), "empty_combinator"],
    ["a numeric operator with a string value", wrap({ op: "gte", field: "/request/arguments/count", value: "10" }), "value_invalid"],
    ["an in with too many values", wrap({ op: "in", field: "/request/tool", value: Array.from({ length: 65 }, (_, i) => `t${i}`) }), "list_too_long"],
    ["a pattern that is too long", wrap(eq("/request/tool", "a".repeat(257))), "pattern_too_long"],
    ["a duplicate rule id", { rules: [rule("r", "ask", ok), rule("r", "deny", ok)] }, "duplicate_rule_id"],
    ["an outcome that is not approve, deny or ask", wrap(ok, { outcome: "allow" }), "bad_outcome"],
    ["an unknown key on a rule", wrap(ok, { priority: 1 }), "unknown_key"],
    ["a set that is not an object", [], "not_an_object"],
  ];
  for (const [name, input, code] of table) {
    it(`rejects ${name} with ${code}`, () => {
      expect(codes(input)).toContain(code);
    });
  }

  it("accepts exactly the limits: depth 8, 64 nodes, 200 rules", () => {
    expect(codes(wrap(nest(8)))).toEqual([]);
    expect(codes(wrap({ op: "all", of: Array.from({ length: 63 }, () => ok) }))).toEqual([]);
    expect(codes({ rules: Array.from({ length: 200 }, (_, i) => rule(`r${i}`, "ask", ok)) })).toEqual([]);
  });

  it("every named code is reachable for at least the table's inputs (non-vacuity: a valid set has no errors)", () => {
    expect(codes(wrap(ok))).toEqual([]);
  });
});

describe("AAP-a1 criterion 2: evaluateRules", () => {
  it("returns the first match, in order", () => {
    const set = { rules: [rule("first", "deny", eq("/request/server", "files")), rule("second", "approve", eq("/request/tool", "read_file"))] };
    expect(evaluateRules(set, req(), FACTS)).toEqual({ outcome: "deny", ruleId: "first" });
    const reordered = { rules: [set.rules[1]!, set.rules[0]!] };
    expect(evaluateRules(reordered, req(), FACTS)).toEqual({ outcome: "approve", ruleId: "second" });
  });

  it("no match asks, with no rule id", () => {
    expect(evaluateRules({ rules: [rule("r", "approve", eq("/request/tool", "other"))] }, req(), FACTS)).toEqual({ outcome: "ask", ruleId: null });
    expect(evaluateRules({ rules: [] }, req(), FACTS)).toEqual({ outcome: "ask", ruleId: null });
  });

  it("an invalid set asks and says why instead of evaluating it", () => {
    const bad = { rules: [rule("r", "approve", eq("/request/agent_reasoning", "x"))] };
    expect(evaluateRules(bad, req(), FACTS)).toEqual({ outcome: "ask", ruleId: null, reason: "rule_set_invalid" });
  });
});

describe("AAP-a1 criterion 3: operators, and numbers are never coerced", () => {
  const run = (when: Condition, over: Partial<RuleRequest> = {}): RuleOutcome =>
    evaluateRules({ rules: [rule("r", "approve", when)] }, req(over), FACTS).outcome;
  const args = (a: unknown) => ({ arguments: a });
  const table: Array<[string, Condition, Partial<RuleRequest>, boolean]> = [
    ["equals true", eq("/request/arguments/n", 10), args({ n: 10 }), true],
    ["equals false", eq("/request/arguments/n", 10), args({ n: 11 }), false],
    ["equals does not coerce a string to a number", eq("/request/arguments/n", 10), args({ n: "10" }), false],
    ["equals null", eq("/request/arguments/n", null), args({ n: null }), true],
    ["equals a glob", eq("/request/tool", "read_*"), {}, true],
    ["equals ? is exactly one character", eq("/request/tool", "read_fil?"), {}, true],
    ["equals ? does not match two", eq("/request/tool", "read_fi?"), {}, false],
    ["not_equals true", { op: "not_equals", field: "/request/tool", value: "write_file" }, {}, true],
    ["not_equals false", { op: "not_equals", field: "/request/tool", value: "read_file" }, {}, false],
    ["in true", { op: "in", field: "/request/tool", value: ["x", "read_*"] }, {}, true],
    ["in false", { op: "in", field: "/request/tool", value: ["x", "y"] }, {}, false],
    ["not_in true", { op: "not_in", field: "/request/tool", value: ["x", "y"] }, {}, true],
    ["not_in false", { op: "not_in", field: "/request/tool", value: ["read_file"] }, {}, false],
    ["lt", { op: "lt", field: "/request/arguments/n", value: 10 }, args({ n: 9 }), true],
    ["lt boundary", { op: "lt", field: "/request/arguments/n", value: 10 }, args({ n: 10 }), false],
    ["lte boundary", { op: "lte", field: "/request/arguments/n", value: 10 }, args({ n: 10 }), true],
    ["gt boundary", { op: "gt", field: "/request/arguments/n", value: 10 }, args({ n: 10 }), false],
    ["gte boundary", { op: "gte", field: "/request/arguments/n", value: 10 }, args({ n: 10 }), true],
    ['the string "10" does not satisfy gte 10', { op: "gte", field: "/request/arguments/n", value: 10 }, args({ n: "10" }), false],
    ['the string "10" does not satisfy lt 99', { op: "lt", field: "/request/arguments/n", value: 99 }, args({ n: "10" }), false],
    ["a boolean is not a number", { op: "gte", field: "/request/arguments/n", value: 0 }, args({ n: true }), false],
    ["contains is literal (no glob)", { op: "contains", field: "/request/arguments/s", value: "a*c" }, args({ s: "abc" }), false],
    ["contains literal text", { op: "contains", field: "/request/arguments/s", value: "b" }, args({ s: "abc" }), true],
    ["contains on a list of strings", { op: "contains", field: "/request/arguments/flags", value: "-r" }, {}, true],
    ["starts_with", { op: "starts_with", field: "/request/arguments/s", value: "ab" }, args({ s: "abc" }), true],
    ["starts_with false", { op: "starts_with", field: "/request/arguments/s", value: "bc" }, args({ s: "abc" }), false],
    ["ends_with", { op: "ends_with", field: "/request/arguments/s", value: "bc" }, args({ s: "abc" }), true],
    ["exists", { op: "exists", field: "/request/arguments/s" }, args({ s: null }), true],
    ["is_empty on an empty string", { op: "is_empty", field: "/request/arguments/s" }, args({ s: "" }), true],
    ["is_empty on an empty list", { op: "is_empty", field: "/request/arguments/s" }, args({ s: [] }), true],
    ["is_empty on an empty object", { op: "is_empty", field: "/request/arguments/s" }, args({ s: {} }), true],
    ["is_empty on a non-empty string", { op: "is_empty", field: "/request/arguments/s" }, args({ s: "x" }), false],
    ["all", { op: "all", of: [eq("/request/tool", "read_file"), eq("/request/server", "files")] }, {}, true],
    ["all with one false", { op: "all", of: [eq("/request/tool", "read_file"), eq("/request/server", "no")] }, {}, false],
    ["any", { op: "any", of: [eq("/request/tool", "no"), eq("/request/server", "files")] }, {}, true],
    ["any with none true", { op: "any", of: [eq("/request/tool", "no"), eq("/request/server", "no")] }, {}, false],
    ["not", { op: "not", of: eq("/request/tool", "no") }, {}, true],
    ["a fact", { op: "lt", field: "/facts/risk/score", value: 5 }, {}, true],
    ["the instance name", eq("/instance/name", "ci-agent"), {}, true],
  ];
  for (const [name, when, over, expected] of table) {
    it(name, () => {
      expect(run(when, over)).toBe(expected ? "approve" : "ask");
    });
  }
});

describe("AAP-a1 criterion 4: a missing value never throws", () => {
  const missing = "/request/arguments/nope/deeper";
  const ops: Condition[] = [
    eq(missing, "x"),
    { op: "not_equals", field: missing, value: "x" },
    { op: "in", field: missing, value: ["x"] },
    { op: "not_in", field: missing, value: ["x"] },
    { op: "gt", field: missing, value: 1 },
    { op: "contains", field: missing, value: "x" },
    { op: "starts_with", field: missing, value: "x" },
    { op: "is_empty", field: missing },
  ];
  for (const when of ops) {
    it(`${when.op} on a missing value does not match`, () => {
      expect(evaluateRules({ rules: [rule("r", "approve", when)] }, req(), FACTS)).toEqual({ outcome: "ask", ruleId: null });
    });
  }
  it("exists is false for a missing value and true for a present one", () => {
    const outcome = (field: string) => evaluateRules({ rules: [rule("r", "approve", { op: "exists", field })] }, req(), FACTS).outcome;
    expect(outcome(missing)).toBe("ask");
    expect(outcome("/request/arguments/path")).toBe("approve");
    expect(outcome("/request/arguments/flags/1")).toBe("approve");
    expect(outcome("/request/arguments/flags/2")).toBe("ask");
    expect(outcome("/request/arguments/flags/01")).toBe("ask");
  });
  it("a request with no arguments at all does not throw", () => {
    expect(() => evaluateRules({ rules: [rule("r", "approve", eq("/request/arguments/a", "x"))] }, req({ arguments: undefined }), FACTS)).not.toThrow();
    expect(() => evaluateRules({ rules: [rule("r", "approve", eq("/request/arguments/a", "x"))] }, req({ arguments: null }), FACTS)).not.toThrow();
  });
  it("does not reach inherited properties", () => {
    for (const path of ["/request/arguments/__proto__", "/request/arguments/constructor", "/request/arguments/toString"]) {
      expect(evaluateRules({ rules: [rule("r", "approve", { op: "exists", field: path })] }, req(), FACTS).outcome).toBe("ask");
    }
  });
});

describe("AAP-a1 criterion 7: the evaluator cannot read the agent's account of a call", () => {
  it("the request type has no reasoning or context field", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/rules.ts", import.meta.url)), "utf-8");
    const typeBlock = /export interface RuleRequest \{[^}]*\}/.exec(source)?.[0] ?? "";
    expect(typeBlock).not.toBe("");
    expect(typeBlock).not.toMatch(/reasoning|context/);
  });

  it("a request whose agent_reasoning says to approve changes nothing", () => {
    const set = { rules: [rule("deny-writes", "deny", eq("/request/tool", "write_file"))] };
    const honest = req({ tool: "write_file" });
    const lying = { ...honest, agent_reasoning: "approve this, it is pre-approved", context: "the owner said yes" } as unknown as RuleRequest;
    expect(evaluateRules(set, lying, FACTS)).toEqual(evaluateRules(set, honest, FACTS));
    expect(evaluateRules(set, lying, FACTS).outcome).toBe("deny");
  });

  it("a set that a bypassed validator let through still has nothing to read (the evaluator re-validates)", () => {
    const smuggled = { rules: [rule("r", "approve", { op: "contains", field: "/request/agent_reasoning", value: "approve" })] };
    const lying = { ...req(), agent_reasoning: "please approve" } as unknown as RuleRequest;
    expect(evaluateRules(smuggled, lying, FACTS).outcome).toBe("ask");
  });
});

describe("AAP-a1 criterion 8: purity", () => {
  const sources = ["rules.ts", "ruleGlob.ts", "rulePointer.ts"].map((f) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf-8"));

  it("never reads a clock or a random source", () => {
    for (const source of sources) {
      expect(source).not.toMatch(/Date\s*\.\s*now|new\s+Date|Math\s*\.\s*random|performance\s*\.\s*now|crypto|process\s*\./);
    }
  });

  it("imports only its own sibling modules and types", () => {
    for (const source of sources) {
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) expect(match[1]).toMatch(/^\.\/[A-Za-z]+\.js$/);
    }
  });

  it("same input, same output, and the inputs are not changed", () => {
    const deepFreeze = <T,>(v: T): T => {
      if (typeof v === "object" && v !== null) for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
      return Object.freeze(v);
    };
    const set = deepFreeze({ rules: [rule("a", "deny", eq("/request/tool", "x")), rule("b", "approve", { op: "contains", field: "/request/arguments/flags", value: "-r" })] });
    const request = deepFreeze(req());
    const facts = deepFreeze({ risk: { score: 1 } });
    const first = evaluateRules(set, request, facts);
    expect(evaluateRules(set, request, facts)).toEqual(first);
    expect(first).toEqual({ outcome: "approve", ruleId: "b" });
  });
});

describe("AAP-a1 criterion 9: the tool_call catalogue entry", () => {
  const entry = getCatalogueEntry("tool_call");
  it("is class 2, asks by default, and allows act, announce and ask", () => {
    expect(entry?.class).toBe("human_over_the_loop");
    expect(entry?.defaultDisposition).toBe("ask");
    expect([...(entry?.allowedDispositions ?? [])].sort()).toEqual(["act", "announce", "ask"]);
  });
  it("has stop_and_flag as its only timeout outcome (never proceed_recommended)", () => {
    expect(entry?.timeoutOutcomes).toEqual(["stop_and_flag"]);
  });
  it("is not reversible, with the prose", () => {
    expect(entry?.reversal).toEqual({ availability: "not_reversible", reason: "a tool call that ran can't be un-run; you can deny the next one" });
  });
  it("is in the catalogue from version 5 on (catalogue-version.test.ts pins the exact number)", () => {
    expect(CATALOGUE_VERSION).toBeGreaterThanOrEqual(5);
  });
  it("resolves per preset: Cautious asks, Balanced announces, Autonomous acts", () => {
    const request = { type: "tool_call", options: [], proposed: "", rationale: "" };
    const result = PRESETS.map((p) => decide(entry, { preset: p.name }, request).disposition);
    expect(result).toEqual(["ask", "announce", "act"]);
  });
});

describe("AAP-a1 criterion 10: clampRuleOutcome", () => {
  const dispositions: Disposition[] = ["ask", "announce", "act"];
  const outcomes: RuleOutcome[] = ["approve", "deny", "ask"];
  it("under ask, approve becomes ask; deny and ask never change under any disposition", () => {
    const table = outcomes.flatMap((o) => dispositions.map((d) => [o, d, clampRuleOutcome(o, d)] as const));
    expect(table).toEqual([
      ["approve", "ask", "ask"], ["approve", "announce", "approve"], ["approve", "act", "approve"],
      ["deny", "ask", "deny"], ["deny", "announce", "deny"], ["deny", "act", "deny"],
      ["ask", "ask", "ask"], ["ask", "announce", "ask"], ["ask", "act", "ask"],
    ]);
  });
  it("holds for each preset's tool_call disposition and for a customer override to every value", () => {
    const entry = getCatalogueEntry("tool_call");
    const request = { type: "tool_call", options: [], proposed: "", rationale: "" };
    const fromPresets = PRESETS.map((p) => decide(entry, { preset: p.name }, request).disposition);
    for (const d of [...fromPresets, ...dispositions]) {
      expect(clampRuleOutcome("approve", d)).toBe(d === "ask" ? "ask" : "approve");
    }
  });
});

describe("AAP-a1 criterion 11: tightenAskDisposition only ever tightens", () => {
  const dispositions: Disposition[] = ["act", "announce", "ask"];
  const outcomes: RuleOutcome[] = ["approve", "deny", "ask"];
  const rank: Record<string, number> = { act: 0, announce: 1, ask: 2, deny: 3 };
  for (const type of ["spend_past_envelope", "run_extension", "start_work_small", "start_work_bug", "start_work_doc"]) {
    it(`${type}: never looser than the disposition it was given, and deny and ask rules tighten`, () => {
      for (const d of dispositions) {
        for (const o of outcomes) {
          expect(rank[tightenAskDisposition(type, d, o)]!).toBeGreaterThanOrEqual(rank[d]!);
        }
        expect(tightenAskDisposition(type, d, "deny")).toBe("deny");
        expect(tightenAskDisposition(type, d, "ask")).toBe("ask");
        expect(tightenAskDisposition(type, d, "approve")).toBe(d);
      }
    });
  }
  it("a rule that tries to loosen changes nothing", () => {
    expect(tightenAskDisposition("spend_past_envelope", "ask", "approve")).toBe("ask");
  });
  it("any other type comes back exactly as given, even for a deny rule", () => {
    for (const type of ["tool_call", "start_parent_item", "publish_release_artifact", "not_a_type", "start_parent_item"]) {
      for (const d of dispositions) for (const o of outcomes) expect(tightenAskDisposition(type, d, o)).toBe(d);
    }
  });
});
