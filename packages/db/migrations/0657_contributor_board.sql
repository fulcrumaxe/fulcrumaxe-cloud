-- Contributor task board, schema half (D#70 BRD-1a; the definers are BRD-1b).
--
-- Two tenants, no cross-tenant FK: the maintainer tenant holds the settings,
-- listings, claims and attestations; the payer tenant holds claim_fundings and
-- the funding_id / claimed_run_ref columns added to spend_reservations and
-- ledger. They are linked only by plain uuid columns that BRD-1b's definers
-- resolve.
--
-- Gate G1 conditions that belong to the schema:
--   C-1. app_user is SELECT-only on task_claims, claim_fundings and
--        claim_attestations (a missing GRANT raises 42501, as in 0613), so a
--        route bug cannot rewrite payer_account_ref, funding_ref or
--        claimant_user_id. Writes go through BRD-1b's definers or platform_ops.
--   C-4. gh_repo_id is set by a trigger, and a partial unique index allows one
--        ENABLED board per GitHub repo across all accounts.
--   C-2. Both trigger functions are REVOKEd FROM PUBLIC.
--
-- Foreign keys into repos, work_items, board_listings and task_claims are NO
-- ACTION: app_user can DELETE repos and work_items, and a cascade would let it
-- destroy claim history it cannot delete directly (0400_decisions.sql).

-- 1. Maintainer tenant.
CREATE TABLE board_repo_settings (
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id          uuid NOT NULL,
  -- C-4: server-derived (trigger below); NOT NULL so a row whose repo lookup
  -- found nothing cannot be stored.
  gh_repo_id       bigint NOT NULL,
  enabled          boolean NOT NULL DEFAULT false,
  local_mode_ack   boolean NOT NULL DEFAULT false,
  claim_ttl_hours  integer NOT NULL DEFAULT 72 CHECK (claim_ttl_hours BETWEEN 4 AND 72),
  updated_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, repo_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id)
);

CREATE UNIQUE INDEX board_repo_settings_one_enabled_per_gh_repo
  ON board_repo_settings (gh_repo_id) WHERE enabled;

-- C-4: overwrite any caller-supplied gh_repo_id. INVOKER rights on purpose: it
-- reads repos under the writer's own tenant context.
CREATE FUNCTION board_repo_settings_set_gh_repo_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.gh_repo_id := (
    SELECT r.gh_repo_id FROM repos r WHERE r.account_id = NEW.account_id AND r.id = NEW.repo_id
  );
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION board_repo_settings_set_gh_repo_id() FROM PUBLIC;

CREATE TRIGGER board_repo_settings_set_gh_repo_id
  BEFORE INSERT OR UPDATE ON board_repo_settings
  FOR EACH ROW EXECUTE FUNCTION board_repo_settings_set_gh_repo_id();

CREATE TABLE board_listings (
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  work_item_id   uuid NOT NULL,
  repo_id        uuid NOT NULL,
  visibility     text NOT NULL CHECK (visibility IN ('public', 'team')),
  spec_sha256    text NOT NULL,
  spec_snapshot  text NOT NULL,
  file_scope     text[] NOT NULL,
  item_kind      text,
  state          text NOT NULL DEFAULT 'listed' CHECK (state IN ('listed', 'unlisted')),
  listed_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id)
);

CREATE TABLE task_claims (
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  listing_id           uuid NOT NULL,
  claimant_user_id     uuid NOT NULL REFERENCES users (id),
  claimant_was_member  boolean NOT NULL,
  -- Plain uuids into the payer tenant: no FK across tenants.
  payer_account_ref    uuid NOT NULL,
  funding_ref          uuid NOT NULL,
  spec_sha256          text NOT NULL,
  state                text NOT NULL DEFAULT 'active' CHECK (state IN (
                         'active', 'in_review', 'merged', 'closed_unmerged',
                         'released', 'expired', 'revoked', 'failed')),
  pr_number            bigint,
  expires_at           timestamptz NOT NULL,
  merged_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id),
  FOREIGN KEY (account_id, listing_id) REFERENCES board_listings (account_id, id)
);

CREATE UNIQUE INDEX task_claims_one_active_per_listing
  ON task_claims (listing_id) WHERE state IN ('active', 'in_review');

CREATE TABLE claim_attestations (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  claim_id    uuid NOT NULL,
  head_sha    text NOT NULL,
  base_sha    text NOT NULL,
  kid         text NOT NULL,
  envelope    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id),
  FOREIGN KEY (account_id, claim_id) REFERENCES task_claims (account_id, id)
);

-- Append-only for every role, the table owner included.
CREATE FUNCTION claim_attestations_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'claim_attestations is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION claim_attestations_append_only() FROM PUBLIC;

CREATE TRIGGER claim_attestations_no_update_delete
  BEFORE UPDATE OR DELETE ON claim_attestations
  FOR EACH ROW EXECUTE FUNCTION claim_attestations_append_only();

-- 2. Payer tenant.
CREATE TABLE claim_fundings (
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  claim_ref        uuid NOT NULL,
  listing_ref      uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('self', 'sponsor')),
  -- numeric accepts NaN, and NaN > 0 is true, so the text form is checked too.
  cap_model_usd    numeric(10, 4) NOT NULL
                     CHECK (cap_model_usd > 0 AND cap_model_usd::text !~ '[A-Za-z]'),
  cap_compute_usd  numeric(10, 4) NOT NULL
                     CHECK (cap_compute_usd > 0 AND cap_compute_usd::text !~ '[A-Za-z]'),
  state            text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'closed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id)
);

-- A funded payer-side row names the claimed run by a plain uuid, never an FK,
-- and its run_id stays NULL. funding_id and claimed_run_ref go together.
ALTER TABLE spend_reservations
  ADD COLUMN funding_id uuid,
  ADD COLUMN claimed_run_ref uuid,
  ADD FOREIGN KEY (account_id, funding_id) REFERENCES claim_fundings (account_id, id),
  ADD CONSTRAINT spend_reservations_funding_not_run
    CHECK (funding_id IS NULL OR run_id IS NULL),
  ADD CONSTRAINT spend_reservations_funding_has_claimed_run
    CHECK ((funding_id IS NULL) = (claimed_run_ref IS NULL));

ALTER TABLE ledger
  ADD COLUMN funding_id uuid,
  ADD COLUMN claimed_run_ref uuid,
  ADD FOREIGN KEY (account_id, funding_id) REFERENCES claim_fundings (account_id, id),
  ADD CONSTRAINT ledger_funding_not_run
    CHECK (funding_id IS NULL OR run_id IS NULL),
  ADD CONSTRAINT ledger_funding_has_claimed_run
    CHECK ((funding_id IS NULL) = (claimed_run_ref IS NULL));

-- Written by BRD-4 at insert; nullable, so adding it now costs nothing.
ALTER TABLE agent_runs ADD COLUMN env_digest text;

-- 3. RLS, enabled and forced on all five tables, then grants.
ALTER TABLE board_repo_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_repo_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE board_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_listings FORCE ROW LEVEL SECURITY;
ALTER TABLE task_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE claim_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_attestations FORCE ROW LEVEL SECURITY;
ALTER TABLE claim_fundings ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_fundings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON board_repo_settings TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_isolation ON board_listings TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON board_repo_settings TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON board_listings TO app_user;

-- C-1: SELECT-only for app_user; any INSERT, UPDATE or DELETE fails 42501.
CREATE POLICY tenant_select ON task_claims FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_select ON claim_attestations FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_select ON claim_fundings FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT ON task_claims TO app_user;
GRANT SELECT ON claim_attestations TO app_user;
GRANT SELECT ON claim_fundings TO app_user;

-- platform_ops owns BRD-1b's definers, so it is the only writer of the claim
-- tables. board_listings gets UPDATE (updated_at) only, which is what
-- SELECT ... FOR UPDATE on a listing row needs.
CREATE POLICY platform_ops_full_access ON board_repo_settings TO platform_ops
  USING (true) WITH CHECK (true);
CREATE POLICY platform_ops_full_access ON board_listings TO platform_ops
  USING (true) WITH CHECK (true);
CREATE POLICY platform_ops_full_access ON task_claims TO platform_ops
  USING (true) WITH CHECK (true);
CREATE POLICY platform_ops_full_access ON claim_attestations TO platform_ops
  USING (true) WITH CHECK (true);
CREATE POLICY platform_ops_full_access ON claim_fundings TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT ON board_repo_settings TO platform_ops;
GRANT SELECT ON board_listings TO platform_ops;
GRANT UPDATE (updated_at) ON board_listings TO platform_ops;
GRANT SELECT, INSERT, UPDATE ON task_claims TO platform_ops;
GRANT SELECT, INSERT ON claim_attestations TO platform_ops;
GRANT SELECT, INSERT, UPDATE ON claim_fundings TO platform_ops;
