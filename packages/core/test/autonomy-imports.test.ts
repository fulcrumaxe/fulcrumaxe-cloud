import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * This is a tripwire against accidental impure imports, not a proof of purity. It reads import specifiers as text, so a
 * deliberately built specifier (a template literal or string concatenation passed to import(), `process["env"]`,
 * `globalThis.fetch`, or a call hidden on a line the comment stripper eats) gets past it. Review catches what it cannot.
 *
 * D#483 S5-a (S5a-4): the start resolver is pure. Its module may import `@fx/decisions` and its own siblings and nothing else:
 * no HTTP client, model SDK, database client, filesystem or clock-bearing package can get in without failing this test. An allowlist
 * rather than a deny list, so a package nobody thought of is refused too.
 */
const DIR = fileURLToPath(new URL("../src/autonomy", import.meta.url));
const ALLOWED = (specifier: string): boolean => specifier === "@fx/decisions" || /^\.\/[A-Za-z0-9_-]+\.js$/.test(specifier);

const SPECIFIER_RES = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
];

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const re of SPECIFIER_RES) for (const m of source.matchAll(re)) found.push(m[1]!);
  return found;
}
const offenders = (source: string): string[] => specifiersOf(source).filter((s) => !ALLOWED(s));

describe("the autonomy module imports only @fx/decisions and its siblings", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

  it("finds the resolver files (not vacuous)", () => {
    expect(files).toEqual(expect.arrayContaining(["resolveStart.ts", "resolveSubItemLaunch.ts", "index.ts"]));
  });

  for (const file of files) {
    it(`${file} imports nothing else`, () => {
      expect(offenders(readFileSync(join(DIR, file), "utf8"))).toEqual([]);
    });
    it(`${file} makes no fetch call and reads no clock`, () => {
      const source = readFileSync(join(DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(source).not.toMatch(/\bfetch\s*\(|\bDate\b|\bperformance\.now\b|\bprocess\.env\b|Math\.random/);
    });
  }

  it("the checker catches every import spelling it should (non-vacuity)", () => {
    for (const bad of [
      `import { Pool } from "pg";`,
      `import { x } from "@fx/db/src/pool.js";`,
      `import "node:fs";`,
      `const m = await import("undici");`,
      `const m = require("@anthropic-ai/sdk");`,
      `import { y } from "../plan/ownerProcess.js";`,
      `export * from "@fx/runtime";`,
    ]) {
      expect(offenders(bad), bad).not.toEqual([]);
    }
    expect(offenders(`import { decide } from "@fx/decisions";\nexport * from "./resolveStart.js";`)).toEqual([]);
  });
});
