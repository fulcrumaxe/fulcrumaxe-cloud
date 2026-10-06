import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TELEMETRY_SHAPES, TOKEN_SHAPE_PATTERN_SOURCES } from "../src/redact.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")) as {
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

/** The built output of every source file, as the TypeScript compiler writes it (comments kept, as tsc keeps them). */
function built(file: string): string {
  return ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: file }).outputText;
}

describe("licence and manifest", () => {
  it("LICENSE is the repository's own LICENSE, byte for byte", () => {
    const own = readFileSync(path.join(PACKAGE_DIR, "LICENSE"));
    const root = readFileSync(path.join(PACKAGE_DIR, "..", "..", "LICENSE"));
    expect(createHash("sha256").update(own).digest("hex")).toBe(createHash("sha256").update(root).digest("hex"));
  });

  it("package.json carries the proprietary marker and the Node minimum", () => {
    expect(manifest.license).toBe("UNLICENSED");
    expect(manifest.engines?.node).toBe(">=22.22.2");
  });

  it("has a README", () => {
    expect(existsSync(path.join(PACKAGE_DIR, "README.md"))).toBe(true);
  });
});

describe("G5: public boundary", () => {
  it("declares no workspace dependency", () => {
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(all).filter((name) => name.startsWith("@fx/") || all[name]!.startsWith("workspace:"))).toEqual([]);
  });

  it("imports only itself, node built-ins, zod and (in tests) vitest and typescript", () => {
    const specifier = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
    const violations: string[] = [];
    for (const file of [...sourceFiles, ...testFiles]) {
      const isTest = file.startsWith(path.join(PACKAGE_DIR, "test"));
      for (const match of readFileSync(file, "utf8").matchAll(specifier)) {
        const spec = match[1]!;
        const ok = spec.startsWith("node:")
          ? true
          : spec.startsWith(".")
            ? path.resolve(path.dirname(file), spec).startsWith(PACKAGE_DIR + path.sep)
            : spec === "zod" || (isTest && (spec === "vitest" || spec === "typescript"));
        if (!ok) violations.push(`${path.relative(PACKAGE_DIR, file)}: ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the source never reaches into the test directory or another package by path", () => {
    for (const file of sourceFiles) expect(readFileSync(file, "utf8"), file).not.toMatch(/\.\.\/\.\.\/|packages\//);
  });
});

const TOKEN_SHAPE_NAMES = [
  "github_pat", "github_prefixed_token", "github_short_token", "slack_token", "sk_ant_key", "sk_ant_family", "openai_proj_key",
  "openai_legacy_key", "aws_access_key", "fxat", "fxrr", "vercel_token", "whsec", "stripe_key", "jwt_token",
];

describe("G4: nothing secret in public code", () => {
  const TOKEN_SHAPES = [
    ...TOKEN_SHAPE_PATTERN_SOURCES,
    ...TELEMETRY_SHAPES.filter((shape) => TOKEN_SHAPE_NAMES.includes(shape.name)).map((shape) => shape.source),
  ];

  const texts: Array<[string, string]> = [
    ...sourceFiles.map((f): [string, string] => [`src/${path.relative(path.join(PACKAGE_DIR, "src"), f)}`, readFileSync(f, "utf8")]),
    ...sourceFiles.map((f): [string, string] => [`built ${path.relative(path.join(PACKAGE_DIR, "src"), f)}`, built(f)]),
    ...testFiles.map((f): [string, string] => [`test/${path.relative(path.join(PACKAGE_DIR, "test"), f)}`, readFileSync(f, "utf8")]),
    ["README.md", readFileSync(path.join(PACKAGE_DIR, "README.md"), "utf8")],
  ];

  it("scans the source, the built output and the tests", () => {
    expect(texts.some(([name]) => name === "src/httpSignature.ts")).toBe(true);
    expect(texts.some(([name]) => name === "built httpSignature.ts")).toBe(true);
    expect(texts.length).toBeGreaterThan(20);
  });

  it("holds no credential-shaped string", () => {
    const found: string[] = [];
    for (const [name, text] of texts) {
      for (const source of TOKEN_SHAPES) if (new RegExp(source).test(text)) found.push(`${name}: ${source}`);
    }
    expect(found).toEqual([]);
  });

  it("names no host other than the documented defaults", () => {
    const allowed = new Set(["api.anthropic.com", "github.com", "api.github.com", "registry.npmjs.org"]);
    const url = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@"'`]*@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
    const bare = /\b((?:[a-z0-9-]+\.)+(?:com|dev|io|net|org|ai|app|cloud|xyz|co))\b/gi;
    const found: string[] = [];
    for (const [name, text] of texts.filter(([n]) => n.startsWith("src/") || n.startsWith("built "))) {
      for (const m of text.matchAll(url)) if (!allowed.has(m[1]!.toLowerCase())) found.push(`${name}: ${m[1]}`);
      for (const m of text.matchAll(bare)) if (!allowed.has(m[1]!.toLowerCase())) found.push(`${name}: ${m[1]}`);
    }
    expect(found).toEqual([]);
  });

  it("the host check does see a host, and the credential check does see a token", () => {
    const sample = "see https://evil.example.dev/x and also some.host.io";
    expect([...sample.matchAll(/\b((?:[a-z0-9-]+\.)+(?:com|dev|io|net|org|ai|app|cloud|xyz|co))\b/gi)].map((m) => m[1])).toEqual(["evil.example.dev", "some.host.io"]);
    const token = ["sk-ant-", "api03-", "A".repeat(24)].join("");
    expect(TOKEN_SHAPES.some((source) => new RegExp(source).test(token))).toBe(true);
  });
});
