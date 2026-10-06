/**
 * The decision-type catalogue (D#7 DP1, DP-OD7).
 *
 * One entry per decision type, shaped like `packages/roles/src/manifest.ts`.
 * This is THE catalogue -- DP-OD7 is binding: later subsystems (D#5, D#6,
 * and DP5's declared-classes guard) contribute entries here, none keeps its
 * own. A decision type absent from this list is unknown, and unknown
 * escalates to class 3 (C1) -- see `decide.ts`, which never guesses.
 *
 * This is a frozen v1 list: `test/catalogue.test.ts` enumerates it exactly,
 * so an addition or removal is a deliberate, reviewed change to this file,
 * not a silent drift.
 *
 * `allowedDispositions` values use DP-C1's `ask | announce | act`
 * vocabulary. An entry that does not lock itself more conservatively than
 * its class allows lists every disposition its class's presets can ever
 * propose for it, so the preset's choice is never clamped away.
 */
import type { CatalogueEntry } from "./types.js";

/**
 * Which catalogue decided (D#7 DP3b, DP-C3b). The receipt writer stamps
 * this on every receipt itself -- it is never a caller input -- so a
 * receipt says which version of the dials' vocabulary resolved it.
 * `test/catalogue-version.test.ts` pins a hash of the catalogue and the
 * three presets next to this number: changing either without bumping it
 * (and updating the pin) fails that test.
 */
export const CATALOGUE_VERSION = 1;

export const CATALOGUE: readonly CatalogueEntry[] = [
  // --- class 1: automated_with_monitoring -- never asked ---
  {
    id: "dependency_patch_bump",
    class: "automated_with_monitoring",
    defaultDisposition: "act",
    allowedDispositions: ["act"],
    reversal: { availability: "reversible_before_build" },
    customerProximity: "internal_only",
    dataSensitivity: "none",
  },
  {
    id: "retry_transient_step_failure",
    class: "automated_with_monitoring",
    defaultDisposition: "act",
    allowedDispositions: ["act"],
    reversal: {
      availability: "not_reversible",
      reason:
        "a retry consumes compute and leaves no artifact of its own to undo; there is nothing to reverse",
    },
    customerProximity: "internal_only",
    dataSensitivity: "none",
  },

  // --- class 2: human_over_the_loop -- ask, announce, or act, per preset ---
  {
    id: "nonbreaking_refactor_approach",
    class: "human_over_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["act", "announce", "ask"],
    reversal: { availability: "reversible_before_build" },
    customerProximity: "internal_only",
    dataSensitivity: "none",
  },
  {
    id: "test_strategy_choice",
    class: "human_over_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["act", "announce", "ask"],
    reversal: { availability: "reversible_before_build" },
    customerProximity: "internal_only",
    dataSensitivity: "none",
  },
  {
    id: "publish_deprecation_notice",
    class: "human_over_the_loop",
    defaultDisposition: "ask",
    // Locked more conservatively than its class strictly requires: a
    // customer-facing notice is reversible only by publishing a
    // retraction (a compensating action, DP7), so this entry stays
    // ask-only regardless of preset until that exists.
    allowedDispositions: ["ask"],
    reversal: { availability: "compensating_work" },
    customerProximity: "customer_facing",
    dataSensitivity: "none",
  },

  // --- class 3: human_in_the_loop -- always asked ---
  {
    id: "publish_release_artifact",
    class: "human_in_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["ask"],
    reversal: {
      availability: "not_reversible",
      reason:
        "a published release artifact may already be downloaded by users; pulling it does not undo those downloads",
    },
    customerProximity: "customer_facing",
    dataSensitivity: "none",
  },
  {
    id: "external_paid_api_call",
    class: "human_in_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["ask"],
    reversal: {
      availability: "not_reversible",
      reason: "money already spent cannot be unspent by this system",
    },
    customerProximity: "internal_only",
    dataSensitivity: "none",
  },
] as const;

/** Looks up one catalogue entry by id. `undefined` for a type not in the catalogue. */
export function getCatalogueEntry(id: string): CatalogueEntry | undefined {
  return CATALOGUE.find((entry) => entry.id === id);
}

export const CATALOGUE_IDS: readonly string[] = CATALOGUE.map((entry) => entry.id);
