/**
 * The one adapter to the CI classifier in scripts/ci/affected.mjs (#511). Routing reuses its glob matcher and
 * its list of paths that are not product code (the `ignore` list in scripts/ci/full-run-triggers.json), so
 * there is exactly one copy of each. The classifier's own question (which workspace packages does a change
 * touch) is a different one from ours (which live packs does it route to), so only these two pieces are used.
 *
 * Loaded by dynamic import so a missing or broken classifier is a value the caller turns into the fail-closed
 * fallback, not a crash at module load.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Affected {
  globToRegExp: (glob: string) => RegExp;
  /** Globs of paths that are documentation or team state, not product code. */
  ignoreGlobs: string[];
}

interface AffectedModule {
  globToRegExp: (glob: string) => RegExp;
  loadTriggers: () => { ignore: { glob: string; reason: string }[] };
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** scripts/ci/affected.mjs of the checkout this package lives in. */
export const AFFECTED_PATH = resolve(HERE, "..", "..", "..", "scripts", "ci", "affected.mjs");

export class AffectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AffectedError";
  }
}

function firstLine(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split("\n")[0] ?? "";
}

export async function loadAffected(path: string = AFFECTED_PATH): Promise<Affected> {
  let mod: Partial<AffectedModule>;
  try {
    mod = (await import(pathToFileURL(path).href)) as Partial<AffectedModule>;
  } catch (err) {
    throw new AffectedError(`classifier unreadable (scripts/ci/affected.mjs): ${firstLine(err)}`);
  }
  if (typeof mod.globToRegExp !== "function" || typeof mod.loadTriggers !== "function") {
    throw new AffectedError("classifier does not export globToRegExp and loadTriggers");
  }
  try {
    const rules = mod.loadTriggers();
    if (!Array.isArray(rules.ignore) || !rules.ignore.every((i) => typeof i?.glob === "string")) {
      throw new Error("ignore list is not a list of {glob, reason}");
    }
    return { globToRegExp: mod.globToRegExp, ignoreGlobs: rules.ignore.map((i) => i.glob) };
  } catch (err) {
    throw new AffectedError(`classifier trigger file unreadable: ${firstLine(err)}`);
  }
}
