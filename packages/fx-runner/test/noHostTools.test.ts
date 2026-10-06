import { describe, expect, it } from "vitest";
import { srcFiles } from "./helpers/srcFiles.js";

type Files = ReadonlyArray<readonly [string, string]>;

const ALWAYS_BANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ["in-process tool server", /createSdkMcpServer/],
  ["tool proxy", /tool_proxy/],
  ["permission bypass", /bypassPermissions/],
  ["permission bypass flag", /dangerously-skip-permissions/i],
  ["permission bypass option", /allowDangerouslySkipPermissions/i],
  ["Anthropic package", /@anthropic-ai/],
  ["agent SDK", /claude-agent-sdk/],
  ["runtime module loader", /createRequire/],
  // A deny rule outranks an allow rule, so a blanket deny would block customer MCP servers (D#47 M14). Platform MCP is
  // kept out by the empty MCP config instead.
  ["blanket MCP rule", /mcp__\*/],
];

/** The shared builder's module (D#47 M13/M14): the one place `mcp__c-<name>__*` names may come from. */
const SHARED_BUILDER_IMPORT = /\bfrom\s+["'][^"']*\/toolPolicy(?:\.js)?["']/;

/** Every ban the sources break. `mcp__` is allowed only in a file that imports the shared builder (C5 item 1). */
export function hostToolViolations(files: Files): string[] {
  const found: string[] = [];
  for (const [name, text] of files) {
    for (const [what, pattern] of ALWAYS_BANNED) if (pattern.test(text)) found.push(`${name}: ${what}`);
    if (text.includes("mcp__") && !SHARED_BUILDER_IMPORT.test(text)) found.push(`${name}: mcp__ without the shared builder import`);
  }
  return found;
}

describe("no host tools in the runner", () => {
  it("packages/fx-runner/src holds none of the banned names, and no mcp__ name at all in this change", () => {
    const files = srcFiles();
    expect(files.length).toBeGreaterThan(4);
    expect(hostToolViolations(files)).toEqual([]);
    expect(files.filter(([, text]) => /\bfrom\s+["'][^"']*toolPolicy/.test(text))).toEqual([]);
  });

  it("the scanner fails on each banned name", () => {
    for (const [, pattern] of ALWAYS_BANNED) {
      const sample = pattern.source.replace(/\\/g, "");
      expect(hostToolViolations([["bad.ts", `const x = "${sample}";`]]).length, sample).toBeGreaterThan(0);
    }
    expect(hostToolViolations([["bad.ts", 'import { q } from "@anthropic-ai/sdk";']])).not.toEqual([]);
    // the same package named through a template-literal import or a loader the import scan cannot follow
    expect(hostToolViolations([["bad.ts", "const m = await import(`@anthropic-ai/sdk`);"]])).not.toEqual([]);
    expect(hostToolViolations([["bad.ts", "const r = createRequire(import.meta.url);"]])).not.toEqual([]);
    expect(hostToolViolations([["bad.ts", 'const flag = "--allow-dangerously-skip-permissions";']])).not.toEqual([]);
  });

  it("customer MCP stays possible: a scoped mcp__ name from the shared builder import passes, anything else fails", () => {
    // Built from parts so the repository's declared-imports scan does not read this sample as a real import.
    const builder = ["@fx", "runtime", "toolPolicy"].join("/");
    const withBuilder = `import { buildCustomerMcp } from "${builder}";\nconst rule = "mcp__c-docs__*";`;
    expect(hostToolViolations([["ok.ts", withBuilder]])).toEqual([]);
    expect(hostToolViolations([["bad.ts", 'const rule = "mcp__c-docs__search";']])).not.toEqual([]);
    expect(hostToolViolations([["bad.ts", 'import { b } from "./toolbox.js";\nconst rule = "mcp__fx__run";']])).not.toEqual([]);
    // even with the builder, a blanket rule is refused
    expect(hostToolViolations([["bad.ts", `${withBuilder}\nconst deny = "mcp__*";`]])).not.toEqual([]);
  });
});
