/**
 * Changed-files routing (`--changed-from <base>..<head>`). A union, never first-match: each changed file
 * selects every pack whose `paths` glob matches it, and every (file, pack, glob) match is recorded.
 *
 * Safety contract:
 *  - Routing only ADDS packs; `select()` unions the result with the tier and the named packs.
 *  - It never selects a `full` pack (those are reached only by `--tier full` or by name).
 *  - Anything it cannot judge falls back to every pack at or below `standard`, never to fewer packs: a changed
 *    file no pack claims (unless the ledger exempts it), a file only a full pack claims, a git error, an
 *    unresolvable commit, a shallow clone, an unreadable ledger or classifier.
 *  - The two refs are validated before any git command is built from them, and git is run with an argument
 *    list (no shell).
 */
import { execFileSync } from "node:child_process";
import { loadAffected, type Affected } from "./affected.js";
import { loadLedger, type Ledger } from "./ledger.js";
import { TIERS, type Pack, type Tier } from "./manifest.js";

/** Routing's ceiling: it never reaches past this tier. */
export const ROUTING_MAX_TIER: Tier = "standard";

export class RouteRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteRangeError";
  }
}

export interface RouteMatch {
  pack: string;
  glob: string;
  /** False when the pack is above the routing ceiling: the match is recorded but selects nothing. */
  selected: boolean;
}

export type RouteDisposition = "claimed" | "ignored" | "ledger" | "fallback-standard";

export interface RouteRecord {
  file: string;
  disposition: RouteDisposition;
  /** Every (pack, glob) that matched, selected or not. */
  matches: RouteMatch[];
  /** Packs this file selects, in id order. */
  selects: string[];
  /** For `ignored`: the ignore glob. For `ledger`: the entry's reason. For `fallback-standard`: why. */
  note: string | null;
}

export interface RoutingResult {
  /** The validated `<base>..<head>` as given. */
  changed_from: string;
  files: RouteRecord[];
  /** Pack ids routing adds to the selection, sorted. */
  packs: string[];
  /** Set when the whole routing step fell back (git or setup trouble); null when every file was judged. */
  fallback: string | null;
}

const tierRank = (t: Tier): number => TIERS.indexOf(t);

/** Every pack at or below the routing ceiling. */
export function fallbackPackIds(packs: Pack[]): string[] {
  return packs
    .filter((p) => tierRank(p.tier) <= tierRank(ROUTING_MAX_TIER))
    .map((p) => p.id)
    .sort();
}

export interface RouteInput {
  files: string[];
  packs: Pack[];
  ledger: Ledger;
  affected: Affected;
}

/** Pure: decides, per changed file, which packs it selects. */
export function routePaths(input: RouteInput): { files: RouteRecord[]; packs: string[] } {
  const { packs, ledger, affected } = input;
  const compile = (g: string): RegExp => affected.globToRegExp(g);
  const packGlobs = packs.map((p) => ({ pack: p, globs: p.paths.map((g) => ({ glob: g, re: compile(g) })) }));
  const ignore = affected.ignoreGlobs.map((g) => ({ glob: g, re: compile(g) }));
  const exempt = ledger.entries.map((e) => ({ ...e, re: compile(e.glob) }));
  const standardIds = fallbackPackIds(packs);

  const records: RouteRecord[] = [];
  const all = new Set<string>();
  for (const file of [...new Set(input.files)].sort()) {
    const matches: RouteMatch[] = [];
    for (const { pack, globs } of packGlobs) {
      for (const { glob, re } of globs) {
        if (re.test(file)) matches.push({ pack: pack.id, glob, selected: tierRank(pack.tier) <= tierRank(ROUTING_MAX_TIER) });
      }
    }
    const selects = [...new Set(matches.filter((m) => m.selected).map((m) => m.pack))].sort();
    let record: RouteRecord;
    if (selects.length > 0) {
      // A pack's own claim wins over the ignore list and the ledger: routing may only add.
      record = { file, disposition: "claimed", matches, selects, note: null };
    } else {
      const ignored = ignore.find((i) => i.re.test(file));
      const ledgered = exempt.find((e) => e.re.test(file));
      if (matches.length === 0 && ignored) {
        record = { file, disposition: "ignored", matches, selects: [], note: ignored.glob };
      } else if (matches.length === 0 && ledgered) {
        record = { file, disposition: "ledger", matches, selects: [], note: ledgered.reason };
      } else {
        const why = matches.length === 0 ? "no pack claims this path" : "only a full-tier pack claims this path";
        record = { file, disposition: "fallback-standard", matches, selects: standardIds, note: why };
      }
    }
    for (const id of record.selects) all.add(id);
    records.push(record);
  }
  return { files: records, packs: [...all].sort() };
}

/**
 * Reconcile the ledger with the tree: an entry that matches no tracked file is stale, and one that matches a
 * file some pack now claims is no longer needed. Returns one problem per offending entry (empty when clean).
 */
export function reconcileLedger(ledger: Ledger, trackedFiles: string[], packs: Pack[], affected: Affected): string[] {
  const problems: string[] = [];
  const claims = packs.flatMap((p) => p.paths.map((g) => ({ pack: p.id, glob: g, re: affected.globToRegExp(g) })));
  for (const entry of ledger.entries) {
    const re = affected.globToRegExp(entry.glob);
    const hit = trackedFiles.filter((f) => re.test(f));
    if (hit.length === 0) {
      problems.push(`${entry.glob}: matches no tracked file (remove the entry)`);
      continue;
    }
    for (const file of hit) {
      const claim = claims.find((c) => c.re.test(file));
      if (claim) problems.push(`${entry.glob}: ${file} is now claimed by pack ${claim.pack} (${claim.glob}); remove or narrow the entry`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------
// The git side.

const HEX_REF = /^[0-9a-f]{7,64}$/;
const NAME_REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

/** A ref is a hex commit id or a conservative ref name; nothing else ever reaches git. */
export function isSafeRef(ref: string): boolean {
  if (HEX_REF.test(ref)) return true;
  if (!NAME_REF.test(ref)) return false;
  return !(ref.includes("..") || ref.includes("//") || ref.includes("/.") || ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock"));
}

/** Parses `<base>..<head>`; throws on anything that is not exactly two safe refs. */
export function parseRange(value: string): { base: string; head: string } {
  const parts = value.split("..");
  if (parts.length !== 2) throw new RouteRangeError(`--changed-from must be <base>..<head> (got "${value.slice(0, 80)}")`);
  const [base, head] = parts as [string, string];
  for (const [what, ref] of [["base", base], ["head", head]] as const) {
    if (!isSafeRef(ref)) throw new RouteRangeError(`--changed-from ${what} is not a valid commit id or ref name`);
  }
  return { base, head };
}

export type GitRun = (args: string[]) => string;

const GIT_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "GIT_EXEC_PATH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"] as const;

function realGit(repoRoot: string): GitRun {
  // Only the variables git needs, named one by one: a hook or wrapper that exported GIT_DIR (or anything
  // else) must not redirect these reads to another repository, and nothing else in the environment is
  // handed to the child.
  const env: NodeJS.ProcessEnv = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return (args) =>
    execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export type ChangedFiles = { ok: true; files: string[] } | { ok: false; reason: string };

/** The files that differ between two commits, or the reason they cannot be trusted. */
export function changedFiles(repoRoot: string, range: { base: string; head: string }, git: GitRun = realGit(repoRoot)): ChangedFiles {
  const firstLine = (e: unknown): string => String(e instanceof Error ? e.message : e).split("\n")[0] ?? "";
  try {
    if (git(["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
      return { ok: false, reason: "shallow clone: the history needed for the diff cannot be trusted" };
    }
  } catch (err) {
    return { ok: false, reason: `git unavailable or not a repository (${firstLine(err)})` };
  }
  const resolved: string[] = [];
  for (const ref of [range.base, range.head]) {
    try {
      const sha = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).trim();
      if (!HEX_REF.test(sha)) throw new Error("did not resolve to a commit id");
      resolved.push(sha);
    } catch {
      return { ok: false, reason: `cannot resolve ${ref} to a commit` };
    }
  }
  try {
    const out = git(["diff", "--name-only", "-z", "--no-renames", resolved[0] as string, resolved[1] as string, "--"]);
    return { ok: true, files: out.split("\0").filter(Boolean) };
  } catch (err) {
    return { ok: false, reason: `git diff failed (${firstLine(err)})` };
  }
}

export interface RoutingInput {
  /** Raw `--changed-from` value. A malformed value throws RouteRangeError before any git command runs. */
  changedFrom: string;
  packs: Pack[];
  repoRoot: string;
  /** Path of routing-ledger.json. */
  ledgerFile: string;
  git?: GitRun;
  loadAffectedFn?: () => Promise<Affected>;
}

export async function computeRouting(input: RoutingInput): Promise<RoutingResult> {
  const range = parseRange(input.changedFrom);
  const fallback = (reason: string): RoutingResult => ({
    changed_from: input.changedFrom,
    files: [],
    packs: fallbackPackIds(input.packs),
    fallback: reason,
  });
  let affected: Affected;
  try {
    affected = await (input.loadAffectedFn ?? loadAffected)();
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err));
  }
  let ledger: Ledger;
  try {
    ledger = loadLedger(input.ledgerFile);
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err));
  }
  const changed = changedFiles(input.repoRoot, range, input.git);
  if (!changed.ok) return fallback(changed.reason);
  const routed = routePaths({ files: changed.files, packs: input.packs, ledger, affected });
  return { changed_from: input.changedFrom, files: routed.files, packs: routed.packs, fallback: null };
}
