-- ON-23a: engine change notices travel on the nudge path and name the panels that changed.
--
-- Until now an `engine.changed` row reached a browser on the poller's 10 s idle tick, and carried ids only, so the Team app had to re-read every panel.
-- This migration does two things.
--
--   1. The notice names the panels. `engine_kind_panels(kind)` maps each engine event kind to the panels whose reader reads it (the reader's own table or
--      its own `kind = '...'` literal, in packages/core/src/engine/panels.ts, read.ts and plan.ts); a kind that no reader reads maps to `status`. The map is
--      one pure function, NULL for a kind that does not exist. `engine_panels_union(kinds, usage_bearing)` unions the panels of the kinds one batch stored
--      (plus `usage` for a usage-bearing tick or stop) in a fixed order, and when any kind is unknown it names every panel: a full re-read, never a missed one.
--      The closed set is: agents, lanes, gates, asks, log, plan, stats, usage, status.
--   2. engine_events_ingest (1027) is re-carried whole with one change: the one notice it writes per stored batch gains `panels`. It stays INSERT-only on
--      domain_events: one row per batch, never merged into an earlier one, so no new SELECT or UPDATE grant and no new row policy is needed. Everything else
--      of the function, and its REVOKE, OWNER and GRANT, are 1027's, verbatim.
--
-- The 0652 trigger gains `engine.changed` in its WHEN list, so a stored batch wakes the account's streams at once (NOTIFY carries the account id only).
-- The list must equal NUDGE_EVENT_TYPES in packages/api/src/sse/nudge.ts (a test compares them).

-- CREATE OR REPLACE on a function owned by engine_bridge_definer needs membership of that role for a non-superuser migrator (1027's bracket): taken here,
-- dropped at the end. The two new functions are handed to the definer in the same bracket, which needs CREATE on the schema for the duration.
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
GRANT CREATE ON SCHEMA public TO engine_bridge_definer;

-- The panels one kind touches. NULL for a kind that does not exist.
CREATE FUNCTION engine_kind_panels(p_kind text) RETURNS text[]
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
    ELSE NULL
  END;
$$;

-- The union for one batch, in the closed set's own order. A usage-bearing tick or stop adds `usage`. Any unknown kind: every panel.
CREATE FUNCTION engine_panels_union(p_kinds text[], p_usage boolean) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  every text[] := ARRAY['agents', 'lanes', 'gates', 'asks', 'log', 'plan', 'stats', 'usage', 'status'];
BEGIN
  IF p_kinds IS NULL OR EXISTS (SELECT 1 FROM unnest(p_kinds) k WHERE public.engine_kind_panels(k) IS NULL) THEN
    RETURN every;
  END IF;
  RETURN ARRAY(
    SELECT t.p FROM unnest(every) WITH ORDINALITY t(p, o)
     WHERE (p_usage AND t.p = 'usage') OR t.p = ANY (SELECT unnest(public.engine_kind_panels(k)) FROM unnest(p_kinds) k)
     ORDER BY t.o);
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
  SELECT n.revoked_at, n.allowed_repo_ids INTO v_revoked, v_allowed FROM public.runners n WHERE n.id = p_runner AND n.account_id = p_account;
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

  -- The runner's own facts (`bridge_*`) live in a session of their own: a batch is all of them or none, and a session keeps the kind it was made with.
  SELECT count(*) INTO v_nb FROM jsonb_array_elements(p_events) x WHERE x ->> 'kind' IN ('bridge_heartbeat', 'bridge_dropped');
  IF v_nb NOT IN (0, v_n) THEN
    RETURN QUERY SELECT 'invalid_message'::text, 0, 0, NULL::bigint, NULL::int, NULL::uuid, '[]'::jsonb; RETURN;
  END IF;
  v_kind := CASE WHEN v_nb = 0 THEN 'engine' ELSE 'bridge' END;

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
  IF v_sess.last_seq IS NOT NULL AND (p_events -> 0 ->> 'seq')::bigint <= v_sess.last_seq THEN
    RETURN QUERY SELECT 'seq_not_increasing'::text, 0, 0, v_sess.last_seq, NULL::int, v_sess.id, '[]'::jsonb; RETURN;
  END IF;

  -- The quotas: 5000 events a session and 20000 a repo per UTC day; what would pass either is not stored.
  v_count := CASE WHEN v_sess.quota_day IS NOT DISTINCT FROM v_day THEN v_sess.quota_count ELSE 0 END;
  v_take := LEAST(v_n, GREATEST(0, 5000 - v_count), GREATEST(0, 20000 - v_rcount));
  IF v_take < v_n THEN v_outcome := 'quota'; END IF;

  v_prev := v_sess.last_seq;
  v_prev_ts := (SELECT ev.ts FROM public.engine_events ev WHERE ev.session_id = v_sess.id AND ev.seq = v_sess.last_seq);
  FOR i IN 0 .. v_take - 1 LOOP
    e := p_events -> i;
    kind := e ->> 'kind';
    b := COALESCE(e -> 'body', '{}'::jsonb);
    s := (e ->> 'seq')::bigint;
    ts := (e ->> 'ts')::timestamptz;
    -- A hole in the numbers is recorded and the batch goes on. The first event of a session is expected at 0.
    IF s > COALESCE(v_prev + 1, 0) THEN
      INSERT INTO public.engine_session_gaps (account_id, session_id, from_seq, to_seq, before_ts) VALUES (p_account, v_sess.id, COALESCE(v_prev + 1, 0), s - 1, v_prev_ts)
      ON CONFLICT DO NOTHING;
      v_gaps := v_gaps + 1;
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

    IF kind IN ('engine_heartbeat', 'host_heartbeat', 'bridge_heartbeat') THEN v_hb := true; END IF;
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
    last_seq = COALESCE(v_prev, x.last_seq), seq_gaps = x.seq_gaps + v_gaps, engine_version = p_version,
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

-- ---- ownership and grants: 1027's, re-asserted -----------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb) FROM PUBLIC;
-- The two pure helpers: nobody but the definer (the ingest runs as it) may call them.
REVOKE ALL ON FUNCTION engine_kind_panels(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_panels_union(text[], boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION engine_kind_panels(text) TO engine_bridge_definer;
GRANT EXECUTE ON FUNCTION engine_panels_union(text[], boolean) TO engine_bridge_definer;
ALTER FUNCTION engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb) OWNER TO engine_bridge_definer;
ALTER FUNCTION engine_kind_panels(text) OWNER TO engine_bridge_definer;
ALTER FUNCTION engine_panels_union(text[], boolean) OWNER TO engine_bridge_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION engine_kind_panels(text) TO engine_bridge_definer;
GRANT EXECUTE ON FUNCTION engine_panels_union(text[], boolean) TO engine_bridge_definer;

REVOKE CREATE ON SCHEMA public FROM engine_bridge_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE engine_bridge_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- the nudge trigger gains engine.changed ----------------------------------------------------------------------------------------------------
-- Same function and timing as 0652; only the WHEN list widens. A broader list adds commit-time contention for every producer of the added type: here one
-- notification per stored engine batch, which the bridge already bounds (at most one upload per flush).
DROP TRIGGER domain_events_nudge ON domain_events;
CREATE TRIGGER domain_events_nudge
  AFTER INSERT ON domain_events
  FOR EACH ROW
  WHEN (NEW.type IN ('session.revoked', 'api_token.created', 'api_token.revoked', 'engine.changed'))
  EXECUTE FUNCTION domain_events_nudge();
