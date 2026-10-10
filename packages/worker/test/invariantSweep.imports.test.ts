import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D#597 CC-8 acceptance 4: no model or LLM call is reachable from the sweep module. The graph is walked from the module's own source:
 * every runtime import (type-only imports are erased and carry no code) must be a relative file that is itself walked, or a package on a
 * short allowlist. The module needs none today, so the list is empty; a package added here is a decision a reviewer sees.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const ALLOWED_PACKAGES: readonly string[] = [];
const FORBIDDEN = /(model|anthropic|claude|openai|llm|agent-sdk|ai-sdk|fetch)/i;

function runtimeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs = [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["']/gms)].map((m) => m[1]!);
  const bare = [...text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
  const dynamic = [...text.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);
  return [...specs, ...bare, ...dynamic];
}

export function walk(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of runtimeImports(file)) {
      if (spec.startsWith(".")) visit(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")));
      else packages.add(spec);
    }
  };
  visit(entry);
  return { files: [...files], packages: [...packages] };
}

describe("invariantSweep import graph (no model call is reachable)", () => {
  const graph = walk(path.join(SRC, "invariantSweep.ts"));

  it("reaches only itself and no package outside the allowlist", () => {
    expect(graph.files.map((f) => path.basename(f))).toEqual(["invariantSweep.ts"]);
    expect(graph.packages.filter((p) => !ALLOWED_PACKAGES.includes(p))).toEqual([]);
  });

  it("names no model, agent or network facility anywhere in the module", () => {
    const text = readFileSync(path.join(SRC, "invariantSweep.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(text.match(FORBIDDEN)).toBeNull();
  });
});
