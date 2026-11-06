-- D#6 SCOPE-IN-JOB: a check the runner did not run because the files its run changed fall outside the Spec's file list ends with the reason 'out_of_scope' (the runner
-- protocol's CHECK_NOT_RUN_REASONS gained it). The CHECK on run_checks.reason (0921) listed the earlier values only, so the insert for such a run would have failed.
-- The list below is every value of CHECK_NOT_RUN_REASONS; a test inserts each one against a real database so the two cannot drift again.
-- Numbered above the highest migration on main (1000). Re-check against main right before merging.
ALTER TABLE run_checks DROP CONSTRAINT run_checks_reason_check;
ALTER TABLE run_checks ADD CONSTRAINT run_checks_reason_check
  CHECK (reason IS NULL OR reason IN ('sandbox_unavailable', 'sandbox_refused', 'pin_failed', 'protected_unreadable', 'protected_changed', 'not_restored', 'start_failed', 'not_set_up', 'base_missing', 'agent_not_stopped', 'out_of_scope', 'other'));
