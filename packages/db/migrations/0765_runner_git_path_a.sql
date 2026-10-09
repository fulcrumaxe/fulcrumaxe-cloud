-- D#6 R5a-2a: the database side of cloud-verified git (path A). The gh-proxy must tie one git request to a live runner lease
-- without holding any tenant context and without being able to write a lease. This file adds exactly that, as narrowly as it can.
--
-- 1. agent_runs_execution_mode_check also allows 'runner_verified', and agent_runs_runner_verified_runtime_check (one way, the
--    0714 shape) says a 'runner_verified' run has runtime 'runner'. Only agent_runs is widened. repos_execution_mode_check is NOT
--    touched, so no repository can be put in the mode yet, the claim still needs 'runner_local' on the repository, and the job
--    issuer never writes mode "verified": path A stays dormant in production after this file (two independent closed doors).
--    The pg tests insert 'runner_verified' runs directly. The later change that opens the mode widens only repos.
--
-- 2. runner_git_definer: NOLOGIN, no members outside this file's bracket, a member of nothing (the shape 0720 gave guard_definer,
--    0742 sandbox_settle_definer and 0754 runner_lease_definer). Column SELECT only on what the body reads, a row policy of its
--    own on each row-secured table it reads, and SELECT/INSERT/UPDATE/DELETE on runner_git_full_clones. platform_ops gains
--    nothing: no new privilege and no new policy for it.
--
-- 3. resolve_runner_git_request(runner, account, run, generation, repo, full_clone) answers one row. The caller is the proxy
--    login (a member of run_binding_resolver), which sets no tenant context, so the function takes the account as an argument
--    and filters on it; the cloud signed that account into the ticket the proxy has just verified. It never writes a lease (the
--    existing fence, agent_run_runner_lease, needs a tenant context, can extend a lease and belongs to agent_run_writer, so it is
--    not reused). It uses the database clock only. The verdict is the first that applies, in this order:
--      unknown                   no such run in the account
--      stale                     the run belongs to another runner or generation
--      not_running               the run is no longer 'running'
--      revoked                   the runner row is missing or revoked
--      expired                   lease_expires_at is at or before now()
--      not_verified              not a runner run, or the run's own execution_mode is not 'runner_verified'
--      no_repo                   dispatch_repo_id is not the asked repo, or the repo or its installation is missing, or the
--                                owner or name is null
--      installation_ambiguous    the gh_installation_id is held by more than one installation (the 0707 guard)
--      clone_limited             a full clone was asked for and the repo already has 3 today (UTC)
--      ok
--    The role, product, owner, name, installation and app kind are filled only on 'ok'. The wall clock is checked where the
--    ticket is minted, not here.
--
-- 4. runner_git_full_clones counts full clones per repo per UTC day. The count and the limit live in the function: the limit is
--    the constant 3, never an argument (0622's lesson: the caller must not choose a window or a limit). The increment is one
--    INSERT .. ON CONFLICT DO UPDATE .. WHERE full_clones < 3, so concurrent calls cannot pass the limit and a refused call
--    writes nothing. The same call deletes that repo's rows older than two days. The count is an event stamp by design (it
--    counts clones, so it cannot be derived from current state); deleting the repo cascades.
--
-- EXECUTE goes to run_binding_resolver and nobody else, so the proxy login gains it through its existing membership.
--
-- Numbered above the highest migration on the code plane (0760); 0761 to 0763 are held by open changes and 0764 is reserved.
-- Re-check against main right before merging (C7 section 4).
--
-- Refusals use fixed SQLSTATEs and messages, never an argument value: 42501 not permitted, 22023 invalid argument.

-- ---- agent_runs.execution_mode ------------------------------------------------------------------------------------
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_execution_mode_check;
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_execution_mode_check
  CHECK (execution_mode IS NULL OR execution_mode IN ('sandbox', 'runner_local', 'runner_verified'));
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_runner_verified_runtime_check
  CHECK (execution_mode IS DISTINCT FROM 'runner_verified' OR runtime = 'runner');

-- ---- the role -----------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text := 'runner_git_definer';
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

-- ---- the counter --------------------------------------------------------------------------------------------------
CREATE TABLE runner_git_full_clones (
  account_id   uuid NOT NULL,
  repo_id      uuid NOT NULL,
  utc_day      date NOT NULL,
  full_clones  integer NOT NULL CHECK (full_clones BETWEEN 1 AND 3),
  PRIMARY KEY (repo_id, utc_day),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);
ALTER TABLE runner_git_full_clones ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_git_full_clones FORCE ROW LEVEL SECURITY;

-- ---- what the body reads and writes, column by column -------------------------------------------------------------
GRANT SELECT (id, account_id, runner_id, lease_generation, lease_expires_at, status, runtime, execution_mode, role, dispatch_repo_id)
  ON agent_runs TO runner_git_definer;
GRANT SELECT (id, account_id, revoked_at) ON runners TO runner_git_definer;
GRANT SELECT (id, account_id, gh_owner, gh_name, installation_id, product) ON repos TO runner_git_definer;
GRANT SELECT (id, account_id, gh_installation_id, app_kind) ON installations TO runner_git_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON runner_git_full_clones TO runner_git_definer;
GRANT USAGE ON SCHEMA public TO runner_git_definer;

-- Row policies for this role only. The proxy sets no tenant context, so a read is not held to one: what the body returns is fixed
-- by its text and it filters every read on the account it was given. Nothing here writes a row of a tenant table.
CREATE POLICY runner_git_definer_select ON agent_runs FOR SELECT TO runner_git_definer USING (true);
CREATE POLICY runner_git_definer_select ON runners FOR SELECT TO runner_git_definer USING (true);
CREATE POLICY runner_git_definer_select ON repos FOR SELECT TO runner_git_definer USING (true);
CREATE POLICY runner_git_definer_select ON installations FOR SELECT TO runner_git_definer USING (true);
CREATE POLICY runner_git_definer_select ON runner_git_full_clones FOR SELECT TO runner_git_definer USING (true);
CREATE POLICY runner_git_definer_insert ON runner_git_full_clones FOR INSERT TO runner_git_definer WITH CHECK (true);
CREATE POLICY runner_git_definer_update ON runner_git_full_clones FOR UPDATE TO runner_git_definer USING (true) WITH CHECK (true);
CREATE POLICY runner_git_definer_delete ON runner_git_full_clones FOR DELETE TO runner_git_definer USING (true);

-- ---- the function -------------------------------------------------------------------------------------------------
CREATE FUNCTION resolve_runner_git_request(
  p_runner_id   uuid,
  p_account_id  uuid,
  p_run_id      uuid,
  p_generation  integer,
  p_repo_id     uuid,
  p_full_clone  boolean
)
RETURNS TABLE (verdict text, role text, product text, gh_owner text, gh_name text, gh_installation_id bigint, app_kind text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_run       record;
  v_revoked   timestamptz;
  v_repo      record;
  v_now       timestamptz := now();
  v_day       date := (now() AT TIME ZONE 'UTC')::date;
  v_count     integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'resolve_runner_git_request: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_runner_id IS NULL OR p_account_id IS NULL OR p_run_id IS NULL OR p_repo_id IS NULL OR p_full_clone IS NULL
     OR p_generation IS NULL OR p_generation < 0 THEN
    RAISE EXCEPTION 'resolve_runner_git_request: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.status AS st, a.runner_id AS rid, a.lease_generation AS gen, a.lease_expires_at AS lease_end,
         a.runtime AS rt, a.execution_mode AS mode, a.role AS run_role, a.dispatch_repo_id AS repo_id
    INTO v_run
    FROM public.agent_runs a
   WHERE a.account_id = p_account_id AND a.id = p_run_id;
  IF NOT FOUND THEN RETURN QUERY SELECT 'unknown'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text; RETURN; END IF;
  IF v_run.rid IS DISTINCT FROM p_runner_id OR v_run.gen <> p_generation THEN
    RETURN QUERY SELECT 'stale'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text; RETURN;
  END IF;
  IF v_run.st <> 'running' THEN
    RETURN QUERY SELECT 'not_running'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text; RETURN;
  END IF;
  SELECT x.revoked_at INTO v_revoked FROM public.runners x WHERE x.id = p_runner_id AND x.account_id = p_account_id;
  IF NOT FOUND OR v_revoked IS NOT NULL THEN
    RETURN QUERY SELECT 'revoked'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text; RETURN;
  END IF;
  IF v_run.lease_end IS NULL OR v_run.lease_end <= v_now THEN
    RETURN QUERY SELECT 'expired'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text; RETURN;
  END IF;
  IF v_run.rt IS DISTINCT FROM 'runner' OR v_run.mode IS DISTINCT FROM 'runner_verified' THEN
    RETURN QUERY SELECT 'not_verified'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text; RETURN;
  END IF;

  SELECT r.product AS prod, r.gh_owner AS own, r.gh_name AS nm, i.id AS inst_id, i.gh_installation_id AS gh_inst, i.app_kind AS kind
    INTO v_repo
    FROM public.repos r
    JOIN public.installations i ON i.id = r.installation_id AND i.account_id = r.account_id
   WHERE r.id = p_repo_id AND r.account_id = p_account_id;
  IF v_run.repo_id IS DISTINCT FROM p_repo_id OR NOT FOUND OR v_repo.own IS NULL OR v_repo.nm IS NULL THEN
    RETURN QUERY SELECT 'no_repo'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.installations i2 WHERE i2.gh_installation_id = v_repo.gh_inst AND i2.id <> v_repo.inst_id) THEN
    RETURN QUERY SELECT 'installation_ambiguous'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text; RETURN;
  END IF;

  IF p_full_clone THEN
    DELETE FROM public.runner_git_full_clones c WHERE c.repo_id = p_repo_id AND c.utc_day < v_day - 2;
    -- One statement decides: a row at the limit is not updated, so nothing comes back and nothing is written.
    INSERT INTO public.runner_git_full_clones AS c (account_id, repo_id, utc_day, full_clones)
    VALUES (p_account_id, p_repo_id, v_day, 1)
    ON CONFLICT (repo_id, utc_day) DO UPDATE SET full_clones = c.full_clones + 1 WHERE c.full_clones < 3
    RETURNING c.full_clones INTO v_count;
    IF v_count IS NULL THEN
      RETURN QUERY SELECT 'clone_limited'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text; RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT 'ok'::text, v_run.run_role, v_repo.prod, v_repo.own, v_repo.nm, v_repo.gh_inst, v_repo.kind;
END;
$$;

-- ---- ownership brackets -------------------------------------------------------------------------------------------
-- The migration role holds the new role (with ADMIN from creating it) only to hand the function over, and the role has CREATE on
-- public only for that transfer; both are reset at the end. platform_ops is not involved at all.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_git_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_git_definer; cannot ALTER FUNCTION ... OWNER TO runner_git_definer';
    END IF;
    GRANT runner_git_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_git_definer;

REVOKE ALL ON FUNCTION resolve_runner_git_request(uuid, uuid, uuid, integer, uuid, boolean) FROM PUBLIC;
ALTER FUNCTION resolve_runner_git_request(uuid, uuid, uuid, integer, uuid, boolean) OWNER TO runner_git_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION resolve_runner_git_request(uuid, uuid, uuid, integer, uuid, boolean) TO run_binding_resolver;

REVOKE CREATE ON SCHEMA public FROM runner_git_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_git_definer FROM CURRENT_USER;
  END IF;
END
$$;
