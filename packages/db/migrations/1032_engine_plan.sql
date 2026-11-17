-- Engine bridge EB-7: the plan and roadmap a person's engine reports, assembled into one stored snapshot per repo.
--
-- The engine sends a `plan_snapshot` in chunks (at most 500 rows an event; every chunk carries the same `snapshot_id`, its own `chunk_index` and the
-- `chunk_count`). Each chunk is kept as the event it arrived in (engine_events, 1027) and, as the event is stored, also here:
--
--   engine_plan_chunks     the chunks of a snapshot that has not fully arrived. A snapshot is applied only when every chunk is here; a chunk
--                          that disagrees with the first one on the chunk count or the date is not kept (the event itself still is).
--   engine_plan_snapshots  one row per (session, plan date): the newest COMPLETE snapshot of that date. A partial snapshot never reaches this
--                          table, so it can never replace a complete one, and what a screen reads is always a snapshot that was whole.
--
-- Which snapshot is "the latest" for a repo: the one completed last (received_at, then the seq of the completing chunk). Inside one session a snapshot
-- that finishes after a later-started one is dropped, so a straggling chunk cannot put older data over newer. The age stamp is `snapshot_at`
-- (the engine's own time on the completing chunk, never later than now); the age in seconds is derived on read, never stored.
--
-- Assembly is a row trigger on engine_events. engine_events_ingest (1027) stays exactly as it is: its insert fires the trigger, which runs as the ingest's own
-- owner (engine_bridge_definer, with the account in the session) and so under the same row policies. The trigger never raises for a bad chunk: a poisoned
-- batch would be resent for ever, so a chunk it cannot use is left unused and the event is stored as it always was.
--
-- Size: a chunk holds at most 300 items and 500 roadmap rows, the same two caps as the ingest's body check (1027) and the runner-protocol schema, so the
-- table's CHECKs can never refuse what the ingest let through. A whole snapshot holds at most 1000 items and 3000 roadmap rows in all (a few hundred KB read
-- in one response); a snapshot that would be larger is not built and its chunks are dropped, the events staying in the log.
--
-- Retention: 14 days of snapshots and of unfinished chunks, by engine_plan_prune(n), called from the existing daily reconcile job.
--
-- Numbered 1032 by the Team Lead (the v1.9 addendum moved EB-7 off 1028); it merges after 1027, in number order.

CREATE TABLE engine_plan_chunks (
  account_id   uuid NOT NULL,
  session_id   uuid NOT NULL,
  snapshot_id  text NOT NULL CHECK (snapshot_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  chunk_index  integer NOT NULL CHECK (chunk_index >= 0),
  chunk_count  integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 100),
  plan_date    date NOT NULL,
  seq          bigint NOT NULL CHECK (seq >= 0),
  items        jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 300),
  roadmap      jsonb NOT NULL CHECK (jsonb_typeof(roadmap) = 'array' AND jsonb_array_length(roadmap) <= 500),
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, snapshot_id, chunk_index),
  CHECK (chunk_index < chunk_count),
  FOREIGN KEY (account_id, session_id) REFERENCES engine_sessions (account_id, id) ON DELETE CASCADE
);
CREATE INDEX engine_plan_chunks_received ON engine_plan_chunks (received_at);

CREATE TABLE engine_plan_snapshots (
  account_id     uuid NOT NULL,
  session_id     uuid NOT NULL,
  repo_id        uuid NOT NULL,
  plan_date      date NOT NULL,
  snapshot_id    text NOT NULL CHECK (snapshot_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  chunk_count    integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 100),
  items          jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  roadmap        jsonb NOT NULL CHECK (jsonb_typeof(roadmap) = 'array'),
  started_seq    bigint NOT NULL CHECK (started_seq >= 0),
  completed_seq  bigint NOT NULL CHECK (completed_seq >= started_seq),
  snapshot_at    timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, plan_date),
  FOREIGN KEY (account_id, session_id) REFERENCES engine_sessions (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);
CREATE INDEX engine_plan_snapshots_latest ON engine_plan_snapshots (account_id, repo_id, received_at DESC, completed_seq DESC);

-- ---- row security, grants -----------------------------------------------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  acct text := 'account_id = NULLIF(current_setting(''app.account_id'', true), '''')::uuid';
BEGIN
  FOREACH t IN ARRAY ARRAY['engine_plan_chunks', 'engine_plan_snapshots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- Readers: the account's own members, through the API.
    EXECUTE format('GRANT SELECT ON %I TO app_user', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR SELECT TO app_user USING (%s AND (SELECT account_is_active(NULLIF(current_setting(''app.account_id'', true), '''')::uuid)))', t, acct);
    -- The assembling trigger runs as the ingest's owner, for the session's own account. A chunk is only ever inserted and deleted (no UPDATE grant); a
    -- snapshot is also upserted, so it keeps UPDATE.
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON %I TO engine_bridge_definer', t);
    IF t = 'engine_plan_snapshots' THEN EXECUTE format('GRANT UPDATE ON %I TO engine_bridge_definer', t); END IF;
    EXECUTE format('CREATE POLICY engine_bridge_definer_rw ON %I FOR ALL TO engine_bridge_definer USING (%s) WITH CHECK (%s)', t, acct, acct);
    -- The prune reaches every account's rows older than the window and nothing newer.
    EXECUTE format('CREATE POLICY engine_bridge_definer_prune_select ON %I FOR SELECT TO engine_bridge_definer USING (received_at < now() - interval ''14 days'')', t);
    EXECUTE format('CREATE POLICY engine_bridge_definer_prune_delete ON %I FOR DELETE TO engine_bridge_definer USING (received_at < now() - interval ''14 days'')', t);
  END LOOP;
END
$$;

-- ---- assembly ----------------------------------------------------------------------------------------------------------------------------------

-- SECURITY INVOKER on purpose: it adds nothing to what the ingest's owner may do. The event's body is already closed (engine_body_closed), so only the
-- cases the shape check cannot see are handled here, each by leaving the chunk unused.
CREATE FUNCTION engine_plan_assemble() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b          jsonb := NEW.body;
  v_snap     text := b ->> 'snapshot_id';
  v_idx      integer := (b ->> 'chunk_index')::integer;
  v_count    integer := (b ->> 'chunk_count')::integer;
  v_date     date;
  v_repo     uuid;
  v_have     integer;
  v_started  bigint;
  v_n_items  bigint;
  v_n_road   bigint;
  v_items    jsonb;
  v_roadmap  jsonb;
BEGIN
  BEGIN
    v_date := (b ->> 'plan_date')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN NEW;  -- a date that matches the pattern but is not one (2026-13-45): the event is kept, the snapshot is not built
  END;

  -- A chunk of a snapshot that is already stored is a resend.
  IF EXISTS (SELECT 1 FROM public.engine_plan_snapshots s WHERE s.session_id = NEW.session_id AND s.snapshot_id = v_snap) THEN RETURN NEW; END IF;
  -- The first chunk fixes the snapshot's date and size; one that disagrees is not kept.
  IF EXISTS (SELECT 1 FROM public.engine_plan_chunks c WHERE c.session_id = NEW.session_id AND c.snapshot_id = v_snap AND (c.chunk_count <> v_count OR c.plan_date <> v_date)) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.engine_plan_chunks (account_id, session_id, snapshot_id, chunk_index, chunk_count, plan_date, seq, items, roadmap)
  VALUES (NEW.account_id, NEW.session_id, v_snap, v_idx, v_count, v_date, NEW.seq, b -> 'items', b -> 'roadmap')
  ON CONFLICT (session_id, snapshot_id, chunk_index) DO NOTHING;

  SELECT count(*), min(c.seq), COALESCE(sum(jsonb_array_length(c.items)), 0), COALESCE(sum(jsonb_array_length(c.roadmap)), 0)
    INTO v_have, v_started, v_n_items, v_n_road
    FROM public.engine_plan_chunks c WHERE c.session_id = NEW.session_id AND c.snapshot_id = v_snap;
  IF v_n_items > 1000 OR v_n_road > 3000 THEN  -- larger than a snapshot may be: not built, and what has arrived of it is dropped
    DELETE FROM public.engine_plan_chunks c WHERE c.session_id = NEW.session_id AND c.snapshot_id = v_snap;
    RETURN NEW;
  END IF;
  IF v_have < v_count THEN RETURN NEW; END IF;  -- not whole yet: nothing a screen reads changes

  -- Whole. It is stored unless a snapshot that started later has already been stored for this session.
  IF NOT EXISTS (SELECT 1 FROM public.engine_plan_snapshots s WHERE s.session_id = NEW.session_id AND s.started_seq > v_started) THEN
    SELECT COALESCE(jsonb_agg(e.value ORDER BY c.chunk_index, e.ord), '[]'::jsonb) INTO v_items
      FROM public.engine_plan_chunks c CROSS JOIN LATERAL jsonb_array_elements(c.items) WITH ORDINALITY AS e(value, ord)
     WHERE c.session_id = NEW.session_id AND c.snapshot_id = v_snap;
    SELECT COALESCE(jsonb_agg(e.value ORDER BY c.chunk_index, e.ord), '[]'::jsonb) INTO v_roadmap
      FROM public.engine_plan_chunks c CROSS JOIN LATERAL jsonb_array_elements(c.roadmap) WITH ORDINALITY AS e(value, ord)
     WHERE c.session_id = NEW.session_id AND c.snapshot_id = v_snap;
    SELECT x.repo_id INTO v_repo FROM public.engine_sessions x WHERE x.id = NEW.session_id AND x.account_id = NEW.account_id;
    IF v_repo IS NOT NULL THEN
      INSERT INTO public.engine_plan_snapshots AS p (account_id, session_id, repo_id, plan_date, snapshot_id, chunk_count, items, roadmap, started_seq, completed_seq, snapshot_at)
      VALUES (NEW.account_id, NEW.session_id, v_repo, v_date, v_snap, v_count, v_items, v_roadmap, v_started, NEW.seq, LEAST(NEW.ts, now()))
      ON CONFLICT (session_id, plan_date) DO UPDATE
        SET snapshot_id = EXCLUDED.snapshot_id, chunk_count = EXCLUDED.chunk_count, items = EXCLUDED.items, roadmap = EXCLUDED.roadmap,
            started_seq = EXCLUDED.started_seq, completed_seq = EXCLUDED.completed_seq, snapshot_at = EXCLUDED.snapshot_at, received_at = now()
        WHERE p.started_seq < EXCLUDED.started_seq;
    END IF;
  END IF;
  DELETE FROM public.engine_plan_chunks c WHERE c.session_id = NEW.session_id AND c.snapshot_id = v_snap;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION engine_plan_assemble() FROM PUBLIC;

CREATE TRIGGER engine_events_plan_assemble AFTER INSERT ON engine_events
  FOR EACH ROW WHEN (NEW.kind = 'plan_snapshot') EXECUTE FUNCTION engine_plan_assemble();

-- ---- retention ---------------------------------------------------------------------------------------------------------------------------------

-- Snapshots and unfinished chunks received more than 14 days ago, a batch at a time; the input is a batch size and nothing else. Returns how many rows went.
CREATE FUNCTION engine_plan_prune(p_limit integer) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n integer;
  m integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'engine_plan_prune: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.engine_plan_snapshots s
   WHERE (s.session_id, s.plan_date) IN (SELECT o.session_id, o.plan_date FROM public.engine_plan_snapshots o WHERE o.received_at < now() - interval '14 days' LIMIT p_limit);
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM public.engine_plan_chunks c
   WHERE (c.session_id, c.snapshot_id, c.chunk_index) IN (SELECT o.session_id, o.snapshot_id, o.chunk_index FROM public.engine_plan_chunks o WHERE o.received_at < now() - interval '14 days' LIMIT p_limit - n);
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END;
$$;

-- ---- ownership: the migration role holds the definer only to hand the function over ------------------------------------------------------------
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

REVOKE ALL ON FUNCTION engine_plan_prune(integer) FROM PUBLIC;
ALTER FUNCTION engine_plan_prune(integer) OWNER TO engine_bridge_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION engine_plan_prune(integer) TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM engine_bridge_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE engine_bridge_definer FROM CURRENT_USER;
  END IF;
END
$$;
