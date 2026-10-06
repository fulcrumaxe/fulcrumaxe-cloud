-- D#45 S2: v_kpi_work_items, v_kpi_runs -- the two read-only KPI views
-- @fx/stats' computeKpis() and (later, S3) the stats API read from.
--
-- Numbering: main's newest migration is 0622_rate_limits.sql (D#94 R1),
-- so this file takes 0623. Re-checked with
-- packages/db/scripts/check-migration-order.sh --base origin/main at
-- build time; renumber above main's newest again at rebase if main has
-- moved.
--
-- Both views are `WITH (security_invoker = true)`: every underlying table
-- access runs with the QUERYING role's own privileges and RLS, not the
-- view owner's. That is what lets `withTenant(A)` scope both views to A's
-- rows for free, through the tenant_isolation policies work_items,
-- work_item_transitions, agent_runs and ledger already carry -- and it is
-- exactly what S1 criterion 8's view/matview inventory check (D#68 PM
-- correction C4) exists to enforce is not forgotten here.
--
-- No #92 INHERIT/ownership bracket is needed: these views are owned by
-- the migration role itself and never transferred to platform_ops.

-- ---------------------------------------------------------------------
-- 1. v_kpi_work_items -- one row per work item.
--
--    t_* columns are MIN(at) of that item's transitions to that stage
--    (S2 binding table: "T(s) is the earliest at of its transitions to
--    s"). t_first_verdict/first_verdict_stage are the earliest row whose
--    to_stage is a verdict stage (changes_requested or review_passed),
--    ties broken by created_at then id -- which is also, by construction,
--    min(T(changes_requested), T(review_passed)) (the earliest across
--    both stages individually), since the minimum of two per-stage
--    minimums equals the minimum over their union.
--
--    model_usd/compute_usd sum `ledger.usd` (by kind) over the ledger
--    rows of this item's own agent_runs; both are 0, not NULL, when the
--    item has none. `tokens` sums tokens_in + tokens_out (NULL treated as
--    0) over this item's runs, but only those with
--    `runtime IN ('local', 'production')` -- criterion 2 requires that
--    literal filter to appear in `pg_get_viewdef`, so it stays explicit
--    even though `agent_runs.runtime`'s own CHECK constraint already
--    limits it to exactly those two values today.
-- ---------------------------------------------------------------------
CREATE VIEW v_kpi_work_items WITH (security_invoker = true) AS
SELECT
  wi.account_id,
  wi.id AS work_item_id,
  wi.repo_id,
  wi.kind,
  wi.stage,
  wi.created_at,
  stg.t_discussing,
  stg.t_spec_ready,
  stg.t_in_progress,
  stg.t_pr_opened,
  vd.t_first_verdict,
  vd.first_verdict_stage,
  stg.t_needs_human,
  stg.t_merged,
  stg.t_closed_unmerged,
  stg.t_closed,
  COALESCE(stg.n_changes_requested, 0) AS n_changes_requested,
  COALESCE(stg.n_needs_human, 0) AS n_needs_human,
  COALESCE(lg.model_usd, 0) AS model_usd,
  COALESCE(lg.compute_usd, 0) AS compute_usd,
  COALESCE(rn.tokens, 0) AS tokens
FROM work_items wi
LEFT JOIN LATERAL (
  SELECT
    MIN(wit.at) FILTER (WHERE wit.to_stage = 'discussing') AS t_discussing,
    MIN(wit.at) FILTER (WHERE wit.to_stage = 'spec_ready') AS t_spec_ready,
    MIN(wit.at) FILTER (WHERE wit.to_stage = 'in_progress') AS t_in_progress,
    MIN(wit.at) FILTER (WHERE wit.to_stage = 'pr_opened') AS t_pr_opened,
    MIN(wit.at) FILTER (WHERE wit.to_stage = 'needs_human') AS t_needs_human,
    MIN(wit.at) FILTER (WHERE wit.to_stage = 'merged') AS t_merged,
    MIN(wit.at) FILTER (WHERE wit.to_stage = 'closed_unmerged') AS t_closed_unmerged,
    MIN(wit.at) FILTER (WHERE wit.to_stage = 'closed') AS t_closed,
    COUNT(*) FILTER (WHERE wit.to_stage = 'changes_requested') AS n_changes_requested,
    COUNT(*) FILTER (WHERE wit.to_stage = 'needs_human') AS n_needs_human
  FROM work_item_transitions wit
  WHERE wit.account_id = wi.account_id AND wit.work_item_id = wi.id
) stg ON true
LEFT JOIN LATERAL (
  SELECT wit.to_stage AS first_verdict_stage, wit.at AS t_first_verdict
  FROM work_item_transitions wit
  WHERE wit.account_id = wi.account_id AND wit.work_item_id = wi.id
    AND wit.to_stage IN ('changes_requested', 'review_passed')
  ORDER BY wit.at ASC, wit.created_at ASC, wit.id ASC
  LIMIT 1
) vd ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE(SUM(l.usd) FILTER (WHERE l.kind = 'model'), 0) AS model_usd,
    COALESCE(SUM(l.usd) FILTER (WHERE l.kind = 'compute'), 0) AS compute_usd
  FROM agent_runs ar
  JOIN ledger l ON l.account_id = ar.account_id AND l.run_id = ar.id
  WHERE ar.account_id = wi.account_id AND ar.work_item_id = wi.id
) lg ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(COALESCE(ar.tokens_in, 0) + COALESCE(ar.tokens_out, 0)), 0) AS tokens
  FROM agent_runs ar
  WHERE ar.account_id = wi.account_id AND ar.work_item_id = wi.id
    AND ar.runtime IN ('local', 'production')
) rn ON true;

GRANT SELECT ON v_kpi_work_items TO app_user;

-- ---------------------------------------------------------------------
-- 2. v_kpi_runs -- one row per agent run, restricted to
--    `runtime IN ('local', 'production')` runs only (criterion 2: "both
--    pg_get_viewdef texts contain that filter" -- this is the view's own
--    WHERE, not just the lateral filter in v_kpi_work_items above).
--    `repo_id` comes from the run's work item (NULL when the run has none
--    or the item's own repo_id is NULL).
-- ---------------------------------------------------------------------
CREATE VIEW v_kpi_runs WITH (security_invoker = true) AS
SELECT
  ar.account_id,
  ar.id AS run_id,
  ar.work_item_id,
  wi.repo_id,
  ar.role,
  ar.runtime,
  ar.status,
  ar.created_at,
  ar.started_at,
  ar.ended_at,
  ar.tokens_in,
  ar.tokens_out,
  COALESCE(lg.model_usd, 0) AS model_usd,
  COALESCE(lg.compute_usd, 0) AS compute_usd
FROM agent_runs ar
LEFT JOIN work_items wi ON wi.account_id = ar.account_id AND wi.id = ar.work_item_id
LEFT JOIN LATERAL (
  SELECT
    COALESCE(SUM(l.usd) FILTER (WHERE l.kind = 'model'), 0) AS model_usd,
    COALESCE(SUM(l.usd) FILTER (WHERE l.kind = 'compute'), 0) AS compute_usd
  FROM ledger l
  WHERE l.account_id = ar.account_id AND l.run_id = ar.id
) lg ON true
WHERE ar.runtime IN ('local', 'production');

GRANT SELECT ON v_kpi_runs TO app_user;

-- ---------------------------------------------------------------------
-- 3. Indexes (criterion 5), created if absent -- both views' lateral
--    joins filter ledger/agent_runs on (account_id, run_id) and
--    (account_id, work_item_id) respectively.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ledger_account_run ON ledger (account_id, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_account_work_item ON agent_runs (account_id, work_item_id);
