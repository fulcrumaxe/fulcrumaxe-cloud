-- D#2 H26a: work-item priority and queue order, part one. A new file.
--
-- 1. work_items.priority (0 urgent .. 3 low, default 2) and queue_rank (the
--    manual order inside a priority, NULLs last). Existing rows take 2.
-- 2. Write path: a column grant on EXACTLY those two columns, in the shape
--    of 0613 (provenance stays closed) and 0630. Nothing wider.
-- 3. audit_write_account_action (0654) is replaced in place with one more
--    allowlist entry, work_item.priority_changed. The four existing entries
--    and every check are unchanged; CREATE OR REPLACE keeps the owner,
--    the EXECUTE grant and the pinned search path. A non-superuser migrator
--    needs the platform_ops bracket to replace it (as 0651).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

ALTER TABLE work_items
  ADD COLUMN priority   smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  ADD COLUMN queue_rank bigint;

GRANT UPDATE (priority, queue_rank) ON work_items TO app_user;

CREATE OR REPLACE FUNCTION audit_write_account_action(
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
    'account.share_public_figures_changed',
    'work_item.priority_changed'
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

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
