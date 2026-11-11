/**
 * #751: generated and companion files that a Spec's file list can leave out although the repository's own generators and guards require them to change with a listed file. A repository
 * names them in one versioned table of rules (data: a JSON file the repository keeps, `{ "version": 1, "rules": [...] }`); this module reads such a table and holds the matching, and
 * nothing here runs a command or names a repository's paths. It is shared by the Spec writer (which adds the files to the list it publishes), the local runner (which reads the table from the
 * default branch, never from the run's branch, and tests the paths a run changed before it spends a check on them) and the cloud's `done` check (which holds the finished pull request to the
 * Spec's list).
 *
 * Two kinds of rule:
 *   - `generated`: the outputs are rebuilt byte for byte by `generators` (argument vectors, never shell strings, run in order). Such a file counts as in scope at the guards ONLY when some
 *     changed input is itself in scope AND the runner found the file equal to a fresh run of the generators on the result and said so on `done` (`check.derived_fresh`, see
 *     `pathsOutsideScopeFresh`). A hand-edited or stale output stays out of scope, and so does every output nobody vouched for (an older runner, a job without a check).
 *   - `companion`: files a hand-maintained registry or inventory needs beside an input. No generator can vouch for them, so the guards never widen for them; only the Spec writer lists them.
 * `inputs` use the entry forms of `acceptanceScope.ts`; `outputs` are exact paths.
 */
import { parseAcceptanceScope, pathInScope, pathsOutsideScope, type AcceptanceScope } from "./acceptanceScope.js";

export const DERIVED_FILE_RULES_VERSION = 1;
export const MAX_DERIVED_RULES = 32;
const MAX_RULE_OUTPUTS = 8;
const MAX_GENERATORS = 4;
const MAX_ARGV = 12;
const ARG = /^[\x21-\x7e]{1,80}$/;
const RULE_ID = /^[a-z][a-z0-9-]{0,39}$/;

export interface DerivedFileRule {
  readonly id: string;
  readonly kind: "generated" | "companion";
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** `generated` only: argument vectors, in the order they must run (a later one may read an earlier one's output). */
  readonly generators?: readonly (readonly string[])[];
}

/** An exact path: no wildcard, brace or bracket, so an output names one file and a vouching for it can be compared as a string. */
const EXACT_PATH = /^[A-Za-z0-9_.@+=:-]+(?:\/[A-Za-z0-9_.@+=:-]+)*$/;

const isStrings = (v: unknown, min: number, max: number): v is string[] => Array.isArray(v) && v.length >= min && v.length <= max && v.every((s) => typeof s === "string");

/**
 * The rules of a table as the repository keeps it (`value` is parsed JSON, untrusted), or null when ANY part of it is not exactly the shape below: the version is not the one this build reads,
 * a field is missing or extra, an id repeats, an input list does not parse as a known scope, an output is not an exact path (or is not alone: no two rules share one), a `generated` rule has
 * no generator or a `companion` rule has one, or a count is over its cap. Never a partly read table.
 */
export function parseDerivedFileRules(value: unknown): DerivedFileRule[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const table = value as Record<string, unknown>;
  if (Object.keys(table).some((k) => k !== "version" && k !== "rules") || table.version !== DERIVED_FILE_RULES_VERSION) return null;
  const rules = table.rules;
  if (!Array.isArray(rules) || rules.length > MAX_DERIVED_RULES) return null;
  const ids = new Set<string>();
  const outputs = new Set<string>();
  const out: DerivedFileRule[] = [];
  for (const raw of rules as unknown[]) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).some((k) => !["id", "kind", "inputs", "outputs", "generators"].includes(k))) return null;
    if (typeof r.id !== "string" || !RULE_ID.test(r.id) || ids.has(r.id) || (r.kind !== "generated" && r.kind !== "companion")) return null;
    if (!isStrings(r.inputs, 1, 8) || parseAcceptanceScope(r.inputs).kind !== "known") return null;
    if (!isStrings(r.outputs, 1, MAX_RULE_OUTPUTS) || r.outputs.some((o) => !EXACT_PATH.test(o) || outputs.has(o)) || new Set(r.outputs).size !== r.outputs.length) return null;
    let generators: string[][] | undefined;
    if (r.generators !== undefined) {
      if (!Array.isArray(r.generators) || r.generators.length > MAX_GENERATORS || r.generators.some((g) => !isStrings(g, 1, MAX_ARGV) || g.some((a) => !ARG.test(a)))) return null;
      generators = r.generators as string[][];
    }
    if ((r.kind === "generated") !== (generators !== undefined && generators.length > 0)) return null;
    ids.add(r.id);
    for (const o of r.outputs) outputs.add(o);
    out.push({ id: r.id, kind: r.kind, inputs: r.inputs, outputs: r.outputs, ...(generators === undefined ? {} : { generators }) });
  }
  return out;
}

/** A rule is active when a changed path is one of its inputs and is itself in scope: the Spec already allows the change that makes the outputs move. */
function active(rule: DerivedFileRule, scope: AcceptanceScope, changed: readonly string[]): boolean {
  const inputs = parseAcceptanceScope([...rule.inputs]);
  return changed.some((p) => pathInScope(inputs, p) && pathInScope(scope, p));
}

/**
 * Of `outside` (changed paths the scope does not hold), the ones that are outputs of an ACTIVE generated rule: the only files whose freshness can lift them into scope.
 * `rules` are the active generated rules that have at least one such output, in table order (the order their generators must run in).
 */
export function derivedCandidates(table: readonly DerivedFileRule[], scope: AcceptanceScope, changed: readonly string[], outside: readonly string[]): { rules: DerivedFileRule[]; paths: string[] } {
  if (scope.kind !== "known") return { rules: [], paths: [] };
  const rules = table.filter((r) => r.kind === "generated" && r.outputs.some((o) => outside.includes(o)) && active(r, scope, changed));
  const outputs = new Set(rules.flatMap((r) => [...r.outputs]));
  return { rules, paths: outside.filter((p) => outputs.has(p)) };
}

/**
 * `pathsOutsideScope`, except that a changed generated output counts as in scope when its rule is active AND `fresh` (what the runner vouched for) names it. With an empty `fresh`
 * this is exactly `pathsOutsideScope`.
 */
export function pathsOutsideScopeFresh(table: readonly DerivedFileRule[], scope: AcceptanceScope, paths: readonly string[], fresh: readonly string[]): string[] {
  const outside = pathsOutsideScope(scope, paths);
  if (fresh.length === 0 || outside.length === 0) return outside;
  const lifted = new Set(derivedCandidates(table, scope, paths, outside).paths.filter((p) => fresh.includes(p)));
  return outside.filter((p) => !lifted.has(p));
}

/** The paths a `done` check may vouch for: an array of distinct generated outputs of the table. Anything else is no vouching at all (never a partial read). */
export function readDerivedFresh(table: readonly DerivedFileRule[], value: unknown): string[] {
  const known = new Set(table.filter((r) => r.kind === "generated").flatMap((r) => [...r.outputs]));
  if (!Array.isArray(value) || value.length === 0 || value.length > known.size) return [];
  const seen = new Set<string>();
  for (const item of value as unknown[]) {
    if (typeof item !== "string" || !known.has(item) || seen.has(item)) return [];
    seen.add(item);
  }
  return [...seen];
}

/** A concrete path an expanded scope pattern stands for, enough to test it against another scope. */
const sampleOf = (pattern: string): string => pattern.replace(/\*\*$/, "x").replace(/\*/g, "x");

/**
 * The Spec writer's step: `entries` plus the outputs of every rule one of them touches (an entry is an input, or holds one), minus what the list already holds. Order kept, additions last,
 * no repeat. A list the parser cannot read, or one the additions would make unreadable (too many patterns), comes back unchanged: the caller's own validation then decides.
 */
export function withDerivedFiles(table: readonly DerivedFileRule[], entries: readonly string[]): string[] {
  const own = parseAcceptanceScope([...entries]);
  if (own.kind !== "known") return [...entries];
  const added: string[] = [];
  for (const rule of table) {
    const inputs = parseAcceptanceScope([...rule.inputs]);
    const touched = own.entries.some((e) => pathInScope(inputs, sampleOf(e))) || rule.inputs.some((i) => pathInScope(own, sampleOf(i)));
    if (!touched) continue;
    for (const out of rule.outputs) if (!pathInScope(own, out) && !added.includes(out)) added.push(out);
  }
  if (added.length === 0) return [...entries];
  const widened = [...entries, ...added];
  return parseAcceptanceScope(widened).kind === "known" ? widened : [...entries];
}
