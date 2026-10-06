-- 0696: the gh-proxy gets its own database login, narrowed to one function.
--
-- Why. The proxy binds a sandbox token to one live run and that run's repo
-- and installation. Until now it did so as platform_ops, a role that reads
-- accounts, users, billing and more. The proxy is internet-facing and will
-- run in a project of its own, so a hole in it should reach exactly one
-- lookup and nothing else.
--
-- What this adds:
--   * run_binding_resolver: a NOLOGIN group role with no table privilege at all.
--     The proxy's login (created by ops, see docs/ops/gh-proxy-login.md) is a
--     member of it and of nothing else.
--   * resolve_sandbox_run(sandbox_name): a SECURITY DEFINER function owned by
--     platform_ops (the same owner shape as every other definer here), with a
--     pinned search_path. It runs the lookup the proxy ran before, and it
--     returns only the fields the proxy uses: no run id, no account id, no
--     status, no token or cost columns.
--   * EXECUTE on it for run_binding_resolver and for nobody else.
--
-- The lookup moves unchanged, with one difference: the run-liveness test
-- (a pending, running or paused run) now lives in the function, so the
-- narrow login can never learn anything about an ended run. The status list
-- below is the set of non-terminal states of RUN_STATUS_TRANSITIONS; a test
-- in packages/github keeps the two in step.
-- The body is plpgsql, not sql, so it is not checked against the tables when the
-- function is created (a database replayed without an older migration still
-- applies this one).
-- Privilege brackets as in 0692.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'run_binding_resolver') THEN
    CREATE ROLE run_binding_resolver NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE run_binding_resolver NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
DECLARE
  r    record;
  bad  text[] := '{}';
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO r
    FROM pg_roles WHERE rolname = 'run_binding_resolver';
  IF r.rolcanlogin THEN bad := array_append(bad, 'rolcanlogin'); END IF;
  IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
  IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
  IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
  IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
  IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'role run_binding_resolver still has privileged attribute(s): %', array_to_string(bad, ', ');
  END IF;
  -- A role that existed before this file must hold nothing it should not: it may be a member of no
  -- role, hold no table, column or other function privilege. (Members of it are the proxy logins, and
  -- its EXECUTE on resolve_sandbox_run is the one grant this file makes.)
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'run_binding_resolver'::regrole) THEN
    RAISE EXCEPTION 'role run_binding_resolver is a member of another role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = 'run_binding_resolver'::regrole::oid) THEN
    RAISE EXCEPTION 'role run_binding_resolver holds a table privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute t, aclexplode(t.attacl) a WHERE a.grantee = 'run_binding_resolver'::regrole::oid) THEN
    RAISE EXCEPTION 'role run_binding_resolver holds a column privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE a.grantee = 'run_binding_resolver'::regrole::oid AND p.proname <> 'resolve_sandbox_run') THEN
    RAISE EXCEPTION 'role run_binding_resolver holds EXECUTE on a function other than resolve_sandbox_run';
  END IF;
END
$$;

CREATE FUNCTION resolve_sandbox_run(p_sandbox_name text)
RETURNS TABLE (
  role              text,
  product           text,
  gh_owner          text,
  gh_name           text,
  gh_installation_id bigint,
  app_kind          text,
  is_preview        boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- sandbox_name is not unique, so the run must be the ONLY match whatever its status: an ended run
  -- sharing the name of a live one denies, exactly as the query this replaces did. Liveness is then
  -- tested on that one row.
  RETURN QUERY
  WITH m AS (
    SELECT ar.role AS m_role, ar.status AS m_status, r.product AS m_product, r.gh_owner AS m_owner,
           r.gh_name AS m_name, i.gh_installation_id AS m_inst, i.app_kind AS m_kind,
           EXISTS (SELECT 1 FROM public.onboarding_previews p
                    WHERE p.run_id = ar.id AND p.account_id = ar.account_id) AS m_preview
      FROM public.agent_runs ar
      JOIN public.repos r
        ON r.id = ar.dispatch_repo_id
       AND r.account_id = ar.account_id
      JOIN public.installations i
        ON i.id = r.installation_id
       AND i.account_id = r.account_id
     WHERE ar.sandbox_name = p_sandbox_name
       AND NOT EXISTS (
         SELECT 1 FROM public.installations i2
          WHERE i2.gh_installation_id = i.gh_installation_id
            AND i2.id <> i.id
       )
  )
  SELECT m.m_role, m.m_product, m.m_owner, m.m_name, m.m_inst, m.m_kind, m.m_preview
    FROM m
   WHERE m.m_status IN ('pending', 'running', 'paused')
     AND (SELECT count(*) FROM m) = 1;
END
$$;

ALTER FUNCTION resolve_sandbox_run(text) OWNER TO platform_ops;
REVOKE ALL ON FUNCTION resolve_sandbox_run(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_sandbox_run(text) TO run_binding_resolver;
GRANT USAGE ON SCHEMA public TO run_binding_resolver;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
