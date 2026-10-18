-- D#598 P8b: the cross-tenant list the setup-request check sweep starts from.
--
-- setup_requests (0856) is tenant-only: app_user alone holds it, with FORCE row security, so no sweep login can ask "which requests are
-- waiting for a check" across accounts. setup_request_list_due answers exactly that, in the shape of 0845's work_item_list_parked_stage:
-- the list names the request (account, id, kind) and nothing else, and everything after it (reading the request, asking the provider,
-- writing the result) runs one request at a time under that request's own tenant.
--
-- A request is due when it is open, carries an automatic check, belongs to a live account, its proposer is still an owner or admin of that
-- account (the check is written as the proposer; one who has left or been demoted can only be answered by Mark done from a current admin, so
-- such a request is not listed and cannot sit at the front of the list), and was last checked at least p_min_age_s seconds ago
-- (check_ran_at, the stamp the failed check already writes; never checked sorts first). No account takes more than 10 places in one call,
-- so one account's requests, whatever state they are in, cannot fill the limit and starve the others. The cron runs once a minute and is asked
-- for 45 seconds, so a request is looked at on every tick and the tick that is a few seconds early still finds it: the customer-facing
-- promise is "every 60 seconds". It writes nothing (STABLE), refuses a platform_ops login, and returns no reason, target, link or agent text.
--
-- Who owns it: platform_ops gains nothing. The function belongs to a role of its own, setup_request_lister: NOLOGIN, no members (the
-- migration role holds it only inside this file), column grants for exactly what the body reads, one row policy per table for this role
-- alone, a pinned search_path, and EXECUTE for the run-writer login (the login the sweeps run as) and nobody else.
--
-- The partial index serves the list: open requests with a check, in the order the list reads them. It carries the columns the list
-- returns, so an idle platform's call is an index scan with nothing in it.
--
-- Expand-only: a new role, a function and an index; nothing existing is dropped, renamed or narrowed. Numbered above the highest migration
-- on the code plane and the open PRs' claims; re-checked right before merge.

CREATE INDEX idx_setup_requests_due ON setup_requests (check_ran_at NULLS FIRST, created_at) INCLUDE (id, account_id, kind)
  WHERE state = 'open' AND check_kind IS NOT NULL;

DO $$
DECLARE
  n text := 'setup_request_lister';
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

-- The lister's whole reach: which requests are open with a check (ids, kind, the check stamp, the proposer's id), whether their account is live,
-- and whether the proposer is still an owner or admin (the member's id and role). Three policies, for this role alone. It sees no target,
-- reason, link or check reason.
GRANT USAGE ON SCHEMA public TO setup_request_lister;
GRANT SELECT (id, account_id, kind, state, check_kind, check_ran_at, created_at, created_by) ON setup_requests TO setup_request_lister;
GRANT SELECT (account_id, user_id, role) ON account_members TO setup_request_lister;
GRANT SELECT (id, deleted_at) ON accounts TO setup_request_lister;
CREATE POLICY setup_request_lister_select ON setup_requests FOR SELECT TO setup_request_lister USING (state = 'open' AND check_kind IS NOT NULL);
CREATE POLICY setup_request_lister_select ON accounts FOR SELECT TO setup_request_lister USING (deleted_at IS NULL);
CREATE POLICY setup_request_lister_select ON account_members FOR SELECT TO setup_request_lister USING (role IN ('owner', 'admin'));

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'setup_request_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on setup_request_lister; cannot ALTER FUNCTION ... OWNER TO setup_request_lister';
    END IF;
    GRANT setup_request_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO setup_request_lister;

CREATE FUNCTION setup_request_list_due(p_limit int, p_min_age_s int)
RETURNS TABLE (account_id uuid, setup_request_id uuid, kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'setup_request_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
     OR p_min_age_s IS NULL OR p_min_age_s NOT BETWEEN 0 AND 86400 THEN
    RAISE EXCEPTION 'setup_request_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT d.account_id, d.id, d.kind
    FROM (
      SELECT s.account_id, s.id, s.kind, s.check_ran_at, s.created_at,
             row_number() OVER (PARTITION BY s.account_id ORDER BY s.check_ran_at NULLS FIRST, s.created_at, s.id) AS rn
        FROM public.setup_requests s
        JOIN public.accounts a ON a.id = s.account_id AND a.deleted_at IS NULL
        JOIN public.account_members m ON m.account_id = s.account_id AND m.user_id = s.created_by AND m.role IN ('owner', 'admin')
       WHERE s.state = 'open' AND s.check_kind IS NOT NULL
         AND (s.check_ran_at IS NULL OR s.check_ran_at <= now() - make_interval(secs => p_min_age_s))
    ) d
   WHERE d.rn <= 10
   ORDER BY d.check_ran_at NULLS FIRST, d.created_at, d.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION setup_request_list_due(int, int) FROM PUBLIC;
ALTER FUNCTION setup_request_list_due(int, int) OWNER TO setup_request_lister;
-- EXECUTE after the transfer, to the run-writer login alone, as 0734, 0757 and 0845 do for their listers.
GRANT EXECUTE ON FUNCTION setup_request_list_due(int, int) TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM setup_request_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE setup_request_lister FROM CURRENT_USER;
  END IF;
END
$$;
