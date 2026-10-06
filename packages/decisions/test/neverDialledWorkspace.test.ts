/**
 * D#7 DP5 criterion 6: "A grep test finds no `neverDialled`, no
 * `never_dialled` and no equivalent flag identifier anywhere in the
 * workspace (C3)."
 *
 * DP1's `test/noNeverDialledFlag.test.ts` already checks this package's own
 * `src/` and `test/` (see that file's header) -- this is "the broader net"
 * its header comment names: every source file in the whole repo, not just
 * this package.
 *
 * The pattern requires that the match not be immediately preceded by a
 * letter (so it is not a bare substring match), so it does NOT flag:
 *   - a filename mention like `test/noNeverDialledFlag.test.ts` in prose
 *     (docs/status.md, packages/decisions/test/catalogue.test.ts) -- the
 *     match would sit inside the longer word "noNeverDialledFlag", preceded
 *     by the letter "o";
 *   - hyphenated human prose like "never-dialed" (docs/packages/decisions.md)
 *     -- a hyphen is not the optional underscore this pattern allows.
 * It DOES still flag a real identifier in any casing/spelling
 * (neverDialled, never_dialled, neverDialed, NEVER_DIALLED, ...), including
 * as a leading segment of a longer identifier (`neverDialledFlag`) or with
 * a non-letter prefix (`_neverDialledFlag`), which is the "equivalent flag
 * identifier" half of the criterion.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * DP1's file legitimately contains the literal identifier (it's the fixture
 * that proves ITS OWN package-local grep isn't vacuous) -- excluded here the
 * same way it excludes itself from its own scan. This file is excluded from
 * itself for the same reason: it has to name the identifier to search for.
 */
const EXCLUDED_FILES = new Set<string>([
  fileURLToPath(new URL("./noNeverDialledFlag.test.ts", import.meta.url)),
  THIS_FILE,
]);

const EXCLUDED_DIR_NAMES = new Set<string>([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".claude",
]);

const SCANNED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sql", ".md"];

/**
 * Not preceded by a letter -- so it flags a bare identifier or one where
 * this is the leading segment (`neverDialledFlag`, `_neverDialledFlag`),
 * but not where it sits inside a longer word after other letters
 * (`noNeverDialledFlag`). A hyphen never matches the optional single
 * underscore, so hyphenated prose ("never-dialed") is untouched.
 */
const BANNED_IDENTIFIER_RE = /(?<![A-Za-z])never_?dial(?:led|ed)/i;

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else if (entry.isFile() && SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

describe("D#7 DP5 criterion 6: no never-a-dial flag identifier anywhere in the workspace (C3)", () => {
  it("finds zero occurrences across the whole repo, excluding DP1's own deliberate fixture and this file", () => {
    const files = listFiles(REPO_ROOT).filter((f) => !EXCLUDED_FILES.has(f));
    expect(files.length).toBeGreaterThan(100);

    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      if (BANNED_IDENTIFIER_RE.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it("deliberate-failure fixture: the pattern matches the literal identifier in each named casing/spelling", () => {
    expect(BANNED_IDENTIFIER_RE.test("const neverDialled = true;")).toBe(true);
    expect(BANNED_IDENTIFIER_RE.test("const never_dialled = true;")).toBe(true);
    expect(BANNED_IDENTIFIER_RE.test("const neverDialed = true;")).toBe(true);
    expect(BANNED_IDENTIFIER_RE.test("NEVER_DIALLED_FIELD = true")).toBe(true);
  });

  it("deliberate-failure fixture: it still matches as a segment of a longer identifier", () => {
    expect(BANNED_IDENTIFIER_RE.test("const _neverDialledFlag = true;")).toBe(true);
  });

  it("does not flag a filename mention embedded in a longer camelCase word (the known false-positive shape)", () => {
    expect(BANNED_IDENTIFIER_RE.test("see test/noNeverDialledFlag.test.ts")).toBe(false);
  });

  it("does not flag hyphenated human prose describing the concept", () => {
    expect(BANNED_IDENTIFIER_RE.test('no "never-dialed" disposition flag exists')).toBe(false);
  });

  it("does not flag an unrelated identifier", () => {
    expect(BANNED_IDENTIFIER_RE.test("const alwaysDialled = true;")).toBe(false);
  });
});
