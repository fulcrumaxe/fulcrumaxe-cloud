-- D#2 H14c-1, correction C38 item S-A, design (a) (idempotent dispatch).
--
-- The merge gate (packages/pipeline/src/build/mergeGate.ts) takes the row
-- with the newest `created_at` as a role's latest verdict, and `created_at`
-- is stamped when a row is inserted as `pending`, not when the run ends. Two
-- LIVE runs of one reviewer role on one head could therefore finish in the
-- opposite order to their dispatch: B (newer) passes first, A (older) ends
-- with a needs-fix, and the gate reads B's pass. The gate's own zero-row
-- "request the reviews" path can dispatch twice when two gate invocations
-- race on a new head.
--
-- Fix: at most one live (pending, running or paused) row per account, work
-- item, head SHA and reviewer role, enforced by the database. A second
-- dispatch while one is live fails this index; the dispatch helper in
-- packages/pipeline/src/build/stageMachine.ts turns that unique violation
-- into an "already dispatched" outcome that names the live run, so the gate
-- never errors on it. Once the live run is terminal a NEW run is allowed, so
-- a legitimate re-review after a needs-fix is unaffected.
--
-- The live set is the gate's own NON_TERMINAL_STATUSES (the CHECK on
-- `status` in 0642 makes those the only non-terminal values). The roles are
-- the gate's ALL_GATED_ROLES. NULL work_item_id / head_sha rows are never
-- constrained (a UNIQUE index treats NULLs as distinct), and the gate never
-- reads such rows either (it filters on both).
CREATE UNIQUE INDEX agent_runs_one_live_reviewer_per_head
  ON agent_runs (account_id, work_item_id, head_sha, role)
  WHERE role IN ('code-reviewer', 'security-reviewer', 'acceptance-tester', 'debater')
    AND status IN ('pending', 'running', 'paused');
