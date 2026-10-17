-- D#519 MQ3-a: a platform refresh records whether its merge brought in files the pull request also changed, and an entry records that
-- the step asked GitHub to refresh it.
--
-- head_refreshes (0824) says "the platform merged the default branch into the reviewed head, and we verified that merge". The merge
-- gate carries the reviewers' passes across such a row, but only when the files the pull request changed and the files the default
-- branch changed do not overlap (owner ruling Q1(b)). When they overlap NO pass carries across that hop: a delta review of the merge
-- commit supplies every pass the refreshed head needs. The gate runs without GitHub, so the answer has to be on the row.
--
-- The column defaults to true (overlapping): a row written without an answer carries nothing, never everything. Adding a column with a
-- constant default is expand-safe, and no writer of the table exists on main before this change, so there are no rows to backfill.
--
-- merge_queue_entries.refresh_requested_from is the head the step last asked GitHub to update the branch from (null: none, or cleared
-- because the request was refused). It is written by the slot holder before the update-branch call. A later step accepts a head it did
-- not leave behind as a possible refresh of ours only when this names the head it was on, so a commit the step never asked for cannot be
-- counted as one. Nullable, no default, no backfill, same SHA shape check as head_sha.
--
-- No grant changes: app_user keeps SELECT and INSERT on head_refreshes and SELECT, INSERT, UPDATE on merge_queue_entries (0824), and a
-- column added later is covered by those table-level grants. The entries guard trigger restricts only identity, counters and state moves.

ALTER TABLE head_refreshes ADD COLUMN files_overlap boolean NOT NULL DEFAULT true;

ALTER TABLE merge_queue_entries
  ADD COLUMN refresh_requested_from text CONSTRAINT merge_queue_entries_refresh_requested_check CHECK (refresh_requested_from ~ '^([0-9a-f]{40}|[0-9a-f]{64})$');
