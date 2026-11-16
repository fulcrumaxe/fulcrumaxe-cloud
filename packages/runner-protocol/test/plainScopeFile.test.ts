import { describe, expect, it } from "vitest";
import { isPlainScopeFile, parseAcceptanceScope } from "../src/acceptanceScope.js";

/** The one entry form a person or an assistant may ADD to a Spec's file list: an exact file path. */
describe("isPlainScopeFile", () => {
  it("accepts exact repo-relative paths", () => {
    for (const p of ["a.ts", "packages/example/test/sample.pg.test.ts", "docs/ops/a-b_c.md", "@scope/x+y=z.ts"]) {
      expect(isPlainScopeFile(p), p).toBe(true);
      // what it accepts, the scope reader reads as exactly that one entry
      expect(parseAcceptanceScope([p])).toEqual({ kind: "known", entries: [p] });
    }
  });

  it("refuses a Next.js route path: brackets and parentheses are glob syntax to the scope matcher, so they never appear in an added entry", () => {
    for (const p of ["app/[id]/page.tsx", "app/(group)/page.tsx", "app/(group)/[id]/page.tsx", "app/[...slug]/page.tsx", "src/[a.ts"]) expect(isPlainScopeFile(p), p).toBe(false);
  });

  it("refuses a directory, a glob, a brace group, a traversal, an absolute path, a colon, a non-ASCII or control character, a space, a backslash and anything that is not a string", () => {
    const bad = ["", "src/", "/src/a.ts", "src//a.ts", "./a.ts", "src/./a.ts", "../a.ts", "src/../a.ts", "src/**", "**", "src/*.ts", "src/a?.ts", "src/{a,b}.ts", "a,b.ts", "src/a:b.ts", "src/a b.ts", "src\\a.ts", "src/é.ts", "src/a\u0000.ts", "src/a\n.ts", ".github/a.yml", "x".repeat(256)];
    for (const p of bad) expect(isPlainScopeFile(p), JSON.stringify(p)).toBe(false);
    for (const v of [null, undefined, 1, {}, ["a.ts"]]) expect(isPlainScopeFile(v)).toBe(false);
  });
});
