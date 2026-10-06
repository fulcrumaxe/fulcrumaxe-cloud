import { describe, expect, it } from "vitest";
import { ROLE_MANIFEST } from "@fx/roles";
import { EXECUTOR_TOOLS, OTHER_ROLE_TOOLS, REVIEWER_TOOLS, toolsForRole } from "@fx/runner";

/**
 * D#483 P3: the runner's per-role tool lists against the role manifest. A role added to the manifest gets the narrowest
 * list (read, curl, git, read-only helpers) until someone names it in the runner; only the roles named there get more.
 */
describe("agent tool lists follow the role manifest", () => {
  const EDITS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

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
