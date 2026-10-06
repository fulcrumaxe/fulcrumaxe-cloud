-- D#31 API-7b (C29): the read seam for audit_log, mirroring audit_write() for writes.
--
-- audit_log_read is SECURITY INVOKER on purpose. app_user already holds SELECT
-- on audit_log under tenant_isolation, which enforces account_id from the
-- app.account_id session GUC plus account_is_active. Running as the caller
-- keeps that RLS policy the single isolation control; a DEFINER function would
-- bypass it and have to reimplement it. There is deliberately no account
-- parameter: a caller cannot name another tenant. An unset GUC or a suspended
-- account therefore returns zero rows, exactly like a direct SELECT.
--
-- Keyset on (created_at, id), newest first. created_at_cursor is the
-- microsecond-precision UTC text the API cursor carries. p_limit is clamped to
-- 1..200 here (NULL means 50). Only app_user may execute it.
-- A new file, never an edit to a merged one.
CREATE FUNCTION audit_log_read(
  p_limit int DEFAULT 50,
  p_before_created_at text DEFAULT NULL,
  p_before_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  action text,
  actor text,
  payload jsonb,
  created_at timestamptz,
  created_at_cursor text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT a.id, a.action, a.actor, a.payload, a.created_at,
         to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    FROM audit_log a
   WHERE p_before_created_at IS NULL
      OR (a.created_at, a.id) < (p_before_created_at::timestamptz, p_before_id)
   ORDER BY a.created_at DESC, a.id DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
$$;

REVOKE ALL ON FUNCTION audit_log_read(int, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_log_read(int, text, uuid) TO app_user;
