-- DP7-2e (D#7 C26): the person's confirmation of a priced reversal. A re-run spends the customer's own model money, so its compensation row is born
-- `awaiting_confirm` (0933) and nothing runs until the person confirms the live estimate. 0933 gave the row no way out of that state.
--
--   * reversal_compensation_confirm(id, estimate): `awaiting_confirm` to `pending`, once, for a row of the caller's own account, recording the estimate
--     the person confirmed. A repeat (the row is no longer waiting) changes nothing and answers false. Owned by platform_ops like 0933's definers, search_path
--     pinned, EXECUTE for receipt_writer_invoker only, nothing for PUBLIC, refused for a platform_ops login. The route compares the figure with the live
--     price before it calls this; the database holds only the state change.
--   * platform_ops may now UPDATE a row that is `awaiting_confirm` (the policy named it out) and the `estimate_usd` column (the grant named it out).
--     Nothing else widens: the other columns, and every other state, are as 0933 left them.
-- Expand-only.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

GRANT UPDATE (estimate_usd) ON reversal_compensations TO platform_ops;
DROP POLICY platform_ops_compensation_update ON reversal_compensations;
CREATE POLICY platform_ops_compensation_update ON reversal_compensations FOR UPDATE TO platform_ops
  USING (session_user <> 'platform_ops' AND state IN ('awaiting_confirm', 'pending', 'failed', 'running'))
  WITH CHECK (session_user <> 'platform_ops');

CREATE FUNCTION reversal_compensation_confirm(p_id uuid, p_estimate_usd numeric)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'reversal_compensation_confirm: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'receipt_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL OR p_estimate_usd IS NULL OR p_estimate_usd < 0 THEN
    RAISE EXCEPTION 'reversal_compensation_confirm: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.reversal_compensations
     SET state = 'pending', estimate_usd = p_estimate_usd, updated_at = clock_timestamp()
   WHERE id = p_id AND account_id = v_tenant AND state = 'awaiting_confirm' AND kind IN ('rerun', 'revert_pr')
     AND (SELECT public.account_is_active(v_tenant));
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION reversal_compensation_confirm(uuid, numeric) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION reversal_compensation_confirm(uuid, numeric) TO receipt_writer_invoker;
ALTER FUNCTION reversal_compensation_confirm(uuid, numeric) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
