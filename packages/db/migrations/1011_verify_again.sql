-- D#749: a person's "Verify again" on a finished post-merge check.
--
-- A merge had exactly one verify row (verify_rows_one_per_merge), and a finished row is final, so a check that ended `unverified` or `failed` could only be re-run by
-- waiting for a whole new build. A re-run is a NEW row for the same merge commit; the old row stays as history and never changes. This migration makes room for it.
--
--   * `attempt`: which try of this merge the row is (1 for every row that exists, 2 for the first "Verify again", and so on). It is written once, at insert; app_user is
--     granted INSERT on it and no UPDATE, so it cannot move afterwards. The streak reads `attempt > 1` as a person's step, so no flag is stamped on the row: the fact is
--     derived, and cannot be forgotten or taken back.
--   * the unique key widens from (account, item, merge) to (account, item, merge, attempt), so two rows of one merge need different attempts.
--   * a partial unique index keeps at most ONE unfinished row per merge, so two people pressing at once (or a press during a running check) cannot open a second.
--
-- Expand only: one column with a default, one constraint swapped for a wider one, one index. Existing rows take attempt 1. The column is insertable by app_user, like the
-- identity columns beside it (1003); verify_rows_guard (1003/1009) is unchanged.
ALTER TABLE verify_rows ADD COLUMN attempt integer NOT NULL DEFAULT 1 CONSTRAINT verify_rows_attempt_check CHECK (attempt BETWEEN 1 AND 1000);
ALTER TABLE verify_rows DROP CONSTRAINT verify_rows_one_per_merge;
ALTER TABLE verify_rows ADD CONSTRAINT verify_rows_one_per_attempt UNIQUE (account_id, work_item_id, merge_sha, attempt);
CREATE UNIQUE INDEX verify_rows_one_unfinished_per_merge ON verify_rows (account_id, work_item_id, merge_sha) WHERE status IN ('pending', 'deploying', 'running');
GRANT INSERT (attempt) ON verify_rows TO app_user;
