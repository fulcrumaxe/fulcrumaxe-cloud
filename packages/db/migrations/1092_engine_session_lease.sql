-- D#845 ON-13c3: the engine session lease. A runner that reports `fx-engine-<gh_id>` running renews a 15 minute lease for that repo, through one definer, and only while the cloud's own rows still allow the session.
--
--   1. engine_session_leases (account_id, repo_id, runner_id, operate_epoch, renewed_at, expires_at; PK account_id + repo_id). Tenants read it (the chip); only engine_lease_definer writes it. There is no cron: expiry is the clock.
--   2. engine_lease_renew(p_names text[]): owned by engine_lease_definer, run by the runner's own session (app.runner_id set). For each reported name it upserts expires_at = now() + 15 min only when ALL of these hold:
--      the repo is the account's, the placement is on this runner, engine_repo_operated is true and engine_plan_ended is false (1077's two predicates, the one copy), the repo's newest start on this runner is delivered or
--      done, and that start's signed epoch is the account's current epoch. Otherwise it writes nothing. It answers the runner's live leases, so a caller that reported nothing still learns what it holds.
--   3. runner_capabilities widens by engine_lease_v1 (the list is 1053's, then this one; the function is 1053's, verbatim).
--
-- Numbered 1092 by the Team Lead; it builds on 1077 (the predicates), so it merges after it.

DO $$
DECLARE
  n text := 'engine_lease_definer';
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

-- ---- 1. the table ----------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE engine_session_leases (
  account_id    uuid NOT NULL,
  repo_id       uuid NOT NULL,
  runner_id     uuid NOT NULL,
  operate_epoch integer NOT NULL CONSTRAINT engine_session_leases_epoch_check CHECK (operate_epoch >= 1),
  renewed_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (account_id, repo_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE
);
ALTER TABLE engine_session_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_session_leases FORCE ROW LEVEL SECURITY;
GRANT SELECT ON engine_session_leases TO app_user;
CREATE POLICY tenant_isolation_select ON engine_session_leases FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

-- ---- what the definer reads (by column) and writes, every policy naming this role and the session's own account ------------------------------------------
GRANT USAGE ON SCHEMA public TO engine_lease_definer;
GRANT SELECT (id, account_id, revoked_at) ON runners TO engine_lease_definer;
GRANT SELECT (id, account_id, gh_repo_id) ON repos TO engine_lease_definer;
GRANT SELECT (account_id, repo_id, runner_id) ON project_placements TO engine_lease_definer;
GRANT SELECT (account_id, operate_epoch) ON engine_bridge_settings TO engine_lease_definer;
-- account_is_active() reads these two columns as its caller (the same grant and policy the other runner definers hold); the policy shows only the session's own account.
GRANT SELECT (id, deleted_at) ON accounts TO engine_lease_definer;
GRANT SELECT (account_id, repo_id, runner_id, kind, state, issued_at, job) ON machine_jobs TO engine_lease_definer;
GRANT SELECT, INSERT, UPDATE ON engine_session_leases TO engine_lease_definer;
CREATE POLICY engine_lease_definer_select ON runners FOR SELECT TO engine_lease_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_lease_definer_select ON accounts FOR SELECT TO engine_lease_definer USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_lease_definer_select ON repos FOR SELECT TO engine_lease_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_lease_definer_select ON project_placements FOR SELECT TO engine_lease_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_lease_definer_select ON engine_bridge_settings FOR SELECT TO engine_lease_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_lease_definer_select ON machine_jobs FOR SELECT TO engine_lease_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_lease_definer_select ON engine_session_leases FOR SELECT TO engine_lease_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_lease_definer_insert ON engine_session_leases FOR INSERT TO engine_lease_definer WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_lease_definer_update ON engine_session_leases FOR UPDATE TO engine_lease_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---- 2. the definer: the migration role holds the two owners only to create the function and take 1077's predicates' EXECUTE for it ----------------------
DO $$
DECLARE
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'engine_lease_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_lease_definer; cannot ALTER FUNCTION ... OWNER TO engine_lease_definer';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'engine_stop_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_stop_definer; cannot grant EXECUTE on its predicates';
    END IF;
    GRANT engine_lease_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    GRANT engine_stop_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
  GRANT CREATE ON SCHEMA public TO engine_lease_definer;
  -- The predicates stay 1077's one copy; the lease's definer may call them (the neon-shape entry of 1077 lists this grantee beside machine_jobs_owner).
  GRANT EXECUTE ON FUNCTION public.engine_plan_ended(uuid) TO engine_lease_definer;
  GRANT EXECUTE ON FUNCTION public.engine_repo_operated(uuid, uuid) TO engine_lease_definer;

  CREATE FUNCTION public.engine_lease_renew(p_names text[])
  RETURNS TABLE (o_repo_gh_id bigint, o_epoch integer, o_until timestamptz)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    raw  text := COALESCE(current_setting('app.runner_id', true), '');
    rid  uuid;
  BEGIN
    -- A live runner of an active account, named by the session: no runner in the session, a deleted account, a revoked runner or another account's one writes nothing (as runner_capabilities_record).
    IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'engine_lease_renew: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
    END IF;
    rid := raw::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = rid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'engine_lease_renew: the session is not a live runner of the account' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_names IS NULL OR cardinality(p_names) > 200 OR (cardinality(p_names) > 0 AND array_ndims(p_names) <> 1) THEN
      RAISE EXCEPTION 'engine_lease_renew: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO public.engine_session_leases AS l (account_id, repo_id, runner_id, operate_epoch, renewed_at, expires_at)
    SELECT acct, rp.id, rid, st.operate_epoch, now(), now() + interval '15 minutes'
      FROM (SELECT DISTINCT substr(n, 11)::bigint AS gh FROM unnest(p_names) n WHERE n ~ '^fx-engine-[1-9][0-9]{0,17}$') w
      JOIN public.repos rp ON rp.account_id = acct AND rp.gh_repo_id = w.gh
      JOIN public.project_placements pl ON pl.account_id = acct AND pl.repo_id = rp.id AND pl.runner_id = rid
      JOIN public.engine_bridge_settings st ON st.account_id = acct
     WHERE public.engine_repo_operated(acct, rp.id) AND NOT public.engine_plan_ended(acct)
       AND (SELECT j.job #>> '{job,args,operate_epoch}' FROM public.machine_jobs j
             WHERE j.account_id = acct AND j.repo_id = rp.id AND j.runner_id = rid AND j.kind = 'engine_session_start' AND j.state IN ('delivered', 'done')
             ORDER BY j.issued_at DESC LIMIT 1) = st.operate_epoch::text
    ON CONFLICT (account_id, repo_id) DO UPDATE
      SET runner_id = EXCLUDED.runner_id, operate_epoch = EXCLUDED.operate_epoch, renewed_at = EXCLUDED.renewed_at, expires_at = EXCLUDED.expires_at;
    RETURN QUERY
    SELECT rp.gh_repo_id, l.operate_epoch, l.expires_at
      FROM public.engine_session_leases l JOIN public.repos rp ON rp.account_id = l.account_id AND rp.id = l.repo_id
     WHERE l.account_id = acct AND l.runner_id = rid AND l.expires_at > now()
     ORDER BY rp.gh_repo_id;
  END;
  $f$;

  REVOKE ALL ON FUNCTION public.engine_lease_renew(text[]) FROM PUBLIC;
  ALTER FUNCTION public.engine_lease_renew(text[]) OWNER TO engine_lease_definer;
  GRANT EXECUTE ON FUNCTION public.engine_lease_renew(text[]) TO app_user;

  REVOKE CREATE ON SCHEMA public FROM engine_lease_definer;
  IF NOT super THEN
    REVOKE engine_lease_definer FROM CURRENT_USER;
    REVOKE engine_stop_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- 3. the capability: a hello that declares engine_lease_v1 must store ----------------------------------------------------------------------------------
-- ownership: runner_capabilities_definer, taken for the replace and dropped (1053's bracket).
ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1', 'engine_lease_v1']::text[]));

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_capabilities_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_capabilities_definer; cannot replace runner_capabilities_record';
    END IF;
    EXECUTE 'GRANT runner_capabilities_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION runner_capabilities_record(p_capabilities text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_capabilities_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A live runner of an active account, named by the session: no runner in the session, a revoked one or another account's one writes nothing.
  IF acct IS NULL OR NOT account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'runner_capabilities_record: the session is not a live runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Closed codes, each once, a flat list: anything else is refused, not repaired, so what is stored is exactly what was sent.
  IF p_capabilities IS NULL OR (cardinality(p_capabilities) > 0 AND array_ndims(p_capabilities) <> 1)
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1', 'engine_lease_v1']))
     OR (SELECT count(*) <> count(DISTINCT c) FROM unnest(p_capabilities) c) THEN
    RAISE EXCEPTION 'runner_capabilities_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.runner_capabilities AS c (runner_id, account_id, capabilities)
  VALUES (raw::uuid, acct, p_capabilities)
  ON CONFLICT (runner_id) DO UPDATE SET capabilities = EXCLUDED.capabilities, reported_at = now();
END;
$$;
REVOKE ALL ON FUNCTION runner_capabilities_record(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_capabilities_record(text[]) TO app_user;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE 'REVOKE runner_capabilities_definer FROM CURRENT_USER';
  END IF;
END
$$;
