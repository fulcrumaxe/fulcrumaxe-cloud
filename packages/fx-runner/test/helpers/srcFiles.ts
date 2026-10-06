import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function filesUnder(dir: string): string[] {
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
