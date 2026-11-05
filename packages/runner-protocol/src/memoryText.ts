/**
 * What memory text may hold that a person cannot see. One definition, used by the runner (which refuses such text) and by the cloud (which removes it), so the two never
 * disagree about what a person reading the Undo list or the Memory screen is looking at.
 *
 * Hidden: control, format (bidi marks, zero-width, soft hyphen, tags), private-use and surrogate code points, line and paragraph separators, every variation
 * selector, the Khmer inherent vowels and Mongolian free variation selectors, the unassigned default-ignorable ranges, and the characters that draw as blanks (Hangul
 * fillers, the braille blank, the combining grapheme joiner). Unassigned code points elsewhere are NOT hidden: a new emoji this runtime does not know yet is real text.
 * Every Default_Ignorable_Code_Point is in this class (a test walks the property), so a newer Unicode adds nothing silently.
 *
 * Kept where the text needs them, and only there: a zero-width non-joiner between two letters of a script that spells with it (Persian and the Indic scripts), a zero-width
 * joiner after a letter or virama of those scripts (a Malayalam chillu ends a word with one) or between two pictographs, the emoji and text variation selectors after a pictograph, and the emoji variation selector of a
 * keycap (a digit, `#` or `*`, the selector, then U+20E3). A joiner between Latin letters is not kept: it is what splits a word so a filter misses it.
 */
const JOINING_SCRIPTS = "\\p{scx=Arab}\\p{scx=Deva}\\p{scx=Beng}\\p{scx=Guru}\\p{scx=Gujr}\\p{scx=Orya}\\p{scx=Taml}\\p{scx=Telu}\\p{scx=Knda}\\p{scx=Mlym}\\p{scx=Sinh}";
const PICTOGRAPH = "[\\p{Extended_Pictographic}\\p{Emoji_Modifier}]";
/** The inside of a character class: every code point a person cannot see. */
export const MEMORY_HIDDEN_CLASS = "\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}\\u2028\\u2029\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180d\\u180f\\u2065\\u2800\\u3164\\ufe00-\\ufe0f\\uffa0\\ufff0-\\ufff8\\u{e0000}-\\u{e0fff}";
/** A hidden character in one of the places above, where it does visible work. Needs the `u` flag. */
export const MEMORY_KEPT_JOINER =
  `(?<=${PICTOGRAPH})[\\ufe0e\\ufe0f]|(?<=[0-9#*])\\ufe0f(?=\\u20e3)|(?<=[${JOINING_SCRIPTS}])\\u200c(?=[${JOINING_SCRIPTS}])`
  + `|(?<=[${JOINING_SCRIPTS}])\\u200d|(?<=${PICTOGRAPH}\\ufe0f?)\\u200d(?=${PICTOGRAPH})`;

const CONTROL = /^\p{Cc}$/u;
const KEPT_OR_HIDDEN = new RegExp(`(${MEMORY_KEPT_JOINER})|[${MEMORY_HIDDEN_CLASS}]`, "gu");

/**
 * Removes every hidden character except the kept joiners, and except control characters, which the caller handles itself (the cloud turns them into spaces and keeps line
 * breaks and tabs; the runner refuses them). Judged on the original text in one pass; idempotent, since a kept joiner's neighbours are never removed.
 */
export function removeHiddenMemoryChars(text: string): string {
  return text.replace(KEPT_OR_HIDDEN, (m: string, kept: string | undefined) => (kept === undefined && !CONTROL.test(m) ? "" : m));
}
