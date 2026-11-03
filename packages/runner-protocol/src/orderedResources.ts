/**
 * D#519 MQ5-a: ordered resources, the pure half (moved here by D#483 S5-j2c2 so the runner computes the same check on objects it fetched itself; the
 * pipeline file re-exports it). A repository can declare files whose names carry a sort key (the migrations of this
 * repository are the first case). Before a queued pull request merges, every key it adds must be unique and sort after the highest key on the
 * default branch's tip. Nothing here reads GitHub or the database; `orderedCheck.ts` binds these functions to the reads.
 *
 * The `keyPattern` of a configuration comes from a tenant, so it is a ReDoS surface and JavaScript has no regex timeout. The bound is
 * therefore structural, and `compileKeyPattern` accepts only a small subset: anchored at the start, exactly one capture group, no
 * alternation, no back-reference, no look-around, no lazy or possessive quantifier, no quantified group that contains a quantifier, a
 * bounded repeat count, and a total cost (the product of every quantifier's reach over the longest input) under `KEY_PATTERN_COST_LIMIT`.
 * The input is the file's base name, cut off at `MAX_KEY_INPUT`: a longer name has no key. A pattern outside the subset is ignored (no
 * check, never a wrong one).
 */

export const MAX_RESOURCES = 5;
export const MAX_NAME = 40;
export const MAX_KEY_PATTERN = 120;
export const MAX_GLOB = 200;
/** Longest base name the key pattern is run on. */
export const MAX_KEY_INPUT = 256;
export const KEY_PATTERN_COST_LIMIT = 100_000;
const MAX_REPEAT = 64;
const MAX_PATH = 512;

export type KeyKind = "integer" | "text";
export type Key = number | string;

export interface ResourceRule {
  name: string;
  keyKind: KeyKind;
  /** Whether a repository path belongs to this resource. */
  matches(path: string): boolean;
  /** The key text of a path's base name, or null when the base name does not match the pattern. */
  rawKey(path: string): string | null;
  /** The accepted configuration entry this rule was compiled from (absent on the detected default): what the runner is sent to compile again. */
  spec?: { name: string; pathPattern: string; keyPattern: string; keyKind: KeyKind };
}

export interface OrderedConfig {
  /** `orderedResources` is present (valid or not): the detected default is then not used. */
  configured: boolean;
  resources: ResourceRule[];
  /** Read by MQ5-b. True unless the setting is exactly `false`. */
  autoRenumber: boolean;
}

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** The cost of a quantifier, or null when the text at `i` is not one. `end` is the index after it. */
function quantifierAt(src: string, i: number): { cost: number; end: number; fixed: boolean } | null {
  const c = src[i];
  if (c === "*" || c === "+") return { cost: MAX_KEY_INPUT, end: i + 1, fixed: false };
  if (c === "?") return { cost: 2, end: i + 1, fixed: false };
  if (c !== "{") return null;
  // Every `{` must be a well-formed quantifier, whatever the digit count: the engine reads `{1,1000}` as one, so a literal reading would skip every rule. No literal braces.
  const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i, i + 40));
  if (!m) return { cost: Infinity, end: i + 1, fixed: false };
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : m[3] === "" ? Infinity : Number(m[3]);
  const end = i + m[0].length;
  if (lo > MAX_REPEAT || (hi !== Infinity && (hi > MAX_REPEAT || hi < lo))) return { cost: Infinity, end, fixed: false };
  // `{n}` repeats exactly n times: one way to match, so it costs nothing and does not make a group "contain a quantifier".
  return { cost: hi === Infinity ? MAX_KEY_INPUT : Math.max(1, hi - lo + 1), end, fixed: m[2] === undefined };
}

/** A regular expression from a tenant's `keyPattern`, or null when it is outside the safe subset (see the header). */
export function compileKeyPattern(src: unknown): RegExp | null {
  if (typeof src !== "string" || src.length < 2 || src.length > MAX_KEY_PATTERN || src[0] !== "^") return null;
  let captures = 0;
  let cost = 1;
  const open: Array<{ quantified: boolean }> = [];
  let closed: { quantified: boolean } | null = null; // the group the previous token closed
  let atom = false; // the previous token can take a quantifier
  for (let i = 1; i < src.length; ) {
    const c = src[i]!;
    const q = quantifierAt(src, i);
    if (q) {
      if (!atom || closed?.quantified) return null; // nothing to repeat, or a quantified group that contains a quantifier
      cost *= q.cost;
      if (cost > KEY_PATTERN_COST_LIMIT) return null;
      if (open.length > 0 && !q.fixed) open[open.length - 1]!.quantified = true;
      if (src[q.end] === "?" || src[q.end] === "+") return null; // lazy or possessive
      closed = null;
      atom = false;
      i = q.end;
      continue;
    }
    closed = null;
    atom = true;
    if (c === "|") return null;
    if (c === "\\") {
      if (i + 1 >= src.length || /[1-9kpPu]/.test(src[i + 1]!)) return null; // back-reference, property or unicode escape
      i += 2;
    } else if (c === "[") {
      let j = i + 1;
      while (j < src.length && src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return null;
      i = j + 1;
    } else if (c === "(") {
      if (src[i + 1] === "?") {
        if (src[i + 2] !== ":") return null; // look-around or a named group
        i += 3;
      } else {
        captures += 1;
        i += 1;
      }
      open.push({ quantified: false });
      atom = false;
    } else if (c === ")") {
      const g = open.pop();
      if (!g) return null;
      if (g.quantified && open.length > 0) open[open.length - 1]!.quantified = true;
      closed = g;
      i += 1;
    } else {
      if (c === "}") return null;
      if (c === "^") atom = false;
      i += 1;
    }
  }
  if (open.length > 0 || captures !== 1) return null;
  try {
    const re = new RegExp(src);
    // The engine must read the pattern the way this scan did: the same number of capture groups.
    return new RegExp(`${src}|`).exec("")!.length - 1 === captures ? re : null;
  } catch {
    // fx-swallow-ok: the engine refusing the pattern is the answer "pattern refused" (null, so no check): it fails closed and there is nothing to report
    return null;
  }
}

/** One path segment against a segment glob (`*`, `?`): the iterative greedy matcher, linear in the product of nothing worse than the two lengths with a single retreat point. */
function segmentMatch(p: string, s: string): boolean {
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) [pi, si] = [pi + 1, si + 1];
    else if (pi < p.length && p[pi] === "*") [star, mark, pi] = [pi, si, pi + 1];
    else if (star >= 0) [pi, si, mark] = [star + 1, mark + 1, mark + 1];
    else return false;
  }
  while (pi < p.length && p[pi] === "*") pi += 1;
  return pi === p.length;
}

/**
 * A glob as a matcher that never backtracks exponentially or polynomially (not a regular expression): `*` and `?` stay inside one segment, a segment that is exactly `**` takes
 * any number of whole segments, and `**` inside a longer segment is refused. At most 4 wildcard characters, a path of at most 512 characters.
 */
export function compileGlob(glob: unknown): ((path: string) => boolean) | null {
  if (typeof glob !== "string" || glob.length < 1 || glob.length > MAX_GLOB || glob.startsWith("/") || (glob.match(/[*?]/g)?.length ?? 0) > 4) return null;
  const gs = glob.split("/");
  if (gs.some((g) => g.includes("**") && g !== "**")) return null;
  return (path) => {
    if (path.length > MAX_PATH) return false;
    const ps = path.split("/");
    const seen = new Set<number>();
    const go = (g: number, p: number): boolean => {
      if (g === gs.length) return p === ps.length;
      if (seen.has(g * 1024 + p)) return false;
      seen.add(g * 1024 + p);
      if (gs[g] === "**") {
        for (let k = p; k <= ps.length; k++) if (go(g + 1, k)) return true;
        return false;
      }
      return p < ps.length && segmentMatch(gs[g]!, ps[p]!) && go(g + 1, p + 1);
    };
    return go(0, 0);
  };
}

function toRule(e: unknown): ResourceRule | null {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return null;
  const { name, pathPattern, keyPattern, keyKind } = e as Record<string, unknown>;
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(name) || name.length > MAX_NAME) return null;
  if (keyKind !== "integer" && keyKind !== "text") return null;
  const glob = compileGlob(pathPattern);
  const key = compileKeyPattern(keyPattern);
  if (!glob || !key) return null;
  return { name, keyKind, matches: glob, rawKey: (p) => keyOf(key, p), spec: { name, pathPattern: pathPattern as string, keyPattern: keyPattern as string, keyKind } };
}

function keyOf(re: RegExp, path: string): string | null {
  const base = baseName(path);
  if (base.length > MAX_KEY_INPUT) return null;
  const m = re.exec(base);
  return m?.[1] !== undefined && m[1] !== "" ? m[1] : null;
}

/** The typed reader for `repos.settings`. An entry that fails validation is dropped whole; entries after the fifth are ignored. */
export function readOrderedConfig(settings: unknown): OrderedConfig {
  const s = settings !== null && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
  const autoRenumber = s.autoRenumber !== false;
  if (!("orderedResources" in s)) return { configured: false, resources: [], autoRenumber };
  const list = Array.isArray(s.orderedResources) ? s.orderedResources.slice(0, MAX_RESOURCES) : [];
  const resources: ResourceRule[] = [];
  for (const e of list) {
    const r = toRule(e);
    if (r && !resources.some((x) => x.name === r.name)) resources.push(r);
  }
  return { configured: true, resources, autoRenumber };
}

/** The detected default: the directory with the most `NNNN_*.sql` files (at least two) is the resource `migrations`, keyed on the four-digit prefix. Null when none. */
export function detectResource(paths: readonly string[]): ResourceRule | null {
  const counts = new Map<string, number>();
  for (const p of paths) if (/^\d{4}_.+\.sql$/.test(baseName(p))) counts.set(dirName(p), (counts.get(dirName(p)) ?? 0) + 1);
  const best = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  if (!best) return null;
  const dir = best[0];
  return { name: "migrations", keyKind: "integer", matches: (p) => dirName(p) === dir, rawKey: (p) => /^(\d{4})_.+\.sql$/.exec(baseName(p))?.[1] ?? null };
}

/** A key as a sortable value, or null when it does not parse as its kind. */
export function parseKey(raw: string | null, kind: KeyKind): Key | null {
  if (raw === null || raw === "") return null;
  if (kind === "text") return raw.length <= 100 ? raw : null;
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

export type OrderVerdict = { ok: true } | { ok: false; key: string; highest: string };

/**
 * Every added key must be unique within the pull request and strictly greater than the highest key on the tip. A path of the resource that has no
 * parseable key is not ordered. `highest` is null when the tip has no file of the resource. Answers the first offending key, as the text it had in its name.
 */
export function checkOrdering(rule: ResourceRule, added: readonly string[], tipPaths: readonly string[]): OrderVerdict {
  let highest: Key | null = null;
  let highestRaw = "none";
  for (const p of tipPaths) {
    if (!rule.matches(p)) continue;
    const raw = rule.rawKey(p);
    const k = parseKey(raw, rule.keyKind);
    if (k !== null && (highest === null || k > highest)) [highest, highestRaw] = [k, raw!];
  }
  const seen = new Set<Key>();
  for (const p of added) {
    if (!rule.matches(p)) continue;
    const raw = rule.rawKey(p);
    const k = parseKey(raw, rule.keyKind);
    const label = raw ?? baseName(p).slice(0, 40);
    if (k === null || seen.has(k) || (highest !== null && k <= highest)) return { ok: false, key: label, highest: highestRaw };
    seen.add(k);
  }
  return { ok: true };
}

/**
 * D#483 S5-j2c1: the configuration as a runner is sent it (`PlaneMergeOrderedConfig`): only what `readOrderedConfig` accepted, at most five resources, and nothing else of `repos.settings`
 * (not `autoRenumber`, not any other key).
 */
export function orderedConfigWire(settings: unknown): { configured: boolean; resources: Array<{ name: string; path_pattern: string; key_pattern: string; key_kind: KeyKind }> } {
  const config = readOrderedConfig(settings);
  const resources = config.resources.flatMap((r) => (r.spec ? [{ name: r.spec.name, path_pattern: r.spec.pathPattern, key_pattern: r.spec.keyPattern, key_kind: r.spec.keyKind }] : []));
  return { configured: config.configured, resources };
}

/** A code as the merge queue's facts and the runner's ordering fact write it: `<prefix>_<value>` in lower case, anything outside `[a-z0-9_]` turned into `_`, at most 64 characters. */
export function orderedCode(prefix: string, v: string): string {
  return `${prefix}_${v.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`.slice(0, 64);
}
