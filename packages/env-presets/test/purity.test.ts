import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const source = (f: string) => readFileSync(join(SRC, f), "utf8");

/** Every module specifier the package can load: static imports, re-exports, dynamic import(), require(). */
const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);

describe("criterion 6: zero I/O, import-graph test", () => {
  it("imports only sibling modules -- so no fs, child_process, network or db package", () => {
    const seen = files.flatMap((f) => specifiers(source(f)).map((s) => [f, s] as const));
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.filter(([, s]) => !s.startsWith("./"))).toEqual([]);
  });

  it("has no dynamic import(), no globalThis and no ambient I/O", () => {
    for (const f of files) {
      expect(source(f), f).not.toMatch(/\bimport\s*\(|\bglobalThis\b/);
      expect(source(f), f).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|process\.(env|cwd|stdout)|Deno|Bun)\b|\bfs\b|child_process|@fx\//);
    }
  });
});
