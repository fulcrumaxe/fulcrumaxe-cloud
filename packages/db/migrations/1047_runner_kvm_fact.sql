-- D#845 ON-6c: whether the machine has a usable KVM device, as its latest hello said it.
--
--   runners.kvm text: 'present' or 'absent'. NULL: the runner did not say (a runner built before it, or a hello that carried no facts), which readers treat as unknown and never as either answer.
--   runner_hello_record is replaced to take it as a fifth argument and to write it on EVERY hello (a hello that says nothing clears it to NULL, so a downgraded runner stops being credited),
--   in the way 1045 writes model_auth_present. Everything else of the function is 1045's, verbatim: the same pinned search_path, the same refusals, the same owner (platform_ops), EXECUTE for
--   app_user alone. The new argument is validated inside the function as well as by the column's CHECK. Display only: no authorization or routing decision reads it.
--
-- Numbered 1047 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE runners ADD COLUMN kvm text NULL CONSTRAINT runners_kvm_check CHECK (kvm IN ('present', 'absent'));

-- ---- ownership brackets (0724's and 1045's shape) -----------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

DROP FUNCTION runner_hello_record(integer, text, text, boolean);
CREATE FUNCTION runner_hello_record(p_protocol_version integer, p_binary_version text, p_isolation text, p_model_auth_present boolean DEFAULT NULL, p_kvm text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
  v_rows integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_hello_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct)
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'runner_hello_record: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_protocol_version IS NULL OR p_protocol_version < 1
     OR p_binary_version IS NULL OR p_binary_version !~ '^[A-Za-z0-9._+-]{1,64}$'
     OR p_isolation IS NULL OR p_isolation NOT IN ('microvm', 'vm_container', 'container', 'host_sandbox')
     OR (p_kvm IS NOT NULL AND p_kvm NOT IN ('present', 'absent')) THEN
    RAISE EXCEPTION 'runner_hello_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.runners
     SET protocol_version = p_protocol_version, binary_version = p_binary_version, isolation = p_isolation, model_auth_present = p_model_auth_present, kvm = p_kvm, last_seen_at = now()
   WHERE id = raw::uuid AND account_id = acct AND revoked_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION runner_hello_record(integer, text, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_hello_record(integer, text, text, boolean, text) TO app_user;
ALTER FUNCTION runner_hello_record(integer, text, text, boolean, text) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE platform_ops FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

-- ---- the capability: a hello that declares 'kvm_fact_v1' must store ---------------------------------------------------------------------------------
-- The runner declares `kvm_fact_v1` on its hello and sends `facts.kvm` only after a reply that listed `kvm_fact` (the cloud lists it only when this migration's column exists). The stored capability list
-- is closed, so the CHECK and runner_capabilities_record widen by one value, from 1043's seventeen; everything else of the function is 1043's, verbatim (ownership: runner_capabilities_definer, taken for the replace and dropped).
ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1']::text[]));

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
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1']))
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
