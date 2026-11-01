import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_CANDIDATES, parseAnalystOutput } from "../../src/discovery/analystOutput.js";
import { MAX_CITE_LINES } from "../../src/discovery/verifierOutput.js";

const REJECTED = { ok: false, reason: "output_rejected" };
const cand = (over: Record<string, unknown> = {}) => ({ kind: "docs", title: "Document the retry limit", summary: "The README promises it.", refs: [{ path: "docs/a.md", start_line: 3, end_line: 9 }], ...over });
const env = (candidates: unknown[]) => ({ candidates });

describe("C25-f1-1: the analyst's closed output shape", () => {
  it("accepts a 10-candidate fixture, cleaned and unchanged in meaning", () => {
    const many = Array.from({ length: MAX_CANDIDATES }, (_, i) => cand({ kind: i % 2 === 0 ? "docs" : "code", title: `Change number ${i}` }));
    const r = parseAnalystOutput(env(many));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.candidates).toHaveLength(10);
      expect(r.candidates[1]).toEqual({ kind: "code", title: "Change number 1", summary: "The README promises it.", refs: [{ path: "docs/a.md", start_line: 3, end_line: 9 }] });
    }
  });

  it("accepts no candidates, and the optional names and duplicate_of", () => {
    expect(parseAnalystOutput(env([]))).toEqual({ ok: true, candidates: [] });
    const dup = "AAAAAAAA-0000-4000-8000-000000000001";
    const r = parseAnalystOutput(env([cand({ names_issue: 4, names_discussion: 7, duplicate_of: dup, refs: [] })]));
    expect(r).toMatchObject({ ok: true, candidates: [{ names_issue: 4, names_discussion: 7, duplicate_of: dup.toLowerCase(), refs: [] }] });
  });

  it("an 11th candidate rejects the whole envelope", () => {
    expect(parseAnalystOutput(env(Array.from({ length: MAX_CANDIDATES + 1 }, () => cand())))).toEqual(REJECTED);
  });

  it.each([
    ["an extra field on a candidate", cand({ extra: 1 })],
    ["a claims field", cand({ claims: [] })],
    ["a category field", cand({ category: "bug" })],
    ["a state or decision field", cand({ approve: true })],
    ["a work item field", cand({ work_item: "x" })],
    ["a null optional field", cand({ names_issue: null })],
    ["a non-integer issue number", cand({ names_issue: 1.5 })],
    ["issue number zero", cand({ names_discussion: 0 })],
    ["a duplicate_of that is not a uuid", cand({ duplicate_of: "abc" })],
    ["an unknown kind", cand({ kind: "issue" })],
    ["an empty title", cand({ title: " \n  " })],
    ["six refs", cand({ refs: Array.from({ length: 6 }, () => ({ path: "a.md", start_line: 1, end_line: 1 })) })],
    ["a `..` path", cand({ refs: [{ path: "docs/../../etc/passwd", start_line: 1, end_line: 1 }] })],
    ["an absolute path", cand({ refs: [{ path: "/etc/passwd", start_line: 1, end_line: 1 }] })],
    ["a NUL in a path", cand({ refs: [{ path: "a\u0000b.md", start_line: 1, end_line: 1 }] })],
    ["end_line before start_line", cand({ refs: [{ path: "a.md", start_line: 9, end_line: 3 }] })],
    ["a range over MAX_CITE_LINES", cand({ refs: [{ path: "a.md", start_line: 1, end_line: MAX_CITE_LINES + 1 }] })],
    ["an extra field on a ref", cand({ refs: [{ path: "a.md", start_line: 1, end_line: 1, excerpt: "x" }] })],
    ["a candidate that is not an object", "text"],
  ])("rejects whole, with the one fixed code: %s", (_name, bad) => {
    // The bad candidate sits beside a good one: the good one is not salvaged.
    expect(parseAnalystOutput(env([cand(), bad]))).toEqual(REJECTED);
  });

  it("a range of exactly MAX_CITE_LINES is accepted", () => {
    expect(parseAnalystOutput(env([cand({ refs: [{ path: "a.md", start_line: 10, end_line: 10 + MAX_CITE_LINES - 1 }] })])).ok).toBe(true);
  });

  it.each([
    ["not an object", null],
    ["an array", []],
    ["a claims field at the top", { candidates: [], claims: [] }],
    ["a category field at the top", { candidates: [], category: "bug" }],
    ["no candidates field", {}],
    ["candidates not an array", { candidates: "x" }],
  ])("rejects the envelope: %s", (_name, bad) => {
    expect(parseAnalystOutput(bad)).toEqual(REJECTED);
  });

  it("reads own data properties only: an inherited candidates field is not read", () => {
    const proto = { candidates: [cand()] };
    expect(parseAnalystOutput(Object.create(proto))).toEqual(REJECTED);
    expect(parseAnalystOutput({ candidates: [Object.assign(Object.create({ kind: "docs" }), { title: "t", summary: "s", refs: [] })] })).toEqual(REJECTED);
  });

  it("a rejection never carries a value from the output", () => {
    const secret = "tok_SECRET_VALUE_123";
    expect(JSON.stringify(parseAnalystOutput(env([cand({ [secret]: secret })])))).not.toContain(secret);
  });

  it("titles and summaries are cleaned to one line and cut to their bounds", () => {
    const r = parseAnalystOutput(env([cand({ title: `a\n\nb ${"t".repeat(400)}`, summary: `x ${"s".repeat(5000)}` })]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.candidates[0]!.title.length).toBeLessThanOrEqual(256);
      expect(r.candidates[0]!.title).not.toMatch(/[\n\r\t]/);
      expect(r.candidates[0]!.summary.length).toBeLessThanOrEqual(2000);
    }
  });

  it("the analyst proposes only: the parser and the prompt import nothing that can write (no database, GitHub, run or work-item module)", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "discovery");
    for (const file of ["analystOutput.ts", "analystPrompt.ts"]) {
      const imports = [...readFileSync(path.join(dir, file), "utf8").matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]!);
      for (const spec of imports) expect(spec, `${file}: ${spec}`).toMatch(/^(\.{1,2}\/|@fx\/trust$|@fx\/core\/src\/plan\/roadmapFile\.js$)/);
    }
  });
});
