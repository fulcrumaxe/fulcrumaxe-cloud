-- D#519 MQ-MAIN-RED-GUARD: work_item_driver_events gains the `main_guard` kind (the merge queue did not merge because the default
-- branch's tip is failing its checks, code main_red, or has no CI result after the wait, code main_ci_unknown). Same shape as 0923: the
-- check is restated whole. No grant moves.
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging.

ALTER TABLE work_item_driver_events DROP CONSTRAINT work_item_driver_events_kind_check;
ALTER TABLE work_item_driver_events
  ADD CONSTRAINT work_item_driver_events_kind_check CHECK (kind IN (
    'build_refused', 'build_waiting', 'stage_waiting', 'review_started', 'security_review_required', 'review_verdicts',
    'fix_round_started', 'fix_round_refused', 'fix_pushed_nothing', 'fix_round_failed', 'escalated',
    'review_status', 'merge_gate', 'merged_by_gate', 'stopped', 'pr_head_pushed', 'platform_check', 'correction_applied', 'resume_refused',
    'head_refresh', 'main_guard'
  ));
