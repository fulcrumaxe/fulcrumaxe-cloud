/**
 * The pre-push scan for a paired public repo. A pure module: it decides whether a
 * commit may be pushed, from the changed paths and blobs of that commit as git
 * stores them (see `planePushGit.ts` for the reader over a real repository). It
 * reads no working tree, runs no command and writes nothing.
 *
 * Fail closed. A public branch is readable the moment it lands, and a check that
 * runs after the push is too late, so every doubt below is a refusal:
 *   - the overlay path list is required and must be well formed;
 *   - a path that is on the list, malformed, a submodule, binary, or over 8 MB
 *     refuses (none of those can be scanned or may ship);
 *   - a rule file the pairing declares that is missing, unreadable or unparseable
 *     refuses. With no rule file declared only the always-on refusals above run,
 *     and `scans` says so, so a settings page can state it in words;
 *   - a reader that throws, or a commit that changes nothing, refuses.
 * A refusal names a place (path, line) and a rule key (an identifier rule's
 * ordinal, a plan-data key path). It never carries the matched text. File names
 * are scanned with the identifier rules too (for a path the commit adds); a name
 * that matches is never echoed, it is named "changed path #N" by its position in
 * the change list.
 *
 * Known limit (recorded decision, parity with the engine scan): the scan is per
 * line, so a secret or identifier split across two added lines (or built by
 * concatenation) is not caught. Closing it would need a multi-line rule grammar
 * the engine rules file does not have.
 *
 * Rule translation is exact or refused. An extended regex is translated to
 * JavaScript (always with the `u` flag, so `.` and a negated class consume one
 * whole character, astral ones included) only from forms with an identical
 * meaning (see `ereToJs`); GNU word anchors (`\\<` `\\>`), other escapes, `{,n}`,
 * stacked quantifiers and every locale-dependent POSIX class refuse the rule file
 * as `rule_file_invalid`, because a translation that matches less than grep -E
 * would turn a refusal into a pass. Supported forms, and only these: literals,
 * `.`, `^` `$`, groups, `|`, `* + ?`, `{n}` `{n,}` `{n,m}` (n, m <= 1000), bracket
 * expressions of literals and code-point ranges, and the POSIX classes
 * `[:digit:]` and `[:xdigit:]` (the same set in every locale). `[:alpha:]`,
 * `[:alnum:]`, `[:upper:]`, `[:lower:]`, `[:punct:]`, `[:space:]` and `[:blank:]`
 * are refused: grep defines them by the host locale, no Unicode property escape
 * equals them, and either guess would be looser than grep somewhere (spell the
 * set out, e.g. `A-Za-z0-9_`). A rule that is not NFKC-stable also refuses.
 *
 * Names and text are matched as written, NFKC-normalised, and NFKC-normalised with
 * every dash folded to a hyphen (NFKC leaves U+2010 alone), and any hit
 * refuses: fullwidth, U+2010 and decomposed (NFD) spellings of an identifier
 * are caught. Size and binary checks use the original bytes.
 *
 * File names are an allowlist: valid UTF-8 (the reader sets `nameInvalid`), only
 * letters, marks, numbers, punctuation, symbols and the ASCII space, no quote,
 * backslash or control character, no `.git` segment. Two changed entries whose
 * names are equal after NFC normalisation refuse. Blob reads are keyed by the
 * entry's index in the change list, never by the decoded name.
 *
 * Identity. The source may report the exact commit it scanned (`scanned()`); the
 * result then carries it as `scanned`. Whoever pushes (the push step, P1c) MUST
 * assert `result.ok` and push exactly `result.scanned.commit`, and refuse when it
 * is absent: nothing else ties the scan to the object that is sent.
 *
 * Identifier rules use the grammar of the engine's rules file: marker lines
 * `=== FORBIDDEN_PATTERNS_START ===` / `_END`, one extended regex per line, `#`
 * comments, plus the optional PREPUSH_EXEMPT and PATH_EXEMPT blocks. Not ported,
 * and refused or stricter rather than looser: IDENTITIES `{TOKEN}` substitution
 * (an unresolved token refuses) and the ALLOWLIST block (ignored, so it can only
 * add refusals). Plan data is a JSON file whose numeric leaves are the figures
 * to keep private; the key-and-value, `$N`, `N USD`, `N/mo`, cents and bare
 * literal detections are ported, the plan-name proximity and API field-name
 * aliases of the engine script are not.
 */

export const MAX_SCAN_BYTES = 8_000_000;
const MAX_LISTED = 100;

export type RefusalKind =
  | "overlay_list_invalid"
  | "no_changes"
  | "overlay_path"
  | "malformed_path"
  | "submodule"
  | "binary_file"
  | "file_too_large"
  | "rule_file_missing"
  | "rule_file_invalid"
  | "identifier_hit"
  | "plan_data_hit"
  | "bad_identity"
  | "bad_ancestry"
  | "scan_failed";

/** Thrown by a source that must refuse with a named reason rather than fail the scan. */
export class SourceRefusal extends Error {
  constructor(
    readonly kind: "bad_identity" | "bad_ancestry",
    message: string,
  ) {
    super(message);
  }
}

export interface Refusal {
  kind: RefusalKind;
  message: string;
  path?: string;
  line?: number;
  /** The rule that fired: `identifier-rule#N`, or a plan-data key path. Never the matched text. */
  rule?: string;
}

/** One path the commit changes over its parent, as git reports it. */
export interface ChangedPath {
  path: string;
  /** True when the raw name is not valid UTF-8; `path` is then only a placeholder and the entry refuses. */
  nameInvalid?: boolean;
  /** New mode, e.g. "100644"; "000000" when the commit deletes the path. */
  mode: string;
  deleted: boolean;
  /** True when the path already exists at the diff base. */
  existedAtBase: boolean;
  binary: boolean;
  /** Blob size in bytes at the commit. */
  size: number;
  /** 1-based line numbers in the new file that the commit adds. */
  addedLines: readonly number[];
}

export interface PlanePushSource {
  changes(): Promise<ChangedPath[]>;
  /** The blob of entry `index` of the list `changes()` returned. Called only for a text path no larger than MAX_SCAN_BYTES. */
  readBlob(index: number): Promise<Uint8Array>;
  /** The exact commit and base the changes were read from, once `changes()` has returned. */
  scanned?(): { commit: string; base: string } | undefined;
}

export interface PlanePushInput {
  /** Overlay (private) paths: `dir/` is a prefix, `*` `**` `?` are shell-case globs (`*` and `?` cross `/`), anything else is an exact path. Brackets are rejected. Required, non-empty. */
  overlay: readonly string[];
  /** Repo paths of the rule files the pairing declares. A declared file must be readable and valid. */
  ruleFiles?: { identifierRules?: string; planData?: string };
  /** Reads a declared rule file from the private repo; null means it does not exist there. */
  readRuleFile(path: string): Promise<Uint8Array | null>;
  source: PlanePushSource;
}

export interface PlanePushResult {
  ok: boolean;
  /** At most 100 are listed; `omitted` counts the rest. */
  refusals: Refusal[];
  omitted: number;
  /** The commit that was scanned. A pusher must push exactly this id. Absent when the source does not report one. */
  scanned?: { commit: string; base: string };
  scans: { identifierRules: "applied" | "not_declared"; planData: "applied" | "not_declared"; files: number; addedLines: number };
}

// ---------------------------------------------------------------------------
// Paths

/** A reason the path cannot be trusted or scanned, or null when it is well formed. */
const PRINTABLE_NAME = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;

export function malformedPathReason(p: string): string | null {
  if (p === "" || p.startsWith("/") || p.endsWith("/")) return "empty or absolute path";
  if (/[\u0000-\u001f\u007f"\\]/.test(p)) return "a quote, backslash or control character";
  if (!PRINTABLE_NAME.test(p)) return "a character outside the printable-name allowlist";
  const segments = p.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "an empty, '.' or '..' segment";
  if (segments.some((s) => s.toLowerCase() === ".git")) return "a .git segment";
  return null;
}

function normalizePath(p: string): string {
  return p.normalize("NFC").toLowerCase();
}

// Glob semantics are those of a shell `case` pattern, which is what the publish
// denylist uses: a star matches any run of characters including a slash, `?`
// matches any one character including a slash, and a double star is the same as
// one (a double star followed by a slash may also match no directory). That is
// the stricter reading (a `*.local` entry also covers `d/x.local`), so a path the
// denylist would hold back is never let through here. Bracket expressions are not
// supported and are rejected with an error (see `compileOverlay`).
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*") {
      while (glob.charAt(i + 1) === "*") i++;
      // `**/` also matches no directory at all (stricter than the shell, which needs the slash).
      if (glob.charAt(i + 1) === "/" && glob.slice(0, i + 1).endsWith("**")) {
        i++;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (c === "?") out += ".";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "s");
}

/** Compiles the overlay list, or returns why it cannot be used. Matching is case- and normalisation-insensitive: stricter, never looser. */
export function compileOverlay(entries: readonly string[]): { match: (path: string) => boolean } | { error: string } {
  if (entries.length === 0) return { error: "the overlay path list is empty; it is required" };
  const tests: Array<(p: string) => boolean> = [];
  for (const raw of entries) {
    const entry = normalizePath(raw);
    const bare = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (/[[\]]/.test(entry)) return { error: "the overlay path list has an entry with a bracket expression, which is not supported; use * and ? only" };
    if (entry.trim() !== entry || bare === "" || entry.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(entry) || bare.split("/").some((s) => s === "" || s === "." || s === "..")) {
      return { error: "the overlay path list has a malformed entry" };
    }
    if (entry.endsWith("/")) tests.push((p) => p.startsWith(entry));
    else if (/[*?]/.test(entry)) {
      const rx = globToRegExp(entry);
      tests.push((p) => rx.test(p));
    } else tests.push((p) => p === entry);
  }
  return { match: (path) => tests.some((t) => t(normalizePath(path))) };
}

// ---------------------------------------------------------------------------
// Identifier rules

export interface IdentifierRule {
  key: string;
  rx: RegExp;
  /** Path prefixes under which this rule is off, for a file that already exists at the base. */
  exemptUnder: string[];
}

/** The POSIX classes that mean the same set in every locale. The others are locale-defined and refused. */
const POSIX_CLASSES: Record<string, string> = { digit: "0-9", xdigit: "0-9A-Fa-f" };

/** The backslash escapes that mean the same literal character to grep -E and to JavaScript. */
const EXACT_ESCAPES = ".[]\\()*+?{}|^$/";
const MAX_REPEAT = 1000;

/**
 * Translates an extended regex into the JavaScript one that matches exactly the
 * same lines, or throws. Only forms with an exact translation pass: literals,
 * `.`, anchors, groups, alternation, `* + ?`, `{n}` `{n,}` `{n,m}`, bracket
 * expressions with the POSIX classes in POSIX_CLASSES, and the escapes in EXACT_ESCAPES.
 * Refused, because JavaScript reads them differently (or locale-dependently):
 * `\<` `\>` `\b` `\B` `\w` `\W` `\s` `\S` `\'` and `\`` (GNU word and buffer
 * anchors), back-references, any other escape, `{,n}` (a literal in JavaScript),
 * a stray `{` or `}`, `(?`, and stacked quantifiers (`a+?` is lazy in JavaScript).
 */
function ereToJs(ere: string): string {
  let out = "";
  let atom = false; // an atom precedes, so a quantifier has something to repeat
  let quantified = false;
  let depth = 0;
  for (let i = 0; i < ere.length; i++) {
    const c = ere.charAt(i);
    if (c === "\\") {
      const next = ere.charAt(i + 1);
      if (next === "" || !(EXACT_ESCAPES.includes(next) || next === "-")) throw new Error("escape without an exact translation");
      out += next === "-" ? "-" : c + next; // a hyphen escaped is a plain hyphen to grep, and an error to the u flag
      i++;
      atom = true;
      quantified = false;
    } else if (c === "[") {
      let j = i + 1;
      let cls = "[";
      if (ere.charAt(j) === "^") (cls += "^"), j++;
      if (ere.charAt(j) === "]") (cls += "\\]"), j++;
      for (; j < ere.length && ere.charAt(j) !== "]"; j++) {
        const d = ere.charAt(j);
        if (d === "[" && (ere.charAt(j + 1) === ":" || ere.charAt(j + 1) === "=" || ere.charAt(j + 1) === ".")) {
          const end = ere.indexOf(`${ere.charAt(j + 1)}]`, j + 2);
          const name = end < 0 ? "" : ere.slice(j + 2, end);
          const mapped = ere.charAt(j + 1) === ":" ? POSIX_CLASSES[name] : undefined;
          if (mapped === undefined) throw new Error("unsupported bracket class");
          cls += mapped;
          j = end + 1;
        } else cls += d === "[" || d === "\\" ? `\\${d}` : d;
      }
      if (j >= ere.length) throw new Error("unterminated bracket expression");
      out += `${cls}]`;
      i = j;
      atom = true;
      quantified = false;
    } else if (c === "*" || c === "+" || c === "?") {
      // A quantifier on a quantifier ("a+?", "a**") is lazy or an error in JavaScript and a repetition in ERE.
      if (!atom || quantified) throw new Error("quantifier without an atom or after a quantifier");
      out += c;
      quantified = true;
    } else if (c === "{") {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(ere.slice(i));
      if (!m || !atom || quantified) throw new Error("unsupported interval expression");
      const lo = Number(m[1]);
      const hi = m[2] === undefined ? lo : m[3] === "" ? Infinity : Number(m[3]);
      if (lo > MAX_REPEAT || (hi !== Infinity && hi > MAX_REPEAT) || hi < lo) throw new Error("interval out of range");
      out += m[0];
      i += m[0].length - 1;
      quantified = true;
    } else if (c === "}") throw new Error("unmatched }");
    else if (c === "(") {
      if (ere.charAt(i + 1) === "?") throw new Error("(? is JavaScript group syntax");
      depth++;
      out += c;
      atom = false;
      quantified = false;
    } else if (c === ")") {
      if (depth === 0) throw new Error("unmatched )");
      depth--;
      out += c;
      atom = true;
      quantified = false;
    } else if (c === "|" || c === "^" || c === "$") {
      out += c;
      atom = false;
      quantified = false;
    } else {
      out += c;
      atom = true;
      quantified = false;
    }
  }
  if (depth !== 0) throw new Error("unmatched (");
  return out;
}

function block(lines: string[], section: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (t === `=== ${section}_START ===`) inside = true;
    else if (t === `=== ${section}_END ===`) inside = false;
    else if (inside && t !== "" && !t.startsWith("#")) out.push(t);
  }
  return out;
}

export interface IdentifierRuleSet {
  rules: IdentifierRule[];
}

export function parseIdentifierRules(text: string): IdentifierRuleSet | { error: string } {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const declared = block(lines, "FORBIDDEN_PATTERNS");
  const prepushExempt = new Set<string>();
  const pathExempt = new Map<string, string[]>();
  for (const t of block(lines, "PREPUSH_EXEMPT")) {
    const [pattern, reason] = t.split("\t");
    if (!pattern || !reason?.trim() || !declared.includes(pattern)) return { error: "a PREPUSH_EXEMPT entry is malformed or names no declared pattern" };
    prepushExempt.add(pattern);
  }
  for (const t of block(lines, "PATH_EXEMPT")) {
    const [pattern, prefix, reason, extra] = t.split("\t");
    if (!pattern || !prefix || !reason?.trim() || extra !== undefined || !declared.includes(pattern) || !prefix.endsWith("/") || malformedPathReason(prefix.slice(0, -1)) !== null) {
      return { error: "a PATH_EXEMPT entry is malformed or names no declared pattern" };
    }
    pathExempt.set(pattern, [...(pathExempt.get(pattern) ?? []), prefix]);
  }
  const rules: IdentifierRule[] = [];
  for (const [i, pattern] of declared.entries()) {
    const key = `identifier-rule#${i + 1}`;
    if (/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(pattern)) return { error: `${key} has an unresolved {TOKEN}` };
    let rx: RegExp;
    try {
      if (pattern !== pattern.normalize("NFKC")) return { error: `${key} is not NFKC-stable, so it could never match normalised text` };
      rx = new RegExp(ereToJs(pattern), "su");
    } catch {
      return { error: `${key} is not a valid extended regular expression` };
    }
    if (rx.test("")) return { error: `${key} matches an empty line` };
    if (!prepushExempt.has(pattern)) rules.push({ key, rx, exemptUnder: pathExempt.get(pattern) ?? [] });
  }
  if (rules.length === 0) return { error: "no enforceable forbidden pattern; a scan that checks nothing is refused" };
  return { rules };
}

// ---------------------------------------------------------------------------
// Plan data

export interface PlanData {
  /** Key-and-value patterns: a figure written next to its own key. */
  keyed: Array<{ path: string; key: string; rx: RegExp }>;
  byValue: Map<number, string>;
}

const num = (n: number): string => String(n);
const escapeRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parsePlanData(text: string): PlanData | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "the plan-data file is not valid JSON" };
  }
  const leaves: Array<{ path: string; key: string; n: number }> = [];
  const walk = (node: unknown, path: string[]): void => {
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, [...path, String(i)]));
    else if (node !== null && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    else if (typeof node === "number" && node !== 0 && Number.isFinite(node) && path.length > 0) {
      const last = path[path.length - 1] as string;
      leaves.push({ path: path.join("."), key: /^\d+$/.test(last) && path.length > 1 ? (path[path.length - 2] as string) : last, n: node });
    }
  };
  walk(data, []);
  if (leaves.length === 0) return { error: "the plan-data file has no numeric figures to protect" };
  const byValue = new Map<number, string>();
  const keyed = leaves.map(({ path, key, n }) => {
    if (!byValue.has(n)) byValue.set(n, path);
    const body = escapeRx(num(n)) + (Number.isInteger(n) ? "(?:\\.0+)?" : "");
    return { path, key, rx: new RegExp(`(?<![A-Za-z0-9_])["'\`]?${escapeRx(key)}["'\`]?\\s*[:=]\\s*["'\`]?${body}(?![0-9A-Za-z_]|\\.[0-9])`, "g") };
  });
  return { keyed, byValue };
}

const TOKEN = /(?<![\w.#])(\d[\d_]*(?:,\d{3})*(?:\.\d+)?)(?![\w]|\.\d)/g;
const MONEY_AFTER = /^\s*(?:USD\b|usd\b|\/mo\b|\/month\b|per month\b|cents\b)/;
const CENTS_AFTER = /^\s*cents\b/;
const SQL_CUE = /\b(?:VALUES|WHERE|SET|SELECT|INSERT|UPDATE|ON CONFLICT|RETURNING)\b|::\w|\$\d+\s*,\s*\$\d|[=<>]\s*\$\d|\$\d+\s*(?:,|\)|\s*$)/;
const COMMENT_START = /^\s*(?:\/\/|\/\*|\*|#|--)/;

function significantDigits(v: number): number {
  return Number.isInteger(v) ? String(v).replace(/0+$/, "").length || 1 : String(v).replace(".", "").replace(/^0+/, "").length;
}
const decimalPlaces = (v: number): number => String(v).split(".")[1]?.length ?? 0;

/** Key paths whose figure this line states as a bare literal, in money form, or in cents. Never the figure. */
function textualHits(line: string, plan: PlanData): string[] {
  const found: string[] = [];
  for (const m of line.matchAll(TOKEN)) {
    const text = m[1] as string;
    const v = Number(text.replace(/[_,]/g, ""));
    const start = m.index ?? 0;
    const after = line.slice(start + text.length);
    const hit = plan.byValue.get(v);
    if (hit !== undefined) {
      const decimal = !Number.isInteger(v);
      if ((decimal && decimalPlaces(v) >= 3) || (!decimal && significantDigits(v) >= 4)) found.push(hit);
      else if (MONEY_AFTER.test(after) && v >= 5) found.push(hit);
      else if (line.charAt(start - 1) === "$" && v >= 5 && (decimal || text.includes(",") || COMMENT_START.test(line) || /(?:^|\s)\/\//.test(line.slice(0, start)) || !SQL_CUE.test(line))) found.push(hit);
    }
    const cents = plan.byValue.get(v / 100);
    if (v >= 100 && cents !== undefined && CENTS_AFTER.test(after)) found.push(cents);
  }
  return found;
}

// ---------------------------------------------------------------------------
// The scan

function place(label: string): string {
  return label.length > 200 ? `${label.slice(0, 200)}...` : label;
}

/**
 * True when the rule matches the text as written, NFKC-normalised, or NFKC-normalised
 * with every dash (Unicode Pd, and U+2212) folded to an ASCII hyphen. NFKC leaves
 * U+2010 and the other dashes alone, so without the fold a rule written with `-`
 * would miss them. Normalising can also split a match (a letter plus a combining
 * mark), so the text as written is tried too.
 */
function ruleHits(rx: RegExp, text: string): boolean {
  const nfkc = text.normalize("NFKC");
  return rx.test(text) || rx.test(nfkc) || rx.test(nfkc.replace(/[\p{Pd}−]/gu, "-"));
}

/** Scans every line of free text (a PR title, a body, a commit message) with the same rules. Hits are named `label:line`. */
export function scanText(
  label: string,
  text: string,
  rules: { identifierRules?: IdentifierRuleSet; planData?: PlanData },
): Refusal[] {
  const out: Refusal[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    for (const r of rules.identifierRules?.rules ?? []) {
      if (ruleHits(r.rx, line) || ruleHits(r.rx, raw)) out.push({ kind: "identifier_hit", path: label, line: i + 1, rule: r.key, message: `${label}:${i + 1} matches ${r.key}` });
    }
    if (rules.planData) {
      for (const kp of new Set(textualHits(line, rules.planData))) out.push({ kind: "plan_data_hit", path: label, line: i + 1, rule: kp, message: `${label}:${i + 1} states plan figure ${kp}` });
    }
  });
  return out;
}

const decoder = new TextDecoder("utf-8");

export async function scanPlanePush(input: PlanePushInput): Promise<PlanePushResult> {
  const all: Refusal[] = [];
  const scans: PlanePushResult["scans"] = { identifierRules: "not_declared", planData: "not_declared", files: 0, addedLines: 0 };
  let scanned: PlanePushResult["scanned"];
  const finish = (): PlanePushResult => ({ ok: all.length === 0, refusals: all.slice(0, MAX_LISTED), omitted: Math.max(0, all.length - MAX_LISTED), ...(scanned ? { scanned } : {}), scans });
  const refuse = (r: Refusal): void => void all.push(r);

  const overlay = compileOverlay(input.overlay);
  if ("error" in overlay) {
    refuse({ kind: "overlay_list_invalid", message: overlay.error });
    return finish();
  }

  try {
    let identifier: IdentifierRuleSet | undefined;
    let plan: PlanData | undefined;
    const declared = [
      ["identifierRules", input.ruleFiles?.identifierRules],
      ["planData", input.ruleFiles?.planData],
    ] as const;
    for (const [which, path] of declared) {
      if (path === undefined) continue;
      const bytes = await input.readRuleFile(path);
      if (bytes === null) {
        refuse({ kind: "rule_file_missing", path, message: `the declared rule file ${path} is missing` });
        continue;
      }
      const text = decoder.decode(bytes);
      if (which === "identifierRules") {
        const parsed = parseIdentifierRules(text);
        if ("error" in parsed) refuse({ kind: "rule_file_invalid", path, message: `the declared rule file ${path} is unusable: ${parsed.error}` });
        else (identifier = parsed), (scans.identifierRules = "applied");
      } else {
        const parsed = parsePlanData(text);
        if ("error" in parsed) refuse({ kind: "rule_file_invalid", path, message: `the declared rule file ${path} is unusable: ${parsed.error}` });
        else (plan = parsed), (scans.planData = "applied");
      }
    }

    const changes = await input.source.changes();
    scanned = input.source.scanned?.();
    if (changes.length === 0) refuse({ kind: "no_changes", message: "the commit changes nothing; a scan that covered nothing is refused" });
    // Two entries whose names are one name once normalised cannot both be told apart downstream: refuse the later ones.
    const firstWith = new Map<string, number>();
    const collides = new Set<number>();
    for (const [ordinal, c] of changes.entries()) {
      if (c.nameInvalid) continue;
      const key = c.path.normalize("NFC");
      if (firstWith.has(key)) collides.add(ordinal);
      else firstWith.set(key, ordinal);
    }
    for (const [ordinal, c] of changes.entries()) {
      if (c.nameInvalid) {
        refuse({ kind: "malformed_path", path: `changed path #${ordinal + 1}`, message: `changed path #${ordinal + 1} has a name that is not valid UTF-8` });
        continue;
      }
      if (collides.has(ordinal)) refuse({ kind: "malformed_path", path: `changed path #${ordinal + 1}`, message: `changed path #${ordinal + 1} has the same name as another changed path after normalisation` });
      // A name that matches an identifier rule is never echoed: the file is named by its ordinal in the change list.
      const nameRule = identifier?.rules.find((r) => ruleHits(r.rx, c.path));
      const shown = nameRule || collides.has(ordinal) ? `changed path #${ordinal + 1}` : c.path;
      if (nameRule && !c.deleted && !c.existedAtBase) {
        refuse({ kind: "identifier_hit", path: shown, rule: nameRule.key, message: `${shown} has a name that matches ${nameRule.key}` });
        continue;
      }
      const bad = malformedPathReason(c.path);
      if (bad !== null) {
        refuse({ kind: "malformed_path", path: shown === c.path ? place(JSON.stringify(c.path).replace(/[^\x20-\x7e]/gu, (ch) => `\\u{${ch.codePointAt(0)?.toString(16)}}`)) : shown, message: `a changed path has ${bad}` });
        continue;
      }
      if (overlay.match(c.path)) {
        refuse({ kind: "overlay_path", path: shown, message: `${shown} is an overlay (private) path` });
        continue;
      }
      if (c.deleted) continue;
      if (c.mode === "160000") {
        refuse({ kind: "submodule", path: shown, message: `${shown} is a submodule and cannot be scanned` });
        continue;
      }
      if (c.size > MAX_SCAN_BYTES) {
        refuse({ kind: "file_too_large", path: shown, message: `${shown} is over ${MAX_SCAN_BYTES} bytes and cannot be scanned` });
        continue;
      }
      if (c.binary) {
        refuse({ kind: "binary_file", path: shown, message: `${shown} is a binary file and cannot be scanned` });
        continue;
      }
      const blob = await input.source.readBlob(ordinal);
      if (blob.includes(0)) {
        refuse({ kind: "binary_file", path: shown, message: `${shown} is a binary file and cannot be scanned` });
        continue;
      }
      scans.files++;
      scans.addedLines += c.addedLines.length;
      const text = decoder.decode(blob);
      const rawLines = text.split("\n");
      const lines = rawLines.map((l) => l.replace(/\r$/, ""));
      const added = new Set(c.addedLines);
      for (const r of identifier?.rules ?? []) {
        if (c.existedAtBase && r.exemptUnder.some((u) => c.path.startsWith(u))) continue;
        for (const n of added) {
          if (ruleHits(r.rx, lines[n - 1] ?? "") || ruleHits(r.rx, rawLines[n - 1] ?? "")) refuse({ kind: "identifier_hit", path: shown, line: n, rule: r.key, message: `${shown}:${n} matches ${r.key}` });
        }
      }
      if (plan) {
        const seen = new Set<string>();
        const hit = (n: number, kp: string): void => {
          if (!seen.has(`${n}\0${kp}`)) {
            seen.add(`${n}\0${kp}`);
            refuse({ kind: "plan_data_hit", path: shown, line: n, rule: kp, message: `${shown}:${n} states plan figure ${kp}` });
          }
        };
        for (const k of plan.keyed) {
          if (!text.includes(k.key)) continue;
          for (const m of text.matchAll(k.rx)) {
            const first = text.slice(0, m.index).split("\n").length;
            const last = first + (m[0].split("\n").length - 1);
            if (added.has(first)) hit(first, k.path);
            else if (added.has(last)) hit(last, k.path);
          }
        }
        if (c.path.split("/").pop() !== "pnpm-lock.yaml") {
          for (const n of [...added].sort((a, b) => a - b)) for (const kp of textualHits(lines[n - 1] ?? "", plan)) hit(n, kp);
        }
      }
    }
  } catch (err) {
    // A reader that throws must never read as a clean scan.
    if (err instanceof SourceRefusal) refuse({ kind: err.kind, message: err.message });
    else refuse({ kind: "scan_failed", message: `the scan could not complete: ${place(err instanceof Error ? err.message.split("\n")[0] ?? "" : "unknown error")}` });
  }
  return finish();
}
