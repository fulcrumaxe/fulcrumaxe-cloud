-- D#6 V1: the data and the rules of the post-merge verify stage. Nothing calls it yet except tests.
--
-- A repository can turn on a verification of what its merged pull requests did to the running staging app: after a merge, the deployed
-- commit is checked against the repository's journeys in a real browser, and the outcome is kept as a row that a person can read.
-- This migration adds only the storage, with the rules that can be held by the database itself. The sweep, the runner and the screens come in later changes.
--
--   verify_settings  one row per repository: whether the stage is on (it is OFF when no row exists, and off by default when one does), the base URL of the
--                    deployed app, the standing journeys, the eligibility rule and the batch columns. Writes need an owner or admin of the account (the policy
--                    joins account_members on the session's user), so turning the stage off, the undo path, is the same gate as turning it on.
--   verify_batches   a group of rows deployed and checked together. Only closure by size one is built: a batch is opened and closed by the row that opens it.
--   verify_rows      one row per merged pull request that was checked: its journeys (written before the run, never changed), its status, the method that
--                    drove the browser, the commit the app was running, the per-journey result, a closed reason code when it could not be verified,
--                    the bug item a failed journey filed, and the two facts the streak rule reads (deploy_by_order, person_step).
--
-- The row's status moves one way: pending -> deploying -> running -> verified | failed | unverified, and pending / deploying may end unverified. A row is
-- born pending: app_user may insert only the identity columns and the journeys (a column grant), so every outcome column starts at its default, and the
-- trigger verify_rows_guard then refuses, whoever writes:
--   - any other move, any change to the identity columns or the journeys;
--   - deploy_by_order changing after the pending -> deploying move (who gave the deploy order is fixed when the deploy starts);
--   - method, deployed_commit, started_at and run_id changing except on the deploying -> running move (a running row cannot be rewritten);
--   - result, reason_code and finished_at changing except on the move to a finished state;
--   - person_step going from true to false, at any status (it is a fact, like the others: it only goes up);
--   - bug_item_id being set on a row that did not fail, set twice, or cleared by a statement (only the foreign key's action clears it, when the item is deleted);
--   - any change to a finished row beyond the two allowed above (person_step up, the bug item once).
-- CHECK constraints keep every state honest: a running row names its method, the commit it ran against and its start; a verified row also names its
-- result (at least one journey) and no reason; an unverified row names a closed reason; a row that is not finished names none.
-- verify_batches is forward-only too: a closed batch cannot change.
--
-- All three tables are tenant tables: RLS is enabled and forced, the policy is the account's own, and app_user is the only role with a grant. No SECURITY DEFINER
-- function is added. Rows are never deleted by a login (no DELETE grant); they go with the repository or the work item.
--
-- driver_event: work_item_driver_events gains the four verify_* kinds (the kind check is restated whole, as in 0938). Expand-only.
--
-- Numbered above the highest migration on the code plane; re-checked against main right before opening.

CREATE TABLE verify_settings (
  repo_id               uuid PRIMARY KEY,
  account_id            uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  enabled               boolean NOT NULL DEFAULT false,
  -- The origin of the deployed app, https only, lower-case host, no path, no credentials.
  base_url              text NULL CONSTRAINT verify_settings_base_url_check CHECK (base_url ~ '^https://[a-z0-9.-]{1,253}(:[0-9]{1,5})?$'),
  deploy_mode           text NOT NULL DEFAULT 'runner_command' CONSTRAINT verify_settings_deploy_mode_check CHECK (deploy_mode IN ('runner_command')),
  -- [{"id": "sign_in", "text": "..."}]: validated by the application; the database holds the shape and the size.
  standing_journeys     jsonb NOT NULL DEFAULT '[]'
                          CONSTRAINT verify_settings_standing_check CHECK (jsonb_typeof(standing_journeys) = 'array' AND jsonb_array_length(standing_journeys) <= 20 AND octet_length(standing_journeys::text) <= 16384),
  test_account_label    text NULL CONSTRAINT verify_settings_test_account_check CHECK (length(test_account_label) BETWEEN 1 AND 100),
  -- 'all': every merge is checked. 'ui_paths': only a merge that changed a file under one of eligibility_paths.
  eligibility           text NOT NULL DEFAULT 'ui_paths' CONSTRAINT verify_settings_eligibility_check CHECK (eligibility IN ('all', 'ui_paths')),
  eligibility_paths     text[] NOT NULL DEFAULT '{}'
                          CONSTRAINT verify_settings_paths_check CHECK (
                            cardinality(eligibility_paths) <= 20
                            AND (cardinality(eligibility_paths) = 0 OR (
                              array_to_string(eligibility_paths, E'\n') ~ '^[A-Za-z0-9._/-]{1,200}(\n[A-Za-z0-9._/-]{1,200})*$'
                              AND array_to_string(eligibility_paths, E'\n') !~ '\.\.'
                              AND array_to_string(eligibility_paths, E'\n') !~ '(^|\n)/'))),
  batch_size            integer NOT NULL DEFAULT 1 CONSTRAINT verify_settings_batch_size_check CHECK (batch_size BETWEEN 1 AND 50),
  batch_window_minutes  integer NULL CONSTRAINT verify_settings_batch_window_check CHECK (batch_window_minutes BETWEEN 1 AND 1440),
  updated_by            uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- A repository without an address to check cannot be switched on.
  CONSTRAINT verify_settings_enabled_needs_url CHECK (NOT enabled OR base_url IS NOT NULL),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);

CREATE TABLE verify_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id     uuid NOT NULL,
  status      text NOT NULL DEFAULT 'open' CONSTRAINT verify_batches_status_check CHECK (status IN ('open', 'closed')),
  closed_by   text NULL CONSTRAINT verify_batches_closed_by_check CHECK (closed_by IN ('size', 'window')),
  opened_at   timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz NULL,
  UNIQUE (account_id, id),
  CONSTRAINT verify_batches_closed_together CHECK ((status = 'open') = (closed_at IS NULL AND closed_by IS NULL)),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);

CREATE TABLE verify_rows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id          uuid NOT NULL,
  batch_id         uuid NOT NULL,
  work_item_id     uuid NOT NULL,
  pr_number        integer NOT NULL CONSTRAINT verify_rows_pr_check CHECK (pr_number > 0),
  merge_sha        text NOT NULL CONSTRAINT verify_rows_merge_sha_check CHECK (merge_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  status           text NOT NULL DEFAULT 'pending'
                     CONSTRAINT verify_rows_status_check CHECK (status IN ('pending', 'deploying', 'running', 'verified', 'failed', 'unverified')),
  method           text NULL CONSTRAINT verify_rows_method_check CHECK (method IN ('chrome_runner', 'playwright_runner', 'playwright_sandbox')),
  deployed_commit  text NULL CONSTRAINT verify_rows_deployed_check CHECK (deployed_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  journeys         jsonb NOT NULL
                     CONSTRAINT verify_rows_journeys_check CHECK (jsonb_typeof(journeys) = 'array' AND jsonb_array_length(journeys) <= 60 AND octet_length(journeys::text) <= 65536),
  result           jsonb NULL
                     CONSTRAINT verify_rows_result_check CHECK (result IS NULL OR (jsonb_typeof(result) = 'array' AND jsonb_array_length(result) <= 60 AND octet_length(result::text) <= 262144)),
  reason_code      text NULL CONSTRAINT verify_rows_reason_check CHECK (reason_code IN (
                     'no_browser', 'chrome_not_connected', 'wrong_account', 'sign_in_refused', 'deploy_failed', 'deployment_unreachable',
                     'commit_not_deployed', 'envelope_rejected', 'hollow_pass', 'journey_blocked', 'journeys_missing', 'run_failed', 'verify_disabled')),
  bug_item_id      uuid NULL,
  run_id           uuid NULL,
  deploy_by_order  boolean NOT NULL DEFAULT false,
  person_step      boolean NOT NULL DEFAULT false,
  started_at       timestamptz NULL,
  finished_at      timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  -- One row per merge of an item: a replayed hand-off finds the row it made.
  CONSTRAINT verify_rows_one_per_merge UNIQUE (account_id, work_item_id, merge_sha),
  CONSTRAINT verify_rows_running_shape CHECK (status <> 'running' OR (method IS NOT NULL AND deployed_commit IS NOT NULL AND started_at IS NOT NULL)),
  CONSTRAINT verify_rows_verified_shape CHECK (status <> 'verified' OR (method IS NOT NULL AND deployed_commit IS NOT NULL AND result IS NOT NULL AND reason_code IS NULL AND jsonb_array_length(journeys) > 0)),
  CONSTRAINT verify_rows_failed_shape CHECK (status <> 'failed' OR (method IS NOT NULL AND deployed_commit IS NOT NULL AND result IS NOT NULL AND reason_code IS NULL)),
  CONSTRAINT verify_rows_unverified_shape CHECK ((status = 'unverified') = (reason_code IS NOT NULL)),
  CONSTRAINT verify_rows_finished_shape CHECK ((status IN ('verified', 'failed', 'unverified')) = (finished_at IS NOT NULL)),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, batch_id) REFERENCES verify_batches (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, bug_item_id) REFERENCES work_items (account_id, id) ON DELETE SET NULL (bug_item_id),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (run_id)
);
CREATE INDEX idx_verify_rows_repo ON verify_rows (account_id, repo_id, created_at DESC, id);
CREATE INDEX idx_verify_rows_batch ON verify_rows (account_id, batch_id);
CREATE INDEX idx_verify_batches_repo ON verify_batches (account_id, repo_id, opened_at DESC);

-- The only moves a row may make, and the only columns each move may change. Not SECURITY DEFINER: it reads nothing but the two rows it is given.
CREATE FUNCTION verify_rows_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.repo_id IS DISTINCT FROM OLD.repo_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
     OR NEW.merge_sha IS DISTINCT FROM OLD.merge_sha OR NEW.journeys IS DISTINCT FROM OLD.journeys OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'verify_rows: identity and journeys are fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('verified', 'failed', 'unverified') THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.method IS DISTINCT FROM OLD.method OR NEW.deployed_commit IS DISTINCT FROM OLD.deployed_commit
       OR NEW.result IS DISTINCT FROM OLD.result OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
       OR NEW.deploy_by_order IS DISTINCT FROM OLD.deploy_by_order OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
      RAISE EXCEPTION 'verify_rows: a finished row does not change' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('pending', 'deploying', 'unverified'))
         OR (OLD.status = 'deploying' AND NEW.status IN ('deploying', 'running', 'unverified'))
         OR (OLD.status = 'running' AND NEW.status IN ('running', 'verified', 'failed', 'unverified'))) THEN
      RAISE EXCEPTION 'verify_rows: % -> % is not a move', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status NOT IN ('verified', 'failed', 'unverified')
       AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.reason_code IS DISTINCT FROM OLD.reason_code OR NEW.finished_at IS DISTINCT FROM OLD.finished_at) THEN
      RAISE EXCEPTION 'verify_rows: the verdict is written only by the move that finishes the row' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Who gave the deploy order is fixed when the deploy starts.
  IF NEW.deploy_by_order IS DISTINCT FROM OLD.deploy_by_order AND NOT (OLD.status = 'pending' AND NEW.status = 'deploying') THEN
    RAISE EXCEPTION 'verify_rows: deploy_by_order is set only when the deploy starts' USING ERRCODE = 'check_violation';
  END IF;
  -- What drove the run, against which commit, and since when, is fixed when the run starts. A run id may only be cleared afterwards (by the foreign key).
  IF NOT (OLD.status = 'deploying' AND NEW.status = 'running')
     AND (NEW.method IS DISTINCT FROM OLD.method OR NEW.deployed_commit IS DISTINCT FROM OLD.deployed_commit OR NEW.started_at IS DISTINCT FROM OLD.started_at
          OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'verify_rows: method, deployed commit, start and run are set only when the run starts' USING ERRCODE = 'check_violation';
  END IF;
  -- A person step is a fact: it only goes up.
  IF OLD.person_step AND NOT NEW.person_step THEN
    RAISE EXCEPTION 'verify_rows: a person step is not taken back' USING ERRCODE = 'check_violation';
  END IF;
  -- The bug item: set once, on a failed row; cleared only by the foreign key's own action (a nested trigger), never by a statement.
  IF NEW.bug_item_id IS DISTINCT FROM OLD.bug_item_id THEN
    IF NEW.bug_item_id IS NULL THEN
      IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'verify_rows: the bug item is not cleared' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD.status <> 'failed' OR OLD.bug_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'verify_rows: the bug item is set once, on a failed row' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER verify_rows_guard BEFORE UPDATE ON verify_rows FOR EACH ROW EXECUTE FUNCTION verify_rows_guard();

-- A closed batch is closed for good.
CREATE FUNCTION verify_batches_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'closed' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.closed_by IS DISTINCT FROM OLD.closed_by OR NEW.closed_at IS DISTINCT FROM OLD.closed_at) THEN
    RAISE EXCEPTION 'verify_batches: a closed batch does not change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER verify_batches_guard BEFORE UPDATE ON verify_batches FOR EACH ROW EXECUTE FUNCTION verify_batches_guard();

ALTER TABLE verify_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE verify_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE verify_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE verify_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE verify_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE verify_rows FORCE ROW LEVEL SECURITY;

-- Anyone in the account's context reads the settings; only an owner or admin of the account writes them.
CREATE POLICY tenant_select ON verify_settings FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY admin_insert ON verify_settings FOR INSERT TO app_user
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
              AND EXISTS (SELECT 1 FROM account_members m
                           WHERE m.account_id = verify_settings.account_id AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND m.role IN ('owner', 'admin')));
CREATE POLICY admin_update ON verify_settings FOR UPDATE TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
         AND EXISTS (SELECT 1 FROM account_members m
                      WHERE m.account_id = verify_settings.account_id AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND m.role IN ('owner', 'admin')))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
              AND EXISTS (SELECT 1 FROM account_members m
                           WHERE m.account_id = verify_settings.account_id AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND m.role IN ('owner', 'admin')));

CREATE POLICY tenant_isolation ON verify_batches TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY tenant_isolation ON verify_rows TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

REVOKE ALL ON verify_settings, verify_batches, verify_rows FROM PUBLIC;
GRANT SELECT, INSERT ON verify_settings TO app_user;
GRANT UPDATE (enabled, base_url, deploy_mode, standing_journeys, test_account_label, eligibility, eligibility_paths, batch_size, batch_window_minutes, updated_by, updated_at)
  ON verify_settings TO app_user;
-- A batch is born open and a row is born pending: only the identity columns (and the row's journeys) can be inserted; everything else takes its default.
GRANT SELECT ON verify_batches TO app_user;
GRANT INSERT (account_id, repo_id) ON verify_batches TO app_user;
GRANT UPDATE (status, closed_by, closed_at) ON verify_batches TO app_user;
GRANT SELECT ON verify_rows TO app_user;
GRANT INSERT (account_id, repo_id, batch_id, work_item_id, pr_number, merge_sha, journeys) ON verify_rows TO app_user;
GRANT UPDATE (status, method, deployed_commit, result, reason_code, bug_item_id, run_id, deploy_by_order, person_step, started_at, finished_at) ON verify_rows TO app_user;

-- work_item_driver_events: the four verify kinds, the whole list restated as 0938 did.
ALTER TABLE work_item_driver_events DROP CONSTRAINT work_item_driver_events_kind_check;
ALTER TABLE work_item_driver_events
  ADD CONSTRAINT work_item_driver_events_kind_check CHECK (kind IN (
    'build_refused', 'build_waiting', 'stage_waiting', 'review_started', 'security_review_required', 'review_verdicts',
    'fix_round_started', 'fix_round_refused', 'fix_pushed_nothing', 'fix_round_failed', 'escalated',
    'review_status', 'merge_gate', 'merged_by_gate', 'stopped', 'pr_head_pushed', 'platform_check', 'correction_applied', 'resume_refused',
    'head_refresh', 'main_guard', 'merge_enqueued', 'merge_dequeued', 'merged_via_queue',
    'verify_started', 'verify_passed', 'verify_failed', 'verify_unverified'
  ));
