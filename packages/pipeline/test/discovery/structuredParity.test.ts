import { describe, expect, it } from "vitest";
import { DISCOVERY_ANALYST_ROLE, PROPOSAL_VERIFIER_ROLE, STRUCTURED_TRIAGE_CATEGORIES, structuredFailures } from "@fulcrumaxe/runner-protocol";
import { TRIAGE_CATEGORIES } from "../../src/plan/categories.js";
import { parseAnalystOutput } from "../../src/discovery/analystOutput.js";
import { parseVerifierOutput } from "../../src/discovery/verifierOutput.js";

/**
 * D#6 RUNNER-STRUCTURED-OUTPUT: the runner (a public package that cannot import this one) repairs an answer only when ITS validator names a failure. These tests
 * keep that validator from drifting from the parsers here: it must never name a failure for an answer the parser accepts (that would spend a repair turn on a good
 * answer), and where it does name one for a refused answer the first code matches the parser's own reason.
 */
const cite = { path: "src/a.ts", start_line: 1, end_line: 3 };
const claim = { text: "t", verdict: "supported", cites: [cite] };
const proto = Object.create({ category: "bug", claims: [] }) as object;

const VERIFIER_CORPUS: unknown[] = [
  { category: "bug", claims: [] }, { category: " Bug ", claims: [] }, { category: "BUG", claims: [claim] },
  { category: "bug", claims: [claim, claim, claim, claim, claim] }, { category: "bug", claims: [claim, claim, claim, claim, claim, claim] },
  { category: "bug", claims: [{ ...claim, cites: [{ path: "src/a.ts", start_line: 1, end_line: 90 }] }] },
  { category: "bug", claims: [{ ...claim, cites: [cite, cite, cite, cite] }] },
  { category: "bug", claims: [{ ...claim, cites: [{ path: "/abs", start_line: 1, end_line: 2 }] }] },
  { category: "bug", claims: [{ ...claim, cites: [{ path: "a/../b", start_line: 1, end_line: 2 }] }] },
  { category: "bug", claims: [{ ...claim, cites: [{ path: "a.ts", start_line: 5, end_line: 2 }] }] },
  { category: "bug", claims: [{ ...claim, cites: [{ path: "a.ts", start_line: 0, end_line: 2 }] }] },
  { category: "bug", claims: [{ ...claim, cites: [{ ...cite, extra: 1 }] }] },
  { category: "bug", claims: [{ ...claim, text: "" }] }, { category: "bug", claims: [{ ...claim, text: "​​" }] }, { category: "bug", claims: [{ ...claim, text: 5 }] },
  { category: "bug", claims: [{ ...claim, verdict: "maybe" }] }, { category: "bug", claims: [{ ...claim, cites: "x" }] }, { category: "bug", claims: [{ ...claim, extra: 1 }] },
  { category: "bug", claims: ["x"] }, { category: "urgent", claims: [] }, { category: "bug extra", claims: [] }, { category: 1, claims: [] }, { category: "bug" }, { claims: [] },
  { category: "bug", claims: [], extra: true }, [], "text", null, 7, proto,
];

const candidate = { kind: "docs", title: "t", summary: "s", refs: [cite] };
const ANALYST_CORPUS: unknown[] = [
  { candidates: [] }, { candidates: [candidate] }, { candidates: Array.from({ length: 10 }, () => candidate) }, { candidates: Array.from({ length: 11 }, () => candidate) },
  { candidates: [{ ...candidate, names_issue: 4, names_discussion: 7, duplicate_of: "3f6c1a52-8d0e-4b7a-9c14-0a5e6d2b7f38" }] },
  { candidates: [{ ...candidate, names_issue: 0 }] }, { candidates: [{ ...candidate, names_issue: null }] }, { candidates: [{ ...candidate, duplicate_of: "nope" }] },
  { candidates: [{ ...candidate, kind: "other" }] }, { candidates: [{ ...candidate, title: "" }] }, { candidates: [{ ...candidate, title: 4 }] }, { candidates: [{ ...candidate, summary: 4 }] },
  { candidates: [{ ...candidate, refs: [{ path: "a.ts", start_line: 1, end_line: 90 }] }] }, { candidates: [{ ...candidate, refs: [cite, cite, cite, cite, cite, cite] }] },
  { candidates: [{ ...candidate, extra: 1 }] }, { candidates: [1] }, { candidates: "x" }, { candidates: [], extra: 1 }, [], "text", null,
];

describe("the runner's validator against the cloud's parsers", () => {
  it("the category list is the same list", () => {
    expect([...STRUCTURED_TRIAGE_CATEGORIES]).toEqual([...TRIAGE_CATEGORIES]);
  });

  it.each(VERIFIER_CORPUS.map((o, i) => [i, o] as const))("verifier corpus #%i: a failure named is a failure the parser reports, with the same first code", (_i, output) => {
    const codes = structuredFailures(PROPOSAL_VERIFIER_ROLE, output);
    const parsed = parseVerifierOutput(output);
    if (parsed.ok) expect(codes).toEqual([]);
    else if (codes.length > 0) expect(codes[0]).toBe(parsed.reason);
  });

  it("the verifier validator catches every refusal in the corpus except the cases it knowingly leaves to the parser", () => {
    const missed = VERIFIER_CORPUS.filter((o) => !parseVerifierOutput(o).ok && structuredFailures(PROPOSAL_VERIFIER_ROLE, o).length === 0);
    expect(missed).toEqual([]);
  });

  it.each(ANALYST_CORPUS.map((o, i) => [i, o] as const))("analyst corpus #%i: a failure named is a failure the parser reports", (_i, output) => {
    const codes = structuredFailures(DISCOVERY_ANALYST_ROLE, output);
    if (parseAnalystOutput(output).ok) expect(codes).toEqual([]);
  });

  it("the analyst validator catches every refusal in the corpus", () => {
    const missed = ANALYST_CORPUS.filter((o) => !parseAnalystOutput(o).ok && structuredFailures(DISCOVERY_ANALYST_ROLE, o).length === 0);
    expect(missed).toEqual([]);
  });
});
