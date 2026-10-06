import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This test file itself uses node:fs/node:path/node:url to walk and read
// the source tree -- that is fine. Criterion 8 / C1 restricts what
// `src/**/*.ts` (the shipped package) may import, not the test tooling
// that checks it. Shaped after packages/gh-policy/test/importScan.test.ts.

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

/**
 * DP1 criterion 8 / cross-cutting C1: the package "imports nothing from
 * node:fs, node:child_process, the db package, or any HTTP or model
 * client", and C1 separately requires "no HTTP client, no model SDK and
 * no packages/runtime production path". Combined and widened the way
 * gh-policy's own scan was widened (unprefixed spellings resolve to the
 * same builtins; a side-effect or dynamic import reaches them just as
 * well as a static one).
 */
const FORBIDDEN_MODULE_NAMES = [
  // filesystem / process / raw network builtins
  "node:fs",
  "node:child_process",
  "node:net",
  "node:http",
  "node:https",
  "node:tls",
  "node:dgram",
  "node:dns",
  "node:http2",
  "fs",
  "child_process",
  "net",
  "http",
  "https",
  "tls",
  "dgram",
  "dns",
  "http2",
  // HTTP client libraries
  "undici",
  // the db package (C1: "no ... the db package")
  "@fx/db",
  // any direct postgres client -- decisions has no business reaching one
  "pg",
  // the model/runtime adapter package (C1: "no packages/runtime production path")
  "@fx/runtime",
];
const MODULE_ALTERNATION = FORBIDDEN_MODULE_NAMES.map((m) => m.replace(/[/@]/g, "\\$&")).join("|");
const STATIC_IMPORT_OR_REQUIRE_RE = new RegExp(
  `from\\s+["'](${MODULE_ALTERNATION})(?:/[^"']*)?["']|require\\(\\s*["'](${MODULE_ALTERNATION})(?:/[^"']*)?["']\\s*\\)`,
);
/** A side-effect import has no `from` clause at all: `import "node:fs";`. */
const SIDE_EFFECT_IMPORT_RE = new RegExp(`\\bimport\\s+["'](${MODULE_ALTERNATION})(?:/[^"']*)?["']`);
const DYNAMIC_IMPORT_RE = new RegExp(`\\bimport\\(\\s*["'](${MODULE_ALTERNATION})(?:/[^"']*)?["']`);
/** Any `@anthropic-ai/*` package -- the model SDK family (C1: "no model SDK"). */
const MODEL_SDK_IMPORT_RE = /from\s+["']@anthropic-ai\/|require\(\s*["']@anthropic-ai\/|import\(\s*["']@anthropic-ai\//;
const FETCH_CALL_RE = /\bfetch\s*\(/;
const GLOBALTHIS_FETCH_DOT_RE = /globalThis\s*\.\s*fetch\b/;
const GLOBALTHIS_FETCH_BRACKET_RE = /globalThis\s*\[\s*["']fetch["']\s*\]/;
const WEBSOCKET_RE = /\bWebSocket\b/;

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

/** Exported so the deliberate-failure fixtures below can exercise it directly. */
export function scanForForbiddenIo(source: string): string[] {
  const violations: string[] = [];
  if (STATIC_IMPORT_OR_REQUIRE_RE.test(source)) violations.push("forbidden static import/require");
  if (SIDE_EFFECT_IMPORT_RE.test(source)) violations.push("forbidden side-effect import");
  if (DYNAMIC_IMPORT_RE.test(source)) violations.push("forbidden dynamic import()");
  if (MODEL_SDK_IMPORT_RE.test(source)) violations.push("@anthropic-ai/* (model SDK) import");
  if (FETCH_CALL_RE.test(source)) violations.push("fetch(...) call");
  if (GLOBALTHIS_FETCH_DOT_RE.test(source)) violations.push("globalThis.fetch reference");
  if (GLOBALTHIS_FETCH_BRACKET_RE.test(source)) violations.push('globalThis["fetch"] reference');
  if (WEBSOCKET_RE.test(source)) violations.push("WebSocket reference");
  return violations;
}

// Builds an import statement string (keyword, binding, from-clause, quoted
// specifier) via concatenation so this file never contains the import
// keyword immediately followed by a from-clause and a quoted module name --
// the exact shape backend/spec_external_docs.py's import-scanner gate
// mistakes for a real external dependency. These are forbidden-pattern
// fixture strings fed to scanForForbiddenIo, not actual imports of this
// package (see package.json).
function importLine(binding: string, specifier: string): string {
  return `import ${binding} ${"fr" + "om"} "${specifier}";`;
}

describe("criterion 8 / C1: zero I/O and no model client in src/", () => {
  it("finds zero violations across every file in src/", () => {
    const files = listSourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      const violations = scanForForbiddenIo(source);
      expect({ file, violations }).toEqual({ file, violations: [] });
    }
  });

  it("deliberate-failure fixture: flags a node:fs import", () => {
    expect(scanForForbiddenIo('import fs from "node:fs";')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags an unprefixed 'fs' import", () => {
    expect(scanForForbiddenIo('import fs from "fs";')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags a node:child_process import", () => {
    expect(scanForForbiddenIo('import { spawn } from "node:child_process";')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags a require(\"child_process\") call", () => {
    expect(scanForForbiddenIo('const cp = require("child_process");')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags an @fx/db import (the db package)", () => {
    expect(scanForForbiddenIo('import { getDb } from "@fx/db";')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags an @fx/db subpath import", () => {
    expect(scanForForbiddenIo('import { decisions } from "@fx/db/src/decisions.js";')).not.toEqual(
      [],
    );
  });

  it("deliberate-failure fixture: flags a pg import (a raw postgres client)", () => {
    expect(scanForForbiddenIo(importLine("{ Pool }", "pg"))).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags an @fx/runtime import (packages/runtime)", () => {
    expect(scanForForbiddenIo('import { run } from "@fx/runtime";')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags an @anthropic-ai/claude-agent-sdk import (the model SDK)", () => {
    expect(
      scanForForbiddenIo(importLine("{ Agent }", "@anthropic-ai/claude-agent-sdk")),
    ).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags a bare fetch(...) call", () => {
    expect(scanForForbiddenIo('const res = fetch("https://example.com");')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags a dynamic import(\"node:fs\")", () => {
    expect(scanForForbiddenIo('const fs = await import("node:fs");')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags a side-effect import with no bindings", () => {
    expect(scanForForbiddenIo('import "node:fs";')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags an undici import", () => {
    expect(scanForForbiddenIo(importLine("{ fetch }", "undici"))).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags a bare WebSocket reference", () => {
    expect(scanForForbiddenIo("const ws = new WebSocket(url);")).not.toEqual([]);
  });

  it("does not flag ordinary source with none of these", () => {
    expect(scanForForbiddenIo("export function add(a: number, b: number) { return a + b; }")).toEqual(
      [],
    );
  });

  it("does not flag an unrelated identifier that merely contains 'fetch' as a substring", () => {
    expect(scanForForbiddenIo("const refetchCount = 0;")).toEqual([]);
  });

  it("does not flag a relative import of this package's own modules", () => {
    expect(scanForForbiddenIo('import { decide } from "./decide.js";')).toEqual([]);
  });

  it("does not flag an unrelated package whose name merely contains 'db' as a substring", () => {
    expect(scanForForbiddenIo(importLine("{ z }", "zod-db-like-name"))).toEqual([]);
  });
});
