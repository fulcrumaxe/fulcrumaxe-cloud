/**
 * CHECK-SCOPE-BY-IMPORTS: which of a failed check's test files depend on the files the change touched.
 *
 * The cloud decides "this failure is outside the change" from file names alone, and a package-level comparison misses the common case: a change edits a module in one
 * package and a test in another package, which loads it through the package's name, breaks. The test file is not in a package the change touched, yet the change broke it.
 * Only the runner can read the repository (the cloud never reads a runner_local repo), so the runner follows the imports and names the failed test files that reach a
 * changed file on one header line of the summary. A line the cloud does not know is simply not read, so an older cloud is unaffected.
 *
 * What counts as an edge: a static import or re-export with a source string, a side-effect import, a dynamic load with a literal, a CommonJS load with a literal and a
 * test double's mock call, found by pattern (no parser: a specifier in a comment or a string is an extra edge, which only widens the scope toward a fix round, the safe
 * side). A relative specifier resolves to a tracked or changed file (a `.js` name finds its `.ts`, a folder finds its index). A workspace package name, with or without a
 * sub-path, resolves to the package's own source: its manifest's entry fields, mapped from a built folder back to the source folder, then the source index; when none of
 * those names a file the package has, EVERY source file of the package counts, so the package is never skipped. A name that is not a workspace package is a dependency
 * from outside the repository and has no edge.
 *
 * Fails toward the fix round: more than `IMPORT_SCOPE_MAX_VISITED` files to follow, a source file that cannot be read exactly, or no tracked list means "not read" (null),
 * and the caller says so on a line of its own. A failed file that is not JavaScript or TypeScript is left to the cloud's package rule exactly as before.
 *
 * This file is pure: reading a file of the workspace is the caller's job (`readWorkspaceSource` in checkStep.ts, which holds the runner's file-system guards).
 */
const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** At most this many files are followed from the failed test files; more is "not read". */
export const IMPORT_SCOPE_MAX_VISITED = 20000;
/** A source file longer than this is not read; the graph is then "not read". */
export const IMPORT_SCOPE_FILE_BYTES = 1024 * 1024;

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual|importMock|unmock)\s*\(\s*|\bjest\.(?:mock|requireActual)\s*\(\s*)(["'`])([^"'`\n]{1,300})\1/g;

export interface ImportScopeInput {
  /** The failed test files, repo-root-relative. */
  failed: readonly string[];
  /** Every path the change touched against its base (complete, never the cut list the summary shows). */
  changed: readonly string[];
  /** Every tracked path of the workspace. */
  tracked: readonly string[];
  /** The text of a tracked source file; null for a file that is gone, and a throw for one that cannot be read exactly. */
  read: (relative: string) => string | null;
  /** Limits on the whole graph read (defaults below); crossing any of them is "not read". */
  budget?: Partial<ImportScopeBudget>;
  /** The clock for the deadline, in milliseconds. */
  now?: () => number;
}

/** One budget for everything a graph read does, so a hostile tree cannot make the runner's event loop work for long or hold much memory. */
export interface ImportScopeBudget {
  /** Characters of source and manifests read, in all. */
  bytes: number;
  /** Edges (file to file) held, in all, after de-duplication. */
  edges: number;
  /** Import specifiers looked at in one file. */
  specifiersPerFile: number;
  /** Wall-clock milliseconds for the whole read. */
  deadlineMs: number;
}
export const IMPORT_SCOPE_BUDGET: ImportScopeBudget = { bytes: 32 * 1024 * 1024, edges: 500_000, specifiersPerFile: 20_000, deadlineMs: 3000 };

/** Thrown inside the read when a limit is crossed; the caller answers null. */
class OverBudget extends Error {}

interface Workspace {
  name: string;
  dir: string;
  manifest: Record<string, unknown>;
}

const stringsOf = (value: unknown, into: string[] = []): string[] => {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, into);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) stringsOf(item, into);
  return into;
};

function normalise(relative: string): string | null {
  const out: string[] = [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/**
 * The failed test files that depend, directly or through other files, on a changed file. Null when the graph could not be read (see the header). A failed file that is itself
 * changed is a dependent. Names that are not JavaScript or TypeScript are skipped (they never appear in the answer and never make it null).
 */
export function dependentFailedFiles(input: ImportScopeInput): string[] | null {
  try {
    return readGraph(input);
  } catch {
    // fx-swallow-ok: a limit crossed, or a source file that cannot be read exactly, leaves the graph unread, which the caller turns into a fix round
    return null;
  }
}

function readGraph(input: ImportScopeInput): string[] {
  const limit = { ...IMPORT_SCOPE_BUDGET, ...input.budget };
  const clock = input.now ?? Date.now;
  const started = clock();
  let bytes = 0;
  let edgesHeld = 0;
  const tick = (): void => {
    if (clock() - started > limit.deadlineMs) throw new OverBudget("deadline");
  };
  const read = (relative: string): string | null => {
    tick();
    const text = input.read(relative);
    if (text !== null) {
      bytes += text.length;
      if (bytes > limit.bytes) throw new OverBudget("bytes");
    }
    return text;
  };
  const known = new Set<string>([...input.tracked, ...input.changed]);
  const changed = new Set(input.changed);
  const tracked = input.tracked;

  // The workspace packages: every `<apps|packages|scripts>/<x>/package.json` that is tracked and names itself.
  const packages = new Map<string, Workspace>();
  for (const file of tracked) {
    if (!/^(?:apps|packages|scripts)\/[^/]+\/package\.json$/.test(file)) continue;
    const text = read(file);
    if (text === null) continue;
    try {
      const manifest = JSON.parse(text) as Record<string, unknown>;
      if (typeof manifest.name === "string") packages.set(manifest.name, { name: manifest.name, dir: file.slice(0, -"/package.json".length), manifest });
    } catch {
      // fx-swallow-ok: a manifest that is not JSON names no package; an import of it then has no edge, and the cloud's package rule still applies
    }
  }
  const byLongest = [...packages.keys()].sort((a, b) => b.length - a.length);

  const withExt = (base: string): string[] => {
    const found: string[] = [];
    if (SOURCE_FILE.test(base) && known.has(base)) found.push(base);
    const stripped = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    for (const ext of SOURCE_EXT) if (known.has(`${stripped}${ext}`)) found.push(`${stripped}${ext}`);
    if (stripped === base) for (const ext of SOURCE_EXT) if (known.has(`${base}${ext}`)) found.push(`${base}${ext}`);
    for (const ext of SOURCE_EXT) if (known.has(`${base}/index${ext}`)) found.push(`${base}/index${ext}`);
    return found;
  };

  // Every source file of a package, listed once per package however many imports fall back to it.
  const sourceOf = new Map<string, string[]>();
  const allSource = (dir: string): string[] => {
    let list = sourceOf.get(dir);
    if (list === undefined) {
      list = tracked.filter((file) => file.startsWith(`${dir}/`) && SOURCE_FILE.test(file));
      sourceOf.set(dir, list);
    }
    return list;
  };
  // A specifier resolves the same way wherever it is written from one folder; remembered so a file that repeats one costs nothing.
  const resolved = new Map<string, readonly string[]>();

  const resolvePackage = (pkg: Workspace, sub: string): string[] => {
    const dir = pkg.dir;
    if (sub !== "") {
      const hit = [...withExt(`${dir}/src/${sub}`), ...withExt(`${dir}/${sub}`)];
      return hit.length > 0 ? hit : allSource(dir);
    }
    const entries: string[] = [];
    for (const field of [pkg.manifest.main, pkg.manifest.module, pkg.manifest.types, pkg.manifest.exports]) {
      for (const value of stringsOf(field)) {
        const rel = normalise(`${dir}/${value}`);
        if (rel === null || !rel.startsWith(`${dir}/`)) continue;
        entries.push(...withExt(rel));
        // A built entry (`dist/index.js`, `dist/index.d.ts`) maps back to the source folder.
        const built = rel.slice(dir.length + 1).replace(/^(?:dist|build|lib|out)\//, "src/").replace(/\.d\.(?:[cm]?)ts$/, "");
        entries.push(...withExt(`${dir}/${built}`));
      }
    }
    entries.push(...withExt(`${dir}/src/index`), ...withExt(`${dir}/index`));
    return entries.length > 0 ? entries : allSource(dir);
  };

  // Each file's edges are built once, de-duplicated, and answer every failed file that reaches it.
  const edgesOf = new Map<string, readonly string[]>();
  const importsOf = (file: string): readonly string[] => {
    const held = edgesOf.get(file);
    if (held !== undefined) return held;
    const text = read(file);
    const edges = new Set<string>();
    const merged = new Set<readonly string[]>();
    if (text !== null) {
      const slash = file.lastIndexOf("/");
      const from = slash < 0 ? "" : file.slice(0, slash);
      let specifiers = 0;
      for (const match of text.matchAll(IMPORT_SPECIFIER)) {
        specifiers += 1;
        if (specifiers > limit.specifiersPerFile) throw new OverBudget("specifiers");
        if (specifiers % 256 === 0) tick();
        const specifier = match[2]!;
        if (specifier.includes("${") || specifier.startsWith("node:")) continue;
        const key = specifier.startsWith(".") ? `${from}\0${specifier}` : specifier;
        let found = resolved.get(key);
        if (found === undefined) {
          if (specifier.startsWith(".")) {
            const rel = normalise(`${from}/${specifier}`);
            found = rel === null ? [] : withExt(rel);
          } else {
            const name = byLongest.find((candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`));
            found = name === undefined ? [] : resolvePackage(packages.get(name)!, specifier.slice(name.length + 1));
          }
          resolved.set(key, found);
        }
        // The same list (a package's whole source, say) reached by a thousand different sub-paths is merged once.
        if (merged.has(found)) continue;
        merged.add(found);
        for (const edge of found) {
          if (edges.has(edge)) continue;
          edges.add(edge);
          edgesHeld += 1;
          if (edgesHeld > limit.edges) throw new OverBudget("edges");
        }
      }
    }
    const list = [...edges];
    edgesOf.set(file, list);
    return list;
  };

  const dependent: string[] = [];
  for (const start of input.failed) {
    if (!SOURCE_FILE.test(start)) continue;
    const seen = new Set<string>([start]);
    const queue = [start];
    let reached = changed.has(start);
    while (!reached && queue.length > 0) {
      const file = queue.pop()!;
      tick();
      for (const edge of importsOf(file)) {
        if (seen.has(edge)) continue;
        if (changed.has(edge)) {
          reached = true;
          break;
        }
        seen.add(edge);
        if (seen.size > IMPORT_SCOPE_MAX_VISITED) throw new OverBudget("visited");
        queue.push(edge);
      }
    }
    if (reached) dependent.push(start);
  }
  return dependent;
}

/** A plain repo-relative source file name, the same closed shape the summary's file lines use. */
const PLAIN = /^[A-Za-z0-9_@+][A-Za-z0-9_./@+-]{0,255}$/;

/** The summary header line naming the failed test files that depend on the change, "" when none does (with its newline otherwise). Only plain names are shown. */
export function importScopeLine(dependent: readonly string[] | null): string {
  if (dependent === null) return "import graph not read\n";
  const shown = dependent.filter((name) => PLAIN.test(name)).slice(0, 40);
  if (dependent.length === 0) return "";
  const left = dependent.length - shown.length;
  return `failed test files that import changed code (${String(dependent.length)}): ${shown.join(", ")}${left === 0 ? "" : `${shown.length === 0 ? "" : " "}(and ${String(left)} more)`}\n`;
}
