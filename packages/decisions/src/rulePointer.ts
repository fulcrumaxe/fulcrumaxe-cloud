/**
 * A bounded JSON Pointer (RFC 6901) for action rules (D#7 AAP-a1). `parsePointer` decodes the escapes (`~1` to `/`, then `~0` to `~`, in that
 * order) and refuses a malformed one. `resolvePointer` walks own properties and array indexes only, so `__proto__` or `constructor` never
 * resolve, and it never throws: a path to nothing is `{ found: false }`.
 */
export type Resolved = { readonly found: true; readonly value: unknown } | { readonly found: false };

const NOT_FOUND: Resolved = { found: false };
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/** The decoded reference tokens, or `null` when the text is not a valid pointer. The empty string is the whole document (no tokens). */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === "") return [];
  if (pointer[0] !== "/") return null;
  const tokens: string[] = [];
  for (const raw of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(raw)) return null;
    tokens.push(raw.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  return tokens;
}

export function resolvePointer(document: unknown, tokens: readonly string[]): Resolved {
  let current: unknown = document;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(token) || Number(token) >= current.length) return NOT_FOUND;
      current = current[Number(token)];
    } else if (typeof current === "object" && current !== null) {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return NOT_FOUND;
      current = (current as Record<string, unknown>)[token];
    } else {
      return NOT_FOUND;
    }
  }
  return { found: true, value: current };
}
