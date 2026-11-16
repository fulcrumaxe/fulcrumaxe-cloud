-- Engine bridge EB-4: what a person's own engine (the autonomous team on their machine) reports to the cloud, and the read model built from it.
--
-- The engine sends closed facts only: ids, enums, counts, timestamps. Every figure on a screen (cost, totals, rates, medians) is computed by the
-- cloud's own code from those facts, so no event may carry a dollar or total field and none may carry prose.
--
-- Tables, all with account_id and row security forced (app_user reads its own account's rows):
--   engine_bridge_settings   the per-account watch / operate switches, off by default (writes: an owner or admin on a session, never a token)
--   engine_bridge_repos      the repos the account ticked
--   engine_sessions          one per (repo, engine instance); a new instance id is a new session, so a reset is never read as a gap. session_kind tells the
--                            engine's own sessions from the runner's bridge sessions (v1.6); both are merged when a repo's freshness is read
--   engine_repo_quota        the day's accepted-event count for a (account, repo) across all its sessions (20000)
--   engine_events            every accepted event; the body is held closed by engine_body_closed(kind, body), also as a CHECK
--   engine_agents, engine_lanes, engine_gate_receipts, engine_asks   the read model, written in the same transaction as the event
--   engine_session_gaps      every hole in a session's seq numbers, kept for good (ordering is strict, so a gap is never filled)
--   engine_agent_usage       tokens per agent or tick, and the cloud's own API-equivalent figure (columns copied from runner_run_usage, 0768)
--
-- Writers. Only the definers below write the event tables; app_user reads. The runner reaches engine_events_ingest through its signed session
-- (app.runner_id is set only by withRunnerSession); the account and runner come from the session, never from an argument.
--
--   engine_events_ingest(...)  the one door for events. Refused first: a runner of an account that is not active. Then, in order: watch switch off, repo
--                              not enabled / not runner_local / not allowed for the runner, instance bound to another runner, a body outside the
--                              closed shape, seq order. A first seq at or below the last stored one is refused with the last stored seq. A hole
--                              is accepted and recorded. At most 5000 events a session and 20000 events a (account, repo), both per UTC day, and
--                              what would pass either is not stored. One `engine.changed` notice (ids only) is written per batch that stored
--                              something, in the batch's own transaction.
--   engine_usage_price(...)    the cloud's recomputed figure for one subject (the caller prices with packages/spend; nothing the engine sent as a
--                              dollar amount exists to be read).
--   engine_data_delete()       an owner removes every session of the account (events and the read model cascade).
--   engine_events_prune(n)     deletes events received more than 30 days ago, a batch at a time (the reconciler's daily job).
--
-- All four belong to engine_bridge_definer (NOLOGIN, no members outside this file's bracket, a member of nothing), with column grants for what the
-- bodies touch and row policies for this role only. Refusals use fixed SQLSTATEs and messages, never an argument value.
--
-- Numbered 1027 by the Team Lead; it merges after 1026 (EB-14), in number order.

DO $$
DECLARE
  n text := 'engine_bridge_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

-- ---- the closed shape of an event body ---------------------------------------------------------------------------------------------------------

-- One value against one type tag: bool, int (0 to 1e15), pos (1 to 1e15), e:<a|b|c> (an enum), r:<regex>, or a structured tag.
CREATE FUNCTION engine_value_ok(p_v jsonb, p_tag text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  t text := jsonb_typeof(p_v);
  s text;
  r jsonb;
BEGIN
  IF t IS NULL THEN RETURN false; END IF;
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

-- Any key named for prose, a branch or path, a dollar figure or a total, at any depth. The same names as the runner-protocol schema's ENGINE_FORBIDDEN_KEYS
-- (matched case-insensitively) and its `total_` prefix: this is the table's backstop and is never stricter than that scan.
CREATE FUNCTION engine_has_forbidden_key(p_v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  k text;
  c jsonb;
BEGIN
  IF jsonb_typeof(p_v) = 'object' THEN
    FOR k, c IN SELECT key, value FROM jsonb_each(p_v) LOOP
      IF lower(k) ~ '^(text|message|content|output|prompt|description|title|body|branch|path|usd|cost|cost_usd|price)$|^total_'
         OR public.engine_has_forbidden_key(c) THEN RETURN true; END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_v) = 'array' THEN
    FOR c IN SELECT value FROM jsonb_array_elements(p_v) LOOP
      IF public.engine_has_forbidden_key(c) THEN RETURN true; END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;

-- The fields of each kind: required and optional, by type tag. NULL for a kind that does not exist.
CREATE FUNCTION engine_kind_spec(p_kind text) RETURNS jsonb
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
    ELSE NULL
  END;
END;
$$;

-- True when `p_body` is exactly the closed shape of `p_kind`: an object whose keys are all declared for the kind, every required key present, every value of
-- its type, no key named for prose or money at any depth (a total or a dollar figure is the cloud's to compute). It is the backstop behind the runner-protocol
-- schema (EB-1, which the route applies first) and is never stricter than it: the same caps (300 plan items, 500 roadmap rows, 100 chunks), an empty roadmap
-- `row_key` allowed (a bare D#N row has one), and a size bound of twice EB-1's 64 KiB compact limit, because a jsonb's text form adds a space after every `:`
-- and `,` (at most half as much again as the compact form), so any body EB-1 accepts is under it.
-- The declared keys are checked first and cheaply (an undeclared key ends it), so a deeply nested body is refused before the recursive scan below ever walks it.
CREATE FUNCTION engine_body_closed(p_kind text, p_body jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  spec jsonb := public.engine_kind_spec(p_kind);
  k text;
  v jsonb;
BEGIN
  IF spec IS NULL OR p_body IS NULL OR jsonb_typeof(p_body) <> 'object' OR octet_length(p_body::text) > 131072 THEN RETURN false; END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(p_body) LOOP
    IF NOT public.engine_value_ok(v, COALESCE(spec->'req'->>k, spec->'opt'->>k, '-')) THEN RETURN false; END IF;
  END LOOP;
  FOR k IN SELECT jsonb_object_keys(spec->'req') LOOP
    IF NOT p_body ? k THEN RETURN false; END IF;
  END LOOP;
  -- The one object allowed a key like `output` is the token counts, which was checked on its own above.
  IF public.engine_has_forbidden_key(p_body - 'usage') THEN RETURN false; END IF;
  IF p_kind = 'plan_snapshot' THEN
    -- Chunked: the chunk is one of the snapshot's own, and a snapshot is at most 100 chunks.
    IF (p_body->>'chunk_index')::bigint >= (p_body->>'chunk_count')::bigint OR (p_body->>'chunk_count')::bigint > 100 THEN RETURN false; END IF;
  END IF;
  RETURN true;
END;
$$;

-- ---- tables ------------------------------------------------------------------------------------------------------------------------------------

CREATE TABLE engine_bridge_settings (
  account_id       uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  watch_enabled    boolean NOT NULL DEFAULT false,
  operate_enabled  boolean NOT NULL DEFAULT false,
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (watch_enabled OR NOT operate_enabled)
);

CREATE TABLE engine_bridge_repos (
  account_id  uuid NOT NULL,
  repo_id     uuid NOT NULL,
  enabled_by  uuid,
  enabled_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, repo_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);

CREATE TABLE engine_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  runner_id           uuid NOT NULL,
  repo_id             uuid NOT NULL,
  engine_instance_id  uuid NOT NULL,
  -- 'engine': the engine's own events. 'bridge': the runner's own `bridge_heartbeat` / `bridge_dropped` facts, in a session of their own (a fresh instance id
  -- per bridge process, its own seq from 0), so they never share the engine's seq space. Set once, when the session is created, from the batch's kinds.
  session_kind        text NOT NULL DEFAULT 'engine' CHECK (session_kind IN ('engine', 'bridge')),
  engine_version      text NOT NULL CHECK (engine_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  last_seq            bigint CHECK (last_seq IS NULL OR last_seq >= 0),
  seq_gaps            integer NOT NULL DEFAULT 0 CHECK (seq_gaps >= 0),
  first_event_at      timestamptz,
  last_event_at       timestamptz,
  last_heard_at       timestamptz,
  last_heartbeat_at   timestamptz,
  source_ages_s       jsonb CHECK (source_ages_s IS NULL OR engine_value_ok(source_ages_s, 'ages')),
  quota_day           date,
  quota_count         integer NOT NULL DEFAULT 0 CHECK (quota_count >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (repo_id, engine_instance_id),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);
-- Sessions of a repo are listed by the server's own clock (created_at), never by an event time the runner chose.
CREATE INDEX engine_sessions_repo ON engine_sessions (account_id, repo_id, created_at DESC);

-- The day's total of accepted events for one (account, repo) across every session of it, so minting sessions cannot multiply the per-session cap. One row a
-- repo, reset when the UTC day changes; written only by the ingest definer, and kept when an owner deletes the engine data (deleting must not refill the cap).
CREATE TABLE engine_repo_quota (
  account_id   uuid NOT NULL,
  repo_id      uuid NOT NULL,
  quota_day    date NOT NULL,
  quota_count  integer NOT NULL DEFAULT 0 CHECK (quota_count >= 0),
  PRIMARY KEY (account_id, repo_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);

CREATE TABLE engine_events (
  session_id   uuid NOT NULL,
  seq          bigint NOT NULL CHECK (seq >= 0),
  account_id   uuid NOT NULL,
  ts           timestamptz NOT NULL,
  kind         text NOT NULL,
  body         jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (account_id, session_id) REFERENCES engine_sessions (account_id, id) ON DELETE CASCADE,
  CONSTRAINT engine_events_kind_known CHECK (engine_kind_spec(kind) IS NOT NULL),
  CONSTRAINT engine_events_body_closed CHECK (engine_body_closed(kind, body))
);
CREATE INDEX engine_events_received ON engine_events (received_at);
CREATE INDEX engine_events_log ON engine_events (session_id, seq DESC) WHERE kind = 'team_log_line';

CREATE TABLE engine_agents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL,
  session_id  uuid NOT NULL,
  spawn_id    text,
  agent_id    text,
  role        text NOT NULL,
  discussion  bigint,
  pr          bigint,
  background  boolean,
  isolation   text,
  model       text,
  started_at  timestamptz,
  stopped_at  timestamptz,
  verdict     text,
  duration_s  bigint,
  UNIQUE (session_id, spawn_id),
  UNIQUE (session_id, agent_id),
  CHECK (spawn_id IS NOT NULL OR agent_id IS NOT NULL),
  FOREIGN KEY (account_id, session_id) REFERENCES engine_sessions (account_id, id) ON DELETE CASCADE
);
CREATE INDEX engine_agents_open ON engine_agents (session_id, started_at DESC);

CREATE TABLE engine_lanes (
  account_id  uuid NOT NULL,
  session_id  uuid NOT NULL,
  pr          bigint NOT NULL,
  discussion  bigint,
  state       text NOT NULL,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (session_id, pr),
  FOREIGN KEY (account_id, session_id) REFERENCES engine_sessions (account_id, id) ON DELETE CASCADE
);

-- One row per distinct (pr, gate, result, head sha): the same label applied twice is one receipt.
CREATE TABLE engine_gate_receipts (
  account_id  uuid NOT NULL,
  session_id  uuid NOT NULL,
  pr          bigint NOT NULL,
  gate        text NOT NULL,
  result      text NOT NULL,
  head_sha    text NOT NULL,
  at          timestamptz NOT NULL,
  PRIMARY KEY (session_id, pr, gate, result, head_sha),
  FOREIGN KEY (account_id, session_id) REFERENCES engine_sessions (account_id, id) ON DELETE CASCADE
);

CREATE TABLE engine_asks (
  account_id  uuid NOT NULL,
  session_id  uuid NOT NULL,
  ask_id      text NOT NULL,
  ask_kind    text NOT NULL,
  source      text NOT NULL,
  discussion  bigint,
  pr          bigint,
  raised_at   timestamptz NOT NULL,
  cleared_at  timestamptz,
  how         text,
  PRIMARY KEY (session_id, ask_id),
  FOREIGN KEY (account_id, session_id) REFERENCES engine_sessions (account_id, id) ON DELETE CASCADE
);

CREATE TABLE engine_session_gaps (
  account_id   uuid NOT NULL,
  session_id   uuid NOT NULL,
  from_seq     bigint NOT NULL,
  to_seq       bigint NOT NULL,
  before_ts    timestamptz,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, from_seq),
  CHECK (to_seq >= from_seq),
  FOREIGN KEY (account_id, session_id) REFERENCES engine_sessions (account_id, id) ON DELETE CASCADE
);

-- One row per agent or tick. Same columns and checks as runner_run_usage (0768), plus where it came from. Information only: it is never spend, and
-- no cap, reservation or envelope reads it.
CREATE TABLE engine_agent_usage (
  account_id           uuid NOT NULL,
  session_id           uuid NOT NULL,
  subject_kind         text NOT NULL CHECK (subject_kind IN ('agent', 'tick')),
  subject_id           text NOT NULL CHECK (subject_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  source_seqs          bigint[] NOT NULL DEFAULT '{}',
  credential_mode      text NOT NULL CHECK (credential_mode IN ('subscription', 'api_key')),
  model                text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 128),
  input_tokens         bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens        bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens    bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens   bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  api_equivalent_usd   numeric(12, 4) CHECK (api_equivalent_usd IS NULL OR api_equivalent_usd >= 0),
  price_table_version  text CHECK (price_table_version IS NULL OR length(price_table_version) BETWEEN 1 AND 64),
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, subject_kind, subject_id),
  CHECK ((api_equivalent_usd IS NULL) = (price_table_version IS NULL)),
  FOREIGN KEY (account_id, session_id) REFERENCES engine_sessions (account_id, id) ON DELETE CASCADE
);
CREATE INDEX engine_agent_usage_period ON engine_agent_usage (account_id, recorded_at);

-- ---- row security, grants -----------------------------------------------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  acct text := 'account_id = NULLIF(current_setting(''app.account_id'', true), '''')::uuid';
BEGIN
  FOREACH t IN ARRAY ARRAY['engine_bridge_settings', 'engine_bridge_repos', 'engine_sessions', 'engine_events', 'engine_agents', 'engine_lanes',
                           'engine_gate_receipts', 'engine_asks', 'engine_session_gaps', 'engine_agent_usage', 'engine_repo_quota'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- Readers: the account's own members, through the API.
    EXECUTE format('GRANT SELECT ON %I TO app_user', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR SELECT TO app_user USING (%s AND (SELECT account_is_active(NULLIF(current_setting(''app.account_id'', true), '''')::uuid)))', t, acct);
  END LOOP;
  -- The definer's rows: its own account's, for every table it writes.
  FOREACH t IN ARRAY ARRAY['engine_sessions', 'engine_agents', 'engine_lanes', 'engine_gate_receipts', 'engine_asks', 'engine_session_gaps', 'engine_agent_usage', 'engine_repo_quota'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO engine_bridge_definer', t);
    EXECUTE format('CREATE POLICY engine_bridge_definer_rw ON %I FOR ALL TO engine_bridge_definer USING (%s) WITH CHECK (%s)', t, acct, acct);
  END LOOP;
END
$$;

-- The two switches: written by a person who is an owner or admin of the account, on a session (a token principal sets app.token_id and is refused).
-- plpgsql, so the body is looked up when it runs (0005's current_member_role need not exist yet when this file is applied to a database that is missing 0005).
CREATE FUNCTION engine_bridge_may_configure() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN COALESCE(current_member_role(), '') IN ('owner', 'admin') AND COALESCE(NULLIF(current_setting('app.token_id', true), ''), '') = '';
END;
$$;
REVOKE ALL ON FUNCTION engine_bridge_may_configure() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION engine_bridge_may_configure() TO app_user;

GRANT INSERT, UPDATE ON engine_bridge_settings TO app_user;
GRANT INSERT, DELETE ON engine_bridge_repos TO app_user;
CREATE POLICY configure_insert ON engine_bridge_settings FOR INSERT TO app_user
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT engine_bridge_may_configure()));
CREATE POLICY configure_update ON engine_bridge_settings FOR UPDATE TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT engine_bridge_may_configure()))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT engine_bridge_may_configure()));
CREATE POLICY configure_insert ON engine_bridge_repos FOR INSERT TO app_user
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT engine_bridge_may_configure()));
CREATE POLICY configure_delete ON engine_bridge_repos FOR DELETE TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT engine_bridge_may_configure()));

-- What the definer bodies read besides their own tables.
GRANT USAGE ON SCHEMA public TO engine_bridge_definer;
GRANT SELECT ON engine_bridge_settings, engine_bridge_repos TO engine_bridge_definer;
GRANT SELECT (id, account_id, gh_repo_id, execution_mode) ON repos TO engine_bridge_definer;
GRANT SELECT (id, account_id, revoked_at, allowed_repo_ids) ON runners TO engine_bridge_definer;
-- account_is_active() reads these two columns as its caller (the same grant and policy the other runner definers hold).
GRANT SELECT (id, deleted_at) ON accounts TO engine_bridge_definer;
CREATE POLICY engine_bridge_definer_select ON accounts FOR SELECT TO engine_bridge_definer USING (true);
-- engine_data_delete() checks the caller's role itself. current_member_role() belongs to guard_definer (0721), whose EXECUTE list the neon-shape
-- gate pins to app_user and platform_ops, so this definer reads the same three columns directly, for the session's own account only.
GRANT SELECT (account_id, user_id, role) ON account_members TO engine_bridge_definer;
-- Only the caller's own row (as 0757 and 0770 do): nothing the definer's bodies do needs another member's.
CREATE POLICY engine_bridge_definer_select ON account_members FOR SELECT TO engine_bridge_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
GRANT DELETE ON engine_sessions TO engine_bridge_definer;
GRANT DELETE ON engine_agents TO engine_bridge_definer;
GRANT SELECT, INSERT, DELETE ON engine_events TO engine_bridge_definer;
CREATE POLICY engine_bridge_definer_select ON engine_events FOR SELECT TO engine_bridge_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_bridge_definer_insert ON engine_events FOR INSERT TO engine_bridge_definer WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_bridge_definer_select ON engine_bridge_settings FOR SELECT TO engine_bridge_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_bridge_definer_select ON engine_bridge_repos FOR SELECT TO engine_bridge_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_bridge_definer_select ON repos FOR SELECT TO engine_bridge_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_bridge_definer_select ON runners FOR SELECT TO engine_bridge_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- The prune reaches every account's old events and nothing newer than 30 days, and only in a session with no tenant set (the reconciler's platform_ops
-- login). The policies apply to the role, not to the prune function, so a body that runs for a tenant never sees another account's old events through them.
CREATE POLICY engine_bridge_definer_prune_select ON engine_events FOR SELECT TO engine_bridge_definer
  USING (received_at < now() - interval '30 days' AND NULLIF(current_setting('app.account_id', true), '') IS NULL);
CREATE POLICY engine_bridge_definer_prune_delete ON engine_events FOR DELETE TO engine_bridge_definer
  USING (received_at < now() - interval '30 days' AND NULLIF(current_setting('app.account_id', true), '') IS NULL);
-- engine.changed: the ingest writes its one change notice itself, in the batch's transaction (ids only, the account's own).
GRANT INSERT ON domain_events TO engine_bridge_definer;
GRANT USAGE ON SEQUENCE domain_events_seq_seq TO engine_bridge_definer;
CREATE POLICY engine_bridge_definer_insert ON domain_events FOR INSERT TO engine_bridge_definer
  WITH CHECK (type = 'engine.changed' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---- ingest ------------------------------------------------------------------------------------------------------------------------------------

CREATE FUNCTION engine_events_ingest(p_account uuid, p_runner uuid, p_repo_gh_id bigint, p_instance uuid, p_version text, p_events jsonb)
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
  -- One change notice per batch that stored something (ids only), in this transaction: it exists exactly when the rows it announces do.
  IF v_stored > 0 THEN
    INSERT INTO public.domain_events (account_id, type, subject_id, payload)
    VALUES (p_account, 'engine.changed', v_repo::text, jsonb_build_object('repo_id', v_repo, 'session_id', v_sess.id, 'last_seq', v_prev));
  END IF;
  RETURN QUERY SELECT v_outcome, v_stored, v_dup, v_prev, CASE WHEN v_outcome = 'quota' THEN v_retry END, v_sess.id, v_usage;
END;
$$;

-- The cloud's own figure for one subject (a number the caller computed from the totals with the price tables). Only the runner that owns the session.
CREATE FUNCTION engine_usage_price(p_account uuid, p_session uuid, p_kind text, p_subject text, p_usd numeric, p_version text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_runner uuid := NULLIF(current_setting('app.runner_id', true), '')::uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'engine_usage_price: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account IS NULL OR p_session IS NULL OR p_kind NOT IN ('agent', 'tick') OR p_subject IS NULL OR p_usd IS NULL OR p_version IS NULL
     OR p_usd < 0 OR length(p_version) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'engine_usage_price: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid OR v_runner IS NULL OR NOT public.account_is_active(p_account)
     OR NOT EXISTS (SELECT 1 FROM public.engine_sessions x WHERE x.id = p_session AND x.account_id = p_account AND x.runner_id = v_runner) THEN
    RAISE EXCEPTION 'engine_usage_price: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A figure at or past 1e8 dollars does not fit numeric(12, 4); the tokens stay and the figure is left empty rather than failing the batch.
  UPDATE public.engine_agent_usage u SET api_equivalent_usd = CASE WHEN p_usd >= 100000000 THEN NULL ELSE p_usd END, price_table_version = CASE WHEN p_usd >= 100000000 THEN NULL ELSE p_version END
   WHERE u.session_id = p_session AND u.account_id = p_account AND u.subject_kind = p_kind AND u.subject_id = p_subject;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engine_usage_price: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- "Delete engine data": an owner, on a session, removes every session of the account; events and the read model go with them. The switches stay.
CREATE FUNCTION engine_data_delete() RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  n integer;
BEGIN
  IF session_user = 'platform_ops' OR v_acct IS NULL OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = v_acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner') OR COALESCE(NULLIF(current_setting('app.token_id', true), ''), '') <> '' THEN
    RAISE EXCEPTION 'engine_data_delete: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.engine_sessions WHERE account_id = v_acct;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Retention: events received more than 30 days ago, a batch at a time. The input is a batch size and nothing else.
CREATE FUNCTION engine_events_prune(p_limit integer) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'engine_events_prune: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.engine_events e
   WHERE (e.session_id, e.seq) IN (SELECT o.session_id, o.seq FROM public.engine_events o WHERE o.received_at < now() - interval '30 days' LIMIT p_limit);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ---- ownership: the migration role holds the definer only to hand the functions over -------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'engine_bridge_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_bridge_definer; cannot ALTER FUNCTION ... OWNER TO engine_bridge_definer';
    END IF;
    GRANT engine_bridge_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO engine_bridge_definer;

REVOKE ALL ON FUNCTION engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_usage_price(uuid, uuid, text, text, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_data_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_events_prune(integer) FROM PUBLIC;
-- The four pure helpers the body CHECKs and the ingest use: nobody but the definer may call them (the CHECKs run as the writer, and every writer is the definer's own function).
REVOKE ALL ON FUNCTION engine_value_ok(jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_has_forbidden_key(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_kind_spec(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_body_closed(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION engine_value_ok(jsonb, text) TO engine_bridge_definer;
GRANT EXECUTE ON FUNCTION engine_has_forbidden_key(jsonb) TO engine_bridge_definer;
GRANT EXECUTE ON FUNCTION engine_kind_spec(text) TO engine_bridge_definer;
GRANT EXECUTE ON FUNCTION engine_body_closed(text, jsonb) TO engine_bridge_definer;
ALTER FUNCTION engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb) OWNER TO engine_bridge_definer;
ALTER FUNCTION engine_usage_price(uuid, uuid, text, text, numeric, text) OWNER TO engine_bridge_definer;
ALTER FUNCTION engine_data_delete() OWNER TO engine_bridge_definer;
ALTER FUNCTION engine_events_prune(integer) OWNER TO engine_bridge_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION engine_events_ingest(uuid, uuid, bigint, uuid, text, jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION engine_usage_price(uuid, uuid, text, text, numeric, text) TO app_user;
GRANT EXECUTE ON FUNCTION engine_data_delete() TO app_user;
GRANT EXECUTE ON FUNCTION engine_events_prune(integer) TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM engine_bridge_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE engine_bridge_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- The reconcile job that calls the prune, once a day (a job with no row is never due). Safe to re-run.
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('engine_events_prune', 86400) ON CONFLICT (name) DO NOTHING;

-- ---- the capability: a hello that declares 'engine_bridge_v1' must store ----------------------------------------------------------------------
-- The closed capability list and runner_capabilities_record widen by one value, from 1021's fourteen; everything else of the function is 1021's, verbatim.
ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1']::text[]));

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
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1']))
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
