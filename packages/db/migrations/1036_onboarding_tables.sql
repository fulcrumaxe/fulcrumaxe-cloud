-- MC-1b: the onboarding and runner tables.
--
-- Five tables:
--   onboarding_tracks   which track (engine or pipeline) an account chose. Primary key (account_id, track)
--   project_setups      one repo's setup, step by step. A partial unique index allows one live setup per repo
--   runner_device_codes a machine's pending device-flow code. Rows have no account until a person approves them, and until then only a definer can reach them
--   project_drafts      the PRD and roadmap a person reviews before the engine is installed, kept 30 days after it is final
--   engine_releases     the published engine versions. A platform table: every account reads it, only platform_ops writes it
--
-- Row security is enabled and forced on all five. The four account tables carry the same tenant policy as the machine tables (1035).
--
-- runner_device_codes. The code a person types (user_code) and the code the machine polls with (device_code) are never stored: only their sha256 is,
-- and a CHECK refuses anything that is not 64 lowercase hex characters, so a plaintext code cannot be written by mistake. The rest is shaped to
-- keep the table small to attack:
--   * expires_at is at most 10 minutes after created_at (a CHECK). A longer life cannot be stored;
--   * a pending row has no account, no approver and no approval time, and an approved or consumed one has all three (CHECKs);
--   * both hashes are unique, so a lookup by user code can only ever find one row, and a collision is a retry in the definer, not an ambiguity;
--   * facts is closed (hostname, os, arch, kvm, ip_country), each value a short plain string or boolean, because the approval page shows it to the person;
--   * app_user may read the non-secret columns of a row that belongs to its own account and nothing else. It has no INSERT, UPDATE or DELETE, and the policy
--     excludes a row with no account even if a later migration grants more. The hashes, the key and the thumbprint are not readable by it at all.
-- The writers are definers owned by onboarding_ops (a later row creates them). This migration gives that role only the prune below.
--
-- Retention. Two prune functions called by the reconciler's onboarding_prune job (platform_ops login, no tenant set):
--   runner_device_codes_prune(n)  deletes a device code 24 hours after it expired
--   project_drafts_prune(n)       deletes a draft 30 days after it became final (approved or discarded)
--
-- project_drafts. roadmap is a closed shape (rows with a key, title, summary, size, dependencies and a keep flag, at most 200 of them, keys unique) checked by
-- project_roadmap_valid(jsonb), and prd_md is at most 200,000 characters. Both are CHECKs, so no write path can skip them.
--
-- audit_write is not touched here: 1035 carries the whole allowlist for these features.
--
-- Numbered 1036 by the Team Lead; it merges after 1035, in number order. Re-check against main's highest right before merging.

DO $$
DECLARE
  n text := 'onboarding_ops';
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

-- ---- shape checks (pure functions: they read no table) ---------------------------------------------------------------------------------------------

CREATE FUNCTION project_roadmap_valid(j jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  e    jsonb;
  d    jsonb;
  k    text;
  seen text[] := '{}';
BEGIN
  IF j IS NULL OR jsonb_typeof(j) <> 'array' OR jsonb_array_length(j) > 200 THEN
    RETURN false;
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(j) LOOP
    IF jsonb_typeof(e) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 6
       OR NOT (e ?& ARRAY['row_key', 'title', 'summary', 'size', 'depends_on', 'keep']) THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(e -> 'row_key') <> 'string' OR jsonb_typeof(e -> 'title') <> 'string' OR jsonb_typeof(e -> 'summary') <> 'string'
       OR jsonb_typeof(e -> 'size') <> 'string' OR jsonb_typeof(e -> 'depends_on') <> 'array' OR jsonb_typeof(e -> 'keep') <> 'boolean' THEN
      RETURN false;
    END IF;
    k := e ->> 'row_key';
    IF k !~ '^[A-Z][A-Z0-9-]{0,15}$' OR k = ANY (seen)
       OR char_length(e ->> 'title') NOT BETWEEN 1 AND 120 OR char_length(e ->> 'summary') > 500
       OR (e ->> 'size') NOT IN ('S', 'M', 'L')
       OR jsonb_array_length(e -> 'depends_on') > 10 THEN
      RETURN false;
    END IF;
    seen := seen || k;
    FOR d IN SELECT value FROM jsonb_array_elements(e -> 'depends_on') LOOP
      IF jsonb_typeof(d) <> 'string' OR (d #>> '{}') !~ '^[A-Z][A-Z0-9-]{0,15}$' THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END;
$$;

-- What a machine says about itself when it asks for a code. The approval page shows these values to a person, so each is a short plain value.
CREATE FUNCTION runner_device_facts_valid(j jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF j IS NULL OR jsonb_typeof(j) <> 'object' THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(j) AS k WHERE k <> ALL (ARRAY['hostname', 'os', 'arch', 'kvm', 'ip_country'])) THEN
    RETURN false;
  END IF;
  IF NOT (j ?& ARRAY['os', 'arch', 'kvm']) OR jsonb_typeof(j -> 'kvm') <> 'boolean' THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(j -> 'os') <> 'string' OR (j ->> 'os') !~ '^[a-z0-9._-]{1,32}$'
     OR jsonb_typeof(j -> 'arch') <> 'string' OR (j ->> 'arch') !~ '^[a-z0-9._-]{1,32}$' THEN
    RETURN false;
  END IF;
  IF j ? 'hostname' AND (jsonb_typeof(j -> 'hostname') <> 'string' OR (j ->> 'hostname') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$') THEN
    RETURN false;
  END IF;
  IF j ? 'ip_country' AND (jsonb_typeof(j -> 'ip_country') <> 'string' OR (j ->> 'ip_country') !~ '^[A-Z]{2}$') THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- ---- tables ----------------------------------------------------------------------------------------------------------------------------------------

CREATE TABLE onboarding_tracks (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  track       text NOT NULL CHECK (track IN ('engine', 'pipeline')),
  chosen_by   uuid NOT NULL REFERENCES users (id),
  chosen_at   timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, track)
);

CREATE TABLE project_setups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id         uuid NOT NULL,
  runner_id       uuid,
  kind            text NOT NULL CHECK (kind IN ('existing', 'new')),
  phase           text NOT NULL DEFAULT 'survey' CHECK (phase IN ('survey', 'plan', 'install', 'await_merge', 'finish', 'done', 'removed')),
  sub_step        text CHECK (sub_step ~ '^[a-z][a-z0-9_]{0,63}$'),
  state           text NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'ok', 'failed')),
  failure_code    text CHECK (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  failure_at      timestamptz,
  engine_version  text CHECK (engine_version ~ '^[0-9][0-9.]{4,19}$'),
  install_pr      integer CHECK (install_pr > 0),
  attempt         integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  -- Lets a draft name a setup of its own repo only (the draft's foreign key spans the repo too).
  UNIQUE (account_id, repo_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE SET NULL (runner_id),
  -- A failure is a code and the time it happened, together; both clear on the next success.
  CONSTRAINT project_setups_failure_pair CHECK ((failure_code IS NULL) = (failure_at IS NULL))
);
-- One live setup per repo: a setup is live until it is done or removed. The account is in the key so that a session naming another account's repo
-- reaches the foreign key (23503) and not this index (23505), which would say whether that repo has a live setup. A repo has one account, so the key means the same.
CREATE UNIQUE INDEX project_setups_one_live ON project_setups (account_id, repo_id) WHERE phase NOT IN ('done', 'removed');
CREATE INDEX project_setups_account ON project_setups (account_id, created_at DESC);

CREATE TABLE runner_device_codes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL until a person approves the code. While it is NULL the row is reachable only by a definer.
  account_id        uuid REFERENCES accounts (id) ON DELETE CASCADE,
  device_code_hash  text NOT NULL UNIQUE CHECK (device_code_hash ~ '^[0-9a-f]{64}$'),
  user_code_hash    text NOT NULL UNIQUE CHECK (user_code_hash ~ '^[0-9a-f]{64}$'),
  jkt               text NOT NULL CHECK (jkt ~ '^[A-Za-z0-9_-]{43}$'),
  public_key_jwk    jsonb NOT NULL CHECK (jsonb_typeof(public_key_jwk) = 'object' AND octet_length(public_key_jwk::text) <= 1024),
  facts             jsonb NOT NULL CHECK (runner_device_facts_valid(facts)),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
  approved_by       uuid REFERENCES users (id),
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  -- Wrong or too-fast attempts counted against this code by the definers.
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  CONSTRAINT runner_device_codes_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CONSTRAINT runner_device_codes_pending_unowned CHECK (status <> 'pending' OR (account_id IS NULL AND approved_by IS NULL AND approved_at IS NULL)),
  CONSTRAINT runner_device_codes_approved_owned CHECK (status NOT IN ('approved', 'consumed') OR (account_id IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT runner_device_codes_approver_pair CHECK ((approved_by IS NULL) = (approved_at IS NULL) AND (approved_by IS NULL OR account_id IS NOT NULL))
);
CREATE INDEX runner_device_codes_expiry ON runner_device_codes (expires_at);
CREATE INDEX runner_device_codes_jkt ON runner_device_codes (jkt);
CREATE INDEX runner_device_codes_account ON runner_device_codes (account_id) WHERE account_id IS NOT NULL;

CREATE TABLE project_drafts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id      uuid NOT NULL,
  setup_id     uuid,
  source       text NOT NULL CHECK (source IN ('survey', 'interview', 'blank')),
  prd_md       text NOT NULL DEFAULT '' CHECK (char_length(prd_md) <= 200000),
  roadmap      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (project_roadmap_valid(roadmap)),
  version      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'discarded')),
  approved_by  uuid REFERENCES users (id),
  approved_at  timestamptz,
  -- When the draft stopped being editable (approved or discarded). The 30-day retention counts from here.
  final_at     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, repo_id, version),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id, setup_id) REFERENCES project_setups (account_id, repo_id, id) ON DELETE SET NULL (setup_id),
  CONSTRAINT project_drafts_approval CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL) AND (approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT project_drafts_final CHECK ((status IN ('approved', 'discarded')) = (final_at IS NOT NULL)),
  -- A draft cannot be made final before it was created. This bounds the retention clock from below; the app role can still set a later time.
  CONSTRAINT project_drafts_final_order CHECK (final_at IS NULL OR final_at >= created_at)
);
CREATE INDEX project_drafts_repo ON project_drafts (account_id, repo_id, version DESC);
CREATE INDEX project_drafts_final ON project_drafts (final_at) WHERE final_at IS NOT NULL;

CREATE TABLE engine_releases (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version              text NOT NULL UNIQUE CHECK (version ~ '^[0-9][0-9.]{4,19}$'),
  commit_sha           text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  tarball_sha256       text NOT NULL CHECK (tarball_sha256 ~ '^[0-9a-f]{64}$'),
  min_runner_protocol  integer NOT NULL CHECK (min_runner_protocol >= 1),
  published_by         text NOT NULL CHECK (char_length(published_by) BETWEEN 1 AND 80),
  published_at         timestamptz NOT NULL DEFAULT now(),
  withdrawn_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engine_releases_withdrawn_after CHECK (withdrawn_at IS NULL OR withdrawn_at >= published_at)
);

-- ---- row security and grants -------------------------------------------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  acct text := 'account_id = NULLIF(current_setting(''app.account_id'', true), '''')::uuid AND (SELECT account_is_active(NULLIF(current_setting(''app.account_id'', true), '''')::uuid))';
BEGIN
  FOREACH t IN ARRAY ARRAY['onboarding_tracks', 'project_setups', 'project_drafts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO app_user USING (%s) WITH CHECK (%s)', t, acct, acct);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON onboarding_tracks TO app_user;
GRANT SELECT, INSERT, UPDATE ON project_setups TO app_user;
GRANT SELECT, INSERT, UPDATE ON project_drafts TO app_user;

-- A device code has no account until it is approved, and a row with none is never visible to app_user. The policy says so itself (it does not lean on
-- NULL never equalling an account), and it holds even if a later migration grants more than SELECT.
ALTER TABLE runner_device_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_device_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON runner_device_codes TO app_user
  USING (account_id IS NOT NULL AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))
  WITH CHECK (account_id IS NOT NULL AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
-- Read only, and not the hashes, the key or its thumbprint.
GRANT SELECT (id, account_id, facts, status, approved_by, approved_at, created_at, expires_at) ON runner_device_codes TO app_user;

-- engine_releases is a platform table: every account's session reads the same rows, and only platform_ops (the publish script's login) writes them.
ALTER TABLE engine_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_read ON engine_releases FOR SELECT TO app_user USING (true);
CREATE POLICY platform_write ON engine_releases FOR ALL TO platform_ops USING (true) WITH CHECK (true);
GRANT SELECT ON engine_releases TO app_user;
GRANT SELECT, INSERT ON engine_releases TO platform_ops;
GRANT UPDATE (withdrawn_at) ON engine_releases TO platform_ops;

REVOKE ALL ON FUNCTION project_roadmap_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_device_facts_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION project_roadmap_valid(jsonb) TO app_user;
-- The device-code writers are definers owned by onboarding_ops, and the CHECK runs as the writer.
GRANT EXECUTE ON FUNCTION runner_device_facts_valid(jsonb) TO onboarding_ops;

-- onboarding_ops: the two prunes (no tenant set, old rows only).
GRANT USAGE ON SCHEMA public TO onboarding_ops;
GRANT SELECT, DELETE ON runner_device_codes TO onboarding_ops;
CREATE POLICY onboarding_ops_prune ON runner_device_codes FOR ALL TO onboarding_ops
  USING (expires_at < now() - interval '24 hours' AND NULLIF(current_setting('app.account_id', true), '') IS NULL);
GRANT SELECT, DELETE ON project_drafts TO onboarding_ops;
CREATE POLICY onboarding_ops_prune ON project_drafts FOR ALL TO onboarding_ops
  USING (final_at < now() - interval '30 days' AND NULLIF(current_setting('app.account_id', true), '') IS NULL);

-- ---- retention -----------------------------------------------------------------------------------------------------------------------------------

CREATE FUNCTION runner_device_codes_prune(p_limit integer) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'runner_device_codes_prune: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.runner_device_codes c
   WHERE c.id IN (SELECT o.id FROM public.runner_device_codes o WHERE o.expires_at < now() - interval '24 hours' LIMIT p_limit);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE FUNCTION project_drafts_prune(p_limit integer) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'project_drafts_prune: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.project_drafts d
   WHERE d.id IN (SELECT o.id FROM public.project_drafts o WHERE o.final_at < now() - interval '30 days' LIMIT p_limit);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ---- ownership: the migration role holds the definer only to hand the functions over -------------------------------------------------------------
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

REVOKE ALL ON FUNCTION runner_device_codes_prune(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION project_drafts_prune(integer) FROM PUBLIC;
ALTER FUNCTION runner_device_codes_prune(integer) OWNER TO onboarding_ops;
ALTER FUNCTION project_drafts_prune(integer) OWNER TO onboarding_ops;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION runner_device_codes_prune(integer) TO platform_ops;
GRANT EXECUTE ON FUNCTION project_drafts_prune(integer) TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM onboarding_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE onboarding_ops FROM CURRENT_USER;
  END IF;
END
$$;

-- The reconcile job that calls the two prunes, every 15 minutes (a job with no row is never due). Safe to re-run.
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('onboarding_prune', 900) ON CONFLICT (name) DO NOTHING;
