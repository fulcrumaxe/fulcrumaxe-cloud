import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The dependency direction for @fx/receipts (D#7 DP7-2b, ruling R1). @fx/receipts may import @fx/decisions, @fx/db, @fx/spend and @fx/github.
 * None of those, and no apps/* client file, may import @fx/receipts. packages/worker and packages/api may. This is a source scan, not a
 * lint rule, so it fails in the same run as the other unit tests.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FORBIDDEN_PACKAGES = ["db", "spend", "github", "decisions"];
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".turbo", "coverage"]);
const IMPORT = /(?:from|import|require|import\()\s*\(?\s*["']@fx\/receipts(?:\/[^"']*)?["']/;

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (SKIP_DIRS.has(n)) continue;
    const p = path.join(dir, n);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(p, out);
    else if (SOURCE.test(n)) out.push(p);
  }
  return out;
}

/** The files among `files` that import @fx/receipts, as paths relative to the repo root. */
export function importersOfReceipts(files: Array<{ file: string; text: string }>): string[] {
  return files.filter((f) => IMPORT.test(f.text)).map((f) => path.relative(root, f.file));
}

const read = (files: string[]) => files.map((file) => ({ file, text: readFileSync(file, "utf8") }));

describe("@fx/receipts dependency direction", () => {
  it("the matcher catches a static, a dynamic, a side-effect and a subpath import, and ignores the rest", () => {
    const f = (text: string) => importersOfReceipts([{ file: path.join(root, "packages/db/src/x.ts"), text }]).length;
    expect(f(`import { a } from "@fx/receipts";`)).toBe(1);
    expect(f(`import '@fx/receipts';`)).toBe(1);
    expect(f(`const m = await import("@fx/receipts/src/ports.js");`)).toBe(1);
    expect(f(`const m = require('@fx/receipts');`)).toBe(1);
    expect(f(`import { a } from "@fx/receipts-other";`)).toBe(0);
    expect(f(`import { a } from "@fx/decisions";`)).toBe(0);
  });

  it.each(FORBIDDEN_PACKAGES)("no source or test file in packages/%s imports @fx/receipts, and its package.json does not depend on it", (name) => {
    const dir = path.join(root, "packages", name);
    expect(importersOfReceipts(read(walk(dir)))).toEqual([]);
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      expect(Object.keys(pkg[field] ?? {}), `${name} ${field}`).not.toContain("@fx/receipts");
    }
  });

  it("no file under apps/* imports @fx/receipts, and no apps/* package.json depends on it", () => {
    const apps = path.join(root, "apps");
    expect(importersOfReceipts(read(walk(apps)))).toEqual([]);
    const manifests = findManifests(apps);
    for (const m of manifests) {
      const pkg = JSON.parse(readFileSync(m, "utf8")) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        expect(Object.keys(pkg[field] ?? {}), `${path.relative(root, m)} ${field}`).not.toContain("@fx/receipts");
      }
    }
  });
});

function findManifests(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (SKIP_DIRS.has(n)) continue;
    const p = path.join(dir, n);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) findManifests(p, out);
    else if (n === "package.json") out.push(p);
  }
  return out;
}
