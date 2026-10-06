import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isNextRoleRequestField } from "../src/next-role-request";

const CARDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cards");
const FIELD = '"next_role_request":';

/**
 * Extracts the JSON value that follows a `"next_role_request":` key at
 * `text[start]`, respecting quoted strings so a literal `{` or `}` inside a
 * placeholder like `"{list}"` never miscounts as a brace. Returns the raw
 * JSON text and the index right after it, or null if `start` isn't
 * immediately followed by `null` or a balanced `{...}`.
 */
function extractJsonValue(text: string, start: number): { json: string; end: number } | null {
  let i = start;
  while (i < text.length && /\s/.test(text.charAt(i))) i++;

  if (text.startsWith("null", i)) {
    return { json: "null", end: i + 4 };
  }
  if (text.charAt(i) !== "{") return null;

  const openIndex = i;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { json: text.slice(openIndex, i + 1), end: i + 1 };
    }
  }
  return null;
}

/** Every `next_role_request` example embedded in a card's prose, parsed. */
function findExamples(text: string): Array<{ raw: string; parsed: unknown }> {
  const out: Array<{ raw: string; parsed: unknown }> = [];
  let searchFrom = 0;
  while (true) {
    const keyIndex = text.indexOf(FIELD, searchFrom);
    if (keyIndex === -1) break;
    const extracted = extractJsonValue(text, keyIndex + FIELD.length);
    if (!extracted) {
      throw new Error(
        `found "${FIELD}" with no parseable null/object value right after it (near index ${keyIndex})`,
      );
    }
    out.push({ raw: extracted.json, parsed: JSON.parse(extracted.json) });
    searchFrom = extracted.end;
  }
  return out;
}

function cardFiles(): string[] {
  return readdirSync(CARDS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

describe("next_role_request contract (H08 fix round: canonical shape)", () => {
  it("every embedded example parses as JSON and matches NextRoleRequestField", () => {
    const failures: string[] = [];
    let totalExamples = 0;

    for (const file of cardFiles()) {
      const text = readFileSync(path.join(CARDS_DIR, file), "utf8");
      const examples = findExamples(text);
      for (const { raw, parsed } of examples) {
        totalExamples++;
        if (!isNextRoleRequestField(parsed)) {
          failures.push(`${file}: ${raw}`);
        }
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
    // Sanity: this test is only meaningful if it actually found examples.
    expect(totalExamples).toBeGreaterThan(0);
  });

  it("no card uses the old singular {\"role\": \"<name>\"} shape", () => {
    for (const file of cardFiles()) {
      const text = readFileSync(path.join(CARDS_DIR, file), "utf8");
      expect(text, file).not.toMatch(/"role"\s*:\s*"/);
    }
  });

  it("at least one example is a multi-role fan-out (the consensus panel)", () => {
    let sawFanOut = false;
    for (const file of cardFiles()) {
      const text = readFileSync(path.join(CARDS_DIR, file), "utf8");
      for (const { parsed } of findExamples(text)) {
        if (isNextRoleRequestField(parsed) && parsed && parsed.roles.length > 1) {
          sawFanOut = true;
        }
      }
    }
    expect(sawFanOut).toBe(true);
  });

  it("the type check actually rejects a malformed example (deliberate fixture)", () => {
    expect(isNextRoleRequestField({ role: "executor", reason: "x", context: "y" })).toBe(false);
    expect(isNextRoleRequestField({ roles: [], reason: "x", context: "y" })).toBe(false);
    expect(isNextRoleRequestField({ roles: ["executor"] })).toBe(false);
    expect(isNextRoleRequestField(null)).toBe(true);
    expect(isNextRoleRequestField({ roles: ["executor"], reason: "x", context: "y" })).toBe(true);
  });

  it("the extractor itself is red on an unparseable fixture, proving it isn't vacuous", () => {
    const broken = '"next_role_request": { "roles": ["executor" }'; // missing closing bracket
    expect(() => findExamples(broken)).toThrow();
  });
});
