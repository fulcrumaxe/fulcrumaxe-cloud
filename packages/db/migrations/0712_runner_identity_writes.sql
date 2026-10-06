-- D#6 R2a0: the write paths for runner identity. A new file, shaped after 0678 (privilege bracket, SECURITY
-- DEFINER, pinned search_path, EXECUTE for app_user only) and 0658 (audit row in the same transaction).
--
-- 0711 gave app_user SELECT on runners and nothing more, on purpose, and that stays: app_user still cannot INSERT
-- or UPDATE a runner row. Every change to a runner goes through one of the definers below, all owned by
-- platform_ops, all with the account taken from the tenant session (app.account_id), never from an argument:
--
--   runner_register(code_sha256, public_key_jwk, isolation)   inserts a runner for the session's account. The code
--       must belong to that account, be unused and unexpired, and its minter must still be an owner or admin. The
--       registrant, credential mode and repo list come from the code row. On an account whose plan is the string
--       'runner' at most 2 runners may be active (see the seam note on the function).
--   runner_rotate_key(runner_id, old_jkt, new_public_key_jwk) replaces the key of one active runner of the account,
--       only if the caller names the key currently stored (compare and set).
--   runner_self_revoke()                                      revokes the runner named by app.runner_id in the session's
--       account. For the runner's own signed revoke request; takes no argument.
--   runner_revoke(runner_id, reason)                          sets revoked_at. The caller must be a member and an
--       owner, an admin, or the runner's registrant.
--   runner_key_thumbprint(jwk)                                helper: validates an Ed25519 public JWK and returns its
--       RFC 7638 thumbprint, so the stored jkt can never disagree with the stored key.
--
-- app.runner_id (C11): rotate and self-revoke act on the runner the session names in app.runner_id. That setting
-- is set ONLY by R2a's signature-verifying runner middleware, after it has verified a request signed by that
-- runner's current key, and NEVER by session (user) routes. A member session therefore cannot rotate or self-revoke
-- a runner, even knowing its id and key thumbprint.
--
-- Plus a trigger (criterion 7 of R2a): when a member stops being an owner or admin of an account, or is removed, the
-- runners they registered are revoked in the SAME transaction as that change. A trigger, not a function the caller
-- must remember: the role gate in 0005 lets an admin UPDATE account_members.role directly, so any route that
-- demotes someone is covered. A rolled-back demotion rolls the revocation back with it.
--
-- Refusals use fixed SQLSTATEs and fixed messages (never an argument value):
--   42501 not permitted (no tenant context, not a member, wrong role, key mismatch)
--   22023 invalid argument (key format or length, enum, hash)
--   P0002 not found, which includes a row of another account and an unusable code
--   55000 wrong state (runner already revoked)
--   53400 runner limit reached
--   23505 key already registered
-- Each function that changes a row writes one audit_log row in the same transaction.
--
-- Not here: the leases a revoked runner holds. They are failed by the worker's failRunnerLeases, which is the only
-- code with the login that may write agent_runs.status.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO platform_ops;

-- Validates an Ed25519 public JWK (exactly kty, crv and x; x is 43 base64url characters that decode to 32 bytes
-- and re-encode to the same text) and returns its RFC 7638 thumbprint: the SHA-256 of the members in key order,
-- base64url without padding.
CREATE FUNCTION runner_key_thumbprint(p_jwk jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  x   text;
  raw bytea;
BEGIN
  IF p_jwk IS NULL OR jsonb_typeof(p_jwk) <> 'object'
     OR (p_jwk - 'kty' - 'crv' - 'x') <> '{}'::jsonb
     OR p_jwk ->> 'kty' IS DISTINCT FROM 'OKP'
     OR p_jwk ->> 'crv' IS DISTINCT FROM 'Ed25519'
     OR jsonb_typeof(p_jwk -> 'x') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'runner key: not an Ed25519 public key' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  x := p_jwk ->> 'x';
  IF x !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'runner key: x is not 43 base64url characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  raw := decode(translate(x, '-_', '+/') || '=', 'base64');
  IF octet_length(raw) <> 32 OR translate(rtrim(encode(raw, 'base64'), '='), '+/', '-_') <> x THEN
    RAISE EXCEPTION 'runner key: x is not a canonical 32-byte value' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN translate(
    rtrim(encode(sha256(convert_to('{"crv":"Ed25519","kty":"OKP","x":"' || x || '"}', 'UTF8')), 'base64'), '='),
    '+/', '-_');
END;
$$;

CREATE FUNCTION runner_register(p_code_sha256 text, p_public_key_jwk jsonb, p_isolation text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_jkt  text;
  v_code public.runner_registration_codes;
  v_plan text;
  v_id   uuid;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'runner_register: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_code_sha256 IS NULL OR p_code_sha256 !~ '^[0-9a-f]{64}$'
     OR (p_isolation IS NOT NULL AND p_isolation NOT IN ('microvm', 'vm_container', 'container', 'host_sandbox')) THEN
    RAISE EXCEPTION 'runner_register: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_jkt := public.runner_key_thumbprint(p_public_key_jwk);

  -- One registration at a time per account, so the count below cannot be raced past the limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_register:' || acct::text, 0));

  -- The code must be this account's, unused, unexpired, and minted by someone who is still an owner or admin.
  -- Every way of failing gives the same answer, so a caller learns nothing about which check it was.
  SELECT * INTO v_code FROM public.runner_registration_codes c
   WHERE c.account_id = acct AND c.code_sha256 = p_code_sha256
   FOR UPDATE;
  IF NOT FOUND OR v_code.used_at IS NOT NULL OR v_code.expires_at <= now()
     OR NOT EXISTS (SELECT 1 FROM public.account_members m
                     WHERE m.account_id = acct AND m.user_id = v_code.registered_by AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'runner_register: the code is not valid' USING ERRCODE = 'no_data_found';
  END IF;

  -- TEMPORARY SEAM (D#6 R2b criterion 12 and C9 section 3): the plan is compared as the string 'runner' and the
  -- limit is 2 active runners. R2b replaces this with the plan data (maxRunners). No plan value is written here.
  SELECT a.plan INTO v_plan FROM public.accounts a WHERE a.id = acct;
  IF v_plan = 'runner'
     AND (SELECT count(*) FROM public.runners r WHERE r.account_id = acct AND r.revoked_at IS NULL) >= 2 THEN
    RAISE EXCEPTION 'runner_register: runner limit reached' USING ERRCODE = 'configuration_limit_exceeded';
  END IF;

  UPDATE public.runner_registration_codes SET used_at = now() WHERE id = v_code.id;

  BEGIN
    INSERT INTO public.runners (account_id, registered_by, public_key_jwk, jkt, credential_mode, isolation, allowed_repo_ids)
    VALUES (acct, v_code.registered_by,
            jsonb_build_object('kty', 'OKP', 'crv', 'Ed25519', 'x', p_public_key_jwk ->> 'x'),
            v_jkt, v_code.credential_mode, p_isolation, v_code.allowed_repo_ids)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'runner_register: that key is already registered' USING ERRCODE = 'unique_violation';
  END;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'runner:' || v_id::text, 'runner.registered', jsonb_build_object(
    'runner_id', v_id, 'registered_by', v_code.registered_by, 'credential_mode', v_code.credential_mode,
    'isolation', p_isolation, 'jkt', v_jkt), clock_timestamp());
  RETURN v_id;
END;
$$;

CREATE FUNCTION runner_rotate_key(p_runner_id uuid, p_old_jkt text, p_new_public_key_jwk jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct      uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_new_jkt text;
  r         public.runners;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'runner_rotate_key: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_runner_id IS NULL OR p_old_jkt IS NULL OR p_old_jkt !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'runner_rotate_key: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Only the verified runner itself (app.runner_id, set by the runner middleware) may rotate its key.
  IF lower(COALESCE(current_setting('app.runner_id', true), '')) IS DISTINCT FROM p_runner_id::text THEN
    RAISE EXCEPTION 'runner_rotate_key: the session is not this runner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_new_jkt := public.runner_key_thumbprint(p_new_public_key_jwk);

  SELECT * INTO r FROM public.runners x WHERE x.id = p_runner_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_rotate_key: runner not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'runner_rotate_key: runner is revoked' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Compare and set: the caller proves which key it verified the request against.
  IF r.jkt <> p_old_jkt THEN
    RAISE EXCEPTION 'runner_rotate_key: the current key does not match' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_new_jkt = r.jkt THEN
    RAISE EXCEPTION 'runner_rotate_key: the new key is the current key' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  BEGIN
    UPDATE public.runners
       SET public_key_jwk = jsonb_build_object('kty', 'OKP', 'crv', 'Ed25519', 'x', p_new_public_key_jwk ->> 'x'),
           jkt = v_new_jkt, key_rotated_at = now()
     WHERE id = r.id AND account_id = acct;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'runner_rotate_key: that key is already registered' USING ERRCODE = 'unique_violation';
  END;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'runner:' || r.id::text, 'runner.key_rotated', jsonb_build_object(
    'runner_id', r.id, 'old_jkt', r.jkt, 'new_jkt', v_new_jkt), clock_timestamp());
  RETURN v_new_jkt;
END;
$$;

CREATE FUNCTION runner_revoke(p_runner_id uuid, p_reason text)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := current_member_user_id();
  rl   text := current_member_role();
  r    public.runners;
  ts   timestamptz := clock_timestamp();
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL THEN
    RAISE EXCEPTION 'runner_revoke: caller is not a member of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_runner_id IS NULL OR p_reason IS NULL OR p_reason NOT IN ('revoked', 'revoke_all', 'compromised') THEN
    RAISE EXCEPTION 'runner_revoke: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO r FROM public.runners x WHERE x.id = p_runner_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_revoke: runner not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (rl IN ('owner', 'admin') OR r.registered_by = usr) THEN
    RAISE EXCEPTION 'runner_revoke: caller may not revoke this runner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF r.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'runner_revoke: runner is already revoked' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE public.runners SET revoked_at = ts, revoked_reason = p_reason WHERE id = r.id AND account_id = acct;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'runner.revoked', jsonb_build_object(
    'runner_id', r.id, 'reason', p_reason, 'registered_by', r.registered_by), ts);
  RETURN ts;
END;
$$;

CREATE FUNCTION runner_self_revoke()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
  r    public.runners;
  ts   timestamptz := clock_timestamp();
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct)
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'runner_self_revoke: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM public.runners x WHERE x.id = raw::uuid AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_self_revoke: runner not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'runner_self_revoke: runner is already revoked' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE public.runners SET revoked_at = ts, revoked_reason = 'runner_self' WHERE id = r.id AND account_id = acct;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'runner:' || r.id::text, 'runner.revoked', jsonb_build_object(
    'runner_id', r.id, 'reason', 'runner_self', 'registered_by', r.registered_by), ts);
  RETURN ts;
END;
$$;

-- Criterion 7: a member who is no longer an owner or admin (demoted, or removed) loses the runners they
-- registered, in the transaction of the change. The actor on the audit row is the acting session user when there
-- is one. Leases are failed afterwards, separately, through the worker.
CREATE FUNCTION runner_revoke_on_member_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  who text := COALESCE(NULLIF(current_setting('app.user_id', true), ''), 'system:membership');
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role IN ('owner', 'admin') THEN
    RETURN NULL;
  END IF;
  WITH revoked AS (
    UPDATE public.runners r
       SET revoked_at = now(), revoked_reason = 'member_demoted'
     WHERE r.account_id = OLD.account_id AND r.registered_by = OLD.user_id AND r.revoked_at IS NULL
    RETURNING r.id, r.registered_by
  )
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  SELECT OLD.account_id, who, 'runner.revoked',
         jsonb_build_object('runner_id', revoked.id, 'reason', 'member_demoted', 'registered_by', revoked.registered_by),
         clock_timestamp()
    FROM revoked;
  RETURN NULL;
END;
$$;

CREATE TRIGGER runner_revoke_on_member_demoted
  AFTER UPDATE OF role ON account_members
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION runner_revoke_on_member_change();
CREATE TRIGGER runner_revoke_on_member_removed
  AFTER DELETE ON account_members
  FOR EACH ROW EXECUTE FUNCTION runner_revoke_on_member_change();

-- EXECUTE: nobody by default, then app_user (the web tier's login) on the four entry points only. The helper and
-- the trigger function are called by the others, as their owner, so they need no grant.
REVOKE ALL ON FUNCTION runner_key_thumbprint(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_register(text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_rotate_key(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_revoke(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_self_revoke() FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_revoke_on_member_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_register(text, jsonb, text) TO app_user;
GRANT EXECUTE ON FUNCTION runner_rotate_key(uuid, text, jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION runner_revoke(uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION runner_self_revoke() TO app_user;

ALTER FUNCTION runner_key_thumbprint(jsonb) OWNER TO platform_ops;
ALTER FUNCTION runner_register(text, jsonb, text) OWNER TO platform_ops;
ALTER FUNCTION runner_rotate_key(uuid, text, jsonb) OWNER TO platform_ops;
ALTER FUNCTION runner_revoke(uuid, text) OWNER TO platform_ops;
ALTER FUNCTION runner_self_revoke() OWNER TO platform_ops;
ALTER FUNCTION runner_revoke_on_member_change() OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
