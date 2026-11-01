-- D#483 S4-c2: the cross-account list the install and payment discovery drain starts from.
--
-- A discovery run and a proposal are tenant rows (FORCE row security), so no sweep login can ask "which accounts have a discovery waiting to run, or a removed
-- repository whose proposals are still `new`" across accounts. This list names the account and nothing else; everything after it (reading GitHub, writing
-- proposals as plan_importer, withdrawing a removed repository's rows) runs one account at a time under that account's own tenant.
--
-- It lists an account when it is live and has a `queued` discovery run, or a repository with no installation that still holds a `new` proposal. Oldest
-- queued run first, at most 100 accounts per call. It writes nothing (STABLE), refuses a platform_ops login and returns no repository, run, title or text.
--
-- Who owns it: a role of its own, discovery_drain_lister (the 0886/0889 bracket): NOLOGIN, no members, column grants for exactly what the body reads, one row
-- policy per table for this role alone, a pinned search_path, and EXECUTE for the run-writer login and nobody else.
--
-- Expand-only: a role and a function. Numbered above the highest migration on the code plane (0946) and above the claims of open pull requests (0947, 0948);
-- re-checked right before the pull request is opened and again before the merge.

DO $$
DECLARE
  n text := 'discovery_drain_lister';
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

-- The lister's whole reach: the queued runs, the repositories without an installation, the proposals still `new`, and whether the account is live.
GRANT USAGE ON SCHEMA public TO discovery_drain_lister;
GRANT SELECT (account_id, state, created_at) ON discovery_runs TO discovery_drain_lister;
GRANT SELECT (id, account_id, installation_id) ON repos TO discovery_drain_lister;
GRANT SELECT (account_id, repo_id, state) ON proposals TO discovery_drain_lister;
GRANT SELECT (id, deleted_at) ON accounts TO discovery_drain_lister;
CREATE POLICY discovery_drain_lister_select ON discovery_runs FOR SELECT TO discovery_drain_lister USING (state = 'queued');
CREATE POLICY discovery_drain_lister_select ON repos FOR SELECT TO discovery_drain_lister USING (installation_id IS NULL);
CREATE POLICY discovery_drain_lister_select ON proposals FOR SELECT TO discovery_drain_lister USING (state = 'new');
CREATE POLICY discovery_drain_lister_select ON accounts FOR SELECT TO discovery_drain_lister USING (deleted_at IS NULL);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'discovery_drain_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on discovery_drain_lister; cannot ALTER FUNCTION ... OWNER TO discovery_drain_lister';
    END IF;
    GRANT discovery_drain_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO discovery_drain_lister;

CREATE FUNCTION discovery_drain_list()
RETURNS TABLE (account_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'discovery_drain_list: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT w.account_id
    FROM (
      SELECT x.account_id, min(x.at) AS at
        FROM (
          SELECT q.account_id, q.created_at AS at FROM public.discovery_runs q WHERE q.state = 'queued'
          UNION ALL
          SELECT r.account_id, now() AS at FROM public.repos r
           WHERE r.installation_id IS NULL
             AND EXISTS (SELECT 1 FROM public.proposals p WHERE p.account_id = r.account_id AND p.repo_id = r.id AND p.state = 'new')
        ) x
        JOIN public.accounts a ON a.id = x.account_id AND a.deleted_at IS NULL
       GROUP BY x.account_id
    ) w
   ORDER BY w.at, w.account_id
   LIMIT 100;
END $$;

REVOKE ALL ON FUNCTION discovery_drain_list() FROM PUBLIC;
ALTER FUNCTION discovery_drain_list() OWNER TO discovery_drain_lister;
-- EXECUTE after the transfer, to the run-writer login alone, as 0874, 0886 and 0889 do.
GRANT EXECUTE ON FUNCTION discovery_drain_list() TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM discovery_drain_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE discovery_drain_lister FROM CURRENT_USER;
  END IF;
END
$$;
