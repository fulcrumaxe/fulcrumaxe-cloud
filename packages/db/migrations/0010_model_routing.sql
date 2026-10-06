-- D#2 H22: intelligent model routing.
--
-- Migration number: the amendment text said 0003_model_routing.sql, but
-- 0002-0004 are already taken on main, and 0005-0009 are allocated to
-- other merged/in-flight work (see the Team Lead's correction on the H22
-- brief). This is 0010, the next free number in the core 00xx range at
-- the time this migration was written.
--
-- routing_tables / routing_rows are platform-wide, not tenant rows (every
-- account reads the same live table). They are therefore added to
-- packages/db/src/platformWideTables.ts's PLATFORM_WIDE_TABLES allowlist
-- in the same PR, and are exempt from the H02 RLS inventory check the way
-- schema_migrations already is -- there is no account_id column to scope
-- a policy on.
--
-- rejection_reason is not in the amendment's own column list for
-- routing_tables ("version, status, source, created_at, activated_at,
-- success_threshold_pp"), but the amendment's own pass/fail requires a
-- rejected proposal to store "the reason" -- there is nowhere else to put
-- it, so this migration adds the column the requirement needs.

CREATE TABLE routing_tables (
  version               integer PRIMARY KEY,
  status                text NOT NULL CHECK (status IN ('proposed', 'live', 'rejected', 'retired')),
  source                text NOT NULL CHECK (source IN ('default', 'offline_eval', 'cost_analyst')),
  success_threshold_pp  numeric(5, 2) NOT NULL DEFAULT 2,
  rejection_reason       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  activated_at          timestamptz
);

-- At most one live version at a time -- the router always reads exactly
-- one table, never has to choose between two "live" rows.
CREATE UNIQUE INDEX routing_tables_one_live ON routing_tables (status) WHERE status = 'live';

CREATE TABLE routing_rows (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_version  integer NOT NULL REFERENCES routing_tables (version) ON DELETE CASCADE,
  role           text NOT NULL,
  size           text NOT NULL CHECK (size IN ('Small', 'Feature', 'Critical')),
  model          text NOT NULL CHECK (model IN ('haiku-4.5', 'sonnet-5', 'opus-5')),
  rationale      text NOT NULL,
  UNIQUE (table_version, role, size)
);

GRANT SELECT ON routing_tables, routing_rows TO app_user;
GRANT SELECT, INSERT, UPDATE ON routing_tables, routing_rows TO platform_ops;

-- agent_runs gains the columns the router and H09 need to record a
-- decision (Spec H22 Files). escalated_from_run_id follows the same
-- tenant-scoped self-reference pattern parent_run_id already uses, so a
-- run can never point at another account's run.
-- agent_runs.model has no foreign key to routing_rows.model (agent_runs
-- rows can outlive any particular routing table version), so it needs its
-- own CHECK against the same three model ids routing_rows.model already
-- enforces above -- otherwise app_user's existing table-wide UPDATE grant
-- on agent_runs (already needed for usd/tokens) lets a tenant session set
-- its own run's model to an arbitrary string (security review, Must-fix
-- #1b). NULL is allowed: a run's model is only known once it has been
-- routed.
ALTER TABLE agent_runs
  ADD COLUMN model                  text CHECK (model IS NULL OR model IN ('haiku-4.5', 'sonnet-5', 'opus-5')),
  ADD COLUMN route_reason           text,
  ADD COLUMN route_table_version    integer REFERENCES routing_tables (version),
  ADD COLUMN escalated_from_run_id  uuid,
  ADD COLUMN expected_usd           numeric(10, 4),
  ADD COLUMN all_opus_expected_usd  numeric(10, 4);

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_escalated_from_fk
  FOREIGN KEY (account_id, escalated_from_run_id) REFERENCES agent_runs (account_id, id)
    ON DELETE SET NULL (escalated_from_run_id);

-- Seed version 1 as the live table, generated from
-- packages/model-router/default-table/v1.json (test/tableSchema.test.ts
-- asserts the two stay identical, so this INSERT can never silently drift
-- from the JSON that ships as "the" table).
INSERT INTO routing_tables (version, status, source, success_threshold_pp, created_at, activated_at)
VALUES (1, 'live', 'default', 2, now(), now());

INSERT INTO routing_rows (table_version, role, size, model, rationale) VALUES
  (1, 'executor', 'Small', 'haiku-4.5', 'role default (sonnet) size-adjusted for Small'),
  (1, 'executor', 'Feature', 'sonnet-5', 'role default (sonnet) size-adjusted for Feature'),
  (1, 'executor', 'Critical', 'opus-5', 'role default (sonnet) size-adjusted for Critical'),
  (1, 'code-reviewer', 'Small', 'haiku-4.5', 'role default (sonnet) size-adjusted for Small'),
  (1, 'code-reviewer', 'Feature', 'sonnet-5', 'role default (sonnet) size-adjusted for Feature'),
  (1, 'code-reviewer', 'Critical', 'opus-5', 'role default (sonnet) size-adjusted for Critical'),
  (1, 'security-reviewer', 'Small', 'sonnet-5', 'role default (opus) size-adjusted for Small, floored at sonnet-5 for security-reviewer'),
  (1, 'security-reviewer', 'Feature', 'opus-5', 'role default (opus) size-adjusted for Feature, floored at sonnet-5 for security-reviewer'),
  (1, 'security-reviewer', 'Critical', 'opus-5', 'role default (opus) size-adjusted for Critical, floored at sonnet-5 for security-reviewer'),
  (1, 'acceptance-tester', 'Small', 'haiku-4.5', 'role default (sonnet) size-adjusted for Small'),
  (1, 'acceptance-tester', 'Feature', 'sonnet-5', 'role default (sonnet) size-adjusted for Feature'),
  (1, 'acceptance-tester', 'Critical', 'opus-5', 'role default (sonnet) size-adjusted for Critical'),
  (1, 'debater', 'Small', 'haiku-4.5', 'role default (haiku) size-adjusted for Small'),
  (1, 'debater', 'Feature', 'haiku-4.5', 'role default (haiku) size-adjusted for Feature'),
  (1, 'debater', 'Critical', 'sonnet-5', 'role default (haiku) size-adjusted for Critical'),
  (1, 'project-manager', 'Small', 'sonnet-5', 'role default (opus) size-adjusted for Small'),
  (1, 'project-manager', 'Feature', 'opus-5', 'role default (opus) size-adjusted for Feature'),
  (1, 'project-manager', 'Critical', 'opus-5', 'role default (opus) size-adjusted for Critical'),
  (1, 'technical-architect', 'Small', 'sonnet-5', 'role default (opus) size-adjusted for Small'),
  (1, 'technical-architect', 'Feature', 'opus-5', 'role default (opus) size-adjusted for Feature'),
  (1, 'technical-architect', 'Critical', 'opus-5', 'role default (opus) size-adjusted for Critical'),
  (1, 'product-owner', 'Small', 'sonnet-5', 'role default (opus) size-adjusted for Small'),
  (1, 'product-owner', 'Feature', 'opus-5', 'role default (opus) size-adjusted for Feature'),
  (1, 'product-owner', 'Critical', 'opus-5', 'role default (opus) size-adjusted for Critical'),
  (1, 'cost-analyst', 'Small', 'sonnet-5', 'role default (opus) size-adjusted for Small'),
  (1, 'cost-analyst', 'Feature', 'opus-5', 'role default (opus) size-adjusted for Feature'),
  (1, 'cost-analyst', 'Critical', 'opus-5', 'role default (opus) size-adjusted for Critical'),
  (1, 'performance-expert', 'Small', 'sonnet-5', 'role default (opus) size-adjusted for Small'),
  (1, 'performance-expert', 'Feature', 'opus-5', 'role default (opus) size-adjusted for Feature'),
  (1, 'performance-expert', 'Critical', 'opus-5', 'role default (opus) size-adjusted for Critical'),
  (1, 'security-expert', 'Small', 'sonnet-5', 'role default (opus) size-adjusted for Small, floored at sonnet-5 for security-expert'),
  (1, 'security-expert', 'Feature', 'opus-5', 'role default (opus) size-adjusted for Feature, floored at sonnet-5 for security-expert'),
  (1, 'security-expert', 'Critical', 'opus-5', 'role default (opus) size-adjusted for Critical, floored at sonnet-5 for security-expert'),
  (1, 'researcher', 'Small', 'haiku-4.5', 'role default (haiku) size-adjusted for Small'),
  (1, 'researcher', 'Feature', 'haiku-4.5', 'role default (haiku) size-adjusted for Feature'),
  (1, 'researcher', 'Critical', 'sonnet-5', 'role default (haiku) size-adjusted for Critical'),
  (1, 'feedback-scanner', 'Small', 'haiku-4.5', 'role default (haiku) size-adjusted for Small'),
  (1, 'feedback-scanner', 'Feature', 'haiku-4.5', 'role default (haiku) size-adjusted for Feature'),
  (1, 'feedback-scanner', 'Critical', 'sonnet-5', 'role default (haiku) size-adjusted for Critical'),
  (1, 'incident-commander', 'Small', 'haiku-4.5', 'role default (sonnet) size-adjusted for Small'),
  (1, 'incident-commander', 'Feature', 'sonnet-5', 'role default (sonnet) size-adjusted for Feature'),
  (1, 'incident-commander', 'Critical', 'opus-5', 'role default (sonnet) size-adjusted for Critical'),
  (1, 'browser-tester', 'Small', 'haiku-4.5', 'role default (haiku) size-adjusted for Small'),
  (1, 'browser-tester', 'Feature', 'haiku-4.5', 'role default (haiku) size-adjusted for Feature'),
  (1, 'browser-tester', 'Critical', 'sonnet-5', 'role default (haiku) size-adjusted for Critical'),
  (1, 'tui-tester', 'Small', 'haiku-4.5', 'role default (haiku) size-adjusted for Small'),
  (1, 'tui-tester', 'Feature', 'haiku-4.5', 'role default (haiku) size-adjusted for Feature'),
  (1, 'tui-tester', 'Critical', 'sonnet-5', 'role default (haiku) size-adjusted for Critical'),
  (1, 'docs-writer', 'Small', 'haiku-4.5', 'role default (sonnet) size-adjusted for Small'),
  (1, 'docs-writer', 'Feature', 'sonnet-5', 'role default (sonnet) size-adjusted for Feature'),
  (1, 'docs-writer', 'Critical', 'opus-5', 'role default (sonnet) size-adjusted for Critical'),
  (1, 'release-manager', 'Small', 'haiku-4.5', 'role default (sonnet) size-adjusted for Small'),
  (1, 'release-manager', 'Feature', 'sonnet-5', 'role default (sonnet) size-adjusted for Feature'),
  (1, 'release-manager', 'Critical', 'opus-5', 'role default (sonnet) size-adjusted for Critical'),
  (1, 'runbook-writer', 'Small', 'haiku-4.5', 'role default (sonnet) size-adjusted for Small'),
  (1, 'runbook-writer', 'Feature', 'sonnet-5', 'role default (sonnet) size-adjusted for Feature'),
  (1, 'runbook-writer', 'Critical', 'opus-5', 'role default (sonnet) size-adjusted for Critical'),
  (1, 'accessibility-reviewer', 'Small', 'haiku-4.5', 'role default (sonnet) size-adjusted for Small'),
  (1, 'accessibility-reviewer', 'Feature', 'sonnet-5', 'role default (sonnet) size-adjusted for Feature'),
  (1, 'accessibility-reviewer', 'Critical', 'opus-5', 'role default (sonnet) size-adjusted for Critical'),
  (1, 'ux-designer', 'Small', 'haiku-4.5', 'role default (sonnet) size-adjusted for Small'),
  (1, 'ux-designer', 'Feature', 'sonnet-5', 'role default (sonnet) size-adjusted for Feature'),
  (1, 'ux-designer', 'Critical', 'opus-5', 'role default (sonnet) size-adjusted for Critical'),
  (1, 'mission-analyst', 'Small', 'sonnet-5', 'role default (opus) size-adjusted for Small'),
  (1, 'mission-analyst', 'Feature', 'opus-5', 'role default (opus) size-adjusted for Feature'),
  (1, 'mission-analyst', 'Critical', 'opus-5', 'role default (opus) size-adjusted for Critical'),
  (1, 'run-analyst', 'Small', 'haiku-4.5', 'role default (haiku) size-adjusted for Small'),
  (1, 'run-analyst', 'Feature', 'haiku-4.5', 'role default (haiku) size-adjusted for Feature'),
  (1, 'run-analyst', 'Critical', 'sonnet-5', 'role default (haiku) size-adjusted for Critical'),
  (1, 'analytics-engineer', 'Small', 'haiku-4.5', 'role default (sonnet) size-adjusted for Small'),
  (1, 'analytics-engineer', 'Feature', 'sonnet-5', 'role default (sonnet) size-adjusted for Feature'),
  (1, 'analytics-engineer', 'Critical', 'opus-5', 'role default (sonnet) size-adjusted for Critical'),
  (1, 'visual-verifier', 'Small', 'haiku-4.5', 'role default (haiku) size-adjusted for Small'),
  (1, 'visual-verifier', 'Feature', 'haiku-4.5', 'role default (haiku) size-adjusted for Feature'),
  (1, 'visual-verifier', 'Critical', 'sonnet-5', 'role default (haiku) size-adjusted for Critical'),
  (1, 'quality-sweep', 'Small', 'haiku-4.5', 'role default (haiku) size-adjusted for Small'),
  (1, 'quality-sweep', 'Feature', 'haiku-4.5', 'role default (haiku) size-adjusted for Feature'),
  (1, 'quality-sweep', 'Critical', 'sonnet-5', 'role default (haiku) size-adjusted for Critical');
