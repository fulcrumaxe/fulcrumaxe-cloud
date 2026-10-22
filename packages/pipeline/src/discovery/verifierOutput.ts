import { parseClassifierOutput, type TriageCategory } from "../plan/categories.js";
import { ownData } from "../plan/ownData.js";
import { toWellFormedString } from "../plan/unicode.js";

/**
 * D#483 S4-b1: the claim verifier's output, read back from the run's AGENT_OUTPUT envelope.
 *
 * The envelope is model output derived from an outsider's text, so it is parsed strictly and fails closed: any field outside
 * the shape below, a verdict or category outside its fixed set, or a value out of bounds rejects the WHOLE output. The caller
 * records `check_failed` and writes nothing else. Rejections carry a fixed code and never a value from the output.
 *
 *   { "category": "bug",
 *     "claims": [ { "text": "...", "verdict": "supported" | "refuted" | "unverifiable",
 *                   "cites": [ { "path": "src/a.ts", "start_line": 3, "end_line": 9 } ] } ] }
 *
 * At most MAX_NEW_CLAIMS claims (a first pass: discovery writes none), MAX_CITES_PER_CLAIM cites each, and each cite at most
 * MAX_CITE_LINES lines. The model's verdict is a proposal only: the system reads the cites itself (verifierCites.ts).
 */
export const MAX_NEW_CLAIMS = 5;
export const MAX_CITES_PER_CLAIM = 3;
export const MAX_CITE_LINES = 40;
export const MAX_CITE_PATH_CHARS = 250;
export const MAX_CLAIM_TEXT_CHARS = 400;
const MAX_LINE_NUMBER = 9_999_999;

export const MODEL_VERDICTS = ["supported", "refuted", "unverifiable"] as const;
export type ModelVerdict = (typeof MODEL_VERDICTS)[number];

export interface Cite {
  path: string;
  start_line: number;
  end_line: number;
}
export interface VerifierClaim {
  text: string;
  verdict: ModelVerdict;
  cites: Cite[];
}
export interface VerifierOutput {
  category: TriageCategory;
  claims: VerifierClaim[];
}

export type VerifierOutputRejection = "not_an_object" | "unknown_field" | "bad_category" | "bad_claims" | "too_many_claims" | "bad_claim" | "bad_cite";
export type ParsedVerifierOutput = { ok: true; output: VerifierOutput } | { ok: false; reason: VerifierOutputRejection };

// Control characters other than tab and newline, bidi overrides and isolates, and zero-width characters.
const UNWANTED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const PATH_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\\]/;

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);
/** True when the object has an own key (enumerable or not, string or symbol) outside `allowed`. */
const hasOtherKeys = (o: object, allowed: readonly string[]): boolean => Reflect.ownKeys(o).some((k) => typeof k !== "string" || !allowed.includes(k));
const isLine = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= MAX_LINE_NUMBER;

/** A relative repository path: no leading slash, no empty, `.` or `..` segment, no backslash or control character. */
export function isSafeRepoPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > MAX_CITE_PATH_CHARS || p.startsWith("/") || PATH_FORBIDDEN.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

function cleanClaimText(s: string): string {
  return Array.from(toWellFormedString(s).replace(UNWANTED, "").replace(/\s+/g, " ").trim())
    .slice(0, MAX_CLAIM_TEXT_CHARS)
    .join("");
}

function parseCite(raw: unknown): Cite | null {
  if (!isObject(raw) || hasOtherKeys(raw, ["path", "start_line", "end_line"])) return null;
  const path = ownData(raw, "path");
  const start = ownData(raw, "start_line");
  const end = ownData(raw, "end_line");
  if (!isSafeRepoPath(path) || !isLine(start) || !isLine(end) || end < start || end - start + 1 > MAX_CITE_LINES) return null;
  return { path, start_line: start, end_line: end };
}

export function parseVerifierOutput(envelope: unknown): ParsedVerifierOutput {
  const fail = (reason: VerifierOutputRejection): ParsedVerifierOutput => ({ ok: false, reason });
  if (!isObject(envelope)) return fail("not_an_object");
  if (hasOtherKeys(envelope, ["category", "claims"])) return fail("unknown_field");

  // The classifier's own parser decides what a category is. Only a bare word reaches it, so its JSON shortcut cannot be used here.
  const rawCategory = ownData(envelope, "category");
  if (typeof rawCategory !== "string" || !/^[A-Za-z]{1,20}$/.test(rawCategory)) return fail("bad_category");
  const category = parseClassifierOutput(rawCategory);
  if (!category.ok) return fail("bad_category");

  const rawClaims = ownData(envelope, "claims");
  if (!Array.isArray(rawClaims)) return fail("bad_claims");
  if (rawClaims.length > MAX_NEW_CLAIMS) return fail("too_many_claims");

  const claims: VerifierClaim[] = [];
  for (const raw of rawClaims as unknown[]) {
    if (!isObject(raw)) return fail("bad_claim");
    if (hasOtherKeys(raw, ["text", "verdict", "cites"])) return fail("unknown_field");
    const text = ownData(raw, "text");
    const verdict = ownData(raw, "verdict");
    const rawCites = ownData(raw, "cites");
    if (typeof text !== "string" || typeof verdict !== "string" || !(MODEL_VERDICTS as readonly string[]).includes(verdict)) return fail("bad_claim");
    const clean = cleanClaimText(text);
    if (clean === "" || !Array.isArray(rawCites)) return fail("bad_claim");
    if (rawCites.length > MAX_CITES_PER_CLAIM) return fail("bad_cite");
    const cites: Cite[] = [];
    for (const c of rawCites as unknown[]) {
      const cite = parseCite(c);
      if (cite === null) return fail("bad_cite");
      cites.push(cite);
    }
    claims.push({ text: clean, verdict: verdict as ModelVerdict, cites });
  }
  return { ok: true, output: { category: category.category, claims } };
}
