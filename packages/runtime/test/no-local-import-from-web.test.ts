import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listSourcePaths } from "../../test-guard/src/sourceFiles.js";
import { FX_LOCAL_RUNNER_MARKER } from "../src/local/index.js";

const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;
const REPO_ROOT = path.join(PACKAGE_ROOT, "..", "..");

const FORBIDDEN_IMPORT_PATTERNS = [
  /packages\/runtime\/src\/local/,
  /@fx\/runtime\/local/,
];

/** Git's file list under apps/web, not a directory walk: a web build's ignored output is not the app's source (Spec H04 pass/fail 4). */
const webFiles = (): string[] => listSourcePaths(REPO_ROOT, ["apps/web"], ["node_modules", ".next"]).filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));

describe("local runner isolation (Spec H04 pass/fail 4)", () => {
  it("runner (a) source contains the FX_LOCAL_RUNNER_MARKER string", () => {
    expect(FX_LOCAL_RUNNER_MARKER).toBe("FX_LOCAL_RUNNER_MARKER");
  });

  it("no file under apps/web statically imports packages/runtime/src/local", async () => {
    const files = webFiles();
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      if (FORBIDDEN_IMPORT_PATTERNS.some((pattern) => pattern.test(contents))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a violation fixture in this scan proves the check goes red", async () => {
    const offenders: string[] = [];
    const fixtureContents = `import { createLocalRuntime } from "packages/runtime/src/local";\n`;
    if (FORBIDDEN_IMPORT_PATTERNS.some((pattern) => pattern.test(fixtureContents))) {
      offenders.push("fixture-violation.ts");
    }
    expect(offenders).toEqual(["fixture-violation.ts"]);
  });
});
