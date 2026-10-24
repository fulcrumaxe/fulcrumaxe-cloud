-- D#483 follow-up (from the S4-b3 security review): a re-queued proposal no longer keeps the claims and evidence of its earlier check.
--
-- proposal_requeue_verification (0861) set the verification back to `pending` and cleared the stamps, but left the proposal_claims and
-- proposal_evidence rows of the previous check in place until the next check replaced them. A proposal approved in that window showed the
-- earlier `supported` claims for text that had since been edited. The function now deletes both sets of rows in the same transaction as
-- the reset. The owning role (proposal_verification_definer) already holds SELECT (account_id, proposal_id) and DELETE on both tables and
-- the tenant policies for them (0839), which is what proposal_record_verification already uses to clear them before it inserts; no new grant.
-- Behaviour otherwise as in 0861: acts only on a `new` proposal, refuses outside a tenant session of an active account and a token principal.
--
-- Derived vs stamped: nothing new is stored; "no claims" is the absence of rows, as before a first check.
-- Expand-only: the function keeps its name and signature, so the previous deploy runs on this schema (it just keeps the stale rows).
-- Numbered above main's highest (0902) and the number open work holds (0903); re-checked before merge. Ownership bracket as in 0861.
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
     SET verification = 'pending', verified_at = NULL, verified_sha = NULL, verified_run_id = NULL, verify_attempts = 0
   WHERE id = p_proposal_id AND account_id = acct;
  -- The verdicts and excerpts of the earlier check described the earlier text; they go in the same transaction as the reset, so nothing
  -- reads them between the re-queue and the next check. The next proposal_record_verification (0839) writes the fresh ones.
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
