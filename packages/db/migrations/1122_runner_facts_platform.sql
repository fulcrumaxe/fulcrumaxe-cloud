-- D#587 B-7c: the runner says which platform it is, so a WSL2 machine is not shown as plain Linux.
--
--   1. runner_facts gains a nullable `platform` column, CHECK IN ('linux', 'wsl2', 'macos'). NULL: the runner never said (a runner built before it, a cloud
--      deployed before the runner, or a machine the protocol does not name). The `os` CHECK is NOT widened: `os` keeps meaning the operating system family
--      ('linux' or 'macos'), every existing row and every old runner's hello stays valid with no rewrite, and a cloud build from before this migration (or a
--      rollback to one) never meets a value it does not know in `os`. The reader takes `platform` when it is set and `os` otherwise.
--   2. runner_facts_platform_record(text) writes it, for the runner the session names (app.runner_id, set only by the signature-verifying runner middleware),
--      in the shape of 1045's host-load definer: owned by the existing runner_facts_definer, which gains UPDATE on this one column and nothing else. The hello
--      calls it after runner_facts_record, on every hello that has facts: NULL clears the value, so a downgraded runner stops being shown as WSL2. It answers
--      false (writes nothing) for a runner that has no facts row yet, and answers false and clears the value for a platform that disagrees with the row's `os` (wsl2 is Linux, macos is macOS).
--   3. runner_capabilities_values_check and runner_capabilities_record take 'platform_fact_v1' (1108's list, nothing dropped, 'platform_fact_v1' last), so the hello that declares it is stored. Everything else of the function is 1108's,
--      which is 1096's, which is 1053's: the same pinned search_path, the same refusals, the same owner (runner_capabilities_definer, taken for the replace and dropped), EXECUTE for app_user alone.
--
-- Routing and display data: no security decision reads it.
--
-- Numbered 1122 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE runner_facts
  ADD COLUMN platform text CONSTRAINT runner_facts_platform_check CHECK (platform IN ('linux', 'wsl2', 'macos'));

GRANT UPDATE (platform) ON runner_facts TO runner_facts_definer;
GRANT SELECT (platform) ON runner_facts TO app_user;

-- ---- ownership bracket (1045's shape) ---------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_facts_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_facts_definer; cannot ALTER FUNCTION ... OWNER';
    END IF;
    GRANT runner_facts_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_facts_definer;

CREATE FUNCTION runner_facts_platform_record(p_platform text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
  v_os text;
  v_ok boolean;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_facts_platform_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A live runner of an active account, named by the session (as in 1045's host-load definer).
  IF acct IS NULL OR NOT account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'runner_facts_platform_record: the session is not a live runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_platform IS NOT NULL AND p_platform NOT IN ('linux', 'wsl2', 'macos') THEN
    RAISE EXCEPTION 'runner_facts_platform_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT f.os INTO v_os FROM public.runner_facts f WHERE f.runner_id = raw::uuid AND f.account_id = acct;
  IF NOT FOUND THEN RETURN false; END IF;
  -- A platform that disagrees with the os (wsl2 and linux are Linux, macos is macOS) is not stored, and the value the row had is cleared with it, so a machine is never left showing a stale one.
  v_ok := p_platform IS NULL OR (p_platform = 'macos' AND v_os = 'macos') OR (p_platform IN ('linux', 'wsl2') AND v_os = 'linux');
  UPDATE public.runner_facts f
     SET platform = CASE WHEN v_ok THEN p_platform ELSE NULL END
   WHERE f.runner_id = raw::uuid AND f.account_id = acct;
  RETURN v_ok;
END;
$$;

REVOKE ALL ON FUNCTION runner_facts_platform_record(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_facts_platform_record(text) TO app_user;
ALTER FUNCTION runner_facts_platform_record(text) OWNER TO runner_facts_definer;
REVOKE CREATE ON SCHEMA public FROM runner_facts_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_facts_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- 3. the capability: a hello that declares 'platform_fact_v1' must store ---------------------------------------------------------------------------
-- ownership: runner_capabilities_definer, taken for the replace and dropped (1053's bracket; 1108's replace).
ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1', 'engine_lease_v1', 'survey_public_v1', 'twin_v1', 'platform_fact_v1']::text[]));

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
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1', 'engine_lease_v1', 'survey_public_v1', 'twin_v1', 'platform_fact_v1']))
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
