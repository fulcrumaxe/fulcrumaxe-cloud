-- D#37 WS-C2 fix round item 1 (E1, CWE-613, correction C15a): per-session
-- server-side revocation. 0604_session_epoch.sql's `users.session_epoch`
-- already lets "sign out everywhere" invalidate every session of a user
-- at once; this table adds the missing single-session case -- an
-- ordinary (non-"everywhere") sign-out must revoke the ONE session that
-- signed out, not force every other session of the same user to
-- re-authenticate too.
--
-- Keyed on the session id (`sid`, packages/core/src/auth/session.ts's
-- `crypto.randomUUID()`, minted fresh at every sign-in and embedded in
-- the signed session JWT) -- never on a user id, since the whole point
-- is per-SESSION, not per-USER, revocation. No foreign key to any table
-- that stores session ids, because none exists: a session's only
-- durable record is this table, written exactly once, at sign-out, for
-- exactly the session that signed out.
--
-- Migration numbering (D#94 R1, merge-monotonic; re-checked against
-- main and every open PR at both build time and rebase, per this fix
-- round's own instruction): main's newest migration was
-- 0606_derived_account_status.sql (#93, merged) at this fix round's own
-- rebase. This file's number went through two corrections before
-- landing on 0609:
--
--   1. The fix round's own spec said "D#103's PR is taking 0608, so
--      0607 should stay free" -- checked directly against D#103's own
--      acceptance_files list at the time (fulcrumaxe/cloud discussion
--      #103, then SPEC_READY), and that was backwards: D#103's spec
--      reserved packages/db/migrations/0607_work_items_provenance_
--      vocabulary.sql, not 0608, with no PR open yet.
--   2. This file was accordingly built as 0608_revoked_sessions.sql --
--      but PR #116 (D#103's real executor run) landed on
--      0608_work_items_provenance_vocabulary.sql instead of 0607 (its
--      own rebase-time renumbering, same D#94 R1 mechanism), passed
--      both reviews, and was merging to main while this fix round was
--      in flight. The Team Lead caught the resulting collision and
--      ruled: rename to 0609, rebase onto main after #116 lands, and
--      re-check `git ls-tree origin/main packages/db/migrations/`
--      immediately before pushing -- exactly the R1 discipline this
--      file's own comment already described in principle.
--
-- Re-checked against `git ls-tree origin/main packages/db/migrations/`
-- immediately before this fix round's PR was pushed: 0608 is on main
-- (from #116) and 0609 is free. This file takes 0609.
-- Fix round 1 on correction C15a: this table's shape was originally built
-- without an `expires_at` column and without a `platform_ops` DELETE grant
-- (the "append-only" design below described that on purpose). Both the
-- security review and the code review on PR #119 caught that as a
-- departure from C15a's own text, not a discretionary simplification: "a
-- new table ... Columns: sid uuid PRIMARY KEY ... revoked_at timestamptz
-- NOT NULL DEFAULT now(), and expires_at timestamptz NOT NULL ... Grants:
-- platform_ops gets SELECT, INSERT, DELETE." This edit restores exactly
-- that -- see identity.ts's `revokeSession` for how `expires_at` is
-- computed and used.
CREATE TABLE revoked_sessions (
  session_id  uuid PRIMARY KEY,
  -- Deliberately a plain (non-composite) FK, same as account_members'
  -- user_id column (0001_core.sql) -- users is global, not tenant-scoped.
  -- ON DELETE CASCADE: a deleted user's revocation records are no
  -- longer meaningful to anything (resolveActiveSession always fails
  -- closed for a vanished user id first, via getUserProfile/
  -- getSessionEpochAndRevocation's own users join, before this table
  -- would even be consulted).
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  revoked_at  timestamptz NOT NULL DEFAULT now(),
  -- C15a: "the session's absolute deadline, meaning sessionStart plus the
  -- absolute limit. After that time the token is dead anyway, so the row
  -- can go." A revoked token can never authenticate again once its own
  -- absolute-limit deadline passes (session.ts's verifySession rejects it
  -- on time alone), so keeping its row past that point buys nothing and
  -- is exactly the unbounded-growth shape E1 (CWE-770/400) flagged: every
  -- sign-out inserts a row and nothing ever ages it out. identity.ts's
  -- revokeSession sets this to the revoked session's own
  -- `sessionStart + absoluteLimitSeconds()`, never a fixed TTL from
  -- revocation time, so a session revoked near the start of its life
  -- still keeps its row until ITS deadline, not a shorter one.
  expires_at  timestamptz NOT NULL
);

-- Every resolveActiveSession call (lib/shell/session-guard.ts, every
-- Node-runtime handler that honours the session cookie) looks this up
-- BY user_id in the common case's WHERE clause is on users.id, with
-- revoked_sessions joined by session_id via an EXISTS subquery -- see
-- identity.ts's getSessionEpochAndRevocation. The primary key on
-- session_id already covers that lookup; this second index makes the
-- ON DELETE CASCADE's own lookup (and any future per-user revocation
-- listing) equally cheap without a sequential scan.
CREATE INDEX idx_revoked_sessions_user_id ON revoked_sessions (user_id);

-- Same shape as `users` (0001_core.sql): a global, non-tenant-scoped
-- table with no account_id at all, so there is nothing for a
-- tenant_isolation-style policy to gate on. RLS is enabled and forced
-- anyway (belt-and-suspenders, matching every other table in this
-- schema) with a single unconditional platform_ops policy -- app_user
-- gets NO grant on this table at all, not even SELECT: revocation is
-- entirely a server-side (platform_ops-only) concern, and no
-- app_user-authenticated request path (packages/api, the account-scoped
-- REST surface) has any legitimate reason to read or write it. The
-- app_user (and platform_ops) privileges test now lives in
-- packages/db/test/revoked-sessions-privileges.test.ts (fix round 1,
-- correction C15a's acceptance_files -- moved out of
-- packages/core/test/pg/identity.test.ts, which keeps only the
-- functional revoke/read-back behaviour), the same split every other
-- grants-matrix table in this schema uses (e.g.
-- packages/db/test/ledger-audit-log-privileges.test.ts).
ALTER TABLE revoked_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_ops_full_access ON revoked_sessions TO platform_ops
  USING (true) WITH CHECK (true);
-- Fix round 1 (E1, CWE-770/400, correction C15a): platform_ops gets
-- DELETE too, not just SELECT/INSERT -- the table was originally
-- "append-only bookkeeping" by design, but that left every revoked
-- session's row permanently unprunable (no role, not even platform_ops,
-- could ever remove one), which is exactly the unbounded-resource-growth
-- shape E1 flagged. identity.ts's revokeSession uses this grant to
-- delete already-expired rows (see its own comment) in the same
-- transaction as the insert that records a new revocation -- there is no
-- separate purge job or scheduled task; C15a only ever describes deletion
-- "in the same transaction" as a revoke, so that is the one code path
-- that exercises this grant. No UPDATE grant: nothing un-revokes or edits
-- a revocation record, only ever inserts one or deletes an expired one.
GRANT SELECT, INSERT, DELETE ON revoked_sessions TO platform_ops;

-- No D#81 / #92 INHERIT bracket (D#94's INHERIT-window note): this table
-- is created by the migration-running role with no `OWNER TO
-- platform_ops` anywhere in this file, so it is owned by the
-- migration role itself, never platform_ops -- the same reasoning
-- 0604_session_epoch.sql's header already uses for its own two ADD
-- COLUMNs. `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE ... ROW LEVEL
-- SECURITY`, `CREATE POLICY` and `GRANT` all run as, and need only the
-- privileges of, the object's own owner (the migration role) -- none of
-- them transfers or replaces ownership of anything platform_ops owns.
-- The non-superuser Neon path therefore needs neither the bracket nor
-- role membership here. If this reasoning turns out not to hold, the
-- executor stops and reports rather than choosing a bracket itself (per
-- C15a) -- it was re-checked for this fix round and still holds.
