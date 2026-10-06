-- D#2 H09b2, correction C21 item 2 (PR #85's final security review,
-- should-fix 1; CWE-672/770): "Two live executor runs on one account,
-- repo and PR share one sandbox name. A cancel racing dispatch can then
-- leave the older agent running: the reviewer's log was 'I1 create, I2
-- stop, R2 create, R2 start, I1 start'."
--
-- Fix: at most one `agent_runs` row with role 'executor' and status in
-- ('pending', 'running') per (account_id, dispatch_repo_id,
-- dispatch_pr_number). `startAgentRun`'s own INSERT (runStatusWriter.ts)
-- is the only writer of these columns (0605_execution_mode.sql's
-- write-once trigger), so a second concurrent executor start for the
-- same PR fails this index at INSERT time, with no separate application
-- check needed -- `insertAgentRun` translates the unique-violation into
-- a typed `DuplicateExecutorRunError`.
--
-- Partial (WHERE role = 'executor' AND status IN ('pending', 'running')):
-- every other role, and every terminal executor run, is unconstrained --
-- a fix round's OWN new run only ever conflicts with an executor run that
-- is still live on the SAME PR, never with a finished one.
--
-- `dispatch_repo_id`/`dispatch_pr_number` are both NULLable
-- (0605_execution_mode.sql), and a UNIQUE index treats NULL as distinct
-- from every other NULL -- an executor row with no persisted dispatch
-- identity (a pre-migration row) is therefore never constrained by this
-- index. That is the same fail-open-on-absence shape 0605's own columns
-- already chose (see that migration's header), not a new one.
CREATE UNIQUE INDEX agent_runs_one_live_executor_per_pr
  ON agent_runs (account_id, dispatch_repo_id, dispatch_pr_number)
  WHERE role = 'executor' AND status IN ('pending', 'running');
