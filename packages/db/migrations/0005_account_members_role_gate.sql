-- D#2605 H06 security fix: account_members RLS never checked the CALLER's
-- role, only account_id. Found live on main by the #54 security review
-- (github.com/fulcrumaxe/cloud/pull/54#issuecomment-5730714389, finding 3).
--
-- migrations/0001_core.sql:636-638 assumed "viewing, re-role-ing or
-- removing a membership row your account already owns was never the
-- exploit, so it isn't restyled here". That assumption is WRONG as soon as
-- members, not only owners, hold app_user sessions -- which they always
-- have, since account_members IS the table that says who's a member. The
-- "left as they are" notes at 0001_core.sql:672-675 (account_members'
-- UPDATE/DELETE grant) and :706-710 (invitations' UPDATE/DELETE grant) are
-- corrected here too, by reference -- neither of those files is edited by
-- this migration (schema_migrations has no content checksum, so an
-- already-applied file is never re-diffed; see 0004's own header for why
-- editing an applied migration in place is unsafe).
--
-- Findings fixed (numbered as in the Discussion's security analysis):
--
--   1. account_members' tenant_isolation_update/tenant_isolation_delete
--      checked only account_id + account_is_active. Any app_user session
--      inside an account -- member, admin, or owner -- could re-role or
--      delete ANY row in that account, including the owner's, and thereby
--      pass every owner/admin check anything else in this schema builds on
--      account_members for.
--   2. The UPDATE grant was table-wide, so the same session could also run
--      `UPDATE account_members SET user_id = <any real user>` -- an
--      identity swap that bypasses invited_only_insert's invitation gate
--      entirely (that policy only ever runs on INSERT). Fix: app_user's
--      UPDATE grant on account_members is narrowed to the `role` column
--      only, below.
--   3. invitations had one plain `tenant_isolation` policy for every
--      command and full CRUD for app_user, with no role check. A member
--      could `INSERT INTO invitations (..., role => 'owner')` for a second
--      identity it controls (or for itself after leaving) and mint an
--      owner through has_open_invitation() -- a two-statement bypass of
--      any account_members-only fix. Also closed here: app_user could
--      replay a consumed invitation (UPDATE accepted_at back to NULL),
--      rewrite role/email/invited_by on an open invitation, or extend
--      expires_at indefinitely (0001_core.sql:167-172 called this
--      self-service; it's now re-issue instead -- see the invitations
--      section below).
--   4. has_open_invitation() admitted an owner invitation even after its
--      inviter stopped being an owner. acceptInvitation() (H06,
--      packages/core/src/auth/invitations.ts) already rechecks this at
--      accept time, but a raw INSERT went around the application entirely.
--      One added conjunct below closes it at the DB layer too.
--   5. RLS alone can't express "the caller's role" without recursion: a
--      policy on account_members that does `EXISTS (SELECT ... FROM
--      account_members ...)` gets expanded by the rewriter and raises
--      "infinite recursion detected in policy for relation
--      \"account_members\"". The role lookup has to go through a
--      SECURITY DEFINER function instead (never inlined/expanded by the
--      rewriter), the same idiom has_open_invitation() already uses. "At
--      least one owner remains" is a cross-row invariant no single-row
--      USING/WITH CHECK expression can state at all, so it needs a
--      trigger, and the trigger needs a lock -- two concurrent owner
--      removals must not both observe "another owner remains" from a
--      stale snapshot (the same CWE-362 class membership.ts's
--      lockOwnerRows already guards against for the application path;
--      this closes the raw-SQL path lockOwnerRows never could).
--   6. Trust boundary, stated honestly: this gate trusts app.user_id
--      exactly as far as every policy already trusts app.account_id --
--      both are set by withTenant from the authenticated session. It
--      protects any app_user statement path running under a correctly-set
--      session (a future route, a service bug, a raw query in a service).
--      It does NOT protect an attacker who can run arbitrary SQL,
--      including set_config -- that attacker can already choose any
--      account. Same residual-trust note as attestations in
--      0100_sitekit.sql:301-308.
--
-- PR #75 review fix round (D#64): two MUST-fix findings against the
-- trigger below, both addressed in place (this migration had not merged
-- yet, so it is edited rather than superseded):
--
--   MUST 1 (CWE-362): the owner count under REPEATABLE READ/SERIALIZABLE
--      reused a stale snapshot even after waiting on the advisory lock,
--      letting two concurrent owner removals both commit and leave an
--      account with zero owners. Fixed by row-locking the counted rows
--      (`FOR UPDATE`) -- see the trigger's own comment below for the
--      full mechanism and why READ COMMITTED's behaviour is unchanged.
--   MUST 2: the platform_ops/superuser exemption alone is wrong on a
--      non-superuser migration/table-owner host (this product's hosted
--      deployment runs on Neon) -- fixed by also exempting current_user
--      when it is the literal owner of this table; see the trigger's own
--      comment below.
--
-- Two SUGGESTIONS from the same review, deliberately NOT changed here,
-- recorded as known and decided:
--
--   - Advisory-lock DoS (CWE-400): `pg_advisory_xact_lock` is executable
--     by PUBLIC, and the lock key below is `hashtext(account_id::text)`
--     -- any app_user session that knows another tenant's account id can
--     open a transaction, take that lock, and hold it to stall that
--     tenant's owner removals/demotions for as long as the transaction
--     stays open. This needs a real account id (not a blind guess) and
--     only delays a specific write path; it does not read, corrupt, or
--     destroy data. Accepted as-is for this migration -- a keyed,
--     unguessable lock derivation (e.g. hashing the account id together
--     with a per-deployment secret) is a reasonable follow-up if this
--     ever needs closing, but changes the lock key's shape for every
--     caller and isn't a two-line fix.
--   - Stale admin invitations: has_open_invitation()'s owner-recheck
--     (finding 4 above) deliberately does not extend to admin
--     invitations -- an admin invitation issued by A1, with A1 later
--     demoted or removed, still admits the invitee as admin. This
--     matches acceptInvitation()'s own scope (H06) and is a real,
--     decided gap, not an oversight: closing it needs its own Spec (does
--     an admin invitation recheck the INVITER's current role, and if so
--     at issue time, accept time, or both -- and what happens to already
--     -open invitations from a since-removed admin). A follow-up
--     Discussion is being filed for it; owners and admins can already
--     delete a pending invitation manually in the meantime.
--
-- Every helper below independently re-derives the caller's role from
-- account_members via app.account_id/app.user_id -- it never trusts
-- app.user_id on its own, satisfying the X-user-id amendment
-- (test/partners-isolation.test.ts's "every policy that reads app.user_id
-- also joins account_members" check: these policies read the HELPER
-- FUNCTION's result, never app.user_id directly, so that check doesn't
-- even see the setting name in the policy text -- the join happens inside
-- the function body instead).

-- ---------------------------------------------------------------------
-- 1. Caller-identity helpers.
--
-- SECURITY DEFINER, SET search_path = public, pg_temp, owned by
-- platform_ops -- same pattern as has_open_invitation() (0001_core.sql):
-- platform_ops already has an unconditional account_members policy and
-- (via 0004) the table grant, so the lookup inside each function runs
-- with platform_ops's own visibility, never app_user's -- which is also
-- what keeps a call from these functions from recursing back into the
-- role-gated app_user policies being built on top of them.
--
-- Each takes NO argument and reads app.account_id/app.user_id itself, so
-- none of them can be used as a cross-account oracle (the round-6 lesson
-- on has_open_invitation, which used to take target_account_id as a bare
-- parameter). EXECUTE is revoked from PUBLIC and granted only to
-- app_user. Every call site below wraps them as `(SELECT
-- current_member_role())` etc: an uncorrelated scalar subquery with no
-- argument that varies per row, so the planner evaluates it once per
-- query in an InitPlan rather than once per row -- the same house
-- convention as account_is_active()'s own performance note in
-- 0001_core.sql, and asserted directly for this migration in
-- test/account-members-role-gate.test.ts's EXPLAIN case (criterion 17).
-- D#81 fix round (security review, per-file bracket rule --
-- docs/ops/hosted-postgres.md): the three `ALTER FUNCTION ... OWNER TO
-- platform_ops` statements below need platform_ops to hold CREATE on
-- schema public at the moment each one runs. That's no longer guaranteed
-- by 0001_core.sql's original grant alone -- on an already-migrated
-- database, filename order is not applied order, and this file (0005)
-- could be delivered after a later-numbered file (e.g. 0200_partners.sql)
-- has already revoked it. Self-bracketed the same way every other later
-- migration must be: grant here, transfer below, revoke once done.
-- Unconditional, matching 0001_core.sql's own original grant style (line
-- 485) -- the migration role can always GRANT/REVOKE this regardless of
-- superuser status.
GRANT CREATE ON SCHEMA public TO platform_ops;

CREATE FUNCTION current_member_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT role FROM account_members
  WHERE account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;
REVOKE ALL ON FUNCTION current_member_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_member_role() TO app_user;
ALTER FUNCTION current_member_role() OWNER TO platform_ops;

-- app.user_id if (and only if) that user actually has a membership row in
-- app.account_id, else NULL -- the "own row" clauses below use this
-- rather than comparing a column straight to the raw app.user_id GUC, so
-- a session whose app.user_id names a real person who ISN'T a member of
-- the current account (criterion 4c's mismatched-settings probe) can't
-- match anything as "itself".
CREATE FUNCTION current_member_user_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT user_id FROM account_members
  WHERE account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;
REVOKE ALL ON FUNCTION current_member_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_member_user_id() TO app_user;
ALTER FUNCTION current_member_user_id() OWNER TO platform_ops;

-- The caller's own users.email (lower-cased), only if the caller is a
-- member of app.account_id, else NULL. Used so "an invitee may consume
-- its OWN invitation" (criterion 9a) can be expressed without granting
-- app_user any broader visibility into users than member_visible
-- (0001_core.sql) already does -- this runs as platform_ops internally,
-- same reasoning as has_open_invitation's users join.
CREATE FUNCTION current_member_email()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT lower(u.email)
  FROM account_members m
  JOIN users u ON u.id = m.user_id
  WHERE m.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;
REVOKE ALL ON FUNCTION current_member_email() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_member_email() TO app_user;
ALTER FUNCTION current_member_email() OWNER TO platform_ops;

-- D#81 fix round: close the window this file opened above. Matches
-- 0200_partners.sql's own revoke, placed right after ITS last OWNER TO
-- statement -- see that file's comment for the full reasoning.
REVOKE CREATE ON SCHEMA public FROM platform_ops;

-- ---------------------------------------------------------------------
-- 2. account_members: role-gated UPDATE/DELETE, column-only UPDATE grant,
--    and the last-owner trigger.
--
-- tenant_isolation_select and invited_only_insert are UNCHANGED: viewing
-- your own account's members, and the invitation-gated INSERT, were never
-- the exploit (see analysis item 1 above) -- only UPDATE and DELETE
-- needed a role check.
DROP POLICY tenant_isolation_update ON account_members;
DROP POLICY tenant_isolation_delete ON account_members;

-- UPDATE: both USING (the OLD row) and WITH CHECK (the NEW row) require
-- the same rule -- owner may touch any row and set any role; admin may
-- touch/produce any row EXCEPT an owner row (on either side of the
-- change). `role` in each expression below refers to that policy's own
-- row image (OLD for USING, NEW for WITH CHECK), which is exactly what
-- makes "may not touch an owner row" and "may not produce an owner row"
-- two different, independently-required halves of the same clause.
CREATE POLICY role_gated_update ON account_members
  FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (
      (SELECT current_member_role()) = 'owner'
      OR ((SELECT current_member_role()) = 'admin' AND role <> 'owner')
    )
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (
      (SELECT current_member_role()) = 'owner'
      OR ((SELECT current_member_role()) = 'admin' AND role <> 'owner')
    )
  );

-- DELETE: the same owner/admin clause, OR the row is the caller's own
-- (any member may leave). current_member_user_id() is used rather than a
-- raw app.user_id comparison so a session with no verified membership
-- can't match "itself" against someone else's row.
CREATE POLICY role_gated_delete ON account_members
  FOR DELETE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (
      (SELECT current_member_role()) = 'owner'
      OR ((SELECT current_member_role()) = 'admin' AND role <> 'owner')
      OR user_id = (SELECT current_member_user_id())
    )
  );

-- Security fix finding 2: the UPDATE grant used to be table-wide, which
-- let a session run `UPDATE account_members SET user_id = <any real
-- user>` -- an identity swap that routes around invited_only_insert
-- entirely (that policy only gates INSERT). app_user now gets UPDATE on
-- `role` only; every other column (id, account_id, user_id, created_at)
-- raises 42501 on any attempted write, checked directly in
-- test/account-members-role-gate.test.ts's column-privilege case
-- (criterion 5).
REVOKE UPDATE ON account_members FROM app_user;
GRANT UPDATE (role) ON account_members TO app_user;

-- The last-owner invariant is cross-row (it's a property of the WHOLE
-- account_members set for one account_id, not of any single row), so no
-- USING/WITH CHECK expression above can state it -- it needs a trigger.
--
-- Deliberately INVOKER rights (no SECURITY DEFINER): the "is the caller
-- exempt" check below needs current_user to be the ACTUAL executing role,
-- not the function owner. platform_ops, the migration/table owner, and
-- superuser are exempt -- they're exactly the lifecycle paths this
-- migration must not break (creating the founding owner, admin support
-- actions, and the `users` ON DELETE CASCADE into account_members).
-- Postgres runs a foreign key's referential action (including ON DELETE
-- CASCADE) as the owner of the referencing table, never as whichever
-- role happened to issue the top-level DELETE -- so this cascade always
-- runs as account_members' table owner, which the check below already
-- exempts (criterion 7). Granting any role DELETE on `users` or
-- `accounts` therefore lets that role remove a sole owner through the
-- cascade, bypassing this trigger entirely. Do not grant it.
-- `pg_has_role(current_user, 'platform_ops', 'USAGE')` is the same
-- deny-by-default guard 0003_spend_security_fixes.sql's
-- model_connections_guard_write uses: a real Postgres superuser satisfies
-- pg_has_role() for any role unconditionally, and platform_ops itself,
-- connected directly, also satisfies pg_has_role() for its own role.
--
-- PR #75 review fix round, MUST 2: that first check alone assumes the
-- migration-running connection is EITHER a real superuser OR platform_ops
-- itself. On managed Postgres (this product's hosted deployment runs on
-- Neon) the migration/table-owning role is neither: it is typically a
-- role with BYPASSRLS and CREATEROLE granted (so it can create app_user /
-- platform_ops and read/write every RLS-protected table) but rolsuper =
-- false, and it was never made a MEMBER of platform_ops -- a CREATEROLE
-- role that CREATEs another role only ever gets pg_has_role(...,
-- 'MEMBER') on it, never 'USAGE' (confirmed directly against PG 18).
-- Without a second check, that role's OWN `users` ON DELETE CASCADE into
-- a sole owner's account_members row would hit "last owner" -- an
-- availability bug on the exact lifecycle path this trigger exists to
-- protect (criterion 7), on exactly the hosting shape this product
-- actually runs on. The added disjunct exempts current_user when it is
-- literally the OWNER of this table (`pg_class.relowner`, resolved via
-- `pg_get_userbyid` -- not a name comparison, so it tracks a renamed
-- owner role too): app_user can never satisfy this, because app_user
-- never owns any object in this schema (0001_core.sql: "it owns nothing
-- and never bypasses RLS", and nothing in this migration or any other
-- changes that). Schema-qualified `'public.account_members'::regclass`
-- for the same "don't trust the caller's search_path" reason
-- account_is_active() documents in 0001_core.sql -- and, as of
-- migrations/0008_audit_log_append_only.sql, this function's own
-- search_path is pinned too, so this lookup no longer depends on the
-- caller's search_path at all, belt-and-suspenders with the explicit
-- schema-qualification above.
--
-- MUST 1 (PR #75 review, CWE-362): the count below now takes a row lock
-- on the other owner rows via `FOR UPDATE` in addition to the advisory
-- lock, so this holds under REPEATABLE READ and SERIALIZABLE too, not
-- only READ COMMITTED (see full analysis just above the query).
--
-- Namespaced two-key advisory lock: the first key pins this to "this
-- trigger's own lock space" (an arbitrary, fixed hash so it can never
-- collide with an unrelated advisory lock taken elsewhere in this
-- schema), the second is the account being changed. It is released only
-- at COMMIT/ROLLBACK (pg_advisory_xact_lock, not pg_advisory_lock), so a
-- transaction that passes this check still holds the lock until it
-- finishes -- which is exactly what makes the blocking in criterion 6
-- deterministic rather than a race, and what forces two concurrent
-- owner-removing statements on the SAME account to serialize regardless
-- of which specific rows they touch (covering the cross-demote case,
-- criterion 6b, that a same-row lock alone never would: two demotes of
-- two DIFFERENT owner rows take no row lock in common until the count
-- query below runs).
--
-- The advisory lock alone is NOT enough, though: this function is plain
-- plpgsql (VOLATILE by default), and under READ COMMITTED each statement
-- gets a fresh snapshot, but under REPEATABLE READ / SERIALIZABLE the
-- WHOLE TRANSACTION shares one snapshot taken at its first statement --
-- see https://www.postgresql.org/docs/current/trigger-datachanges.html.
-- A second transaction that started before the first committed, and that
-- runs under one of those two isolation levels, would still see the
-- FIRST transaction's soon-to-be-removed owner as present in a plain
-- `SELECT count(*)`, wait on the advisory lock, then proceed to commit
-- ITS OWN owner removal against that stale count once unblocked --
-- reproduced by the PR #75 review with two real app_user connections:
-- both owners' rows gone, zero owners left, unrecoverable by any
-- app_user. `FOR UPDATE` on the counted rows closes this: Postgres
-- itself raises `40001 could not serialize access due to concurrent
-- update` (or `delete`) when a REPEATABLE READ / SERIALIZABLE
-- transaction's `FOR UPDATE` target was changed by another transaction
-- that committed after this one's snapshot was taken -- the count query
-- below never even gets to run with stale data at those isolation
-- levels; the second transaction fails closed instead. Under READ
-- COMMITTED, `FOR UPDATE` simply waits for the row lock as before, then
-- re-reads the now-committed row -- so the plain `23514 last owner`
-- behaviour there is unchanged.
--
-- This is also what still makes the bulk-statement case (criterion 3)
-- work correctly with no cross-statement lock needed: Postgres fires
-- this BEFORE ROW trigger once per row of a multi-row UPDATE/DELETE,
-- applying each row's change before moving to the next, so by the time
-- the SECOND owner row of a same-statement bulk change reaches this
-- trigger, the count below already reflects the FIRST row's change --
-- exactly the same-command visibility the Implementation Notes call out,
-- and `FOR UPDATE` on rows this same (uncommitted) transaction already
-- modified is always immediate, never a wait.
--
-- The trigger's own locking clause below is a plain FOR UPDATE -- a row
-- lock on the OTHER owner rows being counted, not restricted to a
-- single column the way an earlier version of this comment claimed: a
-- locking clause's OF list names TABLES, not columns (that's the SET
-- list's job, in an UPDATE statement, not a locking clause). FOR UPDATE
-- also requires the UPDATE privilege (not just SELECT) on
-- account_members, so a role holding DELETE but not UPDATE on this
-- table -- there is no such role today -- fails closed with 42501 from
-- inside this trigger rather than silently skipping the lock.
CREATE FUNCTION account_members_keep_an_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  other_owners integer;
BEGIN
  IF pg_has_role(current_user, 'platform_ops', 'USAGE')
     OR current_user = (
       SELECT pg_get_userbyid(relowner)
       FROM pg_class
       WHERE oid = 'public.account_members'::regclass
     )
  THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Only an actual departure from 'owner' is interesting: a DELETE of a
  -- non-owner row, or an UPDATE that leaves role at 'owner' or never was
  -- 'owner' to begin with, can't reduce the owner count.
  IF OLD.role <> 'owner' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('account_members_keep_an_owner'), hashtext(OLD.account_id::text));

  SELECT count(*) INTO other_owners
  FROM (
    SELECT 1
    FROM account_members
    WHERE account_id = OLD.account_id
      AND role = 'owner'
      AND id <> OLD.id
    FOR UPDATE
  ) s;

  IF other_owners = 0 THEN
    RAISE EXCEPTION 'last owner: account % must keep at least one owner', OLD.account_id
      USING ERRCODE = '23514';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER account_members_keep_an_owner
  BEFORE UPDATE OF role OR DELETE ON account_members
  FOR EACH ROW
  EXECUTE FUNCTION account_members_keep_an_owner();

-- ---------------------------------------------------------------------
-- 3. invitations: per-command role-gated policies, replacing the single
--    all-commands `tenant_isolation`. platform_ops_read_access is
--    unchanged.
DROP POLICY tenant_isolation ON invitations;

CREATE POLICY tenant_isolation_select ON invitations
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

-- Security fix finding 3: issuing an invitation now requires the actor to
-- actually be owner|admin (never member) at the database level, and to
-- name ITSELF as invited_by (via current_member_user_id(), never a bare
-- app.user_id comparison -- criterion 8's "invited_by = NULL" and
-- "invited_by = a different real member" probes both need to fail, not
-- just an unauthenticated one). Owner-role invitations additionally
-- require the actor to already be owner -- the same escalation class
-- membership.ts's setMemberRole and createInvitation's requireOwner
-- already close at the application layer (second security review,
-- finding 10), now also true with no application code in the loop.
CREATE POLICY role_gated_insert ON invitations
  FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND invited_by = (SELECT current_member_user_id())
    AND (
      (SELECT current_member_role()) = 'owner'
      OR ((SELECT current_member_role()) = 'admin' AND role <> 'owner')
    )
  );

-- UPDATE: only ever used to consume an invitation (accepted_at), per the
-- column grant below. USING requires the invitation to still be open
-- (accepted_at IS NULL) -- this alone closes the replay probe (criterion
-- 9d: setting accepted_at back to NULL on an ALREADY-accepted row can
-- never match USING in the first place, since OLD.accepted_at is not
-- null). The actor must be owner|admin (managing invitations is an
-- ordinary owner/admin action), OR the invitation is addressed to the
-- actor's OWN email (an invitee accepting its own invite, criterion 9a --
-- this is the raw form of acceptInvitation, run as the invitee, who by
-- this point in the same transaction already has a membership row from
-- the preceding INSERT, so current_member_email() resolves). WITH CHECK
-- requires the row to end up accepted -- this UPDATE can only ever
-- consume an invitation, never un-consume one.
CREATE POLICY role_gated_update ON invitations
  FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND accepted_at IS NULL
    AND (
      (SELECT current_member_role()) IN ('owner', 'admin')
      OR lower(email) = (SELECT current_member_email())
    )
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND accepted_at IS NOT NULL
  );

CREATE POLICY role_gated_delete ON invitations
  FOR DELETE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (SELECT current_member_role()) IN ('owner', 'admin')
  );

-- Security fix finding 3 (continued): the UPDATE grant used to be
-- table-wide, which let a tenant replay a consumed invitation (accepted_at
-- back to NULL), rewrite role/email/invited_by on an open invitation, or
-- push expires_at forward indefinitely (0001_core.sql:167-172 called that
-- last one self-service; it no longer is -- re-issuing the invitation is
-- the path now). app_user's UPDATE grant is narrowed to `accepted_at`
-- only; every other column -- including role, email, expires_at and
-- invited_by -- raises 42501 regardless of RLS (criterion 9e).
REVOKE UPDATE ON invitations FROM app_user;
GRANT UPDATE (accepted_at) ON invitations TO app_user;

-- ---------------------------------------------------------------------
-- 4. has_open_invitation(): identical signature, SECURITY DEFINER,
--    search_path and owner (CREATE OR REPLACE preserves the owner and
--    every existing GRANT automatically) -- one added conjunct.
--
-- Security fix finding 4: an owner invitation used to stay honored even
-- after its inviter stopped being an owner. acceptInvitation() (H06)
-- already rechecks this at accept time (second security review, finding
-- 10), but that's an application-layer check a raw INSERT bypasses
-- entirely -- the whole point of this function being the DB's OWN gate.
-- The added conjunct only fires for role = 'owner' invitations (criterion
-- 10c: a member invitation from a since-demoted admin still works, since
-- only owner invitations are rechecked -- that's the decided scope, not
-- an oversight).
--
-- D#81 fix round 3 (code re-review NEEDS-FIX): CREATE OR REPLACE on this
-- EXISTING function needs the executing role to hold has_privs_of_role
-- (platform_ops) -- INHERIT, not just SET -- exactly like 0011's own
-- REPLACE of audit_write (see that file's comment for the full
-- reasoning). This file's own per-file bracket above only covers CREATE
-- on schema public for the three fresh CREATE FUNCTION statements; it
-- does not grant INHERIT, so on a database that already has
-- 0200_partners.sql applied (INHERIT FALSE by then) and receives 0005
-- LATE -- filename order is not applied order, per this file's own header
-- above -- the REPLACE below used to fail with "must be owner of function
-- has_open_invitation" (42501). Bracketed per docs/ops/hosted-postgres.md's
-- per-file rule -- INHERIT only; this never touches CREATE, since it's a
-- REPLACE, not an OWNER TO.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION has_open_invitation(target_account_id uuid, target_user_id uuid, target_role text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM invitations i
    JOIN users u ON lower(u.email) = lower(i.email)
    WHERE u.id = target_user_id
      AND i.account_id = target_account_id
      AND i.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
      AND i.role = target_role
      AND i.accepted_at IS NULL
      AND i.expires_at > now()
      AND (
        i.role <> 'owner'
        OR EXISTS (
          SELECT 1 FROM account_members m
          WHERE m.account_id = i.account_id
            AND m.user_id = i.invited_by
            AND m.role = 'owner'
        )
      )
  );
$$;
-- Re-asserted anyway (belt-and-suspenders, matching CREATE OR REPLACE's
-- documented preservation of the owner and existing grants).
REVOKE ALL ON FUNCTION has_open_invitation(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION has_open_invitation(uuid, uuid, text) TO app_user;

-- D#81 fix round 3: downgrade back to INHERIT FALSE now that the REPLACE
-- above is done -- matches 0011's own downgrade shape. SET stays TRUE
-- (still needed elsewhere in the chain / by later migrations with the
-- same bracket).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
