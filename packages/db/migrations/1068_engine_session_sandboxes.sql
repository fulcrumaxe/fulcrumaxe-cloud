-- D#845 ON-13a2: the account's engine sessions as one read, `engine_session_sandboxes`.
--
--   1. machine_jobs.stop_reason: the reason a session stop was signed with (person, halt, move, remove, operate_off, plan), read out of the signed bytes by a generated column, so it can never differ from what the
--      runner was told. It is NULL for every other kind. app_user reads it; it still reads nothing of `job` itself. No CHECK on the value: the signer's closed list owns it, and a reason added there
--      (park, MC-6a1) must not need a migration to be issued.
--   2. engine_session_sandboxes (a view, invoker rights, so row security of every table under it applies to the reader): one row per engine session sandbox the runner's inventory lists (a sandbox named
--      fx-engine-<repo_gh_id>), with the repo, the machine, its tier, the state the runner reported (snapshotted reads as stopped), when it last changed, why it was last stopped, and how the newest start came up.
--      Everything is derived on each read from the inventory and the job rows; nothing is stamped. `deleted` is the absence of a row, and `halted` is not known to the inventory (ON-13b2 reports it), so neither is produced here.
--        last_start_mode, last_start_at   the newest `done` engine_session_start of the repo (created, resumed or fresh, and when it ended)
--        stopped_reason                   the reason of the newest `done` engine_session_stop of the repo that ended after that start, only while the sandbox is stopped
--      Every table in it is joined on the account as well as the id, and a reader adds its own account predicate on top of row security.
--
-- Numbered 1068 by the Team Lead; it merges after 1066. Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE machine_jobs
  ADD COLUMN stop_reason text GENERATED ALWAYS AS (CASE WHEN kind = 'engine_session_stop' THEN job #>> '{job,args,reason}' END) STORED;
GRANT SELECT (stop_reason) ON machine_jobs TO app_user;

CREATE VIEW engine_session_sandboxes WITH (security_invoker = true) AS
SELECT r.account_id,
       r.id AS repo_id,
       s.runner_id,
       s.name AS sandbox_name,
       CASE f.sandbox_engine WHEN 'microvm' THEN 'microvm' WHEN 'os_sandbox' THEN 'standard' END AS tier,
       CASE s.state WHEN 'snapshotted' THEN 'stopped' ELSE s.state END AS state,
       COALESCE(s.last_used_at, s.created_at) AS state_at,
       CASE WHEN s.state IN ('stopped', 'snapshotted') THEN stp.stop_reason END AS stopped_reason,
       s.snapshot_count,
       s.disk_bytes,
       srt.start_mode AS last_start_mode,
       srt.ended_at AS last_start_at
  FROM runner_sandboxes s
       JOIN repos r ON r.account_id = s.account_id AND s.name = 'fx-engine-' || r.gh_repo_id::text
       LEFT JOIN runner_facts f ON f.account_id = s.account_id AND f.runner_id = s.runner_id
       LEFT JOIN LATERAL (
         SELECT j.start_mode, j.ended_at FROM machine_jobs j
          WHERE j.account_id = r.account_id AND j.repo_id = r.id AND j.kind = 'engine_session_start' AND j.state = 'done'
          ORDER BY j.ended_at DESC, j.id DESC LIMIT 1
       ) srt ON true
       LEFT JOIN LATERAL (
         SELECT j.stop_reason FROM machine_jobs j
          WHERE j.account_id = r.account_id AND j.repo_id = r.id AND j.kind = 'engine_session_stop' AND j.state = 'done'
            AND (srt.ended_at IS NULL OR j.ended_at > srt.ended_at)
          ORDER BY j.ended_at DESC, j.id DESC LIMIT 1
       ) stp ON true;

REVOKE ALL ON engine_session_sandboxes FROM PUBLIC;
GRANT SELECT ON engine_session_sandboxes TO app_user;

-- ---- audit action for a session delete (ON-13a2 fix round) -------------------------------------------------------------------------------------------
-- A start and a stop write an audit row; a delete (the sandbox and its snapshots go) did not. audit_write is replaced whole from 1035, the newest definition, adding one action,
-- `engine_session.deleted` (payload: ids only, the repo and the job). CREATE OR REPLACE keeps the owner and the grants. A later migration that replaces audit_write must re-carry the list.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION audit_write(p_action text, p_payload jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct            uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  who             uuid := current_member_user_id();
  ts              timestamptz := clock_timestamp();
  stamped_payload jsonb := p_payload;
  new_id          uuid;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'audit_write: no app.account_id set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF who IS NULL THEN
    RAISE EXCEPTION 'audit_write: caller is not a verified member of account %', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'audit_write: account % is not active', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The 1026 allowlist carried forward whole, plus the machine and onboarding actions. NULL fails
  -- closed explicitly (note (b) above) instead of relying on
  -- `NOT (p_action = ANY(...))` evaluating to NULL (falsy for IF) on a
  -- NULL p_action.
  IF p_action IS NULL OR NOT (p_action = ANY (ARRAY[
    'decision_dial_changed',
    'model_connection.connect',
    'model_connection.replace',
    'model_connection.remove',
    'role_settings.mode_changed',
    'role_settings.guard_changed',
    'role_settings.model_changed',
    'run_limits.changed',
    'decision_ask_setting.changed',
    'ask_route.changed',
    'discovery_setting.changed',
    'build_concurrency.changed',
    'envelope.changed',
    'autostart_envelope.changed',
    'envelope_margin.changed',
    'context_rule.saved',
    'context_rule.replaced',
    'context_rule.removed',
    'vercel_connection.connect',
    'vercel_connection.rotate',
    'vercel_connection.remove',
    'plan_writeback_setting.changed',
    'context_budget.changed',
    'verify_settings.changed',
    'engine_bridge.settings_changed',
    'engine_bridge.data_deleted',
    'engine_command.issued',
    'engine_command.acked',
    'engine_command.cancelled',
    'engine_decision.recorded',
    'engine_decision.answered',
    'engine_halt.set',
    'engine_halt.cleared',
    'onboarding.track_chosen',
    'runner.device_approved',
    'runner.device_denied',
    'project.setup_started',
    'project.plan_approved',
    'project.install_merged',
    'project.moved',
    'project.removed',
    'engine_session.started',
    'engine_session.stopped',
    'engine_session.deleted',
    'machine_credential.added',
    'machine_credential.removed',
    'server.create_confirmed',
    'server.deleted',
    'server.orphan_kept',
    'server.unsealed',
    'machine.login_started',
    'machine.linked_notified'
  ])) THEN
    RAISE EXCEPTION 'audit_write: action % is not on the allowlist', p_action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Note (c) above: bounds a single payload's serialized size, and
  -- (D#97 fix round 1) fails closed on any TOAST-compressed argument
  -- regardless of its compressed size.
  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Decision (c)/note (a): a caller-supplied `actor`, `account_id` or
  -- `created_at` key inside the payload is overwritten with the stamped
  -- value, never trusted. Every other key (including nested ones) is
  -- stored exactly as sent.
  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(who::text));
  END IF;
  IF stamped_payload ? 'account_id' THEN
    stamped_payload := stamped_payload || jsonb_build_object('account_id', to_jsonb(acct::text));
  END IF;
  IF stamped_payload ? 'created_at' THEN
    stamped_payload := stamped_payload || jsonb_build_object('created_at', to_jsonb(ts));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, who::text, p_action, stamped_payload, ts)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- CREATE OR REPLACE preserves the owner and grants on an unchanged signature; re-run because they are idempotent (0651's pattern).
REVOKE ALL ON FUNCTION audit_write(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO context_rules_definer;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO repo_context_settings_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
