-- v_kpi_work_items: a person's "request changes" is not a review verdict.
--
-- The operator action "request changes" records a changes_requested
-- transition whose reviewer is the placeholder `acceptance` (the table
-- requires one) and whose source_ref is `request_changes:<correction id>`.
-- Left alone, the view counted it as a reviewer's verdict: it lowered
-- first-pass yield, could become first_verdict_stage, and skewed
-- time-to-first-verdict -- the very numbers the shadow/switchover
-- comparison reads.
--
-- This redefinition (same columns in the same order, one appended):
--   * t_first_verdict / first_verdict_stage ignore person-initiated
--     transitions;
--   * n_changes_requested counts reviewer verdicts only;
--   * n_person_change_requests (new, last column) counts the person's
--     requests, so nothing is lost.
-- A person round still counts toward the fix-round bound (a safety limit):
-- consumers that enforce the bound add the two columns.
--
-- CREATE OR REPLACE keeps the grant to app_user and the view's
-- security_invoker setting is restated.
CREATE OR REPLACE VIEW v_kpi_work_items WITH (security_invoker = true) AS
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
  COALESCE(rn.tokens, 0) AS tokens,
  COALESCE(stg.n_person_change_requests, 0) AS n_person_change_requests
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
    COUNT(*) FILTER (WHERE wit.to_stage = 'changes_requested'
                       AND wit.source_ref NOT LIKE 'request\_changes:%') AS n_changes_requested,
    COUNT(*) FILTER (WHERE wit.to_stage = 'changes_requested'
                       AND wit.source_ref LIKE 'request\_changes:%') AS n_person_change_requests,
    COUNT(*) FILTER (WHERE wit.to_stage = 'needs_human') AS n_needs_human
  FROM work_item_transitions wit
  WHERE wit.account_id = wi.account_id AND wit.work_item_id = wi.id
) stg ON true
LEFT JOIN LATERAL (
  SELECT wit.to_stage AS first_verdict_stage, wit.at AS t_first_verdict
  FROM work_item_transitions wit
  WHERE wit.account_id = wi.account_id AND wit.work_item_id = wi.id
    AND wit.to_stage IN ('changes_requested', 'review_passed')
    AND wit.source_ref NOT LIKE 'request\_changes:%'
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
