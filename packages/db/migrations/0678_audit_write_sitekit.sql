-- D#3 K07b: the audit path for a site-kit attestation and a version approval.
-- A new file, modelled on 0676. audit_write_sitekit(p_action, p_payload):
-- SECURITY DEFINER, owned by platform_ops, search_path pinned, EXECUTE for
-- app_user only. It lets the attest / approve write and its audit row commit
-- in ONE withTenant transaction (app_user has no INSERT on audit_log).
--   - the action allowlist is fixed here: site.claim_attested and
--     site.version_approved; anything else is refused (22023)
--   - the account and actor are stamped from the tenant session; a
--     caller-supplied actor / account_id / created_at key is overwritten
--   - the stamped actor must be an owner or admin of the account (42501)
--   - payload rules as 0651 / 0676: a JSON object, at most 64 KiB, no
--     compressed argument
-- No existing function or grant changes. Privilege bracket as 0676.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE FUNCTION audit_write_sitekit(p_action text, p_payload jsonb)
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
    RAISE EXCEPTION 'audit_write_sitekit: no app.account_id set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF who IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'audit_write_sitekit: caller is not a verified member of an active account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF current_member_role() IS DISTINCT FROM 'owner' AND current_member_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'audit_write_sitekit: caller is not an owner or admin of the account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('site.claim_attested', 'site.version_approved') THEN
    RAISE EXCEPTION 'audit_write_sitekit: action is not allowed'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write_sitekit: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write_sitekit: payload exceeds 65536 bytes'
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
  VALUES (acct, who::text, p_action, stamped_payload, ts)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION audit_write_sitekit(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write_sitekit(text, jsonb) TO app_user;

GRANT CREATE ON SCHEMA public TO platform_ops;
ALTER FUNCTION audit_write_sitekit(text, jsonb) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
