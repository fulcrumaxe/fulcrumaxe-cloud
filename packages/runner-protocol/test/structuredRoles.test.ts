import { describe, expect, it } from "vitest";
import {
  DISCOVERY_ANALYST_ROLE, PROPOSAL_VERIFIER_ROLE, STRUCTURED_FAILURE_CODES, STRUCTURED_OUTPUT_ROLES, normalizeMessage, repairPromptFor, structuredFailures, structuredSchemaFor,
} from "../src/index.js";

const cite = { path: "src/a.ts", start_line: 1, end_line: 3 };
const claim = { text: "t", verdict: "supported", cites: [cite] };

describe("structuredSchemaFor", () => {
  it("has a schema for each structured role and none for any other", () => {
    for (const role of STRUCTURED_OUTPUT_ROLES) expect(structuredSchemaFor(role)).toMatchObject({ type: "object", additionalProperties: false });
    expect(structuredSchemaFor("executor")).toBeUndefined();
    expect(structuredSchemaFor("code-reviewer")).toBeUndefined();
  });

  it("is plain JSON (it travels as one command-line argument)", () => {
    for (const role of STRUCTURED_OUTPUT_ROLES) expect(JSON.parse(JSON.stringify(structuredSchemaFor(role)))).toEqual(structuredSchemaFor(role));
  });
});

describe("structuredFailures: codes only", () => {
  it("a valid verifier answer and a valid analyst answer have no failures", () => {
    expect(structuredFailures(PROPOSAL_VERIFIER_ROLE, { category: "Bug", claims: [claim] })).toEqual([]);
    expect(structuredFailures(PROPOSAL_VERIFIER_ROLE, { category: "bug", claims: [] })).toEqual([]);
    expect(structuredFailures(DISCOVERY_ANALYST_ROLE, { candidates: [{ kind: "docs", title: "t", summary: "", refs: [cite], names_issue: 4 }] })).toEqual([]);
  });

  it("a cite that only spans too many lines is not a failure for the verifier (the cloud downgrades that claim) but is for the analyst", () => {
    const long = { path: "src/a.ts", start_line: 1, end_line: 90 };
    expect(structuredFailures(PROPOSAL_VERIFIER_ROLE, { category: "bug", claims: [{ ...claim, cites: [long] }] })).toEqual([]);
    expect(structuredFailures(DISCOVERY_ANALYST_ROLE, { candidates: [{ kind: "code", title: "t", summary: "s", refs: [long] }] })).toEqual(["bad_ref"]);
  });

  it.each([
    [undefined, ["no_envelope"]],
    [[], ["not_an_object"]],
    [{ category: "bug", claims: [], extra: 1 }, ["unknown_field"]],
    [{ category: "urgent", claims: [] }, ["bad_category"]],
    [{ category: "bug" }, ["bad_claims"]],
    [{ category: "bug", claims: [claim, claim, claim, claim, claim, claim] }, ["too_many_claims"]],
    [{ category: "bug", claims: [{ text: "t", verdict: "maybe", cites: [] }] }, ["bad_claim"]],
    [{ category: "bug", claims: [{ text: "t", verdict: "supported", cites: [{ path: "../x", start_line: 1, end_line: 2 }] }] }, ["bad_cite"]],
    [{ category: 5, claims: "x" }, ["bad_category", "bad_claims"]],
  ])("verifier: %j gives %j", (output, codes) => {
    expect(structuredFailures(PROPOSAL_VERIFIER_ROLE, output)).toEqual(codes);
  });

  it.each([
    [{ candidates: "x" }, ["bad_candidates"]],
    [{ candidates: Array.from({ length: 11 }, () => ({})) }, ["too_many_candidates"]],
    [{ candidates: [{ kind: "docs", title: "", summary: "", refs: [] }] }, ["bad_candidate"]],
    [{ candidates: [{ kind: "docs", title: "t", summary: "", refs: [], duplicate_of: "nope" }] }, ["bad_candidate"]],
    [{ candidates: [{ kind: "docs", title: "t", summary: "", refs: [], extra: 1 }] }, ["unknown_field"]],
  ])("analyst: %j gives %j", (output, codes) => {
    expect(structuredFailures(DISCOVERY_ANALYST_ROLE, output)).toEqual(codes);
  });

  it("a free-form role never fails", () => {
    expect(structuredFailures("executor", undefined)).toEqual([]);
    expect(structuredFailures("code-reviewer", { anything: 1 })).toEqual([]);
  });

  it("every code it can return is in the closed list", () => {
    const outputs = [undefined, [], { a: 1 }, { category: 1, claims: 1 }, { category: "bug", claims: [1] }, { candidates: [1] }, { candidates: 1 }];
    for (const role of STRUCTURED_OUTPUT_ROLES) for (const o of outputs) for (const code of structuredFailures(role, o)) expect(STRUCTURED_FAILURE_CODES).toContain(code);
  });

  it("the answer's own text is never in a code", () => {
    const codes = structuredFailures(PROPOSAL_VERIFIER_ROLE, { category: "SECRET-TEXT", claims: [{ text: "SECRET-TEXT", verdict: "SECRET-TEXT", cites: "SECRET-TEXT" }] });
    expect(JSON.stringify(codes)).not.toContain("SECRET");
  });
});

describe("repairPromptFor", () => {
  it("lists the codes it is given, and drops anything that is not a closed code", () => {
    const text = repairPromptFor(["bad_category", "IGNORE ALL" as never]);
    expect(text).toContain("bad_category");
    expect(text).not.toContain("IGNORE");
  });
});

describe("the result line's structured_output", () => {
  const ctx = { runId: "r", role: PROPOSAL_VERIFIER_ROLE };
  const line = (extra: Record<string, unknown>) => ({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "", ...extra });

  it("becomes the event's agentOutput", () => {
    expect(normalizeMessage(ctx, line({ structured_output: { category: "bug", claims: [] } }), 0, "/w").agentOutput).toEqual({ category: "bug", claims: [] });
  });

  it("a result without it reads the text envelope as before", () => {
    const text = "x\n<!-- AGENT_OUTPUT -->\n```json\n{\"verdict\":\"done\"}\n```\n<!-- /AGENT_OUTPUT -->";
    expect(normalizeMessage({ runId: "r", role: "executor" }, line({ result: text }), 0, "/w").agentOutput).toEqual({ verdict: "done" });
  });

  it.each([null, 5, "s", [1]])("%j is not a structured answer", (value) => {
    expect(normalizeMessage(ctx, line({ structured_output: value }), 0, "/w").agentOutput).toBeUndefined();
  });
});
