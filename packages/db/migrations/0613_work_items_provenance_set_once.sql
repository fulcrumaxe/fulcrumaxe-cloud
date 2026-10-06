-- D#2 H13a, per correction C26 and D#123 item 1.
--
-- D#123 item 1 (CWE-732/269, #116): app_user has table-wide UPDATE on
-- work_items, so provenance can change from external to internal after
-- insert -- unsafe now that provenance controls auto-merge
-- (packages/trust/src/work-gate.ts's autoMergeAllowed). C26 moves the fix
-- to H13a, since its own INSERT (body criterion 2) makes it the first
-- real writer of work_items.
--
-- APPROACH: a column-scoped grant, not a trigger. app_user's table-wide
-- UPDATE (0001_core.sql:933) is revoked and replaced with UPDATE on every
-- column EXCEPT provenance -- `UPDATE work_items SET provenance = ...` as
-- app_user then fails with 42501 (insufficient_privilege), the same
-- SQLSTATE for a missing column grant as for an RLS rejection (see
-- packages/db/test/helpers/pgErrors.ts). Every other column an existing
-- caller updates (recordStage's stage/updated_at; kind/gh_number/state/
-- wf_run_id) keeps working; only provenance becomes unreachable by
-- UPDATE. INSERT is unaffected -- H13a's own INSERT still sets it freely.
-- A column-scoped grant was chosen over a trigger because 42501 is what a
-- missing GRANT produces natively; a trigger would need
-- `RAISE EXCEPTION USING ERRCODE = '42501'` for the identical outcome.
--
-- The GRANT column list is built from information_schema at migration
-- run time (a DO block), not hardcoded, deliberately: hardcoding
-- `..., stage, ...` would assume 0610_work_item_stages.sql (which adds
-- that column) has already applied -- true on every real, monotonically-
-- ordered chain (D#94 R1), but packages/core/test/pg/
-- work-item-stage-parity.test.ts's own upgrade-path test constructs a
-- database with every migration EXCEPT 0610 applied (by filename, not by
-- migration order) specifically to prove 0610's backfill in isolation --
-- a scenario a hardcoded column list would break. The dynamic form grants
-- UPDATE on whatever non-provenance columns exist at the moment this
-- migration runs, which is every column in the normal chain and is
-- exactly the columns 0610 excludes in that one test's own construction.
--
-- ALSO IN THIS FILE: a platform_ops SELECT grant on installations/repos,
-- the same shape as the existing ledger/audit_log grant
-- (0001_core.sql:1017-1023). Neither table had any platform_ops grant
-- before this file (see packages/core/src/role-settings/types.ts's own
-- doc comment for the pre-existing list). H13a is the first webhook
-- consumer that needs to resolve an inbound delivery's numeric
-- installation.id/repository.id to this platform's own account_id/
-- repo_id BEFORE it knows which tenant to scope a withTenant connection
-- to -- exactly the "no account_id to scope by yet" case
-- packages/core/src/tenancy/withPlatformOps.ts documents platform_ops
-- for. SELECT only: H13a resolves identity here, never writes either
-- table (that stays H06's).
--
-- Numbering: main's newest migration is 0611_exposure_audit.sql; open PR
-- #131 holds 0612. This file takes 0613 (C26).

-- 1. work_items.provenance: set-once for app_user.
REVOKE UPDATE ON work_items FROM app_user;
DO $$
DECLARE
  writable_columns text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO writable_columns
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'work_items' AND column_name <> 'provenance';
  EXECUTE format('GRANT UPDATE (%s) ON work_items TO app_user', writable_columns);
END $$;

-- 2. platform_ops read access on installations/repos, for webhook-time
--    tenant resolution (H13a's own need -- see header).
CREATE POLICY platform_ops_read_access ON installations
  FOR SELECT TO platform_ops
  USING (true);
GRANT SELECT (id, account_id, gh_installation_id) ON installations TO platform_ops;

CREATE POLICY platform_ops_read_access ON repos
  FOR SELECT TO platform_ops
  USING (true);
GRANT SELECT (id, account_id, gh_repo_id) ON repos TO platform_ops;
