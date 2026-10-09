import { accessSync, constants } from "node:fs";
import path from "node:path";

/**
 * The first executable called `name` on the given search path, or undefined. Walks the entries in JS, so a test does
 * not depend on a `which` binary (the self-hosted NixOS runner has none). Empty entries are skipped: they mean the
 * working directory, which is not where a tool is looked for here.
 */
export function findOnPath(name: string, searchPath: string): string | undefined {
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir === "") continue;
    const file = path.join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here, try the next entry
    }
  }
  return undefined;
}
