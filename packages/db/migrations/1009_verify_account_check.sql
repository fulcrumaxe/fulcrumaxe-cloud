-- D#749 V4b fix: the proof of the account check, stored on the row.
--
-- The stage judges the signed-in account when it settles a row (pipeline's outcomeFromAnswer): `matched` when the repository names a test account and the
-- trusted verify server recorded exactly that account, `mismatch` for `unverified: wrong_account`, `unverifiable` for `unverified: account_unverifiable`. The card must
-- say what was checked at the time, not what the repository's settings say now (a label set later, or a run on a method that never checked the account). So the
-- word is written once, by the move that finishes the row, and read back as it is. NULL means the account was not judged (no test account was set, or the row ended
-- for another reason before the check).
--
-- Expand only: one nullable column with a closed-value check, and the column grant the stage's UPDATE already has for the other verdict columns. Rows finished before this
-- migration keep NULL. verify_rows_guard (1003) is replaced whole; the only differences from its 1003 body are the two account_check lines: a finished row does not change
-- it, and a row that is not finishing does not set it.
ALTER TABLE verify_rows ADD COLUMN account_check text NULL
  CONSTRAINT verify_rows_account_check_check CHECK (account_check IN ('matched', 'mismatch', 'unverifiable'));
GRANT UPDATE (account_check) ON verify_rows TO app_user;

CREATE OR REPLACE FUNCTION verify_rows_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.repo_id IS DISTINCT FROM OLD.repo_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
     OR NEW.merge_sha IS DISTINCT FROM OLD.merge_sha OR NEW.journeys IS DISTINCT FROM OLD.journeys OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'verify_rows: identity and journeys are fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('verified', 'failed', 'unverified') THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.method IS DISTINCT FROM OLD.method OR NEW.deployed_commit IS DISTINCT FROM OLD.deployed_commit
       OR NEW.result IS DISTINCT FROM OLD.result OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
       OR NEW.deploy_by_order IS DISTINCT FROM OLD.deploy_by_order OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
       OR NEW.account_check IS DISTINCT FROM OLD.account_check THEN
      RAISE EXCEPTION 'verify_rows: a finished row does not change' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('pending', 'deploying', 'unverified'))
         OR (OLD.status = 'deploying' AND NEW.status IN ('deploying', 'running', 'unverified'))
         OR (OLD.status = 'running' AND NEW.status IN ('running', 'verified', 'failed', 'unverified'))) THEN
      RAISE EXCEPTION 'verify_rows: % -> % is not a move', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status NOT IN ('verified', 'failed', 'unverified')
       AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.reason_code IS DISTINCT FROM OLD.reason_code OR NEW.finished_at IS DISTINCT FROM OLD.finished_at OR NEW.account_check IS DISTINCT FROM OLD.account_check) THEN
      RAISE EXCEPTION 'verify_rows: the verdict is written only by the move that finishes the row' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Who gave the deploy order is fixed when the deploy starts.
  IF NEW.deploy_by_order IS DISTINCT FROM OLD.deploy_by_order AND NOT (OLD.status = 'pending' AND NEW.status = 'deploying') THEN
    RAISE EXCEPTION 'verify_rows: deploy_by_order is set only when the deploy starts' USING ERRCODE = 'check_violation';
  END IF;
  -- What drove the run, against which commit, and since when, is fixed when the run starts. A run id may only be cleared afterwards (by the foreign key).
  IF NOT (OLD.status = 'deploying' AND NEW.status = 'running')
     AND (NEW.method IS DISTINCT FROM OLD.method OR NEW.deployed_commit IS DISTINCT FROM OLD.deployed_commit OR NEW.started_at IS DISTINCT FROM OLD.started_at
          OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'verify_rows: method, deployed commit, start and run are set only when the run starts' USING ERRCODE = 'check_violation';
  END IF;
  -- A person step is a fact: it only goes up.
  IF OLD.person_step AND NOT NEW.person_step THEN
    RAISE EXCEPTION 'verify_rows: a person step is not taken back' USING ERRCODE = 'check_violation';
  END IF;
  -- The bug item: set once, on a failed row; cleared only by the foreign key's own action (a nested trigger), never by a statement.
  IF NEW.bug_item_id IS DISTINCT FROM OLD.bug_item_id THEN
    IF NEW.bug_item_id IS NULL THEN
      IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'verify_rows: the bug item is not cleared' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD.status <> 'failed' OR OLD.bug_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'verify_rows: the bug item is set once, on a failed row' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
