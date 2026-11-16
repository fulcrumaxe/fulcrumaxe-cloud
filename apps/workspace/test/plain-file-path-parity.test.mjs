// The Pipeline card draws "Files added to the Spec's file list" only for paths the server will accept, so the card's `isPlainFilePath` must answer exactly as the server's
// `isPlainScopeFile` (packages/runner-protocol/src/acceptanceScope.ts) does. One shared list of paths, valid and every refusal class, goes to both and the answers must agree.
import { describe, expect, it } from "vitest";
import { isPlainFilePath } from "../apps/pipeline/pipeline-actions.js";
import { isPlainScopeFile } from "../../../packages/runner-protocol/src/acceptanceScope.ts";

const VALID = [
  "a.ts",
  "packages/example/test/sample.pg.test.ts",
  "docs/ops/a-b_c.md",
  "@scope/x+y=z.ts",
  "_x/a.ts",
  "+x/a.ts",
  "src/.hidden/a.ts",
  "src/a.test.ts",
  "x".repeat(255),
];

const REFUSED = {
  "empty": "",
  "directory": "src/",
  "absolute": "/src/a.ts",
  "empty segment": "src//a.ts",
  "dot segment": "./a.ts",
  "dot segment inside": "src/./a.ts",
  "dot-dot": "../a.ts",
  "dot-dot inside": "src/../a.ts",
  "leading dot": ".github/a.yml",
  "leading dash": "-a.ts",
  "subtree glob": "src/**",
  "lone glob": "**",
  "star": "src/*.ts",
  "question mark": "src/a?.ts",
  "brace group": "src/{a,b}.ts",
  "comma": "a,b.ts",
  "square bracket route": "app/[id]/page.tsx",
  "catch-all route": "app/[...slug]/page.tsx",
  "parenthesis route": "app/(group)/page.tsx",
  "stray bracket": "src/[a.ts",
  "colon": "src/a:b.ts",
  "space": "src/a b.ts",
  "backslash": "src\\a.ts",
  "non-ASCII": "src/é.ts",
  "NUL": "src/a\u0000.ts",
  "newline": "src/a\n.ts",
  "trailing newline": "a.ts\n",
  "over 255 characters": "x".repeat(256),
  "over 512 characters": "x".repeat(513),
};

const NOT_STRINGS = [null, undefined, 1, true, {}, ["a.ts"]];

describe("the card's isPlainFilePath answers as the server's isPlainScopeFile", () => {
  it("accepts every valid path on both", () => {
    for (const p of VALID) {
      expect(isPlainScopeFile(p), `server: ${p}`).toBe(true);
      expect(isPlainFilePath(p), `card: ${p}`).toBe(true);
    }
  });

  it("refuses every refusal class on both, and a path with brackets is refused (they are glob syntax to the scope matcher)", () => {
    for (const [why, p] of Object.entries(REFUSED)) {
      expect(isPlainScopeFile(p), `server: ${why}`).toBe(false);
      expect(isPlainFilePath(p), `card: ${why}`).toBe(false);
    }
  });

  it("refuses anything that is not a string on both", () => {
    for (const v of NOT_STRINGS) {
      expect(isPlainScopeFile(v)).toBe(false);
      expect(isPlainFilePath(v)).toBe(false);
    }
  });

  it("agrees on the whole shared list (so a new entry cannot make them drift)", () => {
    for (const p of [...VALID, ...Object.values(REFUSED), ...NOT_STRINGS]) expect(isPlainFilePath(p)).toBe(isPlainScopeFile(p));
  });
});
