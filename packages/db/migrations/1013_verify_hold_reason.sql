-- D#749: why a post-merge check is waiting, kept on its row.
--
-- A `deploying` row whose tester job cannot start (the cost figures are not set, the per-run figure is above the daily one, the repository's daily budget is used) was only
-- held and logged, so the card could say nothing better than "Waiting to start". The stage now writes the CURRENT hold onto the row, and the card says why.
--
--   * `hold_reason`: one closed word, `unconfigured`, `run_over_daily` or `daily_cap`. NULL means the row is not held for one of these.
--   * `hold_since`: when that reason was first written; it moves only when the reason changes, so "since" is the start of THIS wait, not the last tick.
--   * the two are both set or both NULL, and only a row that has not started (`pending`, `deploying`) may carry them: every move to `running` or to a finished state writes both back
--     to NULL in the same statement, and the table refuses a row that still has one. A stale reason therefore cannot outlive the wait, whoever writes.
--
-- Expand only: two nullable columns and three checks. Existing rows take NULL. The stage's UPDATE gets a column grant on these two and nothing else of the row changes.
-- verify_rows_guard (1003/1009) is unchanged: it protects identity, the verdict and the one-way moves, none of which these columns are, and the third check above is what keeps a
-- reason off a row that has started or finished.
ALTER TABLE verify_rows ADD COLUMN hold_reason text NULL CONSTRAINT verify_rows_hold_reason_check CHECK (hold_reason IN ('unconfigured', 'run_over_daily', 'daily_cap'));
ALTER TABLE verify_rows ADD COLUMN hold_since timestamptz NULL;
ALTER TABLE verify_rows ADD CONSTRAINT verify_rows_hold_pair CHECK ((hold_reason IS NULL) = (hold_since IS NULL));
ALTER TABLE verify_rows ADD CONSTRAINT verify_rows_hold_unstarted CHECK (hold_reason IS NULL OR status IN ('pending', 'deploying'));
GRANT UPDATE (hold_reason, hold_since) ON verify_rows TO app_user;
