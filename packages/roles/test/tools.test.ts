import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TOOL_NAMES, TOOL_REGISTRY } from "../src/tools";

const CARDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cards");

const SIMPLE_TOOL_NAMES = TOOL_NAMES.filter((n) => !n.startsWith("mcp__") && n !== "fx test" && n !== "next_role_request");

/** Every literal tool-reference token a card can use, extracted from its text. */
function referencedTools(text: string): Set<string> {
  const found = new Set<string>();

  for (const name of SIMPLE_TOOL_NAMES) {
    const backticked = new RegExp("`" + name + "`");
    if (backticked.test(text)) found.add(name);
  }
  if (text.includes("fx test")) found.add("fx test");
  if (text.includes("next_role_request")) found.add("next_role_request");

  for (const m of text.matchAll(/mcp__([A-Za-z0-9-]+)__[A-Za-z0-9_]+/g)) {
    found.add(`mcp__${m[1]}__*`);
  }

  return found;
}

function allCardText(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(CARDS_DIR).filter((f) => f.endsWith(".md"))) {
    out.set(f, readFileSync(path.join(CARDS_DIR, f), "utf8"));
  }
  return out;
}

describe("tool registry cross-check (H08 criterion 3)", () => {
  it("every tool a card references exists in tools.ts", () => {
    const known = new Set(TOOL_NAMES);
    const unknown: string[] = [];
    for (const [file, text] of allCardText()) {
      for (const tool of referencedTools(text)) {
        if (!known.has(tool)) unknown.push(`${file}: ${tool}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("every tools.ts entry is referenced by at least one card", () => {
    const referenced = new Set<string>();
    for (const text of allCardText().values()) {
      for (const tool of referencedTools(text)) referenced.add(tool);
    }
    const unreferenced = TOOL_NAMES.filter((n) => !referenced.has(n));
    expect(unreferenced).toEqual([]);
  });

  it("has a non-empty description and replaces-note for every entry", () => {
    for (const entry of TOOL_REGISTRY) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.replaces.length).toBeGreaterThan(0);
    }
  });

  it("the cross-check actually catches an unknown tool (deliberate fixture)", () => {
    // Simulate a registry that's missing "git" and a card that references it —
    // the same shape of check as the two tests above, proving they're not vacuous.
    const incompleteRegistry = new Set(TOOL_NAMES.filter((n) => n !== "git"));
    const cardReferences = referencedTools("Run `git` fetch then `gh` pr list.");
    const unknown = [...cardReferences].filter((t) => !incompleteRegistry.has(t));
    expect(unknown).toEqual(["git"]);
  });

  it("the reverse cross-check actually catches an unreferenced entry (deliberate fixture)", () => {
    // Simulate a registry with an extra entry no card mentions.
    const registryWithExtra = [...TOOL_NAMES, "mcp__totally-unused__thing"];
    const referenced = new Set<string>();
    for (const text of allCardText().values()) {
      for (const tool of referencedTools(text)) referenced.add(tool);
    }
    const unreferenced = registryWithExtra.filter((n) => !referenced.has(n));
    expect(unreferenced).toEqual(["mcp__totally-unused__thing"]);
  });
});
