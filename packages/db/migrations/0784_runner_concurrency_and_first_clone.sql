-- D#605 FL-12a: the hosted account's runner concurrency setting, and the first-clone exemption.
--
-- 1. account_runner_concurrency      one row per account that has accepted a setting: the runner jobs it may have running at once, in all
--                                    (total_jobs) and on one repository (per_repo_jobs). No row means the plan data's defaults, so adding
--                                    a runner or changing plan never writes here. The claim never trusts the row alone: the ceiling it
--                                    applies is the smaller of this and what the account's live runners can hold.
--    account_runner_concurrency_set(total, per_repo, accept)
--                                    the one writer. An owner or admin of an active account only, and only with accept = true (an
--                                    explicit accept of every change, raise or lower). A repeat of the figures already stored writes
--                                    nothing and answers false. A real change writes one audit_log row with the actor and the old and new
--                                    figures.
--
-- 2. runner_git_first_clones         one row per (runner, repo) that has had its exempt first full clone, with the UTC day it was given.
--                                    It is an event stamp by design (it records that a clone was granted, so it cannot be derived from
--                                    current state), kept as long as the runner row exists so a runner never gets a second exemption on
--                                    the same repo. resolve_runner_git_request (0765) is replaced: the first full clone of a repo by a
--                                    runner is not counted against the repo's daily allowance, while exemptions given on one UTC day
--                                    for one repo are capped at the number of the account's runners that are not revoked, which the
--                                    plan's runner limit already bounds. Removing a runner and registering another therefore cannot mint
--                                    unlimited clones: the revoked runner's rows still count for that day, and the new runner is exempt only
--                                    while the day's count is below the live runners'. Everything else the function does is unchanged.
--
-- Who may touch it: platform_ops holds NOTHING on the new tables and gains nothing anywhere. The setting's function and rows are owned by
-- a role of their own, runner_concurrency_definer, in the shape of 0770's runner_allowance_definer (NOLOGIN, no members outside this
-- file's bracket, column grants for exactly what the body reads and writes, row policies for this role only, a pinned search_path,
-- EXECUTE for app_user alone). The clone table belongs to the existing runner_git_definer.
--
-- Numbered above the highest migration claimed (0783 is FL-1's). Re-check against main right before merging and renumber to stay above its highest.
--
-- Refusals use fixed SQLSTATEs and messages, never an argument value: 42501 not permitted, 22023 invalid argument.
DO $$
DECLARE
  n text := 'runner_concurrency_definer';
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

CREATE TABLE account_runner_concurrency (
  account_id     uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  total_jobs     smallint NOT NULL CHECK (total_jobs BETWEEN 1 AND 100),
  per_repo_jobs  smallint NOT NULL CHECK (per_repo_jobs BETWEEN 1 AND 100),
  updated_by     uuid NOT NULL REFERENCES users (id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_runner_concurrency_per_repo_check CHECK (per_repo_jobs <= total_jobs)
);
ALTER TABLE account_runner_concurrency ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_runner_concurrency FORCE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO runner_concurrency_definer;
GRANT SELECT (account_id, total_jobs, per_repo_jobs, updated_by, updated_at), INSERT (account_id, total_jobs, per_repo_jobs, updated_by, updated_at), UPDATE (total_jobs, per_repo_jobs, updated_by, updated_at) ON account_runner_concurrency TO runner_concurrency_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO runner_concurrency_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_concurrency_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO runner_concurrency_definer;
-- Read only, for the tenant: the claim (the runner login reads as the runner's tenant) and the settings screen. No write for either.
GRANT SELECT (account_id, total_jobs, per_repo_jobs, updated_by, updated_at) ON account_runner_concurrency TO app_user;

CREATE POLICY tenant_isolation_select ON account_runner_concurrency FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY runner_concurrency_definer_select ON account_runner_concurrency FOR SELECT TO runner_concurrency_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_concurrency_definer_insert ON account_runner_concurrency FOR INSERT TO runner_concurrency_definer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND updated_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = account_runner_concurrency.account_id AND m.user_id = account_runner_concurrency.updated_by)
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY runner_concurrency_definer_update ON account_runner_concurrency FOR UPDATE TO runner_concurrency_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND updated_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = account_runner_concurrency.account_id AND m.user_id = account_runner_concurrency.updated_by)
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- Shows this role only the caller's own membership row, as 0757, 0759 and 0770 do.
CREATE POLICY runner_concurrency_definer_select ON account_members FOR SELECT TO runner_concurrency_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY runner_concurrency_definer_select ON accounts FOR SELECT TO runner_concurrency_definer USING (true);
CREATE POLICY runner_concurrency_definer_audit ON audit_log FOR INSERT TO runner_concurrency_definer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND action = 'account.runner_concurrency.accepted'
  );

-- ---- the clone stamp ----------------------------------------------------------------------------------------------
CREATE TABLE runner_git_first_clones (
  account_id  uuid NOT NULL,
  runner_id   uuid NOT NULL,
  repo_id     uuid NOT NULL,
  utc_day     date NOT NULL,
  PRIMARY KEY (runner_id, repo_id),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);
CREATE INDEX runner_git_first_clones_repo_day_idx ON runner_git_first_clones (repo_id, utc_day);
ALTER TABLE runner_git_first_clones ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_git_first_clones FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON runner_git_first_clones TO runner_git_definer;
CREATE POLICY runner_git_definer_select ON runner_git_first_clones FOR SELECT TO runner_git_definer USING (true);
CREATE POLICY runner_git_definer_insert ON runner_git_first_clones FOR INSERT TO runner_git_definer WITH CHECK (true);

-- ---- ownership brackets -------------------------------------------------------------------------------------------
-- A non-superuser migrator needs SET on each role for ALTER ... OWNER TO and for replacing a function it owns; each role has CREATE on public
-- only for that, and both are reset at the end.
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_concurrency_definer', 'runner_git_definer'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members m
        WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option
      ) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot own or replace its functions', n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
    END LOOP;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_concurrency_definer, runner_git_definer;

CREATE FUNCTION account_runner_concurrency_set(p_total_jobs integer, p_per_repo_jobs integer, p_accept boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct      uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr       uuid;
  v_role    text;
  v_total   smallint;
  v_per     smallint;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'account_runner_concurrency_set: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'account_runner_concurrency_set: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_accept IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'account_runner_concurrency_set: the change was not accepted' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_total_jobs IS NULL OR p_per_repo_jobs IS NULL OR p_total_jobs NOT BETWEEN 1 AND 100
     OR p_per_repo_jobs NOT BETWEEN 1 AND p_total_jobs THEN
    RAISE EXCEPTION 'account_runner_concurrency_set: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One writer per account, so the old figures in the audit row are the ones this change replaces.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_concurrency:' || acct::text, 0));
  SELECT c.total_jobs, c.per_repo_jobs INTO v_total, v_per FROM public.account_runner_concurrency c WHERE c.account_id = acct;
  IF FOUND AND v_total = p_total_jobs AND v_per = p_per_repo_jobs THEN
    RETURN false;
  END IF;
  INSERT INTO public.account_runner_concurrency AS c (account_id, total_jobs, per_repo_jobs, updated_by, updated_at)
  VALUES (acct, p_total_jobs, p_per_repo_jobs, usr, clock_timestamp())
  ON CONFLICT (account_id) DO UPDATE SET total_jobs = EXCLUDED.total_jobs, per_repo_jobs = EXCLUDED.per_repo_jobs, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'account.runner_concurrency.accepted',
          jsonb_build_object('total_jobs', p_total_jobs, 'per_repo_jobs', p_per_repo_jobs, 'previous_total_jobs', v_total, 'previous_per_repo_jobs', v_per),
          clock_timestamp());
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION account_runner_concurrency_set(integer, integer, boolean) FROM PUBLIC;
ALTER FUNCTION account_runner_concurrency_set(integer, integer, boolean) OWNER TO runner_concurrency_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner), to app_user alone.
GRANT EXECUTE ON FUNCTION account_runner_concurrency_set(integer, integer, boolean) TO app_user;

-- ---- resolve_runner_git_request, with the first-clone exemption ----------------------------------------------------
-- The body of 0765's function, with one change: the `IF p_full_clone` block. The replacement keeps the owner and the ACL (EXECUTE for
-- run_binding_resolver and nobody else).
CREATE OR REPLACE FUNCTION resolve_runner_git_request(
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
  v_exempt    boolean := false;
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
    -- A runner's first full clone of a repo is not counted against the repo's daily allowance, up to as many exemptions a day for one repo
    -- as the account has runners that are not revoked (the plan's runner limit bounds that number). Once a runner has had its exemption it
    -- never has another for that repo, and a removed runner's rows still count for the day they were given, so removing a runner and
    -- registering another does not open more of them. One lock per repo, so concurrent first clones cannot pass the cap.
    PERFORM pg_advisory_xact_lock(hashtextextended('runner_first_clone:' || p_repo_id::text, 0));
    IF NOT EXISTS (SELECT 1 FROM public.runner_git_first_clones f WHERE f.runner_id = p_runner_id AND f.repo_id = p_repo_id)
       AND (SELECT count(*) FROM public.runner_git_first_clones f WHERE f.account_id = p_account_id AND f.repo_id = p_repo_id AND f.utc_day = v_day)
           < (SELECT count(*) FROM public.runners x WHERE x.account_id = p_account_id AND x.revoked_at IS NULL) THEN
      INSERT INTO public.runner_git_first_clones (account_id, runner_id, repo_id, utc_day) VALUES (p_account_id, p_runner_id, p_repo_id, v_day);
      v_exempt := true;
    END IF;
    IF NOT v_exempt THEN
      -- One statement decides: a row at the limit is not updated, so nothing comes back and nothing is written.
      INSERT INTO public.runner_git_full_clones AS c (account_id, repo_id, utc_day, full_clones)
      VALUES (p_account_id, p_repo_id, v_day, 1)
      ON CONFLICT (repo_id, utc_day) DO UPDATE SET full_clones = c.full_clones + 1 WHERE c.full_clones < 3
      RETURNING c.full_clones INTO v_count;
      IF v_count IS NULL THEN
        RETURN QUERY SELECT 'clone_limited'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text; RETURN;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT 'ok'::text, v_run.run_role, v_repo.prod, v_repo.own, v_repo.nm, v_repo.gh_inst, v_repo.kind;
END;
$$;

REVOKE CREATE ON SCHEMA public FROM runner_concurrency_definer, runner_git_definer;
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_concurrency_definer', 'runner_git_definer'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', n);
    END LOOP;
  END IF;
END
$$;
