-- D#483 S5-g1: how often a repository is re-discovered, as an append-only history.
--
-- Discovery (the daily sweep, S5-g2) refreshes a repo's inbox of proposals. How often it runs is the person's choice per repo:
-- `daily`, `weekly` or `off`. This table holds that choice and every change to it. A change is a NEW ROW with the next `version` for
-- the repo (the highest version is the current value). Nothing is updated or deleted, so who changed what and when stays readable.
-- No row for a repo means `daily`; that default lives in code (packages/db/src/discoverySettings.ts), not in this table.
--
-- Derived state, not a stamp: whether a repo is due, skipped ("discovery is off") or running is computed from this table and the
-- sweep's own facts each time it is read. Nothing here records that a sweep ran.
--
-- Who may write: app_user holds SELECT and INSERT only (no UPDATE, no DELETE). The insert policy requires the row's account to be the
-- session's account and `changed_by` to be the session's own user AND that user to be an owner or admin of the account, so a row can
-- neither be written for another account nor attributed to another person, and a plain member or a userless session cannot insert.
-- A BEFORE INSERT trigger makes `version` exactly max+1 for the repo, and created_at is the database's own clock.
-- The audit row is written by the TypeScript writer in the same transaction.
--
-- The repo FK is NO ACTION (as in 0400 and 0812): a repo cannot be hard-deleted while a setting row names it, so a holder of DELETE on
-- repos cannot erase the history of who switched discovery off.
--
-- audit_write is replaced whole from 0836 (newest definition on main, which carries 'ask_route.changed'), adding only
-- 'discovery_setting.changed'. CREATE OR REPLACE keeps
-- the owner, the EXECUTE grant and the pinned search path. Another open migration that also replaces audit_write would drop this entry
-- (last file wins), so whoever merges second must re-carry the list.
--
-- Expand-only: a new table and a widened allowlist, nothing existing is dropped, renamed or narrowed. Numbered above the highest
-- migration on the code plane and the open PRs' claims (0849); re-checked right before merge. Privilege bracket copied from 0812.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE TABLE discovery_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id     uuid NOT NULL,
  frequency   text NOT NULL CONSTRAINT discovery_settings_frequency_check CHECK (frequency IN ('daily', 'weekly', 'off')),
  version     integer NOT NULL CONSTRAINT discovery_settings_version_check CHECK (version >= 1),
  changed_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_settings_repo_version_key UNIQUE (account_id, repo_id, version),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE NO ACTION
);

CREATE FUNCTION discovery_settings_enforce_next_version() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  expected_version integer;
BEGIN
  SELECT COALESCE(MAX(version), 0) + 1 INTO expected_version
  FROM discovery_settings
  WHERE account_id = NEW.account_id AND repo_id = NEW.repo_id;
  IF NEW.version <> expected_version THEN
    RAISE EXCEPTION 'discovery_settings.version must be % (the next version for this repo), got %', expected_version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  -- created_at is always the database's own clock, whatever an INSERT says.
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

-- A trigger function is not called by name, and its EXECUTE privilege is checked only when the trigger is created.
REVOKE ALL ON FUNCTION discovery_settings_enforce_next_version() FROM PUBLIC;

CREATE TRIGGER discovery_settings_enforce_next_version
  BEFORE INSERT ON discovery_settings
  FOR EACH ROW EXECUTE FUNCTION discovery_settings_enforce_next_version();

ALTER TABLE discovery_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON discovery_settings
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

CREATE POLICY owner_or_admin_insert ON discovery_settings
  FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND changed_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = discovery_settings.account_id
        AND m.user_id = discovery_settings.changed_by
        AND m.role IN ('owner', 'admin')
    )
  );

-- Append-only for app_user: no UPDATE and no DELETE grant, so no policy is needed for either verb.
GRANT SELECT, INSERT ON discovery_settings TO app_user;

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

  -- The 0836 allowlist carried forward whole, plus 'discovery_setting.changed'. NULL fails
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
    'discovery_setting.changed'
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
