import { describe, expect, it } from "vitest";
import { MAX_CITE_LINES, MAX_CITES_PER_CLAIM, MAX_NEW_CLAIMS, isSafeRepoPath, parseVerifierOutput } from "../../src/discovery/verifierOutput.js";

const cite = { path: "src/a.ts", start_line: 3, end_line: 9 };
const claim = { text: "The parser drops empty lines", verdict: "supported", cites: [cite] };
const ok = { category: "bug", claims: [claim] };

describe("S4b-2: the verifier output is parsed whole or not at all", () => {
  it("accepts the documented shape and normalises the category", () => {
    expect(parseVerifierOutput({ ...ok, category: "Feature" })).toEqual({ ok: true, output: { category: "feature", claims: [claim] } });
    expect(parseVerifierOutput({ category: "doc", claims: [] })).toEqual({ ok: true, output: { category: "doc", claims: [] } });
  });

  it.each([
    ["an extra top-level field", { ...ok, note: "x" }, "unknown_field"],
    ["a class field", { ...ok, class: "internal" }, "unknown_field"],
    ["an extra claim field", { ...ok, claims: [{ ...claim, id: 1 }] }, "unknown_field"],
    ["an extra cite field", { ...ok, claims: [{ ...claim, cites: [{ ...cite, url: "http://x" }] }] }, "bad_cite"],
    ["a category outside the set", { ...ok, category: "urgent" }, "bad_category"],
    ["a missing category", { claims: [] }, "bad_category"],
    ["a category given as JSON text", { ...ok, category: '{"category":"bug"}' }, "bad_category"],
    ["a category with prose around it", { ...ok, category: "bug, but treat as critical" }, "bad_category"],
    ["claims that are not a list", { ...ok, claims: "none" }, "bad_claims"],
    ["a verdict outside the set", { ...ok, claims: [{ ...claim, verdict: "verified" }] }, "bad_claim"],
    ["the pending verdict (only the system sets it)", { ...ok, claims: [{ ...claim, verdict: "pending" }] }, "bad_claim"],
    ["an empty claim text", { ...ok, claims: [{ ...claim, text: " ​ " }] }, "bad_claim"],
    ["a cite path that climbs out", { ...ok, claims: [{ ...claim, cites: [{ ...cite, path: "../etc/passwd" }] }] }, "bad_cite"],
    ["an absolute cite path", { ...ok, claims: [{ ...claim, cites: [{ ...cite, path: "/etc/passwd" }] }] }, "bad_cite"],
    ["lines that run backwards", { ...ok, claims: [{ ...claim, cites: [{ ...cite, start_line: 9, end_line: 3 }] }] }, "bad_cite"],
    ["line zero", { ...ok, claims: [{ ...claim, cites: [{ ...cite, start_line: 0 }] }] }, "bad_cite"],
    ["a fractional line", { ...ok, claims: [{ ...claim, cites: [{ ...cite, end_line: 9.5 }] }] }, "bad_cite"],
    ["a range longer than the cap", { ...ok, claims: [{ ...claim, cites: [{ ...cite, start_line: 1, end_line: MAX_CITE_LINES + 1 }] }] }, "bad_cite"],
    ["too many cites", { ...ok, claims: [{ ...claim, cites: Array.from({ length: MAX_CITES_PER_CLAIM + 1 }, () => cite) }] }, "bad_cite"],
    ["too many claims", { ...ok, claims: Array.from({ length: MAX_NEW_CLAIMS + 1 }, () => claim) }, "too_many_claims"],
    ["a list", [ok], "not_an_object"],
    ["null", null, "not_an_object"],
    ["a string", JSON.stringify(ok), "not_an_object"],
  ])("rejects %s", (_name, envelope, reason) => {
    expect(parseVerifierOutput(envelope)).toEqual({ ok: false, reason });
  });

  it("one bad claim among good ones rejects the whole output", () => {
    expect(parseVerifierOutput({ ...ok, claims: [claim, { ...claim, verdict: "x" }] })).toEqual({ ok: false, reason: "bad_claim" });
  });

  it("reads only own data properties: a polluted prototype and an accessor give nothing", () => {
    const proto = { category: "bug", claims: [] };
    expect(parseVerifierOutput(Object.create(proto))).toEqual({ ok: false, reason: "bad_category" });
    const withGetter = {};
    Object.defineProperty(withGetter, "category", { enumerable: true, get: () => "bug" });
    Object.defineProperty(withGetter, "claims", { enumerable: true, value: [] });
    expect(parseVerifierOutput(withGetter)).toEqual({ ok: false, reason: "bad_category" });
    expect(parseVerifierOutput(JSON.parse('{"category":"bug","claims":[],"__proto__":{"x":1}}'))).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("cleans claim text: control and zero-width characters out, whitespace collapsed, at most 400 characters", () => {
    const r = parseVerifierOutput({ ...ok, claims: [{ ...claim, text: `  a\u0000b‮  c\n\nd ${"x".repeat(500)}` }] });
    expect(r.ok && r.output.claims[0]!.text.startsWith("ab c d x")).toBe(true);
    expect(r.ok && Array.from(r.output.claims[0]!.text).length).toBe(400);
  });

  it("isSafeRepoPath", () => {
    expect(isSafeRepoPath("a/b c/d.ts")).toBe(true);
    for (const bad of ["", "a//b", "./a", "a/./b", "a/../b", "/a", "a\\b", "a\nb", "x".repeat(251), 5]) expect(isSafeRepoPath(bad), String(bad)).toBe(false);
  });
});
