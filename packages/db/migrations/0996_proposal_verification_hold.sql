-- D#483: the verifier's answer is written only onto the check it was made for, with the proposal locked until it is written.
--
-- The sweep reads a proposal again in the transaction that records an ended run's answer, and skips it if it was sent back or edited since. That read
-- took no lock (app_user holds only SELECT on proposals, which does not allow SELECT ... FOR UPDATE), so a re-queue (proposal_requeue_verification,
-- which locks the row) could commit between the read and proposal_record_verification and the older answer was then written over the new pending state.
-- proposal_hold_verification locks the row and keeps the lock to the end of the caller's transaction: the sweep calls it before that read, so a
-- re-queue that commits first is seen by the read and nothing is written, and one that comes later waits behind the write. It changes no data.
--
-- Expand-only: a new function; proposal_record_verification and proposal_requeue_verification are untouched, so the previous deploy runs on this
-- schema. It needs no new privilege (the role already holds SELECT on the key columns and UPDATE on the table's verification columns). Numbered above
-- main's highest (0993) and open PRs' (0994, 0995); re-checked before merge. Ownership bracket as in 0861 and 0994.

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

-- Answers true when the proposal exists (and is now locked), false when it does not. Refusals: 42501 not permitted, 22023 invalid argument.
CREATE FUNCTION proposal_hold_verification(p_proposal_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'proposal_hold_verification: a tenant session of an active account is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_proposal_id IS NULL THEN
    RAISE EXCEPTION 'proposal_hold_verification: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION proposal_hold_verification(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION proposal_hold_verification(uuid) TO app_user;
ALTER FUNCTION proposal_hold_verification(uuid) OWNER TO proposal_verification_definer;

REVOKE CREATE ON SCHEMA public FROM proposal_verification_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE proposal_verification_definer FROM CURRENT_USER;
  END IF;
END
$$;
