-- D#7 AAP-d1-iii: provisioner tokens and the instance reads and renames. A token may manage the instances of one account and nothing
-- else (it cannot raise, decide or consume). Stored like an instance credential: sha256 and a 4-character hint. Token create and revoke are
-- session-only (owner or admin); instance create, close, rename and get take a token or a session via aap_manager_account, which this file
-- replaces with the token branch. Same roles and shape as 0837. It also takes the sealed arguments away from app_user's table read: they are
-- opened only through aap_arguments_get, which needs an owner or admin session (a plain member of the account can read every other column).
-- Expand-safe: a table and functions are new; the table-level SELECT on action_approvals becomes a column list that leaves out only arguments_sealed.

CREATE TABLE aap_provisioner_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  label         text NOT NULL CONSTRAINT aap_tokens_label_check CHECK (length(label) BETWEEN 1 AND 100),
  token_sha256  text NOT NULL CONSTRAINT aap_tokens_sha_check CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  token_hint    text NOT NULL CONSTRAINT aap_tokens_hint_check CHECK (length(token_hint) = 4),
  created_by    uuid NOT NULL,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_sha256)
);
CREATE INDEX aap_provisioner_tokens_account ON aap_provisioner_tokens (account_id, created_at);


ALTER TABLE aap_provisioner_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE aap_provisioner_tokens FORCE ROW LEVEL SECURITY;
REVOKE ALL ON aap_provisioner_tokens FROM PUBLIC;
CREATE POLICY aap_definer_all ON aap_provisioner_tokens FOR ALL TO aap_definer USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON aap_provisioner_tokens FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
GRANT SELECT (id, account_id, label, token_hint, created_by, revoked_at, last_used_at, created_at) ON aap_provisioner_tokens TO app_user;
GRANT SELECT, INSERT, UPDATE ON aap_provisioner_tokens TO aap_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'aap_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on aap_definer; cannot ALTER FUNCTION ... OWNER TO aap_definer';
    END IF;
    GRANT aap_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO aap_definer;


-- The caller of an instance-management function: a provisioner token (sha256) or, with none, a session owner or admin. Returns the account.
-- Replaces 0837's session-only version with the token branch added. Plain (not a definer): it runs as aap_definer inside the definers below, and nothing else can call it.
CREATE OR REPLACE FUNCTION aap_manager_account(p_token text, OUT o_account uuid, OUT o_actor text) RETURNS record
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_user   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_role   text;
BEGIN
  IF p_token IS NOT NULL THEN
    UPDATE public.aap_provisioner_tokens SET last_used_at = now()
     WHERE token_sha256 = p_token AND revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id AND a.deleted_at IS NULL)
     RETURNING account_id, 'token:' || id INTO o_account, o_actor;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unauthenticated: the provisioner token is not valid' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN;
  END IF;
  IF v_tenant IS NULL OR v_user IS NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'session_required: only a signed-in person can do this' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.role INTO v_role FROM public.account_members m WHERE m.account_id = v_tenant AND m.user_id = v_user;
  IF v_role IS NULL OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = v_tenant AND a.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'session_required: the user is not a member of this account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'forbidden: this needs the owner or admin role' USING ERRCODE = 'insufficient_privilege';
  END IF;
  o_account := v_tenant;
  o_actor := 'user:' || v_user;
END;
$$;


CREATE FUNCTION aap_token_create(p_label text, p_token_sha256 text, p_hint text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_who  record;
  v_id   uuid;
BEGIN
  SELECT * INTO v_who FROM public.aap_manager_account(NULL);
  INSERT INTO public.aap_provisioner_tokens (account_id, label, token_sha256, token_hint, created_by)
  VALUES (v_who.o_account, p_label, p_token_sha256, p_hint, v_user) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
CREATE FUNCTION aap_token_revoke(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_who record;
BEGIN
  SELECT * INTO v_who FROM public.aap_manager_account(NULL);
  UPDATE public.aap_provisioner_tokens SET revoked_at = now() WHERE id = p_id AND account_id = v_who.o_account AND revoked_at IS NULL;
  IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM public.aap_provisioner_tokens WHERE id = p_id AND account_id = v_who.o_account) THEN
    RAISE EXCEPTION 'not_found: no such token' USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;
CREATE FUNCTION aap_instance_rename(p_token text, p_id uuid, p_name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_who record;
BEGIN
  SELECT * INTO v_who FROM public.aap_manager_account(p_token);
  UPDATE public.aap_instances SET name = p_name WHERE id = p_id AND account_id = v_who.o_account AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such instance' USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;
-- A provisioner token reads one instance (no hash leaves).
CREATE FUNCTION aap_instance_get(p_token text, p_id uuid)
RETURNS TABLE (o_id uuid, o_name text, o_credential_hint text, o_revoked_at timestamptz, o_deleted_at timestamptz, o_created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_who record;
BEGIN
  SELECT * INTO v_who FROM public.aap_manager_account(p_token);
  RETURN QUERY SELECT i.id, i.name, i.credential_hint, i.revoked_at, i.deleted_at, i.created_at
    FROM public.aap_instances i WHERE i.id = p_id AND i.account_id = v_who.o_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such instance' USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;
REVOKE SELECT ON action_approvals FROM app_user;
GRANT SELECT (id, account_id, instance_id, tool, server, arguments_kek_version, arguments_sha256, arguments_bytes, agent_reasoning, context, requested_timeout_s,
              deadline_at, status, decided_by_kind, decided_by, rule_id, rule_set_version, route_version, note, decided_at, expires_at, consumed_at, outcome,
              outcome_note, outcome_at, created_at) ON action_approvals TO app_user;

-- The sealed arguments of one request, for a signed-in owner or admin of its account (a member, a token principal or another account gets an error).
CREATE FUNCTION aap_arguments_get(p_id uuid)
RETURNS TABLE (o_account_id uuid, o_sealed bytea, o_kek_version integer, o_sha256 text, o_bytes integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_who record;
BEGIN
  SELECT * INTO v_who FROM public.aap_manager_account(NULL);
  RETURN QUERY SELECT a.account_id, a.arguments_sealed, a.arguments_kek_version, a.arguments_sha256, a.arguments_bytes
    FROM public.action_approvals a WHERE a.id = p_id AND a.account_id = v_who.o_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such request' USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- Ownership and EXECUTE (aap_invoker only).
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('aap_token_create', 'aap_token_revoke', 'aap_instance_rename', 'aap_instance_get', 'aap_arguments_get') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('ALTER FUNCTION %s OWNER TO aap_definer', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO aap_invoker', f.sig);
  END LOOP;
END
$$;

REVOKE CREATE ON SCHEMA public FROM aap_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE aap_definer FROM CURRENT_USER;
  END IF;
END
$$;
