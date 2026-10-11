-- D#605 FL-3: the two partial indexes the runner claim reads through, so a claim poll stays flat as an account's history of finished runs grows.
--
--   agent_runs_claim_pending   (account_id, created_at, id) WHERE status = 'pending' AND runtime = 'runner' AND runner_id IS NULL
--                              The candidate query of the claim (runnerClaims.ts) and the queued-run probe behind its idle answer both start from "this
--                              account's pending runner runs nobody holds". Only those rows are in the index, so it holds the queue and never the history.
--   agent_runs_claim_running   (account_id, runner_id) WHERE status = 'running'
--                              The per-runner running count (what a runner holds, per class) that the claim and the runner list take on every poll.
--                              Only rows that are running now are in it. 0711's idx_agent_runs_runner_id covers every row that ever had a runner,
--                              finished ones included, which is the history the claim must not walk.
--
-- Indexes only: no table, column, grant, policy, role or function changes, so platform_ops gains nothing and nothing about who may read or write
-- agent_runs moves. Both predicates are written exactly as the queries write theirs, which is what lets the planner pick them.
--
-- Numbered above the highest migration on the code plane (0784 is held by another open change). Re-check against main right before merging.
CREATE INDEX agent_runs_claim_pending ON agent_runs (account_id, created_at, id) WHERE status = 'pending' AND runtime = 'runner' AND runner_id IS NULL;
CREATE INDEX agent_runs_claim_running ON agent_runs (account_id, runner_id) WHERE status = 'running';
