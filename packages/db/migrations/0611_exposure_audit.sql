-- D#8 R1: account_features and platform_audit -- the two tables that let a
-- feature ship to a customer already running the product without either
-- silently changing their behaviour or leaving no record of who changed
-- it. See D#8 (fulcrumaxe/cloud discussion #8) for the full design; this
-- migration builds exactly R1's Files/Pass-fail list: the two tables,
-- their RLS, their grants, the writer role, and the nullable agent_runs
-- column.
--
-- Migration numbering (D#94 R1, merge-monotonic; re-checked against main
-- and every open PR at both build time and rebase). The Spec's own text
-- says `0501`, from the retired per-epic 05xx range (D#8's range under
-- the old scheme) -- D#94 (merged as #118, see
-- packages/db/migrations/README.md) retired that scheme for every new
-- file: "a migration number written into an already-frozen Spec ... is
-- void once this rule takes effect -- take the next free number
-- instead." At build time: main's newest migration was 0609_revoked_
-- sessions.sql (#119, merged); open PR #127 (D#45 S1) holds 0610 on
-- packages/db/migrations/0610_work_item_stages.sql; no other open PR
-- touches packages/db/migrations/. 0611 is therefore the next free
-- number. Everything else in R1 is unchanged; this file keeps the
-- Spec's own base name (`exposure_audit`), only the four-digit prefix
-- differs.
--
-- account_features (R1 criteria 1-4): one row per (account, feature) that
-- has ever been explicitly decided -- absence of a row is meaningful
-- (D#8 R2's resolver treats a silent/gated feature with no row as "still
-- at its class default"), so this table is never seeded or backfilled,
-- only written when someone or something actually flips a feature. RLS
-- uses the InitPlan predicate form verbatim (R1 criterion 1, reusing
-- 0001_core.sql's own account_is_active() and its security-fix-round-5
-- performance rationale rather than re-deriving it):
-- `(SELECT account_is_active(NULLIF(current_setting('app.account_id',
-- true), '')::uuid))`, never `account_is_active(account_id)`.
--
-- The writer role (R1 criteria 2-3, R1 criterion 5): `exposure_writer` is
-- the sibling D#7 DP3's `receipt_writer` names in its own Implementation
-- Notes ("not a fourth idiom"). D#7's `0401_receipt_writer.sql` has not
-- landed yet (0401 does not exist in this migrations directory), so this
-- migration creates the role fresh, following the app_user/platform_ops
-- hardened-attribute shape D#81/#92 established in 0001_core.sql (state
-- every hardened attribute directly on CREATE, ALTER only when
-- current_user is actually a superuser, then assert none of the five
-- privileged attributes remain regardless) -- when DP3 builds 0401, it
-- matches this one rather than inventing a second pattern.
-- exposure_writer holds INSERT+UPDATE on account_features and
-- INSERT-only on platform_audit -- it is the ONLY role with any write
-- privilege on either table (R1 criteria 3 and 5). Its connection
-- string is not referenced anywhere in this migration, in
-- packages/db/test/**, or in ephemeral-pg.ts -- by construction it is
-- unreachable from this package's own test harness the same way it must
-- be unreachable from a sandbox or an agent tool surface in production
-- (R1 criterion 3); the non-vacuity tests for its grants
-- (exposure.test.ts, platform-audit.test.ts) connect as the ephemeral
-- cluster's own superuser test-admin connection and `SET ROLE
-- exposure_writer` for the duration of one write, which needs no
-- additional grant here because a Postgres superuser may always SET
-- ROLE to any role. No RLS-authority policy is layered onto
-- exposure_writer's own access beyond FOR ALL USING (true): the
-- customer-owner/admin vs. platform_ops vs. partner-refused authority
-- check (D#8 R3's resolveExposure() flip-authority table) is enforced
-- by the application code that decides whether to call this role at
-- all, the same trust boundary D#7's receipt_writer sits behind ("a
-- credential the agent's tool surface cannot reach") -- exposure_writer
-- itself is never reachable by a caller that hasn't already passed that
-- check.
--
-- The frozen exposure columns on agent_runs (R1 criterion 7, D#2
-- amendment 18488789 / correction C19): `resolved_exposure` and
-- `exposure_digest` are additive and nullable, the same shape
-- 0010_model_routing.sql used for its own new agent_runs columns. But
-- the Spec's own Failure conditions (D#8 body, "Intent") name this exact
-- case: "Any pin, entitlement or exposure state reachable by an
-- app_user UPDATE" is an unconditional failure for the whole D#8 Spec,
-- and 0001_core.sql already grants app_user a table-wide,
-- column-unrestricted `UPDATE ON agent_runs` that no later migration has
-- narrowed -- 0010_model_routing.sql's own `model`/`route_table_version`
-- columns inherited that same blanket grant (a pre-existing gap this
-- migration does not attempt to close for THOSE columns; that is out of
-- R1's scope). Left alone, the two new columns this migration adds
-- would be reachable by that same blanket grant from the moment they
-- exist, before D#8 R3 ever builds the freeze this Spec's Success
-- conditions require ("a mid-flight deploy cannot change behaviour
-- under a running work item"). The DO block below revokes app_user's
-- table-wide UPDATE and re-grants it column-by-column over every column
-- agent_runs actually has EXCEPT these two, computed from
-- information_schema at migration time rather than hardcoded, so it
-- can't drift from agent_runs' real column list and needs no update if
-- a later migration adds another column.

-- ---------------------------------------------------------------------
-- exposure_writer role (D#81/#92 hardened-attribute shape).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'exposure_writer') THEN
    CREATE ROLE exposure_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE exposure_writer NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
DECLARE
  r    record;
  bad  text[] := '{}';
BEGIN
  SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO r
    FROM pg_roles WHERE rolname = 'exposure_writer';
  IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
  IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
  IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
  IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
  IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'role exposure_writer still has privileged attribute(s): %', array_to_string(bad, ', ');
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- account_features
-- ---------------------------------------------------------------------
CREATE TABLE account_features (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Non-empty CHECK: same convention 0400_decisions.sql's decision_type
  -- uses -- a blank key is never a valid feature identity.
  feature_key         text NOT NULL CHECK (feature_key <> ''),
  state               text NOT NULL CHECK (state IN ('on', 'off')),
  source              text NOT NULL CHECK (source IN ('customer', 'platform', 'product_default')),
  -- R1 criterion 4: always the authenticated session's own user, never a
  -- client-supplied field -- packages/db/src/exposure.ts derives this
  -- from ctx.principal, the same (ctx, input) shape decisions.ts's
  -- writeDialSetting() uses for decision_settings.changed_by.
  decided_by_user_id  uuid NOT NULL REFERENCES users (id),
  decided_at          timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, feature_key)
);
-- No separate account_id index needed: UNIQUE (account_id, feature_key)
-- above already leads with it, same reasoning 0400_decisions.sql gives
-- for decision_settings.

ALTER TABLE account_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_features FORCE ROW LEVEL SECURITY;

-- R1 criterion 1: the InitPlan form verbatim, not account_is_active(account_id).
CREATE POLICY tenant_isolation_select ON account_features
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- No INSERT/UPDATE/DELETE policy for app_user: it is never GRANTed any of
-- those verbs on this table at all (R1 criteria 2-3), the same
-- "privilege check fails before RLS is even evaluated" shape
-- 0400_decisions.sql's own file header describes for decision_settings.

-- See the file header for why this is FOR ALL USING (true): the
-- customer/platform/partner authority check is the application layer's
-- job (D#8 R3), not this policy's -- exposure_writer is unreachable by
-- anything that hasn't already passed that check.
CREATE POLICY exposure_writer_full_access ON account_features
  FOR ALL TO exposure_writer
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON account_features TO app_user;
-- SELECT, not just INSERT/UPDATE: `INSERT ... RETURNING` (exposure.ts's
-- writeFeatureFlip()) requires the SELECT privilege on the columns it
-- returns even when the applicable RLS policy is USING (true) -- RLS and
-- the base GRANT are two independent checks, and RETURNING needs both.
-- Verified empirically against a throwaway cluster before relying on it
-- here: an INSERT-only role's own `RETURNING *` fails with "permission
-- denied for table", not merely an empty/filtered result. R1 criterion 3
-- only constrains the INSERT/UPDATE/DELETE set (exactly {exposure_writer});
-- it does not forbid exposure_writer also holding SELECT.
GRANT SELECT, INSERT, UPDATE ON account_features TO exposure_writer;

-- ---------------------------------------------------------------------
-- platform_audit
-- ---------------------------------------------------------------------
-- Platform-wide, not per-tenant (R1 criterion 5's whole point:
-- audit_log.account_id is NOT NULL, so a platform-wide action -- the
-- emergency floor path, a cross-account admin decision -- has no legal
-- row shape today). No RLS at all, the same shape 0010_model_routing.sql
-- uses for routing_tables/routing_rows: it is registered in
-- PLATFORM_WIDE_TABLES (packages/db/src/platformWideTables.ts, this same
-- PR) and exempted from the H02 "every table has RLS" inventory check
-- (R1 criterion 6) rather than given a policy that would just be
-- USING (true) for every role that can reach it anyway.
CREATE TABLE platform_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid REFERENCES accounts (id) ON DELETE CASCADE,
  actor_user_id   uuid NOT NULL REFERENCES users (id),
  action          text NOT NULL,
  advisory_ref    text,
  previous_value  jsonb,
  new_value       jsonb,
  authorised_by   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_audit_account_id ON platform_audit (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX idx_platform_audit_created_at ON platform_audit (created_at);

-- R1 criterion 5's exact matrix: app_user holds nothing at all (no GRANT
-- statement for it below); platform_ops holds SELECT; the writer role
-- holds INSERT and nothing else; no role holds UPDATE or DELETE.
GRANT SELECT ON platform_audit TO platform_ops;
GRANT INSERT ON platform_audit TO exposure_writer;

-- ---------------------------------------------------------------------
-- agent_runs: the frozen exposure columns (R1 criterion 7).
-- ---------------------------------------------------------------------
ALTER TABLE agent_runs
  ADD COLUMN resolved_exposure  jsonb,
  ADD COLUMN exposure_digest    text;

-- See the file header for why this block exists: app_user's pre-existing
-- table-wide UPDATE grant on agent_runs (0001_core.sql) would otherwise
-- reach these two columns from the moment they exist, which is exactly
-- the Spec's own Failure condition ("Any pin, entitlement or exposure
-- state reachable by an app_user UPDATE"). Every other pre-existing
-- app_user privilege on agent_runs (SELECT, INSERT, and UPDATE on every
-- column except these two) is unchanged.
DO $$
DECLARE
  allowed_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO allowed_cols
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_runs'
      AND column_name NOT IN ('resolved_exposure', 'exposure_digest');

  REVOKE UPDATE ON agent_runs FROM app_user;
  EXECUTE format('GRANT UPDATE (%s) ON agent_runs TO app_user', allowed_cols);
END
$$;
