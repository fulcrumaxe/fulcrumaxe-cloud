/**
 * Customer-facing names for the Autonomy settings (D#7 DP10b). A picker or a list shows these, never an internal id (build-right rule).
 * They live here, not on the catalogue, so adding a name never changes the catalogue's pinned hash. `test/ask-settings.test.ts` fails when a
 * catalogue entry or a fixed invariant has no name, so a new one cannot reach the page as a raw id.
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
};

export const INVARIANT_LABELS: Readonly<Record<string, string>> = {
  cross_tenant_row_access: "One account can never read another account's data",
  role_permission_grant: "What each role is allowed to do is fixed in code",
  merge_or_protection_change: "Merging, and changing branch protection, is always a person's call",
  untrusted_work_creation: "Work from an untrusted source never starts automatically",
};

/** The name to show: the mapped one, else the id with its underscores read as spaces (never blank, never "undefined"). */
export const decisionLabel = (id: string): string => DECISION_LABELS[id] ?? id.replace(/_/g, " ");
export const invariantLabel = (key: string): string => INVARIANT_LABELS[key] ?? key.replace(/_/g, " ");
