import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DECISION_REQUEST_LIMITS,
  isDecisionRequestField,
  parseDecisionRequestField,
} from "../src/decision-request";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIELD = '"decision_request":';

const valid = () => ({
  type: "some_decision",
  options: [
    { id: "keep", label: "Keep the current shape" },
    { id: "split", label: "Split it in two" },
  ],
  proposed: "keep",
  rationale: "Smaller diff, same behaviour.",
});

const codeOf = (v: unknown): string | null => {
  const r = parseDecisionRequestField(v);
  return r.ok ? null : r.error.code;
};

describe("D#7 DP4a criterion 1: the decision_request field and its structural validator", () => {
  it("accepts null and a well-formed request, and returns a fresh copy", () => {
    expect(parseDecisionRequestField(null)).toEqual({ ok: true, value: null });
    const input = valid();
    const r = parseDecisionRequestField(input);
    expect(r).toEqual({ ok: true, value: input });
    if (r.ok && r.value) {
      expect(r.value).not.toBe(input);
      expect(r.value.options[0]).not.toBe(input.options[0]);
    }
    expect(isDecisionRequestField(null)).toBe(true);
    expect(isDecisionRequestField(valid())).toBe(true);
  });

  it("refuses anything that is not an object or null, with a named code and without throwing", () => {
    for (const bad of [undefined, 0, "x", true, [], [valid()]]) {
      expect(codeOf(bad), String(bad)).toBe("not_an_object");
      expect(isDecisionRequestField(bad)).toBe(false);
    }
  });

  it("table: every malformed field gives its own code", () => {
    const cases: Array<[string, (r: ReturnType<typeof valid>) => unknown, string]> = [
      ["missing type", ({ type: _t, ...rest }) => rest, "bad_type"],
      ["blank type", (r) => ({ ...r, type: "  " }), "bad_type"],
      ["type with upper case", (r) => ({ ...r, type: "Some_Decision" }), "bad_type"],
      ["type too long", (r) => ({ ...r, type: "a".repeat(DECISION_REQUEST_LIMITS.typeMax + 1) }), "bad_type"],
      ["options not an array", (r) => ({ ...r, options: "keep" }), "bad_options"],
      ["one option", (r) => ({ ...r, options: [r.options[0]] }), "bad_options"],
      ["seven options", (r) => ({ ...r, options: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: "x" })) }), "bad_options"],
      ["option not an object", (r) => ({ ...r, options: [r.options[0], "split"] }), "bad_option"],
      ["option with an extra key", (r) => ({ ...r, options: [r.options[0], { ...r.options[1], class: "x" }] }), "bad_option"],
      ["option id with upper case", (r) => ({ ...r, options: [r.options[0], { id: "Split", label: "x" }] }), "bad_option"],
      ["option id too long", (r) => ({ ...r, options: [r.options[0], { id: "a".repeat(33), label: "x" }] }), "bad_option"],
      ["option id deny", (r) => ({ ...r, options: [r.options[0], { id: "deny", label: "x" }] }), "bad_option"],
      ["empty label", (r) => ({ ...r, options: [r.options[0], { id: "split", label: "" }] }), "bad_option"],
      ["label over 200", (r) => ({ ...r, options: [r.options[0], { id: "split", label: "x".repeat(201) }] }), "bad_option"],
      ["duplicate ids", (r) => ({ ...r, options: [r.options[0], { id: "keep", label: "again" }] }), "duplicate_option_id"],
      ["proposed not among options", (r) => ({ ...r, proposed: "merge" }), "bad_proposed"],
      ["proposed deny", (r) => ({ ...r, proposed: "deny" }), "bad_proposed"],
      ["missing proposed", ({ proposed: _p, ...rest }) => rest, "bad_proposed"],
      ["empty rationale", (r) => ({ ...r, rationale: "   " }), "bad_rationale"],
      ["rationale over 4 KiB in bytes", (r) => ({ ...r, rationale: "é".repeat(2049) }), "bad_rationale"],
      ["missing rationale", ({ rationale: _x, ...rest }) => rest, "bad_rationale"],
    ];
    for (const [name, mutate, code] of cases) expect(codeOf(mutate(valid())), name).toBe(code);
  });

  it("boundaries: 6 options, a 200-character label, a 4096-byte rationale all pass", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: "x".repeat(200) }));
    expect(codeOf({ ...valid(), options: six, proposed: "o5", rationale: "a".repeat(4096) })).toBeNull();
  });

  it("refuses unknown keys by name", () => {
    expect(codeOf({ ...valid(), reason: "x" })).toBe("unknown_field");
    expect(codeOf({ ...valid(), next_role_request: null })).toBe("unknown_field");
  });
});

describe("D#7 DP4a / C2: a class supplied by the agent is refused, not honoured", () => {
  it("any value of class gets the named class_not_allowed error, whatever else is wrong or right", () => {
    for (const cls of ["automated_with_monitoring", "human_in_the_loop", "human_over_the_loop", "", null, 1, undefined]) {
      expect(codeOf({ ...valid(), class: cls }), String(cls)).toBe("class_not_allowed");
    }
    expect(codeOf({ class: "automated_with_monitoring" })).toBe("class_not_allowed");
    expect(isDecisionRequestField({ ...valid(), class: "automated_with_monitoring" })).toBe(false);
  });

  it("a request that arrives as JSON text keeps the refusal", () => {
    const smuggled = JSON.parse(
      `{"type":"some_decision","class":"automated_with_monitoring","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"proposed":"a","rationale":"r"}`,
    );
    expect(codeOf(smuggled)).toBe("class_not_allowed");
  });
});

/** Every `decision_request` example embedded in a card's prose, parsed. Brace-aware and string-aware. */
function findExamples(text: string): Array<{ raw: string; parsed: unknown }> {
  const out: Array<{ raw: string; parsed: unknown }> = [];
  let from = 0;
  for (;;) {
    const key = text.indexOf(FIELD, from);
    if (key === -1) return out;
    let i = key + FIELD.length;
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
    if (text.startsWith("null", i)) {
      out.push({ raw: "null", parsed: null });
      from = i + 4;
      continue;
    }
    if (text.charAt(i) !== "{") throw new Error(`"${FIELD}" with no null or object after it (near index ${key})`);
    const open = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (; i < text.length; i++) {
      const ch = text.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end === -1) throw new Error(`unbalanced object after "${FIELD}" (near index ${key})`);
    const raw = text.slice(open, end);
    out.push({ raw, parsed: JSON.parse(raw) });
    from = end;
  }
}

const cardTexts = (dir: string): Array<{ file: string; text: string }> =>
  readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => ({ file: `${dir}/${file}`, text: readFileSync(path.join(ROOT, dir, file), "utf8") }));

describe("D#7 DP4a criterion 1: every embedded decision_request example matches the validator", () => {
  it("every example in cards/ and cards-product/ is a valid DecisionRequestField", () => {
    const failures: string[] = [];
    for (const { file, text } of [...cardTexts("cards"), ...cardTexts("cards-product")]) {
      for (const { raw, parsed } of findExamples(text)) if (!isDecisionRequestField(parsed)) failures.push(`${file}: ${raw}`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("the extractor is not vacuous: it finds valid fixtures, and a fixture carrying a class is flagged", () => {
    const good = `Emit ${FIELD} ${JSON.stringify(valid())} and ${FIELD} null.`;
    expect(findExamples(good).map((f) => isDecisionRequestField(f.parsed))).toEqual([true, true]);
    const bad = findExamples(`${FIELD} ${JSON.stringify({ ...valid(), class: "human_in_the_loop" })}`);
    expect(bad).toHaveLength(1);
    expect(isDecisionRequestField(bad[0]?.parsed)).toBe(false);
    expect(() => findExamples(`${FIELD} { "type": "x"`)).toThrow();
  });
});

const POLICY_IMPORT = /from\s+["']@fx\/decisions|import\(\s*["']@fx\/decisions|require\(\s*["']@fx\/decisions/;

describe("D#7 DP4a: the agent-side contract never imports the policy (DP4 criterion 3, agent-side half)", () => {
  it("no file under packages/roles/src imports @fx/decisions", () => {
    const offenders = readdirSync(path.join(ROOT, "src"))
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => POLICY_IMPORT.test(readFileSync(path.join(ROOT, "src", f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the check is not vacuous: its pattern matches an import of the policy package", () => {
    expect(POLICY_IMPORT.test('import { decide } from "@fx/decisions";')).toBe(true);
    expect(POLICY_IMPORT.test('const m = await import("@fx/decisions");')).toBe(true);
  });
});
