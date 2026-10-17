import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DECISION_REQUEST_LIMITS, isDecisionsTakenField, parseDecisionsTakenField } from "../src/decision-request";

/** D#7 DP4b-2 criterion 1 (R-7-DP4b-7): the `decisions_taken` field, a total parser in DP4a's shape. */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIELD = '"decisions_taken":';

const entry = () => ({
  type: "d1",
  options: [
    { id: "keep", label: "Keep the current shape" },
    { id: "split", label: "Split it in two" },
  ],
  chosen: "keep",
  rationale: "Smaller diff, same behaviour.",
});

const codeOf = (v: unknown): string | null => {
  const r = parseDecisionsTakenField(v);
  return r.ok ? null : r.error.code;
};

describe("D#7 DP4b-2 criterion 1: the decisions_taken field", () => {
  it("accepts null, an empty list and well-formed entries, and returns a fresh copy", () => {
    expect(parseDecisionsTakenField(null)).toEqual({ ok: true, value: null });
    expect(parseDecisionsTakenField([])).toEqual({ ok: true, value: [] });
    const input = [entry(), { ...entry(), type: "d2" }];
    const r = parseDecisionsTakenField(input);
    expect(r).toEqual({ ok: true, value: input });
    if (r.ok && r.value) {
      expect(r.value[0]).not.toBe(input[0]);
      expect(r.value[0]!.options[0]).not.toBe(input[0]!.options[0]);
    }
    expect(isDecisionsTakenField(null)).toBe(true);
    expect(isDecisionsTakenField([entry()])).toBe(true);
  });

  it("refuses anything that is not a list or null, and a list holding a non-object, with a named code and without throwing", () => {
    for (const bad of [undefined, 0, "x", true, {}, entry()]) {
      expect(codeOf(bad), String(bad)).toBe("not_an_object");
      expect(isDecisionsTakenField(bad)).toBe(false);
    }
    for (const bad of [null, "x", 1, [], [entry()]]) expect(codeOf([bad]), String(bad)).toBe("not_an_object");
  });

  it("table: every malformed entry gives its own code", () => {
    const cases: Array<[string, (e: ReturnType<typeof entry>) => unknown, string]> = [
      ["missing type", ({ type: _t, ...rest }) => rest, "bad_type"],
      ["type with upper case", (e) => ({ ...e, type: "D1" }), "bad_type"],
      ["type too long", (e) => ({ ...e, type: "a".repeat(DECISION_REQUEST_LIMITS.typeMax + 1) }), "bad_type"],
      ["one option", (e) => ({ ...e, options: [e.options[0]] }), "bad_options"],
      ["seven options", (e) => ({ ...e, options: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: "x" })) }), "bad_options"],
      ["option with an extra key", (e) => ({ ...e, options: [e.options[0], { ...e.options[1], class: "x" }] }), "bad_option"],
      ["option id deny", (e) => ({ ...e, options: [e.options[0], { id: "deny", label: "x" }] }), "bad_option"],
      ["label over 200", (e) => ({ ...e, options: [e.options[0], { id: "split", label: "x".repeat(201) }] }), "bad_option"],
      ["duplicate ids", (e) => ({ ...e, options: [e.options[0], { id: "keep", label: "again" }] }), "duplicate_option_id"],
      ["chosen not among options", (e) => ({ ...e, chosen: "merge" }), "bad_chosen"],
      ["chosen deny", (e) => ({ ...e, chosen: "deny" }), "bad_chosen"],
      ["missing chosen", ({ chosen: _c, ...rest }) => rest, "bad_chosen"],
      ["proposed in place of chosen", ({ chosen: _c, ...rest }) => ({ ...rest, proposed: "keep" }), "unknown_field"],
      ["empty rationale", (e) => ({ ...e, rationale: "  " }), "bad_rationale"],
      ["rationale over 1 KiB in bytes", (e) => ({ ...e, rationale: "é".repeat(513) }), "bad_rationale"],
      ["missing rationale", ({ rationale: _r, ...rest }) => rest, "bad_rationale"],
      ["unknown key", (e) => ({ ...e, reason: "x" }), "unknown_field"],
    ];
    for (const [name, mutate, code] of cases) expect(codeOf([mutate(entry())]), name).toBe(code);
  });

  it("the first fault in the list names the refusal, wherever it is", () => {
    expect(codeOf([entry(), entry(), { ...entry(), chosen: "nope" }])).toBe("bad_chosen");
  });

  it("class_not_allowed: a class key in any entry, with any value, is refused by name (C2)", () => {
    for (const cls of ["automated_with_monitoring", "human_in_the_loop", "", null, 1]) {
      expect(codeOf([entry(), { ...entry(), class: cls }]), String(cls)).toBe("class_not_allowed");
    }
  });

  it("boundaries: 50 entries pass, 51 are refused whole; a 1024-byte rationale passes", () => {
    expect(codeOf(Array.from({ length: DECISION_REQUEST_LIMITS.takenMax }, entry))).toBeNull();
    expect(codeOf(Array.from({ length: DECISION_REQUEST_LIMITS.takenMax + 1 }, entry))).toBe("too_many_entries");
    expect(codeOf([{ ...entry(), rationale: "a".repeat(1024) }])).toBeNull();
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: "x".repeat(200) }));
    expect(codeOf([{ ...entry(), options: six, chosen: "o5" }])).toBeNull();
  });

  it("the shape is the request's, so the two cannot drift: the same fault gives the same code", () => {
    // A request has `proposed` and a 4 KiB rationale; an entry has `chosen` and 1 KiB. Everything else is one parser.
    expect(codeOf([{ ...entry(), type: "Bad" }])).toBe("bad_type");
    expect(codeOf([{ ...entry(), options: "keep" }])).toBe("bad_options");
  });
});

/** Every `decisions_taken` example embedded in a card's prose, parsed (`null` or a bracketed list). Bracket-aware and string-aware. */
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
    if (text.charAt(i) !== "[") throw new Error(`"${FIELD}" with no null or list after it (near index ${key})`);
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
      else if (ch === "[") depth++;
      else if (ch === "]" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end === -1) throw new Error(`unbalanced list after "${FIELD}" (near index ${key})`);
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

describe("D#7 DP4b-2 criterion 1: every embedded decisions_taken example matches the validator", () => {
  it("every example in cards/ and cards-product/ is a valid DecisionsTakenField", () => {
    const failures: string[] = [];
    for (const { file, text } of [...cardTexts("cards"), ...cardTexts("cards-product")]) {
      for (const { raw, parsed } of findExamples(text)) if (!isDecisionsTakenField(parsed)) failures.push(`${file}: ${raw}`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("the extractor is not vacuous: it finds valid fixtures, and a fixture with a class or an unbalanced list is flagged", () => {
    const good = `Emit ${FIELD} ${JSON.stringify([entry()])} and ${FIELD} null.`;
    expect(findExamples(good).map((f) => isDecisionsTakenField(f.parsed))).toEqual([true, true]);
    const bad = findExamples(`${FIELD} ${JSON.stringify([{ ...entry(), class: "human_in_the_loop" }])}`);
    expect(bad).toHaveLength(1);
    expect(isDecisionsTakenField(bad[0]?.parsed)).toBe(false);
    expect(() => findExamples(`${FIELD} [ { "type": "x"`)).toThrow();
  });
});
