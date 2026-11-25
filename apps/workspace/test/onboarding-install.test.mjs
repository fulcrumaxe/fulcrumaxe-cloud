// apps/workspace/test/onboarding-install.test.mjs
//
// D#845 ON-20b: the install step's feed (parseEngine keeps setup_id, pr_number and pr_state; ctx.install.pr reads them) and the pure half of its panel
// (the summary's shape, every refusal's sentence). The drawn panel, with a fixture per state, is in e2e/onboarding-install.spec.ts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTracks } from "../shell/core/onboarding-mode.js";
import { INSTALL_COPY, categoryCounts, describeStep, installPr, installRefusal, readInstallSummary } from "../apps/onboarding/onboarding-engine.js";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1", "getOnboarding");
const fixture = JSON.parse(readFileSync(join(V1, "200-install-pr.json"), "utf8"));
const SETUP = "3c1c0b7e-5f0a-4c1e-9b1f-0a1b2c3d4e5f";
const withInstall = (over) => parseTracks({ ...fixture, tracks: [fixture.tracks[0], { ...fixture.tracks[1], steps: fixture.tracks[1].steps.map((s) => (s.step === "install" ? { ...s, ...over } : s)) }] }).engine;
const installIndex = 5;

describe("the install step's feed (ON-20b)", () => {
  it("parseEngine keeps setup_id, pr_number and pr_state of the install step, and only there", () => {
    const steps = withInstall({});
    expect(steps[installIndex]).toMatchObject({ step: "install", state: "active", setup_id: SETUP, pr_number: 12, pr_state: "open" });
    expect(steps.filter((s) => "pr_number" in s).map((s) => s.step)).toEqual(["install"]);
    const other = parseTracks({ ...fixture, tracks: [fixture.tracks[0], { ...fixture.tracks[1], steps: fixture.tracks[1].steps.map((s) => (s.step === "live" ? { ...s, setup_id: SETUP, pr_number: 3, pr_state: "open" } : s)) }] }).engine;
    expect(Object.keys(other[6])).not.toContain("pr_number");
  });

  it("a value that does not fit leaves the pull request out; it never fails the track", () => {
    for (const bad of [{ setup_id: "not-a-uuid" }, { pr_number: 0 }, { pr_number: 1.5 }, { pr_number: "12" }, { pr_state: "draft" }, { pr_state: undefined }, { setup_id: undefined }]) {
      const steps = withInstall(bad);
      expect(steps).not.toBeNull();
      expect(Object.keys(steps[installIndex])).not.toEqual(expect.arrayContaining(["pr_number"]));
    }
    expect(withInstall({ setup_id: SETUP.toUpperCase() })[installIndex].setup_id).toBe(SETUP);
  });

  it("installPr feeds ctx.install.pr: open and closed only, with the number", () => {
    expect(installPr(withInstall({}))).toEqual({ number: 12, state: "open" });
    expect(installPr(withInstall({ pr_state: "closed" }))).toEqual({ number: 12, state: "closed" });
    expect(installPr(withInstall({ pr_state: "merged" }))).toBeNull();
    expect(installPr(withInstall({ pr_number: 0 }))).toBeNull();
    expect(installPr(null)).toBeNull();
  });

  it("the install step names the pull request once ctx.install.pr is filled, and says nothing about one when it is not", () => {
    const steps = withInstall({});
    const said = describeStep(steps, installIndex, { install: { pr: installPr(steps) } }).lines;
    expect(said).toContain("Review and merge the install PR #12");
    expect(describeStep(steps, installIndex, {}).lines).not.toContain("Review and merge the install PR #12");
  });
});

const body = (over = {}) => ({
  setup_id: SETUP, pr_number: 12, head_sha: "a".repeat(40), merged: false, pr_url: "https://github.com/acme/api/pull/12",
  totals: { files: 5, added_files: 4, changed_files: 1, additions: 90, deletions: 2 },
  categories: [
    { id: "plan", label: "Your project plan (`docs/PRD.md`, roadmap, 1 epics)", files: 3, added_files: 3, changed_files: 0, additions: 60, deletions: 0 },
    { id: "scripts", label: "2 helper scripts (`scripts/`)", files: 2, added_files: 1, changed_files: 1, additions: 30, deletions: 2 },
  ],
  paths: ["docs/PRD.md", "epics/one.md", "scripts/a.sh", "scripts/b.sh", ".autonomous-team/roadmap.json"],
  ...over,
});

describe("the install summary's shape (ON-20b)", () => {
  it("reads ON-20a's body: categories with counts, every path, and the pull request link", () => {
    const s = readInstallSummary(body(), SETUP);
    expect(s).toMatchObject({ number: 12, url: "https://github.com/acme/api/pull/12", merged: false, total: 5, morePaths: 0 });
    expect(s.categories.map((c) => c.label)).toEqual(["Your project plan (`docs/PRD.md`, roadmap, 1 epics)", "2 helper scripts (`scripts/`)"]);
    expect(s.paths).toHaveLength(5);
    expect(categoryCounts(s.categories[1])).toBe("2 files: 1 added, 1 changed (+30 -2 lines)");
    expect(categoryCounts({ files: 1, added: 1, changed: 0, additions: 4, deletions: 0 })).toBe("1 file: 1 added, 0 changed (+4 -0 lines)");
  });

  it("is null for another setup, a link that is not github.com, or any count that is not a whole number", () => {
    expect(readInstallSummary(body({ setup_id: "9c1c0b7e-5f0a-4c1e-9b1f-0a1b2c3d4e5f" }), SETUP)).toBeNull();
    for (const url of ["http://github.com/a/b/pull/1", "https://evil.example/a/b/pull/1", "javascript:alert(1)", "https://github.com.evil.example/x", "", 7]) expect(readInstallSummary(body({ pr_url: url }), SETUP)).toBeNull();
    expect(readInstallSummary(body({ categories: [{ ...body().categories[0], files: -1 }] }), SETUP)).toBeNull();
    expect(readInstallSummary(body({ categories: [{ ...body().categories[0], label: "" }] }), SETUP)).toBeNull();
    expect(readInstallSummary(null, SETUP)).toBeNull();
    expect(readInstallSummary({ ...body(), paths: "x" }, SETUP)).toBeNull();
  });

  it("keeps text as text: markup in a label or a path comes back as the same string, and a long list is cut with a count", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const s = readInstallSummary(body({ categories: [{ ...body().categories[0], label: evil }], paths: [evil, ...Array.from({ length: 400 }, (_, i) => "f" + i)] }), SETUP);
    expect(s.categories[0].label).toBe(evil);
    expect(s.paths[0]).toBe(evil);
    expect(s.paths).toHaveLength(300);
    expect(s.morePaths).toBe(101);
    expect(readInstallSummary(body({ merged: true }), SETUP).merged).toBe(true);
  });
});

describe("the install panel's refusals (ON-20b)", () => {
  const fail = (status, code, message = "SERVER WORDS") => ({ status, code, message });
  it("install_pr_changed rebuilds the summary and says why", () => {
    expect(installRefusal(fail(409, "install_pr_changed"), false)).toEqual({ code: "install_pr_changed", text: INSTALL_COPY.changed, rebuild: true });
  });
  it("install_pr_files_differ shows our plain line, never the server's", () => {
    const r = installRefusal(fail(409, "install_pr_files_differ"), false);
    expect(r.text).toBe(INSTALL_COPY.differ);
    expect(r.text).not.toContain("SERVER WORDS");
  });
  it("install_pr_blocked shows the server's sentence, and ours when it sent none or an unreasonable one", () => {
    expect(installRefusal(fail(409, "install_pr_blocked", "GitHub will not merge this yet; it may need a passing check or a review first. Finish those on GitHub, then try again"), false).text).toBe("GitHub will not merge this yet; it may need a passing check or a review first. Finish those on GitHub, then try again");
    expect(installRefusal(fail(409, "install_pr_blocked", ""), false).text).toBe(INSTALL_COPY.blocked);
    expect(installRefusal(fail(409, "install_pr_blocked", "x".repeat(301)), false).text).toBe(INSTALL_COPY.blocked);
  });
  it("any other refusal is one of our fixed lines; a server's words reach the screen only for the blocked code", () => {
    expect(installRefusal(fail(403, "forbidden"), false).text).toBe(INSTALL_COPY.member);
    expect(installRefusal(fail(404, "not_found"), false)).toMatchObject({ text: INSTALL_COPY.gone, reread: true });
    expect(installRefusal(fail(409, "setup_phase"), true)).toMatchObject({ text: INSTALL_COPY.gone, reread: true });
    expect(installRefusal(fail(502, "github_unavailable"), false).text).toBe(INSTALL_COPY.mergeFailed);
    expect(installRefusal(fail(502, "github_unavailable"), true).text).toBe(INSTALL_COPY.loadFailed);
    expect(installRefusal(new Error("shape"), true).text).toBe(INSTALL_COPY.loadFailed);
    expect(installRefusal(null, false).text).toBe(INSTALL_COPY.mergeFailed);
    for (const [s, c] of [[403, "forbidden"], [404, "not_found"], [409, "setup_phase"], [502, "x"], [429, "rate_limited"]]) expect(installRefusal(fail(s, c), false).text).not.toContain("SERVER WORDS");
  });
  it("the fixed copy of Item 18 is used as written", () => {
    expect([INSTALL_COPY.changes, INSTALL_COPY.undo, INSTALL_COPY.undoText, INSTALL_COPY.copyLink, INSTALL_COPY.merge, INSTALL_COPY.view]).toEqual(["What merging changes", "How to undo it", "Remove the project, or revert the merge on GitHub", "Copy a link for someone who can merge", "Merge and continue", "View on GitHub"]);
  });
});
