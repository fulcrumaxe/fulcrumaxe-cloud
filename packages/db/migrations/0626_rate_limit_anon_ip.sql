-- D#37 WS-D fix round 1, MUST 1 (a review of that PR flagged this gap):
-- POST /api/rum (apps/web) is a new, unauthenticated, internet-reachable
-- route with a body-size cap but no request-frequency cap of any kind --
-- a scripted client can flood it indefinitely at zero cost, generating
-- unbounded log volume and function-invocation cost. This is D#31's own
-- `rate_limit_check` (0622_rate_limits.sql), extended with a fourth
-- bucket-key shape rather than a second limiter: the review's own
-- instruction was "reuse the existing mechanism if one fits... do not
-- invent a second limiter if one fits," and 0622's per-IP failed-auth
-- bucket already proves this table/function combination works for an
-- unauthenticated, pre-tenant, per-IP cap -- rum just isn't a failed
-- auth attempt.
--
-- Numbered 0626 per the C13c convention (0622's own header): checked
-- `origin/main` (newest migration 0624) and `gh pr list` immediately
-- before writing this file -- the one other open PR touching this range
-- is #171, which holds 0625 (D#... agent-runs). 0626 is free.
--
-- New shape: `anon:<name>:<ip-or-/64>` -- e.g. `anon:rum:203.0.113.9`,
-- the key `packages/api/src/ratelimit/limits.ts`'s new
-- `bucketKeyForAnonIp` builds. Accepted under the exact same
-- precondition as `failed-auth:` (ctx_account_id IS NULL -- this bucket
-- runs pre-auth, pre-tenant-context, by design) but kept in a SEPARATE
-- namespace on purpose: sharing one budget between real failed sign-ins
-- and a telemetry-beacon flood from the same address would let either
-- kind of traffic exhaust the other's cap, and an operator reading
-- `failed-auth:<ip>`'s count as "sign-in abuse from this address" would
-- be misled by unrelated rum traffic mixed into it. `<name>` namespaces
-- the bucket per caller (rum today) so two different anonymous routes
-- added later never share one counter either -- the suffix past
-- `anon:` is treated as an opaque string here, same as `failed-auth:`'s
-- suffix always has been; the caller (limits.ts) owns its shape.
--
-- Everything else below is unchanged from 0622/0621's function body --
-- CREATE OR REPLACE keeps the existing owner (platform_ops) and grants
-- (REVOKE ALL FROM PUBLIC / GRANT EXECUTE TO app_user) as long as the
-- signature is identical, which it is.
--
-- Per-file bracket (D#81/#92, docs/ops/hosted-postgres.md): CREATE OR
-- REPLACE FUNCTION on an existing platform_ops-owned function (here,
-- rate_limit_check, owned by platform_ops since 0622) needs INHERIT
-- (has_privs_of_role), not CREATE on schema public -- no ownership
-- transfer happens in this file; the function already belongs to
-- platform_ops. Statement form copied verbatim from
-- 0612_audit_write_hardening.sql / 0621_api_tokens_hardening.sql, the
-- migrations that established this exact bracket -- this is what
-- test-neon-shape.sh's non-superuser fx_migrator role actually needs to
-- run this file end to end (a plain CREATE OR REPLACE here, run as
-- fx_migrator without this bracket, fails with "must be owner of
-- function rate_limit_check").
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION rate_limit_check(p_bucket_key text, p_limit integer)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
STRICT
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '2s'
AS $$
DECLARE
  c_window_seconds CONSTANT integer := 60;
  c_max_key_length CONSTANT integer := 200;
  c_max_attempts    CONSTANT integer := 5;
  now_ts     timestamptz := clock_timestamp();
  win_start  timestamptz;
  win_count  integer;
  -- NULLIF(..., '') matches every other definer's own "is a tenant
  -- context set" check in this codebase (e.g. audit_write's `acct` in
  -- 0612_audit_write_hardening.sql): an unset `app.account_id` reads
  -- back as '', not SQL NULL, so a bare `current_setting(..., true)`
  -- would treat "no tenant" as "the empty-string tenant" and reject
  -- every legitimate no-tenant failed-auth/anon call.
  ctx_account_id  text := NULLIF(current_setting('app.account_id', true), '');
  key_suffix      text;
  token_account_id uuid;
  attempt integer := 0;
BEGIN
  IF p_limit < 0 THEN
    RAISE EXCEPTION 'rate_limit_check: p_limit must be >= 0, got %', p_limit;
  END IF;
  IF length(p_bucket_key) > c_max_key_length THEN
    RAISE EXCEPTION 'rate_limit_check: p_bucket_key exceeds % characters', c_max_key_length;
  END IF;

  IF p_bucket_key LIKE 'tenant:%' THEN
    key_suffix := substring(p_bucket_key FROM 8); -- length('tenant:') + 1
    IF ctx_account_id IS NULL OR key_suffix <> ctx_account_id THEN
      RAISE EXCEPTION 'rate_limit_check: tenant bucket key does not match the caller''s tenant context';
    END IF;
  ELSIF p_bucket_key LIKE 'token:%' THEN
    IF ctx_account_id IS NULL THEN
      RAISE EXCEPTION 'rate_limit_check: a token bucket requires a tenant context';
    END IF;
    key_suffix := substring(p_bucket_key FROM 7); -- length('token:') + 1
    BEGIN
      SELECT account_id INTO token_account_id FROM api_tokens WHERE id = key_suffix::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'rate_limit_check: malformed token bucket key';
    END;
    IF token_account_id IS NULL OR token_account_id::text <> ctx_account_id THEN
      RAISE EXCEPTION 'rate_limit_check: token bucket key does not belong to the caller''s tenant context';
    END IF;
  ELSIF p_bucket_key LIKE 'failed-auth:%' THEN
    IF ctx_account_id IS NOT NULL THEN
      RAISE EXCEPTION 'rate_limit_check: a failed-auth bucket key is not allowed with a tenant context set';
    END IF;
  ELSIF p_bucket_key LIKE 'anon:%' THEN
    IF ctx_account_id IS NOT NULL THEN
      RAISE EXCEPTION 'rate_limit_check: an anon bucket key is not allowed with a tenant context set';
    END IF;
  ELSE
    RAISE EXCEPTION 'rate_limit_check: unrecognized bucket key shape';
  END IF;

  LOOP
    attempt := attempt + 1;
    IF attempt > c_max_attempts THEN
      RAISE EXCEPTION 'rate_limit_check: exceeded % contention retries for bucket %', c_max_attempts, p_bucket_key;
    END IF;

    UPDATE rate_limit_windows
    SET request_count = request_count + 1
    WHERE bucket_key = p_bucket_key
      AND window_start > now_ts - make_interval(secs => c_window_seconds)
    RETURNING window_start, request_count INTO win_start, win_count;
    EXIT WHEN FOUND;

    INSERT INTO rate_limit_windows (bucket_key, window_start, request_count)
    VALUES (p_bucket_key, now_ts, 1)
    ON CONFLICT (bucket_key) DO UPDATE
      SET window_start = now_ts, request_count = 1
      WHERE rate_limit_windows.window_start <= now_ts - make_interval(secs => c_window_seconds)
    RETURNING window_start, request_count INTO win_start, win_count;
    EXIT WHEN FOUND;
    -- Lost the race: another transaction refreshed this key's window
    -- between our UPDATE and INSERT. Loop back and take the fast path
    -- against it.
  END LOOP;

  RETURN QUERY SELECT
    win_count <= p_limit,
    GREATEST(1, CEIL(EXTRACT(EPOCH FROM (win_start + make_interval(secs => c_window_seconds) - now_ts)))::integer);
END;
$$;

-- Close the window opened above, matching 0612/0621's own downgrade
-- shape. SET stays TRUE (still needed elsewhere in the chain / by later
-- migrations with the same bracket).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
