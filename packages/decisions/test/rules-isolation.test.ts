import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * AAP-a1 criterion 12: a rule can never loosen a fixed invariant, because the layers that enforce them cannot see rules at all. Nothing in
 * `packages/gh-policy`, `packages/trust` or `packages/db/src/withTenant.ts` imports the decisions package (and so not its rules module).
 */
const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const IMPORTS_DECISIONS = /(?:from\s+|import\s*\(\s*|require\(\s*|import\s+)["'](?:@fx\/decisions(?:\/[^"']*)?|[./]+[^"']*\/decisions\/[^"']*|[./]+[^"']*rules(?:\.js)?)["']/;

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? (e.name === "node_modules" ? [] : listTs(full)) : e.name.endsWith(".ts") ? [full] : [];
  });
}

describe("AAP-a1 criterion 12: the fixed-invariant layers do not import rules", () => {
  it("scans real files (non-vacuity)", () => {
    expect(listTs(root("gh-policy/src")).length).toBeGreaterThan(0);
    expect(listTs(root("trust/src")).length).toBeGreaterThan(0);
  });

  it("gh-policy, trust and withTenant do not import @fx/decisions or any rules module", () => {
    const files = [...listTs(root("gh-policy/src")), ...listTs(root("trust/src")), root("db/src/withTenant.ts")];
    for (const file of files) {
      expect({ file, imports: IMPORTS_DECISIONS.test(readFileSync(file, "utf-8")) }).toEqual({ file, imports: false });
    }
  });

  it("the scan catches each way of importing the rules module", () => {
    for (const line of [
      'import { evaluateRules } from "@fx/decisions";',
      'import { evaluateRules } from "@fx/decisions/src/rules.js";',
      'import { evaluateRules } from "../../decisions/src/rules.js";',
      'import("@fx/decisions")',
      'const r = require("@fx/decisions");',
      'import { x } from "./rules.js";',
    ]) {
      expect(IMPORTS_DECISIONS.test(line), line).toBe(true);
    }
    expect(IMPORTS_DECISIONS.test('import { x } from "./decide.js";')).toBe(false);
  });
});
