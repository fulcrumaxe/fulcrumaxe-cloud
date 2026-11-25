import { describe, expect, it } from "vitest";
import { MAX_PRD_BYTES, MAX_ROADMAP_ROWS, ProjectDraft, STRUCTURED_FAILURE_CODES, STRUCTURED_OUTPUT_ROLES, SURVEY_ROLE, readSurveyOutput, repairPromptFor, structuredFailures, structuredSchemaFor } from "../src/index.js";
import { FIXTURE_DRAFTS, PLAIN_DRAFT, draftRow } from "./helpers/projectDrafts.js";

/**
 * D#845 ON-10c: the survey's JSON Schema (what the CLI is asked to enforce) and its closed-code validator (what the repair turn names) are held to `ProjectDraft`, the cloud's authority: over a corpus, neither ever
 * rejects what `ProjectDraft` accepts, and the validator names every answer the draft refuses. The schema is checked by a small validator of the subset it uses, written here (no schema library is a dependency).
 */
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const points = (s: string): number => [...s].length;

/** The part of JSON Schema `structuredSchemaFor` uses: type, const, enum, pattern, string length in code points, item counts, required and closed objects. */
function valid(schema: Record<string, unknown>, value: unknown): boolean {
  if ("const" in schema && value !== schema["const"]) return false;
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) return false;
  switch (schema["type"]) {
    case "object": {
      if (!isObject(value)) return false;
      const props = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
      if ((schema["required"] as string[] | undefined)?.some((key) => !(key in value))) return false;
      return Object.entries(value).every(([key, v]) => (key in props ? valid(props[key]!, v) : schema["additionalProperties"] !== false));
    }
    case "array": {
      if (!Array.isArray(value)) return false;
      if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) return false;
      if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) return false;
      return schema["items"] === undefined || value.every((v) => valid(schema["items"] as Record<string, unknown>, v));
    }
    case "string": {
      if (typeof value !== "string") return false;
      if (typeof schema["minLength"] === "number" && points(value) < schema["minLength"]) return false;
      if (typeof schema["maxLength"] === "number" && points(value) > schema["maxLength"]) return false;
      return typeof schema["pattern"] !== "string" || new RegExp(schema["pattern"]).test(value);
    }
    default:
      return true;
  }
}

const SCHEMA = structuredSchemaFor(SURVEY_ROLE) as Record<string, unknown>;
const rows = (n: number) => Array.from({ length: n }, (_, i) => draftRow(`R${i}`));
const keys = Array.from({ length: 11 }, (_, i) => `D${i}`);
const with_ = (over: Record<string, unknown>) => ({ ...PLAIN_DRAFT, ...over });

const CORPUS: Array<[string, unknown]> = [
  ...Object.entries(FIXTURE_DRAFTS),
  ["rows 1", with_({ roadmap: rows(1) })],
  ["rows 200", with_({ roadmap: rows(200) })],
  ["rows 0", with_({ roadmap: [] })],
  ["rows 201", with_({ roadmap: rows(201) })],
  ["title 1", with_({ roadmap: [draftRow("A", [], "x")] })],
  ["title 120", with_({ roadmap: [draftRow("A", [], "x".repeat(120))] })],
  ["title 121", with_({ roadmap: [draftRow("A", [], "x".repeat(121))] })],
  ["title empty", with_({ roadmap: [draftRow("A", [], "")] })],
  ["title 120 astral", with_({ roadmap: [draftRow("A", [], "😀".repeat(120))] })],
  ["title 121 astral", with_({ roadmap: [draftRow("A", [], "😀".repeat(121))] })],
  ["title with a newline", with_({ roadmap: [draftRow("A", [], "a\nb")] })],
  ["summary 500", with_({ roadmap: [{ ...draftRow("A"), summary: "s".repeat(500) }] })],
  ["summary 501", with_({ roadmap: [{ ...draftRow("A"), summary: "s".repeat(501) }] })],
  ["summary empty", with_({ roadmap: [{ ...draftRow("A"), summary: "" }] })],
  ["size XL", with_({ roadmap: [{ ...draftRow("A"), size: "XL" }] })],
  ["size lower", with_({ roadmap: [{ ...draftRow("A"), size: "s" }] })],
  ["key lower", with_({ roadmap: [draftRow("a")] })],
  ["key digit first", with_({ roadmap: [draftRow("1A")] })],
  ["key 16", with_({ roadmap: [draftRow("A".repeat(16))] })],
  ["key 17", with_({ roadmap: [draftRow("A".repeat(17))] })],
  ["key with a dash", with_({ roadmap: [draftRow("A-1"), draftRow("B", ["A-1"])] })],
  ["deps 10", with_({ roadmap: [...keys.map((k) => draftRow(k)), draftRow("Z", keys.slice(0, 10))] })],
  ["deps 11", with_({ roadmap: [...keys.map((k) => draftRow(k)), draftRow("Z", keys)] })],
  ["duplicate key", with_({ roadmap: [draftRow("A"), draftRow("A")] })],
  ["unresolved dep", with_({ roadmap: [draftRow("A", ["B"])] })],
  ["self dep", with_({ roadmap: [draftRow("A", ["A"])] })],
  ["cycle 2", with_({ roadmap: [draftRow("A", ["B"]), draftRow("B", ["A"])] })],
  ["cycle 3 beside a free row", with_({ roadmap: [draftRow("A", ["C"]), draftRow("B", ["A"]), draftRow("C", ["B"]), draftRow("D")] })],
  ["diamond", with_({ roadmap: [draftRow("A"), draftRow("B", ["A"]), draftRow("C", ["A"]), draftRow("D", ["B", "C"])] })],
  ["prd empty", with_({ prd_md: "" })],
  ["prd one char", with_({ prd_md: "x" })],
  ["prd over the byte cap", with_({ prd_md: "x".repeat(MAX_PRD_BYTES + 1) })],
  ["prd at the byte cap", with_({ prd_md: "x".repeat(MAX_PRD_BYTES) })],
  ["prd with NUL", with_({ prd_md: "a\u0000b" })],
  ["prd with ESC", with_({ prd_md: "a\u001bb" })],
  ["prd with tab and newline", with_({ prd_md: "a\tb\nc" })],
  ["prd with CRLF", with_({ prd_md: "a\r\nb" })],
  ["prd with a lone surrogate", with_({ prd_md: "a\ud800b" })],
  ["prd not a string", with_({ prd_md: 5 })],
  ["v 2", with_({ v: 2 })],
  ["v string", with_({ v: "1" })],
  ["v missing", { prd_md: PLAIN_DRAFT.prd_md, roadmap: PLAIN_DRAFT.roadmap }],
  ["prd missing", { v: 1, roadmap: PLAIN_DRAFT.roadmap }],
  ["roadmap missing", { v: 1, prd_md: PLAIN_DRAFT.prd_md }],
  ["roadmap not an array", with_({ roadmap: {} })],
  ["unknown top key", with_({ extra: 1 })],
  ["keep on a row", with_({ roadmap: [{ ...draftRow("A"), keep: true }] })],
  ["row missing a key", with_({ roadmap: [{ row_key: "A", title: "t", summary: "s", size: "S" }] })],
  ["row not an object", with_({ roadmap: ["A"] })],
  ["depends_on not an array", with_({ roadmap: [{ ...draftRow("A"), depends_on: "B" }] })],
  ["dep not a key", with_({ roadmap: [draftRow("A", ["a"])] })],
  ["an array", []],
  ["a string", "draft"],
  ["null", null],
  ["a number", 3],
];

describe("the survey's schema and validator against ProjectDraft (a parity corpus)", () => {
  it("the corpus holds both kinds: drafts the cloud accepts and drafts it refuses", () => {
    const accepted = CORPUS.filter(([, d]) => ProjectDraft.safeParse(d).success).length;
    expect(accepted).toBeGreaterThan(15);
    expect(CORPUS.length - accepted).toBeGreaterThan(30);
  });

  it.each(CORPUS)("%s: neither the schema nor the validator rejects what ProjectDraft accepts, and the validator names every refusal", (_name, draft) => {
    const accepts = ProjectDraft.safeParse(draft).success;
    const codes = structuredFailures(SURVEY_ROLE, draft);
    if (accepts) {
      expect(valid(SCHEMA, draft)).toBe(true);
      expect(codes).toEqual([]);
    } else {
      expect(codes.length).toBeGreaterThan(0);
    }
    // The validator and the cloud's own read agree, answer by answer.
    expect(codes.length === 0).toBe(readSurveyOutput(draft).ok);
    for (const code of codes) expect(STRUCTURED_FAILURE_CODES as readonly string[]).toContain(code);
  });

  it("the schema alone refuses what it can say: an unknown key, a bad key, a long title, a long summary, an oversize list, a wrong size", () => {
    for (const [name, d] of CORPUS) {
      if (["unknown top key", "keep on a row", "key lower", "key 17", "title 121", "summary 501", "rows 201", "rows 0", "size XL", "deps 11", "v 2"].includes(name)) expect(valid(SCHEMA, d), name).toBe(false);
    }
  });

  it("the schema is a closed object that names its three fields, caps the rows at the protocol's number, and is plain JSON", () => {
    expect(SCHEMA).toMatchObject({ type: "object", additionalProperties: false, required: ["v", "prd_md", "roadmap"] });
    expect((SCHEMA["properties"] as { roadmap: { maxItems: number } }).roadmap.maxItems).toBe(MAX_ROADMAP_ROWS);
    expect(JSON.parse(JSON.stringify(SCHEMA))).toEqual(SCHEMA);
    expect(STRUCTURED_OUTPUT_ROLES).toContain(SURVEY_ROLE);
  });
});

describe("the survey's closed codes", () => {
  it("name the failing part and nothing the answer said", () => {
    const secret = "ZZ-UNTRUSTED-REPO-TEXT-ZZ";
    const answers: Array<[unknown, string[]]> = [
      [undefined, ["no_envelope"]],
      [[], ["not_an_object"]],
      [{ ...PLAIN_DRAFT, extra: secret }, ["unknown_field"]],
      [with_({ v: 2 }), ["bad_version"]],
      [with_({ prd_md: "" }), ["bad_prd"]],
      [with_({ roadmap: secret }), ["bad_roadmap"]],
      [with_({ roadmap: [] }), ["bad_roadmap"]],
      [with_({ roadmap: rows(201) }), ["too_many_rows"]],
      [with_({ roadmap: [{ ...draftRow("A"), size: secret }] }), ["bad_row"]],
      [with_({ roadmap: [draftRow("A", [secret])] }), ["bad_row"]],
      [with_({ roadmap: [draftRow("A", ["B"])] }), ["bad_depends"]],
      [with_({ roadmap: [draftRow("A"), draftRow("A")] }), ["bad_depends"]],
      [with_({ roadmap: [draftRow("A", ["A"])] }), ["bad_depends"]],
    ];
    for (const [answer, expected] of answers) {
      const codes = structuredFailures(SURVEY_ROLE, answer);
      expect(codes, JSON.stringify(expected)).toEqual(expected);
      expect(repairPromptFor(codes)).not.toContain(secret);
    }
  });

  it("a cycle, which no part-by-part check sees, is still named (as a row failure), never accepted", () => {
    expect(structuredFailures(SURVEY_ROLE, with_({ roadmap: [draftRow("A", ["B"]), draftRow("B", ["A"])] }))).toEqual(["bad_row"]);
  });

  it("an answer that only a secret's redaction would repair is read the way the cloud reads it (redaction first)", () => {
    const long = `${"x".repeat(495)} sk-ant-api03-${"a".repeat(40)}`;
    const draft = with_({ roadmap: [{ ...draftRow("A"), summary: long }] });
    expect(structuredFailures(SURVEY_ROLE, draft).length === 0).toBe(readSurveyOutput(draft).ok);
  });

  it("every survey code is on the closed list the repair message may carry", () => {
    for (const code of ["bad_version", "bad_prd", "bad_roadmap", "too_many_rows", "bad_row", "bad_depends"]) expect(STRUCTURED_FAILURE_CODES as readonly string[]).toContain(code);
  });
});
