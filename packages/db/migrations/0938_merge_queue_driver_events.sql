-- D#694 B5: work_item_driver_events gains the three merge-queue kinds and one nullable column that names the queue entry.
--
--   merge_enqueued     the merge gate put the pull request into GitHub's merge queue (or, only where the queue itself was refused to the app, switched
--                      on auto-merge). Written once per head; `queue_entry_id` is the entry GitHub answered with.
--   merge_dequeued     GitHub took the entry out of the queue without merging it (written from the webhook, a later row of this feature).
--   merged_via_queue   the queue merged the pull request (written from the webhook, a later row of this feature).
--
-- `queue_entry_id` is GitHub's node id of the queue entry. None of the existing fields can hold it: `code` and `reasons` are lower-case snake_case codes,
-- `head_sha` and `pr_number` are other facts, `dedupe_key` is the replay guard. It is a plain nullable text with a tight character-set check (GitHub's node-id
-- characters, at most 100), so the table keeps its design: fixed vocabulary, no free text, small rows. NULL for every older row and for every other kind.
--
-- Additive and append-only like the rest of the table: a wider CHECK and a nullable column. The table-level grant (SELECT and INSERT for app_user) already
-- covers a new column, so no grant moves. Rolling the code back leaves harmless unused kinds and a NULL column.
--
-- Same shape as 0925: the kind check is restated whole. Numbered above the highest migration on the code plane and above the one an open pull request
-- holds; re-check against main right before merging.

ALTER TABLE work_item_driver_events DROP CONSTRAINT work_item_driver_events_kind_check;
ALTER TABLE work_item_driver_events
  ADD CONSTRAINT work_item_driver_events_kind_check CHECK (kind IN (
    'build_refused', 'build_waiting', 'stage_waiting', 'review_started', 'security_review_required', 'review_verdicts',
    'fix_round_started', 'fix_round_refused', 'fix_pushed_nothing', 'fix_round_failed', 'escalated',
    'review_status', 'merge_gate', 'merged_by_gate', 'stopped', 'pr_head_pushed', 'platform_check', 'correction_applied', 'resume_refused',
    'head_refresh', 'main_guard', 'merge_enqueued', 'merge_dequeued', 'merged_via_queue'
  ));

ALTER TABLE work_item_driver_events
  ADD COLUMN queue_entry_id text NULL
    CONSTRAINT work_item_driver_events_queue_entry_check CHECK (queue_entry_id ~ '^[A-Za-z0-9_=-]{1,100}$');
