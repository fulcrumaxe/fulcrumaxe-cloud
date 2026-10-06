import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { TOKEN_SHAPE_PATTERN_SOURCES } from "@fulcrumaxe/runner-protocol";
import { describe, expect, it } from "vitest";
import { PACKAGE_DIR } from "./helpers/srcFiles.js";

const manifest = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")) as {
  private?: boolean;
  license?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}
const sourceFiles = filesUnder(path.join(PACKAGE_DIR, "src")).filter((f) => f.endsWith(".ts"));
const testFiles = filesUnder(path.join(PACKAGE_DIR, "test")).filter((f) => f.endsWith(".ts"));

describe("licence and manifest", () => {
  it("LICENSE is the repository's own LICENSE, byte for byte", () => {
    const own = readFileSync(path.join(PACKAGE_DIR, "LICENSE"));
    const root = readFileSync(path.join(PACKAGE_DIR, "..", "..", "LICENSE"));
    expect(createHash("sha256").update(own).digest("hex")).toBe(createHash("sha256").update(root).digest("hex"));
  });

  it("package.json is private, proprietary, names the Node minimum and the package", () => {
    expect(manifest).toMatchObject({ name: "@fulcrumaxe/fx-runner", private: true, license: "UNLICENSED", engines: { node: ">=22.22.2" } });
  });

  it("has a README", () => {
    expect(existsSync(path.join(PACKAGE_DIR, "README.md"))).toBe(true);
  });

  it("depends on no @anthropic-ai package, in any dependency list", () => {
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(all).filter((name) => name.startsWith("@anthropic-ai/"))).toEqual([]);
  });
});

describe("boundary: what the source may import, and every workspace import is declared", () => {
  const specifier = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

  it("src imports only itself, node built-ins and the protocol package", () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      for (const match of readFileSync(file, "utf8").matchAll(specifier)) {
        const spec = match[1]!;
        const ok = spec.startsWith("node:") || (spec.startsWith(".") && path.resolve(path.dirname(file), spec).startsWith(PACKAGE_DIR + path.sep)) || spec === "@fulcrumaxe/runner-protocol";
        if (!ok) violations.push(`${path.relative(PACKAGE_DIR, file)}: ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("every workspace package a file imports is in package.json: src in dependencies, tests in either list", () => {
    const missing: string[] = [];
    for (const file of [...sourceFiles, ...testFiles]) {
      const inTest = file.startsWith(path.join(PACKAGE_DIR, "test"));
      const declared = inTest ? { ...manifest.dependencies, ...manifest.devDependencies } : { ...manifest.dependencies };
      for (const match of readFileSync(file, "utf8").matchAll(specifier)) {
        const spec = match[1]!;
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        if ((name.startsWith("@fx/") || name.startsWith("@fulcrumaxe/")) && !declared[name]) missing.push(`${path.relative(PACKAGE_DIR, file)}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("src never reaches into another package by path", () => {
    for (const file of sourceFiles) expect(readFileSync(file, "utf8"), file).not.toMatch(/\.\.\/\.\.\/\.\.\/|packages\//);
  });
});

describe("G4: nothing secret in the source, the tests or the README", () => {
  it("holds no credential-shaped string", () => {
    const found: string[] = [];
    for (const file of [...sourceFiles, ...testFiles, path.join(PACKAGE_DIR, "README.md")]) {
      const text = readFileSync(file, "utf8");
      for (const source of TOKEN_SHAPE_PATTERN_SOURCES) if (new RegExp(source).test(text)) found.push(`${path.relative(PACKAGE_DIR, file)}: ${source}`);
    }
    expect(found).toEqual([]);
  });
});
