import { describe, expect, it } from "vitest";
import { EXECUTOR_TOOLS, FX_AGENT_SETTINGS, OTHER_ROLE_TOOLS, REVIEWER_TOOLS, agentSettingsFor, toolsForRole } from "../src/agentConfig.js";

/**
 * D#483 P3 (owner ruling): every role's settings carry an explicit tool allow list and `defaultMode: "dontAsk"`, the
 * same for a fresh run and a resumed one. The lists below are written out LITERALLY, not built from the constants, so a
 * change to a list shows up here as a deliberate edit that a reviewer reads.
 */
const READ = ["Read", "Glob", "Grep", "LS"];
const TEST = ["Bash(git:*)", "Bash(node:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(pnpm:*)", "Bash(yarn:*)"];
const HELPERS = ["Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(date:*)", "Bash(pwd)", "Bash(echo:*)", "Bash(diff:*)", "Bash(test:*)"];

const EXECUTOR = [...READ, "Edit", "MultiEdit", "Write", "NotebookEdit", ...TEST, ...HELPERS, "Bash(curl:*)", "Bash(mkdir:*)", "Bash(rm:*)", "Bash(mv:*)", "Bash(cp:*)", "Bash(touch:*)"];
const REVIEWER = [...READ, ...TEST, "Bash(mkdir:*)", ...HELPERS];
const OTHER = [...READ, "Bash(curl:*)", "Bash(git:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(pwd)"];

/** The manifest's other roles (packages/roles/src/manifest.ts); packages/worker agentRolesParity.test.ts pins the manifest to these lists. */
const OTHER_ROLE_NAMES = [
  "project-manager", "technical-architect", "product-owner", "cost-analyst", "performance-expert", "security-expert", "researcher", "feedback-scanner", "incident-commander", "browser-tester", "tui-tester", "docs-writer",
  "release-manager", "runbook-writer", "accessibility-reviewer", "ux-designer", "mission-analyst", "run-analyst", "analytics-engineer", "visual-verifier", "quality-sweep",
];
const ALL_ROLE_NAMES = ["executor", "code-reviewer", "security-reviewer", "acceptance-tester", "debater", ...OTHER_ROLE_NAMES];

const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

describe("per-role tool permissions", () => {
  it("the executor may read, edit and write, run git, node and the package managers, curl, and do basic file operations", () => {
    expect([...toolsForRole("executor")]).toEqual(EXECUTOR);
    expect([...EXECUTOR_TOOLS]).toEqual(EXECUTOR);
    for (const t of ["Edit", "Write", "Bash(git:*)", "Bash(node:*)", "Bash(pnpm:*)", "Bash(npm:*)", "Bash(curl:*)", "Bash(rm:*)"]) expect(toolsForRole("executor")).toContain(t);
  });

  it.each(["code-reviewer", "security-reviewer", "acceptance-tester", "debater"])("%s may read, run git, node and the test runners, and has NO edit or write tool and no curl", (role) => {
    expect([...toolsForRole(role)]).toEqual(REVIEWER);
    for (const t of EDIT_TOOLS) expect(toolsForRole(role)).not.toContain(t);
    expect(toolsForRole(role)).not.toContain("Bash(curl:*)");
    expect(toolsForRole(role)).not.toContain("Bash(rm:*)");
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

  it("no list allows a bare tool that would widen it: no wildcard, no unrestricted Bash, no WebFetch or WebSearch, no MCP tool", () => {
    for (const list of [EXECUTOR_TOOLS, REVIEWER_TOOLS, OTHER_ROLE_TOOLS]) {
      for (const t of list) {
        expect(t).not.toBe("Bash");
        expect(t).not.toBe("*");
        expect(t).not.toMatch(/^(WebFetch|WebSearch|mcp__)/);
        if (t.startsWith("Bash(")) expect(t).toMatch(/^Bash\([a-z]+(:\*)?\)$/);
      }
      expect(new Set(list).size).toBe(list.length);
    }
  });
});
