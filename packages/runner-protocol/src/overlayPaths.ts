/**
 * The overlay (private-only) path list: its compiler and matcher. Pure string work with no imports, so the package root (`acceptanceScope.ts`)
 * can use it without reaching the public push code. `planePush.ts` imports and re-exports it; behaviour is unchanged.
 */

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
