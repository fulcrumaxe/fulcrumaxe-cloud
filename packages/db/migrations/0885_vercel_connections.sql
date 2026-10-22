-- D#598 P8d-2: the "connect Vercel" connection kind. An account stores ONE Vercel API token, sealed, so the setup-request env-var check
-- (P8d-1) can list a project's variable names with the customer's own credential.
--
-- vercel_connections: one row per account (UNIQUE account_id). The token is never stored in the clear: the same envelope as model_connections
-- (data key under the platform key-encryption key, key version recorded per row, AAD bound to account + row + purpose 'vercel_token').
-- `token_fingerprint` is the display tail (last 4 of a keyed hash), `team_id` the optional Vercel team scope. `status` is 'rejected' once Vercel
-- refused the stored token (the check sweep records it); connecting or rotating to a token Vercel accepted sets it back to 'ok'.
-- Rotation is one UPDATE of every sealed column in one transaction, so a reader sees the old token or the new one, never a mix.
--
-- audit_write is replaced whole from 0876 (CREATE OR REPLACE keeps owner, grants and search path) with three more actions:
-- 'vercel_connection.connect', 'vercel_connection.rotate' and 'vercel_connection.remove'. Another open migration that also replaces audit_write
-- would drop these entries (last file wins); whoever merges second must re-carry the list.
-- Numbered 0885: main holds up to 0883 and open #374 claims 0884. Re-check against main right before merging.
CREATE TABLE vercel_connections (
  id                 uuid PRIMARY KEY,
  account_id         uuid NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
  token_ciphertext   bytea NOT NULL,
  token_nonce        bytea NOT NULL,
  wrapped_dek        bytea NOT NULL,
  kek_version        integer NOT NULL CHECK (kek_version >= 1),
  token_fingerprint  text NOT NULL,
  team_id            text CHECK (team_id ~ '^team_[A-Za-z0-9]{1,64}$'),
  status             text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'rejected')),
  rejected_at        timestamptz,
  created_by         uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  rotated_at         timestamptz
);

ALTER TABLE vercel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE vercel_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vercel_connections TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON vercel_connections TO app_user;

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

  -- The 0876 allowlist carried forward whole, plus the three Vercel connection actions. NULL fails
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
    'run_limits.changed',
    'decision_ask_setting.changed',
    'ask_route.changed',
    'discovery_setting.changed',
    'build_concurrency.changed',
    'envelope.changed',
    'autostart_envelope.changed',
    'envelope_margin.changed',
    'context_rule.saved',
    'context_rule.replaced',
    'context_rule.removed',
    'vercel_connection.connect',
    'vercel_connection.rotate',
    'vercel_connection.remove'
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

-- CREATE OR REPLACE preserves the owner and grants on an unchanged signature; re-run because they are idempotent (0651's pattern).
REVOKE ALL ON FUNCTION audit_write(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO context_rules_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
