import { describe, expect, it } from "vitest";
import { ContextLedgerCapture } from "../src/contextLedger.js";
import { EXCLUDE_PROMPT_LINE, MAX_EXCLUDE_RULES, disabledToolsFor, escapeRulePath, excludeDenyRules, isRuleablePath } from "../src/excludeRules.js";

/** D#600 CX-5b / CX-5c: the one copy of the exclude helpers, used by the cloud's sandbox runner and by the local runner. */
describe("escapeRulePath", () => {
  it("leaves a glob a glob, and escapes only what would change it unasked", () => {
    expect(escapeRulePath("src/**/[ab].ts")).toBe("src/**/[ab].ts");
    expect(escapeRulePath("a{b,c}/*.ts")).toBe("a{b,c}/*.ts");
    expect(escapeRulePath("(group)/c.txt")).toBe("\\(group\\)/c.txt");
    expect(escapeRulePath("!x")).toBe("\\\\!x");
    expect(escapeRulePath("#x")).toBe("\\\\#x");
    expect(escapeRulePath("x ")).toBe("x\\\\ ");
    expect(escapeRulePath("plain/path.txt")).toBe("plain/path.txt");
  });

  it("escapes [ ] { } as well in literal mode, so a Next.js path means that one file", () => {
    expect(escapeRulePath("app/[id]/page.tsx", "literal")).toBe("app/\\\\[id\\\\]/page.tsx");
    expect(escapeRulePath("a{b}", "literal")).toBe("a\\\\{b\\\\}");
    expect(escapeRulePath("app/[id]/page.tsx", "glob")).toBe("app/[id]/page.tsx");
  });
});

describe("excludeDenyRules", () => {
  it("is empty for no excludes (the golden: no deny entries are added)", () => {
    expect(excludeDenyRules([])).toEqual([]);
    expect(disabledToolsFor([])).toEqual([]);
    expect(disabledToolsFor(undefined)).toEqual([]);
  });

  it("writes Read(path) and Read(path/**) for each path, sorted and once, then bare Grep and Glob once", () => {
    expect(excludeDenyRules(["secret/a.txt", "keys", "keys"])).toEqual(["Read(keys)", "Read(keys/**)", "Read(secret/a.txt)", "Read(secret/a.txt/**)", "Grep", "Glob"]);
    expect(excludeDenyRules(["b", "a"])).toEqual(excludeDenyRules(["a", "b"]));
    expect(disabledToolsFor(["a"])).toEqual(["Grep", "Glob"]);
  });

  it("fails closed: a path that cannot be a rule, or more than 500 paths, throws and writes nothing", () => {
    for (const bad of ["", "/abs", "~/x", "a/../b", "a//b", "a\\b", "a\nb", "a".repeat(513)]) expect(() => excludeDenyRules(["ok", bad]), JSON.stringify(bad)).toThrow();
    expect(() => excludeDenyRules(Array.from({ length: MAX_EXCLUDE_RULES + 1 }, (_, i) => `p/${i}`))).toThrow();
    expect(excludeDenyRules(Array.from({ length: MAX_EXCLUDE_RULES }, (_, i) => `p/${i}`))).toHaveLength(MAX_EXCLUDE_RULES * 2 + 2);
  });

  it("refuses exactly the paths isRuleablePath refuses", () => {
    for (const p of ["a", "a/b", "(x)", "[y]", "~x", "/a", "", "a/./b", "a//b", "a/..", "a\\b"]) {
      let threw = false;
      try {
        excludeDenyRules([p]);
      } catch {
        threw = true;
      }
      expect(threw, JSON.stringify(p)).toBe(!isRuleablePath(p));
    }
  });

  it("has one prompt line that says it is not a security boundary", () => {
    expect(EXCLUDE_PROMPT_LINE).toContain("not a security boundary");
  });
});

describe("counting refusals with the disabled tools of a run", () => {
  const call = (id: string, name: string) => ({ type: "assistant", message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input: {} }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const result = (id: string, text: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] } });

  it("counts a permission refusal, and counts 'No such tool available' only for a tool the run's settings turned off", () => {
    const off = new ContextLedgerCapture(disabledToolsFor(["secret"]));
    const on = new ContextLedgerCapture();
    for (const c of [off, on]) {
      c.observe(call("r1", "Read"));
      c.observe(result("r1", "Permission to use Read has been denied."));
      c.observe(call("g1", "Grep"));
      c.observe(result("g1", "Error: No such tool available: Grep. Grep exists but is not enabled in this context."));
    }
    expect(off.deniedToolCalls()).toBe(2);
    expect(on.deniedToolCalls()).toBe(1);
  });
});
