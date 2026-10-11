-- D#605 FL-6: provisioning tokens, the cloud side. A token is a registration code for a machine with no browser: an owner or admin mints it in the
-- workspace, pastes it on the machine, and the machine registers with it through the same /api/runner/register route as a one-time code (0711, 0757).
--
--   runner_provisioning_tokens             one row per token: only the SHA-256 of the secret (token_sha256), who minted it, the name / labels / credential mode /
--                                          repos it carries, its expiry (1 h .. 24 h at most), and once used the runner it made and the first client address.
--   runner_provisioning_token_mint         an owner or admin mints one. At most 5 outstanding per account. Writes an audit row (never the hash).
--   runner_provisioning_token_list         an owner or admin lists the unused, unexpired tokens whose minter is still an owner or admin. Never the secret.
--   runner_provisioning_token_revoke       an owner or admin revokes an unused token; it is unusable from then on. A used token cannot be revoked (remove the runner).
--   runner_provisioning_token_account      the account a token belongs to, before any tenant is known (as runner_code_account, 0724). An unknown token is NULL.
--   runner_provisioning_token_revoke_for_member  a trigger function on account_members: when a minter is demoted below admin or removed, their unused,
--                                          unexpired tokens are stamped revoked at that moment (as 0712/0720 do for runners), so a later re-promotion does not
--                                          revive them. It is SECURITY DEFINER and owned by this file's NOLOGIN role, which nothing can become; that is the one
--                                          entry in trigger-function-ownership's allowlist. Why not 0720's invoker-plus-helper shape: that needs EXECUTE for
--                                          platform_ops on the helper, and migration 0765's platform_ops diff test (rightly) refuses any later migration that
--                                          changes what platform_ops can execute. Postgres checks EXECUTE on a trigger function only when the trigger is made.
--   runner_provisioning_register           the redemption, in one definer: single use, not expired, not revoked, the minter still an owner or admin (locked until
--                                          commit, as 0732 does), the bound repos still the account's, the plan limit; then the runner row, its name and labels,
--                                          the token marked used with the first address, and one audit row.
--
-- The one-time codes of 0711 are not changed or copied: a code and a token are two kinds of credential for one registration route, and the route picks the
-- kind by the secret's prefix. This file adds no privilege for platform_ops anywhere: the table, the role and the functions are the new role's alone.
--
-- Single use is enforced in the database three ways: the redemption takes the token row FOR UPDATE and refuses a used one; used_at is write-once (a trigger refuses
-- changing it, or the secret hash, the expiry, the account or the minter, ever); and a CHECK refuses a row that is both used and revoked.
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging and renumber to stay above its highest.
DO $$
DECLARE
  n text := 'runner_provisioning_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

CREATE TABLE runner_provisioning_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_by       uuid NOT NULL REFERENCES users (id),
  token_sha256     text NOT NULL,
  name             text,
  labels           text[] NOT NULL DEFAULT '{}',
  credential_mode  text NOT NULL,
  allowed_repo_ids uuid[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  runner_id        uuid,
  first_ip         inet,
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES users (id),
  CONSTRAINT runner_provisioning_tokens_sha_key UNIQUE (token_sha256),
  CONSTRAINT runner_provisioning_tokens_sha_format CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT runner_provisioning_tokens_mode_check CHECK (credential_mode IN ('subscription', 'api_key')),
  CONSTRAINT runner_provisioning_tokens_name_check CHECK (name IS NULL OR runner_name_valid(name)),
  CONSTRAINT runner_provisioning_tokens_labels_check CHECK (runner_labels_valid(labels)),
  CONSTRAINT runner_provisioning_tokens_repos_check CHECK (cardinality(allowed_repo_ids) <= 100),
  CONSTRAINT runner_provisioning_tokens_lifetime_check CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  CONSTRAINT runner_provisioning_tokens_used_or_revoked CHECK (NOT (used_at IS NOT NULL AND revoked_at IS NOT NULL)),
  CONSTRAINT runner_provisioning_tokens_runner_when_used CHECK (runner_id IS NULL OR used_at IS NOT NULL),
  CONSTRAINT runner_provisioning_tokens_revoked_by_check CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_runner_provisioning_tokens_account ON runner_provisioning_tokens (account_id, created_at);
CREATE UNIQUE INDEX idx_runner_provisioning_tokens_runner ON runner_provisioning_tokens (runner_id) WHERE runner_id IS NOT NULL;
ALTER TABLE runner_provisioning_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_provisioning_tokens FORCE ROW LEVEL SECURITY;

-- Write-once columns. Not owned by the role it guards (the migrator keeps it), and it grants nothing.
CREATE FUNCTION runner_provisioning_tokens_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.credential_mode IS DISTINCT FROM OLD.credential_mode OR NEW.allowed_repo_ids IS DISTINCT FROM OLD.allowed_repo_ids
     OR NEW.name IS DISTINCT FROM OLD.name OR NEW.labels IS DISTINCT FROM OLD.labels THEN
    RAISE EXCEPTION 'runner_provisioning_tokens: a token''s secret, owner, scope and expiry never change' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR (OLD.first_ip IS NOT NULL AND NEW.first_ip IS DISTINCT FROM OLD.first_ip)
     OR (OLD.runner_id IS NOT NULL AND NEW.runner_id IS DISTINCT FROM OLD.runner_id) THEN
    RAISE EXCEPTION 'runner_provisioning_tokens: use and revocation are written once' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION runner_provisioning_tokens_immutable() FROM PUBLIC;
CREATE TRIGGER runner_provisioning_tokens_immutable
  BEFORE UPDATE ON runner_provisioning_tokens
  FOR EACH ROW EXECUTE FUNCTION runner_provisioning_tokens_immutable();

-- ---- grants and policies ----------------------------------------------------------------------------------------------
-- app_user reads every column but the secret's hash, for its own tenant; it cannot write. platform_ops holds nothing.
GRANT SELECT (id, account_id, created_by, name, labels, credential_mode, allowed_repo_ids, created_at, expires_at, used_at, runner_id, first_ip, revoked_at, revoked_by)
  ON runner_provisioning_tokens TO app_user;
CREATE POLICY tenant_isolation_select ON runner_provisioning_tokens FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

GRANT USAGE ON SCHEMA public TO runner_provisioning_definer;
GRANT SELECT (id, account_id, created_by, token_sha256, name, labels, credential_mode, allowed_repo_ids, created_at, expires_at, used_at, runner_id, first_ip, revoked_at, revoked_by),
      INSERT (account_id, created_by, token_sha256, name, labels, credential_mode, allowed_repo_ids, expires_at),
      UPDATE (used_at, runner_id, first_ip, revoked_at, revoked_by) ON runner_provisioning_tokens TO runner_provisioning_definer;
GRANT SELECT (id, account_id, revoked_at), INSERT (account_id, registered_by, public_key_jwk, jkt, credential_mode, isolation, allowed_repo_ids) ON runners TO runner_provisioning_definer;
GRANT INSERT (runner_id, account_id, name, labels, updated_by) ON runner_settings TO runner_provisioning_definer;
-- UPDATE (role) is not a way to write: Postgres wants an UPDATE privilege (and an UPDATE policy) before it lets a role lock a row FOR SHARE, and the
-- redemption must lock the minter's membership row. The only UPDATE policy this role has is WITH CHECK (false), so no write can succeed.
GRANT SELECT (account_id, user_id, role), UPDATE (role) ON account_members TO runner_provisioning_definer;
GRANT SELECT (id, account_id) ON repos TO runner_provisioning_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_provisioning_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO runner_provisioning_definer;
-- The rules the table's CHECKs call, and the key thumbprint the redemption derives (0712). EXECUTE only: nothing else of platform_ops's is touched.
GRANT EXECUTE ON FUNCTION runner_name_valid(text) TO runner_provisioning_definer;
GRANT EXECUTE ON FUNCTION runner_labels_valid(text[]) TO runner_provisioning_definer;

CREATE POLICY runner_provisioning_definer_select ON runner_provisioning_tokens FOR SELECT TO runner_provisioning_definer USING (true);
CREATE POLICY runner_provisioning_definer_insert ON runner_provisioning_tokens FOR INSERT TO runner_provisioning_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_provisioning_definer_update ON runner_provisioning_tokens FOR UPDATE TO runner_provisioning_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- The membership trigger runs in the demoted person's context, with no app.account_id: its own narrow policies. It may only stamp revoked_at on an unused,
-- unrevoked token (never set revoked_by), and write the one audit row that says so, attributed to the system.
CREATE POLICY runner_provisioning_definer_member_revoke ON runner_provisioning_tokens FOR UPDATE TO runner_provisioning_definer
  USING (used_at IS NULL AND revoked_at IS NULL) WITH CHECK (used_at IS NULL AND revoked_at IS NOT NULL AND revoked_by IS NULL);
CREATE POLICY runner_provisioning_definer_member_audit ON audit_log FOR INSERT TO runner_provisioning_definer
  WITH CHECK (action = 'runner.provisioning_token.revoked' AND actor = 'system:membership');
CREATE POLICY runner_provisioning_definer_select ON runners FOR SELECT TO runner_provisioning_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_provisioning_definer_insert ON runners FOR INSERT TO runner_provisioning_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_provisioning_definer_insert ON runner_settings FOR INSERT TO runner_provisioning_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- The members of the caller's account, with the three columns above: the redemption needs the minter's row, not the caller's.
CREATE POLICY runner_provisioning_definer_select ON account_members FOR SELECT TO runner_provisioning_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_provisioning_definer_lock ON account_members FOR UPDATE TO runner_provisioning_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (false);
CREATE POLICY runner_provisioning_definer_select ON repos FOR SELECT TO runner_provisioning_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_provisioning_definer_select ON accounts FOR SELECT TO runner_provisioning_definer USING (true);
CREATE POLICY runner_provisioning_definer_audit ON audit_log FOR INSERT TO runner_provisioning_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND action IN ('runner.provisioning_token.minted', 'runner.provisioning_token.revoked', 'runner.registered'));

-- ---- ownership bracket (0783's shape) ---------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_provisioning_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_provisioning_definer; cannot ALTER FUNCTION ... OWNER TO runner_provisioning_definer';
    END IF;
    GRANT runner_provisioning_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    -- platform_ops owns runner_key_thumbprint; granting EXECUTE on it is the owner's to do.
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT EXECUTE ON FUNCTION runner_key_thumbprint(jsonb) TO runner_provisioning_definer;
GRANT CREATE ON SCHEMA public TO runner_provisioning_definer;

-- ---- mint -----------------------------------------------------------------------------------------------------------
CREATE FUNCTION runner_provisioning_token_mint(p_token_sha256 text, p_name text, p_credential_mode text, p_allowed_repo_ids uuid[], p_labels text[], p_ttl_seconds integer)
RETURNS TABLE (token_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr     uuid;
  v_role  text;
  v_repos uuid[];
  v_id    uuid;
  v_exp   timestamptz;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_provisioning_token_mint: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'runner_provisioning_token_mint: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$'
     OR p_credential_mode IS NULL OR p_credential_mode NOT IN ('subscription', 'api_key')
     OR p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 86400
     OR p_allowed_repo_ids IS NULL OR cardinality(p_allowed_repo_ids) > 100 OR array_position(p_allowed_repo_ids, NULL) IS NOT NULL
     OR (p_name IS NOT NULL AND NOT public.runner_name_valid(p_name))
     OR p_labels IS NULL OR NOT public.runner_labels_valid(p_labels) THEN
    RAISE EXCEPTION 'runner_provisioning_token_mint: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x), '{}') INTO v_repos FROM unnest(p_allowed_repo_ids) AS x;
  IF (SELECT count(*) FROM public.repos rp WHERE rp.account_id = acct AND rp.id = ANY (v_repos)) <> cardinality(v_repos) THEN
    RAISE EXCEPTION 'runner_provisioning_token_mint: a repo is not one of the account''s' USING ERRCODE = 'no_data_found';
  END IF;

  -- One mint at a time per account, so the count cannot be raced past the limit. A token counts while it could still be redeemed.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_provisioning_token_mint:' || acct::text, 0));
  IF (SELECT count(*) FROM public.runner_provisioning_tokens t
       WHERE t.account_id = acct AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()
         AND EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = t.created_by AND m.role IN ('owner', 'admin'))) >= 5 THEN
    RAISE EXCEPTION 'runner_provisioning_token_mint: too many outstanding tokens' USING ERRCODE = 'configuration_limit_exceeded';
  END IF;

  INSERT INTO public.runner_provisioning_tokens AS t (account_id, created_by, token_sha256, name, labels, credential_mode, allowed_repo_ids, expires_at)
  VALUES (acct, usr, p_token_sha256, p_name, p_labels, p_credential_mode, v_repos, now() + make_interval(secs => p_ttl_seconds))
  RETURNING t.id, t.expires_at INTO v_id, v_exp;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'runner.provisioning_token.minted', jsonb_build_object(
    'token_id', v_id, 'name', p_name, 'credential_mode', p_credential_mode, 'repo_count', cardinality(v_repos), 'expires_at', v_exp), clock_timestamp());
  RETURN QUERY SELECT v_id, v_exp;
END;
$$;

-- ---- list -----------------------------------------------------------------------------------------------------------
CREATE FUNCTION runner_provisioning_token_list()
RETURNS TABLE (id uuid, created_by uuid, name text, labels text[], credential_mode text, allowed_repo_ids uuid[], created_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_role text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_provisioning_token_list: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.role INTO v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'runner_provisioning_token_list: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT t.id, t.created_by, t.name, t.labels, t.credential_mode, t.allowed_repo_ids, t.created_at, t.expires_at
      FROM public.runner_provisioning_tokens t
     WHERE t.account_id = acct AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()
       AND EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = t.created_by AND m.role IN ('owner', 'admin'))
     ORDER BY t.created_at, t.id;
END;
$$;

-- ---- revoke ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION runner_provisioning_token_revoke(p_token_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  v_role text;
  v_name text;
  v_rows integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_provisioning_token_revoke: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'runner_provisioning_token_revoke: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_id IS NULL THEN
    RAISE EXCEPTION 'runner_provisioning_token_revoke: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Only an unused, unrevoked token of this account. A used one cannot be revoked (the runner is removed instead); an expired one needs no revoking but may be marked.
  UPDATE public.runner_provisioning_tokens t SET revoked_at = now(), revoked_by = usr
   WHERE t.id = p_token_id AND t.account_id = acct AND t.used_at IS NULL AND t.revoked_at IS NULL
  RETURNING t.name INTO v_name;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN false;
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'runner.provisioning_token.revoked', jsonb_build_object('token_id', p_token_id, 'name', v_name), clock_timestamp());
  RETURN true;
END;
$$;

-- ---- account lookup (before any tenant is known) --------------------------------------------------------------------
CREATE FUNCTION runner_provisioning_token_account(p_token_sha256 text)
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
    RAISE EXCEPTION 'runner_provisioning_token_account: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'runner_provisioning_token_account: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT t.account_id INTO v_account FROM public.runner_provisioning_tokens t WHERE t.token_sha256 = p_token_sha256;
  RETURN v_account;
END;
$$;

-- ---- redemption -----------------------------------------------------------------------------------------------------
CREATE FUNCTION runner_provisioning_register(p_token_sha256 text, p_public_key_jwk jsonb, p_isolation text, p_max_runners integer, p_client_ip text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_jkt   text;
  v_tok   public.runner_provisioning_tokens;
  v_ip    inet;
  v_id    uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_provisioning_register: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'runner_provisioning_register: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$'
     OR (p_isolation IS NOT NULL AND p_isolation NOT IN ('microvm', 'vm_container', 'container', 'host_sandbox'))
     OR (p_max_runners IS NOT NULL AND p_max_runners < 0) THEN
    RAISE EXCEPTION 'runner_provisioning_register: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The address is for display only; one that does not parse is recorded as unknown, never a reason to refuse a valid token.
  BEGIN
    v_ip := host(p_client_ip::inet)::inet;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;
  v_jkt := public.runner_key_thumbprint(p_public_key_jwk);

  PERFORM pg_advisory_xact_lock(hashtextextended('runner_register:' || acct::text, 0));

  -- Every way of failing gives the same answer, so a caller learns nothing about which check it was.
  SELECT * INTO v_tok FROM public.runner_provisioning_tokens t
   WHERE t.account_id = acct AND t.token_sha256 = p_token_sha256
   FOR UPDATE;
  IF NOT FOUND OR v_tok.used_at IS NOT NULL OR v_tok.revoked_at IS NOT NULL OR v_tok.expires_at <= now() THEN
    RAISE EXCEPTION 'runner_provisioning_register: the token is not valid' USING ERRCODE = 'no_data_found';
  END IF;

  -- The minter must still be an owner or admin, and stay one until this transaction ends (FOR SHARE: a demotion waits, and its trigger then
  -- revokes the runner this call makes; see 0732).
  PERFORM 1 FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = v_tok.created_by AND m.role IN ('owner', 'admin')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_provisioning_register: the token is not valid' USING ERRCODE = 'no_data_found';
  END IF;

  -- The bound repos must all still be the account's.
  IF (SELECT count(*) FROM public.repos rp WHERE rp.account_id = acct AND rp.id = ANY (v_tok.allowed_repo_ids)) <> cardinality(v_tok.allowed_repo_ids) THEN
    RAISE EXCEPTION 'runner_provisioning_register: the token is not valid' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_max_runners IS NOT NULL
     AND (SELECT count(*) FROM public.runners r WHERE r.account_id = acct AND r.revoked_at IS NULL) >= p_max_runners THEN
    RAISE EXCEPTION 'runner_provisioning_register: runner limit reached' USING ERRCODE = 'configuration_limit_exceeded';
  END IF;

  BEGIN
    INSERT INTO public.runners (account_id, registered_by, public_key_jwk, jkt, credential_mode, isolation, allowed_repo_ids)
    VALUES (acct, v_tok.created_by,
            jsonb_build_object('kty', 'OKP', 'crv', 'Ed25519', 'x', p_public_key_jwk ->> 'x'),
            v_jkt, v_tok.credential_mode, p_isolation, v_tok.allowed_repo_ids)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'runner_provisioning_register: that key is already registered' USING ERRCODE = 'unique_violation';
  END;

  IF v_tok.name IS NOT NULL OR cardinality(v_tok.labels) > 0 THEN
    INSERT INTO public.runner_settings (runner_id, account_id, name, labels, updated_by) VALUES (v_id, acct, v_tok.name, v_tok.labels, v_tok.created_by);
  END IF;

  UPDATE public.runner_provisioning_tokens SET used_at = now(), runner_id = v_id, first_ip = v_ip WHERE id = v_tok.id;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'runner:' || v_id::text, 'runner.registered', jsonb_build_object(
    'runner_id', v_id, 'registered_by', v_tok.created_by, 'credential_mode', v_tok.credential_mode,
    'isolation', p_isolation, 'jkt', v_jkt, 'provisioning_token_id', v_tok.id, 'first_ip', host(v_ip)), clock_timestamp());
  RETURN v_id;
END;
$$;

-- ---- a token dies with its minter's role ------------------------------------------------------------------------------
-- The condition is re-derived from the row: an update that leaves the person an owner or admin changes nothing. Re-promotion never clears revoked_at
-- (the immutability trigger makes it write-once).
CREATE FUNCTION runner_provisioning_token_revoke_for_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role IN ('owner', 'admin') THEN
    RETURN NULL;
  END IF;
  WITH revoked AS (
    UPDATE public.runner_provisioning_tokens t SET revoked_at = now()
     WHERE t.account_id = OLD.account_id AND t.created_by = OLD.user_id AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()
    RETURNING t.id, t.name
  )
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  SELECT OLD.account_id, 'system:membership', 'runner.provisioning_token.revoked',
         jsonb_build_object('token_id', revoked.id, 'name', revoked.name, 'reason', 'minter_demoted'), clock_timestamp()
    FROM revoked;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION runner_provisioning_token_revoke_for_member() FROM PUBLIC;
CREATE TRIGGER runner_provisioning_tokens_minter_demoted
  AFTER UPDATE OF role ON account_members
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION runner_provisioning_token_revoke_for_member();
CREATE TRIGGER runner_provisioning_tokens_minter_removed
  AFTER DELETE ON account_members
  FOR EACH ROW EXECUTE FUNCTION runner_provisioning_token_revoke_for_member();

-- ---- owners, execute grants, and the bracket closed -----------------------------------------------------------------
REVOKE ALL ON FUNCTION runner_provisioning_token_mint(text, text, text, uuid[], text[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_provisioning_token_list() FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_provisioning_token_revoke(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_provisioning_token_account(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_provisioning_register(text, jsonb, text, integer, text) FROM PUBLIC;
ALTER FUNCTION runner_provisioning_token_mint(text, text, text, uuid[], text[], integer) OWNER TO runner_provisioning_definer;
ALTER FUNCTION runner_provisioning_token_list() OWNER TO runner_provisioning_definer;
ALTER FUNCTION runner_provisioning_token_revoke(uuid) OWNER TO runner_provisioning_definer;
ALTER FUNCTION runner_provisioning_token_account(text) OWNER TO runner_provisioning_definer;
ALTER FUNCTION runner_provisioning_register(text, jsonb, text, integer, text) OWNER TO runner_provisioning_definer;
ALTER FUNCTION runner_provisioning_token_revoke_for_member() OWNER TO runner_provisioning_definer;
-- EXECUTE is granted after the transfer, to app_user alone.
GRANT EXECUTE ON FUNCTION runner_provisioning_token_mint(text, text, text, uuid[], text[], integer) TO app_user;
GRANT EXECUTE ON FUNCTION runner_provisioning_token_list() TO app_user;
GRANT EXECUTE ON FUNCTION runner_provisioning_token_revoke(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION runner_provisioning_token_account(text) TO app_user;
GRANT EXECUTE ON FUNCTION runner_provisioning_register(text, jsonb, text, integer, text) TO app_user;
-- A trigger function cannot be called directly; app_user holds EXECUTE only so the role's ACL shape is the same for every function it owns.
GRANT EXECUTE ON FUNCTION runner_provisioning_token_revoke_for_member() TO app_user;
REVOKE CREATE ON SCHEMA public FROM runner_provisioning_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_provisioning_definer FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
