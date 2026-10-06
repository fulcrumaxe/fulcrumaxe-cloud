-- Decision policy layer: dial history and receipts (D#7 task DP2).
--
-- Two tables, both tenant-scoped, both built on H02's pattern from
-- 0001_core.sql: composite account-scoped FKs, `app_user`/`platform_ops`
-- role model, FORCE ROW LEVEL SECURITY, `account_is_active()` (defined in
-- 0001_core.sql) gating every policy the same way every other tenant table's
-- policy already does.
--
-- `decision_settings`: append-only dial history, keyed `(repo_id,
-- decision_type)` with a `version` column -- rows are history, not state;
-- current state is whichever row has the highest version for that key
-- (DP2 pass/fail item 1). `app_user` gets SELECT and INSERT only: no
-- UPDATE, no DELETE (DP2 item 2, C8) -- a dial is a record of who granted
-- authority and when, not a toggle. The INSERT policy additionally
-- requires `changed_by` to be a real `account_members` row for this
-- account with role owner or admin (DP2 item 6, C8): a plain member's
-- attempt is rejected by the policy itself, not merely by application
-- code.
--
-- Fix round (D#7 DP2, code review needs-fix on PR #54): the first cut of
-- this policy checked only that `changed_by` NAMED an owner/admin, the
-- same "trust the caller-supplied column" shape 0200_partners.sql's
-- `support_grants` policy uses -- but `support_grants` has no cheaper
-- alternative (there is no session-level identity to bind it to there).
-- Here there is: `writeDialSetting()` already opens its transaction
-- through `withTenant(pool, accountId, callerId, ...)`, which sets
-- `app.user_id` to the caller's own id. Checking membership on
-- `changed_by` alone, without also requiring `changed_by` to BE the
-- session's `app.user_id`, let any caller who could reach this INSERT
-- name a *different*, real owner/admin as `changed_by` -- the INSERT and
-- the `audit_log` row it produces would both then name that admin, not
-- the actual (lower-privileged) caller. The `X-USER-ID amendment`
-- (D#2607, discussioncomment-18486915) already establishes the fix for
-- this shape: bind the caller-supplied column to `app.user_id` with `=`,
-- the same way `migrations/0200_partners.sql`'s `support_access_log`
-- partner-side INSERT binds `actor_user_id`. The policy below now
-- requires BOTH: `changed_by = current_setting('app.user_id', true)`
-- (so a member cannot claim to be someone else) AND that identity is a
-- real owner/admin (so a member cannot write even as themselves). The
-- audit trail half of C8 (an `audit_log` row naming the actor and both
-- the previous and new values) is `packages/db/src/decisions.ts`'s job --
-- `writeDialSetting()` takes the caller's identity from its `ctx`
-- (never a free `changedBy` input) and performs the version read, the
-- INSERT (which the policy below gates) and the `audit_log` INSERT
-- inside one transaction, so a rejected dial write never produces a
-- partial audit trail.
--
-- Fix round 3 (D#7 DP2, security review needs-fix on PR #54, MUST item 1):
-- the owner/admin-only INSERT policy above stops a member from writing a
-- fraudulent decision_settings row directly, but it did nothing about a
-- member DELETEing the *parent* repos row instead -- app_user holds plain
-- DELETE on repos (0001_core.sql), checked only against account_id, and
-- the composite FK below used to read `ON DELETE CASCADE`. A member
-- could wipe an account's entire dial history for a repo with an
-- ordinary `DELETE FROM repos`: no owner/admin check, no audit_log row --
-- the exact append-only guarantee item 2/C8 gives this table, bypassed
-- through a completely different table's grant. The composite FK is now
-- `ON DELETE NO ACTION` (RESTRICT-equivalent for a non-deferrable FK,
-- checked immediately -- NO ACTION is used rather than the RESTRICT
-- keyword purely so a violation raises `foreign_key_violation`, 23503,
-- the same SQLSTATE every other FK rejection in this schema's tests
-- already assert on; explicit RESTRICT raises the distinct
-- `restrict_violation`, 23001, in Postgres): a repo that still has dial
-- history cannot be hard-deleted by anyone, app_user or otherwise, until
-- that history is moved aside through an explicit, audited path (not
-- built here). Repo removal (uninstalling the GitHub App, the webhook
-- lifecycle hard-deleting a repos row) must go through a soft-delete/
-- deactivation path instead, the same shape accounts already use
-- (`account_is_active()`).
--
-- Fix round 3 also adds a BEFORE INSERT trigger on decision_settings
-- (SUGGESTION item 5): `version` must equal one more than the current
-- max for `(account_id, repo_id, decision_type)`. The column-level
-- `CHECK (version >= 1)` alone left ordering to application code, so raw
-- SQL as an admin could skip straight to `2147483647` and permanently
-- brick that key -- the next real write then fails on integer overflow,
-- and app_user has neither UPDATE nor DELETE to recover. This check
-- cannot live in the INSERT policy's WITH CHECK the way the rest of
-- owner_or_admin_insert does: a WITH CHECK subquery against
-- decision_settings itself makes Postgres re-expand this table's OWN
-- SELECT policy while it is still mid-rewrite for the very INSERT being
-- checked, which Postgres refuses outright with "infinite recursion
-- detected in policy for relation decision_settings" (SQLSTATE 42P17) --
-- a structural limitation of same-table RLS subqueries, not a logic bug
-- (0001_core.sql's own `account_is_active()` comment already flags this
-- exact hazard: "avoids any doubt about a function call recursing into
-- the policy of the very table it's defined against"). A trigger's
-- internal query is planned and executed as an independent statement,
-- outside that rewrite pass, so it does not hit the same limitation --
-- see `decision_settings_enforce_next_version()` below the table
-- definition. It enforces a real `MAX(version)+1`, not merely a ceiling,
-- so a version can never be skipped, reused, or written out of order --
-- and because it is a trigger rather than a role-scoped RLS policy, it
-- applies to every INSERT, including a superuser/migration-owner
-- connection's raw SQL, not just app_user.
--
-- Fix round 3 also adds a CHECK on `disposition` (DP-C1,
-- discussioncomment-18500837: `ask | announce | act`) and a
-- non-empty CHECK on `decision_type` (SUGGESTION item 7): both used to
-- be unconstrained text, so the resolver could be handed a dial row with
-- an unknown disposition or an empty decision_type key and would have to
-- fail closed itself with no help from the database.
--
-- `decision_receipts`: the durable evidence table. `run_id` is nullable
-- and carries NO cascade from `agent_runs` -- deleting a run must leave
-- its class-2/class-3 receipts intact (DP2 item 3, C5, DP-OD5), so the
-- composite FK uses the same `ON DELETE SET NULL (run_id)` shape
-- 0001_core.sql already uses for `ledger.run_id`, not CASCADE. That
-- SET NULL is safe specifically because `agent_runs` is NOT reachable by
-- a tenant: `app_user` holds no DELETE on `agent_runs` at all, so only an
-- admin/migration-owner connection can ever trigger it, and C5's
-- requirement is that a run's deletion must not destroy the receipt -- it
-- does not require the receipt to stay byte-for-byte unmutated against
-- every possible cause, only against the one a tenant can actually cause.
--
-- Fix round 3 (D#7 DP2, security review needs-fix on PR #54, MUST item
-- 2): `work_item_id` used to carry that SAME `ON DELETE SET NULL` shape,
-- but unlike `agent_runs`, `work_items` IS reachable by a tenant --
-- app_user holds plain DELETE on it (0001_core.sql), checked only
-- against account_id. A member could `DELETE FROM work_items` and have
-- Postgres rewrite `decision_receipts.work_item_id` to NULL on their
-- behalf, with no UPDATE grant on `decision_receipts` ever checked --
-- exactly the gap C4 exists to close (`app_user` gets SELECT-only on
-- this table, no INSERT, and the intent behind that grant list is that
-- nothing app_user does can change a written receipt). SET NULL let a
-- DELETE on a *different* table stand in for the UPDATE app_user is
-- deliberately never granted here. The FK is now `ON DELETE NO ACTION`
-- (see the repo FK comment above for why NO ACTION rather than RESTRICT):
-- a work item that still has receipts cannot be hard-deleted at all, by
-- app_user or otherwise, so no path remains that mutates a receipt after
-- it is written, other than age-based pruning
-- (`pruneDecisionReceipts()`, admin-only, below). This is a deliberate
-- divergence from `run_id`'s SET NULL, not an inconsistency: the two
-- columns sit behind different privilege boundaries (`app_user` can
-- DELETE `work_items` but not `agent_runs`), so the identical FK shape
-- would have given them different real-world guarantees despite looking
-- the same in the DDL. Column-level NOT NULL is deliberately NOT applied
-- to the receipt's content columns (`chosen`, `rejected_alternative`,
-- `dial_version`, `input_trust_classes`, `actor`, `reversal_state`) --
-- DP3's own pass/fail item 3 says a receipt missing any of its required
-- fields "is rejected at the writer, not at the database, with a named
-- error", so the database intentionally leaves that validation to
-- `packages/db/src/receiptWriter.ts` (DP3, not built here) rather than
-- duplicating it in a NOT NULL constraint DP3 doesn't ask for. `app_user`
-- gets SELECT only on this table -- no INSERT at all (DP2 item 4, C4):
-- the writer is DP3's `receipt_writer` role, created in
-- `0401_receipt_writer.sql`, which does not exist yet in this migration.
--
-- `class` DOES get a CHECK: DP-OD2 (cross-referenced by DP1 pass/fail item
-- 1) gives an explicit pipe-separated value list for it
-- (`automated_with_monitoring | human_over_the_loop | human_in_the_loop`),
-- which is exactly the bar 0001_core.sql's own file header sets for adding
-- a CHECK ("only added for columns whose spec text gave an explicit
-- pipe-separated value list"). Fix round 3 adds the same non-empty CHECK
-- to `decision_receipts.decision_type` that `decision_settings` now has
-- (SUGGESTION item 7) -- both columns draw from the same catalogue of
-- keys, and an empty-string key is never valid evidence either.
--
-- Retention (DP2 item 8, DP-OD5, C5): `decision_receipts` rows older than
-- 24 months are pruned by `pruneDecisionReceipts()` in
-- `packages/db/src/decisions.ts`, run against the same admin/migration-
-- owner connection `src/migrate.ts` uses -- deliberately NOT a grant to
-- any application role (`app_user` has no DELETE here at all, matching
-- item 4; nothing in this Spec asks for one), and deliberately independent
-- of any run-retention job: it is a plain `created_at` cutoff on this
-- table alone, never joined to `agent_runs`. Fix round 3 (SUGGESTION item
-- 6): that function now refuses a `retentionMonths` below
-- `RECEIPT_RETENTION_MONTHS` (24) rather than trusting the caller's
-- number, so an accidental `0` or negative value can no longer delete
-- every receipt early -- see `packages/db/src/decisions.ts`.
--
-- Additive only (DP2 item 7): this file only CREATEs. `0001`-`0004`,
-- `0100` (D#4) and `0200` (D#5... this repo's actual D#5 migration is
-- `0200_partners.sql`, not a `03xx` file -- see test/decisions-schema.test.ts
-- for why the byte-identity check below only covers the six migration
-- files that actually exist, and the PR description for how that maps
-- back to the Spec's `02xx`/`03xx` shorthand) are untouched. Fix round 3
-- edits THIS file in place (0400 has not merged yet) rather than adding a
-- follow-on migration -- there is no deployed database yet for this table
-- pair to be additive against.

-- ---------------------------------------------------------------------
-- decision_settings
-- ---------------------------------------------------------------------
CREATE TABLE decision_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id     uuid NOT NULL,
  -- Non-empty CHECK (fix round 3, SUGGESTION item 7): a blank key is
  -- never a valid dial identity, and the resolver should not have to
  -- guard against one the database could have refused outright.
  decision_type  text NOT NULL CHECK (decision_type <> ''),
  -- DP-C1 (discussioncomment-18500837) gives an explicit pipe-separated
  -- value list for disposition, same bar 0001_core.sql's file header sets
  -- for adding a CHECK (fix round 3, SUGGESTION item 7).
  disposition    text NOT NULL CHECK (disposition IN ('ask', 'announce', 'act')),
  -- Nullable: a dial write is usually "adopt preset X", but a per-type
  -- override that isn't attributed to any named preset is also valid (the
  -- row still records a real disposition and a real actor either way).
  preset         text,
  version        integer NOT NULL CHECK (version >= 1),
  -- Plain FK to users (global identity), same reasoning as
  -- account_members.user_id in 0001_core.sql's file header: no second
  -- account_id to compose against on the users side.
  changed_by     uuid NOT NULL REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Enforces "current state is the highest version" as a real constraint,
  -- not just a convention application code has to honor -- and is the
  -- concurrency safety net for two simultaneous writers racing to the same
  -- next version (see decisions.ts: the loser's INSERT fails on THIS
  -- constraint with a unique-violation, not silently overwritten). Not
  -- backed by a SELECT ... FOR UPDATE lock in decisions.ts: that locking
  -- clause needs the UPDATE privilege, which app_user deliberately never
  -- has here (see the owner_or_admin_insert policy comment below).
  UNIQUE (account_id, repo_id, decision_type, version),
  -- Fix round 3 (MUST item 1): was ON DELETE CASCADE, which let a plain
  -- member wipe a repo's whole dial history via a bare DELETE on repos
  -- (app_user holds DELETE there, account-scoped only -- see file
  -- header). NO ACTION means the repo cannot be hard-deleted while any
  -- dial history for it still exists, by app_user or any other role (see
  -- file header for why NO ACTION rather than the RESTRICT keyword).
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE NO ACTION
);

-- Fix round 3 (SUGGESTION item 5): version = max+1 per key, enforced as a
-- trigger rather than in the owner_or_admin_insert policy's WITH CHECK --
-- see the file header for why a same-table WITH CHECK subquery is not
-- usable here (SQLSTATE 42P17, infinite recursion detected in policy).
-- Plain LANGUAGE plpgsql, invoker rights (no SECURITY DEFINER): the
-- internal SELECT is scoped to the row's own (account_id, repo_id,
-- decision_type), so it returns the same answer whether or not RLS
-- additionally restricts visibility to that same account -- there is
-- nothing for elevated privilege to buy here, matching this schema's
-- existing account_is_active() (0001_core.sql), which is also a plain,
-- non-SECURITY-DEFINER function.
CREATE FUNCTION decision_settings_enforce_next_version() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  expected_version integer;
BEGIN
  SELECT COALESCE(MAX(version), 0) + 1 INTO expected_version
  FROM decision_settings
  WHERE account_id = NEW.account_id
    AND repo_id = NEW.repo_id
    AND decision_type = NEW.decision_type;
  IF NEW.version <> expected_version THEN
    RAISE EXCEPTION
      'decision_settings.version must be % (the next version for this key), got %',
      expected_version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER decision_settings_enforce_next_version
  BEFORE INSERT ON decision_settings
  FOR EACH ROW EXECUTE FUNCTION decision_settings_enforce_next_version();

-- ---------------------------------------------------------------------
-- decision_receipts
-- ---------------------------------------------------------------------
CREATE TABLE decision_receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Nullable: MUST be, to survive ON DELETE SET NULL below when the
  -- referenced agent_runs row is removed (DP2 item 3, C5, DP-OD5). Safe
  -- as SET NULL specifically because app_user has no DELETE on
  -- agent_runs at all (see file header) -- this column is not reachable
  -- by a tenant.
  run_id         uuid,
  -- Nullable for the same "must outlive its parent" reasoning as run_id,
  -- but fix round 3 (MUST item 2) changed the referential ACTION: was
  -- ON DELETE SET NULL, which let a plain member rewrite this column to
  -- NULL by deleting the work_items row (app_user holds DELETE there,
  -- account-scoped only), with no UPDATE grant on decision_receipts ever
  -- checked. NO ACTION closes that: a work item with receipts cannot be
  -- hard-deleted by anyone, so this column can only ever be set at
  -- INSERT time (see file header for why NO ACTION rather than the
  -- RESTRICT keyword).
  work_item_id   uuid,
  -- Non-empty CHECK (fix round 3, SUGGESTION item 7) -- same reasoning as
  -- decision_settings.decision_type above.
  decision_type  text NOT NULL CHECK (decision_type <> ''),
  -- DP-OD2's explicit pipe-separated list (see file header).
  class          text NOT NULL
                   CHECK (class IN ('automated_with_monitoring', 'human_over_the_loop', 'human_in_the_loop')),
  -- Content columns: deliberately no NOT NULL here -- see file header
  -- (DP3 item 3 validates these at the writer, not the database).
  chosen                text,
  rejected_alternative  text,
  dial_version          integer,
  input_trust_classes   jsonb,
  actor                 text,
  reversal_state        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id)
    ON DELETE SET NULL (run_id),
  -- Fix round 3 (MUST item 2): NO ACTION, not SET NULL -- see the
  -- work_item_id column comment above and the file header.
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id)
    ON DELETE NO ACTION
);

CREATE INDEX idx_decision_receipts_account_id ON decision_receipts (account_id);
-- Supports the retention pruning query's `created_at < cutoff` scan
-- (DP2 item 8) without a sequential scan over every tenant's receipts.
CREATE INDEX idx_decision_receipts_created_at ON decision_receipts (created_at);
-- decision_settings needs no separate account_id index: the UNIQUE
-- constraint above already leads with (account_id, repo_id, ...), same
-- reasoning 0001_core.sql gives for installations/repos/work_items/
-- agent_runs's own UNIQUE (account_id, id) constraints.

-- ---------------------------------------------------------------------
-- RLS + grants.
-- ---------------------------------------------------------------------
ALTER TABLE decision_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON decision_settings
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- Owner/admin-only write (DP2 item 6, C8), fixed to bind the actor to the
-- session rather than merely to a name (D#7 DP2 fix round, PR #54): the
-- caller cannot write a dial UNLESS `changed_by` equals `app.user_id` --
-- the session's own identity, set by `withTenant()` -- AND that identity
-- is a real account_members row for THIS account with role owner or
-- admin. Requiring both closes the impersonation hole the first cut left
-- open: naming a real admin in `changed_by` while being someone else no
-- longer passes, because the `=` conjunct fails before the EXISTS is even
-- relevant. A plain member's own id still fails the EXISTS the same way
-- it always did. No UPDATE/DELETE policy is needed below because
-- app_user is never GRANTed either verb on this table at all (see the
-- GRANT statement below): the privilege check fails before RLS is even
-- evaluated for those commands, same as every other append-only table in
-- this schema (ledger, audit_log, run_events in 0001_core.sql).
--
-- version = max+1 (SUGGESTION item 5) is enforced by a BEFORE INSERT
-- trigger, `decision_settings_enforce_next_version()`, defined right
-- after this table's CREATE TABLE above -- NOT here in this policy's
-- WITH CHECK, because a same-table subquery in this policy would make
-- Postgres re-expand decision_settings' own SELECT policy while still
-- mid-rewrite for this INSERT ("infinite recursion detected in policy",
-- SQLSTATE 42P17). See the file header for the full explanation.
CREATE POLICY owner_or_admin_insert ON decision_settings
  FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND changed_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = decision_settings.account_id
        AND m.user_id = decision_settings.changed_by
        AND m.role IN ('owner', 'admin')
    )
  );
-- Append-only for app_user: SELECT and INSERT only, matching DP2 item 2
-- exactly. No platform_ops grant or policy -- DP2 does not ask for one;
-- this is silence, not an oversight (same convention as
-- 0200_partners.sql's closing comment on model_connections/
-- spend_reservations/installations/audit_log for partner_user).
GRANT SELECT, INSERT ON decision_settings TO app_user;

ALTER TABLE decision_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON decision_receipts
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- Read-only for app_user (DP2 item 4, C4): no INSERT grant, and therefore
-- no INSERT policy either -- there is nothing for `receipt_writer`
-- (0401_receipt_writer.sql, DP3, not built here) to conflict with yet.
GRANT SELECT ON decision_receipts TO app_user;
