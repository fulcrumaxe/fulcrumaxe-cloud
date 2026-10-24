import { describe, expect, it } from "vitest";
import { MAX_FINDINGS, MAX_FINDING_CHARS, MAX_SUMMARY_CHARS, MAX_UNVERIFIABLE, MAX_UNVERIFIABLE_CHARS, normalizeVerdict, readUnverifiable, readVerdict, recordingOrder } from "../../src/review/verdicts.js";
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
    expect(readVerdict("succeeded", { verdict: "needs-fix", findings: ["a", "b"], summary: "s", security_review_needed: true })).toEqual({ verdict: "needs-fix", findings: ["a", "b"], fullFindings: ["a", "b"], summary: "s", securityNeeded: true, environmentFailure: false, hasVerdict: true });
  });
  it.each(["failed", "timed_out", "cancelled", "killed_spend", "refused_spend", "running", "pending", "missing", "weird"])("a run that is %s has no verdict: fail, and no flag", (status) => {
    expect(readVerdict(status, { verdict: "pass", security_review_needed: true })).toEqual({ verdict: "fail", findings: [], fullFindings: [], summary: "", securityNeeded: false, environmentFailure: false, hasVerdict: false });
  });
  it("only a succeeded run with a `verdict` key produced a verdict; a wrong word is still one (a fail), a missing key or envelope is none", () => {
    expect(readVerdict("succeeded", { verdict: "pass" }).hasVerdict).toBe(true);
    expect(readVerdict("succeeded", { verdict: "PASS" })).toMatchObject({ verdict: "fail", hasVerdict: true });
    expect(readVerdict("succeeded", { summary: "ran out of memory" })).toMatchObject({ verdict: "fail", hasVerdict: false });
    expect(readVerdict("succeeded", null).hasVerdict).toBe(false);
    expect(readVerdict("succeeded", Object.create({ verdict: "pass" }) as Record<string, unknown>).hasVerdict).toBe(false);
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
  it("D#598 P7d: environment_failure is read only as the JSON boolean true, from a run that succeeded", () => {
    expect(readVerdict("succeeded", { verdict: "fail", environment_failure: true }).environmentFailure).toBe(true);
    for (const flag of ["true", 1, "yes", {}, [], null, "TRUE", false]) expect(readVerdict("succeeded", { verdict: "fail", environment_failure: flag }).environmentFailure).toBe(false);
    expect(readVerdict("failed", { verdict: "fail", environment_failure: true }).environmentFailure).toBe(false);
    expect(readVerdict("succeeded", Object.create({ environment_failure: true }) as Record<string, unknown>).environmentFailure).toBe(false);
  });
  it("unverifiable: the word with a usable list reads as a fail plus the flag; every other shape is a plain fail with no flag", () => {
    const list = [{ criterion: "AC4 bwrap test", reason: "namespaces cannot be created here" }, { criterion: "AC5", reason: "skipped" }];
    expect(readVerdict("succeeded", { verdict: "unverifiable", unverifiable: list, summary: "s" })).toMatchObject({ verdict: "fail", unverifiable: true, hasVerdict: true, summary: "s" });
    // Nothing usable to show: a claim without criteria is a fail like any other wrong word.
    for (const bad of [undefined, [], "AC4", [{ reason: "x" }], [{ criterion: "" }], [{ criterion: 4 }], [null, 3, "x"], { criterion: "AC4" }]) {
      const env: Record<string, unknown> = { verdict: "unverifiable", ...(bad === undefined ? {} : { unverifiable: bad }) };
      expect(readVerdict("succeeded", env), JSON.stringify(bad)).toMatchObject({ verdict: "fail", hasVerdict: true });
      expect(readVerdict("succeeded", env).unverifiable, JSON.stringify(bad)).toBeUndefined();
    }
    // A list under any other word does not turn it into the outcome, and the word needs a run that succeeded and its own keys.
    expect(readVerdict("succeeded", { verdict: "needs-fix", unverifiable: list }).unverifiable).toBeUndefined();
    expect(readVerdict("succeeded", { verdict: "pass", unverifiable: list })).toMatchObject({ verdict: "pass" });
    expect(readVerdict("failed", { verdict: "unverifiable", unverifiable: list })).toMatchObject({ verdict: "fail", hasVerdict: false });
    expect(readVerdict("failed", { verdict: "unverifiable", unverifiable: list }).unverifiable).toBeUndefined();
    expect(readVerdict("succeeded", Object.create({ verdict: "unverifiable", unverifiable: list }) as Record<string, unknown>).unverifiable).toBeUndefined();
    expect(readVerdict("succeeded", { verdict: "Unverifiable", unverifiable: list }).unverifiable).toBeUndefined();
  });
  it("unverifiable items: at most 10, objects with a criterion, each text cut to 400", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ criterion: `c${i}`, reason: "r" }));
    expect(readUnverifiable(many)).toHaveLength(MAX_UNVERIFIABLE);
    expect(readUnverifiable([{ criterion: "x".repeat(900), reason: "y".repeat(900) }, { reason: "no criterion" }, 7])).toEqual([{ criterion: "x".repeat(MAX_UNVERIFIABLE_CHARS), reason: "y".repeat(MAX_UNVERIFIABLE_CHARS) }]);
    expect(readUnverifiable([{ criterion: " AC1 ", reason: 3 }])).toEqual([{ criterion: "AC1", reason: "" }]);
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
  it("D#598 P7d: a reviewer that could not run the tests is an environment_failure, whatever its word, and never a fix round (even beside a needs-fix or at the fix limit)", () => {
    const e = (verdicts: Array<[string, string, boolean?]>, started = 0) =>
      decideRound({ requiredRoles: REQ as never, verdicts: verdicts.map(([role, verdict, environmentFailure]) => ({ role: role as never, verdict, ...(environmentFailure ? { environmentFailure } : {}) })), fixRoundsStarted: started });
    expect(e([["code-reviewer", "pass"], ["acceptance-tester", "fail", true]])).toBe("environment_failure");
    expect(e([["code-reviewer", "pass"], ["acceptance-tester", "needs-fix", true]])).toBe("environment_failure");
    expect(e([["code-reviewer", "needs-fix"], ["acceptance-tester", "fail", true]])).toBe("environment_failure");
    expect(e([["code-reviewer", "pass"], ["acceptance-tester", "needs-fix", true]], maxFixRounds())).toBe("environment_failure");
    // The same words without the flag keep their meaning: a needs-fix is a fix round, a fail is a reviewer fail.
    expect(e([["code-reviewer", "pass"], ["acceptance-tester", "needs-fix"]])).toBe("fix");
    expect(e([["code-reviewer", "pass"], ["acceptance-tester", "fail"]])).toBe("reviewer_fail");
  });
  it("a reviewer that could not verify here is `unverifiable`: never a fix round or a reviewer_fail on its own, but a real problem from another reviewer still decides first", () => {
    const u = (verdicts: Array<[string, string, boolean?]>, started = 0) =>
      decideRound({ requiredRoles: REQ as never, verdicts: verdicts.map(([role, verdict, unverifiable]) => ({ role: role as never, verdict, ...(unverifiable ? { unverifiable } : {}) })), fixRoundsStarted: started });
    expect(u([["code-reviewer", "pass"], ["acceptance-tester", "fail", true]])).toBe("unverifiable");
    expect(u([["code-reviewer", "pass"], ["acceptance-tester", "fail", true]], maxFixRounds())).toBe("unverifiable");
    expect(u([["code-reviewer", "pass"], ["acceptance-tester", "fail", true]], 9)).toBe("unverifiable");
    // The other reviewer found something: that is decided as it always was.
    expect(u([["code-reviewer", "needs-fix"], ["acceptance-tester", "fail", true]])).toBe("fix");
    expect(u([["code-reviewer", "needs-fix"], ["acceptance-tester", "fail", true]], maxFixRounds())).toBe("escalated");
    expect(u([["code-reviewer", "fail"], ["acceptance-tester", "fail", true]])).toBe("reviewer_fail");
    // Without the flag the same words keep their meaning.
    expect(u([["code-reviewer", "pass"], ["acceptance-tester", "fail"]])).toBe("reviewer_fail");
    // Environment failure and a missing verdict still come first; a missing required role is still incomplete.
    expect(decideRound({ requiredRoles: REQ as never, verdicts: [{ role: "code-reviewer" as never, verdict: "pass", environmentFailure: true }, { role: "acceptance-tester" as never, verdict: "fail", unverifiable: true }], fixRoundsStarted: 0 })).toBe("environment_failure");
    expect(decideRound({ requiredRoles: REQ as never, verdicts: [{ role: "code-reviewer" as never, verdict: "fail", noVerdict: true }, { role: "acceptance-tester" as never, verdict: "fail", unverifiable: true }], fixRoundsStarted: 0 })).toBe("reviewer_no_verdict");
    expect(decideRound({ requiredRoles: REQ as never, verdicts: [{ role: "acceptance-tester" as never, verdict: "fail", unverifiable: true }], fixRoundsStarted: 0 })).toBe("incomplete");
    // A flag on a role that is not required changes nothing.
    expect(decideRound({ requiredRoles: ["code-reviewer"] as never, verdicts: [{ role: "code-reviewer" as never, verdict: "pass" }, { role: "acceptance-tester" as never, verdict: "fail", unverifiable: true }], fixRoundsStarted: 0 })).toBe("all_passed");
  });
  it("a reviewer with no verdict is reviewer_no_verdict: never a reviewer_fail and never a fix round, whatever the others said", () => {
    const n = (verdicts: Array<[string, string, boolean?]>, started = 0) =>
      decideRound({ requiredRoles: REQ as never, verdicts: verdicts.map(([role, verdict, noVerdict]) => ({ role: role as never, verdict, ...(noVerdict ? { noVerdict } : {}) })), fixRoundsStarted: started });
    expect(n([["code-reviewer", "pass"], ["acceptance-tester", "fail", true]])).toBe("reviewer_no_verdict");
    expect(n([["code-reviewer", "fail"], ["acceptance-tester", "fail", true]])).toBe("reviewer_no_verdict");
    expect(n([["code-reviewer", "needs-fix"], ["acceptance-tester", "fail", true]])).toBe("reviewer_no_verdict");
    // Genuine verdicts keep their meaning.
    expect(n([["code-reviewer", "fail"], ["acceptance-tester", "pass"]])).toBe("reviewer_fail");
    expect(n([["code-reviewer", "needs-fix"], ["acceptance-tester", "pass"]])).toBe("fix");
    // A role that is not required does not decide the round.
    expect(n([["code-reviewer", "pass"], ["acceptance-tester", "pass"], ["security-reviewer", "fail", true]])).toBe("all_passed");
  });
  it("the debater, when required, must pass too", () => {
    const req = [...REQ, "debater"];
    expect(d([["code-reviewer", "pass"], ["acceptance-tester", "pass"]], 0, req)).toBe("incomplete");
    expect(d([["code-reviewer", "pass"], ["acceptance-tester", "pass"], ["debater", "needs-fix"]], 0, req)).toBe("fix");
    expect(d([["code-reviewer", "pass"], ["acceptance-tester", "pass"], ["debater", "pass"]], 0, req)).toBe("all_passed");
  });
});
