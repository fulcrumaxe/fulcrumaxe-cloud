-- D#6 R2b (required item 4 of the R2a review follow-ups): the runner identity work that still ran as platform_ops
-- moves behind narrow SECURITY DEFINER functions, so the web tier's platform_ops login no longer writes the runner
-- tables directly. A new file, shaped after 0712 (privilege bracket, pinned search_path, EXECUTE for app_user only) and
-- 0689/0706 (a direct platform_ops session is refused, where the function would otherwise be a way around its guard).
--
-- Before this file, packages/runner-cloud used the platform_ops pool for six statements: the lookup of a runner by key,
-- the lookup of a code by hash, "is this key already registered", the nonce insert and prune, the registration-code
-- insert, and hello's version columns. Each is now one function below, all owned by platform_ops, all executable by
-- app_user (the web tier's login) and nobody else:
--
--   runner_lookup_by_jkt(jkt)                 the active runner holding that key, or no row. Revoked runners are not found.
--   runner_jkt_registered(jkt)                whether any runner, revoked or not, holds that key.
--   runner_code_account(code_sha256)          the account a registration code belongs to, or NULL.
--   runner_nonce_record(runner, nonce, secs)  prunes nonces older than `secs`, then records this one. true when it is new.
--                                             `secs` must be at least 180: a signature is accepted for up to 121 seconds
--                                             (60 either side of `created`, plus the second the clock is read in), so a
--                                             nonce kept for less than that could be replayed inside the signature window.
--   runner_registration_code_create(...)      inserts a code for the session's account. The session must be an owner or
--                                             admin (taken from app.account_id and app.user_id, never from an argument).
--   runner_hello_record(version, binary, iso) records the versions of the runner named by app.runner_id, which only the
--                                             signature-verifying runner middleware sets (C11).
--
-- Why the lookups are here too. They run before any tenant is known, so they have no row policy to lean on. As functions
-- they return exactly the columns the verifier needs and take one exact key, so the web tier's other logins and routes can
-- not enumerate runners through them.
--
-- The tables themselves. platform_ops keeps its table privileges because the functions run as their owner and need them,
-- exactly as 0689 and 0706 do. What changes is that a direct platform_ops session can no longer use them: a trigger on
-- each of the three tables refuses a statement issued straight from a platform_ops login. Statements that run inside
-- another trigger or a foreign-key action (pg_trigger_depth() above 1) are not refused: 0712's revoke-on-demotion trigger
-- updates runners when a member is demoted, and an account deletion cascades to all three tables, whichever login does it.
--
-- Who owns the guard. The trigger function is deliberately NOT owned by platform_ops (it stays with the role that runs the
-- migration). A role that owns a function can DROP it, and DROP FUNCTION ... CASCADE removes every trigger that uses it
-- without asking who owns the tables; that would let a direct platform_ops login switch off the very guard that restricts it.
-- The function is not SECURITY DEFINER and needs no privilege of its own, so nothing is lost. The definers below are
-- different: they are owned by platform_ops because they must run with its table privileges, and none of them is a guard.
-- Rule for this file and 0725 to 0727: no guard or trigger function is owned by a role it guards against.
--
-- Refusals use the same fixed SQLSTATEs and messages as 0712 (never an argument value):
--   42501 not permitted (no tenant context, wrong role, a platform_ops login)
--   22023 invalid argument
--   P0002 not found (a runner that does not exist or is revoked, a repo of another account)
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO platform_ops;

-- The guard. One function for the three tables: a direct write from a platform_ops login is refused.
CREATE FUNCTION runner_tables_platform_ops_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'platform_ops' AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION '%: platform_ops may not write this table directly; use the runner_* functions', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER runners_platform_ops_guard
  BEFORE INSERT OR UPDATE OR DELETE ON runners
  FOR EACH ROW EXECUTE FUNCTION runner_tables_platform_ops_guard();
CREATE TRIGGER runner_registration_codes_platform_ops_guard
  BEFORE INSERT OR UPDATE OR DELETE ON runner_registration_codes
  FOR EACH ROW EXECUTE FUNCTION runner_tables_platform_ops_guard();
CREATE TRIGGER runner_request_nonces_platform_ops_guard
  BEFORE INSERT OR UPDATE OR DELETE ON runner_request_nonces
  FOR EACH ROW EXECUTE FUNCTION runner_tables_platform_ops_guard();

CREATE FUNCTION runner_lookup_by_jkt(p_jkt text)
RETURNS TABLE (
  id              uuid,
  account_id      uuid,
  registered_by   uuid,
  credential_mode text,
  public_key_jwk  jsonb,
  jkt             text,
  created_at      timestamptz,
  key_rotated_at  timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_lookup_by_jkt: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_jkt IS NULL OR p_jkt !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'runner_lookup_by_jkt: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
    SELECT r.id, r.account_id, r.registered_by, r.credential_mode, r.public_key_jwk, r.jkt, r.created_at, r.key_rotated_at
      FROM public.runners r
     WHERE r.jkt = p_jkt AND r.revoked_at IS NULL;
END;
$$;

CREATE FUNCTION runner_jkt_registered(p_jkt text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_jkt_registered: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_jkt IS NULL OR p_jkt !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'runner_jkt_registered: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.runners r WHERE r.jkt = p_jkt);
END;
$$;

CREATE FUNCTION runner_code_account(p_code_sha256 text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_account uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_code_account: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_code_sha256 IS NULL OR p_code_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'runner_code_account: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT c.account_id INTO v_account FROM public.runner_registration_codes c WHERE c.code_sha256 = p_code_sha256;
  RETURN v_account;
END;
$$;

CREATE FUNCTION runner_nonce_record(p_runner_id uuid, p_nonce text, p_retention_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_rows    integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_nonce_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 180 is the floor: see the header. The caller derives its value from the signature's skew constant and may keep longer.
  IF p_runner_id IS NULL OR p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{16,64}$'
     OR p_retention_seconds IS NULL OR p_retention_seconds < 180 OR p_retention_seconds > 3600 THEN
    RAISE EXCEPTION 'runner_nonce_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The account comes from the runner's own row, so a nonce can never be filed under another account.
  SELECT r.account_id INTO v_account FROM public.runners r WHERE r.id = p_runner_id AND r.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_nonce_record: runner not found' USING ERRCODE = 'no_data_found';
  END IF;
  DELETE FROM public.runner_request_nonces WHERE seen_at < now() - make_interval(secs => p_retention_seconds);
  INSERT INTO public.runner_request_nonces (account_id, runner_id, nonce)
  VALUES (v_account, p_runner_id, p_nonce)
  ON CONFLICT (runner_id, nonce) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

CREATE FUNCTION runner_registration_code_create(p_code_sha256 text, p_credential_mode text, p_allowed_repo_ids uuid[], p_ttl_minutes integer)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr     uuid := current_member_user_id();
  rl      text := current_member_role();
  v_repos uuid[];
  v_exp   timestamptz;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_registration_code_create: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR rl IS NULL OR rl NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'runner_registration_code_create: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_code_sha256 IS NULL OR p_code_sha256 !~ '^[0-9a-f]{64}$'
     OR p_credential_mode IS NULL OR p_credential_mode NOT IN ('subscription', 'api_key')
     OR p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 60
     OR p_allowed_repo_ids IS NULL OR cardinality(p_allowed_repo_ids) > 100
     OR array_position(p_allowed_repo_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'runner_registration_code_create: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x), '{}') INTO v_repos FROM unnest(p_allowed_repo_ids) AS x;
  -- Every repo must be one of this account's.
  IF (SELECT count(*) FROM public.repos rp WHERE rp.account_id = acct AND rp.id = ANY (v_repos)) <> cardinality(v_repos) THEN
    RAISE EXCEPTION 'runner_registration_code_create: a repo is not one of the account''s' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.runner_registration_codes (account_id, registered_by, code_sha256, expires_at, credential_mode, allowed_repo_ids)
  VALUES (acct, usr, p_code_sha256, now() + make_interval(mins => p_ttl_minutes), p_credential_mode, v_repos)
  RETURNING expires_at INTO v_exp;
  RETURN v_exp;
END;
$$;

CREATE FUNCTION runner_hello_record(p_protocol_version integer, p_binary_version text, p_isolation text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
  v_rows integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_hello_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct)
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'runner_hello_record: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_protocol_version IS NULL OR p_protocol_version < 1
     OR p_binary_version IS NULL OR p_binary_version !~ '^[A-Za-z0-9._+-]{1,64}$'
     OR p_isolation IS NULL OR p_isolation NOT IN ('microvm', 'vm_container', 'container', 'host_sandbox') THEN
    RAISE EXCEPTION 'runner_hello_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.runners
     SET protocol_version = p_protocol_version, binary_version = p_binary_version, isolation = p_isolation, last_seen_at = now()
   WHERE id = raw::uuid AND account_id = acct AND revoked_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION runner_tables_platform_ops_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_lookup_by_jkt(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_jkt_registered(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_code_account(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_nonce_record(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_registration_code_create(text, text, uuid[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_hello_record(integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_lookup_by_jkt(text) TO app_user;
GRANT EXECUTE ON FUNCTION runner_jkt_registered(text) TO app_user;
GRANT EXECUTE ON FUNCTION runner_code_account(text) TO app_user;
GRANT EXECUTE ON FUNCTION runner_nonce_record(uuid, text, integer) TO app_user;
GRANT EXECUTE ON FUNCTION runner_registration_code_create(text, text, uuid[], integer) TO app_user;
GRANT EXECUTE ON FUNCTION runner_hello_record(integer, text, text) TO app_user;

ALTER FUNCTION runner_lookup_by_jkt(text) OWNER TO platform_ops;
ALTER FUNCTION runner_jkt_registered(text) OWNER TO platform_ops;
ALTER FUNCTION runner_code_account(text) OWNER TO platform_ops;
ALTER FUNCTION runner_nonce_record(uuid, text, integer) OWNER TO platform_ops;
ALTER FUNCTION runner_registration_code_create(text, text, uuid[], integer) OWNER TO platform_ops;
ALTER FUNCTION runner_hello_record(integer, text, text) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
