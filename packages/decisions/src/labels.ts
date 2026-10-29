/**
 * Customer-facing names for the Autonomy settings (D#7 DP10b), moved here from `packages/api` byte for byte (D#7 DP4b-3, R-7-DP4b-1) so the pipeline's
 * decisions block can name a decision the same way the settings page does without depending on the API package. A data file outside the hashed
 * catalogue: adding a name never changes the catalogue's pinned hash. `packages/api/test/ask-settings.test.ts` fails when a catalogue entry has no name.
 */
export const DECISION_LABELS: Readonly<Record<string, string>> = {
  dependency_patch_bump: "Patch-level dependency updates",
  retry_transient_step_failure: "Retrying a step that failed for a temporary reason",
  nonbreaking_refactor_approach: "How to restructure code without changing what it does",
  test_strategy_choice: "How to test a change",
  runner_run_on_member_plan: "Running work on a team member's own plan",
  tool_call: "Letting an agent run a tool",
  start_work_small: "Starting a small piece of work",
  start_work_bug: "Starting a bug fix",
  start_work_doc: "Starting a documentation change",
  launch_sub_item: "Starting one part of a larger piece of work",
  publish_deprecation_notice: "Publishing a deprecation notice",
  publish_release_artifact: "Publishing a release",
  external_paid_api_call: "Calling a paid outside service",
  start_parent_item: "Starting a new feature, project or critical item",
  spend_past_envelope: "Spending past an item's budget",
  run_extension: "Extending a run past its limit",
  start_after_reclassify: "Starting an item that was later judged larger",
  reversal_recorded: "Undoing an earlier decision",
  reversal_over_cap: "Undoing a decision again after two undos",
};

/** The name to show: the mapped one, else the id with its underscores read as spaces (never blank, never "undefined"). */
export const decisionLabel = (id: string): string => DECISION_LABELS[id] ?? id.replace(/_/g, " ");
