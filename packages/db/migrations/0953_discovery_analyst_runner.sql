-- D#483 S4-f4: the docs-and-code analyst as a light runner job, for Cloud-verified (runner_verified) repositories.
--
-- 1. A sixth runner capability, 'discovery_analyst': the runner can run the analyst's confined read-only job. The cloud offers that role only to a runner whose
--    latest hello listed it (the claim reads runner_capabilities, 0893). The table's CHECK and runner_capabilities_record's closed list widen by one value, from
--    {'proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1'}; everything else of the function is 0947's, verbatim (the
--    ADMIN-option bracket, the pinned search_path, the grants). The capability gates only this role, so what a claim offers every other role is unchanged.
-- 2. discovery_analysis_list_due (0950) now also lists an analysis whose repository is Cloud-verified ('runner_verified'), as proposal_verify_list_due (0893) does for
--    the verifier. A Local-only repository stays left out (S4-f5). Only the lister's repository policy and the function body name the second mode; the grants,
--    the owner and the EXECUTE grant are 0950's.
--
-- Expand-only: a CHECK and a closed list widen by one value; a policy and a body widen by one mode. Numbered above main's highest (0951) and the number open work
-- holds (0952); re-checked at open and before merge.

ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst']::text[]));

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
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst']))
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

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'discovery_analysis_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on discovery_analysis_lister; cannot replace discovery_analysis_list_due';
    END IF;
    GRANT discovery_analysis_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

DROP POLICY discovery_analysis_lister_select ON repos;
CREATE POLICY discovery_analysis_lister_select ON repos FOR SELECT TO discovery_analysis_lister
  USING (execution_mode IN ('sandbox', 'runner_verified') AND installation_id IS NOT NULL AND product = 'team');

CREATE OR REPLACE FUNCTION discovery_analysis_list_due(p_limit int)
RETURNS TABLE (account_id uuid, analysis_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'discovery_analysis_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'discovery_analysis_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT d.account_id, d.id
    FROM (
      SELECT x.account_id, x.id, x.created_at,
             row_number() OVER (PARTITION BY x.account_id ORDER BY x.created_at, x.id) AS rn
        FROM public.discovery_analyses x
        JOIN public.accounts a ON a.id = x.account_id AND a.deleted_at IS NULL
        JOIN public.repos r ON r.account_id = x.account_id AND r.id = x.repo_id
                           AND r.execution_mode IN ('sandbox', 'runner_verified') AND r.installation_id IS NOT NULL AND r.product = 'team'
       WHERE x.state IN ('queued', 'running')
    ) d
   WHERE d.rn <= 5
   ORDER BY d.created_at, d.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION discovery_analysis_list_due(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discovery_analysis_list_due(int) TO agent_run_writer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE discovery_analysis_lister FROM CURRENT_USER;
  END IF;
END
$$;
