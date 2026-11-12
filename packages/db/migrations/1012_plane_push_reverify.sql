-- D#6 PLANE-PUSH-REVERIFY-BOUND: a push report GitHub did not confirm can be checked again, but only against what that same attempt reported.
--
-- A runner's push report that the hosted side could not confirm (the branch head, or the pull request, was not there yet) ends the attempt as `report_mismatch` and the
-- push row as `refused`. GitHub can be seconds behind, so a later check may find the push after all. That check must be tied to the run's own push: a refused row must
-- not become "pushed" because of some other run's head, a head the runner now names, or a branch somebody else moved.
--
-- Four nullable columns on the attempt hold what the refused report named, set once at the finish that records `report_mismatch`, and only for the two checks a later read of
-- GitHub can change (the head was not found, the pull request was not found). The pull request number is kept for the second only, so a check made later (by the merge gate,
-- with no report in hand) reads the pull request the report named. The other refusals (pairing digest, no grant, wrong branch, update state, pull request address)
-- are the runner's own and are never checked again, so they store nothing. The head, tip and check are set together or not at all.
--
-- Expand only: existing rows keep all four null; nothing is dropped. Numbered above the highest migration on the code plane (1011);
-- re-checked right before merge.

ALTER TABLE plane_push_attempts
  ADD COLUMN refused_head_sha text CONSTRAINT plane_push_attempts_refused_head_check CHECK (refused_head_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN refused_tip_sha  text CONSTRAINT plane_push_attempts_refused_tip_check CHECK (refused_tip_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN refused_check    text CONSTRAINT plane_push_attempts_refused_check_check CHECK (refused_check IN ('head_unconfirmed', 'pr_unconfirmed')),
  ADD COLUMN refused_pr_number integer CONSTRAINT plane_push_attempts_refused_pr_check CHECK (refused_pr_number > 0);

ALTER TABLE plane_push_attempts ADD CONSTRAINT plane_push_attempts_refused_shape CHECK (
  (refused_head_sha IS NULL AND refused_tip_sha IS NULL AND refused_check IS NULL)
  OR (refused_head_sha IS NOT NULL AND refused_tip_sha IS NOT NULL AND refused_check IS NOT NULL)
);

-- The number is there exactly for a pr_unconfirmed check.
ALTER TABLE plane_push_attempts ADD CONSTRAINT plane_push_attempts_refused_pr_shape CHECK (
  CASE WHEN refused_check = 'pr_unconfirmed' THEN refused_pr_number IS NOT NULL ELSE refused_pr_number IS NULL END
);

-- Set once, at the finish that records `report_mismatch`; never changed or cleared after.
CREATE OR REPLACE FUNCTION plane_push_attempts_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.plane_push_id IS DISTINCT FROM OLD.plane_push_id
     OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL) OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation
     OR NEW.runtime IS DISTINCT FROM OLD.runtime OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'plane_push_attempts: identity is fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.token_issued_at IS NOT NULL AND NEW.token_issued_at IS DISTINCT FROM OLD.token_issued_at THEN
    RAISE EXCEPTION 'plane_push_attempts: the token issue time is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.refused_check IS NOT NULL THEN
    IF NEW.refused_check IS DISTINCT FROM OLD.refused_check OR NEW.refused_head_sha IS DISTINCT FROM OLD.refused_head_sha OR NEW.refused_tip_sha IS DISTINCT FROM OLD.refused_tip_sha OR NEW.refused_pr_number IS DISTINCT FROM OLD.refused_pr_number THEN
      RAISE EXCEPTION 'plane_push_attempts: the refused report is set once' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.refused_check IS NOT NULL THEN
    IF OLD.finished_at IS NOT NULL OR NEW.finished_at IS NULL OR NEW.outcome IS DISTINCT FROM 'report_mismatch' THEN
      RAISE EXCEPTION 'plane_push_attempts: the refused report is set when the attempt ends as report_mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- A row is born without a refused report: it is only ever set by the finish that records `report_mismatch` (an UPDATE, guarded above).
CREATE FUNCTION plane_push_attempts_no_refused_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.refused_check IS NOT NULL OR NEW.refused_head_sha IS NOT NULL OR NEW.refused_tip_sha IS NOT NULL OR NEW.refused_pr_number IS NOT NULL THEN
    RAISE EXCEPTION 'plane_push_attempts: a refused report cannot be set when the attempt is created' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plane_push_attempts_no_refused_insert BEFORE INSERT ON plane_push_attempts
  FOR EACH ROW EXECUTE FUNCTION plane_push_attempts_no_refused_insert();
REVOKE ALL ON FUNCTION plane_push_attempts_no_refused_insert() FROM PUBLIC;
