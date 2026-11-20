-- D#845 ON-BR-2: one-click Connect and Disconnect for the engine bridge.
--
-- What:
--   * engine_commands takes two more kinds, bridge_enable and bridge_disable. They go to a RUNNER (the cloud picks one the account owns that is paired with the repo), not to the
--     engine session of a repo, so nothing here needs a session. bridge_enable may carry one `repo_root`, an absolute folder (at most 1,024 characters, no `..` part, no control or
--     bidirectional character), which the runner still checks against the repo's own remote.
--   * the runner's answer to a bridge_enable (`ack_result`): a closed object, {result, root_tail?, candidates?}. `root_tail` is the last two parts of the folder it chose;
--     `candidates` are at most 10 folders it offers the person to pick from. It is written once, by the runner, in the same update that acks the command.
--   * the refusal list gains the bridge refusals (checkout_not_found, checkout_ambiguous, ...), the same names as `BRIDGE_REFUSALS` in the runner protocol.
--   * engine_runner_bridges: what a runner SAYS it bridges (one row per runner and repo, with the checkout it chose, when it chose one), replaced by each of its command pulls. The
--     Team app's "connected" is derived from it, never stamped by the cloud: a runner that was disabled by hand, or whose checkout is gone, drops the row at its next pull. A row not
--     renewed for 24 hours is read as gone (`BRIDGE_REPORT_FRESH_S` in `packages/db/src/engineBridgeConnect.ts`), so a moved checkout stops being shown once the runner reports again.
--
-- Who writes (RLS, FORCEd; app_user only):
--   engine_runner_bridges: a verified runner session writes only ITS OWN rows (app.runner_id), for repos of its own account; the account's members read the account's rows (the route
--   shows a path only to an owner or admin). Removing a runner or a repo removes its rows (ON DELETE CASCADE).
--
-- Rollback (expand/contract): nothing reads the new column or table until the routes are deployed; a later migration may drop them. The check changes only add values.
--
-- Numbered 1042 by the executor: main's highest was 1041 when this was written. Re-check against main right before merging.

CREATE OR REPLACE FUNCTION engine_command_args_ok(p_kind text, p_args jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  -- COALESCE: a missing key makes a comparison NULL, and a CHECK lets NULL through.
  SELECT COALESCE(jsonb_typeof(p_args) = 'object' AND CASE p_kind
    WHEN 'start_day' THEN p_args = '{}'::jsonb
    WHEN 'pause_loop' THEN p_args = '{}'::jsonb
    WHEN 'resume_loop' THEN p_args = '{}'::jsonb
    WHEN 'answer_ask' THEN
      NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_args) AS k WHERE k NOT IN ('ask_id', 'choice', 'note'))
      AND jsonb_typeof(p_args -> 'ask_id') = 'string' AND (p_args ->> 'ask_id') ~ '^[0-9a-f]{16}$'
      AND jsonb_typeof(p_args -> 'choice') = 'string' AND (p_args ->> 'choice') IN ('approve', 'decline', 'defer')
      AND (NOT p_args ? 'note' OR (jsonb_typeof(p_args -> 'note') = 'string' AND char_length(p_args ->> 'note') BETWEEN 1 AND 500
           AND (p_args ->> 'note') !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]'))
    WHEN 'set_dial' THEN
      NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_args) AS k WHERE k NOT IN ('dial_class', 'level', 'ttl'))
      AND jsonb_typeof(p_args -> 'dial_class') = 'string'
      AND (p_args ->> 'dial_class') IN ('docs.write', 'tests.add', 'deps.bump', 'agent.spawn', 'merge.standard', 'merge.fast-path', 'memory.write', 'archive.move')
      AND jsonb_typeof(p_args -> 'level') = 'number' AND (p_args ->> 'level') ~ '^[1-5]$'
      AND jsonb_typeof(p_args -> 'ttl') = 'string' AND (p_args ->> 'ttl') IN ('for_today', 'none')
    WHEN 'request_spawn' THEN
      NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_args) AS k WHERE k NOT IN ('role', 'discussion'))
      AND jsonb_typeof(p_args -> 'role') = 'string'
      AND (p_args ->> 'role') IN ('executor', 'code-reviewer', 'security-reviewer', 'acceptance-tester', 'browser-tester', 'project-manager',
                                  'technical-architect', 'product-owner', 'cost-analyst', 'performance-expert', 'security-expert')
      AND jsonb_typeof(p_args -> 'discussion') = 'number' AND (p_args ->> 'discussion') ~ '^[1-9][0-9]{0,9}$'
      AND (p_args ->> 'discussion')::bigint <= 2147483647
    WHEN 'stop_agent' THEN
      NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_args) AS k WHERE k <> 'agent_id')
      AND jsonb_typeof(p_args -> 'agent_id') = 'string' AND (p_args ->> 'agent_id') ~ '^[A-Za-z0-9_-]{1,64}$'
    WHEN 'bridge_disable' THEN p_args = '{}'::jsonb
    WHEN 'bridge_enable' THEN
      NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_args) AS k WHERE k <> 'repo_root')
      AND (NOT p_args ? 'repo_root' OR (
        jsonb_typeof(p_args -> 'repo_root') = 'string' AND char_length(p_args ->> 'repo_root') BETWEEN 2 AND 1024
        AND (p_args ->> 'repo_root') LIKE '/%'
        AND (p_args ->> 'repo_root') !~ '(^|/)\.\.(/|$)'
        AND (p_args ->> 'repo_root') !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]'))
    ELSE false
  END, false);
$$;
REVOKE ALL ON FUNCTION engine_command_args_ok(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION engine_command_args_ok(text, jsonb) TO app_user;

ALTER TABLE engine_commands DROP CONSTRAINT engine_commands_kind_check;
ALTER TABLE engine_commands ADD CONSTRAINT engine_commands_kind_check
  CHECK (kind IN ('start_day', 'pause_loop', 'resume_loop', 'answer_ask', 'set_dial', 'request_spawn', 'stop_agent', 'bridge_enable', 'bridge_disable'));

ALTER TABLE engine_commands DROP CONSTRAINT engine_commands_refusal_check;
ALTER TABLE engine_commands ADD CONSTRAINT engine_commands_refusal_check
  CHECK (refusal IS NULL OR refusal IN ('signature_invalid', 'wrong_runner', 'wrong_repo', 'expired', 'seq_not_increasing', 'halted', 'operate_off',
                                        'host_not_running', 'unknown_ask', 'unknown_agent', 'ceiling', 'already_answered',
                                        'checkout_not_found', 'checkout_ambiguous', 'checkout_layout_unexpected', 'checkout_incomplete', 'checkout_unsafe', 'checkout_mismatch', 'repo_root_invalid',
                                        'repo_not_paired', 'engine_version_unusable', 'state_dir_missing', 'state_dir_unreadable', 'state_dir_shared', 'state_dir_reserved',
                                        'state_dir_unchecked', 'too_many_repos', 'settings_damaged', 'bridge_failed'));

ALTER TABLE engine_commands ADD COLUMN ack_result jsonb;
-- Only a bridge_enable that was answered carries one, and only the closed keys; the guard trigger lets the runner set it in the one update that acks the command.
CREATE FUNCTION engine_ack_result_ok(p_kind text, p_state text, p_result jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_result IS NULL OR COALESCE(
    p_kind = 'bridge_enable' AND p_state IN ('applied', 'refused')
    AND jsonb_typeof(p_result) = 'object'
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_result) AS k WHERE k NOT IN ('result', 'root_tail', 'candidates', 'skipped'))
    AND jsonb_typeof(p_result -> 'result') = 'string' AND (p_result ->> 'result') IN ('connected', 'not_found', 'ambiguous', 'refused', 'already_connected')
    AND (NOT p_result ? 'root_tail' OR (jsonb_typeof(p_result -> 'root_tail') = 'string' AND char_length(p_result ->> 'root_tail') BETWEEN 1 AND 512))
    AND (NOT p_result ? 'candidates' OR (jsonb_typeof(p_result -> 'candidates') = 'array' AND jsonb_array_length(p_result -> 'candidates') BETWEEN 1 AND 10))
    AND (NOT p_result ? 'skipped' OR (jsonb_typeof(p_result -> 'skipped') = 'array' AND jsonb_array_length(p_result -> 'skipped') BETWEEN 1 AND 10 AND (p_result ->> 'result') = 'not_found'))
    AND pg_column_size(p_result) <= 16384,
    false);
$$;
REVOKE ALL ON FUNCTION engine_ack_result_ok(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION engine_ack_result_ok(text, text, jsonb) TO app_user;
ALTER TABLE engine_commands ADD CONSTRAINT engine_commands_ack_result_closed CHECK (engine_ack_result_ok(kind, state, ack_result));
GRANT UPDATE (ack_result) ON engine_commands TO app_user;
CREATE INDEX engine_commands_bridge_idx ON engine_commands (account_id, repo_id, issued_at DESC) WHERE kind IN ('bridge_enable', 'bridge_disable');
CREATE INDEX engine_commands_bridge_account_idx ON engine_commands (account_id, issued_at DESC) WHERE kind IN ('bridge_enable', 'bridge_disable');

CREATE TABLE engine_runner_bridges (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  runner_id   uuid NOT NULL,
  repo_id     uuid NOT NULL,
  -- The checkout the runner chose, as an absolute path; null when the runner reported the repo without one.
  root        text CHECK (root IS NULL OR (char_length(root) BETWEEN 2 AND 1024 AND root LIKE '/%' AND root !~ '(^|/)\.\.(/|$)' AND root !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]')),
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (runner_id, repo_id),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);
CREATE INDEX engine_runner_bridges_repo_idx ON engine_runner_bridges (account_id, repo_id);

ALTER TABLE engine_runner_bridges ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_runner_bridges FORCE ROW LEVEL SECURITY;
REVOKE ALL ON engine_runner_bridges FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON engine_runner_bridges TO app_user;
GRANT UPDATE (root, reported_at) ON engine_runner_bridges TO app_user;

-- A person reads the account's rows; a runner session reads only its own runner's (the same rule engine_commands has).
CREATE POLICY tenant_isolation_select ON engine_runner_bridges FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (NULLIF(current_setting('app.runner_id', true), '') IS NULL OR runner_id::text = lower(current_setting('app.runner_id', true)))
  );
-- Only the verified runner session itself (app.runner_id is set by the runner middleware alone) writes, and only its own rows in its own account.
CREATE POLICY runner_own_insert ON engine_runner_bridges FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND runner_id::text = lower(COALESCE(current_setting('app.runner_id', true), ''))
    AND EXISTS (SELECT 1 FROM runners r WHERE r.id = engine_runner_bridges.runner_id AND r.account_id = engine_runner_bridges.account_id AND r.revoked_at IS NULL)
  );
CREATE POLICY runner_own_update ON engine_runner_bridges FOR UPDATE TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND runner_id::text = lower(COALESCE(current_setting('app.runner_id', true), '')))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND runner_id::text = lower(COALESCE(current_setting('app.runner_id', true), '')));
CREATE POLICY runner_own_delete ON engine_runner_bridges FOR DELETE TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND runner_id::text = lower(COALESCE(current_setting('app.runner_id', true), '')));
