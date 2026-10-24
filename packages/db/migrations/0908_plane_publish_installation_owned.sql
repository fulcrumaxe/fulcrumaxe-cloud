-- D#598 (PUSH-OWNER-SANDBOX-DEFINER): a sandbox publish run may push to a paired public repository whose GitHub App installation is ANY live team installation of
-- the pairing's account, not only the run's own installation.
--
-- Why: the public-repo write token is minted only when the installation GitHub names for that repository belongs to the pairing's account. The runner path
-- reads that fact itself (platform_ops, packages/core/src/tenancy/installationOwnership.ts). The sandbox path runs on the narrow gh-proxy login
-- (run_binding_resolver), which holds no table grant, so it could only accept the run's own installation: a pairing whose public repo sits under another live
-- installation of the same account was refused. Granting that login (or platform_ops) more would widen a role; a narrow definer answers the one question instead.
--
-- What: plane_publish_installation_owned(p_sandbox_name, p_gh_installation_id) answers true only when
--   1. exactly one LIVE agent_runs row (pending, running, paused) carries the sandbox name (the rule 0834 and 0707 use), and its role is plane_publish; that row's
--      account is the account the question is about. The caller names no account and the function trusts none; and
--   2. an `installations` row of THAT account has the given gh_installation_id and app_kind 'team', and its `installation_installers` record is neither deleted nor
--      suspended. This is the rule of the shared reader, QUERY in installationOwnership.ts, restated in SQL because this login cannot run it; a [pg] test runs
--      both against one fixture matrix so the two cannot drift.
-- Anything else (no run, two runs, another role, a bad id, no such installation, another account's, suspended, deleted, a database error) is false or an error;
-- the caller refuses to mint on both. It writes nothing and uses no clock.
--
-- Privileges: a NEW role, plane_publish_owner_definer (NOLOGIN, no members, a member of nothing; the shape 0834 gave plane_publish_definer), owns the function.
-- It holds column SELECT on exactly what the body reads, and a row policy of its own on each table:
--   agent_runs             account_id, role, status, sandbox_name        (any row: this is how the account is found; the answer is only a boolean)
--   installations          account_id, gh_installation_id, app_kind         (only the rows of the tenant in app.account_id)
--   installation_installers gh_installation_id, app_kind, deleted_at, suspended_at (only the rows of an installation of the tenant in app.account_id)
-- The function sets app.account_id (transaction-local) to the account it resolved from the run, reads, and puts the previous value back; with no tenant set the
-- two tenant policies match nothing. EXECUTE goes to run_binding_resolver and nobody else. platform_ops gains NOTHING (the function refuses a platform_ops
-- login like its siblings); plane_publish_definer is not touched; no other role's grants or policies change.
--
-- Rollback (docs/ops/runbooks/rollback.md, expand/contract): additive only (a role, a function, grants, policies). If this deploy is reverted the proxy stops
-- calling the function and the sandbox path is refused for every pairing whose installation it cannot read (fail closed). Nothing is rewritten, dropped or made NOT NULL.
--
-- Numbered above the highest migration on the code plane (0907). Re-check against main right before merging and renumber to stay above it.

DO $$
DECLARE
  n text := 'plane_publish_owner_definer';
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

GRANT USAGE ON SCHEMA public TO plane_publish_owner_definer;
GRANT SELECT (account_id, role, status, sandbox_name) ON agent_runs TO plane_publish_owner_definer;
GRANT SELECT (account_id, gh_installation_id, app_kind) ON installations TO plane_publish_owner_definer;
GRANT SELECT (gh_installation_id, app_kind, deleted_at, suspended_at) ON installation_installers TO plane_publish_owner_definer;

CREATE POLICY plane_publish_owner_definer_select ON agent_runs FOR SELECT TO plane_publish_owner_definer USING (true);
CREATE POLICY plane_publish_owner_definer_select ON installations FOR SELECT TO plane_publish_owner_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- installation_installers carries no account; an installer record is visible only when an installation of the current tenant names it.
CREATE POLICY plane_publish_owner_definer_select ON installation_installers FOR SELECT TO plane_publish_owner_definer
  USING (EXISTS (
    SELECT 1 FROM public.installations i
     WHERE i.gh_installation_id = installation_installers.gh_installation_id
       AND i.app_kind = installation_installers.app_kind
       AND i.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  ));

CREATE FUNCTION plane_publish_installation_owned(p_sandbox_name text, p_gh_installation_id bigint)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_prev    text;
  v_owned   boolean;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'plane_publish_installation_owned: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_sandbox_name IS NULL OR p_sandbox_name = '' OR p_gh_installation_id IS NULL OR p_gh_installation_id <= 0 THEN
    RETURN false;
  END IF;

  -- The account comes from the run alone: exactly one live run carries the name, and it is a plane_publish run.
  SELECT a.account_id INTO v_account
    FROM public.agent_runs a
   WHERE a.sandbox_name = p_sandbox_name
     AND a.status IN ('pending', 'running', 'paused')
     AND a.role = 'plane_publish'
     AND (SELECT count(*) FROM public.agent_runs b WHERE b.sandbox_name = p_sandbox_name AND b.status IN ('pending', 'running', 'paused')) = 1;
  IF v_account IS NULL THEN
    RETURN false;
  END IF;

  v_prev := current_setting('app.account_id', true);
  PERFORM set_config('app.account_id', v_account::text, true);

  SELECT EXISTS (
    SELECT 1
      FROM public.installations i
      JOIN public.installation_installers ii
        ON ii.gh_installation_id = i.gh_installation_id AND ii.app_kind = i.app_kind AND ii.deleted_at IS NULL AND ii.suspended_at IS NULL
     WHERE i.account_id = v_account AND i.gh_installation_id = p_gh_installation_id AND i.app_kind = 'team'
  ) INTO v_owned;

  PERFORM set_config('app.account_id', COALESCE(v_prev, ''), true);
  RETURN v_owned;
END;
$$;

-- ---- ownership brackets (the shape 0834 used) ----------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'plane_publish_owner_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on plane_publish_owner_definer; cannot ALTER FUNCTION ... OWNER TO plane_publish_owner_definer';
    END IF;
    GRANT plane_publish_owner_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO plane_publish_owner_definer;

REVOKE ALL ON FUNCTION plane_publish_installation_owned(text, bigint) FROM PUBLIC;
ALTER FUNCTION plane_publish_installation_owned(text, bigint) OWNER TO plane_publish_owner_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION plane_publish_installation_owned(text, bigint) TO run_binding_resolver;

REVOKE CREATE ON SCHEMA public FROM plane_publish_owner_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE plane_publish_owner_definer FROM CURRENT_USER;
  END IF;
END
$$;
