-- D#6 R5b-2a (correction C38 section 1): reviews of a cloud-verified pull request run in our sandbox, on the customer's key, after a quiet period.
--
-- 1. A reviewer run of a 'runner_verified' repository is a sandbox run: it is stamped runtime = 'production', which is how the merge gate
--    tells a verdict it may count from a runner's (D#2 C11). 0765 said every 'runner_verified' run has runtime 'runner', which was right
--    while no such repository could run a reviewer. The check now allows exactly one other shape: runtime 'production' for the four reviewer
--    roles. Any other role, and any other runtime, is still refused. A runner run still never has a 'production' runtime.
--
-- 2. The quiet period needs the time of the newest push to a pull request. Nothing stored it. It is one new fact kind of the stage driver's own
--    append-only record (work_item_driver_events, 0709): 'pr_head_pushed', carrying the head commit and the pull request number. That table's
--    created_at is stamped by a trigger with the database clock whatever an insert says, no role can update or delete a row, and a
--    replay of the same head is a no-op by the table's unique key, so a delivery cannot move a time that was already recorded. The
--    due time of a review is derived from these rows and the executor run's own ended_at; it is never stamped anywhere.
--
-- Numbered by the Team Lead (0772), above 0771 (R5b-1). Re-check against main right before merging (C7 section 4).

ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_runner_verified_runtime_check;
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_runner_verified_runtime_check
  CHECK (
    execution_mode IS DISTINCT FROM 'runner_verified'
    OR runtime = 'runner'
    OR (runtime = 'production' AND role IN ('code-reviewer', 'security-reviewer', 'acceptance-tester', 'debater'))
  );

ALTER TABLE work_item_driver_events DROP CONSTRAINT work_item_driver_events_kind_check;
ALTER TABLE work_item_driver_events
  ADD CONSTRAINT work_item_driver_events_kind_check CHECK (kind IN (
    'build_refused', 'review_started', 'security_review_required', 'review_verdicts',
    'fix_round_started', 'fix_round_refused', 'fix_pushed_nothing', 'fix_round_failed', 'escalated',
    'review_status', 'merge_gate', 'merged_by_gate', 'stopped', 'pr_head_pushed'
  ));
