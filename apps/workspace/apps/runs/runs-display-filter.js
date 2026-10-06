// D#37 WS-F2a: the display filter. Every string taken from run data passes
// through it before it is shown. Stored events are never changed (audit): only
// what the window draws is rewritten.
//
// The product name shown is "Claude" (allowed); the two-word tool name is not.
// The pattern is the one the runtime gate spec asserts, plus the literal
// "&nbsp;" entity (a model can write it in text; U+00A0 is already \s).
// Invisible characters inside the name are skipped; confusables are out of scope.

const CH = "\u200b\u200c\u200d\u2060\ufeff\u00ad";
const word = (w) => [...w].join("[" + CH + "]*");
const HEAD = word("claude") + "(?:[\\s_\\-. " + CH + "]|&nbsp;)*";
const TOOL_NAME = new RegExp(HEAD + word("code"), "gi");
const TOOL_TAIL = new RegExp(HEAD + "$", "i");

/** Text safe to draw: any spelling of the two-word tool name becomes "Claude". */
export function displayText(value) {
  if (value == null) return "";
  return String(value).replace(TOOL_NAME, "Claude");
}

/** True when the text would still trip the runtime gate (a last check on rendered output). */
export function hasToolName(value) {
  const s = String(value);
  return displayText(s) !== s;
}

// Items read joined by a line break; carry = trailing "Claude" drawn so far.
export const crossesBoundary = (carry, text) => carry !== "" && hasToolName(carry + "\n" + text);
export const nextCarry = (carry, text) => TOOL_TAIL.exec(carry + "\n" + text)?.[0] ?? "";
