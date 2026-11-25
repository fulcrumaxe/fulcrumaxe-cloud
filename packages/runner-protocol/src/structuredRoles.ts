import { MAX_PRD_BYTES, MAX_ROADMAP_ROWS, SURVEY_ROLE, readSurveyOutput } from "./projectDraft.js";
import { DISCOVERY_ANALYST_ROLE, PROPOSAL_VERIFIER_ROLE } from "./verifierGuard.js";

/**
 * D#6 RUNNER-STRUCTURED-OUTPUT: the roles whose answer has ONE fixed shape that the cloud parses strictly (the claim verifier's
 * `parseVerifierOutput`, the discovery analyst's `parseAnalystOutput`). For these roles the runner asks the CLI for structured output
 * (`--json-schema`), reads the result from the stream's `structured_output` field, and, when the answer still fails, spends one repair turn.
 *
 * The cloud's parsers stay the authority. This file holds the same bounds as a JSON Schema for the CLI, and a validator that answers with CLOSED
 * CODES only (never a value from the answer), so the repair turn can name what failed without echoing any text the model derived from a
 * repository. The validator never rejects what the cloud's parser accepts (the cloud package keeps a parity test over a corpus); it may accept a
 * little more, in which case the cloud's own check still decides and no repair happens.
 *
 * Free-form roles have no entry: they keep the text envelope and no repair.
 */
export const STRUCTURED_OUTPUT_ROLES: readonly string[] = Object.freeze([PROPOSAL_VERIFIER_ROLE, DISCOVERY_ANALYST_ROLE, SURVEY_ROLE]);

/** The fixed categories (`TRIAGE_CATEGORIES` in the cloud's pipeline package; a parity test keeps the two equal). */
export const STRUCTURED_TRIAGE_CATEGORIES: readonly string[] = Object.freeze(["critical", "feature", "small", "bug", "doc", "question", "project"]);

const MAX_LINE_NUMBER = 9_999_999;
const MAX_ITEM_NUMBER = 2_147_483_647;
const MAX_CITE_LINES = 40;
const MAX_CITE_PATH_CHARS = 250;
const MAX_CLAIMS = 5;
const MAX_CITES = 3;
const MAX_CANDIDATES = 10;
const MAX_REFS = 5;
const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const CITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "start_line", "end_line"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: MAX_CITE_PATH_CHARS },
    start_line: { type: "integer", minimum: 1, maximum: MAX_LINE_NUMBER },
    end_line: { type: "integer", minimum: 1, maximum: MAX_LINE_NUMBER },
  },
} as const;

const VERIFIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "claims"],
  properties: {
    category: { type: "string", enum: [...STRUCTURED_TRIAGE_CATEGORIES] },
    claims: {
      type: "array",
      maxItems: MAX_CLAIMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "verdict", "cites"],
        properties: {
          text: { type: "string", minLength: 1 },
          verdict: { type: "string", enum: ["supported", "refuted", "unverifiable"] },
          cites: { type: "array", maxItems: MAX_CITES, items: CITE_SCHEMA },
        },
      },
    },
  },
} as const;

const ANALYST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: MAX_CANDIDATES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title", "summary", "refs"],
        properties: {
          kind: { type: "string", enum: ["docs", "code"] },
          title: { type: "string", minLength: 1 },
          summary: { type: "string" },
          refs: { type: "array", maxItems: MAX_REFS, items: CITE_SCHEMA },
          names_issue: { type: "integer", minimum: 1, maximum: MAX_ITEM_NUMBER },
          names_discussion: { type: "integer", minimum: 1, maximum: MAX_ITEM_NUMBER },
          duplicate_of: { type: "string", pattern: UUID },
        },
      },
    },
  },
} as const;

// D#845 ON-10c: the survey's schema holds `ProjectDraft`'s own bounds, as far as JSON Schema can say them (it counts characters, not bytes, and cannot say "acyclic"); a test holds it to the draft over a corpus.
const SURVEY_KEY = "^[A-Z][A-Z0-9-]{0,15}$";
const SURVEY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["v", "prd_md", "roadmap"],
  properties: {
    v: { const: 1 },
    prd_md: { type: "string", minLength: 1 },
    roadmap: {
      type: "array",
      minItems: 1,
      maxItems: MAX_ROADMAP_ROWS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["row_key", "title", "summary", "size", "depends_on"],
        properties: {
          row_key: { type: "string", pattern: SURVEY_KEY },
          title: { type: "string", minLength: 1, maxLength: 120 },
          summary: { type: "string", maxLength: 500 },
          size: { type: "string", enum: ["S", "M", "L"] },
          depends_on: { type: "array", maxItems: 10, items: { type: "string", pattern: SURVEY_KEY } },
        },
      },
    },
  },
} as const;

/** The JSON Schema the CLI is asked to enforce for this role's final answer, or undefined for a role with no fixed shape. */
export function structuredSchemaFor(role: string): Record<string, unknown> | undefined {
  if (role === PROPOSAL_VERIFIER_ROLE) return VERIFIER_SCHEMA as unknown as Record<string, unknown>;
  if (role === DISCOVERY_ANALYST_ROLE) return ANALYST_SCHEMA as unknown as Record<string, unknown>;
  // D#845 ON-10c: the full schema of `ProjectDraft`, and a parity test over a corpus (it never rejects what the draft accepts).
  if (role === SURVEY_ROLE) return SURVEY_SCHEMA as unknown as Record<string, unknown>;
  return undefined;
}

/** Every code `structuredFailures` can return. Closed: the repair prompt carries these and nothing else. */
export const STRUCTURED_FAILURE_CODES = Object.freeze([
  "no_envelope", "not_an_object", "unknown_field",
  "bad_category", "bad_claims", "too_many_claims", "bad_claim", "bad_cite",
  "bad_candidates", "too_many_candidates", "bad_candidate", "bad_ref",
  // D#845 ON-10c: the survey's own codes.
  "bad_version", "bad_prd", "bad_roadmap", "too_many_rows", "bad_row", "bad_depends",
] as const);
export type StructuredFailureCode = (typeof STRUCTURED_FAILURE_CODES)[number];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasOtherKeys = (o: object, allowed: readonly string[]): boolean => Reflect.ownKeys(o).some((k) => typeof k !== "string" || !allowed.includes(k));
/** An own data property, read once (an inherited or accessor property reads as absent), as the cloud's parsers read it. */
function own(o: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d !== undefined && "value" in d ? d.value : undefined;
}
const isLine = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= MAX_LINE_NUMBER;
const PATH_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\\]/;
const UNWANTED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;
const nonEmptyAfterCleaning = (s: string): boolean => s.replace(UNWANTED, "").trim() !== "";

function safePath(p: unknown): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > MAX_CITE_PATH_CHARS || p.startsWith("/") || PATH_FORBIDDEN.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** A cite is fine when well-formed; a span over MAX_CITE_LINES is fine too (the cloud downgrades only that claim, it does not reject). */
function citeOk(raw: unknown): boolean {
  if (!isObject(raw) || hasOtherKeys(raw, ["path", "start_line", "end_line"])) return false;
  const start = own(raw, "start_line");
  const end = own(raw, "end_line");
  return safePath(own(raw, "path")) && isLine(start) && isLine(end) && end >= start;
}
const spanOk = (raw: Record<string, unknown>): boolean => (own(raw, "end_line") as number) - (own(raw, "start_line") as number) + 1 <= MAX_CITE_LINES;

function verifierFailures(envelope: unknown): StructuredFailureCode[] {
  if (!isObject(envelope)) return ["not_an_object"];
  if (hasOtherKeys(envelope, ["category", "claims"])) return ["unknown_field"];
  const codes = new Set<StructuredFailureCode>();
  const category = own(envelope, "category");
  if (typeof category !== "string" || !/^[A-Za-z]{1,20}$/.test(category) || !STRUCTURED_TRIAGE_CATEGORIES.includes(category.toLowerCase())) codes.add("bad_category");
  const claims = own(envelope, "claims");
  if (!Array.isArray(claims)) codes.add("bad_claims");
  else if (claims.length > MAX_CLAIMS) codes.add("too_many_claims");
  else {
    for (const raw of claims as unknown[]) {
      if (!isObject(raw)) {
        codes.add("bad_claim");
        continue;
      }
      if (hasOtherKeys(raw, ["text", "verdict", "cites"])) {
        codes.add("unknown_field");
        continue;
      }
      const text = own(raw, "text");
      const verdict = own(raw, "verdict");
      const cites = own(raw, "cites");
      if (typeof text !== "string" || !nonEmptyAfterCleaning(text) || typeof verdict !== "string" || !["supported", "refuted", "unverifiable"].includes(verdict) || !Array.isArray(cites)) codes.add("bad_claim");
      else if (cites.length > MAX_CITES || !(cites as unknown[]).every(citeOk)) codes.add("bad_cite");
    }
  }
  return [...codes];
}

function analystFailures(envelope: unknown): StructuredFailureCode[] {
  if (!isObject(envelope)) return ["not_an_object"];
  if (hasOtherKeys(envelope, ["candidates"])) return ["unknown_field"];
  const candidates = own(envelope, "candidates");
  if (!Array.isArray(candidates)) return ["bad_candidates"];
  if (candidates.length > MAX_CANDIDATES) return ["too_many_candidates"];
  const codes = new Set<StructuredFailureCode>();
  const keys = ["kind", "title", "summary", "refs", "names_issue", "names_discussion", "duplicate_of"];
  for (const raw of candidates as unknown[]) {
    if (!isObject(raw)) {
      codes.add("bad_candidate");
      continue;
    }
    if (hasOtherKeys(raw, keys)) {
      codes.add("unknown_field");
      continue;
    }
    const kind = own(raw, "kind");
    const title = own(raw, "title");
    const refs = own(raw, "refs");
    if ((kind !== "docs" && kind !== "code") || typeof title !== "string" || !nonEmptyAfterCleaning(title) || typeof own(raw, "summary") !== "string" || !Array.isArray(refs)) codes.add("bad_candidate");
    else if (refs.length > MAX_REFS || !(refs as unknown[]).every((r) => citeOk(r) && spanOk(r as Record<string, unknown>))) codes.add("bad_ref");
    for (const key of ["names_issue", "names_discussion"]) {
      if (!Object.hasOwn(raw, key)) continue;
      const v = own(raw, key);
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > MAX_ITEM_NUMBER) codes.add("bad_candidate");
    }
    if (Object.hasOwn(raw, "duplicate_of")) {
      const v = own(raw, "duplicate_of");
      if (typeof v !== "string" || !new RegExp(UUID).test(v)) codes.add("bad_candidate");
    }
  }
  return [...codes];
}

const SURVEY_KEY_RE = new RegExp(SURVEY_KEY);
const SURVEY_ROW_KEYS = ["row_key", "title", "summary", "size", "depends_on"];

/**
 * D#845 ON-10c: the survey's closed codes. The decision is `readSurveyOutput`'s (the cloud's own read, redaction first, then `ProjectDraft`), so this never rejects what the cloud accepts. Only a refused answer is looked at
 * again, part by part, to say which part: a value never leaves this function, only a code.
 */
function surveyFailures(output: unknown): StructuredFailureCode[] {
  if (!isObject(output)) return ["not_an_object"];
  if (readSurveyOutput(output).ok) return [];
  if (hasOtherKeys(output, ["v", "prd_md", "roadmap"])) return ["unknown_field"];
  const codes = new Set<StructuredFailureCode>();
  if (own(output, "v") !== 1) codes.add("bad_version");
  const prd = own(output, "prd_md");
  if (typeof prd !== "string" || prd.length === 0 || Buffer.byteLength(prd, "utf8") > MAX_PRD_BYTES) codes.add("bad_prd");
  const roadmap = own(output, "roadmap");
  if (!Array.isArray(roadmap) || roadmap.length === 0) codes.add("bad_roadmap");
  else if (roadmap.length > MAX_ROADMAP_ROWS) codes.add("too_many_rows");
  else {
    const keys = new Set<string>();
    let rowsOk = true;
    for (const row of roadmap as unknown[]) {
      const key = isObject(row) ? own(row, "row_key") : undefined;
      const deps = isObject(row) ? own(row, "depends_on") : undefined;
      if (!isObject(row) || hasOtherKeys(row, SURVEY_ROW_KEYS) || typeof key !== "string" || !SURVEY_KEY_RE.test(key) || typeof own(row, "title") !== "string" || typeof own(row, "summary") !== "string" || !["S", "M", "L"].includes(own(row, "size") as string) || !Array.isArray(deps) || deps.length > 10 || !deps.every((d) => typeof d === "string" && SURVEY_KEY_RE.test(d))) {
        codes.add("bad_row");
        rowsOk = false;
        continue;
      }
      if (keys.has(key)) codes.add("bad_depends");
      keys.add(key);
    }
    if (rowsOk && (roadmap as Array<Record<string, unknown>>).some((row) => (own(row, "depends_on") as string[]).some((d) => d === own(row, "row_key") || !keys.has(d)))) codes.add("bad_depends");
  }
  // A refusal none of the checks above names (a cycle, a length the checks cannot see, a control character): the parts are named by what is left over.
  if (codes.size === 0) codes.add(Array.isArray(roadmap) ? "bad_row" : "bad_roadmap");
  return [...codes];
}

/**
 * Why a structured role's answer would be refused, as closed codes (empty: nothing to repair). A role with no fixed shape is never a failure.
 * `undefined` is "no envelope at all".
 */
export function structuredFailures(role: string, output: unknown): StructuredFailureCode[] {
  if (!STRUCTURED_OUTPUT_ROLES.includes(role)) return [];
  if (output === undefined) return ["no_envelope"];
  if (role === SURVEY_ROLE) return surveyFailures(output);
  return role === PROPOSAL_VERIFIER_ROLE ? verifierFailures(output) : analystFailures(output);
}

/**
 * The one repair message. It names the failing parts by code and carries no other text from the run, so nothing the model read can steer it or reach
 * a log through it. The agent is asked for the corrected JSON alone, without tools.
 */
export function repairPromptFor(codes: readonly StructuredFailureCode[]): string {
  const known = codes.filter((c) => (STRUCTURED_FAILURE_CODES as readonly string[]).includes(c));
  return [
    "Your last answer was refused because it did not match the required shape.",
    `Failing parts (codes): ${known.join(", ")}.`,
    "Reply once more with only the corrected JSON, in the same shape as before and inside the same envelope block. Do not use any tools and do not add any other text.",
  ].join("\n");
}
