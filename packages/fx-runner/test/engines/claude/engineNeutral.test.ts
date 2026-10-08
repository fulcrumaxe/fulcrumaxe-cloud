import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "@fulcrumaxe/runner-protocol";
import { createClaudeEngine } from "../../../src/engines/claude/engine.js";
import { IMPORT_SPECIFIER, PACKAGE_DIR, filesUnder, srcFiles } from "../../helpers/srcFiles.js";

const ENGINE_DIR = path.join(PACKAGE_DIR, "src", "engines", "claude");

describe("engine-neutral", () => {
  it("createClaudeEngine returns the protocol package's AgentRuntime", () => {
    const check: (config: Parameters<typeof createClaudeEngine>[0]) => AgentRuntime = createClaudeEngine;
    expect(check).toBe(createClaudeEngine);
  });

  it("nothing outside src/engines/claude/ imports from it, except the one named engine export in index.ts", () => {
    const outside = srcFiles().filter(([name]) => !name.startsWith(path.join("src", "engines", "claude")));
    expect(outside.length).toBeGreaterThan(4);
    for (const [name, text] of outside) {
      const importsEngine = /from\s+["'][^"']*engines\/claude\//.test(text);
      if (name === path.join("src", "index.ts")) {
        const lines = text.split("\n").filter((line) => line.includes("engines/claude/"));
        expect(lines).toEqual([
          'export { createClaudeEngine, outcomeOf } from "./engines/claude/engine.js";',
          'export type { EngineConfig, EngineStartOptions, RunOutcome } from "./engines/claude/engine.js";',
        ]);
      } else {
        expect(importsEngine, name).toBe(false);
      }
    }
  });

  it("no Claude-named type is exported from the package entry", () => {
    const index = readFileSync(path.join(PACKAGE_DIR, "src", "index.ts"), "utf8");
    const exported = [...index.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)].flatMap((m) => m[1]!.split(",").map((n) => n.trim()));
    expect(exported.filter((name) => /^(?:Claude|CLAUDE)/.test(name))).toEqual([]);
  });
});

describe("module graph", () => {
  function reachable(entry: string): { files: string[]; specifiers: string[] } {
    const seen = new Set<string>();
    const specifiers: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const match of readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)) {
        const spec = match[1]!;
        specifiers.push(spec);
        if (spec.startsWith(".")) visit(path.resolve(path.dirname(file), spec).replace(/\.js$/, ".ts"));
      }
    };
    visit(entry);
    return { files: [...seen], specifiers };
  }

  it("src never reaches the cloud's local runtime or the agent SDK, through any import", () => {
    const { files, specifiers } = reachable(path.join(PACKAGE_DIR, "src", "index.ts"));
    expect(files.length).toBeGreaterThan(10);
    expect(specifiers.filter((spec) => /@anthropic-ai|claude-agent-sdk|@fx\/|runtime\/src\/local/.test(spec))).toEqual([]);
    expect(files.filter((file) => file.includes(`${path.sep}runtime${path.sep}`))).toEqual([]);
  });

  it("src has no @anthropic-ai text at all", () => {
    expect(filesUnder(path.join(PACKAGE_DIR, "src")).filter((file) => readFileSync(file, "utf8").includes("@anthropic-ai"))).toEqual([]);
    expect(ENGINE_DIR.endsWith(path.join("engines", "claude"))).toBe(true);
  });
});
