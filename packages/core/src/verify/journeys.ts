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

/** The numbered list items of a Spec body, in order, outside code fences: `1. text` or `1) text`, at most three spaces of indent. At most MAX_CRITERIA. */
export function parseSpecCriteria(body: string | null | undefined): string[] {
  if (typeof body !== 'string') return [];
  const out: string[] = [];
  let fenced = false;
  for (const line of body.slice(0, 400_000).split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^ {0,3}\d{1,3}[.)]\s+(\S.*)$/.exec(line);
    if (m === null) continue;
    const text = cleanVerifyText(m[1]);
    if (text !== '') out.push(text);
    if (out.length >= MAX_CRITERIA) break;
  }
  return out;
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

/** The journeys of a new row, in order: criteria `c1..`, then standing `s_<id>`, then the carried ones. Deterministic; an empty Spec gives only the standing and carried ones. */
export function deriveJourneys(input: DeriveJourneysInput): Journey[] {
  const out: Journey[] = [];
  parseSpecCriteria(input.specBody).forEach((text, i) => out.push({ id: `c${i + 1}`, source: 'criterion', text }));
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
  return out.filter((j) => j.text !== '').slice(0, MAX_JOURNEYS);
}
