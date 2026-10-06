-- D#5 E5a: environment tables env_versions and env_builds, plus two nullable
-- agent_runs columns recording the environment a run used.
--
--   * env_versions  Insert-only for app_user: a re-pin is a NEW row and never
--                   rewrites built_image_digest (E14a, C8). Both digests are
--                   NOT NULL sha256:<64 hex>; a tag is not a reproduction. A
--                   failed build has no row here, only an env_builds row.
--   * env_builds    app_user may advance status, failing_step, log_ref,
--                   finished_at, cost_usd; never budget or env_version_id.
--                   budget is NOT NULL and includes 'emergency' (OD-7, C12,
--                   D#8 amendment).
--   * agent_runs    env_version_id, image_digest: nullable (old rows cannot be
--                   backfilled), unwritable by app_user (0642). The platform_ops
--                   INSERT grant lands with the agent_run_create change that
--                   fills them (E9), as 0648 did; nothing writes them yet.
--
-- env_version_id (lowercase-hex sha256 envVersionId) is text, not a foreign
-- key: env_builds names versions whose build failed, and runs outlive cache rows.
-- Numbering (D#94 R1): open PRs hold 0670, 0672, 0673; E5b takes 0675.

CREATE TABLE env_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id             uuid NOT NULL,
  env_version_id      text NOT NULL CHECK (env_version_id ~ '^[0-9a-f]{64}$'),
  canonical_spec      text NOT NULL CHECK (octet_length(canonical_spec) BETWEEN 1 AND 65536),
  base_image_digest   text NOT NULL CHECK (base_image_digest ~ '^sha256:[0-9a-f]{64}$'),
  built_image_digest  text NOT NULL CHECK (built_image_digest ~ '^sha256:[0-9a-f]{64}$'),
  source              text NOT NULL CHECK (source IN ('repo', 'proposal', 'preset')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, repo_id, env_version_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);

CREATE TABLE env_builds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  env_version_id  text NOT NULL CHECK (env_version_id ~ '^[0-9a-f]{64}$'),
  status          text NOT NULL CHECK (status <> ''),
  failing_step    text,
  log_ref         text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  cost_usd        numeric(10, 4) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  budget          text NOT NULL CHECK (budget IN ('foreground_compute', 'background_compute', 'emergency')),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  UNIQUE (account_id, id)
);

CREATE INDEX idx_env_builds_version ON env_builds (account_id, env_version_id);

ALTER TABLE agent_runs
  ADD COLUMN env_version_id text CHECK (env_version_id ~ '^[0-9a-f]{64}$'),
  ADD COLUMN image_digest   text CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$');

ALTER TABLE env_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE env_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE env_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE env_builds FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select ON env_versions FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_insert ON env_versions FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

CREATE POLICY tenant_select ON env_builds FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_insert ON env_builds FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_update ON env_builds FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

REVOKE ALL ON env_versions, env_builds FROM PUBLIC;
GRANT SELECT, INSERT ON env_versions TO app_user;
GRANT SELECT, INSERT ON env_builds TO app_user;
GRANT UPDATE (status, failing_step, log_ref, finished_at, cost_usd) ON env_builds TO app_user;
