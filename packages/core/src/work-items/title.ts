/** Longest title a work item shows (code points). A GitHub issue title may be 256 long; a card line is shorter. */
export const WORK_ITEM_TITLE_MAX = 120;

/** Control characters, the line/paragraph separators, zero-width and bidi marks, and the byte-order mark. */
function isInvisible(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * The one-line title of a work item, from a GitHub issue title: untrusted text. Invisible and control characters
 * (including newlines and tabs) become spaces, runs of whitespace collapse, the ends are trimmed, and the result is
 * cut to WORK_ITEM_TITLE_MAX code points (a surrogate pair is never split). Null when nothing printable is left, so
 * "no title" is always null, never an empty string.
 */
export function cleanWorkItemTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let out = '';
  for (const ch of raw) out += isInvisible(ch.codePointAt(0)!) ? ' ' : ch;
  const flat = out.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  const points = Array.from(flat);
  return (points.length > WORK_ITEM_TITLE_MAX ? points.slice(0, WORK_ITEM_TITLE_MAX).join('').trimEnd() : flat) || null;
}
