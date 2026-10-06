-- D#2 H26b: the audit path for a work-item priority change. A new file.
--
-- audit_write_work_item_priority(p_work_item_id, p_payload): SECURITY
-- DEFINER, owned by platform_ops, search_path pinned, EXECUTE for app_user
-- only. It lets the change, its audit row and its domain event commit in
-- ONE withTenant transaction (app_user holds the column grant on priority /
-- queue_rank but has no INSERT on audit_log; platform_ops can write the
-- audit row but not the columns).
--   - the action is fixed, 'work_item.priority_changed': no action argument
--   - the account and actor are stamped from the tenant session (as
--     audit_write, 0651); a caller-supplied actor / account_id / created_at
--     key in the payload is overwritten
--   - floor checks: the stamped actor is an owner or admin of the stamped
--     account, and the work item belongs to that account; else 42501
--   - payload rules as 0651: a JSON object, at most 64 KiB, no compressed
--     argument
-- No existing grant and no other definer changes. Privilege bracket copied
-- from 0654 / 0670.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE FUNCTION audit_write_work_item_priority(p_work_item_id uuid, p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct            uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  who             uuid := current_member_user_id();
  ts              timestamptz := clock_timestamp();
  stamped_payload jsonb := p_payload;
  new_id          uuid;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'audit_write_work_item_priority: no app.account_id set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF who IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'audit_write_work_item_priority: caller is not a verified member of an active account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF current_member_role() IS DISTINCT FROM 'owner' AND current_member_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'audit_write_work_item_priority: caller is not an owner or admin of the account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_work_item_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.work_items w WHERE w.id = p_work_item_id AND w.account_id = acct
  ) THEN
    RAISE EXCEPTION 'audit_write_work_item_priority: work item is not in the caller''s account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write_work_item_priority: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write_work_item_priority: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(who::text));
  END IF;
  IF stamped_payload ? 'account_id' THEN
    stamped_payload := stamped_payload || jsonb_build_object('account_id', to_jsonb(acct::text));
  END IF;
  IF stamped_payload ? 'created_at' THEN
    stamped_payload := stamped_payload || jsonb_build_object('created_at', to_jsonb(ts));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, who::text, 'work_item.priority_changed', stamped_payload, ts)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION audit_write_work_item_priority(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write_work_item_priority(uuid, jsonb) TO app_user;

GRANT CREATE ON SCHEMA public TO platform_ops;
ALTER FUNCTION audit_write_work_item_priority(uuid, jsonb) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
