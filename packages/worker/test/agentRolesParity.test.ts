import { describe, expect, it } from "vitest";
import { ROLE_MANIFEST } from "@fx/roles";
import { EXECUTOR_TOOLS, OTHER_ROLE_TOOLS, PLATFORM_ROLES, REVIEWER_TOOLS, TOOL_LISTED_ROLES, toolsForRole } from "@fx/runner";

/**
 * D#483 P3: the runner's per-role tool lists against the role manifest. The runner has no fallback list: a role it does
 * not name gets no tools and its run is refused (`unknown_role`), so every manifest role must be named there, and the
 * runner names no role the manifest lacks other than its named platform roles (`PLATFORM_ROLES`, today the claim verifier
 * and the discovery analyst), which the manifest must not also hold.
 */
describe("agent tool lists follow the role manifest", () => {
  const EDITS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

  it("the runner's tool table names exactly the manifest's roles plus the named platform roles", () => {
    const manifest = ROLE_MANIFEST.map((r) => r.name);
    expect([...PLATFORM_ROLES]).toEqual(["proposal-verifier", "discovery-analyst"]);
    for (const role of PLATFORM_ROLES) expect(manifest, role).not.toContain(role);
    expect([...TOOL_LISTED_ROLES].sort()).toEqual([...manifest, ...PLATFORM_ROLES].sort());
  });

  it("a platform role can neither edit nor run a shell", () => {
    for (const role of PLATFORM_ROLES) {
      const tools = toolsForRole(role);
      for (const t of EDITS) expect(tools, role).not.toContain(t);
      expect(tools.some((t) => t === "Bash" || t.startsWith("Bash(")), role).toBe(false);
    }
  });

  it("every manifest role gets exactly one of the three lists", () => {
    for (const { name } of ROLE_MANIFEST) {
      const tools = toolsForRole(name);
      expect([EXECUTOR_TOOLS, REVIEWER_TOOLS, OTHER_ROLE_TOOLS].some((l) => l === tools), name).toBe(true);
    }
  });

  it("only the executor can edit, only the executor and the reviewing roles can run node, and nobody else is named", () => {
    const byList = (list: readonly string[]) => ROLE_MANIFEST.filter((r) => toolsForRole(r.name) === list).map((r) => r.name);
    expect(byList(EXECUTOR_TOOLS)).toEqual(["executor"]);
    expect(byList(REVIEWER_TOOLS).sort()).toEqual(["acceptance-tester", "code-reviewer", "debater", "security-reviewer"]);
    for (const { name } of ROLE_MANIFEST) {
      const canEdit = EDITS.some((t) => toolsForRole(name).includes(t));
      expect(canEdit, name).toBe(name === "executor");
    }
  });
});
