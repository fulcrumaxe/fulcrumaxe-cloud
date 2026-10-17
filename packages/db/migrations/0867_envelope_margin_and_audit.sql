-- D#483 S5-e2: the person's default envelope margin as an append-only history, one-weekly-envelope-per-account, and the audit actions for envelope writes.
--
-- Three things, all expand-only:
--   1. envelope_margin_settings   the margin (in percent, 0 to 500) the pre-fill of an approval's envelope adds to the priced estimate. A change is a NEW ROW
--                                 with the next `version` for the account (the highest version is the current value); nothing is updated or deleted, so who set
--                                 what, and when, stays readable. No row means the plan data's `envelope.defaultMarginPct` applies (and with none of that the
--                                 pre-fill is the bare estimate). app_user holds SELECT and INSERT only. The insert policy requires `changed_by` to be the
--                                 session's own user AND that user to be an owner or admin of the account, as 0830 does for the build-concurrency setting, so a
--                                 plain member, a token (it carries no user) and a userless session cannot insert. The routes add the session-only rule.
--   2. approval_envelopes_one_weekly_idx   a partial unique index: an account has at most ONE weekly auto-start envelope id, so two first writers racing to
--                                 create it cannot leave two envelopes of that scope (the second fails on the index and is told the setting changed).
--   3. audit_write                replaced whole from 0850, keeping all twelve of its actions and adding 'envelope.changed', 'autostart_envelope.changed' and
--                                 'envelope_margin.changed'. #310 (0865) does not replace audit_write, and no other open migration does; whoever merges second
--                                 after a migration that does must re-carry the list (CREATE OR REPLACE: last file wins). CREATE OR REPLACE keeps the owner,
--                                 the EXECUTE grant and the pinned search path.
--
-- No existing table, column, grant or action changes. Rolling the code back leaves a table and an allowlist entry that nothing calls.
-- Numbered 0867: main holds up to 0866 (the envelope_pause_receipt_record red-main fix). Re-check against main right before merging.
CREATE TABLE envelope_margin_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  margin_pct  numeric(6, 2) NOT NULL CONSTRAINT envelope_margin_settings_margin_check CHECK (margin_pct >= 0 AND margin_pct <= 500),
  version     integer NOT NULL CONSTRAINT envelope_margin_settings_version_check CHECK (version >= 1),
  changed_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT envelope_margin_settings_account_version UNIQUE (account_id, version)
);

-- created_at is always the database's own clock, whatever an INSERT says.
CREATE FUNCTION envelope_margin_settings_set_created_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
-- Not executable by PUBLIC: platform_ops (a member of PUBLIC) must gain no EXECUTE. A trigger needs no EXECUTE grant to fire.
REVOKE ALL ON FUNCTION envelope_margin_settings_set_created_at() FROM PUBLIC;
CREATE TRIGGER envelope_margin_settings_set_created_at
  BEFORE INSERT ON envelope_margin_settings
  FOR EACH ROW EXECUTE FUNCTION envelope_margin_settings_set_created_at();

ALTER TABLE envelope_margin_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE envelope_margin_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON envelope_margin_settings FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_isolation_insert ON envelope_margin_settings FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND changed_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
       WHERE m.account_id = envelope_margin_settings.account_id AND m.user_id = envelope_margin_settings.changed_by AND m.role IN ('owner', 'admin')
    )
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT ON envelope_margin_settings TO app_user;

CREATE UNIQUE INDEX approval_envelopes_one_weekly_idx ON approval_envelopes (account_id) WHERE scope = 'weekly_autostart' AND version = 1;

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

  -- The 0850 allowlist carried forward whole, plus the three envelope actions. NULL fails
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
    'envelope_margin.changed'
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
