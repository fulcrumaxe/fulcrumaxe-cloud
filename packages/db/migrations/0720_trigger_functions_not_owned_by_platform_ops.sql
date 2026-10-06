-- D#2 hardening (security review of #522/#523, CWE-284/693): a trigger function whose job is to refuse direct writes
-- by the platform_ops login is useless while platform_ops OWNS it. The owner can DROP FUNCTION ... CASCADE, which
-- removes the triggers, and then write directly. Every trigger function moves to the role that runs the migrations,
-- which already owns the tables and every other non-definer function.
--
--   forbid_api_token_unrevoke()   (0621)  invoker; owner changed in place.
--
-- Two trigger functions were SECURITY DEFINER and platform_ops-owned. Each is split in two:
--   * a new INVOKER trigger function, owned by the migration role, that does nothing but call
--   * a new SECURITY DEFINER helper `<name>_apply`, with the old body, owned by the new NOLOGIN role guard_definer.
-- The triggers are repointed to the new trigger functions and the old definers are left in place, unused (expand/contract: a later migration marked `-- contract-phase: PR #524` drops them). Fail closed: if a helper
-- is dropped or its EXECUTE is revoked, the write that fires the trigger errors instead of silently skipping the work.
--   runner_revoke_on_member_change() (0712) -> runner_revoke_on_member_change_trigger() + _apply(uuid, uuid)
--   model_connections_onboarding_mark() (0692) -> model_connections_onboarding_mark_trigger() + _apply(uuid)
--
-- Why a role of its own. A helper owned by platform_ops could be neutered by platform_ops without an error and
-- without CREATE on the schema: ALTER FUNCTION ... IMMUTABLE makes the trigger function's PERFORM run on the snapshot
-- from before the row change, so the helper's precondition sees the old state and returns early. The owner of a
-- function can change its attributes, so the owner must be a role nothing can become:
--   guard_definer   NOLOGIN, no members (the migration role is removed again below), a member of nothing. Holds only
--                   what the two helper bodies read and write: column SELECTs on account_members, runners,
--                   model_connections and accounts, UPDATE on runners(revoked_at, revoked_reason) and
--                   accounts(onboarding_key_ok_at), INSERT on audit_log; each on a forced-RLS table has a policy for this
--                   role only. test-neon-shape criterion 8 names it as an exemption (the two helpers, search_path
--                   pinned, EXECUTE for app_user and the migration role only).
-- Same pattern as sandbox_reaper in #514, copied rather than depended on so the two migrations stay independent.
--
-- The helpers re-derive their precondition from table state instead of trusting their arguments, so a direct call
-- by an EXECUTE holder can do no more than the trigger would have done:
--   runner_revoke_on_member_change_apply(account, user)   revokes only when the user is no longer owner/admin there
--   model_connections_onboarding_mark_apply(account)     marks only when the account has a connection with status ok
-- The audit actor is app.user_id only when that user is a member of the account (or is the departing user); any
-- other value is recorded as 'system:membership', so a direct cross-tenant call cannot name another tenant's user.
-- EXECUTE on a helper goes to app_user, platform_ops (both write the tables and fire the triggers as themselves) and
-- the owner of the table (FK cascades run as that owner), granted AFTER the owner change, because changing a function's owner rewrites ACL entries naming the old one.
--
-- agent_runs_write_guard() and agent_runs_identity_immutable() (0642) were never given to platform_ops.
--
-- Safe on a database that already has these functions: the owner change is idempotent and catalog-only, the new objects
-- are created fresh, and the trigger swap happens in this one transaction (DROP/CREATE TRIGGER takes a brief lock on
-- two small tables). Privilege brackets as in 0692 and 0715: on a Neon-shaped database the migration role holds
-- platform_ops and guard_definer only inside this file, as INHERIT TRUE, and both are removed or reset afterwards.

-- ---- the role ---------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text := 'guard_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO guard_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO guard_definer;
GRANT SELECT (id, account_id, registered_by, revoked_at), UPDATE (revoked_at, revoked_reason) ON runners TO guard_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO guard_definer;
GRANT SELECT (account_id, status) ON model_connections TO guard_definer;
GRANT SELECT (id, onboarding_key_ok_at), UPDATE (onboarding_key_ok_at) ON accounts TO guard_definer;

CREATE POLICY guard_definer_select ON account_members FOR SELECT TO guard_definer USING (true);
CREATE POLICY guard_definer_select ON runners FOR SELECT TO guard_definer USING (true);
CREATE POLICY guard_definer_revoke ON runners FOR UPDATE TO guard_definer
  USING (revoked_at IS NULL) WITH CHECK (revoked_reason = 'member_demoted');
CREATE POLICY guard_definer_audit ON audit_log FOR INSERT TO guard_definer WITH CHECK (action = 'runner.revoked');
CREATE POLICY guard_definer_select ON model_connections FOR SELECT TO guard_definer USING (true);
CREATE POLICY guard_definer_select ON accounts FOR SELECT TO guard_definer USING (true);
CREATE POLICY guard_definer_mark ON accounts FOR UPDATE TO guard_definer
  USING (onboarding_key_ok_at IS NULL) WITH CHECK (true);

-- ---- brackets open ----------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'guard_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on guard_definer; cannot ALTER FUNCTION ... OWNER TO guard_definer';
    END IF;
    GRANT guard_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO guard_definer;

-- ---- forbid_api_token_unrevoke ----------------------------------------------------------------------------------
ALTER FUNCTION forbid_api_token_unrevoke() OWNER TO CURRENT_USER;

-- ---- runner revoke on member change -----------------------------------------------------------------------------
CREATE FUNCTION runner_revoke_on_member_change_apply(p_account_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_setting text := NULLIF(current_setting('app.user_id', true), '');
  who text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.account_members m
              WHERE m.account_id = p_account_id AND m.user_id = p_user_id AND m.role IN ('owner', 'admin')) THEN
    RETURN;
  END IF;
  who := 'system:membership';
  IF v_setting IS NOT NULL AND (v_setting = p_user_id::text OR EXISTS (
       SELECT 1 FROM public.account_members m WHERE m.account_id = p_account_id AND m.user_id::text = v_setting)) THEN
    who := v_setting;
  END IF;
  WITH revoked AS (
    UPDATE public.runners r
       SET revoked_at = now(), revoked_reason = 'member_demoted'
     WHERE r.account_id = p_account_id AND r.registered_by = p_user_id AND r.revoked_at IS NULL
    RETURNING r.id, r.registered_by
  )
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  SELECT p_account_id, who, 'runner.revoked',
         jsonb_build_object('runner_id', revoked.id, 'reason', 'member_demoted', 'registered_by', revoked.registered_by),
         clock_timestamp()
    FROM revoked;
END;
$$;
REVOKE ALL ON FUNCTION runner_revoke_on_member_change_apply(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION runner_revoke_on_member_change_apply(uuid, uuid) OWNER TO guard_definer;
GRANT EXECUTE ON FUNCTION runner_revoke_on_member_change_apply(uuid, uuid) TO app_user, platform_ops;
DO $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION runner_revoke_on_member_change_apply(uuid, uuid) TO %I',
                 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.account_members'::regclass));
END
$$;

CREATE FUNCTION runner_revoke_on_member_change_trigger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.runner_revoke_on_member_change_apply(OLD.account_id, OLD.user_id);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION runner_revoke_on_member_change_trigger() FROM PUBLIC;

DROP TRIGGER runner_revoke_on_member_demoted ON account_members;
DROP TRIGGER runner_revoke_on_member_removed ON account_members;
CREATE TRIGGER runner_revoke_on_member_demoted
  AFTER UPDATE OF role ON account_members
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION runner_revoke_on_member_change_trigger();
CREATE TRIGGER runner_revoke_on_member_removed
  AFTER DELETE ON account_members
  FOR EACH ROW EXECUTE FUNCTION runner_revoke_on_member_change_trigger();

-- ---- onboarding key-ok mark -------------------------------------------------------------------------------------
CREATE FUNCTION model_connections_onboarding_mark_apply(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.model_connections c WHERE c.account_id = p_account_id AND c.status = 'ok') THEN
    RETURN;
  END IF;
  PERFORM set_config('fx.onboarding_key_ok_mark', p_account_id::text, true);
  UPDATE public.accounts SET onboarding_key_ok_at = now() WHERE id = p_account_id AND onboarding_key_ok_at IS NULL;
  PERFORM set_config('fx.onboarding_key_ok_mark', '', true);
END;
$$;
REVOKE ALL ON FUNCTION model_connections_onboarding_mark_apply(uuid) FROM PUBLIC;
ALTER FUNCTION model_connections_onboarding_mark_apply(uuid) OWNER TO guard_definer;
GRANT EXECUTE ON FUNCTION model_connections_onboarding_mark_apply(uuid) TO app_user, platform_ops;
DO $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION model_connections_onboarding_mark_apply(uuid) TO %I',
                 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.model_connections'::regclass));
END
$$;

CREATE FUNCTION model_connections_onboarding_mark_trigger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.model_connections_onboarding_mark_apply(NEW.account_id);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION model_connections_onboarding_mark_trigger() FROM PUBLIC;

DROP TRIGGER model_connections_onboarding_mark ON model_connections;
CREATE TRIGGER model_connections_onboarding_mark
  AFTER INSERT OR UPDATE ON model_connections
  FOR EACH ROW WHEN (NEW.status = 'ok') EXECUTE FUNCTION model_connections_onboarding_mark_trigger();

-- ---- brackets closed --------------------------------------------------------------------------------------------
REVOKE CREATE ON SCHEMA public FROM guard_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
    REVOKE guard_definer FROM CURRENT_USER;
  END IF;
END
$$;
