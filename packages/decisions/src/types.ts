/**
 * Types for the decision policy layer (D#7 DP1).
 *
 * This module is pure: no network, no filesystem, no database, no model
 * client. Classification is a table lookup (owner decision 3 / C1) -- the
 * catalogue below is the table, and `decide()` in `decide.ts` is the
 * lookup. Nothing in this package reaches outside the data it is handed.
 *
 * The three decision classes are borrowed, not invented (DP-OD2,
 * arXiv:2606.22484):
 *   - `automated_with_monitoring` (class 1) -- never asked.
 *   - `human_over_the_loop`       (class 2) -- asked or not, per preset.
 *   - `human_in_the_loop`         (class 3) -- always asked.
 */

/** The three decision classes, borrowed verbatim from arXiv:2606.22484 (DP-OD2). */
export type DecisionClass =
  | "automated_with_monitoring"
  | "human_over_the_loop"
  | "human_in_the_loop";

/**
 * What `decide()` resolves a decision to (DP-C1, the Team Lead's
 * disposition-vocabulary clarification for D#7 DP1, resolving the
 * "Balanced and Autonomous end up identical" gap the earlier binary
 * `auto | ask` vocabulary left open):
 *
 *   - `ask`      -- park the branch and wait for the customer (DP4
 *     territory -- out of scope here).
 *   - `announce` -- act now, notify the customer immediately, and offer
 *     reversal where the catalogue entry supports it (DP4 treats this as
 *     act plus notify; DP6 renders it in the digest; DP7 attaches
 *     reversal to the receipt).
 *   - `act`      -- act now; surfaced only in the receipt and digest.
 *
 * These three, and no fourth write-path flag: this package's tests prove
 * no such flag exists anywhere in it (C3) -- "never a dial" is absence
 * from the catalogue, not a disposition value on an entry that IS in it.
 */
export type Disposition = "ask" | "announce" | "act";

/**
 * How a decision type's effect can be reversed. Declared as data on the
 * catalogue entry here (DP1); the actual compensating-action logic is
 * DP7's job, not this package's. `reason` is required exactly when
 * `availability` is `"not_reversible"` -- the type system enforces the
 * "with prose for the second" requirement DP5's criterion 1 states for
 * this same three-value list.
 */
export type ReversalDeclaration =
  | { readonly availability: "reversible_before_build" }
  | { readonly availability: "compensating_work" }
  | { readonly availability: "not_reversible"; readonly reason: string };

/**
 * DP-OD2's two extra routing axes from arXiv:2606.22484. Documentation
 * fields only in v1: `decide()` reads neither (criterion 2). Reversibility
 * (via `reversal`) and blast radius (via `class`) are the only resolution
 * axes.
 */
export type CustomerProximity = "customer_facing" | "internal_only";
export type DataSensitivity = "none" | "customer_data" | "regulated_data";

/**
 * One entry in the decision-type catalogue, shaped like
 * `packages/roles/src/manifest.ts`'s `RoleManifestEntry`. `defaultDisposition`
 * and `allowedDispositions` let a catalogue author lock a specific decision
 * type more conservatively than its class strictly requires (e.g. a
 * class-2 type an author wants to keep permanently `ask`-only) -- `decide()`
 * clamps a preset's proposed disposition to `allowedDispositions`, degrading
 * toward the more conservative value (`act` -> `announce` -> `ask`) when the
 * preset's own choice isn't permitted.
 */
export interface CatalogueEntry {
  /** Stable identifier. Declared by a tool or role card (DP5), never by an agent. */
  readonly id: string;
  readonly class: DecisionClass;
  readonly defaultDisposition: Disposition;
  readonly allowedDispositions: readonly Disposition[];
  readonly reversal: ReversalDeclaration;
  /** Documentation only in v1 (DP-OD2) -- decide() never reads this field. */
  readonly customerProximity: CustomerProximity;
  /** Documentation only in v1 (DP-OD2) -- decide() never reads this field. */
  readonly dataSensitivity: DataSensitivity;
}

/** The three preset names (DP-OD1). Renaming them is rejected as churn. */
export type PresetName = "cautious" | "balanced" | "autonomous";

/** A preset's disposition for each of the three classes. */
export interface PresetDispositions {
  readonly automated_with_monitoring: Disposition;
  readonly human_over_the_loop: Disposition;
  readonly human_in_the_loop: Disposition;
}

/**
 * A named point in the class x disposition matrix (owner decision 5). A
 * preset moves exactly one thing -- the middle tier -- so `dispositions`
 * fixes class 1 to `"act"` and class 3 to `"ask"` on every preset; only
 * `human_over_the_loop` varies, giving every pair of presets a distinct
 * class-2 value (DP-C1).
 */
export interface Preset {
  readonly name: PresetName;
  /** Display label: "Cautious" | "Balanced" | "Autonomous" (DP-OD1). */
  readonly label: string;
  /** DP-OD1's one-line naming principle: the customer's role in this preset. */
  readonly customerRoleDescription: string;
  readonly dispositions: PresetDispositions;
}

/**
 * The facts a role emits about a decision it wants resolved --
 * `{type, options, proposed, rationale}`, per the architect's quote in D#7.
 * Deliberately has no `class` field: the class comes from the catalogue
 * entry the caller looked up for `type`, never from the agent (C2).
 */
export interface DecisionRequest {
  readonly type: string;
  readonly options: readonly string[];
  readonly proposed: string;
  readonly rationale: string;
}

/** The tenant's resolved settings for this one decision, as `decide()` sees them. */
export interface DecisionSettings {
  readonly preset: PresetName;
}

/** What `decide()` resolves a request to. */
export interface DecisionResult {
  readonly class: DecisionClass;
  readonly disposition: Disposition;
}
