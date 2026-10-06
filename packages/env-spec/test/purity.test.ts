import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
const source = (f: string) => readFileSync(join(SRC, f), "utf8");

/** Every module specifier the package can load: static imports, re-exports, dynamic import(), require(). */
const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);

describe("zero I/O (criterion 7): import-graph test", () => {
  const allowed = (s: string) => s.startsWith("./") || s === "js-yaml" || s === "node:crypto";

  it("imports only relative modules, js-yaml and node:crypto -- so no fs, child_process, network or db package", () => {
    const seen = files.flatMap((f) => specifiers(source(f)).map((s) => [f, s] as const));
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.filter(([, s]) => !allowed(s))).toEqual([]);
  });

  it("has no dynamic import() and no globalThis (no computed route to fetch, fs or process)", () => {
    for (const f of files) {
      expect(source(f), f).not.toMatch(/\bimport\s*\(/);
      expect(source(f), f).not.toMatch(/\bglobalThis\b/);
    }
  });

  it("does not reach for ambient I/O either", () => {
    for (const f of files) expect(source(f), f).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|process\.(env|cwd|stdout)|Deno|Bun)\b|\bfs\b|child_process|@fx\//);
  });
});

describe("no shell strings (criterion 5): grep test over the package source", () => {
  it("never spawns, execs or evals, and never joins argv into a string", () => {
    for (const f of files) {
      const text = source(f);
      expect(text, f).not.toMatch(/(?<![.\w])(exec|execSync|execFile|spawn|spawnSync|fork|eval)\s*\(|new Function|\bsh\s+-c|bash\s+-c|\/bin\/sh/);
      expect(text, f).not.toMatch(/\.join\(\s*(["'`])\s\1\s*\)/);
      expect(text, f).not.toMatch(/\$\{[^}]*(argv|setup|run|cmd|command)[^}]*\}/i);
    }
  });
});
