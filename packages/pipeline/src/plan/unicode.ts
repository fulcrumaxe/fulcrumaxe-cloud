/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATE_G = new RegExp(LONE_SURROGATE.source, "g");

/** True when `s` is well-formed Unicode (no lone surrogate). */
export function isWellFormedString(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

/** `s` with every lone surrogate replaced by U+FFFD. */
export function toWellFormedString(s: string): string {
  return s.replace(LONE_SURROGATE_G, "�");
}
