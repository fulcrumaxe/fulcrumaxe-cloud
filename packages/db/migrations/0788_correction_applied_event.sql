-- D#597 CC-3: the stage driver records, as a fact of the item, that a build or fix run carried accepted run notes. One more kind in the
-- store the driver already writes (work_item_driver_events, 0709). The row holds ids and the fixed kind only: the run in `run_id`, the
-- notes' ids as plain codes in `reasons`. The note text is never written here; nothing else changes. No grant moves: the driver login
-- already inserts into this table, and platform_ops gains nothing.
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging and renumber to stay above it.
ALTER TABLE work_item_driver_events DROP CONSTRAINT work_item_driver_events_kind_check;
ALTER TABLE work_item_driver_events
  ADD CONSTRAINT work_item_driver_events_kind_check CHECK (kind IN (
    'build_refused', 'review_started', 'security_review_required', 'review_verdicts',
    'fix_round_started', 'fix_round_refused', 'fix_pushed_nothing', 'fix_round_failed', 'escalated',
    'review_status', 'merge_gate', 'merged_by_gate', 'stopped', 'pr_head_pushed', 'platform_check', 'correction_applied'
  ));
