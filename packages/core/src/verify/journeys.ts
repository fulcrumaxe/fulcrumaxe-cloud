import { classifyCriteria } from './criteria.js';

/**
 * D#6 V1: the journeys a verification row will check, derived before the run and without a model.
 *
 * A journey is {id, source, text}: one per numbered acceptance criterion of the item's Spec, one per standing journey the repository keeps in its verify
 * settings, and, when an earlier row failed a journey, that journey again with source `recheck`. Everything here is plain text that is cut to a length and
 * stripped of control characters, links and invisible characters before it is stored, because it is shown on a card and later handed to a tester.
 */
export const JOURNEY_SOURCES = ['criterion', 'standing', 'recheck'] as const;
export type JourneySource = (typeof JOURNEY_SOURCES)[number];
export interface Journey {
  id: string;
  source: JourneySource;
  text: string;
}
export interface StandingJourney {
  id: string;
  text: string;
}

export const MAX_JOURNEYS = 60;
export const MAX_CRITERIA = 30;
export const MAX_STANDING = 20;
export const MAX_JOURNEY_TEXT = 400;
export const JOURNEY_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
const STANDING_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

// Control characters, line and paragraph separators, the byte-order mark, zero-width and bidi controls.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** Text from a Spec, a page or a model, made safe to store and show as text: no control or invisible characters, no markdown link or image (its label stays), one line, cut to `max`. */
export function cleanVerifyText(raw: unknown, max: number = MAX_JOURNEY_TEXT): string {
  if (typeof raw !== 'string') return '';
  const noLinks = raw.replace(/!?\[([^\]\n]{0,400})\]\([^)\n]{0,2000}\)/g, '$1');
  return noLinks.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const PM_SPEC_LABEL = /^Project-manager Spec \(model text, quoted as data\):\s*$/;
const CRITERION_LINE = /^ {0,3}\d{1,3}[.)]\s+(\S.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ACCEPTANCE_HEADING = /^acceptance criteria\b/i;

interface OpenFence {
  ch: string;
  len: number;
}

/** The fence a line opens, or null. A backtick fence's info string cannot hold a backtick (that is inline code). */
function opensFence(line: string): OpenFence | null {
  const f = FENCE_OPEN.exec(line);
  if (f === null || (f[1]![0] === '`' && f[2]!.includes('`'))) return null;
  return { ch: f[1]![0]!, len: f[1]!.length };
}

/** CommonMark: a fence closes only on the same character, at least as many of it as opened the fence, and nothing else on the line. */
function closesFence(line: string, open: OpenFence): boolean {
  const m = FENCE_CLOSE.exec(line);
  return m !== null && m[1]![0] === open.ch && m[1]!.length >= open.len;
}

/** Whether an "Acceptance criteria" heading stands on `lines` outside code fences (the same fence tracking as the reading loop). */
function hasAcceptanceHeading(lines: readonly string[]): boolean {
  let open: OpenFence | null = null;
  for (const line of lines) {
    if (open !== null) {
      if (closesFence(line, open)) open = null;
      continue;
    }
    open = opensFence(line);
    if (open !== null) continue;
    const h = HEADING.exec(line);
    if (h !== null && ACCEPTANCE_HEADING.test(h[2]!)) return true;
  }
  return false;
}

/** The criteria on `lines` outside code fences; with `byHeading`, only those under an "Acceptance criteria" heading when the text has one. */
function criteriaOutsideFences(lines: readonly string[], byHeading: boolean): string[] {
  const out: string[] = [];
  const scoped = byHeading && hasAcceptanceHeading(lines);
  let level = 0; // level of the Acceptance criteria heading being read; 0 = outside it
  let open: OpenFence | null = null;
  for (const line of lines) {
    if (open !== null) {
      if (closesFence(line, open)) open = null;
      continue;
    }
    open = opensFence(line);
    if (open !== null) continue;
    const h = HEADING.exec(line);
    if (h !== null && scoped) {
      const l = h[1]!.length;
      if (ACCEPTANCE_HEADING.test(h[2]!)) level = l;
      else if (level !== 0 && l <= level) level = 0;
      continue;
    }
    if (scoped && level === 0) continue;
    const m = CRITERION_LINE.exec(line);
    if (m === null) continue;
    const text = cleanVerifyText(m[1]);
    if (text !== '') out.push(text);
    if (out.length >= MAX_CRITERIA) break;
  }
  return out;
}

/** The lines of the quoted block that follows the "Project-manager Spec" label, or null when the body has no such block. */
function quotedSpecLines(lines: readonly string[]): string[] | null {
  // The label counts only at the top level, outside every fence (a forged one inside the summary's quoted block does not).
  let label = -1;
  let fence: OpenFence | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    fence = opensFence(line);
    if (fence === null && PM_SPEC_LABEL.test(line)) {
      label = i;
      break;
    }
  }
  if (label < 0) return null;
  let at = label + 1;
  while (at < lines.length && lines[at]!.trim() === '') at++;
  const first = at < lines.length ? lines[at]! : '';
  const open = opensFence(first);
  // The pipeline's own container: seven or more backticks and the label `untrusted-<hex nonce>`.
  if (open === null || open.ch !== '`' || open.len < 7 || !/^ {0,3}`+untrusted-[0-9a-f]+\s*$/.test(first)) return null;
  const inner: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (closesFence(line, open)) break;
    inner.push(line);
  }
  return inner;
}

/**
 * The numbered list items of a Spec body, in order: `1. text` or `1) text`, at most three spaces of indent. At most MAX_CRITERIA.
 *
 * The stored Spec quotes the project-manager's text inside an untrusted fence after a "Project-manager Spec" line (pipeline plan/spec.ts). When that block is
 * there, only it is read (under its "Acceptance criteria" heading when it has one): the Consensus Summary block, the allowed-files block and any code sample
 * inside the Spec are ignored. A body without that block (an older or hand-written Spec) is read outside code fences.
 */
export function parseSpecCriteria(body: string | null | undefined): string[] {
  if (typeof body !== 'string') return [];
  const lines = body.slice(0, 400_000).replace(/\r/g, '').split('\n');
  const quoted = quotedSpecLines(lines);
  return quoted !== null ? criteriaOutsideFences(quoted, true) : criteriaOutsideFences(lines, false);
}

/** A refusal of a verify input, carrying one of the closed codes in `OWN_ERROR_CODES`. */
export class VerifyInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VerifyInputError';
    this.code = code;
  }
}

/** The standing journeys of a settings row, checked. Refuses (not trims) a bad id, a repeated id, an empty or long text, or more than MAX_STANDING. */
export function parseStandingJourneys(raw: unknown): StandingJourney[] {
  if (!Array.isArray(raw)) throw new VerifyInputError('verify_setting_invalid', 'standing journeys must be a list');
  if (raw.length > MAX_STANDING) throw new VerifyInputError('verify_setting_invalid', 'too many standing journeys');
  const seen = new Set<string>();
  return raw.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new VerifyInputError('verify_setting_invalid', 'a standing journey is {id, text}');
    const e = entry as Record<string, unknown>;
    const keys = Object.keys(e);
    if (keys.length !== 2 || !keys.includes('id') || !keys.includes('text')) throw new VerifyInputError('verify_setting_invalid', 'a standing journey is {id, text}');
    const id = e.id;
    if (typeof id !== 'string' || !STANDING_ID_RE.test(id) || seen.has(id)) throw new VerifyInputError('verify_setting_invalid', 'a standing journey needs its own plain id');
    seen.add(id);
    const text = cleanVerifyText(e.text);
    if (text === '' || typeof e.text !== 'string' || e.text.trim().length > MAX_JOURNEY_TEXT) throw new VerifyInputError('verify_setting_invalid', 'a standing journey needs a text of at most 400 characters');
    return { id, text };
  });
}

export interface DeriveJourneysInput {
  /** The body of the item's Spec version, or null when it has none. */
  specBody: string | null;
  standing: readonly StandingJourney[];
  /** Journeys an earlier row failed, to check again. A carried journey replaces the journey with the same id, or is added after the others. */
  carried?: readonly { id: string; text: string }[];
}

/** The journeys of a new row and the criteria it leaves to the checks. */
export interface JourneyPlan {
  journeys: Journey[];
  /** The 1-based numbers of the Spec criteria classified `code` (criteria.ts): not journeys; the check, the reviewers and the acceptance tester cover them. */
  checksOnly: number[];
}

/** The journeys alone (see `planJourneys`). */
export function deriveJourneys(input: DeriveJourneysInput): Journey[] {
  return planJourneys(input).journeys;
}

/**
 * The journeys of a new row, in order: the visible criteria `c<n>` (n is the criterion's number in the Spec, so a left-out criterion leaves a gap in the ids and the
 * numbers stay stable), then standing `s_<id>`, then the carried ones. Deterministic. A Spec with no visible criterion gives only the standing and carried ones.
 */
export function planJourneys(input: DeriveJourneysInput): JourneyPlan {
  const out: Journey[] = [];
  const checksOnly: number[] = [];
  for (const c of classifyCriteria(parseSpecCriteria(input.specBody))) {
    if (c.kind === 'code') checksOnly.push(c.n);
    else if (c.text !== '') out.push({ id: `c${c.n}`, source: 'criterion', text: c.text });
  }
  for (const s of input.standing.slice(0, MAX_STANDING)) {
    if (STANDING_ID_RE.test(s.id)) out.push({ id: `s_${s.id}`, source: 'standing', text: cleanVerifyText(s.text) });
  }
  for (const c of input.carried ?? []) {
    if (!JOURNEY_ID_RE.test(c.id)) continue;
    const text = cleanVerifyText(c.text);
    const at = out.findIndex((j) => j.id === c.id);
    if (at >= 0) out[at] = { id: c.id, source: 'recheck', text: text === '' ? out[at]!.text : text };
    else if (text !== '') out.push({ id: c.id, source: 'recheck', text });
  }
  return { journeys: out.filter((j) => j.text !== '').slice(0, MAX_JOURNEYS), checksOnly };
}
