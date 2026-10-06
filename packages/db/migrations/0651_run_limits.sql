-- D#2 C48 H12c: customer-configurable run limits, per account and per role.
--
-- 1. run_limits: key (account_id, role), role '*' = the account default.
--    Every limit is NULL ("inherit") or between the floor and ceiling in
--    packages/core/src/run-limits/limits.ts (parity-tested). RLS is the
--    role_settings pattern; writes come from the service's withTenant
--    transaction (owner/admin gate in core).
-- 2. audit_write is replaced whole from 0645 (newest definition on main),
--    adding only 'run_limits.changed'.
-- A new file, never an edit to a merged one (D#94 R1). Privilege bracket
-- copied from 0645/0612.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE TABLE run_limits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role = '*' OR role ~ '^[a-z][a-z0-9-]*$'),
  max_run_minutes  integer CHECK (max_run_minutes BETWEEN 5 AND 240),
  max_model_calls  integer CHECK (max_model_calls BETWEEN 20 AND 1500),
  per_run_usd      numeric(8, 2) CHECK (per_run_usd BETWEEN 1 AND 200),
  max_turns        integer CHECK (max_turns BETWEEN 10 AND 500),
  silence_minutes  integer CHECK (silence_minutes BETWEEN 11 AND 30),
  max_extensions   integer CHECK (max_extensions BETWEEN 0 AND 4),
  max_resumes      integer CHECK (max_resumes BETWEEN 0 AND 5),
  auto_resume      boolean,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, role)
);

ALTER TABLE run_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON run_limits TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON run_limits TO app_user;

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

  -- The 0645 allowlist carried forward whole, plus 'run_limits.changed'. NULL fails
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
    'role_settings.model_changed',
    'run_limits.changed'
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

-- Close the window opened above.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
