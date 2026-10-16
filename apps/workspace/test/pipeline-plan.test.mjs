// apps/workspace/test/pipeline-plan.test.mjs
//
// D#483 S3-L2b: the logic half of the Plan tab (the import-level names, the fourteen failure sentences, the latest-import
// sentences for every state). The DOM half is in e2e/pipeline-plan.spec.ts. The rules under test: the level key is never
// printed raw (issues_discussions has a name), every error code the database accepts has a sentence, a failed import says the
// previous plan is still shown (or that there is none), and no sentence carries "null" or "undefined".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiFailure } from "../apps/_lib/api.js";
import {
  FAILURE_CODES,
  IMPORT_REFUSALS,
  LEVEL_WORDS,
  REMOVE_REFUSALS,
  STALE_MS,
  STALE_SENTENCE,
  failureSentence,
  fallbackSentence,
  importIsLive,
  importRefusal,
  importSentences,
  levelWords,
  removeRefusal,
  succeededLine,
  taskStatusWords,
} from "../apps/pipeline/pipeline-insight.js";

const BAD = /\b(null|undefined|NaN|\[object)/;
const NOW = Date.parse("2026-10-16T12:00:00Z");
const ok = { id: "i1", state: "succeeded", level: "roadmap_file", source_path: ".autonomous-team/roadmap.json", counts: { tasks: 520, done: 242, remaining: 278 }, truncated: false, error_code: null, error_detail: null, started_at: "2026-10-16T11:58:00Z", finished_at: "2026-10-16T11:59:00Z" };

describe("the migrations and the sentences agree", () => {
  it("every error code the CHECK accepts (0723, 0755, 0758) has a failure sentence of its own", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = ["0723_plan_import.sql", "0755_plan_import_budget_code.sql", "0758_plan_import_source_too_large.sql"].map((f) => readFileSync(join(here, "..", "..", "..", "packages", "db", "migrations", f), "utf8")).join("\n");
    const accepted = new Set([...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    for (const code of FAILURE_CODES) expect(accepted.has(code), code).toBe(true);
    expect(FAILURE_CODES).toHaveLength(14);
    expect(new Set(FAILURE_CODES.map((c) => failureSentence(c, "the first problem"))).size).toBe(14);
  });
  it("no failure sentence prints a code, null or undefined, with a detail or without one", () => {
    for (const code of FAILURE_CODES) {
      for (const detail of [null, undefined, "", "task X appears twice"]) {
        const s = failureSentence(code, detail);
        expect(s, code).not.toMatch(BAD);
        expect(s).not.toContain(code);
      }
    }
    expect(failureSentence("a_new_code", null)).toBe("The last import failed, so nothing was changed. Try again in a moment.");
  });
  it("the two codes that name a problem carry it, and the permission one names the fix", () => {
    expect(failureSentence("plan_file_inconsistent", "task D#1:A is listed twice")).toContain("task D#1:A is listed twice");
    expect(failureSentence("plan_file_shape", "milestones is not a list")).toBe("roadmap.json didn't match the expected shape: milestones is not a list. Nothing was changed.");
    expect(failureSentence("app_permission_missing")).toMatch(/accept the new permissions/);
    expect(failureSentence("plan_source_too_large")).toMatch(/Hiding spam comments on GitHub brings the count back down/);
    expect(failureSentence("request_budget_exhausted")).toMatch(/more requests than one import is allowed/);
  });
});

describe("levels", () => {
  it("every level has a name and the raw key is never printed", () => {
    expect(Object.keys(LEVEL_WORDS)).toEqual(["roadmap_file", "spec_tables", "issues_discussions"]);
    expect(levelWords("issues_discussions")).toBe("your open issues and Discussions");
    expect(levelWords("spec_tables")).toBe("the Spec task tables in your Discussions");
    expect(levelWords("future_level")).toBe("the repository");
    expect(levelWords(null)).toBe("the repository");
    for (const level of ["roadmap_file", "spec_tables", "issues_discussions", "odd", null]) expect(succeededLine({ ...ok, level, source_path: null })).not.toMatch(/issues_discussions|spec_tables|roadmap_file|null/);
  });
  it("a fallback level says which level and why", () => {
    expect(fallbackSentence("roadmap_file", null)).toBeNull();
    expect(fallbackSentence("spec_tables", null)).toMatch(/Spec task tables/);
    expect(fallbackSentence("issues_discussions", "milestones is not a list")).toMatch(/open issues and Discussions.*roadmap file was skipped because: milestones is not a list\./);
  });
});

describe("the latest import line", () => {
  it("never imported, queued, importing", () => {
    expect(importSentences(null, null, NOW)).toEqual(["Nothing has been imported for this repository yet. Import its plan to see its milestones and tasks."]);
    expect(importSentences({ ...ok, state: "queued", finished_at: null }, null, NOW)[0]).toMatch(/queued/);
    expect(importSentences({ ...ok, state: "running", finished_at: null }, null, NOW)[0]).toMatch(/^Importing the plan from GitHub/);
  });
  it("an import still running after ten minutes is stopped, and the next start is allowed", () => {
    const stale = { ...ok, state: "running", finished_at: null, started_at: new Date(NOW - STALE_MS - 1000).toISOString() };
    expect(importIsLive(stale, NOW)).toBe(false);
    expect(importIsLive({ ...stale, started_at: new Date(NOW - 1000).toISOString() }, NOW)).toBe(true);
    expect(importSentences(stale, null, NOW)[0]).toBe(STALE_SENTENCE);
  });
  it("succeeded: the numbers come from the import's counts, and a missing count drops the numbers", () => {
    expect(succeededLine(ok)).toMatch(/^Imported from the roadmap file \.autonomous-team\/roadmap\.json, .*: 520 tasks, 242 done, 278 remaining\.$/);
    expect(succeededLine({ ...ok, counts: {} })).toMatch(/\.$/);
    expect(succeededLine({ ...ok, counts: {} })).not.toMatch(/tasks/);
    expect(succeededLine({ ...ok, counts: null, finished_at: null })).toBe("Imported from the roadmap file .autonomous-team/roadmap.json.");
  });
  it("succeeded at a fallback level, and truncated", () => {
    const s = importSentences({ ...ok, level: "spec_tables", source_path: null, truncated: true }, { ...ok }, NOW);
    expect(s).toHaveLength(3);
    expect(s[0]).toMatch(/^Imported from the Spec task tables/);
    expect(s[1]).toMatch(/No usable roadmap file/);
    expect(s[2]).toMatch(/size limit/);
  });
  it("failed with an earlier plan: says it is still shown, with when it was imported", () => {
    const failed = { ...ok, id: "i2", state: "failed", error_code: "plan_source_too_large", counts: {} };
    const s = importSentences(failed, ok, NOW);
    expect(s[0]).toMatch(/more planning Discussions/);
    expect(s[1]).toMatch(/^Your previous plan, imported .+, is still shown\.$/);
  });
  it("failed with no earlier plan: says there is nothing to show", () => {
    const s = importSentences({ ...ok, state: "failed", error_code: "discussions_disabled" }, null, NOW);
    expect(s[1]).toBe("There is no earlier plan, so nothing is shown below.");
  });
  it("no sentence of any state prints null or undefined", () => {
    for (const state of ["queued", "running", "succeeded", "failed"]) {
      for (const level of ["roadmap_file", "spec_tables", "issues_discussions", null]) {
        const imp = { id: "z", state, level, source_path: null, counts: {}, truncated: false, error_code: state === "failed" ? "internal_error" : null, error_detail: null, started_at: null, finished_at: null };
        for (const s of importSentences(imp, state === "failed" ? null : imp, NOW)) expect(s).not.toMatch(BAD);
      }
    }
  });
});

describe("refusals", () => {
  it("an import start or a plan removal that is refused reads as a fixed sentence", () => {
    for (const code of Object.keys(IMPORT_REFUSALS)) expect(importRefusal(new ApiFailure(409, code, "server text"))).toBe(IMPORT_REFUSALS[code]);
    for (const code of Object.keys(REMOVE_REFUSALS)) expect(removeRefusal(new ApiFailure(409, code, "server text"))).toBe(REMOVE_REFUSALS[code]);
    expect(removeRefusal(new ApiFailure(409, "import_running", "x"))).toMatch(/can't be removed yet/);
    expect(importRefusal(new ApiFailure(429, "rate_limited", "x", undefined, 90))).toBe("Too many imports for this repository in the last hour. Try again in 90 seconds.");
    expect(importRefusal(new ApiFailure(409, "odd", "server text"))).toBe("That didn't work. Nothing was changed.");
    for (const s of [...Object.values(IMPORT_REFUSALS), ...Object.values(REMOVE_REFUSALS)]) expect(s).not.toMatch(BAD);
  });
  it("a task status without words reads as nothing, never as its key", () => {
    expect(taskStatusWords("pending_spec")).toBe("Waiting for a Spec");
    expect(taskStatusWords("odd")).toBe("");
  });
});
