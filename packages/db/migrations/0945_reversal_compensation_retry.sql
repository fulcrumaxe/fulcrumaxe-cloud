-- DP7-2g (D#7 C32): a person's retry of a failed compensation, on the SAME row.
--
-- The worker's own tick already takes a failed row whose reason is `tooling_error` while attempts are below the cap (0936). Every other failed re-run or
-- revert row waits for a person (the App was uninstalled, the repository went away, the person must act). This is that person's way back:
--
--   * reversal_compensation_retry(id): moves a `failed` row of kind `rerun` or `revert_pr` back to `pending`, clears its reason and resets `attempts` to 0,
--     for a row the tick will NOT take by itself (any reason but `tooling_error`, or `tooling_error` at the cap of 3). It is the same row: no receipt is
--     written, so the reversal count of the item does not move. Any other row is left exactly as it is and the answer says what it is (`pending` and
--     `running` are the tick's own; `awaiting_confirm`, `done`, and the kinds `refused` and `unavailable` are never retried).
--     The audit row ('reversal.retried') is written inside the definer, so the move and its record commit together or not at all. Only an owner or an
--     admin of the caller's own account may call it (re-checked here, not only on the route). Owned by platform_ops like 0933's definers, search_path
--     pinned, EXECUTE for receipt_writer_invoker only, nothing for PUBLIC, refused for a platform_ops login.
--   * No grant, policy or column changes: platform_ops already holds UPDATE on state, reason_code, attempts and updated_at, and the update policy
--     already names `failed` rows.
-- Expand-only.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

CREATE FUNCTION reversal_compensation_retry(p_id uuid)
RETURNS TABLE (o_found boolean, o_moved boolean, o_state text, o_kind text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_who    uuid := current_member_user_id();
  v_row    public.reversal_compensations%ROWTYPE;
  v_prev   uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'reversal_compensation_retry: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'receipt_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_who IS NULL OR NOT (SELECT public.account_is_active(v_tenant))
     OR (current_member_role() IS DISTINCT FROM 'owner' AND current_member_role() IS DISTINCT FROM 'admin') THEN
    RAISE EXCEPTION 'reversal_compensation_retry: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'reversal_compensation_retry: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A plain read, not FOR UPDATE: the row lock applies the UPDATE policy, which does not name `done` or `awaiting_confirm` rows. The compare-and-set is the UPDATE.
  SELECT * INTO v_row FROM public.reversal_compensations c WHERE c.id = p_id AND c.account_id = v_tenant;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE public.reversal_compensations c
     SET state = 'pending', reason_code = NULL, attempts = 0, updated_at = clock_timestamp()
   WHERE c.id = v_row.id AND c.account_id = v_tenant AND c.kind IN ('rerun', 'revert_pr') AND c.state = 'failed'
     AND NOT (c.reason_code IS NOT DISTINCT FROM 'tooling_error' AND c.attempts < 3)
  RETURNING c.id INTO v_prev;
  IF FOUND THEN
    INSERT INTO audit_log (account_id, actor, action, payload, created_at)
    VALUES (v_tenant, v_who::text, 'reversal.retried',
            jsonb_build_object('reversal_id', v_row.id, 'work_item_id', v_row.work_item_id, 'kind', v_row.kind, 'previous_reason', v_row.reason_code),
            clock_timestamp());
    RETURN QUERY SELECT true, true, 'pending'::text, v_row.kind;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, false, v_row.state, v_row.kind;
END $$;

REVOKE ALL ON FUNCTION reversal_compensation_retry(uuid) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION reversal_compensation_retry(uuid) TO receipt_writer_invoker;
ALTER FUNCTION reversal_compensation_retry(uuid) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
