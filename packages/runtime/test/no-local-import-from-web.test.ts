import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FX_LOCAL_RUNNER_MARKER } from "../src/local/index.js";

const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;
// apps/web does not exist yet in this task's file scope (H01 owns it) — this
// walk is written to be correct once it does, and to trivially pass (zero
// files scanned) until then. Spec H04 pass/fail 4.
const APPS_WEB_DIR = path.join(PACKAGE_ROOT, "..", "..", "apps", "web");

const FORBIDDEN_IMPORT_PATTERNS = [
  /packages\/runtime\/src\/local/,
  /@fx\/runtime\/local/,
];

async function walkFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("local runner isolation (Spec H04 pass/fail 4)", () => {
  it("runner (a) source contains the FX_LOCAL_RUNNER_MARKER string", () => {
    expect(FX_LOCAL_RUNNER_MARKER).toBe("FX_LOCAL_RUNNER_MARKER");
  });

  it("no file under apps/web statically imports packages/runtime/src/local", async () => {
    const files = await walkFiles(APPS_WEB_DIR);
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
