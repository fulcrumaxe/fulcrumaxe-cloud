-- D#600 CX-9b (server row): how full a run's context window is, stored once so the run page and the item card can show it for a live run and for an ended one.
--
-- run_context_figure holds one row per run:
--   last_context_tokens  the context of the run's latest main-thread turn (input + cache read + cache write), in tokens. Not the peak: after a compaction it falls.
--   window_tokens        the model's context window in tokens as the price table gave it when the figure was written; NULL when the model has no window figure
--                        ("window not known for this model" on screen; the percent is then not worked out, never guessed).
-- The percent is derived when it is read (floor(last * 100 / window), at most 100); it is not a column, so it can never disagree with the two numbers.
-- A later write replaces both values (the latest turn is the current figure). A run that never reported usage has no row ("Not recorded"); a row is never 0 by default.
-- Removed with its run (ON DELETE CASCADE). Integers only: no prompt text, path or tool input.
--
-- It is a separate table from run_context_ledger on purpose: that row is written once per command at the end and its `basis` can only get weaker when merged, so a figure
-- written during the run must not create or change it.
--
-- Who may touch it: row security is forced and tenant-scoped. app_user reads its own account's rows and writes nothing. The runner login (a member of agent_run_writer, as in
-- 0888) may INSERT the value columns and UPDATE them for its own tenant, and read the two key columns to find its row: column grants only, no DELETE and no table-wide
-- privilege (0642's contract). There is no function here, so nothing new is SECURITY DEFINER.
--
-- Numbered 0989 (0987 is held by #741, 0988 by another change); re-check against main right before merging, and migrations merge in number order.
CREATE TABLE run_context_figure (
  account_id          uuid NOT NULL,
  run_id              uuid NOT NULL,
  last_context_tokens bigint NOT NULL CHECK (last_context_tokens BETWEEN 0 AND 1000000000000),
  window_tokens       bigint CHECK (window_tokens IS NULL OR window_tokens BETWEEN 1 AND 10000000),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, run_id),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE
);

ALTER TABLE run_context_figure ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_context_figure FORCE ROW LEVEL SECURITY;
REVOKE ALL ON run_context_figure FROM PUBLIC;

GRANT SELECT ON run_context_figure TO app_user;
CREATE POLICY tenant_isolation ON run_context_figure FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

GRANT SELECT (account_id, run_id) ON run_context_figure TO agent_run_writer;
GRANT INSERT (account_id, run_id, last_context_tokens, window_tokens) ON run_context_figure TO agent_run_writer;
GRANT UPDATE (last_context_tokens, window_tokens, recorded_at) ON run_context_figure TO agent_run_writer;
CREATE POLICY runner_select ON run_context_figure FOR SELECT TO agent_run_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_insert ON run_context_figure FOR INSERT TO agent_run_writer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_update ON run_context_figure FOR UPDATE TO agent_run_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
