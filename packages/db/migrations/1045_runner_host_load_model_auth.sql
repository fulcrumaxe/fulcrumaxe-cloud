-- D#845 ON-1b: the two machine facts a runner already says (or has the shape to say) and the cloud never kept.
--
--   1. runner_facts gains the machine's last reported load: host_mem_avail_mb, host_disk_free_mb, host_setups_running and host_load_at, set together or all
--      NULL (NULL: never reported). Whole numbers only, bounded as the protocol's HostLoad block is. Written only by runner_host_load_record(int, int, int),
--      which names the runner from app.runner_id (set only by the signature-verifying runner middleware), in the shape of 1040's host-limits definer:
--      owned by the existing runner_facts_definer, which gains UPDATE on exactly these four columns and nothing else. It refuses a runner whose hello declared
--      a protocol below 22 and answers false (writes nothing) for a runner that has no facts row yet. Routing and display data; no security decision reads it.
--   2. runners.model_auth_present boolean: what the latest hello said about model credentials. NULL: the runner never said. runner_hello_record is
--      replaced to write it on EVERY hello (a hello that says nothing clears it to NULL, so a downgraded runner stops being credited). Everything else of the
--      function is 0724's, verbatim: the same pinned search_path, the same refusals, the same owner (platform_ops), EXECUTE for app_user alone.
--
-- Numbered 1045 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE runners ADD COLUMN model_auth_present boolean NULL;

ALTER TABLE runner_facts
  ADD COLUMN host_mem_avail_mb integer CONSTRAINT runner_facts_host_mem_check CHECK (host_mem_avail_mb BETWEEN 0 AND 100000000),
  ADD COLUMN host_disk_free_mb integer CONSTRAINT runner_facts_host_disk_check CHECK (host_disk_free_mb BETWEEN 0 AND 100000000),
  ADD COLUMN host_setups_running smallint CONSTRAINT runner_facts_host_setups_check CHECK (host_setups_running BETWEEN 0 AND 1000),
  ADD COLUMN host_load_at timestamptz,
  ADD CONSTRAINT runner_facts_host_load_pair CHECK ((host_mem_avail_mb IS NULL) = (host_disk_free_mb IS NULL) AND (host_mem_avail_mb IS NULL) = (host_setups_running IS NULL) AND (host_mem_avail_mb IS NULL) = (host_load_at IS NULL));

GRANT UPDATE (host_mem_avail_mb, host_disk_free_mb, host_setups_running, host_load_at) ON runner_facts TO runner_facts_definer;
GRANT SELECT (host_mem_avail_mb, host_disk_free_mb, host_setups_running, host_load_at) ON runner_facts TO app_user;

-- ---- ownership brackets (0783's and 0724's shapes) -------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_facts_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_facts_definer; cannot ALTER FUNCTION ... OWNER';
    END IF;
    GRANT runner_facts_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_facts_definer, platform_ops;

CREATE FUNCTION runner_host_load_record(p_mem_avail_mb integer, p_disk_free_mb integer, p_setups_running integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rid  uuid;
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
  v_protocol integer;
  v_rows integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION '%: refused for a platform_ops login', 'runner_host_load_record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A live runner of an active account, named by the session (as in 1040's host-limits definer).
  IF acct IS NULL OR NOT account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION '%: the session is not a live runner of an active account', 'runner_host_load_record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  rid := raw::uuid;
  IF p_mem_avail_mb IS NULL OR p_mem_avail_mb NOT BETWEEN 0 AND 100000000
     OR p_disk_free_mb IS NULL OR p_disk_free_mb NOT BETWEEN 0 AND 100000000
     OR p_setups_running IS NULL OR p_setups_running NOT BETWEEN 0 AND 1000 THEN
    RAISE EXCEPTION 'runner_host_load_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT r.protocol_version INTO v_protocol FROM public.runners r WHERE r.id = rid AND r.account_id = acct;
  IF COALESCE(v_protocol, 0) < 22 THEN
    RAISE EXCEPTION 'runner_host_load_record: the runner declared a protocol below 22' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.runner_facts f
     SET host_mem_avail_mb = p_mem_avail_mb, host_disk_free_mb = p_disk_free_mb, host_setups_running = p_setups_running, host_load_at = now()
   WHERE f.runner_id = rid AND f.account_id = acct;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION runner_host_load_record(integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_host_load_record(integer, integer, integer) TO app_user;
ALTER FUNCTION runner_host_load_record(integer, integer, integer) OWNER TO runner_facts_definer;

-- ---- runner_hello_record: 0724's body plus the one write ---------------------------------------------------------------
DROP FUNCTION runner_hello_record(integer, text, text);
CREATE FUNCTION runner_hello_record(p_protocol_version integer, p_binary_version text, p_isolation text, p_model_auth_present boolean DEFAULT NULL)
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
     OR p_isolation IS NULL OR p_isolation NOT IN ('microvm', 'vm_container', 'container', 'host_sandbox') THEN
    RAISE EXCEPTION 'runner_hello_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.runners
     SET protocol_version = p_protocol_version, binary_version = p_binary_version, isolation = p_isolation, model_auth_present = p_model_auth_present, last_seen_at = now()
   WHERE id = raw::uuid AND account_id = acct AND revoked_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION runner_hello_record(integer, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_hello_record(integer, text, text, boolean) TO app_user;
ALTER FUNCTION runner_hello_record(integer, text, text, boolean) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM runner_facts_definer, platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_facts_definer FROM CURRENT_USER;
    REVOKE platform_ops FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
