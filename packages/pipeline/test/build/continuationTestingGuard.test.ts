import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", ".git", "test", "tests", "e2e", "__tests__"]);
const SELF = path.join("packages", "pipeline", "src", "build", "continuationTesting.ts");

/** Matches the subpath, and a relative or deep import of the file that holds it. */
const TEST_ONLY_IMPORT = /["'][^"']*(?:testing\/continuation|continuationTesting)(?:\.js)?["']/;

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) productionFiles(full, out);
    } else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !/\.(?:test|spec)\./.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const allProduction = (): string[] => [...productionFiles(path.join(REPO_ROOT, "packages")), ...productionFiles(path.join(REPO_ROOT, "apps"))];

describe("continuation test-only entry point", () => {
  it("the matcher catches each way of importing it", () => {
    for (const line of [
      'import { continueWorkItemLocked } from "@fx/pipeline/testing/continuation";',
      'import { continueAfterLimitLocked } from "../build/continuationTesting.js";',
      'const m = await import("@fx/pipeline/testing/continuation");',
    ]) {
      expect(TEST_ONLY_IMPORT.test(line), line).toBe(true);
    }
    expect(TEST_ONLY_IMPORT.test('import { continueWorkItem } from "@fx/pipeline";')).toBe(false);
  });

  it("scans a non-zero number of production files, including the entry point itself", () => {
    const files = allProduction();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(SELF))).toBe(true);
  });

  it("no production file imports it", () => {
    const offenders = allProduction()
      .filter((f) => !f.endsWith(SELF))
      .filter((f) => readFileSync(f, "utf8").split("\n").some((line) => TEST_ONLY_IMPORT.test(line)))
      .map((f) => path.relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("the barrel does not re-export the locked functions", async () => {
    const barrel = await import("../../src/index.js");
    expect("continueAfterLimitLocked" in barrel).toBe(false);
    expect("continueWorkItemLocked" in barrel).toBe(false);
    expect("continueWorkItem" in barrel).toBe(true);
  });
});
