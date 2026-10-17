// apps/workspace/test/pipeline-inbox.test.mjs
//
// D#483 S3-L2b: the logic half of the Inbox tab (sentences, badges, details, row validation, retry rules). The DOM half is in
// e2e/pipeline-inbox.spec.ts. The rules under test: every outcome a person reads is a fixed sentence (never a server code or
// message), a malformed row is left out, an absent value is never drawn as "null" or "undefined", and the Idempotency-Key
// survives an unknown outcome only.
import { describe, expect, it } from "vitest";
import { ApiFailure } from "../apps/_lib/api.js";
import { AMOUNT_LABEL, AMOUNT_SENTENCE, LOW_BUDGET_SENTENCE, checkAmount, prefillAmount, DETACHED_SENTENCE, INBOX_DONE as DONE, FILTERS, NOT_STARTED, REFUSALS, INBOX_SENDING as SENDING, approvedSentence, badgesFor, detailsFor, outcomeUnknown, refusalSentence, stageWords, validProposal } from "../apps/pipeline/pipeline-actions.js";

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
    for (const code of ["not_new", "not_rejected", "not_approved", "work_started", "owned_by_internal_loop", "repo_not_connected", "work_item_wrong_repo", "work_item_wrong_stage", "amount_required", "envelope_below_first_run", "over_account_budget", "insufficient_role", "session_required", "run_actions_unavailable", "not_found", "idempotency_key_reused", "idempotency_in_progress", "offline", "timeout", "server_error"]) {
      expect(REFUSALS[code], code).toBeTruthy();
      expect(refusalSentence(new ApiFailure(409, code, "server text that must never be shown"))).toBe(REFUSALS[code]);
    }
    for (const s of Object.values(REFUSALS)) expect(s).not.toMatch(BAD);
    // D#483 S5-e1: the Spec's own sentence for a proposal that cannot be priced yet.
    expect(REFUSALS.amount_required).toBe("Set a limit for this item: we can't estimate it yet");
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

// D#483 S5-e1: the limit a person gives an item as they approve it.
describe("the approve limit", () => {
  it("uses the Spec's sentence for a proposal with no estimate, and a plain label", () => {
    expect(AMOUNT_SENTENCE).toBe("Set a limit for this item: we can't estimate it yet");
    expect(AMOUNT_LABEL).toBe("Limit for this item (USD)");
    expect(REFUSALS.envelope_below_first_run).toMatch(/too low/);
    expect(REFUSALS.over_account_budget).toMatch(/can still spend this month/);
  });
  it("a refusal below the first run reads as the raise-the-budget sentence when what is left is below that cost, and as 'enter a higher one' otherwise", () => {
    expect(LOW_BUDGET_SENTENCE).toBe("Your remaining budget this month is lower than the cost of the first run. Raise the monthly budget to approve this.");
    const refused = new ApiFailure(409, "envelope_below_first_run", "x");
    expect(refusalSentence(refused, { basis: "seed", remaining: 4, firstRun: 10 })).toBe(LOW_BUDGET_SENTENCE);
    expect(refusalSentence(refused, { basis: "seed", remaining: 10, firstRun: 10 })).toBe(REFUSALS.envelope_below_first_run);
    expect(refusalSentence(refused, { basis: "seed", remaining: 437, firstRun: 10 })).toBe(REFUSALS.envelope_below_first_run);
    expect(refusalSentence(refused, undefined)).toBe(REFUSALS.envelope_below_first_run);
    expect(refusalSentence(refused, { basis: "seed" })).toBe(REFUSALS.envelope_below_first_run);
    expect(LOW_BUDGET_SENTENCE).not.toMatch(BAD);
  });
  it("prefillAmount is total x (1 + margin), to four decimals, capped at the remaining budget, like the server's", () => {
    expect(prefillAmount(100, 20, 437)).toBe(120);
    expect(prefillAmount(3, 20, 437)).toBe(3.6);
    expect(prefillAmount(10, null, 437)).toBe(10);
    expect(prefillAmount(1000, 20, 437)).toBe(437);
    expect(prefillAmount(10, 20, 11.99999)).toBe(11.9999);
    expect(prefillAmount(10, 20, -4)).toBe(0);
  });
  it("checkAmount sends nothing for an empty field unless there is no estimate, and refuses a bad limit with a sentence", () => {
    expect(checkAmount("", undefined)).toEqual({ ok: true, amount: null });
    expect(checkAmount("  ", { basis: "seed", remaining: 5 })).toEqual({ ok: true, amount: null });
    expect(checkAmount("", { basis: "none", remaining: 5 })).toEqual({ ok: false, sentence: AMOUNT_SENTENCE });
    expect(checkAmount(" 12.5 ", { basis: "none", remaining: 50 })).toEqual({ ok: true, amount: 12.5 });
    expect(checkAmount("12.12345", undefined).ok).toBe(false);
    for (const bad of ["abc", "-x", "e", "$$", "x,y", "- ", ".x"]) {
      const r = checkAmount(bad, { basis: "seed", remaining: 437 });
      expect(r.ok, bad).toBe(false);
      expect(r.sentence).not.toMatch(BAD);
    }
    expect(checkAmount("0", undefined)).toEqual({ ok: false, sentence: "Enter a limit above $0." });
    expect(checkAmount("0.0000", undefined).ok).toBe(false);
    expect(checkAmount("437.01", { basis: "seed", remaining: 437 })).toEqual({ ok: false, sentence: "Enter a limit of $437.00 or less: that is what this account can still spend this month." });
    expect(checkAmount("437", { basis: "seed", remaining: 437 })).toEqual({ ok: true, amount: 437 });
    // With the budget unknown, the server decides.
    expect(checkAmount("9999", undefined)).toEqual({ ok: true, amount: 9999 });
  });
});
