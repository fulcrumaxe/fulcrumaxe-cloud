/**
 * D#600 CX-5b / CX-5c: how a run's excluded paths become permission rules. The one copy: the cloud's sandbox runner (`@fx/runner`) re-exports these, and the local
 * runner (`@fulcrumaxe/fx-runner`, which may import nothing but this package) imports them, so both sides write the same rules and count refusals the same way.
 * Pure functions of their inputs: no file, no clock, no environment.
 */

/** The most excluded paths one run's settings carry. More is refused (the launch fails), never cut: a cut list would let a path through. */
export const MAX_EXCLUDE_RULES = 500;

/** The longest excluded path, in characters (the database's own limit). */
export const MAX_EXCLUDE_PATH_CHARS = 512;

/**
 * D#600 CX-5b: the one prompt line that tells the agent about excluded paths. It goes in once, and only when the run has excludes. It is a context control and
 * says so; the settings are what refuse the reads.
 */
export const EXCLUDE_PROMPT_LINE =
  "Some paths in this repository are kept out of your context by the person who owns this work. Reading them is refused and the Grep and Glob tools are turned off; do not try to get around it. This is a context control, not a security boundary.";

/**
 * True when the path can be written as a permission rule: not empty, at most 512 characters, no control character or backslash, not absolute (a leading `/` or
 * `~`), and no empty, `.` or `..` segment. The database refuses such paths at save time; the job schema, the launch and the settings writer each check again.
 */
export function isRuleablePath(path: string): boolean {
  return !(path === "" || [...path].length > MAX_EXCLUDE_PATH_CHARS || /[\p{Cc}\\]/u.test(path) || path.startsWith("/") || path.startsWith("~") || path.split("/").some((seg) => seg === "" || seg === "." || seg === ".."));
}

/**
 * Escapes one path for a `Read(...)` rule. Two layers: the ignore-file pattern syntax the CLI matches a rule's path with, then the rule syntax's own.
 *  - "glob" (an exclude, which keeps full glob syntax): `* ? [ab] **` and `{}` keep their meaning. Only what would change it unasked is escaped: a leading
 *    `!` (negation) or `#` (comment), a trailing space (dropped), and `(` `)` (the rule syntax's delimiters, not glob characters).
 *  - "literal" (a pinned path or any exact path): `[ ] { }` are escaped too, so `app/[id]/page.tsx` means exactly that file. A literal holds no `*` or `?`.
 * The second layer doubles the backslashes the first wrote and escapes `(` `)`.
 */
export function escapeRulePath(path: string, mode: "glob" | "literal" = "glob"): string {
  const marks = mode === "literal" ? path.replace(/[[\]{}]/g, "\\$&") : path;
  const first = marks.replace(/^[!#]/, "\\$&").replace(/ $/, "\\ ");
  return first.replace(/\\/g, "\\\\").replace(/[()]/g, "\\$&");
}

/** The tools the settings turn off outright for a run with these excludes (bare `Grep` and `Glob`, which cannot be limited to a path); the capture counts their "No such tool" answers as refusals. */
export function disabledToolsFor(excludes: readonly string[] | undefined): Array<"Grep" | "Glob"> {
  return excludes !== undefined && excludes.length > 0 ? ["Grep", "Glob"] : [];
}

/**
 * The deny entries for a run's excluded paths: `Read(<path>)` and `Read(<path>/**)` for each (a glob stays a glob), and bare `Grep` and `Glob` once, because
 * those two tools cannot be limited to a path. Sorted, so the same rules give the same bytes. Fails closed: a path that cannot be written as a rule or more
 * than MAX_EXCLUDE_RULES paths throws, so the launch fails rather than starts with a rule missing.
 */
export function excludeDenyRules(excludes: readonly string[], mode: "glob" | "literal" = "glob"): string[] {
  const paths = [...new Set(excludes)].sort();
  if (paths.length === 0) return [];
  if (paths.length > MAX_EXCLUDE_RULES) throw new Error("agentSettingsFor: too many excluded paths");
  const rules: string[] = [];
  for (const p of paths) {
    if (!isRuleablePath(p)) throw new Error("agentSettingsFor: an excluded path cannot be written as a permission rule");
    const e = escapeRulePath(p, mode);
    rules.push(`Read(${e})`, `Read(${e}/**)`);
  }
  return [...rules, "Grep", "Glob"];
}
