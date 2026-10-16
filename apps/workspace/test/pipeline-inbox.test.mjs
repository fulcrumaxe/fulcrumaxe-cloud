// apps/workspace/test/pipeline-inbox.test.mjs
//
// D#483 S3-L2b: the logic half of the Inbox tab (sentences, badges, details, row validation, retry rules). The DOM half is in
// e2e/pipeline-inbox.spec.ts. The rules under test: every outcome a person reads is a fixed sentence (never a server code or
// message), a malformed row is left out, an absent value is never drawn as "null" or "undefined", and the Idempotency-Key
// survives an unknown outcome only.
import { describe, expect, it } from "vitest";
import { ApiFailure } from "../apps/_lib/api.js";
import { DETACHED_SENTENCE, INBOX_DONE as DONE, FILTERS, NOT_STARTED, REFUSALS, INBOX_SENDING as SENDING, approvedSentence, badgesFor, detailsFor, outcomeUnknown, refusalSentence, stageWords, validProposal } from "../apps/pipeline/pipeline-actions.js";

const BAD = /\b(null|undefined|NaN|\[object)/;
const base = { id: "p1", title: "Add dark mode", state: "new", sources: ["github_issue"], gh_number: 12, discussion_number: null, task_key: null, category_hint: null, estimate_usd: null, milestone_key: null, milestone_title: null };

describe("filters", () => {
  it("are the five of the Spec, in order, each with an empty-state sentence", () => {
    expect(FILTERS.map((f) => f.label)).toEqual(["New", "Approved", "Rejected", "Closed at source", "Your own loop"]);
    for (const f of FILTERS) {
      expect(f.empty.length).toBeGreaterThan(10);
      expect(f.empty).not.toMatch(BAD);
    }
    expect(FILTERS.find((f) => f.key === "new").query).toBe("state=new&owner=product");
    expect(FILTERS.find((f) => f.key === "own_loop").query).toBe("owner=internal_loop");
  });
});

describe("rows", () => {
  it("validProposal rejects a row that would be drawn with holes", () => {
    expect(validProposal(base)).toBe(true);
    for (const bad of [null, {}, { ...base, id: "" }, { ...base, title: "" }, { ...base, title: null }, { ...base, state: "odd" }, { ...base, sources: null }]) expect(validProposal(bad)).toBe(false);
  });
  it("badgesFor names every source the way the Spec words it", () => {
    expect(badgesFor(base)).toEqual(["Issue #12"]);
    expect(badgesFor({ ...base, sources: ["github_discussion"], gh_number: null, discussion_number: 483 })).toEqual(["Discussion #483"]);
    expect(badgesFor({ ...base, sources: ["plan_task", "preview"], gh_number: null, task_key: "D#2:H14a" })).toEqual(["Task D#2 · H14a", "Preview"]);
    expect(badgesFor({ ...base, sources: [], gh_number: null })).toEqual([]);
  });
  it("detailsFor lists only what is present, the estimate in dollars and the milestone by title", () => {
    expect(detailsFor(base)).toEqual([]);
    expect(detailsFor({ ...base, category_hint: "bug", estimate_usd: 1.5, milestone_title: "M1: Start", milestone_key: "M1" })).toEqual(["bug", "Estimate $1.50", "M1: Start"]);
    expect(detailsFor({ ...base, estimate_usd: 0 })).toEqual(["Estimate $0.00"]);
    expect(detailsFor({ ...base, milestone_key: "M1" })).toEqual(["M1"]);
    expect(detailsFor({ ...base, estimate_usd: "3" })).toEqual([]);
  });
  it("stageWords gives the label, and nothing for a stage it does not know", () => {
    expect(stageWords("triaged")).toBe("Triaged");
    expect(stageWords("closed")).toBe("Closed");
    expect(stageWords("odd")).toBe("");
    expect(stageWords(null)).toBe("");
  });
});

describe("sentences", () => {
  it("every refusal the definers and the routes can answer has its own sentence", () => {
    for (const code of ["not_new", "not_rejected", "not_approved", "work_started", "owned_by_internal_loop", "repo_not_connected", "work_item_wrong_repo", "work_item_wrong_stage", "insufficient_role", "session_required", "run_actions_unavailable", "not_found", "idempotency_key_reused", "idempotency_in_progress", "offline", "timeout", "server_error"]) {
      expect(REFUSALS[code], code).toBeTruthy();
      expect(refusalSentence(new ApiFailure(409, code, "server text that must never be shown"))).toBe(REFUSALS[code]);
    }
    for (const s of Object.values(REFUSALS)) expect(s).not.toMatch(BAD);
  });
  it("an unknown code, a 5xx and a missing error each read as a fixed sentence, never the server's words", () => {
    expect(refusalSentence(new ApiFailure(409, "brand_new_code", "server text that must never be shown"))).toBe("That didn't work. Nothing was changed.");
    expect(refusalSentence(new ApiFailure(500, "server_error", "x"))).toBe(REFUSALS.server_error);
    expect(refusalSentence(undefined)).toBe("That didn't work. Nothing was changed.");
  });
  it("a 429 counts down from Retry-After and never says NaN", () => {
    expect(refusalSentence(new ApiFailure(429, "rate_limited", "x", undefined, 8))).toBe("You're changing things too fast. Try again in 8 seconds.");
    expect(refusalSentence(new ApiFailure(429, "rate_limited", "x", undefined, 0))).toBe("You're changing things too fast. Try again in 10 seconds.");
  });
  it("approve says whether it started, and why not", () => {
    expect(approvedSentence({ started: true, not_started_reason: null })).toMatch(/^Approved and started/);
    for (const reason of Object.keys(NOT_STARTED)) expect(approvedSentence({ started: false, not_started_reason: reason })).toBe(NOT_STARTED[reason]);
    expect(approvedSentence({ started: false, not_started_reason: "a_new_reason" })).toBe("Approved. It waits at Triaged, so nothing was started.");
    expect(approvedSentence(undefined)).toMatch(/^Approved\./);
    for (const s of [...Object.values(NOT_STARTED), ...Object.values(DONE), ...Object.values(SENDING), DETACHED_SENTENCE]) expect(s).not.toMatch(BAD);
  });
  it("a Discussion- or task-backed approval says in words that it does not start yet", () => {
    expect(NOT_STARTED.not_issue_backed).toMatch(/Discussion or a task/);
  });
});

describe("idempotency", () => {
  it("the key is kept only when the outcome is unknown", () => {
    expect(outcomeUnknown(new ApiFailure(0, "offline", "x"))).toBe(true);
    expect(outcomeUnknown(new ApiFailure(0, "timeout", "x"))).toBe(true);
    expect(outcomeUnknown(new ApiFailure(503, "run_actions_unavailable", "x"))).toBe(true);
    expect(outcomeUnknown(new ApiFailure(409, "not_new", "x"))).toBe(false);
    expect(outcomeUnknown(new ApiFailure(429, "rate_limited", "x"))).toBe(false);
    expect(outcomeUnknown(undefined)).toBe(false);
  });
});
