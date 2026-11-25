-- D#845 ON-27a: the private twin of a public repo. repo_twins holds one row per public repo (UNIQUE public_repo_id; private_repo_id is unique among live twins); a removed twin keeps its row and a
-- new one revives it. App users read it under RLS and write nothing: twin_record (the create's callback) and twin_change (pause, resume, remove) are SECURITY DEFINER functions
-- owned by the new NOLOGIN role repo_twins_owner, each for an owner or admin of the session's active account, each writing one audit row of its own (ids and states only).
-- A repo cannot hold a twin and a repo_pairing at once: twin_record refuses with 'pairing_exists', and setRepoPairing refuses a repo of a live twin in the app.
-- The seed, publish and sync anchors and the pull request numbers are written by later rows; here they stay NULL. Numbered 1097 by the Team Lead; never renumbered.

DO $$
DECLARE
  n text := 'repo_twins_owner';
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

CREATE TABLE repo_twins (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  public_repo_id         uuid NOT NULL,
  private_repo_id        uuid,
  private_name           text NOT NULL CONSTRAINT repo_twins_private_name_check CHECK (private_name ~ '^[A-Za-z0-9._-]{1,100}$' AND private_name NOT IN ('.', '..')),
  private_gh_repo_id     bigint CONSTRAINT repo_twins_private_gh_check CHECK (private_gh_repo_id > 0),
  created_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  state                  text NOT NULL CONSTRAINT repo_twins_state_check
    CHECK (state IN ('creating', 'not_connected', 'seeding', 'ready', 'paused', 'conflict', 'refused', 'failed', 'removed')),
  overlay_globs          text[] NOT NULL DEFAULT '{}' CONSTRAINT repo_twins_overlay_check CHECK (cardinality(overlay_globs) <= 100),
  install_paths          text[] NOT NULL DEFAULT '{}' CONSTRAINT repo_twins_install_check CHECK (cardinality(install_paths) <= 5000),
  binary_globs           text[] NOT NULL DEFAULT '{}' CONSTRAINT repo_twins_binary_check CHECK (cardinality(binary_globs) <= 100),
  identifier_rules_path  text CONSTRAINT repo_twins_identifier_rules_check CHECK (identifier_rules_path IS NULL OR (length(identifier_rules_path) <= 200 AND identifier_rules_path !~ '[*?{},]')),
  plan_data_rules_path   text CONSTRAINT repo_twins_plan_data_rules_check CHECK (plan_data_rules_path IS NULL OR (length(plan_data_rules_path) <= 200 AND plan_data_rules_path !~ '[*?{},]')),
  published_private_sha  text CONSTRAINT repo_twins_published_check CHECK (published_private_sha ~ '^[0-9a-f]{40}$'),
  synced_public_sha      text CONSTRAINT repo_twins_synced_check CHECK (synced_public_sha ~ '^[0-9a-f]{40}$'),
  publish_pr             integer CONSTRAINT repo_twins_publish_pr_check CHECK (publish_pr > 0),
  sync_pr                integer CONSTRAINT repo_twins_sync_pr_check CHECK (sync_pr > 0),
  failure_code           text CONSTRAINT repo_twins_failure_code_check CHECK (failure_code ~ '^[a-z0-9_]{1,64}$'),
  failure_reason         text CONSTRAINT repo_twins_failure_reason_check CHECK (length(failure_reason) <= 500),
  failure_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  removed_at             timestamptz,
  UNIQUE (public_repo_id),
  UNIQUE (account_id, id),
  CONSTRAINT repo_twins_distinct_repos CHECK (private_repo_id IS NULL OR private_repo_id <> public_repo_id),
  CONSTRAINT repo_twins_removed_check CHECK ((state = 'removed') = (removed_at IS NOT NULL)),
  FOREIGN KEY (account_id, public_repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, private_repo_id) REFERENCES repos (account_id, id) ON DELETE SET NULL (private_repo_id)
);

-- A removed twin keeps its private repo for the record, so the repo is unique among live twins only.
CREATE UNIQUE INDEX repo_twins_private_live ON repo_twins (private_repo_id) WHERE state <> 'removed';

ALTER TABLE repo_twins ENABLE ROW LEVEL SECURITY;
ALTER TABLE repo_twins FORCE ROW LEVEL SECURITY;
REVOKE ALL ON repo_twins FROM PUBLIC;
GRANT SELECT ON repo_twins TO app_user;
CREATE POLICY tenant_isolation_select ON repo_twins FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

-- What repo_twins_owner reads and writes, by column, in the session's account only.
GRANT USAGE ON SCHEMA public TO repo_twins_owner;
GRANT SELECT ON repo_twins TO repo_twins_owner;
GRANT INSERT (account_id, public_repo_id, private_repo_id, private_name, private_gh_repo_id, created_by, state) ON repo_twins TO repo_twins_owner;
GRANT UPDATE (private_repo_id, private_name, private_gh_repo_id, created_by, state, overlay_globs, install_paths, binary_globs, identifier_rules_path, plan_data_rules_path,
              published_private_sha, synced_public_sha, publish_pr, sync_pr, failure_code, failure_reason, failure_at, updated_at, removed_at) ON repo_twins TO repo_twins_owner;
CREATE POLICY repo_twins_owner_use ON repo_twins FOR ALL TO repo_twins_owner
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT (id, account_id) ON repos TO repo_twins_owner;
CREATE POLICY repo_twins_owner_use ON repos FOR SELECT TO repo_twins_owner USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT (repo_id, account_id) ON repo_pairing TO repo_twins_owner;
CREATE POLICY repo_twins_owner_use ON repo_pairing FOR SELECT TO repo_twins_owner USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT (id, deleted_at) ON accounts TO repo_twins_owner;
CREATE POLICY repo_twins_owner_use ON accounts FOR SELECT TO repo_twins_owner USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT (account_id, user_id, role) ON account_members TO repo_twins_owner;
CREATE POLICY repo_twins_owner_use ON account_members FOR SELECT TO repo_twins_owner
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO repo_twins_owner;
CREATE POLICY repo_twins_owner_audit ON audit_log FOR INSERT TO repo_twins_owner
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action IN ('twin.created', 'twin.paused', 'twin.resumed', 'twin.removed'));

-- ---- ownership: the migration role holds repo_twins_owner only to hand the functions over (1059's shape) ----------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'repo_twins_owner'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on repo_twins_owner; cannot ALTER FUNCTION ... OWNER TO repo_twins_owner';
    END IF;
    GRANT repo_twins_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO repo_twins_owner;

-- The create's callback: records the twin of one public repo, with its private repo once the App can see it. An owner or admin of the session's active account.
-- o_result: ok | not_found (a repo that is not the account's) | pairing_exists (either repo has a pairing) | twin_exists (a live twin holds either repo).
CREATE FUNCTION twin_record(p_public uuid, p_private uuid, p_gh_repo_id bigint, p_name text) RETURNS TABLE (o_result text, o_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v    public.repo_twins%ROWTYPE;
  v_state text := CASE WHEN p_private IS NULL THEN 'not_connected' ELSE 'seeding' END;
BEGIN
  IF acct IS NULL OR usr IS NULL OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = acct AND a.deleted_at IS NULL) OR NOT public.account_is_active(acct)
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'twin_record: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_public IS NULL OR p_name IS NULL OR p_private IS NOT DISTINCT FROM p_public THEN
    RAISE EXCEPTION 'twin_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = acct AND r.id = p_public)
     OR (p_private IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = acct AND r.id = p_private)) THEN
    RETURN QUERY SELECT 'not_found', NULL::uuid; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.repo_pairing p WHERE p.account_id = acct AND p.repo_id IN (p_public, p_private)) THEN
    RETURN QUERY SELECT 'pairing_exists', NULL::uuid; RETURN;
  END IF;
  SELECT * INTO v FROM public.repo_twins t WHERE t.account_id = acct AND t.public_repo_id = p_public FOR UPDATE;
  IF FOUND AND v.state <> 'removed' THEN
    RETURN QUERY SELECT 'twin_exists', NULL::uuid; RETURN;
  END IF;
  IF FOUND THEN
    UPDATE public.repo_twins SET private_repo_id = p_private, private_name = p_name, private_gh_repo_id = p_gh_repo_id, created_by = usr, state = v_state,
           overlay_globs = '{}', install_paths = '{}', binary_globs = '{}', identifier_rules_path = NULL, plan_data_rules_path = NULL, published_private_sha = NULL,
           synced_public_sha = NULL, publish_pr = NULL, sync_pr = NULL, failure_code = NULL, failure_reason = NULL, failure_at = NULL, removed_at = NULL, updated_at = now()
     WHERE id = v.id AND account_id = acct;
  ELSE
    INSERT INTO public.repo_twins (account_id, public_repo_id, private_repo_id, private_name, private_gh_repo_id, created_by, state)
    VALUES (acct, p_public, p_private, p_name, p_gh_repo_id, usr, v_state) RETURNING * INTO v;
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'twin.created', jsonb_build_object('twin_id', v.id, 'public_repo_id', p_public, 'private_repo_id', p_private, 'state', v_state), clock_timestamp());
  RETURN QUERY SELECT 'ok', v.id;
EXCEPTION WHEN unique_violation THEN
  -- The private repo already belongs to another twin.
  RETURN QUERY SELECT 'twin_exists', NULL::uuid;
END;
$$;

-- Pause, resume or remove one twin. An owner or admin of the session's active account. o_result: ok | not_found | bad_state (the twin's state does not allow it).
-- Resume goes back to the state the twin's own columns say: not_connected without a private repo, seeding before the seed, ready after it. Remove is final for the row
-- (a new create revives it); the private repo on GitHub is never touched.
CREATE FUNCTION twin_change(p_id uuid, p_action text) RETURNS TABLE (o_result text, o_state text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v    public.repo_twins%ROWTYPE;
  v_new text;
BEGIN
  IF acct IS NULL OR usr IS NULL OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = acct AND a.deleted_at IS NULL) OR NOT public.account_is_active(acct)
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'twin_change: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL OR p_action IS NULL OR p_action NOT IN ('pause', 'resume', 'remove') THEN
    RAISE EXCEPTION 'twin_change: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v FROM public.repo_twins t WHERE t.id = p_id AND t.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found', NULL::text; RETURN;
  END IF;
  IF v.state = 'removed' OR (p_action = 'pause' AND v.state = 'paused') OR (p_action = 'resume' AND v.state <> 'paused') THEN
    RETURN QUERY SELECT 'bad_state', v.state; RETURN;
  END IF;
  v_new := CASE p_action WHEN 'pause' THEN 'paused' WHEN 'remove' THEN 'removed'
             ELSE CASE WHEN v.private_repo_id IS NULL THEN 'not_connected' WHEN v.published_private_sha IS NULL THEN 'seeding' ELSE 'ready' END END;
  UPDATE public.repo_twins SET state = v_new, updated_at = now(), removed_at = CASE WHEN v_new = 'removed' THEN now() END WHERE id = v.id AND account_id = acct;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, CASE p_action WHEN 'pause' THEN 'twin.paused' WHEN 'resume' THEN 'twin.resumed' ELSE 'twin.removed' END,
          jsonb_build_object('twin_id', v.id, 'public_repo_id', v.public_repo_id, 'private_repo_id', v.private_repo_id, 'from', v.state, 'to', v_new), clock_timestamp());
  RETURN QUERY SELECT 'ok', v_new;
END;
$$;

REVOKE ALL ON FUNCTION twin_record(uuid, uuid, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION twin_change(uuid, text) FROM PUBLIC;
ALTER FUNCTION twin_record(uuid, uuid, bigint, text) OWNER TO repo_twins_owner;
ALTER FUNCTION twin_change(uuid, text) OWNER TO repo_twins_owner;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION twin_record(uuid, uuid, bigint, text) TO app_user;
GRANT EXECUTE ON FUNCTION twin_change(uuid, text) TO app_user;

REVOKE CREATE ON SCHEMA public FROM repo_twins_owner;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE repo_twins_owner FROM CURRENT_USER;
  END IF;
END
$$;
