import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ROLE_MANIFEST, ROLE_NAMES } from "../src/manifest";
import { TOOL_NAMES } from "../src/tools";
import {
  BASH_MEDIATED_TOOLS,
  READ_ONLY_ROLES,
  UnknownRoleError,
  sdkToolsFor,
  toolsetFor,
} from "../src/toolsets";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROLES_DIR = path.join(HERE, "..");
const CARDS_DIR = path.join(ROLES_DIR, "cards");

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/** Roles whose card frontmatter says `read_only: true`, read straight from the files. */
function readOnlyFromCards(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(CARDS_DIR).filter((n) => n.endsWith(".md"))) {
    const text = readFileSync(path.join(CARDS_DIR, f), "utf8");
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    if (/^read_only:\s*true\s*$/m.test(fm)) out.push(f.replace(/\.md$/, ""));
  }
  return out.sort();
}

/** The expected set, built without calling toolsetFor and from the card files, not READ_ONLY_ROLES. */
function expectedSet(role: string, readOnly: ReadonlySet<string>): string[] {
  const entry = ROLE_MANIFEST.find((r) => r.name === role)!;
  const set = ["Read", "Glob", "Grep", "Bash", "gh", "git", "fx test"];
  if (!readOnly.has(role)) set.push("Write", "Edit", "NotebookEdit");
  if (entry.needsBrowser) set.push("mcp__chrome-devtools__*");
  if (role === "researcher") set.push("WebFetch", "WebSearch");
  return set.sort();
}

describe("toolsetFor (M01)", () => {
  it("throws UnknownRoleError for an unknown or empty role, and for inherited object keys", () => {
    for (const bad of ["not-a-role", "", "Executor", "constructor", "__proto__", "toString"]) {
      expect(() => toolsetFor(bad)).toThrow(UnknownRoleError);
      expect(() => sdkToolsFor(bad)).toThrow(UnknownRoleError);
    }
  });

  it("covers all 26 roles", () => {
    expect(ROLE_NAMES).toHaveLength(26);
  });

  it("matches the independently computed set for every role", () => {
    const readOnly = new Set(readOnlyFromCards());
    for (const role of ROLE_NAMES) {
      expect(sorted(toolsetFor(role)), role).toEqual(expectedSet(role, readOnly));
    }
  });

  it("never grants Agent, next_role_request or a mcp__ns__ name", () => {
    for (const role of ROLE_NAMES) {
      for (const tool of toolsetFor(role)) {
        expect(tool === "Agent" || tool === "next_role_request" || tool.startsWith("mcp__ns__")).toBe(false);
      }
    }
  });

  it("gives browser tools to exactly the needsBrowser roles and web tools to researcher only", () => {
    const browser = ROLE_NAMES.filter((r) => toolsetFor(r).includes("mcp__chrome-devtools__*"));
    expect(sorted(browser)).toEqual(["browser-tester", "tui-tester", "visual-verifier"]);
    const web = ROLE_NAMES.filter((r) => toolsetFor(r).includes("WebFetch") || toolsetFor(r).includes("WebSearch"));
    expect(web).toEqual(["researcher"]);
  });

  it("READ_ONLY_ROLES equals the read_only cards (11 today)", () => {
    expect(sorted(READ_ONLY_ROLES)).toEqual(readOnlyFromCards());
    expect(READ_ONLY_ROLES).toHaveLength(11);
  });

  it("every entry is a registry name, and only the chrome-devtools entry has a wildcard", () => {
    const known = new Set(TOOL_NAMES);
    for (const role of ROLE_NAMES) {
      for (const tool of toolsetFor(role)) {
        expect(known.has(tool), `${role}: ${tool}`).toBe(true);
        if (tool.includes("*")) expect(tool).toBe("mcp__chrome-devtools__*");
      }
    }
  });

  it("removes mcp__ns__* from the registry and leaves no mcp__ns__ or .mcp.json text in cards or src", () => {
    expect(TOOL_NAMES.some((n) => n.startsWith("mcp__ns__"))).toBe(false);
    for (const dir of [CARDS_DIR, path.join(ROLES_DIR, "src")]) {
      for (const f of readdirSync(dir)) {
        const text = readFileSync(path.join(dir, f), "utf8");
        expect(/mcp__ns__|\.mcp\.json/.test(text), `${f}`).toBe(false);
      }
    }
  });

  it("sdkToolsFor is toolsetFor minus the shell-mediated tools", () => {
    expect([...BASH_MEDIATED_TOOLS]).toEqual(["gh", "git", "fx test"]);
    for (const role of ROLE_NAMES) {
      const expected = toolsetFor(role).filter((t) => !["gh", "git", "fx test"].includes(t));
      expect(sdkToolsFor(role), role).toEqual(expected);
    }
  });

  it("exports ./toolsets from package.json", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROLES_DIR, "package.json"), "utf8"));
    expect(pkg.exports["./toolsets"]).toBe("./src/toolsets.ts");
  });

  it("matches the committed snapshot of all 26 sets", () => {
    const snapshot = JSON.parse(readFileSync(path.join(HERE, "toolsets.snapshot.json"), "utf8"));
    const actual = Object.fromEntries(ROLE_NAMES.map((r) => [r, [...toolsetFor(r)]]));
    expect(actual).toEqual(snapshot);
    expect(Object.keys(snapshot)).toHaveLength(26);
  });
});
