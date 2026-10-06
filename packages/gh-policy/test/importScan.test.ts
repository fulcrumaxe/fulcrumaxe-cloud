import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// NOTE: this test file itself uses node:fs/node:path/node:url to walk and
// read the source tree — that is fine. Criterion 9 restricts what
// `src/**/*.ts` (the shipped decision engine) may import, not the test
// tooling that checks it.

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

/**
 * [H03 fix round 1] The original scan only matched the `node:`-prefixed
 * spellings and a direct `fetch(...)` call. Node also resolves the
 * unprefixed builtin names to the exact same modules, a dynamic
 * `import(...)` reaches them just as well as a static `import`/`require`,
 * and code can reference `globalThis.fetch` without ever writing the four
 * literal characters `fetch(` at the call site.
 *
 * [H03 fix round 2] Widened the module list to `child_process`/`tls`/
 * `dgram` (all real network/process-spawn capability) and `undici` (an npm
 * package, so no `node:`-prefixed spelling exists for it). Added a
 * side-effect import with no bindings (`import "node:fs";` — no `from`
 * keyword at all, so the round-1 regex, which required one, never matched
 * it), `globalThis["fetch"]` bracket notation, and a bare `WebSocket`
 * reference (a second, unrelated way to reach the network from inside a
 * "pure" module).
 */
const FORBIDDEN_MODULE_NAMES = [
  "node:net",
  "node:http",
  "node:https",
  "node:fs",
  "node:child_process",
  "node:tls",
  "node:dgram",
  "net",
  "http",
  "https",
  "fs",
  "child_process",
  "tls",
  "dgram",
  "undici",
];
const MODULE_ALTERNATION = FORBIDDEN_MODULE_NAMES.join("|");
const STATIC_IMPORT_OR_REQUIRE_RE = new RegExp(
  `from\\s+["'](${MODULE_ALTERNATION})["']|require\\(\\s*["'](${MODULE_ALTERNATION})["']\\s*\\)`,
);
/** A side-effect import has no `from` clause at all: `import "node:fs";`. */
const SIDE_EFFECT_IMPORT_RE = new RegExp(`\\bimport\\s+["'](${MODULE_ALTERNATION})["']`);
const DYNAMIC_IMPORT_RE = new RegExp(`\\bimport\\(\\s*["'](${MODULE_ALTERNATION})["']`);
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
  if (FETCH_CALL_RE.test(source)) violations.push("fetch(...) call");
  if (GLOBALTHIS_FETCH_DOT_RE.test(source)) violations.push("globalThis.fetch reference");
  if (GLOBALTHIS_FETCH_BRACKET_RE.test(source)) violations.push('globalThis["fetch"] reference');
  if (WEBSOCKET_RE.test(source)) violations.push("WebSocket reference");
  return violations;
}

describe("criterion 9: no network/filesystem imports or fetch in src/", () => {
  it("finds zero violations across every file in src/", () => {
    const files = listSourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      const violations = scanForForbiddenIo(source);
      expect({ file, violations }).toEqual({ file, violations: [] });
    }
  });

  it("deliberate-failure fixture: flags a node:net import", () => {
    expect(scanForForbiddenIo('import { connect } from "node:net";')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags a node:http import", () => {
    expect(scanForForbiddenIo('import http from "node:http";')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags a node:https import", () => {
    expect(scanForForbiddenIo('import https from "node:https";')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags a node:fs import", () => {
    expect(scanForForbiddenIo('import fs from "node:fs";')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags a require(\"node:net\") call", () => {
    expect(scanForForbiddenIo('const net = require("node:net");')).not.toEqual([]);
  });

  it("deliberate-failure fixture: flags a bare fetch(...) call", () => {
    expect(scanForForbiddenIo('const res = fetch("https://example.com");')).not.toEqual([]);
  });

  it("[H03 fix round 1] deliberate-failure fixture: flags an unprefixed 'net' import", () => {
    expect(scanForForbiddenIo('import { connect } from "net";')).not.toEqual([]);
  });

  it("[H03 fix round 1] deliberate-failure fixture: flags an unprefixed 'http' require", () => {
    expect(scanForForbiddenIo('const http = require("http");')).not.toEqual([]);
  });

  it("[H03 fix round 1] deliberate-failure fixture: flags an unprefixed 'https' import", () => {
    expect(scanForForbiddenIo('import https from "https";')).not.toEqual([]);
  });

  it("[H03 fix round 1] deliberate-failure fixture: flags an unprefixed 'fs' import", () => {
    expect(scanForForbiddenIo('import fs from "fs";')).not.toEqual([]);
  });

  it("[H03 fix round 1] deliberate-failure fixture: flags a dynamic import(\"node:fs\")", () => {
    expect(scanForForbiddenIo('const fs = await import("node:fs");')).not.toEqual([]);
  });

  it("[H03 fix round 1] deliberate-failure fixture: flags a dynamic import(\"http\") (unprefixed)", () => {
    expect(scanForForbiddenIo('const http = await import("http");')).not.toEqual([]);
  });

  it("[H03 fix round 1] deliberate-failure fixture: flags a globalThis.fetch reference with no call parens", () => {
    expect(scanForForbiddenIo("const f = globalThis.fetch;")).not.toEqual([]);
  });

  it("[H03 fix round 1] deliberate-failure fixture: flags globalThis.fetch(...) called directly", () => {
    expect(scanForForbiddenIo('globalThis.fetch("https://example.com");')).not.toEqual([]);
  });

  it("[H03 fix round 2] deliberate-failure fixture: flags a side-effect import with no bindings", () => {
    expect(scanForForbiddenIo('import "node:fs";')).not.toEqual([]);
  });

  it("[H03 fix round 2] deliberate-failure fixture: flags a side-effect import of an unprefixed builtin", () => {
    expect(scanForForbiddenIo('import "child_process";')).not.toEqual([]);
  });

  it("[H03 fix round 2] deliberate-failure fixture: flags a node:child_process import", () => {
    expect(scanForForbiddenIo('import { spawn } from "node:child_process";')).not.toEqual([]);
  });

  it("[H03 fix round 2] deliberate-failure fixture: flags a node:tls import", () => {
    expect(scanForForbiddenIo('import tls from "node:tls";')).not.toEqual([]);
  });

  it("[H03 fix round 2] deliberate-failure fixture: flags a node:dgram import", () => {
    expect(scanForForbiddenIo('import dgram from "node:dgram";')).not.toEqual([]);
  });

  it("[H03 fix round 2] deliberate-failure fixture: flags an undici import", () => {
    expect(scanForForbiddenIo('import { fetch } from "undici";')).not.toEqual([]);
  });

  it("[H03 fix round 2] deliberate-failure fixture: flags globalThis[\"fetch\"] bracket notation", () => {
    expect(scanForForbiddenIo('const f = globalThis["fetch"];')).not.toEqual([]);
  });

  it("[H03 fix round 2] deliberate-failure fixture: flags a bare WebSocket reference", () => {
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

  it("does not flag an unrelated identifier that merely contains 'Socket' as a substring", () => {
    expect(scanForForbiddenIo("const socketCount = 0;")).toEqual([]);
  });
});
