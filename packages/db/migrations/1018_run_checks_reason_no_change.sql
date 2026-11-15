-- D#6 RUNNER-CHECK-SKIP-NO-COMMIT: a check the runner did not run because the fix round's branch tip is still the commit it started from ends with the reason 'no_change'
-- (the runner protocol's CHECK_NOT_RUN_REASONS gained it). The CHECK on run_checks.reason (1001) listed the earlier values only, so the insert for such a run would have failed.
-- The list below is every value of CHECK_NOT_RUN_REASONS. Numbered 1018 by the Team Lead (1017 is claimed by another lane). Re-check against main right before merging.
ALTER TABLE run_checks DROP CONSTRAINT run_checks_reason_check;
ALTER TABLE run_checks ADD CONSTRAINT run_checks_reason_check
  CHECK (reason IS NULL OR reason IN ('sandbox_unavailable', 'sandbox_refused', 'pin_failed', 'protected_unreadable', 'protected_changed', 'not_restored', 'start_failed', 'not_set_up', 'base_missing', 'agent_not_stopped', 'out_of_scope', 'no_change', 'other'));
