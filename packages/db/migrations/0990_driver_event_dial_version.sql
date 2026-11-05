-- D#7 DW-R4: the merge dial's version, recorded on the gate's own facts.
--
-- A merge by policy is receipted with the dial that decided it. For a pull request the gate put into GitHub's queue, the receipt is written later (webhook or
-- reconcile), so it re-read the dial "as it stood at the enqueue fact's time": the newest row with created_at <= that time. A dial row written by a transaction
-- that started before the decision and committed after it carries an earlier created_at (now() is the transaction's start), so it was picked up by that re-read
-- although the gate never saw it. The receipt then named a version the decision did not use.
--
-- The fix is to write down what the gate read. `dial_version` is a plain nullable integer on work_item_driver_events: the version of `merge_after_reviews` the
-- gate read when it wrote this fact (0 = no row, the catalogue default). Only the merge gate's own facts carry it (merge_gate, merged_by_gate, merge_enqueued: the
-- application writes it on those kinds alone); NULL for every older row and every other kind, which keep the old time-based read.
--
-- Accepted risk (the same one 0983 states for its facts): app_user can insert this table, so a caller with the app login could write a false version; the receipt
-- function still checks the version against the repository's own versions and the word it names, so a false one can only name a version that existed.
--
-- Additive and append-only like the rest of the table: one nullable column with a range check, and only on the gate's own kinds. The table-level grant (SELECT and INSERT for app_user) already
-- covers a new column, so no grant moves; merge_receipt_write reads no dial version from this table and needs no new privilege. Rolling the code back leaves a NULL column.

ALTER TABLE work_item_driver_events
  ADD COLUMN dial_version integer NULL
    CONSTRAINT work_item_driver_events_dial_version_check CHECK (dial_version IS NULL OR (dial_version >= 0 AND kind IN ('merge_gate', 'merged_by_gate', 'merge_enqueued')));
