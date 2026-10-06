/**
 * The feature exposure catalogue (D#8 R2): the classification every
 * shippable feature must carry before it reaches a customer who is
 * already running the product.
 *
 * The catalogue is CODE, not a table. It is declared and reviewed in a
 * PR, frozen by a snapshot test, and shaped like
 * `packages/roles/src/manifest.ts` and D#7's decision catalogue
 * (`packages/decisions/src/catalogue.ts`). This is what removes the
 * per-table RLS tax the D#8 panel asked for from four of six table
 * proposals, and it makes a floor bump (see `resolveVersion` below) a
 * reviewed code change rather than a credential.
 *
 * Three exposure classes (D#8 Spec, Policy point 1):
 *   - silent      on for everyone, no record: bug fixes, performance,
 *                 new read-only surfaces, wording.
 *   - gated       off until an owner|admin turns it on: anything that
 *                 can change the outcome of work already in flight,
 *                 spend the customer's money, loosen a guard, or alter
 *                 published customer output.
 *   - tier_gated  an entitlement read from the plan, never a second
 *                 source of truth about what a customer bought.
 *
 * v1 is deliberately empty: no code path in this repo creates an
 * `account_features` row or reads a feature key yet (D#8 R1 merged the
 * table; R3, which this task blocks, builds the resolver; the call site
 * that creates `agent_runs` rows -- the only thing that would need a
 * real feature key -- is D#2 H04/H09, not yet built, per D#8's own
 * cross-Spec amendment request 5). This mirrors the "nothing declares
 * yet" state D#7 DP5's declared-classes guard documents for
 * `packages/roles/src/tools.ts`/`cards/*.md`: the guard exists and is
 * correct before it has a first real consumer. The first real feature
 * lands here as its own reviewed diff.
 */

export type ExposureClass = "silent" | "gated" | "tier_gated";

export interface FeatureCatalogueEntry {
  /** Unique feature identifier; matches account_features.feature_key. */
  readonly key: string;
  readonly class: ExposureClass;
  /**
   * The emergency-path floor (D#8 Spec Policy point 9): a pin below this
   * version resolves to this version, on the next resolution, for
   * everyone. `resolveVersion` below is the ONLY code path that applies
   * it -- there is no second, emergency-only lever, so raising this
   * field is a reviewed code change exercised the same way on every
   * ordinary resolution, not a credential used for the first time during
   * an incident.
   */
  readonly securityFloorVersion: number;
  /** The version this feature's catalogue entry first shipped in. */
  readonly addedIn: number;
  readonly description: string;
}

/** Input shape for `defineFeature`: `securityFloorVersion` is optional here only. */
export interface FeatureCatalogueEntryInput {
  readonly key: string;
  readonly class: ExposureClass;
  /** Defaults to `addedIn` when omitted (criterion 4, first sentence). */
  readonly securityFloorVersion?: number;
  readonly addedIn: number;
  readonly description: string;
}

/**
 * Constructs a catalogue entry, defaulting `securityFloorVersion` to
 * `addedIn` when the author does not name a later floor explicitly.
 * Every entry in `FEATURE_CATALOGUE` is built through this so the
 * default is never duplicated by hand.
 */
export function defineFeature(input: FeatureCatalogueEntryInput): FeatureCatalogueEntry {
  return {
    key: input.key,
    class: input.class,
    securityFloorVersion: input.securityFloorVersion ?? input.addedIn,
    addedIn: input.addedIn,
    description: input.description,
  };
}

/**
 * Frozen v1 catalogue (criterion 1). A change here -- adding, removing,
 * or reclassifying an entry -- is a deliberate, reviewed diff to this
 * file, the same guarantee D#2 H08.6 gives role defaults. See the module
 * header for why v1 starts empty.
 */
export const FEATURE_CATALOGUE: readonly FeatureCatalogueEntry[] = [];

export const FEATURE_CATALOGUE_KEYS: readonly string[] = FEATURE_CATALOGUE.map((entry) => entry.key);

/** The catalogue entry for `key`, or `undefined` if none exists. */
export function getCatalogueEntry(
  key: string,
  catalogue: readonly FeatureCatalogueEntry[] = FEATURE_CATALOGUE,
): FeatureCatalogueEntry | undefined {
  return catalogue.find((entry) => entry.key === key);
}

/**
 * Criterion 3: a feature key absent from the catalogue resolves to
 * `gated`, never `silent`. Fail closed -- an unclassified feature is a
 * behaviour change nobody recorded, not a feature nobody enabled.
 */
export function classify(
  key: string,
  catalogue: readonly FeatureCatalogueEntry[] = FEATURE_CATALOGUE,
): ExposureClass {
  return getCatalogueEntry(key, catalogue)?.class ?? "gated";
}

/**
 * Criterion 4: the floor path, exercised on every resolution. `key`
 * names a catalogue entry; `pinnedVersion` is whatever version a
 * per-artifact resolver (D#5's `env_versions`, D#3's `site_versions`,
 * D#7's `decision_settings.version` -- this package holds no pin state
 * of its own, per the D#8 Spec's scope fence) would otherwise use. The
 * result is `pinnedVersion` unless the catalogue names a higher
 * `securityFloorVersion`, in which case the floor wins -- "the floor
 * path is the ordinary path," so this same function is what an incident
 * response calls, not a second code path built for it. A key absent
 * from the catalogue has no floor to apply and returns `pinnedVersion`
 * unchanged: criterion 3's fail-closed default is about the on/off
 * *class*, not a floor that does not exist for an unclassified key.
 */
export function resolveVersion(
  key: string,
  pinnedVersion: number,
  catalogue: readonly FeatureCatalogueEntry[] = FEATURE_CATALOGUE,
): number {
  const entry = getCatalogueEntry(key, catalogue);
  if (!entry) return pinnedVersion;
  return Math.max(pinnedVersion, entry.securityFloorVersion);
}
