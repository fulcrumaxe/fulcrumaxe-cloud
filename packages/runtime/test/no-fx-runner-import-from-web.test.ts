import { createRequire } from "node:module";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;
const APPS_WEB_DIR = path.join(PACKAGE_ROOT, "..", "..", "apps", "web");

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
    if ((await stat(full)).isDirectory()) files.push(...(await walkFiles(full)));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(entry)) files.push(full);
  }
  return files;
}

describe("the web app never imports fx-runner (D#6)", () => {
  it("no file under apps/web, its package.json included, names the package or its path", async () => {
    const offenders: string[] = [];
    for (const file of await walkFiles(APPS_WEB_DIR)) {
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
