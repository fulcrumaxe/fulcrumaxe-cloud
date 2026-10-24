import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listSourcePaths } from "../../test-guard/src/sourceFiles.js";

const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;
const REPO_ROOT = path.join(PACKAGE_ROOT, "..", "..");

// The package name is assembled at run time: a literal import specifier in this file would count as a dependency of
// @fx/runtime for the declared-imports check, and this test exists to keep the name out of the web app.
const PACKAGE_DIR = ["fx", "runner"].join("-");
const PACKAGE_NAME = ["@fulcrumaxe", PACKAGE_DIR].join("/");
const importLine = (specifier: string): string => ["import { x } from", `${JSON.stringify(specifier)};`].join(" ");

// The local runner runs on a customer's machine. The web app must never import it, by package name or by path.
// An import, dynamic import or require whose specifier names either, or a dependency entry in a package.json.
const FORBIDDEN = [
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`][^"'`]*(?:@fulcrumaxe\/fx-runner|packages\/fx-runner)/m,
  /"@fulcrumaxe\/fx-runner"\s*:/,
];

/** Git's file list under apps/web, not a directory walk: a web build's ignored output (bundles, their debug maps) is not the app's source. */
const webFiles = (): string[] => listSourcePaths(REPO_ROOT, ["apps/web"], ["node_modules", ".next"]).filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(f));

describe("the web app never imports fx-runner (D#6)", () => {
  it("no file under apps/web, its package.json included, names the package or its path", async () => {
    const offenders: string[] = [];
    for (const file of webFiles()) {
      const contents = await readFile(file, "utf8");
      if (FORBIDDEN.some((pattern) => pattern.test(contents))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("the shared lint config restricts the package name, its subpaths and its directory", () => {
    const rules = createRequire(import.meta.url)("../eslint-rules.cjs") as { rules: { "no-restricted-imports": [string, { patterns: Array<{ group: string[] }> }] } };
    const groups = rules.rules["no-restricted-imports"][1].patterns.flatMap((pattern) => pattern.group);
    for (const pattern of [PACKAGE_NAME, `${PACKAGE_NAME}/*`, `**/packages/${PACKAGE_DIR}`, `**/packages/${PACKAGE_DIR}/*`]) expect(groups).toContain(pattern);
  });

  it("a violation fixture makes the scan go red", () => {
    const fixtures = [importLine(PACKAGE_NAME), importLine(`../../packages/${PACKAGE_DIR}/src/index`)];
    for (const text of fixtures) expect(FORBIDDEN.some((pattern) => pattern.test(text))).toBe(true);
  });
});
