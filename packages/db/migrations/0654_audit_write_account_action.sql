-- D#31 API-7c-1: the audit path for account-level billing actions, plus
-- C16's accounts.share_public_figures column. A new file, never an edit to
-- a merged one (D#94 R1).
--
-- 1. audit_write_account_action(p_account_id, p_user_id, p_action,
--    p_payload): SECURITY INVOKER, owned by platform_ops, search_path
--    pinned, EXECUTE for platform_ops only -- the same family shape as
--    audit_write_webhook_endpoint_disabled (0627/0631). Its callers run as
--    platform_ops in the same transaction as the write they record, so the
--    state change and its audit row commit together or not at all.
--    platform_ops already holds INSERT on the audit table (with its own
--    policy, 0200) and SELECT on account_members, so no privilege is
--    elevated.
--      - fixed four-action allowlist; NULL, blank or anything else: 22023
--      - p_user_id must be an owner or admin of p_account_id: else 42501
--      - the actor is p_user_id::text, the format audit_write stamps
--      - payload rules as audit_write's: a JSON object, at most 64 KiB, no
--        compressed argument, and the actor / account_id / created_at
--        keys overwritten with the stamped values
--      - created_at = clock_timestamp()
--    audit_write and audit_write_system are not touched.
-- 2. accounts.share_public_figures boolean NOT NULL DEFAULT false (C16).
--    Nothing reads or writes it yet.
--
-- Privilege bracket for OWNER TO platform_ops copied from 0631.
CREATE FUNCTION audit_write_account_action(
  p_account_id uuid,
  p_user_id    uuid,
  p_action     text,
  p_payload    jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts              timestamptz := clock_timestamp();
  stamped_payload jsonb := p_payload;
  new_id          uuid;
BEGIN
  IF p_action IS NULL OR NOT (p_action = ANY (ARRAY[
    'account.paused',
    'account.resumed',
    'account.budgets_changed',
    'account.share_public_figures_changed'
  ])) THEN
    RAISE EXCEPTION 'audit_write_account_action: action % is not on the allowlist', p_action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write_account_action: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write_account_action: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_account_id IS NULL OR p_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM account_members
    WHERE account_id = p_account_id AND user_id = p_user_id AND role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'audit_write_account_action: user is not an owner or admin of the account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(p_user_id::text));
  END IF;
  IF stamped_payload ? 'account_id' THEN
    stamped_payload := stamped_payload || jsonb_build_object('account_id', to_jsonb(p_account_id::text));
  END IF;
  IF stamped_payload ? 'created_at' THEN
    stamped_payload := stamped_payload || jsonb_build_object('created_at', to_jsonb(ts));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (p_account_id, p_user_id::text, p_action, stamped_payload, ts)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION audit_write_account_action(uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write_account_action(uuid, uuid, text, jsonb) TO platform_ops;

GRANT CREATE ON SCHEMA public TO platform_ops;
ALTER FUNCTION audit_write_account_action(uuid, uuid, text, jsonb) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;

ALTER TABLE accounts ADD COLUMN share_public_figures boolean NOT NULL DEFAULT false;
