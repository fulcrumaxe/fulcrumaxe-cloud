-- D#68 OPS-C1: staff identity and the two roles the operator console runs on. Nothing here is reachable from a customer session; the
-- console itself (apps/ops, OPS-C2) and its views and actions come in later changes.
--
--   ops_console        LOGIN. The only login apps/ops uses (DATABASE_URL_OPS_CONSOLE). It is NOT a member of platform_ops or app_user, holds no
--                      table, column or sequence privilege at all, and can only call the three functions below. An owner sets its password
--                      when the console is deployed; until then nothing can log in as it.
--   ops_owner          NOLOGIN, no members (the migration role holds it only inside this file). Owns the ops views and functions, and holds
--                      exactly the column grants the functions below need, with row policies for this role only. It cannot read
--                      model_connections key columns, run_events.payload or agent_runs.envelope: it holds nothing on those tables.
--
--   platform_staff, staff_webauthn_credentials, staff_enrollment_tokens, staff_audit_log
--                      Staff identity is separate from tenant users. Every table has row security enabled and forced and no policy for any
--                      role but ops_owner, so a platform_ops or app_user login sees nothing. staff_enrollment_tokens has no grant and no
--                      policy yet: OPS-C2 adds the enrollment functions with their own. staff_audit_log is append-only: no role holds UPDATE
--                      or DELETE on it, its reason is required, and its account_id has no foreign key so the evidence outlives the account.
--
--   ops_current_staff()           the active staff id from app.staff_id, or an error (unset, not a uuid, unknown, or inactive).
--   audit_write_staff(...)        writes the tenant-visible audit_log row with actor 'staff:<uuid>'. Owner-only EXECUTE: later ops actions
--                                 (also owned by ops_owner) call it; ops_console and app_user cannot. The staff id passed must be the
--                                 session's own, so an action cannot be recorded in another person's name.
--   ops_login_credential(...)     reads a passkey by credential id for an active staff member (OPS-C2 login).
--   ops_login_bump_sign_count(..) raises the stored signature counter; never lowers it.
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging.

-- ---------------------------------------------------------------------
-- 1. Roles (0001's hardened attributes and post-create assertion).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_owner') THEN
    CREATE ROLE ops_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_console') THEN
    CREATE ROLE ops_console LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE ops_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    ALTER ROLE ops_console LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
DECLARE
  n   text;
  r   record;
  bad text[];
BEGIN
  FOREACH n IN ARRAY ARRAY['ops_owner', 'ops_console'] LOOP
    SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls INTO r FROM pg_roles WHERE rolname = n;
    bad := '{}';
    IF (n = 'ops_owner') = r.rolcanlogin THEN bad := array_append(bad, 'rolcanlogin'); END IF;
    IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
    IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
    IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
    IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
    IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
    IF array_length(bad, 1) > 0 THEN
      RAISE EXCEPTION 'role % has wrong attribute(s): %', n, array_to_string(bad, ', ');
    END IF;
  END LOOP;
  IF pg_has_role('ops_console', 'platform_ops', 'MEMBER') OR pg_has_role('ops_console', 'app_user', 'MEMBER') THEN
    RAISE EXCEPTION 'role ops_console must not be a member of platform_ops or app_user';
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------
CREATE TABLE platform_staff (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL UNIQUE,
  display_name text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_webauthn_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL REFERENCES platform_staff (id) ON DELETE CASCADE,
  credential_id bytea NOT NULL UNIQUE,
  public_key    bytea NOT NULL,
  sign_count    bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_webauthn_credentials_staff_idx ON staff_webauthn_credentials (staff_id);

CREATE TABLE staff_enrollment_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   uuid NOT NULL REFERENCES platform_staff (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX staff_enrollment_tokens_staff_idx ON staff_enrollment_tokens (staff_id);

CREATE TABLE staff_audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   uuid NOT NULL REFERENCES platform_staff (id),
  account_id uuid,
  action     text NOT NULL,
  reason     text NOT NULL CHECK (btrim(reason) <> ''),
  request_id text,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_audit_log_staff_idx ON staff_audit_log (staff_id, created_at);
CREATE INDEX staff_audit_log_account_idx ON staff_audit_log (account_id, created_at) WHERE account_id IS NOT NULL;

ALTER TABLE platform_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_staff FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_webauthn_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_enrollment_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_enrollment_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_audit_log FORCE ROW LEVEL SECURITY;

REVOKE ALL ON platform_staff, staff_webauthn_credentials, staff_enrollment_tokens, staff_audit_log FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO ops_owner, ops_console;

-- What the functions below read and write, and nothing more.
GRANT SELECT (id, active) ON platform_staff TO ops_owner;
GRANT SELECT (credential_id, staff_id, public_key, sign_count), UPDATE (sign_count) ON staff_webauthn_credentials TO ops_owner;
GRANT INSERT (id, staff_id, account_id, action, reason, request_id, payload, created_at) ON staff_audit_log TO ops_owner;
GRANT INSERT (id, account_id, actor, action, payload, created_at) ON audit_log TO ops_owner;

CREATE POLICY ops_owner_select ON platform_staff FOR SELECT TO ops_owner USING (true);
CREATE POLICY ops_owner_select ON staff_webauthn_credentials FOR SELECT TO ops_owner USING (true);
CREATE POLICY ops_owner_update ON staff_webauthn_credentials FOR UPDATE TO ops_owner USING (true) WITH CHECK (true);
CREATE POLICY ops_owner_insert ON staff_audit_log FOR INSERT TO ops_owner WITH CHECK (true);
-- Only a staff-stamped row: an ops_owner function cannot write a row that claims a tenant member or a system source did it.
CREATE POLICY ops_owner_audit ON audit_log FOR INSERT TO ops_owner
  WITH CHECK (actor ~ '^staff:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- ---------------------------------------------------------------------
-- 3. Ownership bracket (0702's shape): a non-superuser migrator needs SET on the role for ALTER ... OWNER TO, and the role holds CREATE
--    on public only for that transfer. Both are reset at the end.
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
-- 4. Functions.
-- ---------------------------------------------------------------------
CREATE FUNCTION ops_current_staff()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  raw text := NULLIF(current_setting('app.staff_id', true), '');
  sid uuid;
BEGIN
  IF raw IS NULL THEN
    RAISE EXCEPTION 'ops_current_staff: no app.staff_id set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  BEGIN
    sid := raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'ops_current_staff: app.staff_id is not a uuid' USING ERRCODE = 'insufficient_privilege';
  END;
  IF NOT EXISTS (SELECT 1 FROM public.platform_staff WHERE id = sid AND active) THEN
    RAISE EXCEPTION 'ops_current_staff: no active staff member for app.staff_id' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN sid;
END;
$$;

CREATE FUNCTION audit_write_staff(p_account_id uuid, p_staff_id uuid, p_action text, p_payload jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  who             text;
  stamped_payload jsonb := p_payload;
  new_id          uuid := gen_random_uuid();
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'audit_write_staff: an account id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_staff_id IS DISTINCT FROM public.ops_current_staff() THEN
    RAISE EXCEPTION 'audit_write_staff: staff id is not the session''s staff member' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_action IS NULL OR p_action !~ '^[a-z][a-z0-9_.]{0,63}$' THEN
    RAISE EXCEPTION 'audit_write_staff: action is not a lowercase identifier' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write_staff: payload must be a JSON object' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  who := 'staff:' || p_staff_id::text;
  -- A caller-supplied `actor` key inside the payload is overwritten, never trusted (0008's rule).
  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(who));
  END IF;

  INSERT INTO public.audit_log (id, account_id, actor, action, payload, created_at)
  VALUES (new_id, p_account_id, who, p_action, stamped_payload, now());
  RETURN new_id;
END;
$$;

CREATE FUNCTION ops_login_credential(p_credential_id bytea)
RETURNS TABLE (staff_id uuid, public_key bytea, sign_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.staff_id, c.public_key, c.sign_count
    FROM public.staff_webauthn_credentials c
    JOIN public.platform_staff s ON s.id = c.staff_id
   WHERE c.credential_id = p_credential_id AND s.active;
$$;

CREATE FUNCTION ops_login_bump_sign_count(p_credential_id bytea, p_sign_count bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.staff_webauthn_credentials c
     SET sign_count = p_sign_count
   WHERE c.credential_id = p_credential_id
     AND p_sign_count > c.sign_count
     AND EXISTS (SELECT 1 FROM public.platform_staff s WHERE s.id = c.staff_id AND s.active);
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION ops_current_staff() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_write_staff(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_login_credential(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops_login_bump_sign_count(bytea, bigint) FROM PUBLIC;
-- EXECUTE goes on before the transfer (as 0702 does): afterwards the non-superuser migrator no longer owns the functions and could not grant.
-- Grants to other roles survive the transfer. audit_write_staff gets none: only its owner calls it.
GRANT EXECUTE ON FUNCTION ops_current_staff() TO ops_console;
GRANT EXECUTE ON FUNCTION ops_login_credential(bytea) TO ops_console;
GRANT EXECUTE ON FUNCTION ops_login_bump_sign_count(bytea, bigint) TO ops_console;
ALTER FUNCTION ops_current_staff() OWNER TO ops_owner;
ALTER FUNCTION audit_write_staff(uuid, uuid, text, jsonb) OWNER TO ops_owner;
ALTER FUNCTION ops_login_credential(bytea) OWNER TO ops_owner;
ALTER FUNCTION ops_login_bump_sign_count(bytea, bigint) OWNER TO ops_owner;

REVOKE CREATE ON SCHEMA public FROM ops_owner;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE ops_owner FROM CURRENT_USER;
  END IF;
END
$$;
