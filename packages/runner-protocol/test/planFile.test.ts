import { describe, expect, it } from "vitest";
import { MAX_PLAN_BYTES, MAX_PLAN_ROWS, PlanFile, setupPlanPath } from "../src/planFile.js";

/** D#845 ON-8c: the plan file is strict at every depth, and its rows hang together. */
const ID = "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f";
const row = (key: string, depends_on: string[] = []) => ({ row_key: key, title: `Title ${key}`, summary: "s", size: "M", depends_on });
const plan = (over: Record<string, unknown> = {}) => ({
  v: 1,
  draft_id: ID,
  version: 1,
  prd_md: "# P\n",
  roadmap: [row("A1"), row("B2", ["A1"])],
  setup: { kind: "new", repo_owner: "acme", repo_name: "widgets", default_branch: "main", visibility: "private", boss_github_username: "jane" },
  ...over,
});
const ok = (value: unknown): boolean => PlanFile.safeParse(value).success;

describe("PlanFile", () => {
  it("accepts a whole plan and a plan with no rows", () => {
    expect(ok(plan())).toBe(true);
    expect(ok(plan({ roadmap: [] }))).toBe(true);
  });

  it("is strict at every depth", () => {
    expect(ok(plan({ extra: 1 }))).toBe(false);
    expect(ok(plan({ roadmap: [{ ...row("A1"), keep: true }] }))).toBe(false);
    expect(ok(plan({ setup: { ...plan().setup, token: "x" } }))).toBe(false);
  });

  it("refuses a row that is not well formed, a repeated key and a dependency that is not kept or is itself", () => {
    expect(ok(plan({ roadmap: [row("a1")] }))).toBe(false);
    expect(ok(plan({ roadmap: [{ ...row("A1"), size: "XL" }] }))).toBe(false);
    expect(ok(plan({ roadmap: [{ ...row("A1"), title: "" }] }))).toBe(false);
    expect(ok(plan({ roadmap: [{ ...row("A1"), title: "a\u0007b" }] }))).toBe(false);
    expect(ok(plan({ roadmap: [row("A1"), row("A1")] }))).toBe(false);
    expect(ok(plan({ roadmap: [row("A1", ["Z9"])] }))).toBe(false);
    expect(ok(plan({ roadmap: [row("A1", ["A1"])] }))).toBe(false);
    expect(ok(plan({ roadmap: Array.from({ length: MAX_PLAN_ROWS + 1 }, (_, i) => row(`R${i}`)) }))).toBe(false);
    expect(ok(plan({ roadmap: Array.from({ length: MAX_PLAN_ROWS }, (_, i) => row(`R${i}`)) }))).toBe(true);
  });

  it("refuses a setup with an odd owner, repo, visibility or kind", () => {
    for (const bad of [{ repo_owner: "-x" }, { repo_owner: "a/b" }, { repo_name: "a b" }, { repo_name: ".." + "x".repeat(200) }, { visibility: "internal" }, { kind: "other" }, { boss_github_username: "" }, { default_branch: "" }]) {
      expect(ok(plan({ setup: { ...plan().setup, ...bad } })), JSON.stringify(bad)).toBe(false);
    }
  });

  it("keeps heading-bound text on one line: a title with LF, CR, tab or a Unicode line break is refused", () => {
    for (const bad of ["a\nb", "a\rb", "a\tb", "a\u2028b", "a\u0085b"]) expect(ok(plan({ roadmap: [{ ...row("A1"), title: bad }] })), JSON.stringify(bad)).toBe(false);
  });

  it("holds the default branch to a git ref grammar", () => {
    for (const good of ["main", "release/1.2", "feature-x_y+z", "v1.0.0"]) expect(ok(plan({ setup: { ...plan().setup, default_branch: good } })), good).toBe(true);
    for (const bad of ["", "-main", "/main", "main/", "a..b", "a b", "a\tb", "a\nb", "a//b", "a/.hidden", ".hidden", "x.lock", "a.", "@", "a@{b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "--upload-pack=x", "x".repeat(201)]) {
      expect(ok(plan({ setup: { ...plan().setup, default_branch: bad } })), JSON.stringify(bad)).toBe(false);
    }
  });

  it("limits the PRD to 200,000 characters and 1 to start with", () => {
    expect(ok(plan({ prd_md: "x".repeat(200_000) }))).toBe(true);
    expect(ok(plan({ prd_md: "x".repeat(200_001) }))).toBe(false);
    expect(ok(plan({ prd_md: "" }))).toBe(false);
  });
});

describe("the route", () => {
  it("is one fixed path with the version, and the limit is a mebibyte", () => {
    expect(setupPlanPath(ID, 3)).toBe(`/api/runner/setup/${ID}/plan?version=3`);
    expect(MAX_PLAN_BYTES).toBe(1024 * 1024);
  });
});
