-- D#2605 H05: spend reservation, metering and caps.
--
-- This migration is deliberately small. The reserve/meter/settle business
-- logic (the four denial reasons, the foreground/background independence,
-- Scale's per-repo background shape) lives in plain TypeScript in
-- packages/spend/src -- per the Spec's own implementation note to keep SQL
-- thin and put logic in plain functions. What actually needs to live in
-- the database is the schema this task's amendments require, and one
-- enforcement trigger that no TypeScript-level check can substitute for.
--
-- Three additions:
--
-- 1. `budget` on spend_reservations and ledger. The H05 amendment (posted
--    2026-09-17, binding) split compute into two independent budgets
--    (foreground: customer-initiated work; background: the scheduled
--    loop and its analysts) alongside the existing model-spend budget,
--    and requires "every reservation and ledger row records which budget
--    it drew on." Neither table had anywhere to record that. NOT NULL
--    with a default of 'model': a default is required so the H02 test
--    fixtures that already INSERT into these two tables without knowing
--    about `budget` (packages/db/test/helpers/seed.ts -- out of this
--    task's file scope, so not touched here) keep working unchanged.
--    packages/spend always sets it explicitly; the default only matters
--    to code outside H05's scope.
--
-- 2. A CHECK constraint on spend_reservations.state, plus a trigger
--    enforcing legal transitions. This is criterion A8 of the H02/H03
--    security-review amendment: "H05 owns spend_reservations.state...
--    each owning task defines the legal values and transitions in one
--    place and tests that an illegal transition is refused." The values
--    are 'open' (just reserved), 'settled' (settle() wrote ledger rows
--    for actual usage) and 'released' (cancelled with no usage, e.g. a
--    run that never started billable work). The only legal transitions
--    are open -> settled and open -> released; settled/released are
--    terminal. This has to be a trigger, not just app-level discipline in
--    packages/spend: app_user already has ordinary UPDATE on this table
--    (H02 grant, since settle/release IS an ordinary tenant-visible state
--    transition), so nothing but a trigger stops a direct SQL UPDATE from
--    making an illegal jump (e.g. settled -> open, which would let a
--    settled reservation's dollars re-enter the "open" aggregate a
--    concurrent reserve() call sums over).
--
-- 3. Nothing else. In particular this migration does not touch `accounts`
--    -- H05's own reserve/meter/settle logic only ever needs SELECT on
--    accounts.status and the two existing cap columns, which app_user
--    already has (migrations/0001_core.sql). Criterion A3 ("every cap
--    check and status transition runs as platform_ops... app_user has no
--    INSERT or UPDATE on accounts at all") is already fully enforced by
--    0001's GRANTs; H05 adds no write path to accounts and its own test
--    suite (packages/spend/test/accounts-privileges.test.ts) confirms
--    that boundary from this task's side rather than re-granting or
--    re-restricting anything here.

ALTER TABLE spend_reservations
  ADD COLUMN budget text NOT NULL DEFAULT 'model'
    CHECK (budget IN ('model', 'foreground_compute', 'background_compute'));

ALTER TABLE ledger
  ADD COLUMN budget text NOT NULL DEFAULT 'model'
    CHECK (budget IN ('model', 'foreground_compute', 'background_compute'));

ALTER TABLE spend_reservations
  ADD CONSTRAINT spend_reservations_state_check
    CHECK (state IN ('open', 'settled', 'released'));

CREATE FUNCTION spend_reservations_check_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state = 'open' AND NEW.state IN ('settled', 'released') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal spend_reservations.state transition: % -> %', OLD.state, NEW.state
    USING ERRCODE = 'check_violation';
END;
$$;

-- Fires for every UPDATE that changes state, for every role -- app_user's
-- ordinary UPDATE grant and platform_ops's unconditional access alike.
-- Postgres triggers are not bypassed by role privilege the way RLS can be
-- bypassed by BYPASSRLS; there is no equivalent "skip this trigger" flag
-- either role holds.
CREATE TRIGGER spend_reservations_state_transition
  BEFORE UPDATE OF state ON spend_reservations
  FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION spend_reservations_check_transition();
