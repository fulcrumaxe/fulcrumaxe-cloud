-- OPERATOR-SUB-EXCEPTION: runs on the operator's own subscription.
--
-- 1. A run powered by the operator's own subscription is not billed per token, so its model ledger row needs a
--    source of its own (recorded at $0, never against an account's monthly budget). The source list is a CHECK on
--    ledger.source; the constraint is the one 0001 created inline, replaced here by the same list plus the new
--    value. Existing rows all satisfy the wider list, so the re-add validates cleanly.
-- 2. onboarding_preview_record_mode(preview id, mode): the audit row that says which model path a started preview
--    ran on ('operator_subscription' or 'customer_key'). The worker's login has no INSERT on audit_log, so this is
--    a narrow definer (owner platform_ops, EXECUTE for agent_run_writer only): it takes the preview id and the mode,
--    reads the account from the STARTED preview row (never from the caller), refuses any other mode value, writes
--    one audit row with ids and the enum only, and refuses a preview that is not running. Privilege brackets as in 0682.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

ALTER TABLE ledger DROP CONSTRAINT ledger_source_check;
ALTER TABLE ledger
  ADD CONSTRAINT ledger_source_check
    CHECK (source IN ('customer_gateway', 'customer_anthropic', 'sandbox', 'workflow', 'operator_subscription'));

CREATE FUNCTION onboarding_preview_record_mode(p_preview_id uuid, p_mode text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_account uuid;
  v_run uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'onboarding_preview_record_mode: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('operator_subscription', 'customer_key') THEN
    RAISE EXCEPTION 'onboarding_preview_record_mode: unknown mode' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT p.account_id, p.run_id INTO v_account, v_run FROM public.onboarding_previews p WHERE p.id = p_preview_id AND p.run_id IS NOT NULL AND p.state = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'onboarding_preview_record_mode: no running preview' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (v_account, 'system:onboarding_preview', 'onboarding_preview.model_mode',
          jsonb_build_object('preview_id', p_preview_id, 'run_id', v_run, 'mode', p_mode), clock_timestamp());
END $$;

REVOKE ALL ON FUNCTION onboarding_preview_record_mode(uuid, text) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION onboarding_preview_record_mode(uuid, text) TO agent_run_writer;
ALTER FUNCTION onboarding_preview_record_mode(uuid, text) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
