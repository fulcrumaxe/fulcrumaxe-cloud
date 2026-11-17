-- MC-1a: the machine tables and the audit actions of the machines and onboarding work.
--
-- Five tables, each with account_id and row security forced:
--   machine_provider_credentials  a person's Hetzner Cloud token, sealed. One active row per account and provider; removing it sets the sealed columns to NULL
--   managed_servers               a Hetzner Cloud server we created with that token, its status, and the price stamped when it was created
--   project_placements            which machine runs a repo's engine. One engine per machine: (account_id, runner_id) is unique
--   machine_login_requests        a Claude sign-in link and its one-time code, sealed, short-lived
--   machine_usage_daily           raw token counts per machine, repo, day and model tier (the cloud's spend code prices them; nothing here is a dollar figure)
--
-- Sealed columns. ciphertext, nonce and wrapped_dek of a credential, and auth_url_ct and code_ct of a login request, cannot be read by app_user: its SELECT
-- grant on those two tables names the other columns. It can write them (the seal is made in the app, with the machine KEK). The one reader is
-- machine_credential_use(credential id), which belongs to machine_ops (NOLOGIN, a member of nothing), reads the session's own account only and returns
-- nothing for a removed credential or a deleted account. The caller unseals in memory for one call.
--
-- Retention. Three prune functions, called by the reconciler's machine_prune job (every 5 minutes, so a login code is cleared soon after it expires):
--   machine_login_requests_prune(n)  sets a login request's sealed columns to NULL once it has expired and deletes it 7 days after
--   machine_usage_prune(n)           deletes usage rows older than 400 days
--   machine_servers_prune(n)         deletes servers deleted more than 400 days ago
-- Each takes a batch size and nothing else. Their policies for machine_ops apply only in a session with no tenant set (the reconciler's platform_ops login).
--
-- audit_write is replaced whole from 1026 (the newest definition on main; CREATE OR REPLACE keeps the owner and the grants), adding eighteen actions: the whole
-- list of the machines and onboarding work, with server.unsealed and machine.linked_notified, except server.bootstrap_issued (withdrawn) and project.github_identity_changed (a later migration adds it). Another open migration that also
-- replaces audit_write would drop these entries (last file wins): whoever merges second re-carries the list. Payloads of these actions are ids and enums only.
--
-- Numbered 1035 by the Team Lead; it merges after 1032, 1033 and 1034, in number order. Re-check against main's highest right before merging.

DO $$
DECLARE
  n text := 'machine_ops';
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

CREATE TABLE machine_provider_credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider = 'hetzner_cloud'),
  ciphertext       bytea CHECK (octet_length(ciphertext) BETWEEN 1 AND 4096),
  nonce            bytea CHECK (octet_length(nonce) = 12),
  wrapped_dek      bytea CHECK (octet_length(wrapped_dek) BETWEEN 1 AND 1024),
  kek_version      integer NOT NULL CHECK (kek_version >= 1),
  token_hint       text NOT NULL CHECK (char_length(token_hint) = 4),
  status           text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'invalid')),
  last_checked_at  timestamptz,
  created_by       uuid NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  removed_at       timestamptz,
  removed_by       uuid REFERENCES users (id),
  UNIQUE (account_id, id),
  -- Removal clears all three sealed columns; a live row has all three.
  CONSTRAINT machine_credentials_sealed_iff_live CHECK ((removed_at IS NULL) = (ciphertext IS NOT NULL AND nonce IS NOT NULL AND wrapped_dek IS NOT NULL)),
  CONSTRAINT machine_credentials_removed_by CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX machine_credentials_one_active ON machine_provider_credentials (account_id, provider) WHERE removed_at IS NULL;

CREATE TABLE managed_servers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind = 'hetzner_cloud'),
  credential_id          uuid NOT NULL,
  provider_server_id     text CHECK (provider_server_id ~ '^[0-9]{1,20}$'),
  provider_firewall_id   text CHECK (provider_firewall_id ~ '^[0-9]{1,20}$'),
  name                   text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  server_type            text CHECK (server_type ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  location               text CHECK (location ~ '^[a-z0-9][a-z0-9._-]{0,15}$'),
  public_ipv4            inet CHECK (family(public_ipv4) = 4),
  status                 text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'booting', 'installing', 'registering', 'needs_claude_login', 'ready', 'deleting', 'deleted', 'failed', 'orphaned')),
  status_at              timestamptz NOT NULL DEFAULT now(),
  failure_code           text CHECK (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Stamped when the server is created, never recomputed.
  price_hourly_gross     numeric(12, 6) CHECK (price_hourly_gross >= 0),
  price_monthly_gross    numeric(12, 4) CHECK (price_monthly_gross >= 0),
  ipv4_monthly_gross     numeric(12, 4) CHECK (ipv4_monthly_gross >= 0),
  currency               text NOT NULL DEFAULT 'EUR' CHECK (currency ~ '^[A-Z]{3}$'),
  runner_id              uuid,
  provisioning_token_id  uuid NOT NULL REFERENCES runner_provisioning_tokens (id),
  created_by             uuid NOT NULL REFERENCES users (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  deleted_by             uuid REFERENCES users (id),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, credential_id) REFERENCES machine_provider_credentials (account_id, id),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE SET NULL (runner_id),
  CONSTRAINT managed_servers_deleted_iff CHECK ((status = 'deleted') = (deleted_at IS NOT NULL) AND (deleted_by IS NULL OR deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX managed_servers_provider_server ON managed_servers (credential_id, provider_server_id) WHERE provider_server_id IS NOT NULL;
CREATE INDEX managed_servers_account ON managed_servers (account_id, created_at DESC);
CREATE INDEX managed_servers_deleted ON managed_servers (deleted_at) WHERE deleted_at IS NOT NULL;

-- Both keys lead with account_id. A key on repo_id or runner_id alone would let a session that names another account's repo or runner tell,
-- by 23505 against 23503, whether that repo or runner has a placement. The repo and the runner are each bound to one account by the composite
-- foreign keys below, so a foreign id now reaches a foreign key failure first, and one engine per machine and one placement per repo still hold.
CREATE TABLE project_placements (
  repo_id     uuid NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  runner_id   uuid NOT NULL,
  placed_by   text NOT NULL CHECK (placed_by IN ('auto', 'person')),
  placed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, repo_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE
);
-- One engine per machine: a runner holds at most one placement, on every tier.
CREATE UNIQUE INDEX project_placements_one_per_runner ON project_placements (account_id, runner_id);

CREATE TABLE machine_login_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  runner_id    uuid NOT NULL,
  kind         text NOT NULL DEFAULT 'claude' CHECK (kind = 'claude'),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'awaiting_code', 'code_ready', 'done', 'failed', 'expired')),
  -- Each is one sealed blob (nonce and tag included), sealed with the machine KEK.
  auth_url_ct  bytea CHECK (octet_length(auth_url_ct) BETWEEN 1 AND 4096),
  code_ct      bytea CHECK (octet_length(code_ct) BETWEEN 1 AND 4096),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  created_by   uuid NOT NULL REFERENCES users (id),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  CONSTRAINT machine_login_requests_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  -- A finished request holds no sealed value.
  CONSTRAINT machine_login_requests_final_unsealed CHECK (status NOT IN ('done', 'failed', 'expired') OR (auth_url_ct IS NULL AND code_ct IS NULL))
);
CREATE INDEX machine_login_requests_expiry ON machine_login_requests (expires_at);

CREATE TABLE machine_usage_daily (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  runner_id           uuid NOT NULL,
  repo_id             uuid,
  day                 date NOT NULL,
  source              text NOT NULL CHECK (source IN ('engine_session', 'run')),
  model_tier          text NOT NULL CHECK (model_tier ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  input_tokens        bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens   bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens  bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE SET NULL (repo_id)
);
-- One row per machine, repo (or none), day, source and tier: usage is added to it, not appended.
CREATE UNIQUE INDEX machine_usage_daily_key ON machine_usage_daily (account_id, runner_id, repo_id, day, source, model_tier) NULLS NOT DISTINCT;
CREATE INDEX machine_usage_daily_day ON machine_usage_daily (day);

-- ---- row security and grants -------------------------------------------------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  acct text := 'account_id = NULLIF(current_setting(''app.account_id'', true), '''')::uuid AND (SELECT account_is_active(NULLIF(current_setting(''app.account_id'', true), '''')::uuid))';
BEGIN
  FOREACH t IN ARRAY ARRAY['machine_provider_credentials', 'managed_servers', 'project_placements', 'machine_login_requests', 'machine_usage_daily'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO app_user USING (%s) WITH CHECK (%s)', t, acct, acct);
  END LOOP;
END
$$;

-- app_user reads every column except the sealed ones, and writes them (the seal is made in the app). Usage rows are written by a later definer.
GRANT SELECT (id, account_id, provider, kek_version, token_hint, status, last_checked_at, created_by, created_at, removed_at, removed_by) ON machine_provider_credentials TO app_user;
GRANT INSERT ON machine_provider_credentials TO app_user;
-- Update is column by column: provider, created_by, created_at, account_id and id are fixed when the row is made.
GRANT UPDATE (ciphertext, nonce, wrapped_dek, kek_version, token_hint, status, last_checked_at, removed_at, removed_by) ON machine_provider_credentials TO app_user;
GRANT SELECT (id, account_id, runner_id, kind, status, created_at, expires_at, created_by) ON machine_login_requests TO app_user;
GRANT INSERT, UPDATE ON machine_login_requests TO app_user;
GRANT SELECT, INSERT ON managed_servers TO app_user;
-- What a server's life changes. Not updatable after create: the prices and currency stamped at create (never recomputed), kind, credential_id,
-- provisioning_token_id, created_by, created_at, account_id and id.
GRANT UPDATE (name, provider_server_id, provider_firewall_id, server_type, location, public_ipv4, status, status_at, failure_code, runner_id, deleted_at, deleted_by) ON managed_servers TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_placements TO app_user;
GRANT SELECT ON machine_usage_daily TO app_user;

-- machine_ops: the credential reader (its own account only) and the three prune functions (no tenant set, old rows only).
GRANT USAGE ON SCHEMA public TO machine_ops;
-- The reader asks account_is_active(), which reads accounts: two columns, and only the session's own account row.
GRANT SELECT (id, deleted_at) ON accounts TO machine_ops;
CREATE POLICY machine_ops_use ON accounts FOR SELECT TO machine_ops
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT ON machine_provider_credentials TO machine_ops;
CREATE POLICY machine_ops_use ON machine_provider_credentials FOR SELECT TO machine_ops
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT, UPDATE, DELETE ON machine_login_requests TO machine_ops;
CREATE POLICY machine_ops_prune ON machine_login_requests FOR ALL TO machine_ops
  USING (expires_at < now() AND NULLIF(current_setting('app.account_id', true), '') IS NULL)
  WITH CHECK (expires_at < now() AND NULLIF(current_setting('app.account_id', true), '') IS NULL);
GRANT SELECT, DELETE ON machine_usage_daily TO machine_ops;
CREATE POLICY machine_ops_prune ON machine_usage_daily FOR ALL TO machine_ops
  USING (day < (now() AT TIME ZONE 'UTC')::date - 400 AND NULLIF(current_setting('app.account_id', true), '') IS NULL);
GRANT SELECT, DELETE ON managed_servers TO machine_ops;
CREATE POLICY machine_ops_prune ON managed_servers FOR ALL TO machine_ops
  USING (deleted_at < now() - interval '400 days' AND NULLIF(current_setting('app.account_id', true), '') IS NULL);

-- ---- functions -----------------------------------------------------------------------------------------------------------------------------------

-- The only reader of a credential's sealed columns. The account is the session's, never an argument; a removed credential, and a deleted account's, have nothing to return.
CREATE FUNCTION machine_credential_use(p_credential uuid)
RETURNS TABLE (o_id uuid, o_ciphertext bytea, o_nonce bytea, o_wrapped_dek bytea, o_kek_version integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  IF acct IS NULL OR p_credential IS NULL THEN
    RAISE EXCEPTION 'machine_credential_use: invalid call' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT c.id, c.ciphertext, c.nonce, c.wrapped_dek, c.kek_version
      FROM public.machine_provider_credentials c
     WHERE c.account_id = acct AND c.id = p_credential AND c.removed_at IS NULL AND public.account_is_active(acct);
END;
$$;

-- Retention. Each takes a batch size and nothing else; each returns the rows it changed.
CREATE FUNCTION machine_login_requests_prune(p_limit integer) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n integer;
  m integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'machine_login_requests_prune: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.machine_login_requests r
     SET auth_url_ct = NULL, code_ct = NULL, status = CASE WHEN r.status IN ('done', 'failed') THEN r.status ELSE 'expired' END
   WHERE r.id IN (SELECT o.id FROM public.machine_login_requests o
                   WHERE o.expires_at < now() AND (o.auth_url_ct IS NOT NULL OR o.code_ct IS NOT NULL OR o.status NOT IN ('done', 'failed', 'expired')) LIMIT p_limit);
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM public.machine_login_requests r
   WHERE r.id IN (SELECT o.id FROM public.machine_login_requests o WHERE o.expires_at < now() - interval '7 days' LIMIT p_limit);
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END;
$$;

CREATE FUNCTION machine_usage_prune(p_limit integer) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'machine_usage_prune: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.machine_usage_daily u
   WHERE u.id IN (SELECT o.id FROM public.machine_usage_daily o WHERE o.day < (now() AT TIME ZONE 'UTC')::date - 400 LIMIT p_limit);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE FUNCTION machine_servers_prune(p_limit integer) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'machine_servers_prune: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.managed_servers s
   WHERE s.id IN (SELECT o.id FROM public.managed_servers o WHERE o.deleted_at < now() - interval '400 days' LIMIT p_limit);
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
      WHERE m.roleid = 'machine_ops'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on machine_ops; cannot ALTER FUNCTION ... OWNER TO machine_ops';
    END IF;
    GRANT machine_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO machine_ops;

REVOKE ALL ON FUNCTION machine_credential_use(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION machine_login_requests_prune(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION machine_usage_prune(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION machine_servers_prune(integer) FROM PUBLIC;
ALTER FUNCTION machine_credential_use(uuid) OWNER TO machine_ops;
ALTER FUNCTION machine_login_requests_prune(integer) OWNER TO machine_ops;
ALTER FUNCTION machine_usage_prune(integer) OWNER TO machine_ops;
ALTER FUNCTION machine_servers_prune(integer) OWNER TO machine_ops;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION machine_credential_use(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION machine_login_requests_prune(integer) TO platform_ops;
GRANT EXECUTE ON FUNCTION machine_usage_prune(integer) TO platform_ops;
GRANT EXECUTE ON FUNCTION machine_servers_prune(integer) TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM machine_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE machine_ops FROM CURRENT_USER;
  END IF;
END
$$;

-- The reconcile job that calls the three prunes, every 5 minutes (a job with no row is never due). Safe to re-run.
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('machine_prune', 300) ON CONFLICT (name) DO NOTHING;

-- ---- audit_write ---------------------------------------------------------------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION audit_write(p_action text, p_payload jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct            uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  who             uuid := current_member_user_id();
  ts              timestamptz := clock_timestamp();
  stamped_payload jsonb := p_payload;
  new_id          uuid;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'audit_write: no app.account_id set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF who IS NULL THEN
    RAISE EXCEPTION 'audit_write: caller is not a verified member of account %', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'audit_write: account % is not active', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The 1026 allowlist carried forward whole, plus the machine and onboarding actions. NULL fails
  -- closed explicitly (note (b) above) instead of relying on
  -- `NOT (p_action = ANY(...))` evaluating to NULL (falsy for IF) on a
  -- NULL p_action.
  IF p_action IS NULL OR NOT (p_action = ANY (ARRAY[
    'decision_dial_changed',
    'model_connection.connect',
    'model_connection.replace',
    'model_connection.remove',
    'role_settings.mode_changed',
    'role_settings.guard_changed',
    'role_settings.model_changed',
    'run_limits.changed',
    'decision_ask_setting.changed',
    'ask_route.changed',
    'discovery_setting.changed',
    'build_concurrency.changed',
    'envelope.changed',
    'autostart_envelope.changed',
    'envelope_margin.changed',
    'context_rule.saved',
    'context_rule.replaced',
    'context_rule.removed',
    'vercel_connection.connect',
    'vercel_connection.rotate',
    'vercel_connection.remove',
    'plan_writeback_setting.changed',
    'context_budget.changed',
    'verify_settings.changed',
    'engine_bridge.settings_changed',
    'engine_bridge.data_deleted',
    'engine_command.issued',
    'engine_command.acked',
    'engine_command.cancelled',
    'engine_decision.recorded',
    'engine_decision.answered',
    'engine_halt.set',
    'engine_halt.cleared',
    'onboarding.track_chosen',
    'runner.device_approved',
    'runner.device_denied',
    'project.setup_started',
    'project.plan_approved',
    'project.install_merged',
    'project.moved',
    'project.removed',
    'engine_session.started',
    'engine_session.stopped',
    'machine_credential.added',
    'machine_credential.removed',
    'server.create_confirmed',
    'server.deleted',
    'server.orphan_kept',
    'server.unsealed',
    'machine.login_started',
    'machine.linked_notified'
  ])) THEN
    RAISE EXCEPTION 'audit_write: action % is not on the allowlist', p_action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Note (c) above: bounds a single payload's serialized size, and
  -- (D#97 fix round 1) fails closed on any TOAST-compressed argument
  -- regardless of its compressed size.
  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Decision (c)/note (a): a caller-supplied `actor`, `account_id` or
  -- `created_at` key inside the payload is overwritten with the stamped
  -- value, never trusted. Every other key (including nested ones) is
  -- stored exactly as sent.
  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(who::text));
  END IF;
  IF stamped_payload ? 'account_id' THEN
    stamped_payload := stamped_payload || jsonb_build_object('account_id', to_jsonb(acct::text));
  END IF;
  IF stamped_payload ? 'created_at' THEN
    stamped_payload := stamped_payload || jsonb_build_object('created_at', to_jsonb(ts));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, who::text, p_action, stamped_payload, ts)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- CREATE OR REPLACE preserves the owner and grants on an unchanged signature; re-run because they are idempotent (0651's pattern).
REVOKE ALL ON FUNCTION audit_write(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO context_rules_definer;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO repo_context_settings_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
