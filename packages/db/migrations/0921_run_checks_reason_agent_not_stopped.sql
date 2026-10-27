-- D#6 RUNNER-HOSTREAD-FOLLOWUPS-527: a check the runner did not run because it could not stop the agent first ends with the reason 'agent_not_stopped' (the runner
-- protocol's CHECK_NOT_RUN_REASONS gained it). The CHECK on run_checks.reason (0891) listed the earlier values only, so the insert for such a run would have failed.
-- The list below is every value of CHECK_NOT_RUN_REASONS; a test inserts each one against a real database so the two cannot drift again.
-- Numbered above the highest migration on main (0920). Re-check against main right before merging.
ALTER TABLE run_checks DROP CONSTRAINT run_checks_reason_check;
ALTER TABLE run_checks ADD CONSTRAINT run_checks_reason_check
  CHECK (reason IS NULL OR reason IN ('sandbox_unavailable', 'sandbox_refused', 'pin_failed', 'protected_unreadable', 'protected_changed', 'not_restored', 'start_failed', 'not_set_up', 'base_missing', 'agent_not_stopped', 'other'));
