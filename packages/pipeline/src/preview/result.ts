import { parseClassifierOutput, type TriageCategory } from "../plan/categories.js";
import { ownData } from "../plan/ownData.js";
import { toWellFormedString } from "../plan/unicode.js";
import { PREVIEW_MAX_ISSUES } from "./prompt.js";

/**
 * D#2 H17c-2 (Q-17c-3): turns a finished preview run's own output envelope into
 * the result the customer sees. Computed on read; nothing is stored. The envelope
 * is model output derived from untrusted repository text, so every field is read
 * as an own data property, checked, and the text cleaned; anything off makes the
 * whole result `invalid_output` rather than a partial one.
 */

export const PREVIEW_MAX_TITLE_CHARS = 200;
export const PREVIEW_MAX_SPEC_BYTES = 16 * 1024;
/** The preview's model cap; an issue estimate above it cannot be true. */
export const PREVIEW_EXPECTED_USD_MAX = 20;

export interface PreviewIssue {
  number: number;
  title: string;
  category: TriageCategory;
  expected_model_usd: number;
}
export interface PreviewResult {
  issues: PreviewIssue[];
  sample_spec: { issue_number: number; body: string };
}
export type ParsedPreviewResult = PreviewResult | { error: "invalid_output" };

const INVALID: ParsedPreviewResult = { error: "invalid_output" };
// Control characters other than tab and newline, bidi overrides and isolates, and zero-width characters.
const UNWANTED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

function clean(s: string): string {
  return toWellFormedString(s).replace(UNWANTED, "");
}
function cleanTitle(s: string): string {
  return Array.from(clean(s).replace(/\s+/g, " ").trim())
    .slice(0, PREVIEW_MAX_TITLE_CHARS)
    .join("");
}
function cleanBody(s: string): string {
  const chars = Array.from(clean(s).replace(/\r\n?/g, "\n"));
  let bytes = 0;
  let end = 0;
  for (; end < chars.length; end++) {
    bytes += Buffer.byteLength(chars[end]!, "utf8");
    if (bytes > PREVIEW_MAX_SPEC_BYTES) break;
  }
  return chars.slice(0, end).join("");
}
const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);
const isIssueNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function parsePreviewResult(envelope: unknown): ParsedPreviewResult {
  if (!isObject(envelope)) return INVALID;
  const rawIssues = ownData(envelope, "issues");
  const rawSpec = ownData(envelope, "sample_spec");
  if (!Array.isArray(rawIssues) || rawIssues.length > PREVIEW_MAX_ISSUES || !isObject(rawSpec)) return INVALID;

  const issues: PreviewIssue[] = [];
  for (const raw of rawIssues as unknown[]) {
    if (!isObject(raw)) return INVALID;
    const number = ownData(raw, "number");
    const title = ownData(raw, "title");
    const category = ownData(raw, "category");
    const usd = ownData(raw, "expected_model_usd");
    if (!isIssueNumber(number) || typeof title !== "string" || typeof usd !== "number") return INVALID;
    if (!Number.isFinite(usd) || usd <= 0 || usd > PREVIEW_EXPECTED_USD_MAX) return INVALID;
    // The classifier's own parser decides what a category is, so the set cannot drift.
    const parsed = parseClassifierOutput(category);
    if (!parsed.ok) return INVALID;
    issues.push({ number, title: cleanTitle(title), category: parsed.category, expected_model_usd: usd });
  }

  const issueNumber = ownData(rawSpec, "issue_number");
  const body = ownData(rawSpec, "body");
  if (!isIssueNumber(issueNumber) || typeof body !== "string") return INVALID;
  return { issues, sample_spec: { issue_number: issueNumber, body: cleanBody(body) } };
}
