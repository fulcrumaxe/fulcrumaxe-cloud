-- D#483: a proposal sent back to be checked starts a new key space for its verifier run.
--
-- The verifier's run is keyed by proposal id, a hash of its text and the attempt count (`proposal-verify:<id>:<hash8>:<attempts>`), and a run
-- started on a key can never be started again. proposal_requeue_verification (0861, 0904, 0918) resets the attempt count to 0, and a real verdict
-- resets it to 0 too, so a proposal checked once and sent back with the same text (the product label taken off and put on again, 0992) met the
-- run it already had on attempt 0: the sweep listed it, found that run, and either re-recorded its old answer or waited on it, and never started
-- the run the re-check was for. verify_requeues counts the times the proposal was sent back; the sweep adds it to the key from the first re-queue
-- on (0 leaves the key exactly as before, so no existing key changes). Stamped, not derived: nothing else records how many times it was sent back.
--
-- Expand-only: a column with a default and a function with the same name and signature, so the previous deploy runs on this schema (it keeps the
-- old key space). Numbered above main's highest (0993); re-checked before merge. Body of the function as in 0918 plus the increment. Ownership
-- bracket as in 0861.

ALTER TABLE proposals
  ADD COLUMN verify_requeues integer NOT NULL DEFAULT 0 CONSTRAINT proposals_verify_requeues_check CHECK (verify_requeues >= 0);
GRANT SELECT (verify_requeues), UPDATE (verify_requeues) ON proposals TO proposal_verification_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'proposal_verification_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on proposal_verification_definer; cannot ALTER FUNCTION ... OWNER TO proposal_verification_definer';
    END IF;
    GRANT proposal_verification_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO proposal_verification_definer;

-- Answers true when the proposal was `new` and is pending again, false when it is in another state (nothing changes). Refusals: 42501 not
-- permitted, 22023 invalid argument, P0002 proposal not found.
CREATE OR REPLACE FUNCTION proposal_requeue_verification(p_proposal_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  p_state text;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'proposal_requeue_verification: a tenant session of an active account is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_proposal_id IS NULL THEN
    RAISE EXCEPTION 'proposal_requeue_verification: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.state INTO p_state FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proposal_requeue_verification: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_state <> 'new' THEN
    RETURN false;
  END IF;
  UPDATE public.proposals
     SET verification = 'pending', verified_at = NULL, verified_sha = NULL, verified_run_id = NULL, verifier_category = NULL, verify_attempts = 0,
         verify_requeues = verify_requeues + 1
   WHERE id = p_proposal_id AND account_id = acct;
  DELETE FROM public.proposal_claims WHERE proposal_id = p_proposal_id AND account_id = acct;
  DELETE FROM public.proposal_evidence WHERE proposal_id = p_proposal_id AND account_id = acct;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION proposal_requeue_verification(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION proposal_requeue_verification(uuid) TO app_user;
ALTER FUNCTION proposal_requeue_verification(uuid) OWNER TO proposal_verification_definer;

REVOKE CREATE ON SCHEMA public FROM proposal_verification_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE proposal_verification_definer FROM CURRENT_USER;
  END IF;
END
$$;
