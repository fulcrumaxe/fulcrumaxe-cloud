-- D#31 C15(a): close the token-mint TOCTOU raised in the #158 review
-- (https://github.com/fulcrumaxe/cloud/pull/158#issuecomment-5840962211,
-- "Informational, not blocking"). A mint request whose session principal
-- was resolved as owner (or admin) before a concurrent demotion commits
-- still inserted its token afterwards: `insertApiToken` never re-read the
-- creator's role inside its own transaction, and the demotion/removal
-- path's own revocation pass only revokes tokens that already exist at
-- the moment it runs (CWE-367).
--
-- The fix is `insertApiToken` locking the CREATOR's own `account_members`
-- row `FOR SHARE`, inside the SAME transaction as the token INSERT, before
-- re-checking the requested scopes against that row's role. That forces
-- the mint and a concurrent `setMemberRole`/`removeMember` (both of which
-- UPDATE/DELETE that same row) to serialise: whichever gets there first
-- blocks the other until it commits.
--
-- This cannot be a raw `SELECT ... FOR SHARE` from `app_user`, though. Per
-- the row security documentation, Postgres checks a locking clause's rows
-- against the applicable policy for the LOCKING strength's own command
-- (UPDATE, for FOR SHARE/FOR UPDATE), in addition to the SELECT policy --
-- not just the SELECT policy alone. `account_members`' `role_gated_update`
-- policy (0005_account_members_role_gate.sql) only admits an owner, or an
-- admin acting on a non-owner row; a plain 'member' has NO update policy
-- match on any row, including their own. So a raw `FOR SHARE` issued by a
-- 'member' minting their own (very ordinary) 'read'-scope token silently
-- returns ZERO rows -- not a permission error, an empty result -- which is
-- exactly the shape a caller mistakes for "not a member" (confirmed
-- directly: packages/core/test/token-revocation.test.ts's own
-- criterion-2 fixtures, which mint as a plain member, only pass with the
-- function below in place of a raw locking SELECT).
--
-- Fixed the same way every other app_user operation that needs to see
-- past a role-gated policy already does in this schema
-- (current_member_role, current_member_user_id, has_open_invitation,
-- resolve_api_token, audit_write_api_tokens, touch_api_token_last_used):
-- a SECURITY DEFINER function owned by platform_ops, whose OWN
-- account_members policy is unconditional
-- (`platform_ops_full_access ... USING (true) WITH CHECK (true)`), so the
-- lock always succeeds regardless of the CALLING member's role.
--
-- No arguments, reading `app.account_id`/`app.user_id` itself -- same
-- shape as `current_member_role()` -- so this can never be used as a
-- cross-account oracle (0005's own stated design rule for every function
-- in this family): it only ever locks and reports the CALLING session's
-- own row, never an arbitrary account/user pair a caller might name.
CREATE FUNCTION lock_own_member_role_for_mint()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT role FROM account_members
  WHERE account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  FOR SHARE;
$$;
REVOKE ALL ON FUNCTION lock_own_member_role_for_mint() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_own_member_role_for_mint() TO app_user;

-- D#81/#92 per-file bracket (docs/ops/hosted-postgres.md, as 0616's own
-- section documents): the `ALTER FUNCTION ... OWNER TO platform_ops`
-- below needs platform_ops to hold CREATE on schema public at that
-- moment, not guaranteed on an already-migrated database. Unconditional
-- grant/revoke, bracketing this one new function.
GRANT CREATE ON SCHEMA public TO platform_ops;
ALTER FUNCTION lock_own_member_role_for_mint() OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;
