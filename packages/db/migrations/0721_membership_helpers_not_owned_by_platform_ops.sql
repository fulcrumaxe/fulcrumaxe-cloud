-- D#2 hardening (security review of #522/#523, CWE-693/284): the helpers that answer "who is the caller, and in what role"
-- must not be owned by the platform_ops login.
--
-- The owner of a function can change its attributes. 0005 made platform_ops the owner of current_member_role(),
-- current_member_user_id() and current_member_email(), all three declared STABLE and SECURITY DEFINER. A direct
-- platform_ops login could therefore ALTER FUNCTION ... IMMUTABLE on one of them. An IMMUTABLE call whose arguments are
-- constants is folded when the statement is planned, and a plan cached on a pooled connection is reused by the next
-- caller, so a later caller could be handed an earlier caller's answer. Every owner/admin check built on the helper
-- (RLS policies on account_members and invitations, and the definers that call current_member_role()) weakens with it.
-- The same owner could also rename, replace or re-point the helper (SET search_path, SECURITY INVOKER) or drop it.
--
-- This migration moves every membership/role helper, and the other authorization helpers of the same shape, to the
-- NOLOGIN role guard_definer that 0720 created (nothing can log in as it, become it, or alter it):
--   current_member_role(), current_member_user_id(), current_member_email()   (0005)  membership of the session's account
--   has_open_invitation(uuid, uuid, text)                                      (0001/0005) invitation gate on account_members
--   partner_account_visible(uuid), has_active_support_grant(uuid),
--   support_grant_matches(uuid, uuid)                                          (0200)  the partner-side equivalents
-- Bodies, SECURITY DEFINER mode, search_path, volatility and the existing EXECUTE grants are unchanged; only the owner
-- changes. guard_definer is given exactly the column SELECTs these bodies read, each on a forced-RLS table with a
-- SELECT policy for that role alone, in the same style as 0720.
--
-- Grant order. Changing a function's owner rewrites every ACL entry that names the old owner, so the owner's implicit
-- EXECUTE moves to guard_definer and platform_ops (which still calls the helpers from its own definers) would lose it.
-- EXECUTE is therefore granted to platform_ops AFTER the owner change, never before.
--
-- Safe on a database that already has these functions: the owner change is catalog-only and idempotent, and the new
-- grants and policies are additive. Privilege brackets as in 0720: on a Neon-shaped database the migration role holds
-- platform_ops and guard_definer only inside this file, as INHERIT TRUE, and both are removed or reset afterwards.

GRANT SELECT (id, email) ON users TO guard_definer;
GRANT SELECT (account_id, email, role, accepted_at, expires_at, invited_by) ON invitations TO guard_definer;
GRANT SELECT (partner_id, deleted_at) ON accounts TO guard_definer;
GRANT SELECT (id, account_id, grantee_kind, grantee_partner_id, revoked_at, expires_at) ON support_grants TO guard_definer;

CREATE POLICY guard_definer_select ON users FOR SELECT TO guard_definer USING (true);
CREATE POLICY guard_definer_select ON invitations FOR SELECT TO guard_definer USING (true);
CREATE POLICY guard_definer_select ON support_grants FOR SELECT TO guard_definer USING (true);

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

-- ---- owner change, then EXECUTE for the previous owner -----------------------------------------------------------
-- The three 0005 helpers are changed only where they exist: test/migrate-0005-upgrade.test.ts applies every file except 0005
-- on purpose, and the real chain always has 0005 first (test/authorization-helper-ownership.pg.test.ts proves they are moved).
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['current_member_role()', 'current_member_user_id()', 'current_member_email()'] LOOP
    IF to_regprocedure('public.' || f) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION public.%s OWNER TO guard_definer', f);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO platform_ops', f);
    END IF;
  END LOOP;
END
$$;
ALTER FUNCTION has_open_invitation(uuid, uuid, text) OWNER TO guard_definer;
ALTER FUNCTION partner_account_visible(uuid) OWNER TO guard_definer;
ALTER FUNCTION has_active_support_grant(uuid) OWNER TO guard_definer;
ALTER FUNCTION support_grant_matches(uuid, uuid) OWNER TO guard_definer;

GRANT EXECUTE ON FUNCTION has_open_invitation(uuid, uuid, text) TO platform_ops;
GRANT EXECUTE ON FUNCTION partner_account_visible(uuid) TO platform_ops;
GRANT EXECUTE ON FUNCTION has_active_support_grant(uuid) TO platform_ops;
GRANT EXECUTE ON FUNCTION support_grant_matches(uuid, uuid) TO platform_ops;

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
