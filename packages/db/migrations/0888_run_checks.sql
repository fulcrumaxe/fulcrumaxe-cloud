-- D#6 R-CHK-3a (correction C47): what the runner's approved check did on a run, recorded when the runner reports `done`.
--
-- One row per run (the check runs once, after the agent's last turn). The row is a record of what happened, written once and never changed:
--   exit_code      the check's exit status; NULL when it never ran (no dev shell) or was killed at its cap (timed_out).
--   duration_ms    how long it ran; 0 when it never ran.
--   timed_out      it was killed at its own time cap.
--   skipped_tests  the test runner's skipped count when it printed one, NULL otherwise ("Not recorded" on screen, never 0).
--   summary        the last bytes of the output, redacted by the runner and again by the cloud; plain text, at most 4096 characters. Shown as text, never as markup.
-- Removed with its run (ON DELETE CASCADE). Rows are the run's own facts, so nothing here is derived state.
--
-- Who may touch it: row security is forced and tenant-scoped. app_user reads its own account's rows (the run view) and writes nothing. The runner login (a member
-- of agent_run_writer, as in 0697) may INSERT the five value columns for its own tenant and nothing else: no UPDATE, no DELETE, and no table-wide privilege
-- (0642's contract). The cloud writes the row inside the same transaction that ends the run, so a run that is `failed check_failed` always has its row.
--
-- Numbered above the highest migration claimed (0887 is #384). Re-check against main and the open PRs right before merging.
CREATE TABLE run_checks (
  account_id    uuid NOT NULL,
  run_id        uuid NOT NULL,
  exit_code     integer CHECK (exit_code IS NULL OR exit_code BETWEEN -1000000 AND 1000000),
  duration_ms   bigint NOT NULL CHECK (duration_ms BETWEEN 0 AND 604800000),
  timed_out     boolean NOT NULL,
  skipped_tests integer CHECK (skipped_tests IS NULL OR skipped_tests BETWEEN 0 AND 100000000),
  summary       text NOT NULL CHECK (char_length(summary) <= 4096),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, run_id),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE,
  -- A killed check has no exit status of its own.
  CHECK (NOT timed_out OR exit_code IS NULL)
);

ALTER TABLE run_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_checks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON run_checks FROM PUBLIC;

GRANT SELECT ON run_checks TO app_user;
CREATE POLICY tenant_isolation ON run_checks FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

GRANT INSERT (account_id, run_id, exit_code, duration_ms, timed_out, skipped_tests, summary) ON run_checks TO agent_run_writer;
CREATE POLICY runner_insert ON run_checks FOR INSERT TO agent_run_writer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
