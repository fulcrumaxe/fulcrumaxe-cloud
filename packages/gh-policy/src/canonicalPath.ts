/**
 * Every literal (non-percent-encoded) character a path segment may contain.
 * A strict ALLOWLIST, not a denylist of known-bad characters: an allowlist
 * fails closed on any byte nobody has thought of yet, instead of needing a
 * new denylist entry every time someone finds one more bypass. Excludes
 * `/` (the separator, checked per-segment already) and `;` (an old-style
 * path-parameter delimiter some frameworks still special-case).
 */
const SEGMENT_CHARSET_RE = /^[A-Za-z0-9._~!$&'()*+,=:@%-]+$/;

/**
 * Byte values a `%XX` escape may decode to. Deliberately an ALLOWLIST of
 * printable-ASCII, non-unreserved, non-separator bytes, built by exclusion
 * rather than enumeration so every rule below is a documented reason a byte
 * is missing, not a byte anyone forgot to list:
 *
 *   - `< 0x21` (space and every control char) or `>= 0x7F` (DEL and every
 *     non-ASCII byte, including every byte of an overlong or multi-byte
 *     UTF-8 sequence — an homoglyph dot, an overlong-encoded `.`, all of it)
 *     — never a valid escape target here.
 *   - `0x25` (`%`) — accepting this would let `%2520` etc. decode to a
 *     *second* percent-escape on a later pass; this engine never decodes
 *     more than once, so the fix is to never accept the character that
 *     would need a second pass at all.
 *   - `0x2F` (`/`) and `0x5C` (`\`) — encoded separators; a decoded `/`
 *     inside what looks like one segment is a second segment in disguise.
 *   - `0x3B` (`;`) — the same path-parameter delimiter excluded above,
 *     just spelled with its escape instead of the literal character.
 *   - `0x23` (`#`) and `0x3F` (`?`) — [fix round 3, item W4] the two
 *     characters that split a URL into path/query/fragment. Both are
 *     already rejected LITERALLY by `isCanonicalPath` below, but before
 *     this fix their percent-encoded spellings (`%23`, `%3F`) sailed
 *     straight through: they aren't unreserved, aren't `/`/`\`/`;`, and
 *     aren't `%`, so nothing else on this list caught them. Anything that
 *     later decodes this path (a real HTTP client, a browser, a proxy)
 *     would read a decoded `%3F` exactly like a literal `?` — reopening the
 *     query-string-smuggling case the literal check exists to close.
 *   - RFC 3986 §2.3 unreserved characters (`A-Z a-z 0-9 - . _ ~`) — RFC
 *     3986 §6.2.2.2 says a normalizer SHOULD decode these back to their
 *     literal form because encoding them changes nothing semantically;
 *     this engine instead REJECTS the encoded spelling outright, because
 *     accepting `%6D` as "just an m" and then matching `merge` against a
 *     STRING containing `%6derge` are two different acts, and only the
 *     first is what a real HTTP client's normalization would agree with.
 */
function isForbiddenEscapeByte(byte: number): boolean {
  if (byte < 0x21 || byte >= 0x7f) return true; // control/space/DEL/non-ASCII
  if (byte === 0x25) return true; // '%' — double-encoding
  if (byte === 0x2f || byte === 0x5c || byte === 0x3b) return true; // '/' '\' ';'
  if (byte === 0x23 || byte === 0x3f) return true; // '#' '?' — URL-splitting bytes
  if (byte >= 0x41 && byte <= 0x5a) return true; // A-Z
  if (byte >= 0x61 && byte <= 0x7a) return true; // a-z
  if (byte >= 0x30 && byte <= 0x39) return true; // 0-9
  if (byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e) return true; // - . _ ~
  return false;
}

/**
 * True when every `%XX` escape in `segment` is well-formed (exactly two hex
 * digits) AND decodes to a byte this engine actually allows encoded (see
 * `isForbiddenEscapeByte`). Assumes `segment` already passed
 * `SEGMENT_CHARSET_RE`, so every literal character is already known-safe —
 * this function only has to walk the `%` occurrences.
 */
function hasOnlyAllowedEscapes(segment: string): boolean {
  let i = 0;
  while (i < segment.length) {
    if (segment[i] !== "%") {
      i += 1;
      continue;
    }
    const hex = segment.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return false;
    const byte = parseInt(hex, 16);
    if (isForbiddenEscapeByte(byte)) return false;
    i += 3;
  }
  return true;
}

/**
 * True only when `path` is already in its one canonical form.
 *
 * `decide()` judges the path exactly as written — it never decodes or
 * normalizes anything. That is deliberate: `fetch` (or any real HTTP
 * client) DOES normalize `.`/`..`/`//` segments (and decode percent-escapes)
 * before it makes the actual request, so a path this function approved and
 * a path the real request ends up hitting must be provably identical, or
 * the policy engine is judging a request that was never actually made.
 * Rejecting every non-canonical spelling — rather than normalizing and
 * re-judging — is what keeps that identity: nothing here ever gets a
 * "fixed up" second look.
 *
 * Rejects:
 *   - a path not starting with `/`
 *   - an embedded `?` or `#` (the query/fragment must arrive out-of-band,
 *     never smuggled into the path string itself)
 *   - a backslash anywhere
 *   - a trailing slash (other than the path `/` itself)
 *   - any `.` or `..` segment, or any empty segment (a `//`)
 *   - any segment containing a character outside `SEGMENT_CHARSET_RE` —
 *     which includes every control character, space, DEL, every non-ASCII
 *     character (a raw UTF-8 multi-byte homoglyph or overlong sequence
 *     included), and `;`
 *   - any `%XX` escape that is malformed, or that decodes to a byte
 *     `isForbiddenEscapeByte` rejects (control/space/DEL/non-ASCII, `%`,
 *     `/`, `\`, `;`, `#`, `?`, or an RFC 3986 unreserved character)
 *
 * Deliberately does NOT enforce keyword casing (e.g. requiring a literal
 * "merge" over "MERGE") here — [fix round 3, suggestion] that check used to
 * live in this file and over-denied real content: a repo file literally
 * named `Keys`, a branch literally named `Refs`, or any other user-chosen
 * name that happens to collide with an API keyword's spelling was rejected
 * outright, even in positions where no keyword was ever expected (a file
 * path segment under `/contents/...`, a branch name under `/branches/...`).
 * This module has no notion of "position" — it validates every path as a
 * flat sequence of segments, so it can't tell a keyword position from a
 * content position, and guessing wrong is exactly the over-denial that
 * happened. The actual fix lives where it belongs: every regex in
 * `pathTarget.ts`, `mergeProtection.ts` and `decide.ts` that recognizes a
 * keyword (`merge`, `pulls`, `labels`, `info/refs`, ...) is already
 * case-sensitive by construction (none use the `i` flag), and — as of fix
 * round 3's item E3 — every WRITE decision routes through an explicitly
 * enumerated, fully-anchored regex rather than a case-blind prefix
 * catch-all. A wrong-case spelling of a real keyword therefore simply
 * matches no allow-rule anywhere and falls through to this engine's
 * default deny, at the specific decision point that actually knows what
 * position that segment is in — never a blanket, position-blind rejection
 * in here.
 */
export function isCanonicalPath(path: string): boolean {
  if (path.length === 0 || path[0] !== "/") return false;
  if (path.includes("?") || path.includes("#")) return false;
  if (path.includes("\\")) return false;
  if (path.length > 1 && path.endsWith("/")) return false;

  const segments = path.split("/").slice(1);
  for (const segment of segments) {
    if (segment === "") return false;
    if (segment === "." || segment === "..") return false;
    if (!SEGMENT_CHARSET_RE.test(segment)) return false;
    if (!hasOnlyAllowedEscapes(segment)) return false;
  }
  return true;
}
