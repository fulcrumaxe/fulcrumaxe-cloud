/**
 * The "declared classes" guard (D#7 DP5, criteria 1-2): the mechanism that
 * resolves a decision-type declaration -- a tool or role card statically
 * naming a catalogue entry it can request, following Codex's
 * destructive-annotation pattern ("the tool declares its own class; the
 * policy engine reads the declaration" -- research seat, D#7 Round 1) -- to
 * a real catalogue entry.
 *
 * This module is pure: no I/O, the same constraint DP1's
 * `test/importScan.test.ts` already enforces on every file in this
 * package's `src/`. The SCAN that finds real declarations in
 * `packages/roles/src/tools.ts` and `packages/roles/cards/*.md` lives in
 * `packages/roles/test/` -- that package owns those files, and DP5's own
 * file scope does not extend to editing them (no tool or role card
 * currently declares a decision type; DP4, which wires `decision_request`
 * into an actual card, has not landed). This module only knows how to
 * resolve a declaration once one is handed to it, and how to fail loudly --
 * at test/build time, never at runtime as a silent default (criterion 2) --
 * when one doesn't resolve.
 */
import type { CatalogueEntry } from "./types.js";
import { CATALOGUE } from "./catalogue.js";

/**
 * One static declaration: `source` names where it was found (e.g.
 * `tools.ts:gh` or a card's filename), `decisionType` is the catalogue id
 * it claims.
 */
export interface DeclaredEntry {
  readonly source: string;
  readonly decisionType: string;
}

/**
 * Resolves one declaration to its catalogue entry, or `undefined` when the
 * declared id isn't in `catalogue`. Catalogue ids are unique (DP1's frozen
 * list), so a resolved declaration always resolves to exactly one entry.
 */
export function resolveDeclaredEntry(
  declaration: DeclaredEntry,
  catalogue: readonly CatalogueEntry[] = CATALOGUE,
): CatalogueEntry | undefined {
  return catalogue.find((entry) => entry.id === declaration.decisionType);
}

/**
 * Every declaration whose `decisionType` does not resolve to a catalogue
 * entry. Empty is passing -- shaped like `findRlsViolations()` /
 * `findDialInvariantCollisions()`: a check function that returns a
 * violation list, never a boolean.
 */
export function findUnresolvedDeclarations(
  declarations: readonly DeclaredEntry[],
  catalogue: readonly CatalogueEntry[] = CATALOGUE,
): DeclaredEntry[] {
  return declarations.filter((d) => resolveDeclaredEntry(d, catalogue) === undefined);
}

/**
 * Thrown by `assertDeclarationsResolve` -- criterion 2: "A declaration
 * naming no catalogue entry is a build-time failure, not a runtime
 * default." Never caught and silently defaulted to some class; the caller
 * (a test today, a build-time check later) is expected to let this
 * propagate.
 */
export class UndeclaredCatalogueEntryError extends Error {
  constructor(unresolved: readonly DeclaredEntry[]) {
    super(
      `${unresolved.length} declaration(s) name no catalogue entry: ` +
        unresolved.map((d) => `${d.source} -> "${d.decisionType}"`).join(", "),
    );
    this.name = "UndeclaredCatalogueEntryError";
  }
}

/**
 * Throws `UndeclaredCatalogueEntryError` if any declaration fails to
 * resolve; a no-op otherwise. This is the "build-time failure, not a
 * runtime default" of criterion 2 -- it fails the check that runs it (a
 * test today), it never returns a fallback class for the caller to use.
 */
export function assertDeclarationsResolve(
  declarations: readonly DeclaredEntry[],
  catalogue: readonly CatalogueEntry[] = CATALOGUE,
): void {
  const unresolved = findUnresolvedDeclarations(declarations, catalogue);
  if (unresolved.length > 0) throw new UndeclaredCatalogueEntryError(unresolved);
}
