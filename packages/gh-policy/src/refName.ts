/**
 * A conservative subset of `git check-ref-format` (see `man gitrevisions`,
 * "Ref exclusions"). It exists to catch path-traversal-shaped and otherwise
 * malformed ref names on top of the `refs/heads/fx/` prefix check — a ref
 * like `refs/heads/fx/../main` satisfies the prefix check as a plain string
 * but resolves to a completely different, non-`fx/*` ref once git actually
 * interprets it.
 *
 * Not a full reimplementation of every historical git quirk (no Unicode
 * normalization edge cases, no `refname-available` lookahead) — just the
 * structural rules that matter for a policy decision: no `..`, no `//`, no
 * `@{`, no control characters, no space/`~`/`^`/`:`/`?`/`*`/`[`/`\`, no
 * segment starting with `.` or ending in `.lock`, no leading/trailing `/`,
 * no trailing `.`, and not the bare string `@`.
 */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const FORBIDDEN_CHAR_RE = /[ ~^:?*[\\]/;

export function isValidRefName(ref: string): boolean {
  if (ref.length === 0) return false;
  if (ref.includes("..")) return false;
  if (ref.includes("//")) return false;
  if (ref.includes("@{")) return false;
  if (CONTROL_CHAR_RE.test(ref)) return false;
  if (FORBIDDEN_CHAR_RE.test(ref)) return false;
  if (ref.startsWith("/") || ref.endsWith("/")) return false;
  if (ref.endsWith(".")) return false;
  if (ref === "@") return false;

  for (const segment of ref.split("/")) {
    if (segment.length === 0) return false;
    if (segment.startsWith(".")) return false;
    if (segment.endsWith(".lock")) return false;
  }
  return true;
}
