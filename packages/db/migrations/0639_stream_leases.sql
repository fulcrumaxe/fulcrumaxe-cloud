-- D#31 API-5: the v1 SSE stream's database surface.
--
-- Numbered 0639 (the Spec's 0330 is illustrative only -- D#94 R1/R2):
-- main's newest migration is 0635. The migration-order checker only
-- requires a new file to sort after everything on the base.
--
-- Three things live here:
--
--   1. stream_leases: one row per open stream, expiring 90 s after its
--      last renewal, so a killed process frees its slot on its own. The
--      caps (3 streams per user and 25 per account for sessions, 2/5/10
--      per tenant by plan for tokens) are counted from this table under a
--      per-account advisory lock, so two concurrent opens cannot both
--      slip under a cap. Under FORCE ROW LEVEL SECURITY with a plain
--      tenant policy: a lease in one account is invisible to every other
--      account, so a lease can be neither seen, renewed, released nor
--      counted across tenants. app_user only -- nothing here is reachable
--      from a client.
--
--   2. domain_event_watermarks(uuid[]): the shared poll's change check.
--      Returns, for each account id the SERVER passes in, the highest
--      domain_events.seq and whether a run is live -- and nothing else (no
--      event body, type or id). It is the "platform_ops watermark read"
--      D#31 resolved disagreement 18 flagged for this task's security
--      review: the private serial it returns never reaches a client
--      (streams seal it into an AES-GCM cursor), and only platform_ops --
--      the server's own privileged pool -- may execute it. app_user, and
--      therefore any tenant-scoped code path, cannot.
--
--   3. stream_json_poll_check(uuid, int): the 6-per-minute cap on a
--      token's JSON polling of the two event routes ("A token's 7th poll
--      in one minute -> 429"). rate_limit_check (0622) accepts exactly
--      three bucket-key shapes and that file is never edited, so this
--      is its own small definer over the same rate_limit_windows table,
--      under its own `json-poll:` key namespace, tenant-bound the same
--      way rate_limit_check binds a `token:` key (M2 of 0622).

CREATE TABLE stream_leases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- 'session' (a browser cookie) or 'token' (an API token): the two are
  -- capped separately.
  kind          text NOT NULL CHECK (kind IN ('session', 'token')),
  -- The user id for a session, the api_tokens id for a token.
  principal_key uuid NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The cap count and the expired-row sweep both filter by account first.
CREATE INDEX idx_stream_leases_account_kind ON stream_leases (account_id, kind, expires_at);

ALTER TABLE stream_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE stream_leases FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON stream_leases TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- A future sweep (or an operator) may need to clear leases platform-wide.
CREATE POLICY platform_ops_full_access ON stream_leases TO platform_ops
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON stream_leases TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON stream_leases TO platform_ops;

-- The stream reads "this account's events after seq N" on every wake, and
-- the tenant read of domain_events (0627) only has (account_id, created_at).
CREATE INDEX idx_domain_events_account_seq ON domain_events (account_id, seq);

-- Fix round 2 (CWE-362): domain_events.inserted_at, the stream's SETTLE clock.
--
-- `seq` is assigned at INSERT, not at commit, so the stream holds a row back
-- until it is older than a settle window (poller.ts, COMMIT-ORDER SAFETY).
-- `created_at` cannot be that clock: it defaults to now() -- the writing
-- transaction's START -- and three producers pass their own (runSweep's
-- `now`, fixLoop's `at`, budget.exhausted's host clock), so a row could be
-- born "already settled" and be skipped past while a lower serial was still
-- uncommitted. `inserted_at` is clock_timestamp() at the moment of the
-- INSERT statement, i.e. the moment `seq` is drawn, and no caller can set it:
-- a BEFORE INSERT trigger overwrites whatever the statement supplied (a
-- trigger, not a column-level grant, so it also holds against platform_ops
-- and any future role granted INSERT), and the same trigger pins the value
-- on UPDATE so it can never be moved later.
--
-- History is backfilled from created_at. The table is FORCE ROW LEVEL
-- SECURITY, so the owner would otherwise match no policy and update zero
-- rows: the toggle is inside this migration's transaction and put back.
ALTER TABLE domain_events ADD COLUMN inserted_at timestamptz;
ALTER TABLE domain_events NO FORCE ROW LEVEL SECURITY;
UPDATE domain_events SET inserted_at = created_at;
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;
ALTER TABLE domain_events ALTER COLUMN inserted_at SET DEFAULT clock_timestamp();
ALTER TABLE domain_events ALTER COLUMN inserted_at SET NOT NULL;

CREATE FUNCTION domain_events_pin_inserted_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.inserted_at := clock_timestamp();
  ELSE
    NEW.inserted_at := OLD.inserted_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER domain_events_pin_inserted_at
  BEFORE INSERT OR UPDATE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION domain_events_pin_inserted_at();

-- D#81/#92 per-file bracket (same shape as 0616/0622/0631): OWNER TO
-- platform_ops needs platform_ops to hold CREATE on schema public at that
-- moment; test-neon-shape.sh's end-state check requires it revoked after.
GRANT CREATE ON SCHEMA public TO platform_ops;

CREATE FUNCTION domain_event_watermarks(p_account_ids uuid[])
RETURNS TABLE (account_id uuid, max_seq bigint, run_active boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_account_ids IS NULL THEN
    RAISE EXCEPTION 'domain_event_watermarks: p_account_ids must not be null';
  END IF;
  IF cardinality(p_account_ids) > 1000 THEN
    RAISE EXCEPTION 'domain_event_watermarks: at most 1000 account ids per call';
  END IF;
  RETURN QUERY
  SELECT a.id,
         COALESCE((SELECT max(e.seq) FROM domain_events e WHERE e.account_id = a.id), 0)::bigint,
         EXISTS (
           SELECT 1 FROM agent_runs r
           WHERE r.account_id = a.id
             AND r.status NOT IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')
         )
  FROM unnest(p_account_ids) AS a(id);
END;
$$;
REVOKE ALL ON FUNCTION domain_event_watermarks(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain_event_watermarks(uuid[]) TO platform_ops;
ALTER FUNCTION domain_event_watermarks(uuid[]) OWNER TO platform_ops;

CREATE FUNCTION stream_json_poll_check(p_token_id uuid, p_limit integer)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '2s'
AS $$
DECLARE
  c_window_seconds CONSTANT integer := 60;
  now_ts           timestamptz := clock_timestamp();
  ctx_account_id   text := NULLIF(current_setting('app.account_id', true), '');
  token_account_id uuid;
  win_start        timestamptz;
  win_count        integer;
BEGIN
  IF p_limit < 0 THEN
    RAISE EXCEPTION 'stream_json_poll_check: p_limit must be >= 0, got %', p_limit;
  END IF;
  IF ctx_account_id IS NULL THEN
    RAISE EXCEPTION 'stream_json_poll_check: a tenant context is required';
  END IF;
  SELECT t.account_id INTO token_account_id FROM api_tokens t WHERE t.id = p_token_id;
  IF token_account_id IS NULL OR token_account_id::text <> ctx_account_id THEN
    RAISE EXCEPTION 'stream_json_poll_check: token does not belong to the caller''s tenant context';
  END IF;

  -- One atomic statement: bump the live window, or open a fresh one when
  -- the previous window has fully elapsed. The row lock serializes
  -- concurrent callers on the same key.
  INSERT INTO rate_limit_windows AS w (bucket_key, window_start, request_count)
  VALUES ('json-poll:' || p_token_id::text, now_ts, 1)
  ON CONFLICT (bucket_key) DO UPDATE
    SET window_start = CASE
          WHEN w.window_start <= now_ts - make_interval(secs => c_window_seconds) THEN now_ts
          ELSE w.window_start END,
        request_count = CASE
          WHEN w.window_start <= now_ts - make_interval(secs => c_window_seconds) THEN 1
          ELSE w.request_count + 1 END
  RETURNING w.window_start, w.request_count INTO win_start, win_count;

  RETURN QUERY SELECT
    win_count <= p_limit,
    GREATEST(1, CEIL(EXTRACT(EPOCH FROM (win_start + make_interval(secs => c_window_seconds) - now_ts)))::integer);
END;
$$;
REVOKE ALL ON FUNCTION stream_json_poll_check(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stream_json_poll_check(uuid, integer) TO app_user;
ALTER FUNCTION stream_json_poll_check(uuid, integer) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
