-- Site-kit tables (D#2606 K04), landing in the migrations directory H02
-- (migrations/0001_core.sql) owns. Depends on that file's `accounts`,
-- `users`, `repos` tables, `app_user`/`platform_ops` roles, and the
-- `account_is_active()` function -- all created there, none redefined here.
--
-- Every table below follows the exact conventions 0001_core.sql establishes
-- (see its header for the full rationale of each):
--   - RLS ENABLED and FORCED on every table, no exemptions (none of these
--     five tables are platform-wide -- see src/platformWideTables.ts, which
--     stays empty for this task).
--   - Every tenant policy calls `account_is_active` through the HOISTED
--     scalar-subquery form -- `(SELECT account_is_active(NULLIF(current_
--     setting('app.account_id', true), '')::uuid))` -- never the per-row
--     `account_is_active(account_id)` form, which 0001_core.sql's
--     performance note measured ~25x slower because Postgres cannot fold a
--     per-row function call into a single InitPlan.
--   - Every child table's FK to another tenant table is COMPOSITE and
--     carries account_id: `FOREIGN KEY (account_id, fk) REFERENCES parent
--     (account_id, id)`, so a tenant cannot attach a row to another
--     tenant's parent even though the FK check itself runs with elevated
--     privilege that bypasses RLS. Every parent referenced this way gets
--     its own `UNIQUE (account_id, id)`, which also means none of these
--     tables need a separate `idx_*_account_id` index -- the leading column
--     of that UNIQUE constraint already covers it, same reasoning as
--     0001_core.sql's own index section.
--   - `approved_by` (site_versions) and `user_id` (attestations) are
--     PLAIN (non-composite) FKs to `users(id)`, same as
--     `account_members.user_id` and `invitations.invited_by` -- users is
--     global, so there is no second account_id to match against.
--
-- CHECK constraints: `claims.kind` and `claims.verdict` get one because
-- D#2606 K01 (packages/sitekit-claims/src/schema.ts, merged, frozen)
-- already gives an explicit, closed enum for both -- `ClaimKind` and
-- `ClaimVerdict` -- so this is the same "spec gave an explicit
-- pipe-separated value list" case 0001_core.sql's header describes, applied
-- to a list this Discussion already froze rather than one invented here.
-- Every other status-shaped column in this file (`sites.status`,
-- `sites.hosting_target`, `sync_passes.trigger`, `sync_passes.status`) has
-- no such list in the K04 spec text -- K08/K09/K11 own that vocabulary --
-- so they stay plain text, exactly like `accounts.plan` or
-- `agent_runs.status` in 0001_core.sql.
--
-- The one check constraint the K04 spec text asks for by name:
-- `site_versions.approved_by` is required for `published_at` to be set.
--
-- `site_versions.template_version` was added after this task started, by a
-- binding D#2606 Discussion amendment (2026-09-17, "Spec amendment --
-- template wording, K13 routing, and one new obligation"): the template
-- that produced a row must be recorded, since nothing else lets a future
-- template upgrade be previewed/diffed against what's already live. See
-- that column's own comment below for scope (column only, no
-- resolver/upgrade logic -- that's D#2612's).
--
-- `site_versions.template_digest` and `site_versions.content_schema_version`
-- were added by a second binding amendment ("Spec amendment 2 -- two
-- further columns on site_versions (K04)"), posted after a first attempt to
-- relay them over a direct message (not the Discussion) was correctly
-- refused and re-verified. Both are column-only, same fence as
-- template_version: no resolver, no upgrade flow, no pin table, and no
-- version field inside the zod SiteContent/Claim schemas -- see each
-- column's own comment below.

CREATE TABLE sites (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Nullable + SET NULL, not CASCADE: a site (and its version/billing
  -- history) must survive the underlying repo connection being removed --
  -- same reasoning as repos.installation_id -> installations in
  -- 0001_core.sql.
  repo_id             uuid,
  hosting_target      text,
  vercel_project_id   text,
  domain              text,
  domain_verified_at  timestamptz,
  content_sha         text,
  verified_sha        text,
  status              text NOT NULL DEFAULT 'draft',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id)
    ON DELETE SET NULL (repo_id)
);

CREATE TABLE claims (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  site_id      uuid NOT NULL,
  -- Default 'en': the minimum paid product (product-owner, Round 1) is
  -- English-only; K13 adds other locales as separate rows, never rewriting
  -- this default.
  locale       text NOT NULL DEFAULT 'en',
  -- The app-level claim id (K01's `Claim.id`) -- named claim_key here to
  -- keep it distinct from this table's own surrogate `id`.
  claim_key    text NOT NULL,
  text         text NOT NULL,
  kind         text NOT NULL
                 CHECK (kind IN ('feature', 'figure', 'status', 'pricing', 'legal', 'security')),
  evidence     jsonb NOT NULL DEFAULT '[]'::jsonb,
  verdict      text NOT NULL DEFAULT 'PENDING'
                 CHECK (verdict IN ('VERIFIED', 'FALSE', 'UNVERIFIABLE', 'CONFLICT', 'PENDING', 'ATTESTED')),
  checked_sha  text,
  source_hash  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  -- One claim_key per site per locale -- the natural key K05/K13 upsert against.
  UNIQUE (site_id, locale, claim_key),
  FOREIGN KEY (account_id, site_id) REFERENCES sites (account_id, id) ON DELETE CASCADE
);

CREATE TABLE site_versions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  site_id                  uuid NOT NULL,
  repo_sha                 text NOT NULL,
  content                  jsonb NOT NULL,
  -- D#2606 Discussion amendment 2026-09-17 ("Spec amendment -- template
  -- wording, K13 routing, and one new obligation"), binding, item 3: K03's
  -- template package (packages/sitekit-template) currently exports no
  -- version identifier at all, so a site generated today and one generated
  -- after the template improves are indistinguishable in this table.
  -- NOT NULL with no default deliberately -- there is nothing yet to
  -- default it TO (see the note below); the writer (K05/K10/K11) must
  -- supply the value explicitly once K03 exports one. Column only: no
  -- resolver, pin table or upgrade/approval flow -- that is D#2612's, per
  -- the amendment.
  template_version         text NOT NULL,
  -- Amendment 2 ("Spec amendment 2 -- two further columns on site_versions
  -- (K04)"): a version string names a release; a digest is the content
  -- hash of the renderer that actually ran. They diverge exactly when it
  -- matters (an unreleased build, a hotfix that reused a version label, a
  -- local render) -- K07 attestation has to bind to the bytes, not the
  -- label. NOT NULL, no default: the writer supplies it, same as
  -- template_version.
  template_digest          text NOT NULL,
  -- Amendment 2: the SiteContent shape version `content` conforms to.
  -- packages/sitekit-claims/src/schema.ts's zod schemas are .strict(), so a
  -- stored document missing a field a later schema version declares is
  -- REJECTED, not defaulted -- and D#2612 has settled that a row a customer
  -- was billed for, signed, or attested to is never rewritten, so there is
  -- no repair path to defer this to. The tag lives on the row, never inside
  -- the zod schemas themselves, so the strict schemas never have to change
  -- to accommodate versioning. NOT NULL, no default: the writer supplies
  -- it. Integer (not text) because it's an ordered shape revision, not a
  -- label.
  content_schema_version  integer NOT NULL,
  report                   jsonb,
  -- Plain FK: users is global (see file header and 0001_core.sql).
  approved_by              uuid REFERENCES users (id),
  approved_at              timestamptz,
  published_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, site_id) REFERENCES sites (account_id, id) ON DELETE CASCADE,
  -- K04 pass/fail, verbatim: approved_by is required for published_at to be set.
  CHECK (published_at IS NULL OR approved_by IS NOT NULL)
);

CREATE TABLE attestations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  claim_id    uuid NOT NULL,
  version_id  uuid NOT NULL,
  -- Plain FK: users is global (see file header and 0001_core.sql).
  user_id     uuid NOT NULL REFERENCES users (id),
  at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  -- K07: "Attestations bind to version_id, so a new version requires
  -- re-attestation of changed claims only" -- one attestation per
  -- claim/version pair.
  UNIQUE (claim_id, version_id),
  FOREIGN KEY (account_id, claim_id) REFERENCES claims (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, version_id) REFERENCES site_versions (account_id, id) ON DELETE CASCADE
);

CREATE TABLE sync_passes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  site_id      uuid NOT NULL,
  trigger      text NOT NULL,
  diff_paths   jsonb,
  status       text NOT NULL DEFAULT 'pending',
  started_at   timestamptz,
  model_usd    numeric(10, 4),
  compute_usd  numeric(10, 4),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, site_id) REFERENCES sites (account_id, id) ON DELETE CASCADE
);

-- Row-level security. See 0001_core.sql's header for the full explanation
-- of NULLIF(current_setting(...), '') and the hoisted account_is_active
-- subquery form used identically below.

ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sites TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- No DELETE: unpublishing/removing a site is a status transition, not a
-- row deletion, matching agent_runs's own no-DELETE rationale.
--
-- KNOWN, DELIBERATELY DEFERRED (security review, not fixed here): this
-- blanket UPDATE lets app_user rewrite `verified_sha` and
-- `domain_verified_at` -- columns the K05 extract/verify pipeline and the
-- K08 domain-ownership check are supposed to own, not the tenant session
-- that's also using this same app_user role to browse its own site. One
-- application role currently serves both the tenant and the verifier/
-- publish pipeline, so there is no second writer identity to grant those
-- columns to instead -- splitting that is K05/K08's decision, not a
-- column-list fix inside this migration. Team Lead is posting a D#2606
-- amendment to make this binding on K05/K08.
GRANT SELECT, INSERT, UPDATE ON sites TO app_user;

ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON claims TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- KNOWN, DELIBERATELY DEFERRED (security review, not fixed here): same gap
-- as sites above -- this blanket UPDATE lets app_user rewrite `verdict`,
-- `evidence` and `checked_sha`, which are supposed to be the K05 verifier's
-- exclusive output, not something the tenant session using this same role
-- can also set. No second writer identity exists yet to split this onto;
-- K05/K08 own that decision. Team Lead is posting a D#2606 amendment to
-- make this binding on K05/K08.
GRANT SELECT, INSERT, UPDATE ON claims TO app_user;

ALTER TABLE site_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON site_versions TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- MUST FIX (security review, live-verified against a real cluster):
-- template_digest exists precisely so a K07 approval binds to the bytes
-- the renderer actually produced, not to a version label -- but a blanket
-- UPDATE grant let app_user rewrite `content`, `template_digest`,
-- `repo_sha` and `content_schema_version` on a row that was ALREADY
-- approved and published, and re-point `approved_by`/backdate
-- `approved_at`/`published_at`, with the customer's already-recorded
-- attestation none the wiser (attestations is correctly append-only, but
-- it binds to a mutable row). 0001_core.sql:446-449 already states this
-- exact convention ("grant UPDATE on that column specifically -- never a
-- blanket UPDATE") for exactly this situation; this table just hadn't
-- followed it. `id`, `account_id`, `site_id`, `repo_sha`, `content`,
-- `template_version`, `template_digest` and `content_schema_version` are
-- write-once from here on -- only the columns the planned lifecycle
-- actually needs to mutate after creation are grantable: `report` (K05/K06
-- fill it in), `approved_by`/`approved_at` (K07 approval),
-- `published_at` (K08 publish). See test/sitekit.test.ts for the
-- privileges tests asserting each write-once column rejects UPDATE with
-- 42501 -- the grant blocks it there, before RLS is ever evaluated,
-- exactly like a re-parented `account_id` already did.
GRANT SELECT, INSERT ON site_versions TO app_user;
GRANT UPDATE (report, approved_by, approved_at, published_at) ON site_versions TO app_user;
-- KNOWN, DELIBERATELY DEFERRED (security review, not fixed here): `report`
-- has to stay tenant-writable through app_user for K05/K06 to fill it in
-- (there is no second writer identity for the verifier pipeline yet, same
-- gap noted on sites/claims above), which means the tenant session can
-- also rewrite its own verification report. That's real, and it is
-- K05/K08's decision to give the verifier pipeline its own identity, not a
-- column-list fix inside this migration. Team Lead is posting a D#2606
-- amendment to make this binding on K05/K08.

ALTER TABLE attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attestations FORCE ROW LEVEL SECURITY;
-- FIX (security review, live-verified against a real cluster): the
-- account_id-only WITH CHECK let app_user insert an attestation naming ANY
-- real row in the global `users` table as `user_id` -- including another
-- tenant's owner -- and, because this table is correctly append-only, a
-- wrong signer would have been permanent with no repair path, on the one
-- table whose entire purpose is naming who signed off on legal, pricing
-- and security text published in the customer's name. The extra two
-- conjuncts pin `user_id` to the CALLING session's own `app.user_id` (set
-- via withTenant's 4-arg form) and require that user to actually be a
-- member of the current tenant account -- the same shape 0001_core.sql
-- round 3 already chose for account_members.user_id, and it still reads
-- via a membership EXISTS join rather than trusting app.user_id alone, so
-- it passes a pg_policies scan for a bare-user_id check the same way that
-- one does.
--
-- Honest about what this buys, per the reviewer: app.user_id is exactly as
-- application-trusted as app.account_id already is -- this raises the bar
-- from "any real user in the system" to "a member of THIS account", not to
-- "the human who was actually shown the attestation UI". It does not stop
-- an account owner who controls their own session from naming a colleague
-- as signer. That residual trust is core's existing design (the same trust
-- withTenant's callers already carry for app.account_id), not something
-- this migration changes or is positioned to change.
CREATE POLICY tenant_isolation ON attestations TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.user_id = attestations.user_id
        AND m.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    )
  );
-- Append-only: an attestation is a record that a specific person attested
-- to a specific version, same rationale as ledger/audit_log in
-- 0001_core.sql -- no UPDATE, no DELETE.
GRANT SELECT, INSERT ON attestations TO app_user;

ALTER TABLE sync_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_passes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_passes TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT, UPDATE ON sync_passes TO app_user;
