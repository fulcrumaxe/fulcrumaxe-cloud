-- D#483 S5-k2: the reconcile job that re-validates a model connection recorded as broken for out-of-credit
-- (`status = 'broken'`, `last_error_code = 'credits_exhausted'`). A reconcile job with no reconcile_jobs row is never due, so
-- this row is what puts the job on the 15-minute cron's schedule (15 minutes; the runner starts the next pass up to a tenth of
-- the interval early, so a 15-minute tick always finds it due).
--
-- Expand-only and safe to re-run (ON CONFLICT on the name, the table's primary key): one INSERT into a table only the reconciler reads, no column, constraint or privilege
-- change. The old code ignores a row for a job it does not know; the new code finds it. The column `last_error_code` is free
-- text and takes the new word without a change.
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('model_credits_revalidate', 15 * 60) ON CONFLICT (name) DO NOTHING;
