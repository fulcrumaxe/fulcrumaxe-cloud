-- D#749: the post-merge check answers only the acceptance criteria a person can see in the browser.
--
-- A Spec's criteria mix code-level ones (a helper's return value, a column, a status code) with user-visible ones. A browser tester can only mark the first
-- kind `blocked`, so a correct change could never be verified. The stage now sorts the criteria by a deterministic rule before the row opens (core's
-- verify/criteria.ts): only the visible ones become journeys; the rest are left to the check, the reviewers and the acceptance tester.
--
-- Two additions, expand only:
--   1. verify_rows.checks_only  the numbers (1-based, as in the Spec) of the criteria left to the checks. Written once, when the row opens, with the journeys; app_user has
--      INSERT on it and no UPDATE grant, so it cannot change afterwards. Rows opened before this migration keep the empty list (all their criteria were journeys).
--   2. a reason for a row whose Spec has no visible criterion and whose repository keeps no standing journey: `unverified: no_visible_journeys`. The streak rule treats it
--      as neutral (it neither counts nor resets). The check keeps 1007's list and gains the one word; every existing row already holds a word the new list accepts.
ALTER TABLE verify_rows ADD COLUMN checks_only jsonb NOT NULL DEFAULT '[]'
  CONSTRAINT verify_rows_checks_only_check CHECK (jsonb_typeof(checks_only) = 'array' AND jsonb_array_length(checks_only) <= 30 AND octet_length(checks_only::text) <= 512);
GRANT INSERT (checks_only) ON verify_rows TO app_user;

ALTER TABLE verify_rows DROP CONSTRAINT verify_rows_reason_check;
ALTER TABLE verify_rows ADD CONSTRAINT verify_rows_reason_check CHECK (reason_code IN (
  'no_browser', 'chrome_not_connected', 'wrong_account', 'sign_in_refused', 'deploy_failed', 'deployment_unreachable',
  'commit_not_deployed', 'envelope_rejected', 'hollow_pass', 'journey_blocked', 'journeys_missing', 'run_failed', 'verify_disabled', 'account_unverifiable',
  'no_visible_journeys'));
