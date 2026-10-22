-- D#483 S4-b2a: the cross-tenant list the claim verifier's sweep starts from.
--
-- A proposal is a tenant row (FORCE row security), so no sweep login can ask "which proposals are waiting to be checked" across accounts. This list
-- names the proposal (account, id) and nothing else; everything after it (reading the text, the daily limit, starting the verifier run, recording
-- its outcome through proposal_record_verification) runs one proposal at a time under that proposal's own tenant.
--
-- It lists a proposal when it is still `new`, owned by the product process, its account is live, its repository runs in our sandbox (a repository on
-- the person's own machine stays `pending` until the verifier is a runner job), and it is waiting to be checked: `pending`, or `check_failed` with
-- attempts left (fewer than 3, MAX_VERIFY_ATTEMPTS). A proposal whose verifier run is still going stays listed; the sweep finds that run by its
-- idempotency key and waits. Oldest first, at most 10 per account in one call, so one account's queue cannot hold every place. It writes nothing
-- (STABLE), refuses a platform_ops login and returns no title, text, repository or sha.
--
-- Who owns it: platform_ops gains nothing. The function belongs to a role of its own, proposal_verify_lister (the 0886 bracket): NOLOGIN, no members,
-- column grants for exactly what the body reads, one row policy per table for this role alone, a pinned search_path, and EXECUTE for the run-writer
-- login and nobody else.
--
-- Expand-only: a role and a function; nothing existing is dropped, renamed or narrowed. Numbered above the highest migration on the code plane (0887)
-- and above the claim of an open pull request (0888); re-checked right before the pull request is opened.

DO $$
DECLARE
  n text := 'proposal_verify_lister';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

-- The lister's whole reach: the proposal's ids, state, owner, verification and attempts, its repository's mode, and whether the account is live.
GRANT USAGE ON SCHEMA public TO proposal_verify_lister;
GRANT SELECT (id, account_id, repo_id, state, owner_process, verification, verify_attempts, created_at) ON proposals TO proposal_verify_lister;
GRANT SELECT (id, account_id, execution_mode) ON repos TO proposal_verify_lister;
GRANT SELECT (id, deleted_at) ON accounts TO proposal_verify_lister;
CREATE POLICY proposal_verify_lister_select ON proposals FOR SELECT TO proposal_verify_lister
  USING (state = 'new' AND owner_process = 'product' AND (verification = 'pending' OR (verification = 'check_failed' AND verify_attempts < 3)));
CREATE POLICY proposal_verify_lister_select ON repos FOR SELECT TO proposal_verify_lister USING (execution_mode = 'sandbox');
CREATE POLICY proposal_verify_lister_select ON accounts FOR SELECT TO proposal_verify_lister USING (deleted_at IS NULL);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'proposal_verify_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on proposal_verify_lister; cannot ALTER FUNCTION ... OWNER TO proposal_verify_lister';
    END IF;
    GRANT proposal_verify_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO proposal_verify_lister;

CREATE FUNCTION proposal_verify_list_due(p_limit int)
RETURNS TABLE (account_id uuid, proposal_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'proposal_verify_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'proposal_verify_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT d.account_id, d.id
    FROM (
      SELECT p.account_id, p.id, p.created_at,
             row_number() OVER (PARTITION BY p.account_id ORDER BY p.created_at, p.id) AS rn
        FROM public.proposals p
        JOIN public.accounts a ON a.id = p.account_id AND a.deleted_at IS NULL
        JOIN public.repos r ON r.account_id = p.account_id AND r.id = p.repo_id AND r.execution_mode = 'sandbox'
       WHERE p.state = 'new' AND p.owner_process = 'product'
         AND (p.verification = 'pending' OR (p.verification = 'check_failed' AND p.verify_attempts < 3))
    ) d
   WHERE d.rn <= 10
   ORDER BY d.created_at, d.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION proposal_verify_list_due(int) FROM PUBLIC;
ALTER FUNCTION proposal_verify_list_due(int) OWNER TO proposal_verify_lister;
-- EXECUTE after the transfer, to the run-writer login alone, as 0874 and 0886 do.
GRANT EXECUTE ON FUNCTION proposal_verify_list_due(int) TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM proposal_verify_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE proposal_verify_lister FROM CURRENT_USER;
  END IF;
END
$$;
