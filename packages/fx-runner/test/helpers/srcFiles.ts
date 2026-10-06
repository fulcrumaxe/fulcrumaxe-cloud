import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every file under `dir`, recursively. */
export function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

/** Every `.ts` file under `src/`: [path relative to the package, text]. */
export function srcFiles(): Array<[string, string]> {
  return filesUnder(path.join(PACKAGE_DIR, "src"))
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file): [string, string] => [path.relative(PACKAGE_DIR, file), readFileSync(file, "utf8")]);
}

/** The module specifier of a static import, a dynamic `import()` or a `require()`, quoted with ', " or a backtick. */
export const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;

/**
 * Ways to load code that the specifier scan cannot see: `createRequire`, and an `import()` or `require()` whose
 * argument is not a plain string literal (a template with a substitution, a variable, a concatenation).
 */
export function opaqueLoads(text: string): string[] {
  const found: string[] = [];
  if (/\bcreateRequire\b/.test(text)) found.push("createRequire");
  for (const match of text.matchAll(/\b(import|require)\s*\(\s*([^)]*)\)/g)) {
    if (!/^(["'])[^"'`$]*\1\s*$/.test(match[2]!.trim()) && !/^`[^`$]*`\s*$/.test(match[2]!.trim())) found.push(`${match[1]}(${match[2]!.trim().slice(0, 30)})`);
  }
  return found;
}
