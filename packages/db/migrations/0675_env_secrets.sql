-- Environment secrets: what a repo's test environment may use, and what a run
-- actually used (D#5 E5b). The database holds REFERENCES and COUNTS, never a
-- secret value: neither table has a column that could carry one.
--
--   * env_secret_refs    one named secret set per repo: name, kind, destination
--                        host, and a reference (a pointer to where the value is
--                        held, not the value). RLS forced, app_user CRUD.
--   * env_secret_access  append-only ledger: one row per batch of requests a
--                        run made with a secret to a host. RLS forced, app_user
--                        SELECT + INSERT only. run_id cascades with agent_runs.
--                        No FK to env_secret_refs: the ledger outlives a ref.

-- The run-event redactor's credential shapes (core/events/redact.ts), plus rk_,
-- xox tokens, PEM headers and any 40+ character run of token characters.
CREATE FUNCTION env_secret_credential_shaped(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT t ~ 'vck_[A-Za-z0-9_-]{10,}|ghs_[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[0-9A-Za-z+/=_-]{20,}|fxat_[0-9A-Za-z]{49}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|gh[pour]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|rk_(?:live|test)_[A-Za-z0-9]{10,}|xox[abp]-[A-Za-z0-9-]{10,}|-----BEGIN|[A-Za-z0-9_+-]{40,}' $$;

CREATE TABLE env_secret_refs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id       uuid NOT NULL,
  name          text NOT NULL CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' AND NOT env_secret_credential_shaped(name)),
  kind          text NOT NULL CHECK (kind IN ('brokered_http', 'in_sandbox')),
  -- A brokered secret is only ever sent to one named host (two or more clean labels, the last
  -- starting with a letter, which refuses IP literals; no localhost or
  -- cloud-metadata name; no wildcard);
  -- an in_sandbox secret never leaves the sandbox and has none.
  destination_host text CHECK (destination_host ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?[.])+[a-z]([a-z0-9-]*[a-z0-9])?$' AND char_length(destination_host) <= 253
    AND destination_host !~ '(^|[.])(localhost|internal|local|localdomain)$'),
  -- Where the value lives: a scheme from a fixed list (vault: a secret-manager
  -- path, env: a platform env-var name, broker: a credential-broker handle)
  -- then a path. Credential shapes (the run-event redactor's list, plus a few)
  -- and long high-entropy runs are refused. This works on shape and cannot prove
  -- a pointer is not a value; platform-minted references (E7) close that.
  reference     text NOT NULL
    CONSTRAINT reference_is_pointer CHECK (
      reference ~ '^(vault|env|broker):[A-Za-z0-9_./-]{1,200}$'
      AND NOT env_secret_credential_shaped(reference)),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'brokered_http') = (destination_host IS NOT NULL)),
  UNIQUE (account_id, id),
  UNIQUE (account_id, repo_id, name),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_env_secret_refs_account_id ON env_secret_refs (account_id);

CREATE TABLE env_secret_access (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  run_id           uuid NOT NULL,
  secret_name      text NOT NULL CHECK (secret_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' AND NOT env_secret_credential_shaped(secret_name)),
  destination_host text NOT NULL CHECK (destination_host ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?[.])+[a-z]([a-z0-9-]*[a-z0-9])?$' AND char_length(destination_host) <= 253
    AND destination_host !~ '(^|[.])(localhost|internal|local|localdomain)$'),
  request_count    integer NOT NULL CHECK (request_count > 0),
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_env_secret_access_account_run ON env_secret_access (account_id, run_id);

REVOKE ALL ON env_secret_refs, env_secret_access FROM PUBLIC;

ALTER TABLE env_secret_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE env_secret_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON env_secret_refs TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON env_secret_refs TO app_user;

ALTER TABLE env_secret_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE env_secret_access FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON env_secret_access TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT ON env_secret_access TO app_user;
