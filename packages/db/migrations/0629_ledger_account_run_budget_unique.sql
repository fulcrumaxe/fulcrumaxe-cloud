-- D#2 H05b (correction C35, PM 2026-09-26): a run can never be settled
-- twice into the same budget. Source: PR #171 (D#2 H09b2) fix round 2
-- delta recheck, "3. Skipped unique constraint -- SHOULD, not a MUST":
--
--   The stated reason ("would break packages/db/test/kpi-views.test.ts")
--   is technically accurate ... But that's not evidence of a real
--   two-rows-per-(run,budget) product case ... A run legitimately having
--   both a model row and a compute row (two rows, two DIFFERENT budget
--   values) would NOT violate UNIQUE(account_id, run_id, budget) --
--   that's exactly the case the constraint is meant to allow. The only
--   thing that would collide is this one test fixture's own omission of
--   an explicit budget on its compute-kind insert ... SHOULD: fix
--   kpi-views.test.ts's ledgerRow helper to pass an explicit budget ...
--   then add the UNIQUE(account_id, run_id, budget) constraint in a
--   follow-up.
--
-- The blocker is fixed: PR #174 changed kpi-views.test.ts's ledgerRow
-- helper to pass an explicit budget on every insert. This migration adds
-- the constraint the recheck deferred.
--
-- Why no ON CONFLICT / DO NOTHING anywhere in application code: settle()
-- (packages/spend/src/settle.ts, settleWith) always runs under the same
-- per-(account,budget) `pg_advisory_xact_lock` reserve() itself takes
-- (packages/runner/src/targets/sandboxTarget.ts's meterModelUnderLock and
-- settleOrReleaseOpenRows both take it, then re-read spend_reservations
-- fresh INSIDE the lock before deciding to settle). Under that lock a
-- second settle of the same (account_id, run_id, budget) is already
-- impossible in the normal path -- the loser's fresh read sees 'settled'
-- (never 'open') and does nothing further (PR #171 fix round 2,
-- CWE-362/840). This constraint is a backstop against that invariant
-- ever breaking elsewhere, not a path any correct caller is expected to
-- hit -- so a violation must surface as a loud, unhandled 23505 rather
-- than being silently swallowed.
--
-- Pre-flight: fail loudly, not silently, if a database already carries
-- a duplicate this constraint would have to reject. This never deletes
-- or rewrites a money row -- it only refuses to proceed.
--
-- Fix round 1: the pre-flight below must exclude run_id IS NULL rows.
-- `GROUP BY account_id, run_id, budget` treats every NULL run_id as equal
-- to every other NULL for grouping purposes, so two or more legitimate
-- NULL-run ledger rows for the same (account_id, budget) collapsed into
-- one group with count(*) > 1 and aborted the migration -- even though
-- the UNIQUE constraint itself (below) treats NULLs as pairwise distinct
-- and would never reject them. `WHERE run_id IS NOT NULL` makes the
-- pre-flight check exactly the set of rows the constraint can actually
-- collide on.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count
  FROM (
    SELECT account_id, run_id, budget
    FROM ledger
    WHERE run_id IS NOT NULL
    GROUP BY account_id, run_id, budget
    HAVING count(*) > 1
  ) dups;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'migration 0629 aborted: % existing (account_id, run_id, budget) group(s) in ledger already have more than one row -- refusing to add the UNIQUE constraint or touch any existing ledger row. Investigate before re-running this migration.',
      dup_count;
  END IF;
END $$;

-- run_id IS NULL rows (a ledger entry not tied to a run) are unaffected:
-- Postgres treats NULL as distinct from every other NULL for uniqueness
-- purposes, so multiple NULL-run_id rows for the same account/budget
-- still insert freely.
ALTER TABLE ledger
  ADD CONSTRAINT ledger_account_run_budget_unique UNIQUE (account_id, run_id, budget);
