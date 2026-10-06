-- The schema for local runners: a program on a customer's machine that runs an agent and talks to the cloud over
-- signed requests. This file adds the tables the cloud keeps about runners and the columns a run needs to be leased
-- to one. It writes no data; later changes add the code that uses it and may add columns or grants of their own.
--
-- Numbered above the highest migration on main (0707); open pull requests already hold 0708 to 0710. Re-check
-- against main right before merging.
--
-- Not here, on purpose: accounts.plan (0001 left it unconstrained text, so there is no CHECK to widen);
-- agent_runs_execution_mode_check (0605; it stays 'sandbox' until the change that first creates runner runs widens
-- it); and any private key (the DB holds only the public JWK and its thumbprint, and refuses a JWK with anything else).

-- runners: one row per registered runner.
-- jkt is the RFC 7638 thumbprint of the Ed25519 public key (43 base64url characters), the `keyid` of every request
-- the runner signs; unique across accounts, so a key belongs to one runner. credential_mode names where the model
-- credential lives on the runner's machine and never holds a secret. isolation is what the runner last reported
-- (display only). registered_by is the owner or admin who minted the registration code.
CREATE TABLE runners (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  registered_by     uuid NOT NULL REFERENCES users (id),
  public_key_jwk    jsonb NOT NULL,
  jkt               text NOT NULL,
  credential_mode   text NOT NULL,
  isolation         text,
  allowed_repo_ids  uuid[] NOT NULL DEFAULT '{}',
  allowed_roles     text[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  key_rotated_at    timestamptz,
  last_seen_at      timestamptz,
  protocol_version  integer,
  binary_version    text,
  revoked_at        timestamptz,
  revoked_reason    text,
  UNIQUE (account_id, id),
  CONSTRAINT runners_jkt_key UNIQUE (jkt),
  CONSTRAINT runners_jkt_format CHECK (jkt ~ '^[A-Za-z0-9_-]{43}$'),
  -- Exactly kty, crv and x: no private member `d`, nothing else. COALESCE, because a CHECK that evaluates to NULL
  -- passes, and a key with no `x` would otherwise slip through.
  CONSTRAINT runners_public_key_check CHECK (COALESCE(
    public_key_jwk ->> 'kty' = 'OKP'
    AND public_key_jwk ->> 'crv' = 'Ed25519'
    AND jsonb_typeof(public_key_jwk -> 'x') = 'string'
    AND (public_key_jwk - 'kty' - 'crv' - 'x') = '{}'::jsonb,
    false
  )),
  CONSTRAINT runners_credential_mode_check CHECK (credential_mode IN ('subscription', 'api_key')),
  CONSTRAINT runners_isolation_check CHECK (isolation IS NULL OR isolation IN ('microvm', 'vm_container', 'container', 'host_sandbox'))
);
CREATE INDEX idx_runners_account_id ON runners (account_id);

-- runner_registration_codes: single-use codes a signed-in owner or admin mints so a runner can register. Only the
-- SHA-256 is stored (64 hex characters); there is no plaintext column, and a plaintext code would fail the CHECK.
CREATE TABLE runner_registration_codes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  registered_by     uuid NOT NULL REFERENCES users (id),
  code_sha256       text NOT NULL,
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  credential_mode   text NOT NULL,
  allowed_repo_ids  uuid[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runner_registration_codes_code_sha256_key UNIQUE (code_sha256),
  CONSTRAINT runner_registration_codes_sha_format CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT runner_registration_codes_credential_mode_check CHECK (credential_mode IN ('subscription', 'api_key'))
);
CREATE INDEX idx_runner_registration_codes_account_id ON runner_registration_codes (account_id);

-- runner_request_nonces: nonces of signed requests already seen, so a replay is refused. The caller prunes old rows.
-- The composite foreign key means a nonce can only name a runner of its own account.
CREATE TABLE runner_request_nonces (
  account_id  uuid NOT NULL,
  runner_id   uuid NOT NULL,
  nonce       text NOT NULL,
  seen_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runner_request_nonces_runner_nonce_key UNIQUE (runner_id, nonce),
  CONSTRAINT runner_request_nonces_nonce_format CHECK (nonce ~ '^[A-Za-z0-9_-]{16,64}$'),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_runner_request_nonces_seen_at ON runner_request_nonces (seen_at);

-- Row level security, enabled and forced on all three: app_user sees its own account's rows while the account is
-- active; platform_ops sees everything, since it looks a runner up by key before any tenant is known. app_user may
-- only read runners and codes for now. The nonces have a policy but no grant, so a later grant is tenant-scoped.
ALTER TABLE runners ENABLE ROW LEVEL SECURITY;
ALTER TABLE runners FORCE ROW LEVEL SECURITY;
ALTER TABLE runner_registration_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_registration_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE runner_request_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_request_nonces FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON runners FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_isolation_select ON runner_registration_codes FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_isolation_select ON runner_request_nonces FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

CREATE POLICY platform_ops_full_access ON runners TO platform_ops USING (true) WITH CHECK (true);
CREATE POLICY platform_ops_full_access ON runner_registration_codes TO platform_ops USING (true) WITH CHECK (true);
CREATE POLICY platform_ops_full_access ON runner_request_nonces TO platform_ops USING (true) WITH CHECK (true);

GRANT SELECT ON runners TO app_user;
GRANT SELECT ON runner_registration_codes TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON runners TO platform_ops;
GRANT SELECT, INSERT, UPDATE, DELETE ON runner_registration_codes TO platform_ops;
GRANT SELECT, INSERT, UPDATE, DELETE ON runner_request_nonces TO platform_ops;

-- agent_runs: a run can belong to a runner. runtime gains 'runner'; the KPI views (0623) count only 'local' and
-- 'production', and a runner run never writes the ledger, so no KPI figure changes. runner_id uses the account
-- composite key, so a run can never point at another account's runner. lease_generation counts how often the run
-- was handed out and fences stale writers. initiated_by and approved_by are the people behind the run. job_signed is
-- the signed job as it was handed out.
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_runtime_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_runtime_check CHECK (runtime IN ('local', 'production', 'runner'));

ALTER TABLE agent_runs
  ADD COLUMN runner_id         uuid,
  ADD COLUMN lease_generation  integer NOT NULL DEFAULT 0,
  ADD COLUMN lease_expires_at  timestamptz,
  ADD COLUMN initiated_by      uuid REFERENCES users (id),
  ADD COLUMN approved_by       uuid REFERENCES users (id),
  ADD COLUMN job_signed        jsonb;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_lease_generation_check CHECK (lease_generation >= 0);
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_runner_fk
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE SET NULL (runner_id);
CREATE INDEX idx_agent_runs_runner_id ON agent_runs (account_id, runner_id) WHERE runner_id IS NOT NULL;

-- repos.execution_mode gains 'runner_local' (0605's CHECK allowed only 'sandbox'). The resolver in packages/runner
-- still fails closed for a mode with no registered target, so this alone routes nothing to a runner.
ALTER TABLE repos DROP CONSTRAINT repos_execution_mode_check;
ALTER TABLE repos ADD CONSTRAINT repos_execution_mode_check CHECK (execution_mode IN ('sandbox', 'runner_local'));
