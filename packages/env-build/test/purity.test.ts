import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const source = (f: string) => readFileSync(join(SRC, f), "utf8");

/** Every module specifier the package can load: static imports, re-exports, dynamic import(), require(). */
const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);

describe("criterion 11: zero I/O, import-graph test", () => {
  const allowed = (s: string) => s.startsWith("./") || s === "@fx/env-spec" || s === "@fx/env-presets";

  it("imports only relative modules and the two pure sibling packages", () => {
    const seen = files.flatMap((f) => specifiers(source(f)).map((s) => [f, s] as const));
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.filter(([, s]) => !allowed(s))).toEqual([]);
  });

  it("has no dynamic import(), no globalThis and no ambient I/O", () => {
    for (const f of files) {
      expect(source(f), f).not.toMatch(/\bimport\s*\(|\bglobalThis\b/);
      expect(source(f), f).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|process\.(env|cwd|stdout)|Deno|Bun)\b|\bfs\b|child_process/);
    }
  });
});

describe("criterion 7: no shell strings in the package source", () => {
  it("never spawns, execs or evals, and never joins argv into a string", () => {
    for (const f of files) {
      const text = source(f);
      expect(text, f).not.toMatch(/(?<![.\w])(exec|execSync|execFile|spawn|spawnSync|fork|eval)\s*\(|new Function|\bsh\s+-c|bash\s+-c|\/bin\/sh/);
      expect(text, f).not.toMatch(/\.join\(\s*(["'`])\s\1\s*\)/);
    }
  });
});
