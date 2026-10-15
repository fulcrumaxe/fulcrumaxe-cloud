-- D#68 OPS-C2: the two definer functions that enroll a staff passkey. 0801 left staff_enrollment_tokens with no grant and no policy on purpose;
-- this adds exactly what these two functions read and write, for ops_owner only. Nothing here is reachable from a customer session.
--
--   ops_enroll_lookup(token_hash)     the staff member a live token belongs to (email and display name, for the passkey's label), or no row
--                                     when the token is unknown, used, expired, or its staff member is inactive. Reads only.
--   ops_enroll_complete(token_hash, credential_id, public_key, sign_count)
--                                     spends the token and stores the one passkey in one statement: the token is marked used only if it was
--                                     unused, unexpired and its staff member active, and the credential insert shares its transaction, so a
--                                     duplicate credential id leaves the token unspent. Raises insufficient_privilege for a bad token.
--
--   ops_challenge_consume(hash, expires_at)
--                                     records a WebAuthn challenge as spent (insert-only table, expired rows swept in the same call) and
--                                     returns false when it was already spent: a signed challenge cookie is single-use.
--
--   ops_auth_rate_take(key_hash, bucket, max, window, record)
--                                     a rate limit for /api/auth/*: true while fewer than max rows for (key_hash, bucket) fall inside the window,
--                                     and (record = true) it adds one. The caller keys it on the SHA-256 of the client address. record = false only
--                                     asks, so a gate can be checked before the work and a failure recorded after it. The same table holds the
--                                     console's sign-out deny-list (bucket sid_revoked, keyed on the session id's hash): a full bucket is a
--                                     revoked session. Insert-only table, rows older than the longest window (8 hours) swept in the same call.
--
-- Only ops_console may execute any of them. The token itself never reaches the database, only its SHA-256 (apps/ops/scripts/enroll-staff.ts).
-- Numbered above 0801 (OPS-C1). Re-check against main right before merging.

-- ---------------------------------------------------------------------
-- 1. Grants and policies: what the two functions touch, nothing more.
-- ---------------------------------------------------------------------
GRANT SELECT (email, display_name) ON platform_staff TO ops_owner;
GRANT SELECT (staff_id, token_hash, expires_at, used_at), UPDATE (used_at) ON staff_enrollment_tokens TO ops_owner;
GRANT INSERT (staff_id, credential_id, public_key, sign_count) ON staff_webauthn_credentials TO ops_owner;

CREATE POLICY ops_owner_select ON staff_enrollment_tokens FOR SELECT TO ops_owner USING (true);
CREATE POLICY ops_owner_update ON staff_enrollment_tokens FOR UPDATE TO ops_owner USING (true) WITH CHECK (true);
CREATE POLICY ops_owner_insert ON staff_webauthn_credentials FOR INSERT TO ops_owner WITH CHECK (true);

-- The two audit writers' policies, tightened now that the first writers exist: a row may only name the session's own staff member.
-- Both run as ops_owner, which holds EXECUTE on ops_current_staff(); it raises when app.staff_id is unset or not an active member.
DROP POLICY ops_owner_insert ON staff_audit_log;
CREATE POLICY ops_owner_insert ON staff_audit_log FOR INSERT TO ops_owner WITH CHECK (staff_id = public.ops_current_staff());
DROP POLICY ops_owner_audit ON audit_log;
CREATE POLICY ops_owner_audit ON audit_log FOR INSERT TO ops_owner
  WITH CHECK (actor = 'staff:' || public.ops_current_staff()::text);

CREATE TABLE staff_used_challenges (
  challenge_hash text PRIMARY KEY,
  expires_at     timestamptz NOT NULL
);
ALTER TABLE staff_used_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_used_challenges FORCE ROW LEVEL SECURITY;
REVOKE ALL ON staff_used_challenges FROM PUBLIC;
GRANT SELECT (expires_at), INSERT (challenge_hash, expires_at) ON staff_used_challenges TO ops_owner;
GRANT DELETE ON staff_used_challenges TO ops_owner;
CREATE POLICY ops_owner_select ON staff_used_challenges FOR SELECT TO ops_owner USING (true);
CREATE POLICY ops_owner_insert ON staff_used_challenges FOR INSERT TO ops_owner WITH CHECK (true);
CREATE POLICY ops_owner_delete ON staff_used_challenges FOR DELETE TO ops_owner USING (true);

-- Insert-only log behind ops_auth_rate_take: one row per counted event. Nothing reads it but that function.
CREATE TABLE staff_auth_rate (
  key_hash text        NOT NULL,
  bucket   text        NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_auth_rate_lookup ON staff_auth_rate (key_hash, bucket, at);
CREATE INDEX staff_auth_rate_at ON staff_auth_rate (at);
ALTER TABLE staff_auth_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_auth_rate FORCE ROW LEVEL SECURITY;
REVOKE ALL ON staff_auth_rate FROM PUBLIC;
GRANT SELECT (key_hash, bucket, at), INSERT (key_hash, bucket) ON staff_auth_rate TO ops_owner;
GRANT DELETE ON staff_auth_rate TO ops_owner;
CREATE POLICY ops_owner_select ON staff_auth_rate FOR SELECT TO ops_owner USING (true);
CREATE POLICY ops_owner_insert ON staff_auth_rate FOR INSERT TO ops_owner WITH CHECK (true);
CREATE POLICY ops_owner_delete ON staff_auth_rate FOR DELETE TO ops_owner USING (true);

-- ---------------------------------------------------------------------
-- 2. Ownership bracket (0801's shape).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'ops_owner'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on ops_owner; cannot ALTER FUNCTION ... OWNER TO ops_owner';
    END IF;
    GRANT ops_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO ops_owner;

-- ---------------------------------------------------------------------
-- 3. Functions.
-- ---------------------------------------------------------------------
CREATE FUNCTION ops_enroll_lookup(p_token_hash text)
RETURNS TABLE (staff_id uuid, email text, display_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.id, s.email, s.display_name
    FROM public.staff_enrollment_tokens t
    JOIN public.platform_staff s ON s.id = t.staff_id
   WHERE t.token_hash = p_token_hash AND t.used_at IS NULL AND t.expires_at > now() AND s.active;
$$;

CREATE FUNCTION ops_enroll_complete(p_token_hash text, p_credential_id bytea, p_public_key bytea, p_sign_count bigint)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  sid uuid;
BEGIN
  UPDATE public.staff_enrollment_tokens t
     SET used_at = now()
   WHERE t.token_hash = p_token_hash AND t.used_at IS NULL AND t.expires_at > now()
     AND EXISTS (SELECT 1 FROM public.platform_staff s WHERE s.id = t.staff_id AND s.active)
  RETURNING t.staff_id INTO sid;
  IF sid IS NULL THEN
    RAISE EXCEPTION 'ops_enroll_complete: the enrollment token is unknown, used or expired' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.staff_webauthn_credentials (staff_id, credential_id, public_key, sign_count)
  VALUES (sid, p_credential_id, p_public_key, p_sign_count);
  RETURN sid;
END;
$$;

CREATE FUNCTION ops_challenge_consume(p_hash text, p_expires_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  DELETE FROM public.staff_used_challenges WHERE expires_at < now();
  INSERT INTO public.staff_used_challenges (challenge_hash, expires_at) VALUES (p_hash, p_expires_at) ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION ops_auth_rate_take(p_key_hash text, p_bucket text, p_max integer, p_window interval, p_record boolean DEFAULT true)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  used integer;
BEGIN
  IF p_max < 1 OR p_window <= interval '0' OR p_window > interval '8 hours' THEN
    RAISE EXCEPTION 'ops_auth_rate_take: max must be at least 1 and the window within 8 hours' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_record THEN
    -- One counter at a time per (key, bucket), so two requests cannot both take the last slot.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_key_hash || ':' || p_bucket, 0));
  END IF;
  DELETE FROM public.staff_auth_rate WHERE at < now() - interval '8 hours';
  SELECT count(*) INTO used FROM public.staff_auth_rate WHERE key_hash = p_key_hash AND bucket = p_bucket AND at > now() - p_window;
  IF used >= p_max THEN
    RETURN false;
  END IF;
  IF p_record THEN
    INSERT INTO public.staff_auth_rate (key_hash, bucket) VALUES (p_key_hash, p_bucket);
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION ops_challenge_consume(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_challenge_consume(text, timestamptz) TO ops_console;
ALTER FUNCTION ops_challenge_consume(text, timestamptz) OWNER TO ops_owner;
REVOKE ALL ON FUNCTION ops_auth_rate_take(text, text, integer, interval, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_auth_rate_take(text, text, integer, interval, boolean) TO ops_console;
ALTER FUNCTION ops_auth_rate_take(text, text, integer, interval, boolean) OWNER TO ops_owner;
REVOKE ALL ON FUNCTION ops_enroll_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_enroll_complete(text, bytea, bytea, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_enroll_lookup(text) TO ops_console;
GRANT EXECUTE ON FUNCTION ops_enroll_complete(text, bytea, bytea, bigint) TO ops_console;
ALTER FUNCTION ops_enroll_lookup(text) OWNER TO ops_owner;
ALTER FUNCTION ops_enroll_complete(text, bytea, bytea, bigint) OWNER TO ops_owner;

REVOKE CREATE ON SCHEMA public FROM ops_owner;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE ops_owner FROM CURRENT_USER;
  END IF;
END
$$;
