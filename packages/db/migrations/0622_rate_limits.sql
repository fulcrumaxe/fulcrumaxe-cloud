-- D#31 API-3d: token, tenant and failed-auth rate limits (Correction C13c).
--
-- Numbered 0622 per C13c: "06NN is the next free 06xx number when the
-- executor is spawned." Main's newest migration was #154's gh-proxy
-- run-resolution one (merged) at spawn time; the one open PR touching
-- this range was #155 (API-3f), which held 0617. 0620 was free both at
-- spawn and when this file was first written -- but #155 merged while
-- this PR was in flight and renumbered itself to 0621 (D#94 R1,
-- merge-monotonic: its own base had moved past 0617 by the time it
-- landed), which pushed this file's own number up in turn. Re-checked
-- against `origin/main` and `gh pr list` again immediately before push
-- -- 0622 is free.
--
-- Only `rate_limit_windows` (and its index) goes in this migration, per
-- C13c: rate limits do NOT fold into `resolve_api_token` (0616) here --
-- that would require altering a function 0616 already shipped, and the
-- advisory note that suggested folding the counter upsert into the
-- token-resolve round-trip is explicitly optional ("Advisory, from the
-- Implementation Notes"), not a pass/fail criterion.
--
-- Design: one row per bucket key (`token:<id>`, `tenant:<accountId>`, or
-- `failed-auth:<ip>` -- see packages/api/src/ratelimit/limits.ts), reset
-- in place once its window has fully elapsed, rather than one row per
-- key per historical window. This keeps the table's size bounded by the
-- number of DISTINCT active keys, not by request volume, and -- unlike a
-- window aligned to the wall-clock minute -- means a window's lifetime is
-- always measured from the bucket's OWN first request, never from a
-- shared clock boundary a fast-moving test (or a real burst) could
-- straddle.
--
-- No tenant_isolation-style RLS: a bucket key is an opaque, already
-- globally-unique string (never a bare account id column another
-- policy could compare against app.account_id), and the failed-auth
-- buckets have no account context at all -- there is nothing for a
-- per-tenant policy to gate on, the same reasoning 0609_revoked_
-- sessions.sql's header gives for that table. Access is mediated
-- entirely through the SECURITY DEFINER function below; app_user gets
-- no table grant, matching that same precedent.
CREATE TABLE rate_limit_windows (
  bucket_key     text PRIMARY KEY,
  window_start   timestamptz NOT NULL,
  request_count  integer NOT NULL DEFAULT 0
);

-- Supports a future sweep (API-4's own purge job is advisory-noted as
-- the eventual owner: "API-4's sweep purges windows older than 1 h" --
-- API-3d adds no purging itself, C13c). Not used by rate_limit_check
-- itself, which always looks up by the bucket_key primary key.
CREATE INDEX idx_rate_limit_windows_window_start ON rate_limit_windows (window_start);

ALTER TABLE rate_limit_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_ops_full_access ON rate_limit_windows TO platform_ops
  USING (true) WITH CHECK (true);
-- rate_limit_check (below) is SECURITY DEFINER, owned by platform_ops --
-- table-level privilege, not just the policy above, is what it actually
-- runs under. No DELETE grant here: nothing this migration adds ever
-- deletes a row (API-4's future sweep grants that itself when it adds
-- purging, C13c: "API-3d does not add purging"). No app_user grant on
-- the table at all -- see the header note above.
GRANT SELECT, INSERT, UPDATE ON rate_limit_windows TO platform_ops;

-- D#81/#92 per-file bracket (same shape 0616_api_tokens.sql uses): the
-- `ALTER FUNCTION ... OWNER TO platform_ops` below needs platform_ops to
-- hold CREATE on schema public at that moment.
GRANT CREATE ON SCHEMA public TO platform_ops;

-- rate_limit_check(bucket_key, limit): atomically bumps the counter for
-- bucket_key and reports whether the caller is still within `limit`
-- requests in the current (fixed) window, plus how many seconds until
-- the window rolls over. Callable directly from the app_user pool --
-- exactly like resolve_api_token, this runs pre-tenant-context for the
-- failed-auth-IP bucket, and packages/api/src/ratelimit/limits.ts calls
-- it from inside a `withTenant` transaction for the post-auth
-- token/tenant buckets (fix round 1, M2, below).
--
-- Fix round 1 (PR #159 review, M1 and M2 -- both MUST-FIX):
--
-- M1. The original signature took `p_window_seconds` from the caller.
-- `rate_limit_check('token:<id>', 0, 1)` reset any bucket to 1, a
-- negative window did the same, and `rate_limit_check('<key>', NULL, 1)`
-- looped forever while holding the conflicting row's lock: both
-- `window_start > now_ts - make_interval(secs => NULL)` and its ON
-- CONFLICT counterpart compare against NULL, which is neither true nor
-- false, so neither `EXIT WHEN FOUND` branch could ever fire. Per the
-- review's "preferably, stop taking the window from the caller" fix,
-- the window is no longer a parameter at all -- it is fixed at
-- `c_window_seconds` below, so there is no caller-controlled window left
-- to corrupt, and the NULL-window infinite loop is structurally
-- impossible rather than merely guarded against. `STRICT` rejects a NULL
-- p_bucket_key or p_limit outright (the function body never runs; the
-- call returns zero rows -- PgRateLimitStore already throws on "no row",
-- so this fails closed the same way an explicit RAISE would).
-- `p_limit < 0` and an over-length `p_bucket_key` each RAISE explicitly.
-- `SET lock_timeout` bounds how long any one call can wait on a row
-- lock held by a concurrent caller, and the loop below now carries its
-- own attempt cap that RAISEs rather than spinning -- belt-and-suspenders
-- once the window itself can no longer be poisoned.
--
-- M2. The original body had no tenant binding at all: any app_user
-- context could increment -- or, via M1's window=0 bug, reset -- any
-- bucket, including another tenant's. Reproduced live in the review: 130
-- calls of `rate_limit_check('tenant:<B>', 60, 1)` from inside tenant
-- A's own transaction pushed tenant B over its cap. Fixed by keying
-- every non-failed-auth key to the CALLER's own tenant context
-- (`current_setting('app.account_id', true)`, set by `withTenant`'s
-- `SET LOCAL` -- see limits.ts's `enforceTokenRateLimits`, which now
-- runs the token/tenant checks inside that same transaction):
--   * a `tenant:<id>` key's <id> must equal the caller's own
--     app.account_id;
--   * a `token:<id>` key's <id> must name an api_tokens row whose
--     account_id equals the caller's own app.account_id (platform_ops,
--     this function's owner, already has full SELECT access to
--     api_tokens -- 0616_api_tokens.sql -- so no new grant is needed);
--   * a `failed-auth:<ip>` key is accepted ONLY when app.account_id is
--     NOT set -- this bucket runs pre-auth, pre-tenant-context, by
--     design (resolve.ts calls it before a principal, let alone a
--     tenant, is known).
-- Any other bucket-key shape RAISEs: every real caller's key matches one
-- of the three shapes above (limits.ts), so there is no legitimate use
-- of a fourth shape to preserve.
--
-- Race-safety (unchanged from the original design): the fast-path
-- UPDATE only bumps a row whose window has NOT yet elapsed. When no such
-- row exists (first request for a key, or its window just elapsed), the
-- INSERT ... ON CONFLICT DO UPDATE opens a fresh window, but its own
-- WHERE guard only fires if the conflicting row is ALSO expired -- so a
-- concurrent opener never gets clobbered by a second one arriving a
-- moment later. If that guard skips (because the other transaction's
-- fresh window already committed), the loop retries the fast path,
-- which now finds the just-opened live row. `c_max_attempts` bounds this
-- retry loop itself (M1): legitimate contention converges in one or two
-- iterations, so a call that still hasn't converged after several is
-- treated as a bug, not raced against forever.
CREATE FUNCTION rate_limit_check(p_bucket_key text, p_limit integer)
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
  -- every legitimate no-tenant failed-auth call.
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
REVOKE ALL ON FUNCTION rate_limit_check(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rate_limit_check(text, integer) TO app_user;
ALTER FUNCTION rate_limit_check(text, integer) OWNER TO platform_ops;

-- Close the window opened above, right after the last OWNER TO statement.
REVOKE CREATE ON SCHEMA public FROM platform_ops;
