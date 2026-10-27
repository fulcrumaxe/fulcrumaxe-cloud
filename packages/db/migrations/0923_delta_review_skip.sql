-- D#519 MQ3-b-2a: a delta review that is skipped because the merge commit touched none of the pull request's own files (C4 2.4).
--
-- head_refreshes (0824) is append-only for app_user: SELECT and INSERT. The skip is decided AFTER the row is written (the refresh step
-- writes it, releases the slot, then asks the delta-review port), so the decision needs one narrow write: a nullable column set once
-- to the fixed code 'main_side_only', and a column-level UPDATE grant on that column alone. Nothing else on the row can change.
-- The merge gate reads it: a hop with the code carries the reviewed head's passes like a disjoint hop.
--
-- work_item_driver_events gains the `head_refresh` kind (the skip leaves a fixed code on the item). Same shape as 0788: the check is
-- restated whole. No grant moves.
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging.

ALTER TABLE head_refreshes
  ADD COLUMN delta_review_skipped text CONSTRAINT head_refreshes_skipped_check CHECK (delta_review_skipped = 'main_side_only');
GRANT UPDATE (delta_review_skipped) ON head_refreshes TO app_user;

ALTER TABLE work_item_driver_events DROP CONSTRAINT work_item_driver_events_kind_check;
ALTER TABLE work_item_driver_events
  ADD CONSTRAINT work_item_driver_events_kind_check CHECK (kind IN (
    'build_refused', 'build_waiting', 'stage_waiting', 'review_started', 'security_review_required', 'review_verdicts',
    'fix_round_started', 'fix_round_refused', 'fix_pushed_nothing', 'fix_round_failed', 'escalated',
    'review_status', 'merge_gate', 'merged_by_gate', 'stopped', 'pr_head_pushed', 'platform_check', 'correction_applied', 'resume_refused',
    'head_refresh'
  ));
