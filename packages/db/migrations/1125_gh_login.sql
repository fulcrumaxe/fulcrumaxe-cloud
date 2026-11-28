-- D#845 ON-19c: the GitHub sign-in relay, cloud side. A person who owns or administers the account asks for `gh auth login --web` on a managed server; the runner relays the one device address and the 8-character one-time
-- code the CLI prints, and the person enters the code on GitHub's own page. Nothing the CLI prints beyond those two values, and no token, reaches the cloud.
--
--   1. machine_login_requests.kind takes 'github' and machine_commands takes 'gh_login_start' and 'gh_logout' (1070's lists, nothing dropped). A github request moves pending -> awaiting_code (the address and the code,
--      sealed together under the machine key, the `auth_url` purpose) -> done | failed, and never passes through code_ready: nobody types a code back to the runner.
--   2. runner_capabilities_values_check and runner_capabilities_record take 'gh_login_v1' (1123's list, nothing dropped, 'gh_login_v1' last). Everything else of the function is 1123's.
--   3. machine_login_report (1070's, owned by machine_ops) reads the request kind from the transaction setting `app.login_kind` (unset: 'claude', so the Claude route is unchanged). It reports only a request of that kind,
--      and a github request may go awaiting_code -> done. A github request that is already over (cancelled, or done and refused) may still be told
--      `signout_failed` (the sign-out that undoes it did not work), so the person sees it; the request stays failed and keeps no sealed value. It is taken only from `failed`, the one state
--      the runner's paths reach (a cancelled request, or a done that was refused). A github report that repeats the request's own end and word answers 200 without a change.
--
-- Numbered 1125 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest, and carry any capability a lower migration added (rebuild step 2 from main's newest definition).

-- ---- 1. the kinds ----------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE machine_login_requests DROP CONSTRAINT machine_login_requests_kind_check;
ALTER TABLE machine_login_requests ADD CONSTRAINT machine_login_requests_kind_check CHECK (kind IN ('claude', 'github'));
ALTER TABLE machine_commands DROP CONSTRAINT machine_commands_kind_check;
ALTER TABLE machine_commands ADD CONSTRAINT machine_commands_kind_check CHECK (kind IN ('claude_login_start', 'claude_login_code', 'claude_logout', 'gh_login_start', 'gh_logout'));
ALTER TABLE machine_commands DROP CONSTRAINT machine_commands_request_with_kind;
ALTER TABLE machine_commands ADD CONSTRAINT machine_commands_request_with_kind CHECK ((kind IN ('claude_logout', 'gh_logout')) = (request_id IS NULL));

-- ---- 2. the capability: a hello that declares 'gh_login_v1' must store (1123's list, nothing dropped, 'gh_login_v1' last) ---------------------------------------------------------
ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1', 'engine_lease_v1', 'survey_public_v1', 'twin_v1', 'platform_fact_v1', 'engine_carry_v1', 'gh_login_v1']::text[]));

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
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1', 'engine_lease_v1', 'survey_public_v1', 'twin_v1', 'platform_fact_v1', 'engine_carry_v1', 'gh_login_v1']))
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

-- ---- 3. the report: one kind per call -----------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'machine_ops'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on machine_ops; cannot replace machine_login_report';
    END IF;
    GRANT machine_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO machine_ops;

CREATE OR REPLACE FUNCTION machine_login_report(p_request uuid, p_state text, p_auth_url_ct bytea, p_failure text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  rid  uuid := NULLIF(current_setting('app.runner_id', true), '')::uuid;
  v_kind text := COALESCE(NULLIF(current_setting('app.login_kind', true), ''), 'claude');
  cur  text;
  cur_failure text;
BEGIN
  IF acct IS NULL OR rid IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'machine_login_report: not a live runner session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_request IS NULL OR p_state IS NULL OR p_state NOT IN ('awaiting_code', 'done', 'failed') OR (p_state = 'awaiting_code') <> (p_auth_url_ct IS NOT NULL)
     OR (p_failure IS NOT NULL AND p_state <> 'failed') OR v_kind NOT IN ('claude', 'github') THEN
    RAISE EXCEPTION 'machine_login_report: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT r.status, r.failure_code INTO cur, cur_failure FROM public.machine_login_requests r
   WHERE r.id = p_request AND r.account_id = acct AND r.runner_id = rid AND r.kind = v_kind AND r.expires_at > now() FOR UPDATE;
  IF cur IS NULL THEN
    RAISE EXCEPTION 'machine_login_report: no such live request' USING ERRCODE = 'no_data_found';
  END IF;
  -- A github report that says what the request already says (the same end, the same word) is answered, not refused: a runner whose reply was lost says it again and must not take that for a cancelled request.
  IF v_kind = 'github' AND p_state IN ('done', 'failed') AND cur = p_state AND cur_failure IS NOT DISTINCT FROM p_failure THEN
    RETURN p_state;
  END IF;
  IF NOT ((p_state = 'awaiting_code' AND cur = 'pending') OR (p_state = 'done' AND (cur = 'code_ready' OR (v_kind = 'github' AND cur = 'awaiting_code'))) OR (p_state = 'failed' AND cur IN ('pending', 'awaiting_code', 'code_ready'))
          OR (p_state = 'failed' AND p_failure IS NOT DISTINCT FROM 'signout_failed' AND v_kind = 'github' AND cur = 'failed')) THEN
    RAISE EXCEPTION 'machine_login_report: the request is %, not a state that takes this report', cur USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE public.machine_login_requests SET status = p_state, auth_url_ct = p_auth_url_ct, code_ct = CASE WHEN p_state = 'awaiting_code' THEN code_ct END, failure_code = p_failure
   WHERE id = p_request;
  RETURN p_state;
END;
$$;

REVOKE CREATE ON SCHEMA public FROM machine_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE machine_ops FROM CURRENT_USER;
  END IF;
END
$$;
