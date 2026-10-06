-- D#31 API-8b: role model overrides with the H22 floor.
--
-- 1. audit_write gains 'role_settings.model_changed'. The function is
--    replaced whole from 0612 (the newest definition on main; only 0011 and
--    0612 define it): same signature, owner, SECURITY DEFINER and pinned
--    search_path, and the WHOLE 0612 allowlist and body carried forward, with
--    that one action added. audit_write_system is not touched.
-- 2. role_settings.model gets two CHECKs, the database backstop behind the
--    route (which applies applyCustomerOverride) and core (ROLE_MODEL_IDS):
--    the model is one of the three ids, and the floored roles
--    (security-reviewer, security-expert; packages/model-router/src/floors.ts)
--    never hold haiku-4.5. packages/model-router/test/role-model-parity.test.ts
--    fails if the ids, the tier order, the floors and these CHECKs drift.
--    Existing rows: nothing wrote role_settings.model before this task, so no
--    stored value can violate them.
--
-- A new file, never an edit to a merged one (D#94 R1). The privilege bracket
-- is copied from 0612 (D#81/#92).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION audit_write(p_action text, p_payload jsonb DEFAULT NULL)
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
    RAISE EXCEPTION 'audit_write: no app.account_id set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF who IS NULL THEN
    RAISE EXCEPTION 'audit_write: caller is not a verified member of account %', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'audit_write: account % is not active', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The 0612 allowlist carried forward whole, plus 'role_settings.model_changed'. NULL now fails
  -- closed explicitly (note (b) above) instead of relying on
  -- `NOT (p_action = ANY(...))` evaluating to NULL (falsy for IF) on a
  -- NULL p_action.
  IF p_action IS NULL OR NOT (p_action = ANY (ARRAY[
    'decision_dial_changed',
    'model_connection.connect',
    'model_connection.replace',
    'model_connection.remove',
    'role_settings.mode_changed',
    'role_settings.guard_changed',
    'role_settings.model_changed'
  ])) THEN
    RAISE EXCEPTION 'audit_write: action % is not on the allowlist', p_action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Note (c) above: bounds a single payload's serialized size, and
  -- (D#97 fix round 1) fails closed on any TOAST-compressed argument
  -- regardless of its compressed size.
  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Decision (c)/note (a): a caller-supplied `actor`, `account_id` or
  -- `created_at` key inside the payload is overwritten with the stamped
  -- value, never trusted. Every other key (including nested ones) is
  -- stored exactly as sent.
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

-- Decision 4: CREATE OR REPLACE preserves the existing owner and grants
-- on an unchanged signature -- no owner-reassigning ALTER FUNCTION is
-- needed or wanted. These are re-run anyway because they are idempotent,
-- matching 0011's own pattern.
REVOKE ALL ON FUNCTION audit_write(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO app_user;

ALTER TABLE role_settings
  ADD CONSTRAINT role_settings_model_known
    CHECK (model IS NULL OR model IN ('haiku-4.5', 'sonnet-5', 'opus-5')),
  ADD CONSTRAINT role_settings_model_floor
    CHECK (model IS NULL OR role NOT IN ('security-reviewer', 'security-expert') OR model IN ('sonnet-5', 'opus-5'));

-- Close the window opened above, matching 0011's own downgrade shape.
-- SET stays TRUE (still needed elsewhere in the chain / by later
-- migrations with the same bracket).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
