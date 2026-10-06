import { describe, expect, it } from "vitest";
import { MAX_FINDINGS, MAX_FINDING_CHARS, MAX_SUMMARY_CHARS, normalizeVerdict, readVerdict, recordingOrder } from "../../src/review/verdicts.js";
import { decideRound, maxFixRounds } from "../../src/review/roundDecision.js";

/** D#483 P3: reading a reviewer's verdict (fail closed), the recording order, and the round decision. */
describe("normalizeVerdict: only the exact words", () => {
  it.each(["pass", "needs-fix", "fail"])("%s is itself", (v) => {
    expect(normalizeVerdict(v)).toBe(v);
  });
  it.each([["Pass"], ["PASS"], [" pass"], ["pass "], ["passed"], ["needs_fix"], ["needs fix"], ["NEEDS-FIX"], ["ok"], [""], [null], [undefined], [1], [true], [{}], [["pass"]], [Symbol.iterator.toString()]])("%j is fail", (v) => {
    expect(normalizeVerdict(v)).toBe("fail");
  });
});

describe("readVerdict", () => {
  it("reads the verdict, findings, summary and flag of a succeeded run", () => {
    expect(readVerdict("succeeded", { verdict: "needs-fix", findings: ["a", "b"], summary: "s", security_review_needed: true })).toEqual({ verdict: "needs-fix", findings: ["a", "b"], summary: "s", securityNeeded: true });
  });
  it.each(["failed", "timed_out", "cancelled", "killed_spend", "refused_spend", "running", "pending", "missing", "weird"])("a run that is %s has no verdict: fail, and no flag", (status) => {
    expect(readVerdict(status, { verdict: "pass", security_review_needed: true })).toEqual({ verdict: "fail", findings: [], summary: "", securityNeeded: false });
  });
  it("a missing or non-object envelope is a fail", () => {
    for (const env of [null, [] as unknown as Record<string, unknown>, "pass" as unknown as Record<string, unknown>]) expect(readVerdict("succeeded", env).verdict).toBe("fail");
  });
  it("reads only OWN properties: an inherited verdict is not a verdict", () => {
    const env = Object.create({ verdict: "pass", security_review_needed: true }) as Record<string, unknown>;
    expect(readVerdict("succeeded", env)).toMatchObject({ verdict: "fail", securityNeeded: false });
  });
  it.each(["true", 1, "yes", {}, [], null, "TRUE"])("the flag %j is not the JSON boolean true", (flag) => {
    expect(readVerdict("succeeded", { verdict: "pass", security_review_needed: flag }).securityNeeded).toBe(false);
  });
  it("findings: strings only, at most 20, each cut to 600 characters; a non-array is none", () => {
    const r = readVerdict("succeeded", { verdict: "needs-fix", findings: [...Array.from({ length: 30 }, () => "x".repeat(900)), 7, null, { a: 1 }] });
    expect(r.findings).toHaveLength(MAX_FINDINGS);
    expect(r.findings.every((f) => f.length === MAX_FINDING_CHARS)).toBe(true);
    expect(readVerdict("succeeded", { verdict: "pass", findings: "one" }).findings).toEqual([]);
    expect(readVerdict("succeeded", { verdict: "pass", findings: [1, 2] }).findings).toEqual([]);
  });
  it("the summary is text, cut to 4000 characters; anything else is empty", () => {
    expect(readVerdict("succeeded", { verdict: "pass", summary: "s".repeat(9000) }).summary).toHaveLength(MAX_SUMMARY_CHARS);
    expect(readVerdict("succeeded", { verdict: "pass", summary: { a: 1 } }).summary).toBe("");
  });
});

describe("recordingOrder: passes first, non-passes last, so a needs-fix is never overwritten by a later pass", () => {
  const v = (role: string, verdict: "pass" | "needs-fix" | "fail") => ({ role, verdict });
  it("puts every pass before every non-pass and keeps the order inside each group", () => {
    const out = recordingOrder([v("a", "needs-fix"), v("b", "pass"), v("c", "fail"), v("d", "pass"), v("e", "needs-fix")]);
    expect(out.map((x) => x.role)).toEqual(["b", "d", "a", "c", "e"]);
  });
  it("whatever the order the verdicts arrive in, the LAST one recorded is never a pass while any non-pass exists", () => {
    const base = [v("code", "needs-fix"), v("acc", "pass"), v("sec", "pass")];
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const p of perms) {
      const ordered = recordingOrder(p.map((i) => base[i]!));
      expect(ordered.at(-1)!.verdict).not.toBe("pass");
    }
  });
  it("does not mutate its input and handles empty", () => {
    const input = [v("a", "needs-fix"), v("b", "pass")];
    recordingOrder(input);
    expect(input.map((x) => x.role)).toEqual(["a", "b"]);
    expect(recordingOrder([])).toEqual([]);
  });
});

describe("decideRound", () => {
  const REQ = ["code-reviewer", "acceptance-tester"] as const;
  const d = (verdicts: Array<[string, string]>, fixRoundsStarted = 0, required: readonly string[] = REQ) =>
    decideRound({ requiredRoles: required as never, verdicts: verdicts.map(([role, verdict]) => ({ role: role as never, verdict })), fixRoundsStarted });

  it("every required role passed -> all_passed", () => {
    expect(d([["code-reviewer", "pass"], ["acceptance-tester", "pass"]])).toBe("all_passed");
  });
  it("a required role with no verdict is incomplete, even if the rest passed", () => {
    expect(d([["code-reviewer", "pass"]])).toBe("incomplete");
    expect(d([])).toBe("incomplete");
  });
  it("a verdict from a role that is not required does not count for it", () => {
    expect(d([["code-reviewer", "pass"], ["security-reviewer", "pass"]])).toBe("incomplete");
  });
  it("any fail -> reviewer_fail, even beside a needs-fix", () => {
    expect(d([["code-reviewer", "needs-fix"], ["acceptance-tester", "fail"]])).toBe("reviewer_fail");
  });
  it("a needs-fix -> fix while fix rounds remain, escalated once the limit is used", () => {
    for (let started = 0; started < maxFixRounds(); started++) expect(d([["code-reviewer", "needs-fix"], ["acceptance-tester", "pass"]], started)).toBe("fix");
    expect(d([["code-reviewer", "needs-fix"], ["acceptance-tester", "pass"]], maxFixRounds())).toBe("escalated");
    expect(d([["code-reviewer", "needs-fix"], ["acceptance-tester", "pass"]], 9)).toBe("escalated");
  });
  it("two reviewers asking for changes on one head are ONE round", () => {
    expect(d([["code-reviewer", "needs-fix"], ["acceptance-tester", "needs-fix"]], 2)).toBe("fix");
  });
  it("the debater, when required, must pass too", () => {
    const req = [...REQ, "debater"];
    expect(d([["code-reviewer", "pass"], ["acceptance-tester", "pass"]], 0, req)).toBe("incomplete");
    expect(d([["code-reviewer", "pass"], ["acceptance-tester", "pass"], ["debater", "needs-fix"]], 0, req)).toBe("fix");
    expect(d([["code-reviewer", "pass"], ["acceptance-tester", "pass"], ["debater", "pass"]], 0, req)).toBe("all_passed");
  });
});
