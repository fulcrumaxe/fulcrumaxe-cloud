-- Repo pairing: a repository may declare a paired public code repo and the overlay paths that stay private. This is the data model
-- and its audit path only. Nothing reads the table to route a push yet (the scan module and the executor push routing come in
-- later changes), so a repository with no row behaves exactly as it does today.
--
--   repo_pairing              at most one row per repository. NO ROW MEANS OFF: the pairing is derived from the current row, never
--                             stamped on items, and removing the row returns the repository to the single-repo path.
--                               code_repo              owner/name of the paired public repo
--                               overlay_globs          the paths that stay private (required, 1 to 100 distinct patterns)
--                               identifier_rules_path  optional: a rule file committed in the PRIVATE repo
--                               plan_data_rules_path   optional: a rule file committed in the PRIVATE repo
--   audit_write_repo_pairing  the audit path for the two writes (set, cleared), so the change and its audit row commit in one
--                             withTenant transaction (app_user has no INSERT on audit_log). A SECURITY DEFINER owned by the
--                             dedicated NOLOGIN role repo_pairing_audit_definer, in the shape of 0781: column INSERT on audit_log
--                             only, one policy admitting the two action names for the caller's own account, the caller's own
--                             membership row, a pinned search_path, EXECUTE for app_user alone. platform_ops gains NOTHING.
--
-- Path rules (repo_pairing_path_valid): relative, at most 200 characters, only letters, digits and . _ / - @ + = ~ plus the glob
-- characters * ? { } ,  -- no leading slash, no empty segment, no segment that is dot-dot, no backslash, quote, space or control
-- character. Text that breaks a rule is refused, never repaired. A rule-file path may not contain a glob character.
--
-- Numbered above the highest migration queued at the time of writing. Re-check against main right before merging.

CREATE FUNCTION repo_pairing_path_valid(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p IS NOT NULL
     AND p ~ '^[A-Za-z0-9._/*?{},@+=~-]{1,200}$'
     AND p !~ '^/'
     AND p !~ '//'
     AND p !~ '(^|/)\.\.(/|$)'
$$;

CREATE FUNCTION repo_pairing_globs_valid(p text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p IS NOT NULL AND array_ndims(p) = 1 AND cardinality(p) BETWEEN 1 AND 100
     AND coalesce((SELECT bool_and(coalesce(public.repo_pairing_path_valid(g), false)) AND count(*) = count(DISTINCT g) FROM unnest(p) AS g), false)
$$;

-- The CHECK constraints below run as the writing role (app_user), so it needs EXECUTE; PUBLIC does not (platform_ops would inherit it).
REVOKE ALL ON FUNCTION repo_pairing_path_valid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION repo_pairing_globs_valid(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION repo_pairing_path_valid(text) TO app_user;
GRANT EXECUTE ON FUNCTION repo_pairing_globs_valid(text[]) TO app_user;

CREATE TABLE repo_pairing (
  repo_id                uuid PRIMARY KEY,
  account_id             uuid NOT NULL,
  code_repo              text NOT NULL
    CONSTRAINT repo_pairing_code_repo_check CHECK (
      code_repo ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9._-]{1,100}$'
      AND split_part(code_repo, '/', 2) NOT IN ('.', '..')),
  overlay_globs          text[] NOT NULL
    CONSTRAINT repo_pairing_overlay_globs_check CHECK (repo_pairing_globs_valid(overlay_globs)),
  identifier_rules_path  text
    CONSTRAINT repo_pairing_identifier_rules_check CHECK (
      identifier_rules_path IS NULL OR (repo_pairing_path_valid(identifier_rules_path) AND identifier_rules_path !~ '[*?{},]')),
  plan_data_rules_path   text
    CONSTRAINT repo_pairing_plan_data_rules_check CHECK (
      plan_data_rules_path IS NULL OR (repo_pairing_path_valid(plan_data_rules_path) AND plan_data_rules_path !~ '[*?{},]')),
  updated_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);

ALTER TABLE repo_pairing ENABLE ROW LEVEL SECURITY;
ALTER TABLE repo_pairing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON repo_pairing TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON repo_pairing TO app_user;

-- ---- the audit path (0781's shape) ------------------------------------------------------------------------------------
DO $$
DECLARE
  n text := 'repo_pairing_audit_definer';
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

GRANT USAGE ON SCHEMA public TO repo_pairing_audit_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO repo_pairing_audit_definer;
GRANT SELECT (id, deleted_at) ON accounts TO repo_pairing_audit_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO repo_pairing_audit_definer;

-- Shows this role only the caller's own membership row.
CREATE POLICY repo_pairing_audit_definer_select ON account_members FOR SELECT TO repo_pairing_audit_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY repo_pairing_audit_definer_select ON accounts FOR SELECT TO repo_pairing_audit_definer USING (true);
CREATE POLICY repo_pairing_audit_definer_audit ON audit_log FOR INSERT TO repo_pairing_audit_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action IN ('repo_pairing.set', 'repo_pairing.cleared'));

-- ---- ownership bracket (as 0781) ---------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'repo_pairing_audit_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on repo_pairing_audit_definer; cannot ALTER FUNCTION ... OWNER TO repo_pairing_audit_definer';
    END IF;
    GRANT repo_pairing_audit_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO repo_pairing_audit_definer;

CREATE FUNCTION audit_write_repo_pairing(p_action text, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct            uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr             uuid;
  v_role          text;
  ts              timestamptz := clock_timestamp();
  stamped_payload jsonb := p_payload;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'audit_write_repo_pairing: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The caller's own membership row (the policy shows this role no other); the role is re-derived on every call.
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'audit_write_repo_pairing: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('repo_pairing.set', 'repo_pairing.cleared') THEN
    RAISE EXCEPTION 'audit_write_repo_pairing: action is not allowed' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write_repo_pairing: payload must be a JSON object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_payload IS NOT NULL AND (pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536) THEN
    RAISE EXCEPTION 'audit_write_repo_pairing: payload exceeds 65536 bytes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- A caller-supplied actor, account or time inside the payload is overwritten with the session's own.
  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(usr::text));
  END IF;
  IF stamped_payload ? 'account_id' THEN
    stamped_payload := stamped_payload || jsonb_build_object('account_id', to_jsonb(acct::text));
  END IF;
  IF stamped_payload ? 'created_at' THEN
    stamped_payload := stamped_payload || jsonb_build_object('created_at', to_jsonb(ts));
  END IF;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, p_action, stamped_payload, ts);
END;
$$;

REVOKE ALL ON FUNCTION audit_write_repo_pairing(text, jsonb) FROM PUBLIC;
ALTER FUNCTION audit_write_repo_pairing(text, jsonb) OWNER TO repo_pairing_audit_definer;
GRANT EXECUTE ON FUNCTION audit_write_repo_pairing(text, jsonb) TO app_user;

REVOKE CREATE ON SCHEMA public FROM repo_pairing_audit_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE repo_pairing_audit_definer FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
