-- D#845 watch mode, the cloud half: the `watch` command, the slim status, and the detail session.
--
-- What:
--   * engine_commands takes one more kind, `watch`: `{until, before?}`. `until` is a UTC time and `before` a detail seq; whether `until` is ahead of the issue time and within
--     600 s of it is the protocol's check (the signed command schema) and the route's, whether `before` is a seq the repo has reached is `watchBeforeWithinHighWater`'s. This migration
--     re-carries 1042's engine_command_args_ok whole (the two bridge kinds included) and adds the one case.
--   * `slim_status` is a known engine event kind: `{sources: {bridge, host, engine}, reason: 'unwatched'}`, each source the age in whole seconds (0 to 86400) or null for "never seen". The
--     runner sends it in place of the three heartbeats while nobody watches the repo, in its bridge session. It counts as a heartbeat (`last_heartbeat_at`), and maps to the `status` panel.
--     engine_value_ok gains the `slim_sources` tag, engine_kind_spec the kind, engine_kind_panels the row.
--   * a DETAIL session: the events a runner keeps on its machine until someone watches (the on-demand kinds, and the engine's and host's heartbeats while a watch lasts) arrive in a session of
--     their own, with their own instance id and their own seq. The runner marks one by making its instance id a version-8 UUID; the engine's own ids are random (version 4), so nothing is
--     guessed from the kinds. A detail session takes those kinds only. It is kept apart from the engine's session on purpose: the engine session's strict seq order is unchanged, and a reader's
--     "load older" can send lower seqs into the detail session (the batch must still increase, a seq already stored is dropped, and no gap is recorded there: what a catch-up left on the machine
--     is not missing). `engine_sessions.session_kind` gains `detail`.
--   * a hole in an ENGINE session of a runner that holds its on-demand events back (protocol 23 or above) is expected: those events are in the detail session. It is still recorded in
--     engine_session_gaps, flagged `held`, and the readers leave held holes out of "missing events" and of the gap list (a hole in a bridge session, or of an older runner, is shown as before).
--   * `watch_mode_v1` is a hello capability (the runner declares it, as it declares `wake_v1`): the closed list and runner_capabilities_record widen by it (1041's, re-carried whole). The cloud tells a runner it
--     takes watch mode only when the runner declared this.
--   * engine_events_ingest is re-carried whole (1039's) with these changes and nothing else; its REVOKE, OWNER and GRANT are 1039's.
--
-- Rollback (expand/contract): nothing writes a watch command or a slim status until the routes and the runner that send them are deployed; a later migration may drop them. The checks only add
-- values. A `held` column left behind reads as "never held" (false) for every older row.
--
-- Numbered 1043 by the executor: main's highest was 1041 and #1112 holds 1042 when this was written. Re-check against main right before merging.

ALTER TABLE engine_sessions DROP CONSTRAINT engine_sessions_session_kind_check;
ALTER TABLE engine_sessions ADD CONSTRAINT engine_sessions_session_kind_check CHECK (session_kind IN ('engine', 'bridge', 'detail'));
ALTER TABLE engine_session_gaps ADD COLUMN held boolean NOT NULL DEFAULT false;
-- The ingest reads the runner's hello protocol (to flag held holes): one more column of the definer's own SELECT on runners.
GRANT SELECT (protocol_version) ON runners TO engine_bridge_definer;

-- CREATE OR REPLACE on a function owned by engine_bridge_definer needs membership of that role for a non-superuser migrator (1027's bracket, as 1039 took it): taken here, dropped at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'engine_bridge_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_bridge_definer; cannot replace engine_events_ingest';
    END IF;
    GRANT engine_bridge_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

-- ---- the closed shape: one new kind ----------------------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION engine_value_ok(p_v jsonb, p_tag text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  t text := jsonb_typeof(p_v);
  s text;
  r jsonb;
BEGIN
  IF t IS NULL THEN RETURN false; END IF;
  IF p_tag = 'slim_sources' THEN
    -- The slim status's three sources: exactly bridge, host and engine, each the age in whole seconds (0 to 86400) or null for "never seen".
    RETURN t = 'object' AND (SELECT count(*) FROM jsonb_object_keys(p_v)) = 3 AND p_v ? 'bridge' AND p_v ? 'host' AND p_v ? 'engine'
      AND NOT EXISTS (SELECT 1 FROM jsonb_each(p_v) e WHERE NOT (jsonb_typeof(e.value) = 'null'
                       OR (jsonb_typeof(e.value) = 'number' AND e.value::text ~ '^(0|[1-9][0-9]{0,4})$' AND (e.value::text)::int <= 86400)));
  END IF;
  IF p_tag = 'bool' THEN RETURN t = 'boolean'; END IF;
  IF p_tag IN ('int', 'pos') THEN
    RETURN t = 'number' AND p_v::text ~ '^(0|[1-9][0-9]{0,14})$' AND (p_tag = 'int' OR p_v::text <> '0');
  END IF;
  IF p_tag = 'usage' THEN
    -- Token counts: its `output` is a number here, which is why the free-text key scan skips this one object.
    RETURN t = 'object' AND p_v <> '{}'::jsonb
      AND NOT EXISTS (SELECT 1 FROM jsonb_each(p_v) e WHERE e.key NOT IN ('input', 'output', 'cache_read', 'cache_write')
                       OR NOT CASE WHEN jsonb_typeof(e.value) = 'number' AND e.value::text ~ '^(0|[1-9][0-9]{0,12})$' THEN (e.value::text)::numeric <= 1000000000000 ELSE false END);
  END IF;
  IF p_tag = 'ages' THEN
    RETURN t = 'object' AND NOT EXISTS (SELECT 1 FROM jsonb_each(p_v) e WHERE e.key NOT IN ('loop', 'team_log', 'plan', 'merge_queue') OR NOT public.engine_value_ok(e.value, 'int'));
  END IF;
  IF p_tag IN ('items', 'roadmap') THEN
    -- The same two caps as the runner-protocol schema: 300 plan items and 500 roadmap rows, separately.
    IF t <> 'array' OR jsonb_array_length(p_v) > (CASE WHEN p_tag = 'items' THEN 300 ELSE 500 END) THEN RETURN false; END IF;
    FOR r IN SELECT value FROM jsonb_array_elements(p_v) LOOP
      IF jsonb_typeof(r) <> 'object' THEN RETURN false; END IF;
      IF p_tag = 'items' THEN
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(r) k WHERE k NOT IN ('discussion', 'ordinal', 'state'))
           OR NOT (r ? 'discussion' AND r ? 'ordinal' AND r ? 'state')
           OR NOT (public.engine_value_ok(r->'discussion', 'pos') AND public.engine_value_ok(r->'ordinal', 'int')
                   AND public.engine_value_ok(r->'state', 'e:planned|in_progress|pr_open|merged|blocked|dropped')) THEN RETURN false; END IF;
      ELSE
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(r) k WHERE k NOT IN ('row_key', 'discussion', 'status', 'planned_prs'))
           OR NOT (r ? 'row_key' AND r ? 'status')
           OR NOT (public.engine_value_ok(r->'row_key', 'r:^([A-Za-z0-9][A-Za-z0-9._-]{0,47})?$')
                   AND public.engine_value_ok(r->'status', 'e:not_started|in_progress|done|blocked|deferred|split|removed|superseded')
                   AND (NOT r ? 'discussion' OR public.engine_value_ok(r->'discussion', 'pos'))
                   AND (NOT r ? 'planned_prs' OR public.engine_value_ok(r->'planned_prs', 'int'))) THEN RETURN false; END IF;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  IF t <> 'string' THEN RETURN false; END IF;
  s := p_v #>> '{}';
  IF left(p_tag, 2) = 'e:' THEN RETURN s = ANY (string_to_array(substr(p_tag, 3), '|')); END IF;
  IF left(p_tag, 2) = 'r:' THEN RETURN s ~ substr(p_tag, 3); END IF;
  RETURN false;
END;
$$;
CREATE OR REPLACE FUNCTION engine_kind_spec(p_kind text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  role_e   text := 'e:executor|code-reviewer|security-reviewer|project-manager|acceptance-tester|browser-tester|technical-architect|product-owner|cost-analyst|performance-expert|security-expert|researcher|mission-analyst|docs-writer|debater|explore|other';
  actor_e  text := role_e || '|team-lead';
  spawn    text := 'r:^toolu_[A-Za-z0-9]{1,64}$';
  agent    text := 'r:^[A-Za-z0-9_-]{1,64}$';
  hex16    text := 'r:^[0-9a-f]{16}$';
  model    text := 'r:^[a-z0-9][a-z0-9.-]{0,63}$';
  origin_e text := 'e:interactive|cron|host';
  cred     text := 'e:subscription|api_key';
  outcome  text := 'e:ok|error|interrupted';
  hostwhy  text := 'e:stopped_by_person|halted|crash_loop|operate_off|machine_shutdown';
  dropwhy  text := 'e:schema|oversize|redaction|partial_line';
  tickk    text := 'e:loop|checkin|start_day|command|reorient';
BEGIN
  RETURN CASE p_kind
    WHEN 'agent_started' THEN jsonb_build_object('req', jsonb_build_object('spawn_id', spawn, 'role', role_e, 'background', 'bool', 'isolation', 'e:worktree|none'), 'opt', jsonb_build_object('discussion', 'pos', 'model', model))
    WHEN 'agent_linked' THEN jsonb_build_object('req', jsonb_build_object('spawn_id', spawn, 'agent_id', agent), 'opt', '{}'::jsonb)
    WHEN 'agent_stopped' THEN jsonb_build_object('req', jsonb_build_object('agent_id', agent, 'role', role_e, 'verdict', 'e:pass|fail|done|blocked|needs_fix|unknown', 'credential_mode', cred),
                                                 'opt', jsonb_build_object('discussion', 'pos', 'pr', 'pos', 'duration_s', 'int', 'model', model, 'usage', 'usage'))
    WHEN 'spawn_blocked' THEN jsonb_build_object('req', jsonb_build_object('role', role_e, 'reason', 'e:circuit_breaker|budget|planned_prs|no_spec|halted|cloud_denied|cloud_unreachable|other'), 'opt', jsonb_build_object('discussion', 'pos'))
    WHEN 'merge_lane' THEN jsonb_build_object('req', jsonb_build_object('pr', 'pos', 'state', 'e:queued|testing|merged|failed|dequeued|refused'), 'opt', jsonb_build_object('discussion', 'pos'))
    WHEN 'merged' THEN jsonb_build_object('req', jsonb_build_object('pr', 'pos', 'closes', 'bool'), 'opt', jsonb_build_object('discussion', 'pos'))
    WHEN 'gate_receipt' THEN jsonb_build_object('req', jsonb_build_object('pr', 'pos', 'gate', 'e:gate1|code_review|security_review|acceptance|browser|ci_full', 'result', 'e:pass|fail|error|skipped', 'head_sha', 'r:^[0-9a-f]{40}$'), 'opt', '{}'::jsonb)
    WHEN 'team_log_line' THEN jsonb_build_object('req', jsonb_build_object('line_id', hex16, 'actor_role', actor_e, 'category', 'e:activated|starting|spawning|merged|needs_boss|blocked|heartbeat|other'), 'opt', jsonb_build_object('discussion', 'pos', 'pr', 'pos'))
    WHEN 'loop_tick' THEN jsonb_build_object('req', jsonb_build_object('origin', origin_e, 'duration_s', 'int'), 'opt', '{}'::jsonb)
    WHEN 'checkin_tick' THEN jsonb_build_object('req', jsonb_build_object('name', 'r:^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$', 'origin', origin_e), 'opt', '{}'::jsonb)
    WHEN 'engine_heartbeat' THEN jsonb_build_object('req', jsonb_build_object('origin', origin_e), 'opt', jsonb_build_object('source_ages_s', 'ages'))
    WHEN 'plan_snapshot' THEN jsonb_build_object('req', jsonb_build_object('plan_date', 'r:^[0-9]{4}-[0-9]{2}-[0-9]{2}$', 'snapshot_id', agent, 'chunk_index', 'int', 'chunk_count', 'pos', 'items', 'items', 'roadmap', 'roadmap'), 'opt', '{}'::jsonb)
    WHEN 'ask_raised' THEN jsonb_build_object('req', jsonb_build_object('ask_id', hex16, 'ask_kind', 'e:owner_decision|merge_blocked|credential|budget|review_blocked|other', 'source', 'e:team_log|discussion_label|issue_label'), 'opt', jsonb_build_object('discussion', 'pos', 'pr', 'pos'))
    WHEN 'ask_cleared' THEN jsonb_build_object('req', jsonb_build_object('ask_id', hex16, 'how', 'e:answered_cloud|answered_github|withdrawn|expired'), 'opt', '{}'::jsonb)
    WHEN 'host_started' THEN jsonb_build_object('req', '{}'::jsonb, 'opt', jsonb_build_object('reason', hostwhy))
    WHEN 'host_stopped' THEN jsonb_build_object('req', '{}'::jsonb, 'opt', jsonb_build_object('reason', hostwhy))
    WHEN 'host_heartbeat' THEN jsonb_build_object('req', '{}'::jsonb, 'opt', jsonb_build_object('reason', hostwhy))
    WHEN 'tick_started' THEN jsonb_build_object('req', jsonb_build_object('tick_kind', tickk), 'opt', jsonb_build_object('outcome', outcome, 'duration_s', 'int'))
    WHEN 'tick_ended' THEN jsonb_build_object('req', jsonb_build_object('tick_kind', tickk, 'credential_mode', cred), 'opt', jsonb_build_object('outcome', outcome, 'duration_s', 'int', 'model', model, 'usage', 'usage'))
    WHEN 'compaction_detected' THEN jsonb_build_object('req', '{}'::jsonb, 'opt', '{}'::jsonb)
    WHEN 'halt_applied' THEN jsonb_build_object('req', jsonb_build_object('halt_epoch', 'int', 'method', 'e:scope|group_only', 'survivors', 'int'), 'opt', '{}'::jsonb)
    WHEN 'bridge_heartbeat' THEN jsonb_build_object('req', '{}'::jsonb, 'opt', jsonb_build_object('count', 'int', 'reason', dropwhy))
    WHEN 'bridge_dropped' THEN jsonb_build_object('req', '{}'::jsonb, 'opt', jsonb_build_object('count', 'int', 'reason', dropwhy))
    -- D#845 watch mode: sent in place of the three heartbeats while nobody watches the repo (the runner's own, in its bridge session).
    WHEN 'slim_status' THEN jsonb_build_object('req', jsonb_build_object('sources', 'slim_sources', 'reason', 'e:unwatched'), 'opt', '{}'::jsonb)
    ELSE NULL
  END;
END;
$$;
CREATE OR REPLACE FUNCTION engine_kind_panels(p_kind text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_kind
    WHEN 'agent_started' THEN ARRAY['agents', 'stats']
    WHEN 'agent_linked' THEN ARRAY['agents', 'stats', 'usage']
    WHEN 'agent_stopped' THEN ARRAY['agents', 'stats', 'usage']
    WHEN 'merge_lane' THEN ARRAY['lanes', 'gates']
    WHEN 'merged' THEN ARRAY['stats']
    WHEN 'gate_receipt' THEN ARRAY['gates', 'stats']
    WHEN 'ask_raised' THEN ARRAY['asks']
    WHEN 'ask_cleared' THEN ARRAY['asks']
    WHEN 'team_log_line' THEN ARRAY['log']
    WHEN 'plan_snapshot' THEN ARRAY['plan']
    -- No reader reads these kinds' own rows: what they change is the repo's status line (last event, heartbeat, halt).
    WHEN 'spawn_blocked' THEN ARRAY['status']
    WHEN 'loop_tick' THEN ARRAY['status']
    WHEN 'checkin_tick' THEN ARRAY['status']
    WHEN 'engine_heartbeat' THEN ARRAY['status']
    WHEN 'host_started' THEN ARRAY['status']
    WHEN 'host_stopped' THEN ARRAY['status']
    WHEN 'host_heartbeat' THEN ARRAY['status']
    WHEN 'tick_started' THEN ARRAY['status']
    WHEN 'tick_ended' THEN ARRAY['status']
    WHEN 'compaction_detected' THEN ARRAY['status']
    WHEN 'halt_applied' THEN ARRAY['status']
    WHEN 'bridge_heartbeat' THEN ARRAY['status']
    WHEN 'bridge_dropped' THEN ARRAY['status']
    WHEN 'slim_status' THEN ARRAY['status']
    ELSE NULL
  END;
$$;

-- ---- the command: one new kind ---------------------------------------------------------------------------------------------------------------------

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
    WHEN 'watch' THEN
      -- D#845 watch mode: `until` is a UTC time (the schema's own check that it is ahead of the issue time is the protocol's), `before` a detail seq.
      NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_args) AS k WHERE k NOT IN ('until', 'before'))
      AND jsonb_typeof(p_args -> 'until') = 'string'
      -- The shape first, then that the day exists in its month (2026-02-30 matches the shape and is no time: a stored one would make every read that casts it fail), then the cast itself. A CASE, so
      -- the later steps run only on text the earlier ones passed.
      AND CASE
        WHEN (p_args ->> 'until') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?Z$' THEN false
        WHEN substr(p_args ->> 'until', 1, 4)::int < 1 THEN false
        WHEN substr(p_args ->> 'until', 9, 2)::int > EXTRACT(day FROM (make_date(substr(p_args ->> 'until', 1, 4)::int, substr(p_args ->> 'until', 6, 2)::int, 1) + interval '1 month' - interval '1 day'))::int THEN false
        ELSE (p_args ->> 'until')::timestamptz IS NOT NULL
      END
      AND (NOT p_args ? 'before' OR (jsonb_typeof(p_args -> 'before') = 'number' AND (p_args ->> 'before') ~ '^(0|[1-9][0-9]{0,15})$'
           AND (p_args ->> 'before')::bigint <= 9007199254740991))
    ELSE false
  END, false);
$$;
REVOKE ALL ON FUNCTION engine_command_args_ok(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION engine_command_args_ok(text, jsonb) TO app_user;

ALTER TABLE engine_commands DROP CONSTRAINT engine_commands_kind_check;
ALTER TABLE engine_commands ADD CONSTRAINT engine_commands_kind_check
  CHECK (kind IN ('start_day', 'pause_loop', 'resume_loop', 'answer_ask', 'set_dial', 'request_spawn', 'stop_agent', 'bridge_enable', 'bridge_disable', 'watch'));

-- ---- the ingest: 1039's, with the slim status, the detail session and held holes ----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION engine_events_ingest(p_account uuid, p_runner uuid, p_repo_gh_id bigint, p_instance uuid, p_version text, p_events jsonb)
RETURNS TABLE (o_outcome text, o_accepted integer, o_duplicates integer, o_last_seq bigint, o_retry_after_s integer, o_session_id uuid, o_usage jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_runner uuid := NULLIF(current_setting('app.runner_id', true), '')::uuid;
  v_repo uuid; v_mode text; v_allowed uuid[]; v_revoked timestamptz; v_watch boolean;
  v_day date := (now() AT TIME ZONE 'utc')::date;
  v_sess engine_sessions%ROWTYPE;
  v_n int; i int; e jsonb; b jsonb; kind text; s bigint; ts timestamptz;
  v_prev bigint; v_prev_ts timestamptz; v_gaps int := 0; v_stored int := 0; v_dup int := 0; v_take int; v_rows int;
  v_count int; v_usage jsonb := '[]'::jsonb; v_hb boolean := false; v_ages jsonb; v_model text; v_first timestamptz; v_last timestamptz;
  v_orphan engine_agents%ROWTYPE; v_outcome text := 'ok'; v_retry int;
  v_kind text; v_nb int; v_rq engine_repo_quota%ROWTYPE; v_rcount int;
  v_kinds text[] := '{}'; v_usage_b boolean := false;
  v_proto int; v_detail boolean; v_nd int; v_held boolean;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'engine_events_ingest: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account IS NULL OR p_runner IS NULL OR p_instance IS NULL OR p_repo_gh_id IS NULL OR p_repo_gh_id < 1 OR p_version IS NULL
     OR p_version !~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$' OR p_events IS NULL OR jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'engine_events_ingest: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account IS DISTINCT FROM v_acct OR p_runner IS DISTINCT FROM v_runner THEN
    RAISE EXCEPTION 'engine_events_ingest: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT n.revoked_at, n.allowed_repo_ids, COALESCE(n.protocol_version, 0) INTO v_revoked, v_allowed, v_proto FROM public.runners n WHERE n.id = p_runner AND n.account_id = p_account;
  -- A live runner of an active account (a soft-deleted account's runner writes nothing), as runner_capabilities_record requires.
  IF NOT FOUND OR v_revoked IS NOT NULL OR NOT public.account_is_active(p_account) THEN
    RAISE EXCEPTION 'engine_events_ingest: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Refusals, in order. Nothing is written by any of them.
  SELECT st.watch_enabled INTO v_watch FROM public.engine_bridge_settings st WHERE st.account_id = p_account;
  IF NOT FOUND OR NOT v_watch THEN
    RETURN QUERY SELECT 'engine_bridge_off'::text, 0, 0, NULL::bigint, NULL::int, NULL::uuid, '[]'::jsonb; RETURN;
  END IF;
  SELECT r.id, r.execution_mode INTO v_repo, v_mode FROM public.repos r WHERE r.account_id = p_account AND r.gh_repo_id = p_repo_gh_id;
  IF NOT FOUND OR v_mode IS DISTINCT FROM 'runner_local' OR NOT (v_repo = ANY (v_allowed))
     OR NOT EXISTS (SELECT 1 FROM public.engine_bridge_repos br WHERE br.account_id = p_account AND br.repo_id = v_repo) THEN
    RETURN QUERY SELECT 'engine_repo_not_enabled'::text, 0, 0, NULL::bigint, NULL::int, NULL::uuid, '[]'::jsonb; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.engine_sessions x WHERE x.account_id = p_account AND x.engine_instance_id = p_instance AND x.runner_id <> p_runner) THEN
    RETURN QUERY SELECT 'engine_instance_other_runner'::text, 0, 0, NULL::bigint, NULL::int, NULL::uuid, '[]'::jsonb; RETURN;
  END IF;

  -- Every event is checked before any is stored, so a bad one costs the batch nothing.
  v_n := jsonb_array_length(p_events);
  v_prev := NULL;
  FOR i IN 0 .. v_n - 1 LOOP
    e := p_events -> i;
    BEGIN
      IF jsonb_typeof(e) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('seq', 'ts', 'kind', 'body'))
         OR NOT engine_value_ok(e -> 'seq', 'int') OR jsonb_typeof(e -> 'ts') <> 'string' OR jsonb_typeof(e -> 'kind') <> 'string' THEN
        RETURN QUERY SELECT 'invalid_message'::text, 0, 0, NULL::bigint, NULL::int, NULL::uuid, '[]'::jsonb; RETURN;
      END IF;
      ts := (e ->> 'ts')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY SELECT 'invalid_message'::text, 0, 0, NULL::bigint, NULL::int, NULL::uuid, '[]'::jsonb; RETURN;
    END;
    IF NOT engine_body_closed(e ->> 'kind', COALESCE(e -> 'body', '{}'::jsonb)) THEN
      RETURN QUERY SELECT 'invalid_message'::text, 0, 0, NULL::bigint, NULL::int, NULL::uuid, '[]'::jsonb; RETURN;
    END IF;
    s := (e ->> 'seq')::bigint;
    IF v_prev IS NOT NULL AND s <= v_prev THEN
      RETURN QUERY SELECT 'seq_order'::text, 0, 0, NULL::bigint, NULL::int, NULL::uuid, '[]'::jsonb; RETURN;
    END IF;
    v_prev := s;
  END LOOP;

  -- The runner's own facts (`bridge_*`, and the slim status that stands in for the heartbeats) live in a session of their own: a batch is all of them or none, and a session keeps the
  -- kind it was made with.
  SELECT count(*) INTO v_nb FROM jsonb_array_elements(p_events) x WHERE x ->> 'kind' IN ('bridge_heartbeat', 'bridge_dropped', 'slim_status');
  IF v_nb NOT IN (0, v_n) THEN
    RETURN QUERY SELECT 'invalid_message'::text, 0, 0, NULL::bigint, NULL::int, NULL::uuid, '[]'::jsonb; RETURN;
  END IF;
  -- D#845 watch mode: the events a runner keeps on its machine until someone watches (the on-demand kinds, and the engine's and host's heartbeats while a watch lasts) go in a DETAIL session,
  -- with its own instance id and its own seq. The runner marks one by making its instance id a version-8 UUID (the engine's own ids are random, version 4), so no guess is made from the kinds.
  -- A detail session takes those kinds only.
  v_detail := substr(p_instance::text, 15, 1) = '8';
  SELECT count(*) INTO v_nd FROM jsonb_array_elements(p_events) x WHERE x ->> 'kind' IN ('team_log_line', 'loop_tick', 'checkin_tick', 'plan_snapshot', 'tick_started', 'compaction_detected', 'engine_heartbeat', 'host_heartbeat');
  IF v_detail AND (v_nb <> 0 OR v_nd <> v_n) THEN
    RETURN QUERY SELECT 'invalid_message'::text, 0, 0, NULL::bigint, NULL::int, NULL::uuid, '[]'::jsonb; RETURN;
  END IF;
  v_kind := CASE WHEN v_detail THEN 'detail' WHEN v_nb = 0 THEN 'engine' ELSE 'bridge' END;
  -- A hole in an engine session of a runner that holds its on-demand events back is expected (they are in the detail session): it is recorded, flagged `held`, and not counted as missing.
  v_held := v_kind = 'engine' AND v_proto >= 23;

  -- The day's cap for the whole repo, taken (and its row locked) before any session is made, so a runner cannot multiply it by opening sessions.
  v_retry := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (((v_day + 1)::timestamp AT TIME ZONE 'utc') - now())))::int);
  INSERT INTO public.engine_repo_quota (account_id, repo_id, quota_day, quota_count) VALUES (p_account, v_repo, v_day, 0) ON CONFLICT (account_id, repo_id) DO NOTHING;
  SELECT * INTO v_rq FROM public.engine_repo_quota q WHERE q.account_id = p_account AND q.repo_id = v_repo FOR UPDATE;
  v_rcount := CASE WHEN v_rq.quota_day = v_day THEN v_rq.quota_count ELSE 0 END;
  IF v_rcount >= 20000 THEN
    RETURN QUERY SELECT 'quota'::text, 0, 0, NULL::bigint, v_retry, NULL::uuid, '[]'::jsonb; RETURN;
  END IF;

  INSERT INTO public.engine_sessions (account_id, runner_id, repo_id, engine_instance_id, engine_version, session_kind)
  VALUES (p_account, p_runner, v_repo, p_instance, p_version, v_kind)
  ON CONFLICT (repo_id, engine_instance_id) DO NOTHING;
  SELECT * INTO v_sess FROM public.engine_sessions x WHERE x.repo_id = v_repo AND x.engine_instance_id = p_instance FOR UPDATE;
  IF v_sess.account_id <> p_account OR v_sess.runner_id <> p_runner THEN
    RAISE EXCEPTION 'engine_events_ingest: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_sess.session_kind <> v_kind THEN
    RETURN QUERY SELECT 'invalid_message'::text, 0, 0, NULL::bigint, NULL::int, NULL::uuid, '[]'::jsonb; RETURN;
  END IF;

  -- Strictly increasing across batches: a first seq at or below the last stored one is a replay (nothing stored, the runner trims and resends).
  IF v_kind <> 'detail' AND v_sess.last_seq IS NOT NULL AND (p_events -> 0 ->> 'seq')::bigint <= v_sess.last_seq THEN
    RETURN QUERY SELECT 'seq_not_increasing'::text, 0, 0, v_sess.last_seq, NULL::int, v_sess.id, '[]'::jsonb; RETURN;
  END IF;

  -- The quotas: 5000 events a session and 20000 a repo per UTC day; what would pass either is not stored.
  v_count := CASE WHEN v_sess.quota_day IS NOT DISTINCT FROM v_day THEN v_sess.quota_count ELSE 0 END;
  v_take := LEAST(v_n, GREATEST(0, 5000 - v_count), GREATEST(0, 20000 - v_rcount));
  IF v_take < v_n THEN v_outcome := 'quota'; END IF;

  -- A detail session answers with the last seq of THIS batch (what the runner trims its resend by), its high-water mark being the session's own last_seq.
  v_prev := CASE WHEN v_kind = 'detail' THEN NULL ELSE v_sess.last_seq END;
  v_prev_ts := (SELECT ev.ts FROM public.engine_events ev WHERE ev.session_id = v_sess.id AND ev.seq = v_sess.last_seq);
  FOR i IN 0 .. v_take - 1 LOOP
    e := p_events -> i;
    kind := e ->> 'kind';
    b := COALESCE(e -> 'body', '{}'::jsonb);
    s := (e ->> 'seq')::bigint;
    ts := (e ->> 'ts')::timestamptz;
    -- A hole in the numbers is recorded and the batch goes on. The first event of a session is expected at 0.
    IF v_kind <> 'detail' AND s > COALESCE(v_prev + 1, 0) THEN
      INSERT INTO public.engine_session_gaps (account_id, session_id, from_seq, to_seq, before_ts, held) VALUES (p_account, v_sess.id, COALESCE(v_prev + 1, 0), s - 1, v_prev_ts, v_held)
      ON CONFLICT DO NOTHING;
      IF NOT v_held THEN v_gaps := v_gaps + 1; END IF;
    END IF;
    INSERT INTO public.engine_events (session_id, seq, account_id, ts, kind, body) VALUES (v_sess.id, s, p_account, ts, kind, b) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_prev := s;
    v_prev_ts := ts;
    v_first := LEAST(COALESCE(v_first, ts), ts);
    v_last := GREATEST(COALESCE(v_last, ts), ts);
    IF v_rows = 0 THEN v_dup := v_dup + 1; CONTINUE; END IF;
    v_stored := v_stored + 1;
    v_kinds := v_kinds || kind;

    IF kind = 'agent_started' THEN
      INSERT INTO public.engine_agents (account_id, session_id, spawn_id, role, discussion, background, isolation, model, started_at)
      VALUES (p_account, v_sess.id, b ->> 'spawn_id', b ->> 'role', (b ->> 'discussion')::bigint, (b ->> 'background')::boolean, b ->> 'isolation', b ->> 'model', ts)
      ON CONFLICT (session_id, spawn_id) DO NOTHING;
    ELSIF kind = 'agent_linked' THEN
      -- A foreground agent stops before its tool call returns, so its stop can arrive first as a row of its own; the link joins them.
      SELECT * INTO v_orphan FROM public.engine_agents a WHERE a.session_id = v_sess.id AND a.agent_id = b ->> 'agent_id' AND a.spawn_id IS NULL;
      IF FOUND THEN
        DELETE FROM public.engine_agents a WHERE a.id = v_orphan.id;
        UPDATE public.engine_agents a SET agent_id = v_orphan.agent_id, stopped_at = v_orphan.stopped_at, verdict = v_orphan.verdict, duration_s = v_orphan.duration_s,
               pr = v_orphan.pr, discussion = COALESCE(a.discussion, v_orphan.discussion) WHERE a.session_id = v_sess.id AND a.spawn_id = b ->> 'spawn_id' AND a.agent_id IS NULL;
      ELSE
        UPDATE public.engine_agents a SET agent_id = b ->> 'agent_id'
         WHERE a.session_id = v_sess.id AND a.spawn_id = b ->> 'spawn_id' AND a.agent_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.engine_agents o WHERE o.session_id = v_sess.id AND o.agent_id = b ->> 'agent_id');
      END IF;
    ELSIF kind = 'agent_stopped' THEN
      UPDATE public.engine_agents a SET stopped_at = ts, verdict = b ->> 'verdict', duration_s = (b ->> 'duration_s')::bigint, pr = COALESCE((b ->> 'pr')::bigint, a.pr),
             discussion = COALESCE(a.discussion, (b ->> 'discussion')::bigint)
       WHERE a.session_id = v_sess.id AND a.agent_id = b ->> 'agent_id' RETURNING a.model INTO v_model;
      IF NOT FOUND THEN
        INSERT INTO public.engine_agents (account_id, session_id, agent_id, role, discussion, pr, stopped_at, verdict, duration_s)
        VALUES (p_account, v_sess.id, b ->> 'agent_id', b ->> 'role', (b ->> 'discussion')::bigint, (b ->> 'pr')::bigint, ts, b ->> 'verdict', (b ->> 'duration_s')::bigint);
        v_model := NULL;
      END IF;
    ELSIF kind = 'merge_lane' THEN
      INSERT INTO public.engine_lanes (account_id, session_id, pr, discussion, state, updated_at) VALUES (p_account, v_sess.id, (b ->> 'pr')::bigint, (b ->> 'discussion')::bigint, b ->> 'state', ts)
      ON CONFLICT (session_id, pr) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at, discussion = COALESCE(EXCLUDED.discussion, engine_lanes.discussion);
    ELSIF kind = 'gate_receipt' THEN
      INSERT INTO public.engine_gate_receipts (account_id, session_id, pr, gate, result, head_sha, at)
      VALUES (p_account, v_sess.id, (b ->> 'pr')::bigint, b ->> 'gate', b ->> 'result', b ->> 'head_sha', ts) ON CONFLICT DO NOTHING;
    ELSIF kind = 'ask_raised' THEN
      INSERT INTO public.engine_asks (account_id, session_id, ask_id, ask_kind, source, discussion, pr, raised_at)
      VALUES (p_account, v_sess.id, b ->> 'ask_id', b ->> 'ask_kind', b ->> 'source', (b ->> 'discussion')::bigint, (b ->> 'pr')::bigint, ts) ON CONFLICT DO NOTHING;
    ELSIF kind = 'ask_cleared' THEN
      UPDATE public.engine_asks a SET cleared_at = ts, how = b ->> 'how' WHERE a.session_id = v_sess.id AND a.ask_id = b ->> 'ask_id' AND a.cleared_at IS NULL;
    END IF;

    IF kind IN ('engine_heartbeat', 'host_heartbeat', 'bridge_heartbeat', 'slim_status') THEN v_hb := true; END IF;
    IF kind = 'engine_heartbeat' THEN v_ages := b -> 'source_ages_s'; END IF;

    -- Tokens of an agent or a tick. The figure is set (not added) so a repeated stop for one agent is not counted twice; it is priced afterwards.
    IF kind IN ('agent_stopped', 'tick_ended') AND b ? 'usage' THEN
      v_usage_b := true;
      INSERT INTO public.engine_agent_usage AS u (account_id, session_id, subject_kind, subject_id, source_seqs, credential_mode, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
      VALUES (p_account, v_sess.id, CASE WHEN kind = 'agent_stopped' THEN 'agent' ELSE 'tick' END, CASE WHEN kind = 'agent_stopped' THEN b ->> 'agent_id' ELSE s::text END,
              ARRAY[s], b ->> 'credential_mode', COALESCE(b ->> 'model', v_model), COALESCE((b -> 'usage' ->> 'input')::bigint, 0), COALESCE((b -> 'usage' ->> 'output')::bigint, 0),
              COALESCE((b -> 'usage' ->> 'cache_read')::bigint, 0), COALESCE((b -> 'usage' ->> 'cache_write')::bigint, 0))
      ON CONFLICT (session_id, subject_kind, subject_id) DO UPDATE
        SET source_seqs = u.source_seqs || EXCLUDED.source_seqs, credential_mode = EXCLUDED.credential_mode, model = EXCLUDED.model, input_tokens = EXCLUDED.input_tokens,
            output_tokens = EXCLUDED.output_tokens, cache_read_tokens = EXCLUDED.cache_read_tokens, cache_write_tokens = EXCLUDED.cache_write_tokens,
            api_equivalent_usd = NULL, price_table_version = NULL, recorded_at = now();
      v_usage := v_usage || jsonb_build_array(jsonb_build_object('subject_kind', CASE WHEN kind = 'agent_stopped' THEN 'agent' ELSE 'tick' END,
                 'subject_id', CASE WHEN kind = 'agent_stopped' THEN b ->> 'agent_id' ELSE s::text END, 'model', COALESCE(b ->> 'model', v_model),
                 'input_tokens', COALESCE(b -> 'usage' ->> 'input', '0'), 'output_tokens', COALESCE(b -> 'usage' ->> 'output', '0'),
                 'cache_read_tokens', COALESCE(b -> 'usage' ->> 'cache_read', '0'), 'cache_write_tokens', COALESCE(b -> 'usage' ->> 'cache_write', '0')));
    END IF;
    v_model := NULL;
  END LOOP;

  UPDATE public.engine_sessions x SET
    last_seq = CASE WHEN v_kind = 'detail' THEN GREATEST(x.last_seq, v_prev) ELSE COALESCE(v_prev, x.last_seq) END, seq_gaps = x.seq_gaps + v_gaps, engine_version = p_version,
    first_event_at = COALESCE(x.first_event_at, CASE WHEN v_first IS NOT NULL THEN LEAST(v_first, now()) END),
    last_event_at = CASE WHEN v_stored > 0 THEN GREATEST(x.last_event_at, LEAST(v_last, now())) ELSE x.last_event_at END,
    last_heard_at = now(), last_heartbeat_at = CASE WHEN v_hb THEN now() ELSE x.last_heartbeat_at END,
    source_ages_s = COALESCE(v_ages, x.source_ages_s), quota_day = v_day, quota_count = v_count + v_stored
   WHERE x.id = v_sess.id;
  UPDATE public.engine_repo_quota q SET quota_day = v_day, quota_count = v_rcount + v_stored WHERE q.account_id = p_account AND q.repo_id = v_repo;
  -- One change notice per batch that stored something (ids and panel names only), in this transaction: it exists exactly when the rows it announces do.
  -- Insert-only: a batch is never merged into an earlier notice. `panels` is the union of the panels of the kinds this batch stored; an unknown kind
  -- makes it name every panel (engine_panels_union).
  IF v_stored > 0 THEN
    INSERT INTO public.domain_events (account_id, type, subject_id, payload)
    VALUES (p_account, 'engine.changed', v_repo::text, jsonb_build_object('repo_id', v_repo, 'session_id', v_sess.id, 'last_seq', v_prev,
            'panels', to_jsonb(public.engine_panels_union(v_kinds, v_usage_b))));
  END IF;
  RETURN QUERY SELECT v_outcome, v_stored, v_dup, v_prev, CASE WHEN v_outcome = 'quota' THEN v_retry END, v_sess.id, v_usage;
END;
$$;

-- ---- ownership and grants: 1027's and 1039's, re-asserted -----------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_value_ok(jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_kind_spec(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_kind_panels(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION engine_value_ok(jsonb, text) TO engine_bridge_definer;
GRANT EXECUTE ON FUNCTION engine_kind_spec(text) TO engine_bridge_definer;
GRANT EXECUTE ON FUNCTION engine_kind_panels(text) TO engine_bridge_definer;
ALTER FUNCTION engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb) OWNER TO engine_bridge_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb) TO app_user;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE engine_bridge_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- the capability: a hello that declares 'watch_mode_v1' must store -------------------------------------------------------------------------------
-- A runner that can run watch mode says so on its hello, as it says `wake_v1`; the cloud then (and only then) tells it in the reply that this cloud's ingest takes watch mode. The closed capability
-- list and runner_capabilities_record widen by one value, from 1041's sixteen; everything else of the function is 1041's, verbatim (ownership: runner_capabilities_definer, taken for the replace and dropped).
ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1']::text[]));

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_capabilities_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_capabilities_definer; cannot replace runner_capabilities_record';
    END IF;
    EXECUTE 'GRANT runner_capabilities_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION runner_capabilities_record(p_capabilities text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_capabilities_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A live runner of an active account, named by the session: no runner in the session, a revoked one or another account's one writes nothing.
  IF acct IS NULL OR NOT account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'runner_capabilities_record: the session is not a live runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Closed codes, each once, a flat list: anything else is refused, not repaired, so what is stored is exactly what was sent.
  IF p_capabilities IS NULL OR (cardinality(p_capabilities) > 0 AND array_ndims(p_capabilities) <> 1)
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1']))
     OR (SELECT count(*) <> count(DISTINCT c) FROM unnest(p_capabilities) c) THEN
    RAISE EXCEPTION 'runner_capabilities_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.runner_capabilities AS c (runner_id, account_id, capabilities)
  VALUES (raw::uuid, acct, p_capabilities)
  ON CONFLICT (runner_id) DO UPDATE SET capabilities = EXCLUDED.capabilities, reported_at = now();
END;
$$;
REVOKE ALL ON FUNCTION runner_capabilities_record(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_capabilities_record(text[]) TO app_user;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE 'REVOKE runner_capabilities_definer FROM CURRENT_USER';
  END IF;
END
$$;
