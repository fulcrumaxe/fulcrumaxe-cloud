-- D#7 DP12a-1: the customer's ask settings (answer window, timeout outcome, notify), as append-only versions.
--
-- 1. decision_ask_settings: one row per change, keyed (account, repo or NULL, decision type or '*'). A row's three values are each NULL
--    ("not set here, inherit") or inside the bounds below, so changing only the window never silently resets the outcome. All three NULL
--    is a legal version: it is how an override is removed (the undo path is a new version, never a DELETE). The current value for a key
--    is its highest version. resolveAskPolicy (packages/decisions/src/askPolicy.ts) walks repo+type, repo+'*', account+type, account+'*',
--    then the preset default, taking the first non-NULL value per field and clamping the outcome to the catalogue entry.
-- 2. Same shape as decision_settings (0400): app_user holds SELECT and INSERT and nothing else; the INSERT policy binds changed_by to the
--    session's user and requires owner or admin; a BEFORE INSERT trigger makes version exactly max+1 per key. The repo FK is NO ACTION for
--    the reason 0400 gives (a member holding DELETE on repos must not be able to erase settings history). The audit row is written by the
--    TypeScript writer in the same transaction (packages/db/src/decisionAskSettings.ts).
-- 3. audit_write is replaced whole from 0651 (newest definition on main), adding only 'decision_ask_setting.changed'. CREATE OR REPLACE
--    keeps the owner, the EXECUTE grant and the pinned search path. Another open migration that also replaces audit_write would drop this
--    entry (last file wins), so whoever merges second must re-carry the list.
-- Additive only: no existing object is dropped, renamed or narrowed. A new file; the number is above the highest on the code plane and is
-- re-checked right before merge. Privilege bracket copied from 0651.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE TABLE decision_ask_settings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id                uuid,
  decision_type          text NOT NULL CHECK (decision_type = '*' OR decision_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- 15 minutes to 14 days (D#7 DP-C5 R3). NULL = inherit.
  answer_window_minutes  integer CHECK (answer_window_minutes BETWEEN 15 AND 20160),
  timeout_outcome        text CHECK (timeout_outcome IN ('stop_and_flag', 'proceed_recommended')),
  notify                 text CHECK (notify IN ('email', 'none')),
  version                integer NOT NULL CHECK (version >= 1),
  changed_by             uuid NOT NULL REFERENCES users (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, repo_id, decision_type, version),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE NO ACTION
);

-- A NULL repo_id is distinct in the UNIQUE above, so the account-wide key needs its own index to keep two writers from taking one version.
CREATE UNIQUE INDEX decision_ask_settings_account_key
  ON decision_ask_settings (account_id, decision_type, version) WHERE repo_id IS NULL;

CREATE FUNCTION decision_ask_settings_enforce_next_version() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  expected_version integer;
BEGIN
  SELECT COALESCE(MAX(version), 0) + 1 INTO expected_version
  FROM decision_ask_settings
  WHERE account_id = NEW.account_id
    AND repo_id IS NOT DISTINCT FROM NEW.repo_id
    AND decision_type = NEW.decision_type;
  IF NEW.version <> expected_version THEN
    RAISE EXCEPTION 'decision_ask_settings.version must be % (the next version for this key), got %', expected_version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- A trigger function is not called by name, and its EXECUTE privilege is checked only when the trigger is created, so nothing else needs it.
REVOKE ALL ON FUNCTION decision_ask_settings_enforce_next_version() FROM PUBLIC;

CREATE TRIGGER decision_ask_settings_enforce_next_version
  BEFORE INSERT ON decision_ask_settings
  FOR EACH ROW EXECUTE FUNCTION decision_ask_settings_enforce_next_version();

ALTER TABLE decision_ask_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_ask_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON decision_ask_settings
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

CREATE POLICY owner_or_admin_insert ON decision_ask_settings
  FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND changed_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = decision_ask_settings.account_id
        AND m.user_id = decision_ask_settings.changed_by
        AND m.role IN ('owner', 'admin')
    )
  );

-- Append-only for app_user: no UPDATE and no DELETE grant, so no policy is needed for either verb.
GRANT SELECT, INSERT ON decision_ask_settings TO app_user;

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

  -- The 0651 allowlist carried forward whole, plus 'decision_ask_setting.changed'. NULL fails
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
    'decision_ask_setting.changed'
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

-- CREATE OR REPLACE preserves the existing owner and grants on an unchanged signature. Re-run because they are idempotent (0651's pattern).
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
