-- D#845 MC-11a, the usage rollup: raw token counts per machine, repo, day and model tier (machine_usage_daily, 1035's table).
--
-- What:
--   * source 'engine_session': `usage_tick` becomes a known engine event kind (engine_kind_spec and engine_kind_panels re-carried whole from 1043 with the one case; its own panel is status, and the batch's usage flag adds `usage`), and
--     engine_events_ingest (1043's, whole) adds each newly stored tick's four counts to the row keyed (account, runner, repo, day, 'engine_session', model_tier). Idempotent on the event's seq:
--     the add sits behind the same ON CONFLICT DO NOTHING on engine_events (session, seq) that already drops a replayed event, so a replayed batch adds nothing. A tick over 1e12 in any count
--     refuses the batch (the protocol's own cap), so a day's sum cannot overflow. The day is the day it arrives (the server's UTC day, as for runs), never the runner's own timestamp.
--   * source 'run': runner_usage_add (0768's, whole) adds the same delta it adds to the run's usage row, keyed by the run's repo (agent_runs.dispatch_repo_id; NULL when that repo is gone), the UTC day it arrives and the
--     model family as tier ('unknown' with no model). Runner runs DO carry token counts (runner_run_usage), so these rows are real counts, never invented.
--   * The key is recreated WITHOUT NULLS NOT DISTINCT: 1035's repo FK is ON DELETE SET NULL, and with the NULL-repo rows merged into one, deleting a second repo whose rows share a key with an
--     existing NULL-repo row (or two repos in one statement) failed with 23505. Rows with no repo (a deleted repo's, and a run's whose repo is gone) now stay separate rows, so a reader MUST SUM over rows
--     for a (runner, day, source, tier), as for any rollup (MC-11b does). A row with a repo is still unique per key, so the engine's upsert is unchanged.
--   * Writers: only the two definers. app_user keeps 1035's tenant-isolated SELECT and gains nothing; both definers get SELECT, INSERT and UPDATE on the table and a policy for their own tenant.
--
-- Rollback (expand/contract): a later migration may stop writing; rows only add. Numbered 1063 by the Team Lead; merges in number order. Re-carries from main's newest definitions at merge time.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'engine_bridge_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_bridge_definer; cannot replace its functions';
    END IF;
    GRANT engine_bridge_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
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
    -- D#845 MC-11a: raw token counts for one window; the cloud adds them to machine_usage_daily and prices them with its own tables.
    WHEN 'usage_tick' THEN jsonb_build_object('req', jsonb_build_object('model_tier', 'r:^[a-z0-9][a-z0-9._-]{0,31}$', 'input_tokens', 'int', 'output_tokens', 'int', 'cache_read_tokens', 'int', 'cache_write_tokens', 'int', 'window_s', 'int'), 'opt', '{}'::jsonb)
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
    WHEN 'usage_tick' THEN ARRAY['status']
    ELSE NULL
  END;
$$;

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
    -- A usage_tick's counts are each at most 1e12 (the protocol's cap), so a day's sum cannot overflow a bigint.
    IF e ->> 'kind' = 'usage_tick' AND EXISTS (SELECT 1 FROM jsonb_each_text(e -> 'body') u WHERE u.key LIKE '%\_tokens' AND u.value::numeric > 1000000000000) THEN
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

    -- MC-11a: a stored (not duplicate) usage_tick adds its counts to the machine's day. The event row's own (session, seq) key is the guard: a replayed event stores nothing and
    -- reaches the CONTINUE above, so it adds nothing. The day is the day it arrives (UTC), so a runner cannot file a row on a day of its choosing.
    IF kind = 'usage_tick' THEN
      INSERT INTO public.machine_usage_daily AS d (account_id, runner_id, repo_id, day, source, model_tier, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
      VALUES (p_account, p_runner, v_repo, (now() AT TIME ZONE 'utc')::date, 'engine_session', b ->> 'model_tier',
              (b ->> 'input_tokens')::bigint, (b ->> 'output_tokens')::bigint, (b ->> 'cache_read_tokens')::bigint, (b ->> 'cache_write_tokens')::bigint)
      ON CONFLICT (account_id, runner_id, repo_id, day, source, model_tier) DO UPDATE
        SET input_tokens = d.input_tokens + EXCLUDED.input_tokens, output_tokens = d.output_tokens + EXCLUDED.output_tokens,
            cache_read_tokens = d.cache_read_tokens + EXCLUDED.cache_read_tokens, cache_write_tokens = d.cache_write_tokens + EXCLUDED.cache_write_tokens;
      v_usage_b := true;
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

REVOKE ALL ON FUNCTION engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_kind_spec(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_kind_panels(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION engine_kind_spec(text) TO engine_bridge_definer;
GRANT EXECUTE ON FUNCTION engine_kind_panels(text) TO engine_bridge_definer;
ALTER FUNCTION engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb) OWNER TO engine_bridge_definer;
GRANT EXECUTE ON FUNCTION engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb) TO app_user;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE engine_bridge_definer FROM CURRENT_USER;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_usage_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_usage_definer; cannot replace its functions';
    END IF;
    GRANT runner_usage_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION runner_usage_add(
  p_account uuid, p_run uuid, p_runner uuid,
  p_input bigint, p_output bigint, p_cache_read bigint, p_cache_write bigint
)
RETURNS TABLE (model text, input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_model text;
  v_repo  uuid;
  i       int;
  v_mode  text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_usage_add: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Each count is at most 1e12 (a run does not reach a thousandth of that), so a sum cannot overflow a bigint in any realistic life of a run.
  IF p_account IS NULL OR p_run IS NULL OR p_runner IS NULL
     OR p_input IS NULL OR p_output IS NULL OR p_cache_read IS NULL OR p_cache_write IS NULL
     OR p_input < 0 OR p_output < 0 OR p_cache_read < 0 OR p_cache_write < 0
     OR p_input > 1000000000000 OR p_output > 1000000000000 OR p_cache_read > 1000000000000 OR p_cache_write > 1000000000000 THEN
    RAISE EXCEPTION 'runner_usage_add: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid THEN
    RAISE EXCEPTION 'runner_usage_add: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT r.model, r.dispatch_repo_id INTO v_model, v_repo FROM public.agent_runs r
   WHERE r.id = p_run AND r.account_id = p_account AND r.runtime = 'runner' AND r.runner_id = p_runner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_usage_add: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT n.credential_mode INTO v_mode FROM public.runners n WHERE n.id = p_runner AND n.account_id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_usage_add: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- MC-11a: the same delta goes to the machine's day (source 'run'). The caller adds once per event its batch newly stored, so a replayed batch never reaches here.
  -- The tier is the model's family (haiku, sonnet, opus), 'unknown' with no model; the counts are the ones just added, nothing is invented.
  -- A run whose dispatch repo was deleted names a repo the table's key no longer admits: the delta is then filed under no repo (retry once), so the run's own usage row below is never lost to it.
  FOR i IN 1 .. 2 LOOP
    BEGIN
      INSERT INTO public.machine_usage_daily AS d (account_id, runner_id, repo_id, day, source, model_tier, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
      VALUES (p_account, p_runner, v_repo, (now() AT TIME ZONE 'utc')::date, 'run', COALESCE(NULLIF(split_part(v_model, '-', 1), ''), 'unknown'), p_input, p_output, p_cache_read, p_cache_write)
      ON CONFLICT (account_id, runner_id, repo_id, day, source, model_tier) DO UPDATE
        SET input_tokens = d.input_tokens + EXCLUDED.input_tokens, output_tokens = d.output_tokens + EXCLUDED.output_tokens,
            cache_read_tokens = d.cache_read_tokens + EXCLUDED.cache_read_tokens, cache_write_tokens = d.cache_write_tokens + EXCLUDED.cache_write_tokens;
      EXIT;
    EXCEPTION WHEN foreign_key_violation THEN
      IF i = 2 THEN RAISE; END IF;
      v_repo := NULL;
    END;
  END LOOP;

  RETURN QUERY
  INSERT INTO public.runner_run_usage AS u (account_id, run_id, runner_id, credential_mode, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
  VALUES (p_account, p_run, p_runner, v_mode, v_model, p_input, p_output, p_cache_read, p_cache_write)
  ON CONFLICT (account_id, run_id) DO UPDATE
    SET input_tokens = u.input_tokens + EXCLUDED.input_tokens,
        output_tokens = u.output_tokens + EXCLUDED.output_tokens,
        cache_read_tokens = u.cache_read_tokens + EXCLUDED.cache_read_tokens,
        cache_write_tokens = u.cache_write_tokens + EXCLUDED.cache_write_tokens
  RETURNING u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens;
END;
$$;

REVOKE ALL ON FUNCTION runner_usage_add(uuid, uuid, uuid, bigint, bigint, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_usage_add(uuid, uuid, uuid, bigint, bigint, bigint, bigint) TO agent_run_writer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_usage_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- machine_usage_daily: written by the two definers only -----------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON machine_usage_daily TO engine_bridge_definer, runner_usage_definer;
GRANT SELECT (dispatch_repo_id) ON agent_runs TO runner_usage_definer;
CREATE POLICY engine_bridge_definer_rw ON machine_usage_daily FOR ALL TO engine_bridge_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_usage_definer_rw ON machine_usage_daily FOR ALL TO runner_usage_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

DROP INDEX machine_usage_daily_key;
CREATE UNIQUE INDEX machine_usage_daily_key ON machine_usage_daily (account_id, runner_id, repo_id, day, source, model_tier);
