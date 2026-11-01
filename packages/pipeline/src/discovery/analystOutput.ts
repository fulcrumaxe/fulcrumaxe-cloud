import { cleanText } from "@fx/core/src/plan/roadmapFile.js";
import { ownData } from "../plan/ownData.js";
import { parseCite, type Cite } from "./verifierOutput.js";

/**
 * D#483 S4-f1 (R-C25-5): the discovery analyst's output, read back from the run's AGENT_OUTPUT envelope.
 *
 * The analyst only PROPOSES. Its envelope is model output derived from text in a customer's repository, so it is parsed strictly and fails
 * closed: any field outside the closed shape below, an 11th candidate, a bad path or a bad line range rejects the WHOLE envelope, and the
 * result is the one fixed code `output_rejected` (never a value from the output). The caller then writes nothing. The shape has no field that
 * could carry a claim, a category, a decision or a work item (a `claims` or `category` field is an unknown field), so the system, not the
 * model, decides what is written (S4-f2).
 *
 *   { "candidates": [ { "kind": "docs" | "code", "title": "...", "summary": "...",
 *                       "refs": [ { "path": "docs/a.md", "start_line": 3, "end_line": 9 } ],
 *                       "names_issue": 4, "names_discussion": 7, "duplicate_of": "<uuid>" } ] }
 *
 * The last three are optional. The refs are not evidence: they are stored as pointers and the verifier re-reads them itself.
 */
export const MAX_CANDIDATES = 10;
export const MAX_CANDIDATE_REFS = 5;
export const MAX_CANDIDATE_TITLE_CHARS = 256;
export const MAX_CANDIDATE_SUMMARY_CHARS = 2000;
const MAX_ITEM_NUMBER = 2_147_483_647;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CANDIDATE_KINDS = ["docs", "code"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export interface AnalystCandidate {
  kind: CandidateKind;
  title: string;
  summary: string;
  refs: Cite[];
  names_issue?: number;
  names_discussion?: number;
  duplicate_of?: string;
}
export type ParsedAnalystOutput = { ok: true; candidates: AnalystCandidate[] } | { ok: false; reason: "output_rejected" };

const REJECTED: ParsedAnalystOutput = Object.freeze({ ok: false, reason: "output_rejected" });
const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);
/** True when the object has an own key (enumerable or not, string or symbol) outside `allowed`. */
const hasOtherKeys = (o: object, allowed: readonly string[]): boolean => Reflect.ownKeys(o).some((k) => typeof k !== "string" || !allowed.includes(k));
const isItemNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= MAX_ITEM_NUMBER;

const CANDIDATE_KEYS = ["kind", "title", "summary", "refs", "names_issue", "names_discussion", "duplicate_of"] as const;

function parseCandidate(raw: unknown): AnalystCandidate | null {
  if (!isObject(raw) || hasOtherKeys(raw, CANDIDATE_KEYS)) return null;
  const kind = ownData(raw, "kind");
  const title = ownData(raw, "title");
  const summary = ownData(raw, "summary");
  const refs = ownData(raw, "refs");
  if (kind !== "docs" && kind !== "code") return null;
  if (typeof title !== "string" || typeof summary !== "string" || !Array.isArray(refs) || refs.length > MAX_CANDIDATE_REFS) return null;
  const cleanTitle = cleanText(title, MAX_CANDIDATE_TITLE_CHARS);
  if (cleanTitle === "") return null;
  const cites: Cite[] = [];
  for (const r of refs as unknown[]) {
    const cite = parseCite(r);
    if (cite === null) return null;
    cites.push(cite);
  }
  const out: AnalystCandidate = { kind, title: cleanTitle, summary: cleanText(summary, MAX_CANDIDATE_SUMMARY_CHARS), refs: cites };
  // An optional field is either absent or valid; a present field of the wrong type (null included) rejects.
  for (const key of ["names_issue", "names_discussion"] as const) {
    if (!Object.hasOwn(raw, key)) continue;
    const v = ownData(raw, key);
    if (!isItemNumber(v)) return null;
    out[key] = v;
  }
  if (Object.hasOwn(raw, "duplicate_of")) {
    const v = ownData(raw, "duplicate_of");
    if (typeof v !== "string" || !UUID_RE.test(v)) return null;
    out.duplicate_of = v.toLowerCase();
  }
  return out;
}

export function parseAnalystOutput(envelope: unknown): ParsedAnalystOutput {
  if (!isObject(envelope) || hasOtherKeys(envelope, ["candidates"])) return REJECTED;
  const raw = ownData(envelope, "candidates");
  if (!Array.isArray(raw) || raw.length > MAX_CANDIDATES) return REJECTED;
  const candidates: AnalystCandidate[] = [];
  for (const c of raw as unknown[]) {
    const parsed = parseCandidate(c);
    if (parsed === null) return REJECTED;
    candidates.push(parsed);
  }
  return { ok: true, candidates };
}
