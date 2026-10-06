/**
 * DP1 criterion 7 (C3): "No `neverDialled` field exists: a schema test
 * asserts the entry type has no such key, and a grep test finds the
 * identifier nowhere in the package."
 *
 * Every occurrence of the literal string "neverDialled" this package
 * contains lives in THIS file and in D#7 DP5's
 * `test/neverDialledWorkspace.test.ts` -- it has to: a test that checks an
 * identifier is absent must name the identifier to search for, the same
 * way test/importScan.test.ts's deliberate-failure fixtures reference
 * "node:fs" without that file flagging itself (that scan only walks
 * src/). Here the scan walks src/ AND test/, so this file excludes both
 * itself and DP5's workspace-wide file by path. DP5's own grep (criterion
 * 6 there) is the broader net -- every package and every file in the repo,
 * not just this one -- and needs its own deliberate-failure fixtures for
 * the same reason this file needs its own.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOGUE } from "../src/catalogue.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);
const DP5_WORKSPACE_GREP_FILE = fileURLToPath(new URL("./neverDialledWorkspace.test.ts", import.meta.url));

const BANNED_IDENTIFIER_RE = /neverDialled/;

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("criterion 7 (grep half): no neverDialled identifier anywhere in the package (C3)", () => {
  it("finds zero occurrences across src/ and test/, excluding this enforcement file", () => {
    const files = [
      ...listTsFiles(join(PACKAGE_ROOT, "src")),
      ...listTsFiles(join(PACKAGE_ROOT, "test")),
    ].filter((f) => f !== THIS_FILE && f !== DP5_WORKSPACE_GREP_FILE);

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      expect({ file, matched: BANNED_IDENTIFIER_RE.test(source) }).toEqual({
        file,
        matched: false,
      });
    }
  });

  it("deliberate-failure fixture: the pattern does match the literal identifier -- proves the check is not vacuous", () => {
    expect(BANNED_IDENTIFIER_RE.test("const neverDialled = true;")).toBe(true);
  });

  it("deliberate-failure fixture: the pattern does not match an unrelated identifier", () => {
    expect(BANNED_IDENTIFIER_RE.test("const alwaysDialled = true;")).toBe(false);
  });
});

describe("criterion 7 (schema half): no real catalogue entry has an own 'neverDialled' property", () => {
  it("every catalogue entry lacks the property at runtime", () => {
    for (const entry of CATALOGUE) {
      expect(Object.prototype.hasOwnProperty.call(entry, "neverDialled")).toBe(false);
    }
  });

  it("deliberate-failure fixture: the same check flags an object that does carry the property", () => {
    const hostileEntry: Record<string, unknown> = { ...CATALOGUE[0], neverDialled: true };
    expect(Object.prototype.hasOwnProperty.call(hostileEntry, "neverDialled")).toBe(true);
  });
});
