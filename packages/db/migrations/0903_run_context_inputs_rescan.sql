-- D#601 MEM-RECALL-RESCAN: memory recall now checks each stored entry's text again against today's live secret values before it goes into a prompt.
-- This records, beside what the run WAS given (run_context_inputs), how many candidates that check left out and whether the check itself could not be made.
--
--   rescan_skipped     the number of entries left out because their stored text holds a credential shape or a live token (0 when none; counts only, never text).
--   rescan_unavailable true when the live-secrets source failed, so the run recalled no memory at all rather than unchecked text.
--
-- Same access as the rest of the table: app_user reads and inserts its own account's row; nothing updates or deletes. Expand only (two columns with
-- defaults, existing rows read 0 / false). Numbered 0903 (0901 and 0902 are held by queued PRs); re-check against main right before merging.

ALTER TABLE run_context_inputs
  ADD COLUMN rescan_skipped integer NOT NULL DEFAULT 0 CHECK (rescan_skipped BETWEEN 0 AND 100000),
  ADD COLUMN rescan_unavailable boolean NOT NULL DEFAULT false;

GRANT SELECT (rescan_skipped, rescan_unavailable) ON run_context_inputs TO app_user;
GRANT INSERT (rescan_skipped, rescan_unavailable) ON run_context_inputs TO app_user;
