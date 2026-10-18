import { describe, expect, it } from "vitest";
import { EXCLUDE_PROMPT_LINE, EXECUTOR_TOOLS, FX_AGENT_SETTINGS, MAX_EXCLUDE_RULES, OTHER_ROLE_TOOLS, REVIEWER_TOOLS, agentSettingsFor, escapeRulePath, excludeDenyRules, toolsForRole } from "../src/agentConfig.js";

/**
 * D#483 P3 (owner ruling): every role's settings carry an explicit tool allow list and `defaultMode: "dontAsk"`, the
 * same for a fresh run and a resumed one. The lists below are written out LITERALLY, not built from the constants, so a
 * change to a list shows up here as a deliberate edit that a reviewer reads.
 */
const READ = ["Read", "Glob", "Grep", "LS"];

// R-C44-1 (owner, 2026-10-10): these roles hold plain Bash; the OS sandbox / VM is the boundary.
const EXECUTOR = [...READ, "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"];
const REVIEWER = [...READ, "Bash"];
const OTHER = [...READ, "Bash(curl:*)", "Bash(git:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(pwd)"];

/** The manifest's other roles (packages/roles/src/manifest.ts); packages/worker agentRolesParity.test.ts pins the manifest to these lists. */
const OTHER_ROLE_NAMES = [
  "project-manager", "technical-architect", "product-owner", "cost-analyst", "performance-expert", "security-expert", "researcher", "feedback-scanner", "incident-commander", "browser-tester", "tui-tester", "docs-writer",
  "release-manager", "runbook-writer", "accessibility-reviewer", "ux-designer", "mission-analyst", "run-analyst", "analytics-engineer", "visual-verifier", "quality-sweep",
];
const ALL_ROLE_NAMES = ["executor", "code-reviewer", "security-reviewer", "acceptance-tester", "debater", ...OTHER_ROLE_NAMES];

const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

describe("per-role tool permissions", () => {
  it("the executor may read, edit and write, and use plain Bash (no Bash prefix entries)", () => {
    expect([...toolsForRole("executor")]).toEqual(EXECUTOR);
    expect([...EXECUTOR_TOOLS]).toEqual(EXECUTOR);
    for (const t of ["Edit", "Write", "Bash"]) expect(toolsForRole("executor")).toContain(t);
    expect(toolsForRole("executor").filter((t) => t.startsWith("Bash("))).toEqual([]);
  });

  it.each(["code-reviewer", "security-reviewer", "acceptance-tester", "debater"])("%s may read and use plain Bash, and has NO edit or write tool", (role) => {
    expect([...toolsForRole(role)]).toEqual(REVIEWER);
    for (const t of EDIT_TOOLS) expect(toolsForRole(role)).not.toContain(t);
    expect(toolsForRole(role)).toContain("Bash");
    expect(toolsForRole(role).filter((t) => t.startsWith("Bash("))).toEqual([]);
    expect([...REVIEWER_TOOLS]).toEqual(REVIEWER);
  });

  it("every other role in the manifest may read, curl, run git and use read-only helpers, and nothing that edits", () => {
    for (const role of OTHER_ROLE_NAMES) {
      expect([...toolsForRole(role)], role).toEqual(OTHER);
      for (const t of EDIT_TOOLS) expect(toolsForRole(role)).not.toContain(t);
      for (const t of ["Bash(node:*)", "Bash(npm:*)", "Bash(rm:*)", "Bash(mkdir:*)"]) expect(toolsForRole(role), role).not.toContain(t);
    }
    expect([...OTHER_ROLE_TOOLS]).toEqual(OTHER);
    // A name that is no role at all gets the look-only list too (fail to the narrowest).
    expect([...toolsForRole("no-such-role")]).toEqual(OTHER);
    expect([...toolsForRole("__proto__")]).toEqual(OTHER);
    expect([...toolsForRole("constructor")]).toEqual(OTHER);
  });

  it("the settings are the runner's hook plus the role's allow list and dontAsk, and the same call gives the same bytes (fresh and resumed)", () => {
    for (const role of ALL_ROLE_NAMES) {
      const settings = agentSettingsFor(role) as { disableAllHooks: boolean; hooks: unknown; permissions: { defaultMode: string; allow: string[]; deny: string[] } };
      expect(settings.permissions.defaultMode).toBe("dontAsk");
      expect(settings.permissions.allow).toEqual([...toolsForRole(role)]);
      expect(settings.permissions.deny).toEqual([]);
      expect(settings.hooks).toEqual(FX_AGENT_SETTINGS.hooks);
      expect(settings.disableAllHooks).toBe(false);
      expect(JSON.stringify(agentSettingsFor(role))).toBe(JSON.stringify(agentSettingsFor(role)));
      // Nothing but these four keys: no env, apiKeyHelper, plugins, model or statusLine.
      expect(Object.keys(settings).sort()).toEqual(["disableAllHooks", "hooks", "permissions"]);
    }
  });

  it("no list allows a wildcard, WebFetch, WebSearch or an MCP tool, and only the executor and reviewer lists hold plain Bash", () => {
    expect(OTHER_ROLE_TOOLS).not.toContain("Bash");
    for (const list of [EXECUTOR_TOOLS, REVIEWER_TOOLS, OTHER_ROLE_TOOLS]) {
      for (const t of list) {
        expect(t).not.toBe("*");
        expect(t).not.toMatch(/^(WebFetch|WebSearch|mcp__)/);
        if (t.startsWith("Bash(")) expect(t).toMatch(/^Bash\([a-z]+(:\*)?\)$/);
      }
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe("D#600 CX-5b: excludes become deny rules", () => {
  it("each path is denied as itself and as a folder, and Grep and Glob are denied once, whatever the number of paths", () => {
    expect(excludeDenyRules(["secret/a.txt"])).toEqual(["Read(secret/a.txt)", "Read(secret/a.txt/**)", "Grep", "Glob"]);
    const two = excludeDenyRules(["b.env", "a/*.pem", "b.env"]);
    expect(two).toEqual(["Read(a/*.pem)", "Read(a/*.pem/**)", "Read(b.env)", "Read(b.env/**)", "Grep", "Glob"]);
    expect(two.filter((r) => r === "Grep")).toHaveLength(1);
    expect(excludeDenyRules([])).toEqual([]);
  });

  it("a glob stays a glob: * and ? are left alone", () => {
    expect(escapeRulePath("**/*.pem")).toBe("**/*.pem");
    expect(escapeRulePath("src/?/a*.ts")).toBe("src/?/a*.ts");
  });

  it("an exclude keeps full glob syntax: a character class or brace stays a class or brace; only ( ) are escaped, in both modes", () => {
    expect(escapeRulePath("src/**/[ab].ts")).toBe("src/**/[ab].ts");
    expect(excludeDenyRules(["src/**/[ab].ts"])).toEqual(["Read(src/**/[ab].ts)", "Read(src/**/[ab].ts/**)", "Grep", "Glob"]);
    expect(escapeRulePath("a/{b,c}.txt")).toBe("a/{b,c}.txt");
    expect(escapeRulePath("app/(group)/page.tsx")).toBe("app/\\(group\\)/page.tsx");
    expect(escapeRulePath("app/(group)/page.tsx", "literal")).toBe("app/\\(group\\)/page.tsx");
  });

  it("a literal path (a pin, or any exact path) escapes [ ] { } too: a Next.js folder is one file, never a character class or a brace", () => {
    expect(escapeRulePath("app/[id]/page.tsx", "literal")).toBe("app/\\\\[id\\\\]/page.tsx");
    expect(escapeRulePath("a{b,c}.txt", "literal")).toBe("a\\\\{b,c\\\\}.txt");
    expect(excludeDenyRules(["app/[id]/page.tsx"], "literal")[0]).toBe("Read(app/\\\\[id\\\\]/page.tsx)");
    // No parenthesis reaches the rule syntax bare, whatever else the path holds.
    for (const mode of ["glob", "literal"] as const) {
      const body = excludeDenyRules(["x/[a]/{b}/(c)/d"], mode)[0]!.slice("Read(".length, -1);
      expect(body).not.toMatch(/(^|[^\\])[()]/);
    }
  });

  it("a leading ! or #, and a trailing space, are escaped so they stay part of the name", () => {
    expect(escapeRulePath("!important.txt")).toBe("\\\\!important.txt");
    expect(escapeRulePath("#notes")).toBe("\\\\#notes");
    expect(escapeRulePath("a/b ")).toBe("a/b\\\\ ");
    expect(escapeRulePath("a!b#c")).toBe("a!b#c");
  });

  it("the deny list goes into every role's settings; with none the deny list is empty, as before this row; the order of the paths does not change the bytes", () => {
    for (const role of ALL_ROLE_NAMES) {
      const withRules = agentSettingsFor(role, ["z.txt", "a/b"]) as { permissions: { deny: string[]; allow: string[]; defaultMode: string } };
      expect(withRules.permissions.deny).toEqual(["Read(a/b)", "Read(a/b/**)", "Read(z.txt)", "Read(z.txt/**)", "Grep", "Glob"]);
      expect(withRules.permissions.allow).toEqual([...toolsForRole(role)]);
      expect(withRules.permissions.defaultMode).toBe("dontAsk");
      expect(JSON.stringify(agentSettingsFor(role, ["z.txt", "a/b"]))).toBe(JSON.stringify(agentSettingsFor(role, ["a/b", "z.txt"])));
      expect(JSON.stringify(agentSettingsFor(role, []))).toBe(JSON.stringify(agentSettingsFor(role)));
    }
  });

  it("fails closed: a path that cannot be written as a rule, or too many paths, throws instead of leaving a rule out", () => {
    for (const bad of ["", "/abs/path", "~/x", "../x", "a/../b", "a//b", "./a", "a\\b", "a\nb", "x".repeat(513)]) expect(() => excludeDenyRules([bad]), JSON.stringify(bad)).toThrow();
    expect(() => excludeDenyRules(Array.from({ length: MAX_EXCLUDE_RULES + 1 }, (_, i) => `p${i}`))).toThrow();
    expect(excludeDenyRules(Array.from({ length: MAX_EXCLUDE_RULES }, (_, i) => `p${i}`))).toHaveLength(MAX_EXCLUDE_RULES * 2 + 2);
  });

  it("the prompt line says it is a context control and not a security boundary, and names no path", () => {
    expect(EXCLUDE_PROMPT_LINE).toContain("not a security boundary");
    expect(EXCLUDE_PROMPT_LINE).not.toMatch(/[/*]/);
  });
});
