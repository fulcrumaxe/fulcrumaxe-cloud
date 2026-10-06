import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const source = (f: string) => readFileSync(join(SRC, f), "utf8");

/** Every module specifier the package can load: static imports, re-exports, dynamic import(), require(). */
const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);

describe("zero I/O (criterion 8): import-graph test", () => {
  // node:url is only used for domainToASCII, a pure string function. @fx/env-spec is imported for a type.
  const allowed = (s: string) => s.startsWith("./") || s === "node:url" || s === "@fx/env-spec";

  it("imports only relative modules, node:url and @fx/env-spec -- so no fs, child_process, net, dns or db", () => {
    const seen = files.flatMap((f) => specifiers(source(f)).map((s) => [f, s] as const));
    expect(seen.length).toBeGreaterThan(4);
    expect(seen.filter(([, s]) => !allowed(s))).toEqual([]);
  });

  it("imports @fx/env-spec as a type only, so nothing of it loads at run time", () => {
    for (const f of files) expect(source(f), f).not.toMatch(/^import\s+(?!type\b)[^"']*from\s+["']@fx\//m);
  });

  it("has no dynamic import(), globalThis or ambient I/O", () => {
    for (const f of files) {
      expect(source(f), f).not.toMatch(/\bimport\s*\(/);
      expect(source(f), f).not.toMatch(/\bglobalThis\b/);
      expect(source(f), f).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|process\.(env|cwd|stdout)|Deno|Bun)\b|\bfs\b|child_process|node:net|node:dns/);
    }
  });
});
