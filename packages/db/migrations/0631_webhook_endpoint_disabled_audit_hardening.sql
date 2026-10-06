-- D#31 API-4c: hardening for audit_write_webhook_endpoint_disabled(), from
-- the SHOULD findings of the API-4a (#173) security review. A new
-- migration, not an edit to 0627_webhooks.sql (an already-merged file is
-- never edited -- D#94 R1).
--
-- Numbered 0631: main's highest migration is 0630. The number the Spec
-- mentions (0628) is illustrative only and is already taken.
--
-- Two changes to the function, both behind CREATE OR REPLACE with the
-- unchanged signature (uuid, uuid) and unchanged return type:
--   1. It now refuses a pair where no webhook_endpoints row has
--      id = p_endpoint_id AND account_id = p_account_id. Before, a
--      mismatched pair silently wrote an audit row attributed to an
--      account that never owned the endpoint.
--   2. It pins search_path = pg_catalog, public, pg_temp, the same as
--      audit_write / audit_write_system (0612).
-- The function stays SECURITY INVOKER (0627's own rationale: its only
-- caller, sweep.ts, already runs as platform_ops with its own INSERT
-- policy + grant on audit_log and its own full-access policy on
-- webhook_endpoints, so the existence check below sees the row without
-- any privilege elevation). Its ownership moves to platform_ops, like the
-- rest of this function family.
--
-- LANGUAGE changes from sql to plpgsql because a check-then-raise needs
-- control flow; CREATE OR REPLACE permits that.
CREATE OR REPLACE FUNCTION audit_write_webhook_endpoint_disabled(p_account_id uuid, p_endpoint_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM webhook_endpoints
    WHERE id = p_endpoint_id AND account_id = p_account_id
  ) THEN
    -- 22023 (invalid_parameter_value): same code audit_write uses for a
    -- bad argument. No audit_log row is written on this path.
    RAISE EXCEPTION 'audit_write_webhook_endpoint_disabled: endpoint % does not belong to account %',
      p_endpoint_id, p_account_id
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (
    p_account_id,
    'platform_ops',
    'webhook_endpoint.disabled',
    jsonb_build_object('endpoint_id', p_endpoint_id, 'reason', 'failing'),
    clock_timestamp()
  );
END;
$$;

-- Same grants as 0627 (re-stated so this file stands on its own).
REVOKE ALL ON FUNCTION audit_write_webhook_endpoint_disabled(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write_webhook_endpoint_disabled(uuid, uuid) TO platform_ops;

-- D#81/#92 per-file bracket (docs/ops/hosted-postgres.md; same pattern as
-- 0616/0624/0628): OWNER TO platform_ops needs platform_ops to hold CREATE
-- on schema public at that moment, which is not guaranteed on an
-- already-migrated database, and test-neon-shape.sh's end-state check
-- requires it be revoked again afterwards.
GRANT CREATE ON SCHEMA public TO platform_ops;
ALTER FUNCTION audit_write_webhook_endpoint_disabled(uuid, uuid) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;
