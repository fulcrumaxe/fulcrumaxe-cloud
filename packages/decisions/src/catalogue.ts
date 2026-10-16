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
 * `timeoutOutcomes` (D#7 DP12a-1, DP-C5 R2) lists what an unanswered ask may resolve to for the entry. Only the two internal,
 * reversible-before-build class-2 entries allow `proceed_recommended`; every other asked entry is `stop_and_flag` only, and a class-1
 * entry (never asked) has none. A later class-3 entry is `stop_and_flag` only unless its own reviewed PR says otherwise and names why.
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
export const CATALOGUE_VERSION = 5;

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
    timeoutOutcomes: [],
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
    timeoutOutcomes: [],
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
    timeoutOutcomes: ["stop_and_flag", "proceed_recommended"],
  },
  {
    id: "test_strategy_choice",
    class: "human_over_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["act", "announce", "ask"],
    reversal: { availability: "reversible_before_build" },
    customerProximity: "internal_only",
    dataSensitivity: "none",
    timeoutOutcomes: ["stop_and_flag", "proceed_recommended"],
  },
  {
    // D#6 R2b-4a (C31): a runner run uses the Claude plan of the member whose subscription runner takes it. Cautious asks for each
    // run, Balanced approves at claim and says so, Autonomous approves at claim. The default when a repo has no dial row is
    // `announce`: the plan holder's own per-runner consent is the deliberate act, and an admin who wants per-run asking sets the
    // repo (or just this decision) to `ask`. Class 2 and not class 3, because class 3 asks at every level, which is the very thing
    // the owner ruled against; spending another member's plan without that member's consent stays impossible at every level.
    id: "runner_run_on_member_plan",
    class: "human_over_the_loop",
    defaultDisposition: "announce",
    allowedDispositions: ["act", "announce", "ask"],
    reversal: { availability: "reversible_before_build" },
    customerProximity: "internal_only",
    dataSensitivity: "none",
    // Stop-and-flag only: going ahead on silence would spend a member's plan without that member's consent (D#7 DP12a-1).
    timeoutOutcomes: ["stop_and_flag"],
  },
  // D#483 S5-a: starting work. The three small kinds share one shape: the person's dial moves them (Cautious asks, Balanced
  // starts and says so, Autonomous starts). With no dial row the default is `ask`: starting work is a person's approval until they
  // choose a preset or set the dial; the start gate
  // still needs a confirmed weekly auto-start envelope and the hard rules in `resolveStart` before anything starts.
  {
    id: "start_work_small",
    class: "human_over_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["act", "announce", "ask"],
    reversal: { availability: "reversible_before_build" },
    customerProximity: "internal_only",
    dataSensitivity: "none",
    // Ruling R-7-DP12a1-4: starting work belongs to the person or the auto-start toggle, never to a timeout, so stop-and-flag only.
    timeoutOutcomes: ["stop_and_flag"],
  },
  {
    id: "start_work_bug",
    class: "human_over_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["act", "announce", "ask"],
    reversal: { availability: "reversible_before_build" },
    customerProximity: "internal_only",
    dataSensitivity: "none",
    // Ruling R-7-DP12a1-4: starting work belongs to the person or the auto-start toggle, never to a timeout, so stop-and-flag only.
    timeoutOutcomes: ["stop_and_flag"],
  },
  {
    id: "start_work_doc",
    class: "human_over_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["act", "announce", "ask"],
    reversal: { availability: "reversible_before_build" },
    customerProximity: "internal_only",
    dataSensitivity: "none",
    // Ruling R-7-DP12a1-4: starting work belongs to the person or the auto-start toggle, never to a timeout, so stop-and-flag only.
    timeoutOutcomes: ["stop_and_flag"],
  },
  {
    // Launching a sub-item of a parent a person already approved: a planned PR or task of its approved Spec, a fix round, or a
    // follow-up child inside the parent's scope. The envelope limit is the same at every preset (a sub-item never passes the
    // parent's envelope); `resolveSubItemLaunch` checks that before this dial is read.
    id: "launch_sub_item",
    class: "human_over_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["act", "announce", "ask"],
    reversal: { availability: "reversible_before_build" },
    customerProximity: "internal_only",
    dataSensitivity: "none",
    // Ruling R-7-DP12a1-4: starting work belongs to the person or the auto-start toggle, never to a timeout, so stop-and-flag only.
    timeoutOutcomes: ["stop_and_flag"],
  },
  {
    // D#7 AAP-a1: an agent asks to run one tool call (a customer's own approval service or our gateway raises it). Unlike a decision
    // request this is a real call with exact arguments, so a person's rules may approve or deny it by what the call IS, never by what the
    // agent says about it. Cautious asks for each call; a rule can only approve when this dial resolves to `announce` or `act`. A call that
    // ran can't be un-run, and silence is never a go-ahead: the only timeout outcome is stop-and-flag (R-7-AAP-2).
    id: "tool_call",
    class: "human_over_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["act", "announce", "ask"],
    reversal: {
      availability: "not_reversible",
      reason: "a tool call that ran can't be un-run; you can deny the next one",
    },
    customerProximity: "internal_only",
    dataSensitivity: "customer_data",
    timeoutOutcomes: ["stop_and_flag"],
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
    timeoutOutcomes: ["stop_and_flag"],
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
    timeoutOutcomes: ["stop_and_flag"],
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
    timeoutOutcomes: ["stop_and_flag"],
  },
  {
    // The first start of a feature, project or critical item. Always asked, at every preset.
    id: "start_parent_item",
    class: "human_in_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["ask"],
    reversal: { availability: "reversible_before_build" },
    customerProximity: "internal_only",
    dataSensitivity: "none",
    // Class 3 added after v1: stop-and-flag only (D#7 R2 v1 clamps).
    timeoutOutcomes: ["stop_and_flag"],
  },
  {
    // An item reached its spend envelope and would go past it.
    id: "spend_past_envelope",
    class: "human_in_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["ask"],
    reversal: {
      availability: "not_reversible",
      reason: "money already spent cannot be unspent",
    },
    customerProximity: "internal_only",
    dataSensitivity: "none",
    // Going past a spend envelope on silence is never allowed: stop-and-flag only.
    timeoutOutcomes: ["stop_and_flag"],
  },
  {
    // An item that started as small, doc or bug and that triage then classifies higher.
    id: "start_after_reclassify",
    class: "human_in_the_loop",
    defaultDisposition: "ask",
    allowedDispositions: ["ask"],
    reversal: { availability: "reversible_before_build" },
    customerProximity: "internal_only",
    dataSensitivity: "none",
    // Class 3 added after v1: stop-and-flag only (D#7 R2 v1 clamps).
    timeoutOutcomes: ["stop_and_flag"],
  },
] as const;

/** Looks up one catalogue entry by id. `undefined` for a type not in the catalogue. */
export function getCatalogueEntry(id: string): CatalogueEntry | undefined {
  return CATALOGUE.find((entry) => entry.id === id);
}

export const CATALOGUE_IDS: readonly string[] = CATALOGUE.map((entry) => entry.id);
