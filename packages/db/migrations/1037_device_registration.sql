-- ON-2: device registration, the cloud side.
--
-- A machine asks for a code (start), the person types it in the browser while signed in (lookup, then approve or deny), and the machine
-- collects its registration with a signed poll. Every write below is a definer owned by onboarding_ops (1036 made the role), so no app session can
-- read, list, claim or change a code that has no account yet.
--
--   runner_device_start(...)   unsigned caller. Stores the code row and enforces the two start limits: 10 an hour per address and the global figure
--                              (passed in; the default is 1,000). Both count rows, so a refused start leaves nothing behind.
--   runner_device_lookup(h)    an owner or admin of an active account looks a typed code up and gets the machine's facts. A code that does not exist is
--                              a counted wrong attempt: the sixth in 15 minutes for the account answers 'limited', and so does everything after it.
--   runner_device_approve(...) the same caller approves it. Creates the runner row with allowed_repo_ids '{}' (a new machine has no repos until a
--                              project is placed on it), writes the audit rows, and marks the code approved. All in one transaction.
--   runner_device_deny(h)      the same caller cancels a pending code; it becomes denied.
--   runner_device_key(h)       before a poll's signature is checked: the key the code was started with, and nothing else (not its status).
--   runner_device_poll(h, k, s) after the signature is checked: pending, slow_down (polled faster than s seconds), approved (which marks the code
--                              consumed in the same statement, so the registration is handed out once) or the reason it is over (expired, denied, consumed). The key's thumbprint is passed in and must match
--                              the row, so a session that calls this directly with a known hash but another key gets nothing.
--
-- Outcomes that must keep a counted attempt are returned, not raised (a raise rolls the attempt back). Refusals that change nothing are raised.
--
-- The user code is hashed with a keyed hash (HMAC-SHA256, the key is the server's FX_DEVICE_CODE_KEY): about 35 bits of code are guessable offline if the
-- hashes ever leak, and the key makes that useless. The device code is a 256-bit secret and stays a plain SHA-256. Both are 64 hex characters in the table.
--
-- Numbered 1037 by the Team Lead; it merges after 1036, in number order. Re-check against main's highest right before merging.

ALTER TABLE runner_device_codes
  ADD COLUMN start_ip_hash    text CHECK (start_ip_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN last_polled_at   timestamptz,
  ADD COLUMN runner_id        uuid,
  ADD CONSTRAINT runner_device_codes_runner_owned CHECK (runner_id IS NULL OR account_id IS NOT NULL),
  ADD CONSTRAINT runner_device_codes_runner_fk FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE SET NULL (runner_id);
CREATE INDEX runner_device_codes_ip ON runner_device_codes (start_ip_hash, created_at) WHERE start_ip_hash IS NOT NULL;
CREATE INDEX runner_device_codes_created ON runner_device_codes (created_at);

-- Codes a person typed that matched nothing, per account. No app_user grant at all: only the definers read or write it.
CREATE TABLE runner_device_attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runner_device_attempts_account ON runner_device_attempts (account_id, created_at);
ALTER TABLE runner_device_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_device_attempts FORCE ROW LEVEL SECURITY;

-- ---- what the definer role may touch ------------------------------------------------------------------------------------------------------------

GRANT INSERT (device_code_hash, user_code_hash, jkt, public_key_jwk, facts, expires_at, start_ip_hash) ON runner_device_codes TO onboarding_ops;
GRANT UPDATE (account_id, status, approved_by, approved_at, runner_id, attempts, last_polled_at) ON runner_device_codes TO onboarding_ops;
CREATE POLICY onboarding_ops_device_select ON runner_device_codes FOR SELECT TO onboarding_ops USING (true);
CREATE POLICY onboarding_ops_device_insert ON runner_device_codes FOR INSERT TO onboarding_ops WITH CHECK (status = 'pending' AND account_id IS NULL);
CREATE POLICY onboarding_ops_device_update ON runner_device_codes FOR UPDATE TO onboarding_ops USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, DELETE ON runner_device_attempts TO onboarding_ops;
CREATE POLICY onboarding_ops_device ON runner_device_attempts FOR ALL TO onboarding_ops
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

GRANT SELECT (id, account_id, credential_mode, revoked_at), INSERT (account_id, registered_by, public_key_jwk, jkt, credential_mode, allowed_repo_ids) ON runners TO onboarding_ops;
-- The caller's own account while a person approves; and the one runner a code just created, for the poll that has no account in context.
CREATE POLICY onboarding_ops_device_select ON runners FOR SELECT TO onboarding_ops
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         OR EXISTS (SELECT 1 FROM runner_device_codes c WHERE c.runner_id = runners.id AND c.account_id = runners.account_id AND c.status IN ('approved', 'consumed')));
CREATE POLICY onboarding_ops_device_insert ON runners FOR INSERT TO onboarding_ops
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

GRANT INSERT (runner_id, account_id, name, updated_by) ON runner_settings TO onboarding_ops;
CREATE POLICY onboarding_ops_device_insert ON runner_settings FOR INSERT TO onboarding_ops
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- UPDATE (role) is only a way to lock a membership row FOR SHARE (Postgres wants UPDATE before it allows the lock); the one UPDATE policy refuses every write.
GRANT SELECT (account_id, user_id, role), UPDATE (role) ON account_members TO onboarding_ops;
CREATE POLICY onboarding_ops_device_select ON account_members FOR SELECT TO onboarding_ops USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY onboarding_ops_device_lock ON account_members FOR UPDATE TO onboarding_ops USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (false);

GRANT SELECT (id, deleted_at) ON accounts TO onboarding_ops;
CREATE POLICY onboarding_ops_device_select ON accounts FOR SELECT TO onboarding_ops USING (true);

GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO onboarding_ops;
CREATE POLICY onboarding_ops_device_audit ON audit_log FOR INSERT TO onboarding_ops
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action IN ('runner.device_approved', 'runner.device_denied', 'runner.registered'));

-- The CHECKs on runner_settings run as the writer.
GRANT EXECUTE ON FUNCTION runner_name_valid(text) TO onboarding_ops;
GRANT EXECUTE ON FUNCTION runner_labels_valid(text[]) TO onboarding_ops;

-- ---- ownership bracket (1036's shape) ------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'onboarding_ops'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on onboarding_ops; cannot ALTER FUNCTION ... OWNER TO onboarding_ops';
    END IF;
    GRANT onboarding_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO onboarding_ops;

-- ---- start ------------------------------------------------------------------------------------------------------------------------------------------

CREATE FUNCTION runner_device_start(p_device_hash text, p_user_hash text, p_jwk jsonb, p_jkt text, p_facts jsonb, p_ip_hash text, p_ip_limit integer, p_global_limit integer)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_expires timestamptz := now() + interval '10 minutes';
BEGIN
  IF p_device_hash IS NULL OR p_device_hash !~ '^[0-9a-f]{64}$' OR p_user_hash IS NULL OR p_user_hash !~ '^[0-9a-f]{64}$'
     OR p_ip_hash IS NULL OR p_ip_hash !~ '^[0-9a-f]{64}$' OR p_jkt IS NULL OR p_jkt !~ '^[A-Za-z0-9_-]{43}$'
     OR p_ip_limit IS NULL OR p_ip_limit < 1 OR p_global_limit IS NULL OR p_global_limit < 1
     OR p_jwk IS NULL OR p_facts IS NULL THEN
    RAISE EXCEPTION 'runner_device_start: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- One start at a time, so the two counts below cannot be raced past their limits.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_device_start', 0));
  IF (SELECT count(*) FROM public.runner_device_codes c WHERE c.start_ip_hash = p_ip_hash AND c.created_at > now() - interval '1 hour') >= p_ip_limit
     OR (SELECT count(*) FROM public.runner_device_codes c WHERE c.created_at > now() - interval '1 hour') >= p_global_limit THEN
    RAISE EXCEPTION 'runner_device_start: too many starts' USING ERRCODE = 'configuration_limit_exceeded';
  END IF;
  -- A unique violation on either hash is the caller's cue to draw a new code and try again.
  INSERT INTO public.runner_device_codes (device_code_hash, user_code_hash, jkt, public_key_jwk, facts, expires_at, start_ip_hash)
  VALUES (p_device_hash, p_user_hash, p_jkt, p_jwk, p_facts, v_expires, p_ip_hash);
  RETURN v_expires;
END;
$$;

-- ---- lookup, approve, deny: the three calls a person makes -----------------------------------------------------------------------------------

-- The caller must be an owner or admin of an active account; the account and the person are the session's (app.account_id, app.user_id).
CREATE FUNCTION runner_device_lookup(p_user_hash text)
RETURNS TABLE (outcome text, facts jsonb, expires_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v     public.runner_device_codes;
BEGIN
  IF acct IS NULL OR usr IS NULL OR NOT account_is_active(acct)
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'runner_device_lookup: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user_hash IS NULL OR p_user_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'runner_device_lookup: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- One wrong-code count at a time per account, so concurrent wrong codes cannot all read the old count and slip past the limit of 6.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_device_attempts:' || acct::text, 0));
  DELETE FROM public.runner_device_attempts a WHERE a.account_id = acct AND a.created_at < now() - interval '1 day';
  IF (SELECT count(*) FROM public.runner_device_attempts a WHERE a.account_id = acct AND a.created_at > now() - interval '15 minutes') >= 6 THEN
    outcome := 'limited'; RETURN NEXT; RETURN;
  END IF;
  -- A code with no account is anyone's to find; one with an account is found only by that account.
  SELECT * INTO v FROM public.runner_device_codes c WHERE c.user_code_hash = p_user_hash AND (c.account_id IS NULL OR c.account_id = acct);
  IF NOT FOUND THEN
    INSERT INTO public.runner_device_attempts (account_id) VALUES (acct);
    IF (SELECT count(*) FROM public.runner_device_attempts a WHERE a.account_id = acct AND a.created_at > now() - interval '15 minutes') >= 6 THEN
      outcome := 'limited';
    ELSE
      outcome := 'not_found';
    END IF;
    RETURN NEXT; RETURN;
  END IF;
  IF v.status <> 'pending' OR v.expires_at <= now() THEN
    outcome := 'gone'; RETURN NEXT; RETURN;
  END IF;
  outcome := 'ok'; facts := v.facts; expires_at := v.expires_at;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION runner_device_approve(p_user_hash text, p_name text, p_max_runners integer)
RETURNS TABLE (outcome text, runner_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v     public.runner_device_codes;
  v_id  uuid;
BEGIN
  IF acct IS NULL OR usr IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'runner_device_approve: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user_hash IS NULL OR p_user_hash !~ '^[0-9a-f]{64}$' OR p_max_runners IS NULL OR p_max_runners < 0
     OR (p_name IS NOT NULL AND NOT public.runner_name_valid(p_name)) THEN
    RAISE EXCEPTION 'runner_device_approve: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- One wrong-code count at a time per account, so concurrent wrong codes cannot all read the old count and slip past the limit of 6.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_device_attempts:' || acct::text, 0));
  -- One registration at a time per account (the same lock every registration path takes), so the count below cannot be raced past the limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_register:' || acct::text, 0));
  -- The approver stays an owner or admin until this transaction ends: a demotion waits for it and then revokes the runner this call makes.
  PERFORM 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin') FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_device_approve: caller is not an owner or admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.runner_device_attempts a WHERE a.account_id = acct AND a.created_at < now() - interval '1 day';
  IF (SELECT count(*) FROM public.runner_device_attempts a WHERE a.account_id = acct AND a.created_at > now() - interval '15 minutes') >= 6 THEN
    outcome := 'limited'; RETURN NEXT; RETURN;
  END IF;
  SELECT * INTO v FROM public.runner_device_codes c WHERE c.user_code_hash = p_user_hash AND (c.account_id IS NULL OR c.account_id = acct) FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.runner_device_attempts (account_id) VALUES (acct);
    IF (SELECT count(*) FROM public.runner_device_attempts a WHERE a.account_id = acct AND a.created_at > now() - interval '15 minutes') >= 6 THEN
      outcome := 'limited';
    ELSE
      outcome := 'not_found';
    END IF;
    RETURN NEXT; RETURN;
  END IF;
  IF v.status <> 'pending' OR v.expires_at <= now() THEN
    outcome := 'gone'; RETURN NEXT; RETURN;
  END IF;
  IF (SELECT count(*) FROM public.runners r WHERE r.account_id = acct AND r.revoked_at IS NULL) >= p_max_runners THEN
    outcome := 'runner_limit'; RETURN NEXT; RETURN;
  END IF;
  BEGIN
    INSERT INTO public.runners (account_id, registered_by, public_key_jwk, jkt, credential_mode, allowed_repo_ids)
    VALUES (acct, usr, v.public_key_jwk, v.jkt, 'subscription', '{}')
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    outcome := 'key_registered'; RETURN NEXT; RETURN;
  END;
  IF p_name IS NOT NULL THEN
    INSERT INTO public.runner_settings (runner_id, account_id, name, updated_by) VALUES (v_id, acct, p_name, usr);
  END IF;
  UPDATE public.runner_device_codes c
     SET status = 'approved', account_id = acct, approved_by = usr, approved_at = now(), runner_id = v_id
   WHERE c.id = v.id AND c.status = 'pending';
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at) VALUES
    (acct, 'user:' || usr::text, 'runner.device_approved', jsonb_build_object('runner_id', v_id, 'device_code_id', v.id), clock_timestamp()),
    (acct, 'runner:' || v_id::text, 'runner.registered', jsonb_build_object('runner_id', v_id, 'registered_by', usr, 'credential_mode', 'subscription', 'jkt', v.jkt, 'via', 'device_code'), clock_timestamp());
  outcome := 'ok'; runner_id := v_id;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION runner_device_deny(p_user_hash text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v     public.runner_device_codes;
BEGIN
  IF acct IS NULL OR usr IS NULL OR NOT account_is_active(acct)
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'runner_device_deny: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user_hash IS NULL OR p_user_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'runner_device_deny: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- One wrong-code count at a time per account, so concurrent wrong codes cannot all read the old count and slip past the limit of 6.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_device_attempts:' || acct::text, 0));
  IF (SELECT count(*) FROM public.runner_device_attempts a WHERE a.account_id = acct AND a.created_at > now() - interval '15 minutes') >= 6 THEN
    RETURN 'limited';
  END IF;
  SELECT * INTO v FROM public.runner_device_codes c WHERE c.user_code_hash = p_user_hash AND (c.account_id IS NULL OR c.account_id = acct) FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.runner_device_attempts (account_id) VALUES (acct);
    RETURN CASE WHEN (SELECT count(*) FROM public.runner_device_attempts a WHERE a.account_id = acct AND a.created_at > now() - interval '15 minutes') >= 6 THEN 'limited' ELSE 'not_found' END;
  END IF;
  IF v.status <> 'pending' OR v.expires_at <= now() THEN
    RETURN 'gone';
  END IF;
  UPDATE public.runner_device_codes c SET status = 'denied', account_id = acct WHERE c.id = v.id AND c.status = 'pending';
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'user:' || usr::text, 'runner.device_denied', jsonb_build_object('device_code_id', v.id), clock_timestamp());
  RETURN 'ok';
END;
$$;

-- ---- poll: the machine's two calls -------------------------------------------------------------------------------------------------------------

-- The key a code was started with, for the signature check. It says nothing of the code's state, so a caller learns nothing before it has signed.
CREATE FUNCTION runner_device_key(p_device_hash text)
RETURNS TABLE (jkt text, public_key_jwk jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.jkt, c.public_key_jwk FROM public.runner_device_codes c
   WHERE p_device_hash ~ '^[0-9a-f]{64}$' AND c.device_code_hash = p_device_hash;
$$;

CREATE FUNCTION runner_device_poll(p_device_hash text, p_jkt text, p_interval_seconds integer)
RETURNS TABLE (outcome text, runner_id uuid, account_id uuid, credential_mode text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v  public.runner_device_codes;
  r  record;
BEGIN
  IF p_device_hash IS NULL OR p_device_hash !~ '^[0-9a-f]{64}$' OR p_jkt IS NULL OR p_interval_seconds IS NULL OR p_interval_seconds < 1 THEN
    RAISE EXCEPTION 'runner_device_poll: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v FROM public.runner_device_codes c WHERE c.device_code_hash = p_device_hash FOR UPDATE;
  -- Another key than the one the code was started with gets the answer of no code at all.
  IF NOT FOUND OR v.jkt <> p_jkt THEN
    outcome := 'unknown'; RETURN NEXT; RETURN;
  END IF;
  IF v.status = 'denied' OR v.status = 'consumed' OR v.status = 'expired' OR (v.status = 'pending' AND v.expires_at <= now()) THEN
    IF v.status = 'pending' THEN
      UPDATE public.runner_device_codes c SET status = 'expired' WHERE c.id = v.id;
    END IF;
    outcome := CASE WHEN v.status IN ('pending', 'expired') THEN 'expired' ELSE v.status END; RETURN NEXT; RETURN;
  END IF;
  IF v.last_polled_at IS NOT NULL AND v.last_polled_at > now() - make_interval(secs => p_interval_seconds) THEN
    UPDATE public.runner_device_codes c SET attempts = c.attempts + 1 WHERE c.id = v.id;
    outcome := 'slow_down'; RETURN NEXT; RETURN;
  END IF;
  IF v.status = 'pending' THEN
    UPDATE public.runner_device_codes c SET last_polled_at = now() WHERE c.id = v.id;
    outcome := 'pending'; RETURN NEXT; RETURN;
  END IF;
  -- Approved: the registration is handed out once. The code is consumed whatever the runner's state, and a revoked runner gets none.
  SELECT n.id, n.account_id, n.credential_mode, n.revoked_at INTO r FROM public.runners n WHERE n.id = v.runner_id AND n.account_id = v.account_id;
  UPDATE public.runner_device_codes c SET status = 'consumed', last_polled_at = now() WHERE c.id = v.id;
  IF r.id IS NULL OR r.revoked_at IS NOT NULL THEN
    outcome := 'denied'; RETURN NEXT; RETURN;
  END IF;
  outcome := 'approved'; runner_id := r.id; account_id := r.account_id; credential_mode := r.credential_mode;
  RETURN NEXT;
END;
$$;

-- ---- ownership and EXECUTE ----------------------------------------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION runner_device_start(text, text, jsonb, text, jsonb, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_device_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_device_approve(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_device_deny(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_device_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_device_poll(text, text, integer) FROM PUBLIC;
ALTER FUNCTION runner_device_start(text, text, jsonb, text, jsonb, text, integer, integer) OWNER TO onboarding_ops;
ALTER FUNCTION runner_device_lookup(text) OWNER TO onboarding_ops;
ALTER FUNCTION runner_device_approve(text, text, integer) OWNER TO onboarding_ops;
ALTER FUNCTION runner_device_deny(text) OWNER TO onboarding_ops;
ALTER FUNCTION runner_device_key(text) OWNER TO onboarding_ops;
ALTER FUNCTION runner_device_poll(text, text, integer) OWNER TO onboarding_ops;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION runner_device_start(text, text, jsonb, text, jsonb, text, integer, integer) TO app_user;
GRANT EXECUTE ON FUNCTION runner_device_lookup(text) TO app_user;
GRANT EXECUTE ON FUNCTION runner_device_approve(text, text, integer) TO app_user;
GRANT EXECUTE ON FUNCTION runner_device_deny(text) TO app_user;
GRANT EXECUTE ON FUNCTION runner_device_key(text) TO app_user;
GRANT EXECUTE ON FUNCTION runner_device_poll(text, text, integer) TO app_user;

REVOKE CREATE ON SCHEMA public FROM onboarding_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE onboarding_ops FROM CURRENT_USER;
  END IF;
END
$$;
