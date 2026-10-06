-- D#2 H14c-5d guard: at most one live continuation per parent run.
--
-- The continue path (packages/pipeline/src/build/continuation.ts) serialises
-- deciders with an advisory lock, but that lock is held on a separate
-- connection. If that session dies in the few milliseconds after the lock is
-- taken and before the child row is written, a second continue can decide at
-- the same time. For a seat other than the executor (which has its own
-- live-run check) two continues with different request ids then both
-- started a run.
--
-- Fix: the database refuses the second child. At most one row per account and
-- parent run whose status is live: pending, running or paused. Those are the
-- non-terminal values allowed by the CHECK on `status` in 0642; every
-- terminal value (refused_spend, succeeded, failed, timed_out, killed_spend,
-- cancelled) is left out, so a refused-for-spend attempt never blocks a later
-- one and a finished child never blocks anything. Rows without a parent are
-- never constrained.
--
-- `role` is part of the key because `parent_run_id` is also how a parent run
-- (a planning panel) links its many concurrent children, one per seat. A
-- continuation always relaunches the parent's own seat, so the same role under
-- the same parent is the continuation, and other roles stay free to run side
-- by side.
--
-- The continue path turns this index's unique violation into its `duplicate`
-- outcome.
--
-- Existing data: the index cannot be built over two live children of one
-- parent, and quietly picking one to cancel is not this migration's call. So
-- it checks first and fails with a message that says how many parents are
-- affected, rather than with an opaque index-build error.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM agent_runs
     WHERE parent_run_id IS NOT NULL AND status IN ('pending', 'running', 'paused')
     GROUP BY account_id, parent_run_id, role HAVING count(*) > 1
  ) dup;
  IF n > 0 THEN
    RAISE EXCEPTION '% parent run seat(s) have more than one live continuation; resolve them before this migration', n;
  END IF;
END $$;

CREATE UNIQUE INDEX agent_runs_one_live_continuation_per_parent
  ON agent_runs (account_id, parent_run_id, role)
  WHERE parent_run_id IS NOT NULL AND status IN ('pending', 'running', 'paused');
