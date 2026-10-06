-- Partner tenancy migration, roles and isolation (D#2607 task P01).
--
-- Builds on the H02/X1 hook already in 0001_core.sql: `partners`,
-- `accounts.partner_id`, `accounts.referred_by_partner_id`. This file adds
-- `partner_members`, the `partner_user` role (column-limited reads of
-- customer data plus full self-service on the partner's own tables), and
-- the three-level isolation: platform (platform_ops), partner admin
-- (partner_user), customer (app_user).
--
-- CHECK constraints follow 0001_core.sql's own convention (see its header):
-- only added for columns whose spec text gave an explicit pipe-separated
-- value list. `partner_domains.vercel_state`, `partner_escalations.status`
-- and `partner_retail_prices.{product,plan}` got no such list in the D#2607
-- P01 task text, so they stay plain text.
--
-- SPEC-VS-REALITY DIVERGENCE (documented per the Executor role's contract --
-- Spec is binding, but a column that does not exist cannot be granted on):
-- the frozen D#2607 P01 pass/fail item 2 lists partner_user's column grant
-- on `repos` as "(id, account_id, product, gh_full_name)" and on
-- `agent_runs` as "(id, account_id, role, status, model, usd, created_at)".
-- Neither `repos.gh_full_name` nor `agent_runs.model` exists in
-- 0001_core.sql (repos has `gh_repo_id bigint`; agent_runs has no model
-- column at all). Both names appear nowhere else in the merged schema, so
-- this isn't a naming drift I can resolve by grepping for the real column
-- -- they were never built. Granted instead: `repos.gh_repo_id` in
-- `gh_full_name`'s place (the only column that identifies which GitHub repo
-- a run touched, matching the intent -- "repos, run metadata" -- of the
-- technical-architect's Round 1 text this list was transcribed from), and
-- `agent_runs.model` is simply dropped (no substitute column exists, and
-- the higher-level acceptance text only promises "plan, status and usage
-- dollars", never a model name). Every OTHER column in every OTHER
-- table's grant list in item 2 exists exactly as named and is granted
-- exactly as listed.
--
-- X-USER-ID (Spec amendment, discussioncomment-18486915, binding on P01 and
-- P02): any policy that reads app.user_id must join account_members or
-- partner_members itself rather than trust the setting. None of the
-- policies below actually needs app.user_id for row visibility -- every
-- new policy is scoped by app.partner_id (verified by the auth-handoff a
-- later task builds) or by an ordinary account_id/partner_id match, which
-- is the same pattern 0001_core.sql's own account_id policies already use
-- and isn't the thing the amendment is about. The one place a NEW policy
-- DOES read app.user_id is support_access_log's partner-side INSERT below,
-- and it joins partner_members inline, by name, satisfying the amendment
-- directly. withPartner still accepts and sets app.user_id (per the Tables
-- section) so a future policy or an audit column has it available -- but
-- per the amendment, availability is not trust: nothing here, or added
-- later, may read it without its own join.
--
-- FIX ROUND (D#2607 P01, security review on PR #13, head a10b576 -- head
-- comment https://github.com/fulcrumaxe/cloud/pull/13#issuecomment-5723757380):
-- fixes findings 1, 2, 3, 4, 5, 8 and 9. Findings 6 (the TXT challenge
-- itself, `txt_token_hash` supplied by the partner) and 7 (no policy checks
-- `partners.status`) are left for P05 and P10 respectively, per the
-- reviewer's own task split -- neither is touched here.
--   1. `partner_suspend_account` now requires an owner/admin
--      `partner_members` row for (caller_partner_id, caller_user_id) before
--      touching anything; a forged or missing actor changes 0 rows and
--      raises, rather than writing an audit row under a forged identity.
--   2. `support_grants_created_at_guard` now exempts the privileged side
--      (`pg_has_role(current_user, 'platform_ops', 'USAGE')`) instead of
--      naming the tenant side (`current_user = 'app_user'`), so an
--      inheriting member role of `app_user` is guarded too.
--   3. `has_active_support_grant` and `support_grant_matches` now also
--      require `partner_account_visible()` (current ownership, not
--      soft-deleted) -- a partner that loses an account, or whose account
--      gets soft-deleted, loses `run_events`/`support_access_log` access
--      immediately rather than for up to 60 more minutes.
--   4. `partner_domains.hostname` uniqueness is now a partial unique index
--      (`WHERE txt_verified_at IS NOT NULL`), so an unverified squat no
--      longer blocks the real owner's claim -- whichever row verifies
--      first wins the slot. Partners may now DELETE their own still-
--      unverified rows (and only those -- a verified row stays
--      platform-only to remove).
--   5. `has_active_support_grant`, `support_grant_matches` and
--      `partner_account_visible` now read `app.partner_id` from the
--      session themselves instead of taking it as a parameter, closing the
--      cross-partner-oracle shape (any partner id could be passed as an
--      argument before).
--   8. `support_grants`' own `tenant_isolation` policy now requires
--      `granted_by_user_id` to be a real `account_members` row for the
--      grant's `account_id` -- not merely any user id `app_user` supplies.
--      `partner_escalations`' INSERT grant to `partner_user` is now
--      column-scoped to (partner_id, account_id, subject, body), so a
--      partner can no longer set `status` or `created_at` itself.
--   9. `withPartner` now asserts `current_user = 'partner_user'` right
--      after `BEGIN`, so handing it the wrong pool (e.g. `platform_ops`'s)
--      fails closed instead of silently running with full access. See
--      packages/db/src/withPartner.ts.

-- ---------------------------------------------------------------------
-- partner_members: which users administer which partner, and at what role.
-- ---------------------------------------------------------------------
CREATE TABLE partner_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  uuid NOT NULL REFERENCES partners (id) ON DELETE CASCADE,
  -- Plain FK: users is global (see 0001_core.sql's file header).
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'support')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, user_id)
);

-- ---------------------------------------------------------------------
-- partner_branding: one row per partner. Approval fields (status,
-- reviewed_by, reviewed_at) are platform_ops-only -- see the column-level
-- GRANT below, which deliberately omits them from partner_user's INSERT
-- and UPDATE column lists so a partner can never self-approve. P09 (a
-- later task, no migration of its own) owns the actual approval workflow;
-- this migration only has to make self-approval impossible at the grant
-- level, which it does.
-- ---------------------------------------------------------------------
CREATE TABLE partner_branding (
  partner_id           uuid PRIMARY KEY REFERENCES partners (id) ON DELETE CASCADE,
  product_name         text,
  logo_object_key      text,
  color_primary        text,
  color_accent         text,
  support_email        text,
  reply_to             text,
  sender_name          text,
  terms_url            text,
  privacy_url          text,
  site_credit_enabled  boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'pending_review', 'approved', 'rejected')),
  reviewed_by          uuid REFERENCES users (id),
  reviewed_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- partner_domains. hostname uniqueness applies only once VERIFIED (D#2607
-- P01 fix-round finding 4): a global UNIQUE constraint including unverified
-- rows let any partner_user session squat an unclaimed hostname -- including
-- an affiliate claiming a lookalike of our own domain -- with a bare
-- unverified INSERT, and nothing ever expired the claim; the real owner
-- then hit a unique violation that only platform_ops could clear. A partial
-- unique index scoped to verified rows means unverified rows for the same
-- hostname may coexist, and TXT verification (P05) is the actual
-- tie-breaker: whichever row verifies first takes the slot, and every
-- other unverified row for that hostname fails the index on ITS OWN
-- verification attempt, not on insert.
-- ---------------------------------------------------------------------
-- Canonical hostname form only (D#2607 P01 merge-round finding W1): lowercase,
-- no trailing dot, no leading/trailing/internal whitespace. Punycode labels
-- (xn--...) are ordinary lowercase-alnum-hyphen hostname characters and pass
-- unchanged -- this is a syntax check on the wire form, not an IDNA
-- validator, so it doesn't (and can't, in a CHECK) confirm a punycode label
-- decodes to valid Unicode. Each label: starts and ends with an alnum char,
-- hyphens allowed only in the middle, 1-63 chars -- the standard hostname
-- label shape.
CREATE TABLE partner_domains (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id       uuid NOT NULL REFERENCES partners (id) ON DELETE CASCADE,
  hostname         text NOT NULL
                     CHECK (hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'),
  -- Reused-hash defence in depth (D#2607 P01 merge-round finding W2): a
  -- copycat row cannot carry the real owner's txt_token_hash. Server-side
  -- token generation (P05) is the actual fix; this index just makes a
  -- collision impossible at the data layer too, in the meantime. NULL rows
  -- (token not yet issued) are exempt -- Postgres never treats two NULLs as
  -- equal, so the partial index only constrains rows that actually carry a
  -- hash.
  txt_token_hash   text,
  txt_verified_at  timestamptz,
  vercel_state     text,
  attached_at      timestamptz,
  detached_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partner_domains_hostname_verified_uniq
  ON partner_domains (hostname) WHERE txt_verified_at IS NOT NULL;
CREATE UNIQUE INDEX partner_domains_txt_token_hash_uniq
  ON partner_domains (txt_token_hash) WHERE txt_token_hash IS NOT NULL;

-- ---------------------------------------------------------------------
-- partner_retail_prices. Plan/product vocabulary is P07's job to define
-- (same convention as 0001_core.sql leaving accounts.plan unconstrained);
-- (partner_id, product, plan) is the natural key.
-- ---------------------------------------------------------------------
CREATE TABLE partner_retail_prices (
  partner_id  uuid NOT NULL REFERENCES partners (id) ON DELETE CASCADE,
  product     text NOT NULL,
  plan        text NOT NULL,
  retail_usd  numeric(10, 2) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, product, plan)
);

-- ---------------------------------------------------------------------
-- support_grants: a customer-issued, time-boxed, read-only grant to either
-- our own support (platform) or its own reseller (partner). The 60-minute
-- cap is a CHECK, not an app-layer convention -- P01 pass/fail item 3 tests
-- that a 61-minute expiry is a constraint violation, not a validation bug
-- an app could regress.
-- ---------------------------------------------------------------------
CREATE TABLE support_grants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  grantee_kind        text NOT NULL CHECK (grantee_kind IN ('partner', 'platform')),
  grantee_partner_id  uuid REFERENCES partners (id),
  granted_by_user_id  uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  CHECK (expires_at <= created_at + interval '60 minutes'),
  CHECK (
    (grantee_kind = 'partner' AND grantee_partner_id IS NOT NULL)
    OR (grantee_kind = 'platform' AND grantee_partner_id IS NULL)
  )
);

-- A grant to "its own partner" must actually be the account's own reseller
-- -- not an arbitrary partner the customer typed in. P08 (support-access
-- UI, no migration of its own) depends on this already being true.
CREATE FUNCTION support_grants_partner_must_own_account()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.grantee_kind = 'partner' THEN
    IF NOT EXISTS (
      SELECT 1 FROM accounts WHERE id = NEW.account_id AND partner_id = NEW.grantee_partner_id
    ) THEN
      RAISE EXCEPTION 'support_grants: grantee_partner_id must be the account''s own partner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER support_grants_partner_must_own_account
  BEFORE INSERT OR UPDATE ON support_grants
  FOR EACH ROW EXECUTE FUNCTION support_grants_partner_must_own_account();

-- created_at must be server time, not whatever the tenant's INSERT/UPDATE
-- supplies -- a forward-dated created_at lets the 60-minute CHECK above
-- authorize an expires_at years in the future (D#2607 P01 fix-round
-- finding 1: "the 60-minute cap is bypassable"). Originally scoped on
-- `current_user = 'app_user'`, which missed any LOGIN role that merely
-- inherits app_user's grants (D#2607 P01 fix-round finding 2: a
-- `tenant_svc` member role reproduced the full round-1 bypass, because
-- `current_user` for such a role is never literally `'app_user'`). Now
-- exempts the PRIVILEGED side instead of naming the tenant side, so every
-- role that is not a member of platform_ops is guarded, regardless of what
-- it is called or how many roles it inherits through:
CREATE FUNCTION support_grants_created_at_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT pg_has_role(current_user, 'platform_ops', 'USAGE') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.created_at := now();
    ELSIF TG_OP = 'UPDATE' AND NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'support_grants: created_at is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER support_grants_created_at_guard
  BEFORE INSERT OR UPDATE ON support_grants
  FOR EACH ROW EXECUTE FUNCTION support_grants_created_at_guard();

-- ---------------------------------------------------------------------
-- support_access_log: append-only. Per the Spec table description, no role
-- gets an UPDATE or DELETE grant on this table at all -- not even
-- platform_ops (see the GRANT block below, which simply never mentions
-- either verb for this table).
-- ---------------------------------------------------------------------
CREATE TABLE support_access_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id       uuid NOT NULL REFERENCES support_grants (id),
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  actor_user_id  uuid NOT NULL REFERENCES users (id),
  path           text NOT NULL,
  at             timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- partner_escalations: a partner asking our support (tier 2) for help with
-- one of its own customers. Grants us no data access on its own (P04 item
-- 7) -- it is just a message row.
-- ---------------------------------------------------------------------
CREATE TABLE partner_escalations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  uuid NOT NULL REFERENCES partners (id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  subject     text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- partner_audit_log: the partner-side counterpart of 0001_core.sql's
-- audit_log, same append-only philosophy (platform_ops gets SELECT and
-- INSERT, never UPDATE or DELETE -- see the GRANT block).
-- ---------------------------------------------------------------------
CREATE TABLE partner_audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  uuid NOT NULL REFERENCES partners (id) ON DELETE CASCADE,
  actor       text,
  action      text NOT NULL,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_partner_members_partner_id ON partner_members (partner_id);
CREATE INDEX idx_partner_domains_partner_id ON partner_domains (partner_id);
CREATE INDEX idx_support_grants_account_id ON support_grants (account_id);
CREATE INDEX idx_support_access_log_account_id ON support_access_log (account_id);
CREATE INDEX idx_partner_escalations_partner_id ON partner_escalations (partner_id);
CREATE INDEX idx_partner_audit_log_partner_id ON partner_audit_log (partner_id);

-- ---------------------------------------------------------------------
-- accounts_partner_kind_check: accounts.partner_id must be a reseller,
-- accounts.referred_by_partner_id must be an affiliate (pass/fail item 7).
-- A plain CHECK can't do a cross-table lookup, hence a trigger. app_user
-- already has no INSERT/UPDATE privilege on either column (0001_core.sql
-- grants app_user SELECT-only on accounts), so this only ever runs for
-- platform_ops's own writes -- but it's the schema's job to make an
-- impossible state impossible regardless of which role could reach it.
-- ---------------------------------------------------------------------
CREATE FUNCTION accounts_partner_kind_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.partner_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM partners WHERE id = NEW.partner_id AND kind = 'reseller') THEN
      RAISE EXCEPTION 'accounts.partner_id must reference a reseller partner';
    END IF;
  END IF;
  IF NEW.referred_by_partner_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM partners WHERE id = NEW.referred_by_partner_id AND kind = 'affiliate') THEN
      RAISE EXCEPTION 'accounts.referred_by_partner_id must reference an affiliate partner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounts_partner_kind_check
  BEFORE INSERT OR UPDATE OF partner_id, referred_by_partner_id ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_partner_kind_check();

-- ---------------------------------------------------------------------
-- partner_user role. NOBYPASSRLS, owns no tables -- every row it can touch
-- is reached through an explicit policy below, same discipline as
-- app_user/platform_ops in 0001_core.sql.
--
-- Neon/hosted owner shape (D#81): same pattern as app_user/platform_ops in
-- 0001_core.sql -- state the hardened attributes on CREATE (a non-superuser
-- migration role can't ALTER ... NOSUPERUSER at all), ALTER only when it
-- can succeed (current_user is a superuser), and always assert afterwards
-- that none of the hardened attributes are still set.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_user') THEN
    CREATE ROLE partner_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE partner_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
DECLARE
  r    record;
  bad  text[] := '{}';
BEGIN
  SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO r
    FROM pg_roles WHERE rolname = 'partner_user';
  IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
  IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
  IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
  IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
  IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'role partner_user still has privileged attribute(s): %', array_to_string(bad, ', ');
  END IF;
END
$$;

-- Neon/hosted owner shape (D#81): downgrade the migration role's INHERIT
-- TRUE membership in platform_ops (granted in 0001_core.sql, right after
-- the platform_ops role block) back to INHERIT FALSE now that
-- 0005_account_members_role_gate.sql's `CREATE OR REPLACE FUNCTION
-- has_open_invitation(...)` -- the one statement in this whole chain that
-- actually needs it -- has already run (0200 sorts after 0005 by
-- filename, so migrate.ts always applies it later). SET TRUE is left
-- alone: ALTER FUNCTION ... OWNER TO platform_ops below still needs it.
-- Re-granting with the same grantor updates the existing membership row
-- in place rather than adding a duplicate one (verified empirically), so
-- this is safe to run unconditionally alongside the same
-- superuser/ADMIN-option guards as the grant it undoes -- this keeps
-- criterion 8's pg_has_role(<migration role>, 'platform_ops', 'USAGE') =
-- false holding at the end of the chain, per database, regardless of
-- what an earlier database on the same cluster left behind.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO partner_user;
DO $$
BEGIN
  EXECUTE format('REVOKE TEMP ON DATABASE %I FROM partner_user', current_database());
END
$$;

-- ---------------------------------------------------------------------
-- RLS + grants: the partner's own tables.
-- ---------------------------------------------------------------------

-- partners itself: a partner session may read only its own row. (The
-- existing platform_ops_full_access policy from 0001_core.sql is
-- untouched; this adds a second policy for the new role.)
CREATE POLICY partner_self ON partners
  FOR SELECT TO partner_user
  USING (id = NULLIF(current_setting('app.partner_id', true), '')::uuid);
GRANT SELECT ON partners TO partner_user;

ALTER TABLE partner_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_members FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_read ON partner_members
  FOR SELECT TO partner_user
  USING (partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid);
CREATE POLICY platform_ops_full_access ON partner_members TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT ON partner_members TO partner_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_members TO platform_ops;

ALTER TABLE partner_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_branding FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_own ON partner_branding TO partner_user
  USING (partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid)
  WITH CHECK (partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid);
CREATE POLICY platform_ops_full_access ON partner_branding TO platform_ops
  USING (true) WITH CHECK (true);
-- Input columns only -- status/reviewed_by/reviewed_at stay platform_ops-only
-- (see the table comment above): self-approval is impossible because the
-- column simply isn't in partner_user's grant.
GRANT SELECT, INSERT (
  partner_id, product_name, logo_object_key, color_primary, color_accent,
  support_email, reply_to, sender_name, terms_url, privacy_url, site_credit_enabled
), UPDATE (
  product_name, logo_object_key, color_primary, color_accent,
  support_email, reply_to, sender_name, terms_url, privacy_url, site_credit_enabled
) ON partner_branding TO partner_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_branding TO platform_ops;

ALTER TABLE partner_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_domains FORCE ROW LEVEL SECURITY;
-- Partners may create unverified rows and read their own -- no UPDATE grant
-- at all, so verification (txt_verified_at), the hostname of an existing
-- (including already-verified) row, and takedown state (vercel_state,
-- attached_at, detached_at) all stay platform-only. A blanket UPDATE
-- previously let a partner self-verify a domain, repoint an already-
-- verified hostname, or clear a platform takedown (D#2607 P01 fix-round
-- finding 2). Column-scoped INSERT mirrors the partner_branding pattern
-- above: id/txt_verified_at/vercel_state/attached_at/detached_at/created_at
-- simply aren't in the grant, so self-verifying or self-attaching at
-- creation time isn't possible either.
CREATE POLICY partner_read ON partner_domains
  FOR SELECT TO partner_user
  USING (partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid);
CREATE POLICY partner_insert ON partner_domains
  FOR INSERT TO partner_user
  WITH CHECK (partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid);
-- A partner may delete only its OWN, still-unverified, still-unattached rows
-- (D#2607 P01 fix-round finding 4; merge-round finding S2 adds the
-- `attached_at IS NULL` leg). A separate FOR DELETE policy, not folded into
-- partner_read/partner_insert above, so the extra conditions apply to DELETE
-- alone -- two permissive policies for the same command OR together, so
-- combining this into a broader ALL-commands policy would have granted
-- unrestricted delete on own rows instead. Once a hostname is verified, only
-- platform_ops may remove it: deleting a verified row would silently free
-- the uniqueness slot the partial index above enforces. `attached_at` is
-- platform-only to set (see the column-scoped INSERT grant above), but
-- nothing else in this policy stopped a partner from deleting a row that
-- platform_ops had already attached (e.g. mid-verification-window takedown
-- handling) -- a partner shouldn't be able to unilaterally remove a domain
-- platform has already wired up, verified or not, so the delete requires
-- both legs.
CREATE POLICY partner_delete_unverified ON partner_domains
  FOR DELETE TO partner_user
  USING (
    partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid
    AND txt_verified_at IS NULL
    AND attached_at IS NULL
  );
CREATE POLICY platform_ops_full_access ON partner_domains TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT (
  partner_id, hostname, txt_token_hash
), DELETE ON partner_domains TO partner_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_domains TO platform_ops;

ALTER TABLE partner_retail_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_retail_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_own ON partner_retail_prices TO partner_user
  USING (partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid)
  WITH CHECK (partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid);
CREATE POLICY platform_ops_full_access ON partner_retail_prices TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON partner_retail_prices TO partner_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_retail_prices TO platform_ops;

ALTER TABLE partner_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_escalations FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_own ON partner_escalations TO partner_user
  USING (partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid)
  WITH CHECK (
    partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM accounts a
      WHERE a.id = partner_escalations.account_id AND a.partner_id = partner_escalations.partner_id
    )
  );
CREATE POLICY platform_ops_full_access ON partner_escalations TO platform_ops
  USING (true) WITH CHECK (true);
-- Column-scoped INSERT (D#2607 P01 fix-round finding 8): status and
-- created_at are no longer in partner_user's grant, so a partner cannot
-- open an escalation already marked resolved/closed, or backdate one --
-- both stay server-defaulted ('open', now()).
GRANT SELECT, INSERT (
  partner_id, account_id, subject, body
) ON partner_escalations TO partner_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_escalations TO platform_ops;

ALTER TABLE partner_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_read ON partner_audit_log
  FOR SELECT TO partner_user
  USING (partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid);
CREATE POLICY platform_ops_full_access ON partner_audit_log TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT ON partner_audit_log TO partner_user;
-- append-only for platform_ops too: no UPDATE/DELETE grant.
GRANT SELECT, INSERT ON partner_audit_log TO platform_ops;

-- D#81 fix round: re-open the CREATE window for the four ownership
-- transfers below (partner_account_visible, has_active_support_grant,
-- support_grant_matches, partner_suspend_account), each an
-- `ALTER FUNCTION ... OWNER TO platform_ops`. This file's own REVOKE
-- (below, right after the last of those four) is no longer the only place
-- in the chain that can close this window -- 0005_account_members_role_
-- gate.sql and 0008_audit_log_append_only.sql now self-bracket their OWN
-- OWNER TO statements the same way (grant, transfer, revoke), per the
-- per-file bracket rule (docs/ops/hosted-postgres.md). On an
-- already-migrated database that receives 0005 or 0008 AFTER this file
-- has already run once, CREATE would otherwise still be closed when this
-- file's own transfers run again on a database that somehow re-applies it
-- -- that can't happen (migrate.ts never re-applies a recorded filename),
-- but the same self-bracketing discipline applies here for the case that
-- DOES happen on every fresh chain: 0005 and 0008 both sort before this
-- file and now close the window themselves before it's this file's turn
-- to open it. Unconditional, matching 0001_core.sql's own original grant
-- style (line 485) -- not gated on a superuser check, since the migration
-- role can always GRANT/REVOKE this privilege regardless (proved by that
-- same original grant already running successfully as a plain statement).
GRANT CREATE ON SCHEMA public TO platform_ops;

-- ---------------------------------------------------------------------
-- support_grants / support_access_log.
-- ---------------------------------------------------------------------
ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_grants FORCE ROW LEVEL SECURITY;
-- WITH CHECK also requires granted_by_user_id to be a real account_members
-- row for this grant's account_id (D#2607 P01 fix-round finding 8): before
-- this, app_user could name ANY user id as the granter, which corrupts the
-- audit trail exactly like the (now-fixed) partner_suspend_account actor
-- did. This does not read app.user_id at all -- it checks the VALUE the
-- caller supplied against real membership, so it applies whether or not
-- withTenant was even given a userId.
CREATE POLICY tenant_isolation ON support_grants TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.account_id = support_grants.account_id
        AND m.user_id = support_grants.granted_by_user_id
    )
  );
CREATE POLICY platform_ops_full_access ON support_grants TO platform_ops
  USING (true) WITH CHECK (true);
-- No DELETE for app_user (revoke sets revoked_at; a deletable grant with no
-- trace would defeat its own audit purpose). No grant of any kind for
-- partner_user: it never reads this table directly -- see
-- has_active_support_grant() below, which is the only path a partner
-- session has into grant data at all.
GRANT SELECT, INSERT, UPDATE ON support_grants TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON support_grants TO platform_ops;

-- partner_account_visible(): SECURITY DEFINER (owned by platform_ops) so
-- the helpers and policies below can check accounts.deleted_at and current
-- ownership without partner_user needing a column grant on deleted_at --
-- item 2's grant list for accounts is EXACTLY (id, plan, status,
-- created_at, partner_id), and deleted_at is deliberately not in it. A
-- policy that referenced accounts.deleted_at directly (as invoker) would
-- need that grant to even evaluate, which is exactly what this avoids: a
-- soft-deleted account is excluded, but the exclusion check itself runs
-- with platform_ops's privileges, not partner_user's.
--
-- Reads app.partner_id from the session itself rather than taking it as a
-- parameter (D#2607 P01 fix-round finding 5): the earlier (target_account_id,
-- target_partner_id) shape let partner_user call this, and every function
-- below that used the same shape, as a cross-partner oracle -- any partner
-- id could be passed as an argument, from any partner's own session, and
-- the boolean answer leaked which OTHER partner owns a given account.
-- Deriving the partner id from the session instead means the function can
-- only ever answer for the CALLER's own partner.
CREATE FUNCTION partner_account_visible(target_account_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM accounts
    WHERE id = target_account_id
      AND partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid
      AND deleted_at IS NULL
  );
$$;
REVOKE ALL ON FUNCTION partner_account_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_account_visible(uuid) TO partner_user;
ALTER FUNCTION partner_account_visible(uuid) OWNER TO platform_ops;

-- has_active_support_grant() / support_grant_matches(): the ONLY paths
-- partner_user has into grant data. Both SECURITY DEFINER (owned by
-- platform_ops, same pattern as has_open_invitation in 0001_core.sql) so
-- partner_user needs no direct table privilege on support_grants at all --
-- narrower than granting SELECT on the table, which would let a partner
-- browse OTHER accounts' (or other partners') grant metadata even when it
-- returns no matching rows for its own query. Defined here, ahead of
-- support_access_log's own policy below, which calls the second one.
--
-- Both also now require partner_account_visible(target_account_id) --
-- i.e. that the CALLER'S partner currently owns the account, and the
-- account isn't soft-deleted (D#2607 P01 fix-round finding 3). Before
-- this, only the grant row itself was checked: if platform_ops moved the
-- account to a different partner (or soft-deleted it) while a grant was
-- still active, the ORIGINAL partner kept reading that account's
-- run_events -- and inserting support_access_log rows for it -- until the
-- grant's own expiry, up to 60 minutes later.
CREATE FUNCTION has_active_support_grant(target_account_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM support_grants g
    WHERE g.account_id = target_account_id
      AND g.grantee_kind = 'partner'
      AND g.grantee_partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid
      AND g.revoked_at IS NULL
      AND g.expires_at > now()
  )
  AND partner_account_visible(target_account_id);
$$;
REVOKE ALL ON FUNCTION has_active_support_grant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION has_active_support_grant(uuid) TO partner_user;
ALTER FUNCTION has_active_support_grant(uuid) OWNER TO platform_ops;

-- Same check as has_active_support_grant, but pinned to one specific grant
-- id -- support_access_log's INSERT records which grant authorized the
-- access, so its WITH CHECK has to confirm THAT grant is the active one,
-- not merely that some active grant exists for the (account, partner) pair.
CREATE FUNCTION support_grant_matches(target_grant_id uuid, target_account_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM support_grants g
    WHERE g.id = target_grant_id
      AND g.account_id = target_account_id
      AND g.grantee_kind = 'partner'
      AND g.grantee_partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid
      AND g.revoked_at IS NULL
      AND g.expires_at > now()
  )
  AND partner_account_visible(target_account_id);
$$;
REVOKE ALL ON FUNCTION support_grant_matches(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_grant_matches(uuid, uuid) TO partner_user;
ALTER FUNCTION support_grant_matches(uuid, uuid) OWNER TO platform_ops;

ALTER TABLE support_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_log FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_read ON support_access_log
  FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- The one policy in this migration that reads app.user_id for row
-- visibility -- and per the X-user-id amendment, it joins partner_members
-- itself rather than trusting the setting: a caller must both (a) hold a
-- partner_members row for app.partner_id matching app.user_id, and (b)
-- have an active support_grants row, for that exact grant_id, for
-- app.partner_id on this account. Setting app.user_id to a real partner
-- user's id while app.partner_id names a DIFFERENT partner fails (a): no
-- partner_members row has that (partner_id, user_id) pair. Neither
-- condition needs a direct table privilege on support_grants -- both go
-- through support_grant_matches(), a SECURITY DEFINER function, same
-- reasoning as run_events' policy below.
CREATE POLICY partner_grant_insert ON support_access_log
  FOR INSERT TO partner_user
  WITH CHECK (
    actor_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM partner_members pm
      WHERE pm.partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid
        AND pm.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
    AND support_grant_matches(grant_id, account_id)
  );
CREATE POLICY platform_ops_full_access ON support_access_log TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT ON support_access_log TO app_user;
GRANT INSERT ON support_access_log TO partner_user;
-- append-only, no exceptions: not even platform_ops gets UPDATE or DELETE.
GRANT SELECT, INSERT ON support_access_log TO platform_ops;

-- ---------------------------------------------------------------------
-- partner_suspend_account(): SECURITY DEFINER so it can update accounts
-- (partner_user has no direct UPDATE grant there) while still enforcing,
-- itself, that the caller's app.partner_id owns the target account.
-- Cross-partner attempts change 0 rows and still write a
-- partner_audit_log row recording the refusal (pass/fail item 8).
--
-- Requires an owner/admin partner_members row for (caller_partner_id,
-- caller_user_id) before touching anything (D#2607 P01 fix-round finding
-- 1): previously app.user_id was written straight into audit_log and
-- partner_audit_log as the actor with no check at all -- any partner_user
-- session could set app.user_id to an arbitrary (including another
-- partner's) user id and it would be recorded, verbatim, as who suspended
-- the customer's account. An unauthorized caller now changes NOTHING --
-- not even a refusal row, since the refusal row would itself carry the
-- unverified actor -- and the function raises instead.
-- ---------------------------------------------------------------------
CREATE FUNCTION partner_suspend_account(target_account_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_partner_id uuid := NULLIF(current_setting('app.partner_id', true), '')::uuid;
  caller_user_id     uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  is_admin_member    boolean;
  owns               boolean;
BEGIN
  IF caller_partner_id IS NULL THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM partner_members
    WHERE partner_id = caller_partner_id
      AND user_id = caller_user_id
      AND role IN ('owner', 'admin')
  ) INTO is_admin_member;

  IF NOT is_admin_member THEN
    RAISE EXCEPTION 'partner_suspend_account: caller is not an owner/admin member of partner %', caller_partner_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM accounts WHERE id = target_account_id AND partner_id = caller_partner_id
  ) INTO owns;

  IF owns THEN
    UPDATE accounts SET status = 'paused', updated_at = now() WHERE id = target_account_id;
    INSERT INTO audit_log (account_id, actor, action, payload)
    VALUES (target_account_id, caller_user_id::text, 'partner_suspend',
            jsonb_build_object('partner_id', caller_partner_id));
    INSERT INTO partner_audit_log (partner_id, actor, action, payload)
    VALUES (caller_partner_id, caller_user_id::text, 'suspend_account',
            jsonb_build_object('account_id', target_account_id));
  ELSE
    INSERT INTO partner_audit_log (partner_id, actor, action, payload)
    VALUES (caller_partner_id, caller_user_id::text, 'suspend_account_refused',
            jsonb_build_object('account_id', target_account_id));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION partner_suspend_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_suspend_account(uuid) TO partner_user;
ALTER FUNCTION partner_suspend_account(uuid) OWNER TO platform_ops;

-- D#81 fix round (security review MUST-FIX, CWE-427/CWE-269): close the
-- ownership-transfer window opened in 0001_core.sql
-- (GRANT USAGE, CREATE ON SCHEMA public TO platform_ops -- needed so
-- ALTER FUNCTION ... OWNER TO platform_ops could succeed as a
-- non-superuser). Left open, platform_ops -- a REAL runtime credential
-- (the billing/lifecycle connection), not just a migration-time membership
-- -- could CREATE a same-named function in public that Postgres's
-- unknown-literal overload rules pick over a pg_catalog built-in for any
-- unpinned invoker-rights caller. Verified by the reviewer against
-- model_connections_guard_write() (0003_spend_security_fixes.sql, not
-- editable here -- see 0601's own migration for the search_path pin
-- defense-in-depth): a shadowed `public.pg_has_role(name, text, text)` let
-- a tenant self-validate its own model_connections row, and let an
-- ordinary INSERT escalate platform_ops to BYPASSRLS. CREATE on a schema
-- is also checked for CREATE OR REPLACE, not just fresh CREATE, so the
-- same open window let platform_ops rewrite its own SECURITY DEFINER
-- functions (partner_account_visible, current_member_role,
-- has_open_invitation, and after merge audit_write/audit_write_system) --
-- a backdoor there survives a platform_ops password rotation.
--
-- Placement: this must run AFTER THE LAST `OWNER TO platform_ops` in the
-- whole 0001-0200 chain, not merely "next to" the INHERIT downgrade a few
-- hundred lines up (0200_partners.sql:415) -- FOUR more ownership
-- transfers (partner_account_visible, has_active_support_grant,
-- support_grant_matches, partner_suspend_account, immediately above) all
-- run AFTER that INHERIT block and all independently need platform_ops to
-- still hold CREATE on public at the moment each one runs (Postgres
-- requires the NEW owner to independently have CREATE on the object's
-- schema -- see the same comment in 0001_core.sql). Revoking any earlier
-- would break every one of those four. This is the true end of the
-- window: the statement immediately above is the last ownership transfer
-- in this file, and 0200 is the last migration in the chain that performs
-- one at all.
--
-- End state (matches main): platform_ops keeps USAGE only on public.
-- Ownership survives the revoke -- REVOKE on the SCHEMA privilege doesn't
-- touch object ownership -- so every definer function above stays owned
-- by platform_ops and app_user/partner_user can still EXECUTE them.
--
-- Per-file bracket rule for LATER migrations (docs/ops/hosted-postgres.md):
-- on an already-migrated database, filename/lexical order is NOT applied
-- order -- a database that already has this chain applied receives every
-- migration after this one, one at a time, as each merges. Any such
-- migration that creates or replaces a platform_ops-owned object cannot
-- rely on a window this file opened; it must GRANT CREATE (and INHERIT/SET
-- as needed) for itself, do the work, and REVOKE both again, all within
-- its own file.
REVOKE CREATE ON SCHEMA public FROM platform_ops;

-- The function (owned by platform_ops) writes audit_log and
-- partner_audit_log itself -- platform_ops needs its own INSERT grant AND
-- policy on both regardless of who calls the function. audit_log's
-- existing platform_ops policy (0001_core.sql) is `platform_ops_read_access
-- ... FOR SELECT` -- read-only, since nothing before D#2607 ever needed
-- platform_ops to write it. This adds exactly the INSERT grant and policy
-- partner_suspend_account needs, without touching the existing SELECT one.
GRANT INSERT ON audit_log TO platform_ops;
CREATE POLICY platform_ops_insert_access ON audit_log
  FOR INSERT TO platform_ops
  WITH CHECK (true);

-- ---------------------------------------------------------------------
-- Column-limited reads of customer data (pass/fail item 2). Every column
-- list below is exact -- see the divergence note at the top of this file
-- for the two spots where the frozen Spec text named a column that does
-- not exist in the merged schema.
-- ---------------------------------------------------------------------
CREATE POLICY partner_read ON accounts
  FOR SELECT TO partner_user
  USING (
    partner_account_visible(id)
  );
GRANT SELECT (id, plan, status, created_at, partner_id) ON accounts TO partner_user;

CREATE POLICY partner_read ON account_members
  FOR SELECT TO partner_user
  USING (
    partner_account_visible(account_id)
  );
GRANT SELECT (account_id, user_id, role) ON account_members TO partner_user;

CREATE POLICY partner_read ON users
  FOR SELECT TO partner_user
  USING (
    EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.user_id = users.id
        AND partner_account_visible(m.account_id)
    )
  );
GRANT SELECT (id, email) ON users TO partner_user;

CREATE POLICY partner_read ON repos
  FOR SELECT TO partner_user
  USING (
    partner_account_visible(account_id)
  );
-- gh_repo_id in place of the spec text's non-existent gh_full_name -- see
-- the divergence note at the top of this file.
GRANT SELECT (id, account_id, product, gh_repo_id) ON repos TO partner_user;

CREATE POLICY partner_read ON agent_runs
  FOR SELECT TO partner_user
  USING (
    partner_account_visible(account_id)
  );
-- No "model" column exists on agent_runs -- see the divergence note at the
-- top of this file. envelope, cc_session_id and sandbox_name are
-- deliberately absent from this list (pass/fail item 2's exclusion).
GRANT SELECT (id, account_id, role, status, usd, created_at) ON agent_runs TO partner_user;

CREATE POLICY partner_read ON ledger
  FOR SELECT TO partner_user
  USING (
    partner_account_visible(account_id)
  );
GRANT SELECT (account_id, kind, usd, created_at) ON ledger TO partner_user;

-- run_events: readable by partner_user ONLY under an active support grant
-- (pass/fail item 3). Full column set -- nothing here is excluded the way
-- agent_runs' envelope/session/sandbox columns are, and the grant is
-- meaningless without the policy gating it. has_active_support_grant()
-- itself now also re-checks current ownership and soft-delete status (see
-- its own comment above, fix-round finding 3).
CREATE POLICY partner_support_grant_read ON run_events
  FOR SELECT TO partner_user
  USING (
    has_active_support_grant(run_events.account_id)
  );
GRANT SELECT ON run_events TO partner_user;

-- No policy and no grant of any kind, for partner_user, on model_connections,
-- spend_reservations, installations or audit_log (pass/fail item 2). This is
-- silence, not code -- there is nothing to add here, which is the point.
