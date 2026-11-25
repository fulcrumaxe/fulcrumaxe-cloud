import { describe, expect, it } from "vitest";
import { INSTALL_SUMMARY_CATEGORIES, summarizeInstall } from "../src/onboarding/installSummary.js";

const f = (path: string, additions = 1, deletions = 0, changeType = "ADDED") => ({ path, changeType, additions, deletions });

/** D#845 ON-20a: the install summary is a pure count over the pull request's files, in the Spec's six fixed categories. */
describe("summarizeInstall", () => {
  it("puts every file in exactly one of the six categories (the first that fits), in the fixed order, with the Spec's copy and the epic count", () => {
    const s = summarizeInstall([
      f("docs/PRD.md", 30), f(".autonomous-team/roadmap.json", 20), f("epics/01-a.md"), f("epics/02-b.md"), f("epics/03-c.md"),
      f(".autonomous-team/project.json", 8), f("scripts/a.sh", 7), f("scripts/b.sh"),
      f("CLAUDE.md", 3, 2, "MODIFIED"), f(".claude/agents/a.md", 10), f(".claude/settings.json", 2, 1, "MODIFIED"),
      f("hooks/sandbox.py", 50), f("src/app.ts", 1, 1, "MODIFIED"), f("README.md"), f("package.json", 1, 1, "MODIFIED"),
    ]);
    expect(s.categories.map((c) => [c.id, c.label, c.files])).toEqual([
      ["plan", "Your project plan (`docs/PRD.md`, roadmap, 3 epics)", 5],
      ["team", "The team's settings (`.autonomous-team/`)", 1],
      ["scripts", "2 helper scripts (`scripts/`)", 2],
      ["agents", "The agents' instructions (`CLAUDE.md`, `.claude/`)", 3],
      ["hook", "The sandbox hook", 1],
      ["other", "3 other files", 3],
    ]);
    expect(s.categories.reduce((n, c) => n + c.files, 0)).toBe(s.totals.files);
    expect(s.categories.find((c) => c.id === "agents")).toMatchObject({ added_files: 1, changed_files: 2, additions: 15, deletions: 3 });
    expect(s.totals).toEqual({ files: 15, added_files: 11, changed_files: 4, additions: 137, deletions: 5 });
  });

  it("the sandbox hook is exactly its two files, hooks/sandbox.py and hooks/sandbox_rules.py, and nothing else under hooks/", () => {
    const s = summarizeInstall([f("hooks/sandbox.py"), f("hooks/sandbox_rules.py", 4), f("hooks/other.py"), f("hooks/sandbox_rules.pyc"), f("hooks/x/sandbox.py")]);
    expect(s.categories.map((c) => [c.id, c.files])).toEqual([["hook", 2], ["other", 3]]);
    expect(s.categories[0]).toMatchObject({ label: "The sandbox hook", additions: 5 });
  });

  it("counts files added and files changed apart, by GitHub's change type: ADDED is added, everything else (modified, renamed, copied) is changed", () => {
    const s = summarizeInstall([f("a.txt"), f("b.txt", 1, 1, "MODIFIED"), f("c.txt", 0, 0, "RENAMED"), f("d.txt", 1, 0, "CHANGED")]);
    expect(s.totals).toMatchObject({ files: 4, added_files: 1, changed_files: 3 });
  });

  it("an empty list is an empty summary, and a category with no file is not listed", () => {
    expect(summarizeInstall([])).toEqual({ totals: { files: 0, added_files: 0, changed_files: 0, additions: 0, deletions: 0 }, categories: [], paths: [] });
    expect(summarizeInstall([f("scripts/a.sh")]).categories.map((c) => c.id)).toEqual(["scripts"]);
  });

  it("matches by the path as written: a look-alike directory, a nested one and another case are other files", () => {
    for (const path of ["src/scripts/a.sh", "myscripts/a.sh", "Scripts/a.sh", "claude.md", "docs/prd.md", "x/.claude/agents/a.md", ".claudex/a.md", "hooks/other.py", "src/epics/a.md", ".autonomous-teams/a"]) {
      expect(summarizeInstall([f(path)]).categories.map((c) => c.id), path).toEqual(["other"]);
    }
  });

  it("lists every path, sorted, as plain data; categories carry counts and fixed copy only", () => {
    const s = summarizeInstall([f("scripts/z.sh"), f(".claude/agents/<script>.md"), f("a b.md")]);
    expect(s.paths).toEqual([".claude/agents/<script>.md", "a b.md", "scripts/z.sh"]);
    expect(JSON.stringify(s.categories)).not.toContain("<script>");
    expect(INSTALL_SUMMARY_CATEGORIES.map((c) => c.id)).toEqual(["plan", "team", "scripts", "agents", "hook", "other"]);
    expect(INSTALL_SUMMARY_CATEGORIES.at(-1)!.fits("anything")).toBe(true);
  });
});
