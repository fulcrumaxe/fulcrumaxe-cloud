-- Rate limits for signed-in session traffic on routes that call an outside service, start compute, or write on each call.
--
-- rate_limit_check (0622, 0626) has one fixed 60 second window and only knows the token, tenant, failed-auth and anon key
-- shapes. A session limit needs a 10 second window (one model-key test per 10 s) and a one hour window (30 per hour), so this adds
-- a second function instead of changing that one. The window is still never caller-controlled in the free sense: it must be
-- one of 10, 60 or 3600, and the key must end in that same window (":w10"), so one key can never be counted under two
-- different windows. It reuses the rate_limit_windows table, its purge (older than one hour is gone, and an hour window
-- that old has already ended), and the same bump-or-open-a-window loop.
--
-- Two key shapes, both tied to the caller's own tenant context (app.account_id, set by withTenant), so one account can never
-- count against or drain another's bucket:
--   session:<account uuid>:<name>:w<seconds>
--   session-user:<account uuid>:<user uuid>:<name>:w<seconds>
-- The user shape only narrows a bucket inside the caller's own account; nothing outside that account is reachable by it.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

CREATE FUNCTION session_rate_limit_check(p_bucket_key text, p_limit integer, p_window_seconds integer)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '2s'
AS $$
DECLARE
  c_max_key_length CONSTANT integer := 200;
  c_max_attempts   CONSTANT integer := 5;
  c_uuid           CONSTANT text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  c_name           CONSTANT text := '[a-z0-9][a-z0-9._-]{0,63}';
  now_ts     timestamptz := clock_timestamp();
  win_start  timestamptz;
  win_count  integer;
  ctx_account_id text := NULLIF(current_setting('app.account_id', true), '');
  key_account_id text;
  attempt integer := 0;
BEGIN
  IF p_limit < 0 THEN
    RAISE EXCEPTION 'session_rate_limit_check: p_limit must be >= 0, got %', p_limit;
  END IF;
  IF p_window_seconds NOT IN (10, 60, 3600) THEN
    RAISE EXCEPTION 'session_rate_limit_check: window must be 10, 60 or 3600 seconds, got %', p_window_seconds;
  END IF;
  IF length(p_bucket_key) > c_max_key_length THEN
    RAISE EXCEPTION 'session_rate_limit_check: p_bucket_key exceeds % characters', c_max_key_length;
  END IF;
  IF ctx_account_id IS NULL THEN
    RAISE EXCEPTION 'session_rate_limit_check: a session bucket requires a tenant context';
  END IF;

  IF p_bucket_key ~ ('^session:' || c_uuid || ':' || c_name || ':w' || p_window_seconds || '$') THEN
    key_account_id := substring(p_bucket_key FROM 9 FOR 36); -- after 'session:'
  ELSIF p_bucket_key ~ ('^session-user:' || c_uuid || ':' || c_uuid || ':' || c_name || ':w' || p_window_seconds || '$') THEN
    key_account_id := substring(p_bucket_key FROM 14 FOR 36); -- after 'session-user:'
  ELSE
    RAISE EXCEPTION 'session_rate_limit_check: unrecognized bucket key shape or window';
  END IF;
  IF key_account_id <> ctx_account_id THEN
    RAISE EXCEPTION 'session_rate_limit_check: bucket key does not match the caller''s tenant context';
  END IF;

  LOOP
    attempt := attempt + 1;
    IF attempt > c_max_attempts THEN
      RAISE EXCEPTION 'session_rate_limit_check: exceeded % contention retries for bucket %', c_max_attempts, p_bucket_key;
    END IF;

    UPDATE rate_limit_windows
    SET request_count = request_count + 1
    WHERE bucket_key = p_bucket_key
      AND window_start > now_ts - make_interval(secs => p_window_seconds)
    RETURNING window_start, request_count INTO win_start, win_count;
    EXIT WHEN FOUND;

    INSERT INTO rate_limit_windows (bucket_key, window_start, request_count)
    VALUES (p_bucket_key, now_ts, 1)
    ON CONFLICT (bucket_key) DO UPDATE
      SET window_start = now_ts, request_count = 1
      WHERE rate_limit_windows.window_start <= now_ts - make_interval(secs => p_window_seconds)
    RETURNING window_start, request_count INTO win_start, win_count;
    EXIT WHEN FOUND;
  END LOOP;

  RETURN QUERY SELECT
    win_count <= p_limit,
    GREATEST(1, CEIL(EXTRACT(EPOCH FROM (win_start + make_interval(secs => p_window_seconds) - now_ts)))::integer);
END;
$$;
REVOKE ALL ON FUNCTION session_rate_limit_check(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_rate_limit_check(text, integer, integer) TO app_user;
ALTER FUNCTION session_rate_limit_check(text, integer, integer) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
