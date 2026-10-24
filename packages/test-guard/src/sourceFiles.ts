/**
 * The file list a source-scanning guard test reads: what git tracks under `tops`, plus untracked files git
 * does not ignore. Build output is out because git ignores it, not because of its directory name.
 *
 * A directory walk sees whatever happens to be on disk. A checkout that has run a web build carries bundles
 * such as `apps/web/app/.well-known/workflow/v1/step/route.js` (the workflow plugin writes it next to the
 * source, under its own `*` .gitignore), and those bundles inline source text, so an "only these files
 * mention X" guard counts them as extra sources. The same guard is green on a fresh CI checkout and red on
 * a machine that built first. Asking git gives one answer everywhere.
 *
 * Untracked, not-ignored files are kept on purpose: a new source file nobody has `git add`ed yet is still
 * scanned, so a guard catches a new mention before the commit, as the directory walk did.
 *
 * Fails closed: when `root` is not a git checkout (or git is missing) this throws instead of falling back to
 * a walk, because a walk would quietly bring the build output back.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Repo-relative, `/`-separated, sorted paths of every listed file under `tops` that exists in the working tree.
 * `skipDirs` drops a file that sits under a directory with one of these names at any depth below `root`
 * (the walk's old name skips, such as `test`, which mean "not production source" rather than "build output").
 */
export function listSourceFiles(root: string, tops: readonly string[], skipDirs: Iterable<string> = []): string[] {
  if (tops.length === 0) throw new TypeError("listSourceFiles: name at least one top directory");
  let out: string;
  try {
    out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...tops], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`listSourceFiles: git ls-files failed under ${root}; a source guard needs a git checkout`, { cause: error });
  }
  const skip = new Set(skipDirs);
  const files = out.split("\0").filter(
    // A tracked file deleted in the working tree is still listed by --cached; it is not a source any more.
    (f) => f !== "" && !f.split("/").slice(0, -1).some((segment) => skip.has(segment)) && existsSync(path.join(root, f)),
  );
  return [...new Set(files)].sort();
}

/** The same list as absolute paths, for scans that were written against a directory walk's output. */
export function listSourcePaths(root: string, tops: readonly string[], skipDirs: Iterable<string> = []): string[] {
  return listSourceFiles(root, tops, skipDirs).map((f) => path.join(root, f));
}
