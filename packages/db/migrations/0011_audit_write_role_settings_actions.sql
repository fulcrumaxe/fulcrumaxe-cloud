-- D#2 H12 / PR #89: role-settings writes convert to audit_write().
--
-- packages/core/src/role-settings/auditLog.ts's writeRoleSettingsAuditLog
-- (the ONE call site setMode.ts and guardSettings.ts both use) used to
-- INSERT INTO audit_log directly. PR #91 (D#76, migration 0008) landed on
-- main first and revoked app_user's INSERT grant on audit_log outright,
-- so that raw INSERT is now refused (42501) -- this PR converts the call
-- site to `SELECT audit_write(action, payload)` instead, same as
-- decisions.ts's writeDialSetting.
--
-- audit_write's action allowlist (0008) is a literal array with four
-- entries, none of which are the two actions role-settings writes:
-- 'role_settings.mode_changed' (setMode.ts) and
-- 'role_settings.guard_changed' (guardSettings.ts). 0008's own header
-- comment says a later migration adding an action re-CREATEs the
-- function with a longer array -- this is that migration. Nothing else
-- about audit_write changes: same SECURITY DEFINER, same owner
-- (platform_ops), same pinned search_path, same grants (CREATE OR
-- REPLACE FUNCTION preserves the existing owner and grants on a
-- signature it doesn't change).
--
-- Numbering: 0009 is D#69 PR-A (in flight) and 0010 is H22 #88 (open) --
-- both checked against main and the open-PR list at the time this PR was
-- written. This migration takes 0011, the next free core number.
--
-- D#81 fix round (security review on this PR, #89, then relayed into the
-- D#81 fix round on PR #92): CREATE OR REPLACE on an EXISTING function
-- needs the executing role to hold has_privs_of_role(platform_ops) --
-- INHERIT, not just SET -- it does NOT need CREATE on the schema the way
-- a fresh CREATE or an OWNER TO transfer does (the object already exists;
-- REPLACE preserves its owner and grants). On a database that already has
-- 0200_partners.sql applied, the migration role's platform_ops membership
-- is INHERIT FALSE (0200's own downgrade) -- this migration used to
-- assume the 0001-0200 INHERIT TRUE window was still open, which is true
-- on a fresh chain (0011 sorts before 0200) but not on an
-- already-migrated database receiving 0011 later, one migration at a
-- time. Verified: without this bracket, the REPLACE below fails with
-- "must be owner of function audit_write" on exactly that shape.
-- Bracketed per docs/ops/hosted-postgres.md's per-file rule -- INHERIT
-- only; this never touches CREATE, since it's a REPLACE, not an OWNER TO.
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

  -- Same allowlist as 0008, plus the two role-settings actions this PR
  -- adds.
  IF NOT (p_action = ANY (ARRAY[
    'decision_dial_changed',
    'model_connection.connect',
    'model_connection.replace',
    'model_connection.remove',
    'role_settings.mode_changed',
    'role_settings.guard_changed'
  ])) THEN
    RAISE EXCEPTION 'audit_write: action % is not on the allowlist', p_action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(who::text));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, who::text, p_action, stamped_payload, now())
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- D#81 fix round: downgrade back to INHERIT FALSE now that the REPLACE
-- above is done -- matches 0200_partners.sql's own downgrade shape. SET
-- stays TRUE (still needed elsewhere in the chain / by later migrations
-- with the same bracket).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
