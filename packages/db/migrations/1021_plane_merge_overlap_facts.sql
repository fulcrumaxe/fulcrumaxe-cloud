-- D#483 S5-j2e-RUNNER PR 1: a blocked merge order may carry the runner's overlap facts, and the fourteenth runner capability, 'overlap_facts_v1'.
--
-- (1) A runner that kept 'overlap_facts_v1' may attach a closed verdict (shas, a ref name, at most 100 paths; no content) to a plane-merge-verify whose ordering fact names an overlap. When the gate then
-- blocks the order for that overlap, the cloud keeps the facts on the order in the four conflict columns of 0970, in the statement that ends it. The shape CHECK of 0970 allowed them only on a failed order
-- (the runner's refused merge call); it now also allows them on a `blocked` order that never had a write credential, with a platform or foreign verdict and one of the two ordering codes. A failed order's
-- rows, and an order with no facts, satisfy the new CHECK exactly as they did the old one. The guard function of 0970 already holds "written with the order's end" and does not change.
-- (2) The capability list and runner_capabilities_record widen by one value, from the thirteen of 1006; everything else of the function is 1006's, verbatim (same signature, owner, pinned search_path,
-- grants and the ADMIN-option bracket).
--
-- Expand-only: a CHECK is replaced by a weaker one and a closed list widens by one value. Nothing is removed from either in place. The number is the one the migration ledger holds for this row.

ALTER TABLE plane_merge_orders DROP CONSTRAINT plane_merge_orders_conflict_shape;
ALTER TABLE plane_merge_orders ADD CONSTRAINT plane_merge_orders_conflict_shape CHECK (
  (conflict_verdict IS NULL AND conflict_base_sha IS NULL AND conflict_base_ref IS NULL AND conflict_files IS NULL)
  OR (conflict_verdict IS NOT NULL AND conflict_base_sha IS NOT NULL AND conflict_base_ref IS NOT NULL AND conflict_files IS NOT NULL
      AND ((state = 'failed' AND write_token_issued_at IS NOT NULL
            AND outcome_code = CASE conflict_verdict WHEN 'conflict_platform' THEN 'merge_conflict_runner' ELSE 'merge_conflict_foreign' END)
        OR (state = 'blocked' AND write_token_issued_at IS NULL AND outcome_code IN ('overlap_unreviewed', 'ordered_resource_out_of_order')))));

ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1']::text[]));

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
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1']))
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
