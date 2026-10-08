/**
 * D#6 R2b-3e (C21 section 5): the file scope a runner's executor run may change, and the matcher that holds a pull request's
 * changed paths to it. The scope is read from our own database (`spec_versions.frontmatter.acceptance_files` of the run's spec
 * version), never from the job and never from the runner, which is the party being checked.
 *
 * Three entry forms are understood, and no others, so there is no glob library to trust (C23 section 1 adds brace groups, which are
 * expanded FIRST, so each expanded pattern must be one of these three):
 *   - an exact path:        `packages/web/src/page.ts`
 *   - everything below one directory:  `packages/web/**`   (at least one more segment; never the directory itself)
 *   - `*` inside one segment: `packages/web/src/*.ts`      (`*` matches any run of characters except `/`, including none)
 * A brace group is `{a,b,...}`: at least two alternatives, each non-empty and free of `/ { } , * ? [ ] ( )`, no nesting, and not inside
 * a `(...)` or `[...]` segment. An entry may hold several groups (the expansion is every combination, in any segment). At most
 * `MAX_ENTRY_PATTERNS` patterns come from one entry and `MAX_SCOPE_PATTERNS` from the whole list; over either, the scope is `unknown`.
 * Round and square brackets are literal characters of a path, so a Next.js route such as `app/(group)/[id]/page.tsx` is an exact path;
 * a bracket or parenthesis is accepted only as a WHOLE segment of the Next.js kind (`(name)`, `[name]`, `[...name]`, `[[...name]]`,
 * name = `[A-Za-z0-9_-]+`), compared byte for byte, never as a character class. An entry of any other shape (an unbalanced or nested
 * brace, a one-alternative group, `?`, a bracket or parenthesis anywhere else, a lone `**`, `**` anywhere but the last segment, a leading `/`, a `.` or `..`
 * segment, a backslash, a control character, an empty or over-long string) makes the WHOLE scope unreadable, never a partly
 * checked one: the answer is then `unknown`, and the caller fails the run `scope_unknown` and opens no pull request. The same goes
 * for an absent or empty list, a value that is not an array of strings, more than `MAX_SCOPE_ENTRIES` entries, and a run with no
 * spec version.
 */

export type AcceptanceScope = { kind: "known"; entries: readonly string[] } | { kind: "unknown" };

export const MAX_SCOPE_ENTRIES = 500;
export const MAX_ENTRY_PATTERNS = 64;
export const MAX_SCOPE_PATTERNS = 1024;
const MAX_ENTRY_LENGTH = 512;
const UNKNOWN: AcceptanceScope = Object.freeze({ kind: "unknown" });

/** The characters an entry may hold. A control character, a backslash or a space would be read differently by Git than by us. */
const ENTRY_CHARS = /^[A-Za-z0-9_.@+=,:*()[\]{}/-]+$/;
/** A whole segment of the Next.js kind: `(name)`, `[name]`, `[...name]`, `[[...name]]`. Any other segment holding a bracket or parenthesis is not a form we understand. */
const NEXT_SEGMENT = /^(?:\([A-Za-z0-9_-]+\)|\[[A-Za-z0-9_-]+\]|\[\.\.\.[A-Za-z0-9_-]+\]|\[\[\.\.\.[A-Za-z0-9_-]+\]\])$/;
/** What an alternative of a brace group may not hold (`{`, `}` and `,` cannot occur by construction). */
const ALTERNATIVE_FORBIDDEN = /[/*?[\]()]/;

/**
 * Expands the brace groups of one entry into every combination, or null when the entry's braces are not well formed (unclosed or
 * stray, nested, fewer than two alternatives, an empty or forbidden alternative, a group inside a `(...)` or `[...]` segment) or
 * the expansion would pass `MAX_ENTRY_PATTERNS`. An entry with no brace is its own single expansion.
 */
function expandBraces(entry: string): string[] | null {
  const literals: string[] = [""];
  const groups: string[][] = [];
  let open = 0;
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i]!;
    if (ch === "}") return null;
    if (ch !== "{") {
      literals[literals.length - 1] += ch;
      continue;
    }
    const close = entry.indexOf("}", i + 1);
    if (close < 0) return null;
    const alternatives = entry.slice(i + 1, close).split(",");
    if (alternatives.some((a) => a.includes("{"))) return null;
    if (alternatives.length < 2 || alternatives.some((a) => a.length === 0 || ALTERNATIVE_FORBIDDEN.test(a))) return null;
    // A group inside a `[...]` or `(...)` is a brace inside a Next.js segment name: never allowed.
    const before = literals.join("");
    open = (before.match(/[[(]/g)?.length ?? 0) - (before.match(/[\])]/g)?.length ?? 0);
    if (open > 0) return null;
    groups.push(alternatives);
    literals.push("");
    i = close;
  }
  let count = 1;
  for (const g of groups) {
    count *= g.length;
    if (count > MAX_ENTRY_PATTERNS) return null;
  }
  let out = [literals[0]!];
  groups.forEach((g, n) => {
    out = out.flatMap((prefix) => g.map((alt) => prefix + alt + literals[n + 1]!));
  });
  return out;
}

interface Compiled {
  segments: readonly string[];
  /** `dir/**`: everything strictly below `segments`. */
  subtree: boolean;
}

function compile(entry: string): Compiled | null {
  if (entry.length === 0 || entry.length > MAX_ENTRY_LENGTH || !ENTRY_CHARS.test(entry)) return null;
  if (entry.startsWith("/") || entry.endsWith("/")) return null;
  const segments = entry.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  if (segments.some((s) => /[[\]()]/.test(s) && !NEXT_SEGMENT.test(s))) return null;
  const subtree = segments[segments.length - 1] === "**";
  const body = subtree ? segments.slice(0, -1) : segments;
  if (subtree && body.length === 0) return null;
  // `**` anywhere but the last segment, or mixed with other characters, is a form we do not understand.
  if (body.some((s) => s.includes("**"))) return null;
  return { segments: body, subtree };
}

function segmentMatches(pattern: string, segment: string): boolean {
  if (!pattern.includes("*")) return pattern === segment;
  const parts = pattern.split("*");
  // Anchored: the first part is a prefix, the last a suffix, and the middle parts appear in order between them.
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i === 0) {
      if (!segment.startsWith(part)) return false;
      at = part.length;
    } else if (i === parts.length - 1) {
      return segment.length - part.length >= at && segment.endsWith(part);
    } else {
      const found = segment.indexOf(part, at);
      if (found < 0) return false;
      at = found + part.length;
    }
  }
  return true;
}

/** The scope a `spec_versions.frontmatter.acceptance_files` value stands for. `value` is whatever the database held. */
export function parseAcceptanceScope(value: unknown): AcceptanceScope {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_ENTRIES) return UNKNOWN;
  // `entries` holds the EXPANDED patterns, each one of the three forms, so the matcher never sees a brace.
  const entries: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_ENTRY_LENGTH || !ENTRY_CHARS.test(entry)) return UNKNOWN;
    const expanded = expandBraces(entry);
    if (expanded === null || entries.length + expanded.length > MAX_SCOPE_PATTERNS) return UNKNOWN;
    for (const pattern of expanded) {
      if (compile(pattern) === null) return UNKNOWN;
      entries.push(pattern);
    }
  }
  return { kind: "known", entries: Object.freeze(entries) };
}

/** Whether `path` (a changed file's path, as GitHub reports it) is inside the scope. An unknown scope holds nothing. */
export function pathInScope(scope: AcceptanceScope, path: string): boolean {
  if (scope.kind !== "known" || typeof path !== "string" || path.length === 0) return false;
  const parts = path.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return false;
  return scope.entries.some((entry) => {
    const c = compile(entry);
    if (c === null) return false;
    if (c.subtree ? parts.length <= c.segments.length : parts.length !== c.segments.length) return false;
    return c.segments.every((pattern, i) => segmentMatches(pattern, parts[i]!));
  });
}

/** The changed paths that fall outside the scope, in the order given. With an unknown scope, every path does. */
export function pathsOutsideScope(scope: AcceptanceScope, paths: readonly string[]): string[] {
  return paths.filter((p) => !pathInScope(scope, p));
}

/** The query a loader needs, run under the run's tenant (a `pg` client or pool client fits). */
export interface TenantQueryable {
  query<R extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Reads the scope for a run. `client` must be under the run's tenant (row-level security does the rest); the account is also in
 * the WHERE clause. A run with no spec version, a spec version that was erased, a missing row, and a value that does not parse
 * all answer `unknown`.
 */
export async function loadAcceptanceScope(client: TenantQueryable, run: { accountId: string; runId: string }): Promise<AcceptanceScope> {
  const { rows } = await client.query<{ acceptance_files: unknown }>(
    `SELECT sv.frontmatter -> 'acceptance_files' AS acceptance_files
       FROM agent_runs ar
       JOIN spec_versions sv ON sv.account_id = ar.account_id AND sv.id = ar.spec_version_id AND sv.erased_at IS NULL
      WHERE ar.account_id = $1 AND ar.id = $2`,
    [run.accountId, run.runId],
  );
  return rows.length === 1 ? parseAcceptanceScope(rows[0]!.acceptance_files) : UNKNOWN;
}
