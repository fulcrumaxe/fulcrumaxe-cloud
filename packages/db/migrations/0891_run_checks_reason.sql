-- D#6 R-CHK-3d: why a run's approved check could not run safely, as a closed code beside the summary.
--
-- Optional: NULL for a runner that does not send one (protocol 8 stays as it is) and for every row recorded before this migration. The values are the runner protocol's
-- CHECK_NOT_RUN_REASONS; the cloud maps any word outside the set to 'other' before it writes, and the CHECK below refuses anything else, so a free-text value cannot be stored.
-- A row with a reason is a check that was not run safely (or whose result does not count); the Runs detail words it from the code, not from the summary.
--
-- Same rights as the other value columns (0888): the runner login may INSERT it, nothing may UPDATE it. Numbered above the highest migration on main (0889) and the one another open pull request claims (0890).
-- Re-check against main and the open PRs right before merging.
ALTER TABLE run_checks
  ADD COLUMN reason text
  CHECK (reason IS NULL OR reason IN ('sandbox_unavailable', 'sandbox_refused', 'pin_failed', 'protected_unreadable', 'protected_changed', 'not_restored', 'start_failed', 'not_set_up', 'base_missing', 'other'));

GRANT INSERT (reason) ON run_checks TO agent_run_writer;
