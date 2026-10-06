-- Core tenancy schema for hosted fulcrumaxe (D#2605 task H02).
--
-- Every table below carries `account_id` (fail-closed row-level security,
-- scoped by the `app.account_id` session setting) EXCEPT:
--   - `accounts` itself, which is keyed on `id` and scoped the same way.
--   - `users`, which is GLOBAL (a person can belong to several accounts via
--     account_members, and later to partners via partner_members -- D#2607
--     P01, not built here). RLS on `users` is a membership check via EXISTS
--     on account_members, not an account_id equality (see below).
--   - `partners` (D#2607), which is platform-wide, not per-tenant. Only the
--     `platform_ops` role has a policy on it; `app_user` gets no grants at
--     all on `partners`.
-- `schema_migrations` is bootstrapped by src/migrate.ts, not this file, and
-- is the sole named exemption from the RLS inventory check. `users` and
-- `partners` are NOT exempt from the inventory check -- they have RLS
-- enabled and forced like everything else, just with non-account_id
-- policies (see src/rlsInventory.ts and test/rls-inventory.test.ts).
--
-- Site-kit tables land in a later migration file (K04), not here.
--
-- CHECK constraints are only added for columns whose spec text gave an
-- explicit pipe-separated value list. Columns the spec named without an
-- enumerated set (accounts.plan, repos.product, work_items.state,
-- agent_runs.status, spend_reservations.state) are left as plain text so a
-- later task (H05, H09, H10, H14) can define that vocabulary without a
-- migration here.
--
-- CROSS-TENANT FOREIGN KEYS (CWE-639, security fix round 2): a plain FK
-- like `repos.installation_id REFERENCES installations (id)` only checks
-- that the id exists SOMEWHERE -- not that it belongs to the same account,
-- and FK-constraint checks run with elevated internal privilege that
-- bypasses RLS entirely. That let tenant A point a child row at tenant B's
-- parent row: the FK acted as a cross-tenant existence oracle, A could
-- collide with B's own unique constraints (blocking B's writes with no way
-- for B to see or remove the blocker), and B's cascade delete could remove
-- A's rows. Every parent table that's referenced this way now carries
-- `UNIQUE (account_id, id)`, and the referencing FK is composite:
-- `FOREIGN KEY (account_id, <fk>) REFERENCES parent (account_id, id)`. That
-- forces the child's account_id to match the parent's, so a cross-tenant
-- reference fails at the constraint level regardless of RLS. Nullable
-- SET NULL FKs use the Postgres 15+ column-list form,
-- `ON DELETE SET NULL (<fk>)`, so only the FK column is nulled when the
-- parent disappears -- the un-qualified form would null every column in
-- the FK, including account_id, which would then violate account_id's own
-- NOT NULL constraint instead of cleanly detaching the reference.
--
-- account_members.user_id -> users(id) is deliberately NOT composite: users
-- is global (see above), so there is no second "account_id" on the users
-- side to match against. A tenant naming any real user id in a new
-- account_members row is fine -- users holds only identity (email, name,
-- github id), no tenant data, and RLS on users independently hides a user
-- row from anyone not sharing an account with them (see below). What the
-- composite fix protects elsewhere is tenant DATA (repos, runs, spend,
-- ...); a global identity id is not tenant data.

-- Postgres 13+ ships gen_random_uuid() in core; no extension needed.
-- The composite ON DELETE SET NULL (col) form used below needs Postgres 15+.

-- Neon/hosted owner shape (D#81): production's migration role is never a
-- superuser -- Neon's connection owner gets only CREATEROLE + BYPASSRLS --
-- so this checks database ownership before anything else. Without it, a
-- non-owner, non-superuser role would instead abort deep inside the role
-- or GRANT statements below with an unrelated "permission denied for
-- schema public", which is much harder to diagnose. A superuser is exempt:
-- it can do everything below regardless of who owns the database, which is
-- what every existing test cluster (ephemeral-pg, CI) still does today.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
     AND (SELECT datdba FROM pg_database WHERE datname = current_database())
         <> current_user::regrole::oid
  THEN
    RAISE EXCEPTION 'the migration role must own the database';
  END IF;
END
$$;

CREATE TABLE partners (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('reseller', 'affiliate')),
  -- 'pending' is a reseller application awaiting approval (D#2607 X1).
  status      text NOT NULL CHECK (status IN ('pending', 'active', 'suspended')),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_customer_id      text,
  plan                    text NOT NULL DEFAULT 'starter',
  status                  text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'past_due', 'paused', 'model_key_broken')),
  model_budget_usd_month  numeric(10, 2) NOT NULL DEFAULT 0,
  compute_cap_usd_month   numeric(10, 2) NOT NULL DEFAULT 0,
  -- D#2607 partner hook. partner_id is the reseller that owns this account;
  -- referred_by_partner_id is the affiliate that referred it. An account is
  -- never both -- reseller-owned accounts aren't separately affiliate-
  -- attributed. app_user can write neither column (see the accounts GRANT
  -- below); only platform_ops can set them.
  partner_id              uuid REFERENCES partners (id),
  referred_by_partner_id  uuid REFERENCES partners (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- Soft delete (security fix round 4, Team Lead decision): "deleting" an
  -- account means setting this, never removing the row. A tenant must not
  -- be able to erase the record of what it spent or what it did, and
  -- neither should a support action taken on its behalf -- so nobody gets
  -- a real DELETE on accounts in normal operation (see the GRANTs below;
  -- app_user never had it, platform_ops loses it here too). Every child
  -- table's ON DELETE CASCADE is left exactly as it is -- it simply never
  -- fires under normal operation, since nothing ever deletes the parent
  -- row. If a hard delete is ever genuinely required (a legal erasure
  -- request), that is a manual DBA action run directly against the
  -- database outside any application role's grants -- deliberately not a
  -- code path this schema or any app role provides.
  deleted_at              timestamptz,
  CHECK (partner_id IS NULL OR referred_by_partner_id IS NULL)
);

CREATE TABLE model_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  provider           text NOT NULL CHECK (provider IN ('ai_gateway', 'anthropic')),
  -- The customer's key is never stored as plaintext: only ciphertext, its
  -- nonce, and the wrapped per-connection data key. See test/model-connections-schema.test.ts.
  key_ciphertext     bytea NOT NULL,
  key_nonce          bytea NOT NULL,
  wrapped_dek        bytea NOT NULL,
  kek_version        integer NOT NULL,
  key_fingerprint    text NOT NULL,
  status             text NOT NULL DEFAULT 'unvalidated'
                        CHECK (status IN ('unvalidated', 'ok', 'broken')),
  last_validated_at  timestamptz,
  last_error_code    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Global identity. NOT account-scoped: see the file header and the users
-- RLS policies below. email is NOT NULL UNIQUE (D#2607 X1): it's the one
-- thing that identifies the same person across sign-ins/accounts.
-- github_user_id is UNIQUE too (security fix round 3 warning 1): nullable
-- (not every sign-in method is GitHub), but two rows must never share one
-- real GitHub account. Defense in depth once identity creation moves to
-- platform_ops below -- a single buggy or malicious platform_ops caller
-- could otherwise still create a duplicate.
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_user_id  bigint UNIQUE,
  email           text NOT NULL UNIQUE,
  name            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Deliberately a plain (non-composite) FK -- users is global. See the file header.
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id)
);

-- NEW TABLE (security fix round 3, item c): the trusted path for adding an
-- EXISTING user to an account. Without this, account_members' INSERT policy
-- had nothing to gate on except account_id -- any tenant could name any
-- real user id it could guess/enumerate and add that stranger to its own
-- account (see the account_members RLS section below for the exploit this
-- closes). An invitation is always keyed on the invitee's EMAIL, never a
-- user id: the inviter cannot possibly know a stranger's internal uuid,
-- but inviting-by-email is the only thing a legitimate "add a teammate"
-- flow ever needed anyway. token_hash is a hash of an out-of-band
-- (emailed) acceptance token -- never the raw token -- for H06's actual
-- accept-invite flow; the DB-level policy below only checks
-- email/role/expiry/acceptance, not the token (verifying the token is an
-- application-layer step that happens before this INSERT is ever issued).
--
-- Round 5 suggestion 2: the DB never CONSUMES an invitation on its own --
-- nothing here sets accepted_at. H06 MUST set accepted_at = now() in the
-- SAME transaction as the account_members INSERT it gates, or two real
-- gaps follow from an app_user grant this table already has to have for
-- ordinary tenant use: (1) the same invitation can be replayed to re-add
-- a member after they've been removed (accepted_at IS NULL forever, so
-- has_open_invitation() keeps saying yes), and (2) a tenant holding its
-- own not-yet-accepted invitation can UPDATE expires_at forward
-- indefinitely, since app_user has ordinary UPDATE on its own tenant
-- table. Neither is a database-level fix -- consuming the invitation is
-- inherently a "the join and the accept happen together" property, and
-- extending expires_at on your OWN not-yet-used invitation is normal
-- tenant self-service, not a cross-tenant issue -- so both stay H06's job
-- to get right, documented here rather than half-fixed in SQL.
CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  email        text NOT NULL,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  token_hash   text NOT NULL UNIQUE,
  -- Plain FK, same reasoning as account_members.user_id: users is global.
  invited_by   uuid REFERENCES users (id),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE installations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  gh_installation_id  bigint NOT NULL,
  app_kind            text NOT NULL CHECK (app_kind IN ('team', 'sitekit')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

CREATE TABLE repos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  installation_id  uuid,
  gh_repo_id       bigint NOT NULL,
  product          text NOT NULL,
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, installation_id) REFERENCES installations (account_id, id)
    ON DELETE SET NULL (installation_id)
);

CREATE TABLE role_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id     uuid NOT NULL,
  role        text NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('off', 'weekly', 'feature_critical', 'always')),
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id, role),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);

CREATE TABLE work_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id     uuid,
  kind        text,
  gh_number   bigint,
  state       text,
  provenance  text NOT NULL CHECK (provenance IN ('trusted', 'external')),
  wf_run_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE SET NULL (repo_id)
);

CREATE TABLE agent_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id   uuid,
  role           text NOT NULL,
  runtime        text NOT NULL CHECK (runtime IN ('local', 'production')),
  sandbox_name   text,
  cc_session_id  text,
  parent_run_id  uuid,
  status         text NOT NULL,
  envelope       jsonb,
  tokens_in      bigint,
  tokens_out     bigint,
  usd            numeric(10, 4),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id)
    ON DELETE SET NULL (work_item_id),
  FOREIGN KEY (account_id, parent_run_id) REFERENCES agent_runs (account_id, id)
    ON DELETE SET NULL (parent_run_id)
);

CREATE TABLE run_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  run_id      uuid NOT NULL,
  seq         bigint NOT NULL,
  kind        text NOT NULL,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE
);

CREATE TABLE spend_reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  run_id        uuid,
  usd_reserved  numeric(10, 4) NOT NULL,
  state         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE
);

CREATE TABLE ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('model', 'compute')),
  source      text NOT NULL
                CHECK (source IN ('customer_gateway', 'customer_anthropic', 'sandbox', 'workflow')),
  usd         numeric(10, 4) NOT NULL,
  run_id      uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (run_id)
);

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  actor       text,
  action      text NOT NULL,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Basic per-tenant lookup indexes (every tenant table is always filtered by
-- account_id via RLS, so every table benefits from this index). The
-- UNIQUE (account_id, id) constraints added above already index
-- installations/repos/work_items/agent_runs on that leading column, so
-- they don't need a separate one here.
CREATE INDEX idx_model_connections_account_id ON model_connections (account_id);
CREATE INDEX idx_account_members_account_id ON account_members (account_id);
CREATE INDEX idx_invitations_account_id ON invitations (account_id);
CREATE INDEX idx_role_settings_account_id ON role_settings (account_id);
CREATE INDEX idx_run_events_account_id ON run_events (account_id);
CREATE INDEX idx_spend_reservations_account_id ON spend_reservations (account_id);
CREATE INDEX idx_ledger_account_id ON ledger (account_id);
CREATE INDEX idx_audit_log_account_id ON audit_log (account_id);

-- app_user is the role every tenant-scoped application connection uses. It
-- owns nothing and never bypasses RLS. The IF NOT EXISTS guard makes CREATE
-- idempotent across re-runs (e.g. a shared dev database), but a role that
-- already existed from an earlier run never had its attributes touched by
-- that guard -- so every run, not just the CREATE, applies them explicitly.
--
-- Neon/hosted owner shape (D#81): changing the SUPERUSER attribute (even
-- to turn it OFF) itself requires superuser, so a non-superuser migration
-- role cannot run the unconditional ALTER ROLE this used to be. The CREATE
-- now states every hardened attribute directly, so a role created fresh by
-- a non-superuser is already correct; the ALTER only runs when it can
-- succeed (current_user is a superuser), covering the case where app_user
-- pre-existed with drifted attributes (D#2605, app-user.test.ts:48-100);
-- and a final assertion, unconditional either way, fails loudly instead of
-- silently if any hardened attribute is still set afterwards.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE app_user NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
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
    FROM pg_roles WHERE rolname = 'app_user';
  IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
  IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
  IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
  IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
  IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'role app_user still has privileged attribute(s): %', array_to_string(bad, ', ');
  END IF;
END
$$;

-- platform_ops is the privileged role billing/lifecycle code (H05, H10) use
-- for platform-wide operations app_user must never do itself: creating
-- accounts, changing their plan/status/caps, and (D#2607) managing
-- partners. It still never bypasses RLS -- it gets its own explicit,
-- unconditionally-true policies instead, scoped `TO platform_ops` so
-- app_user's tenant_isolation policies are unaffected.
--
-- Same Neon/hosted owner shape as app_user above: state the hardened
-- attributes on CREATE, ALTER only when it can succeed, assert always.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_ops') THEN
    CREATE ROLE platform_ops LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE platform_ops NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
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
    FROM pg_roles WHERE rolname = 'platform_ops';
  IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
  IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
  IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
  IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
  IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'role platform_ops still has privileged attribute(s): %', array_to_string(bad, ', ');
  END IF;
END
$$;

-- Ownership transfer, Neon/hosted owner shape (D#81): `ALTER FUNCTION ...
-- OWNER TO platform_ops` below needs current_user to be able to `SET ROLE
-- platform_ops` (Postgres 16+). A CREATEROLE role that just created
-- platform_ops gets only ADMIN OPTION on it (INHERIT FALSE, SET FALSE), so
-- grant SET explicitly. This also grants INHERIT TRUE, not FALSE, for one
-- specific reason: 0005_account_members_role_gate.sql (an already-applied
-- migration, out of scope to edit here) does
-- `CREATE OR REPLACE FUNCTION has_open_invitation(...)` on the function
-- this file transfers to platform_ops a few statements below -- REPLACE,
-- unlike a fresh CREATE, requires the executing role to already hold
-- platform_ops's privileges "with inherit" (has_privs_of_role), and plain
-- SET-only membership does not satisfy that (verified empirically: it
-- fails with "must be owner of function has_open_invitation"). INHERIT
-- TRUE is downgraded back to FALSE in 0200_partners.sql, which runs after
-- 0005 in filename order -- so criterion 8's
-- pg_has_role(<migration role>, 'platform_ops', 'USAGE') = false holds at
-- the end of the chain, exactly as before, while the window it's TRUE
-- covers only 0002-0100 (nothing else in that range touches a
-- platform_ops-owned object it doesn't also create+transfer itself in the
-- same file, which only ever needed SET). This is not an escalation
-- beyond that window: the migration role already owns every table and has
-- BYPASSRLS, so it is strictly more powerful than platform_ops throughout.
-- Unconditionally re-asserted (not skipped when already granted) because
-- role membership is cluster-wide but this window is per-database: a
-- second database on the same cluster runs its OWN 0001-through-0200
-- chain, and needs its OWN INHERIT-TRUE-then-FALSE cycle regardless of
-- what an earlier database's chain left behind. Skipped only when
-- current_user is a superuser (ALTER FUNCTION OWNER TO and REPLACE both
-- always work for a superuser). If current_user has no ADMIN option on
-- platform_ops (the role was pre-created by someone else), the GRANT
-- itself cannot succeed, so this fails loudly and names the missing
-- prerequisite instead of letting a later statement fail with an
-- unrelated error.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'platform_ops'::regrole
        AND m.member = current_user::regrole
        AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on platform_ops; cannot grant membership for ALTER FUNCTION ... OWNER TO platform_ops (Neon/hosted owner shape, D#81)';
    END IF;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

-- CREATE (not just USAGE) is also required on the schema for `ALTER
-- FUNCTION ... OWNER TO platform_ops` to succeed as a non-superuser --
-- Postgres requires the NEW owner to independently have CREATE on the
-- object's schema, precisely so ownership transfer can't be used to gain
-- schema access a role wasn't already granted (Neon/hosted owner shape,
-- D#81). A superuser bypasses this check entirely, which is why nothing
-- caught its absence before.
GRANT USAGE ON SCHEMA public TO app_user;
GRANT USAGE, CREATE ON SCHEMA public TO platform_ops;

-- No role except the migration owner may open a temp-table session on this
-- database. app_user has no legitimate use for one, and an explicit REVOKE
-- from PUBLIC (the implicit grantee of TEMP at database-creation time)
-- closes it for every non-superuser role, not just app_user; the second
-- REVOKE targets app_user directly too, belt-and-suspenders, in case it was
-- ever granted TEMP some other way. current_database() keeps this portable
-- across whatever database name the caller connected to.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMP ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMP ON DATABASE %I FROM app_user', current_database());
END
$$;

-- Neon/hosted owner shape (D#81): the REVOKE above only takes effect if
-- current_user owns the database -- otherwise Postgres just issues a
-- WARNING and changes nothing, which the earlier ownership assertion at
-- the top of this file should already have caught. This is defense in
-- depth: assert that it actually took, unconditionally, rather than trust
-- the WARNING path was unreachable. app_user has no direct grant of its
-- own, so this reflects whatever PUBLIC still holds.
DO $$
BEGIN
  IF has_database_privilege('app_user', current_database(), 'TEMP') THEN
    RAISE EXCEPTION 'app_user still has TEMP privilege on the database';
  END IF;
END
$$;

-- Row-level security. `current_setting('app.account_id', true)` returns NULL
-- (rather than raising) the first time a session reads a custom GUC it has
-- never touched -- but once ANY transaction on that same backend has done
-- `SET LOCAL app.account_id`, Postgres keeps a session-level placeholder for
-- it that resets to '' (empty string), not NULL, once the transaction ends.
-- Connection pooling means later callers on that same physical connection
-- see '' rather than NULL for "unset". Casting '' straight to uuid raises an
-- error instead of failing closed, so every policy below runs the value
-- through NULLIF(..., '') first: NULL either way, and `NULL = account_id`
-- is never true, so an unset session matches no rows on every table.
-- account_is_active(): the single place every tenant-scoped policy below
-- checks whether the account behind a row has been soft-deleted (security
-- fix round 4). Deliberately a PLAIN sql function, not SECURITY DEFINER --
-- unlike has_open_invitation() below, this never needs to see past
-- the calling role's own visibility: app_user calling it is always
-- checking its OWN current account (the outer account_id = app.account_id
-- clause already guarantees that), which app_user's own accounts SELECT
-- policy already lets it see when active. Running as the caller means
-- platform_ops's UNRESTRICTED accounts policy (below) is what this
-- function sees when platform_ops calls it -- not that platform_ops
-- actually needs to, since none of platform_ops's own policies call it at
-- all (platform_ops must keep seeing soft-deleted accounts' data for
-- billing/audit, so its policies stay unconditionally `USING (true)`).
--
-- Deliberately no `SET search_path`: that would make Postgres treat the
-- function as not-inlinable, forcing a real per-row function call instead
-- of letting the planner fold this EXISTS into the outer query (security
-- fix round 5 suggestion 1). Schema-qualifying `public.accounts` directly
-- gets the same "don't trust the caller's search_path" property without
-- that cost -- see the round-5 performance note on every call site below.
--
-- PERFORMANCE (security fix round 5 WARNING): every call site below reads
-- `(SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))`
-- -- the session setting, wrapped in a scalar subquery -- rather than the
-- more obvious `account_is_active(account_id)` on the row's own column.
-- Both check the same thing: the row's own account_id equality clause
-- (right next to this one, in every policy) already pins account_id to
-- that same session setting, so checking either is equivalent by the time
-- both conjuncts have to hold. But a call on the ROW's column varies per
-- row, so Postgres must invoke the function -- and re-run its internal
-- accounts lookup -- once per row scanned. A call on the SESSION SETTING
-- is the same value for every row in the query, so the planner can fold
-- it into a single once-per-query InitPlan instead. Measured by the
-- reviewer on 20,001 rows: 60ms / 40,189 buffer hits with the per-row
-- form, 2.4ms / 206 buffer hits with the InitPlan form -- roughly 25x,
-- and the per-row cost scales with the TENANT'S OWN row count, so an
-- unfixed version would have let any tenant self-inflict (and bill
-- everyone else sharing the database for) a slower query just by growing
-- their own data.
CREATE FUNCTION account_is_active(target_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts WHERE id = target_account_id AND deleted_at IS NULL
  );
$$;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
-- app_user's own policy excludes a soft-deleted account directly (deleted_at
-- IS NULL) rather than calling account_is_active(id) on itself -- simpler
-- than a self-referential EXISTS, and avoids any doubt about a function
-- call recursing into the policy of the very table it's defined against.
CREATE POLICY tenant_isolation ON accounts TO app_user
  USING (
    id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND deleted_at IS NULL
  )
  WITH CHECK (
    id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND deleted_at IS NULL
  );
-- platform_ops's policy stays unconditional: it must keep seeing (and, for
-- soft-delete itself, keep writing) a soft-deleted account's row.
CREATE POLICY platform_ops_full_access ON accounts TO platform_ops
  USING (true) WITH CHECK (true);
-- No INSERT: creating an account is a billing-owned action (platform_ops).
-- No UPDATE: accounts has no column a customer is allowed to self-serve
-- change today (stripe_customer_id, plan, status and both caps are all
-- billing/lifecycle-owned, and partner_id/referred_by_partner_id are
-- platform_ops-only per D#2607). If a customer-editable column (e.g. a
-- display name) is added later, grant UPDATE on that column specifically --
-- never a blanket UPDATE.
-- No DELETE for app_user, and none for platform_ops either (security fix
-- round 4): "deleting" an account is UPDATE deleted_at = now() through
-- platform_ops's own UPDATE grant below, never a real DELETE -- see the
-- deleted_at column comment above for why (ledger/audit_log must outlive
-- the account regardless of who closes it, including a platform_ops/H10
-- support action). A genuine hard delete is a manual DBA action outside
-- every application role's grants, not something this schema provides a
-- path for.
GRANT SELECT ON accounts TO app_user;
GRANT SELECT, INSERT, UPDATE ON accounts TO platform_ops;

-- D#2607 partner hook. Platform-wide, not per-tenant: only platform_ops has
-- a policy or any grant here. app_user gets nothing on this table at all.
ALTER TABLE partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_ops_full_access ON partners TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON partners TO platform_ops;

ALTER TABLE model_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON model_connections TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- Round-7 grants audit / round-8 decision 5: UPDATE and DELETE left as
-- they are. H21 plausibly needs both (revalidating a key updates
-- status/last_validated_at; "delete removes the ciphertext and the
-- wrapped data key" is H21's own spec text) -- H21 owns confirming or
-- tightening this.
GRANT SELECT, INSERT, UPDATE, DELETE ON model_connections TO app_user;

-- users is global (see the file header): the SELECT policy is membership in
-- the CURRENT account, via EXISTS on account_members, not an account_id
-- equality -- there is no account_id column on this table to compare.
--
-- Security fix round 3 (ERROR: identity takeover through membership):
-- app_user used to also get INSERT/UPDATE/DELETE here (an open INSERT so a
-- brand-new identity could be created, and membership-gated UPDATE/DELETE
-- for "editing your own profile"). The reviewer found that combination
-- exploitable: because account_members' own INSERT policy only checked
-- account_id (see below), and the FK from account_members.user_id to
-- users(id) is checked with elevated privilege that bypasses RLS
-- entirely, a tenant that merely knew (or guessed/enumerated) ANY real
-- user uuid could add that stranger to its own account via
-- account_members, and from that moment the membership-gated UPDATE/DELETE
-- policies here treated the attacker as a legitimate co-member -- able to
-- read the victim's email/name/github_user_id, overwrite them, or delete
-- their user row outright (which cascade-deleted the victim's OWN
-- account_members row in their REAL account, locking them out of it).
--
-- Fix: app_user keeps ONLY membership-gated SELECT. Identity lifecycle
-- (create/update/delete a user) is platform_ops-only (H06 signs people
-- in) -- see the GRANT below and platform_ops_full_access. Closing the
-- account_members half of this (gating who can be added at all) is the
-- invitations table and account_members's own INSERT policy, further down.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
-- Security fix round 7 suggestion 1: also check account_is_active, like
-- every other tenant-scoped policy does -- member_visible was the one
-- policy in the file that didn't. Low risk on its own (a soft-deleted
-- account's account_members rows are ALREADY invisible to app_user, since
-- account_members' own SELECT policy is gated the same way, so the EXISTS
-- below would already find nothing) -- this is about not leaving one
-- policy asymmetric with the rest, not a live gap the EXISTS didn't
-- already close.
CREATE POLICY member_visible ON users
  FOR SELECT TO app_user
  USING (
    (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND EXISTS (
      SELECT 1 FROM account_members m
      WHERE m.user_id = users.id
        AND m.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    )
  );
CREATE POLICY platform_ops_full_access ON users TO platform_ops
  USING (true) WITH CHECK (true);
GRANT SELECT ON users TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO platform_ops;

-- SECURITY DEFINER helper so account_members's INSERT policy (below) can
-- check for a matching invitation WITHOUT app_user needing direct
-- visibility into an arbitrary users row (which member_visible above
-- deliberately denies until they're already a member -- the exact
-- chicken-and-egg the old open INSERT policy tried to route around,
-- unsafely).
--
-- Security fix round 5 (ERROR: this used to be invitation_target_email(),
-- a SECURITY DEFINER function that RETURNED the target user's email to
-- app_user for ANY user uuid, with no tenant/invitation context of its
-- own). The reviewer's chain: a tenant calls the function directly (it
-- had EXECUTE), resolves a victim's email itself, writes a matching
-- invitations row into its OWN account using that resolved email, then
-- inserts the account_members row -- reading the victim's email, name and
-- github_user_id in one transaction, with no invitation ever having
-- existed before the attacker manufactured one to match. Returning a
-- value at all was the hole: it handed app_user exactly the piece of
-- information (the email) it wasn't supposed to be able to get to on its
-- own.
--
-- Fix: has_open_invitation() returns ONLY a boolean and does the
-- invitations-to-users join INSIDE itself, so nothing about the target
-- user (their email or anything else) ever crosses back to the caller.
-- An attacker now needs to already know BOTH a real user uuid AND that
-- user's exact email address (to have pre-written a matching invitation)
-- -- and even then, see the defense-in-depth note below.
--
-- Ownership is transferred to platform_ops, which has its own
-- unconditional policy on both `invitations` and `users`, so the lookup
-- runs with platform_ops's visibility regardless of the calling app_user
-- session's own membership state. Only app_user may call it -- a narrow,
-- single-purpose escape hatch, not a general grant, so EXECUTE is revoked
-- from PUBLIC first.
--
-- DEFENSE IN DEPTH, not the real anchor: this DB-level gate stops the
-- database from admitting a membership row with no matching invitation at
-- all, but the actual security boundary is H06 verifying an emailed,
-- single-use acceptance token (invitations.token_hash) before it ever
-- issues this INSERT. This function cannot and does not check the token
-- -- it has no way to know what the caller actually proved to the human
-- who received the invite. See suggestion 2 below on H06 also needing to
-- consume (accepted_at) the invitation in the same transaction.
--
-- Security fix round 6: `target_account_id` was taken as a bare parameter
-- and never pinned to the caller's own session, so app_user could call
-- this directly with SOME OTHER account's id and a user/role it was
-- probing for, and get back a truthful boolean -- one bit ("does that
-- OTHER account have an open invitation for this user/role") that
-- account_members' policy never needed to expose, since the policy
-- itself only ever calls this with account_id = the session's own
-- account anyway. Needs both a real user uuid and the exact role to get
-- anything out of it, but it cost nothing to close: pin
-- `i.account_id` to `app.account_id` INSIDE the function too, so a
-- cross-account call can only ever see false. Nothing legitimate
-- changes -- the policy already passes a session-pinned account_id, so
-- this is now checked twice on the path that matters and enforced on
-- every other path.
-- Security fix round 7 suggestion 2: the invitations-to-users join is on
-- lower(email) on both sides, not a raw equality. Email addresses are
-- case-insensitive by convention (and by spec for the domain part, but
-- treated as such everywhere in practice for the local part too); users
-- and invitations are populated by two DIFFERENT flows -- H06 sign-in and
-- however H12/the invite UI captures the address a tenant typed -- with
-- no guarantee either one normalizes casing before it reaches this table.
-- A raw `=` would silently block a legitimate accept whenever the two
-- differ only by case ("Alice@Example.com" invited, "alice@example.com"
-- signed in). Using `lower()` here rather than switching the columns to
-- `citext` keeps the fix scoped to the one place casing actually matters
-- (this comparison) without changing either column's stored type or
-- adding an extension.
CREATE FUNCTION has_open_invitation(target_account_id uuid, target_user_id uuid, target_role text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM invitations i
    JOIN users u ON lower(u.email) = lower(i.email)
    WHERE u.id = target_user_id
      AND i.account_id = target_account_id
      AND i.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
      AND i.role = target_role
      AND i.accepted_at IS NULL
      AND i.expires_at > now()
  );
$$;
REVOKE ALL ON FUNCTION has_open_invitation(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION has_open_invitation(uuid, uuid, text) TO app_user;
ALTER FUNCTION has_open_invitation(uuid, uuid, text) OWNER TO platform_ops;

-- Security fix round 3, item (c): account_members' INSERT used to be gated
-- ONLY on account_id (the same tenant_isolation shape every other table
-- uses) -- which is exactly the "identity takeover" hole described above.
-- Adding an EXISTING user to your account now additionally requires a
-- matching, unexpired, unaccepted invitation for THAT USER'S EMAIL, for
-- this account, for the SAME role being inserted (round 5 suggestion 3 --
-- a member invitation no longer admits an owner row) -- checked via
-- has_open_invitation(), never a user id the inserting tenant merely
-- knows or guessed. SELECT/UPDATE/DELETE stay the plain account_id check:
-- viewing, re-role-ing or removing a membership row your account already
-- owns was never the exploit, so it isn't restyled here.
ALTER TABLE account_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON account_members
  FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_isolation_update ON account_members
  FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_isolation_delete ON account_members
  FOR DELETE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY invited_only_insert ON account_members
  FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND has_open_invitation(account_id, user_id, role)
  );
CREATE POLICY platform_ops_full_access ON account_members TO platform_ops
  USING (true) WITH CHECK (true);
-- Round-7 grants audit / round-8 decision 5: UPDATE and DELETE left as
-- they are (re-role or remove a teammate is plausible ordinary team
-- management) -- H06 (tenancy/auth core) owns confirming or tightening
-- this.
GRANT SELECT, INSERT, UPDATE, DELETE ON account_members TO app_user;

-- Standard tenant table: account-scoped, app_user gets full CRUD (creating
-- and managing invitations is an ordinary tenant operation; the trust
-- boundary is who can be ADDED via one, enforced above, not who can issue
-- one).
--
-- platform_ops also needs read access here (security fix round 5): unlike
-- invitation_target_email() before it, has_open_invitation() joins
-- invitations to users INSIDE itself, and it's SECURITY DEFINER owned by
-- platform_ops -- so that join runs with platform_ops's own table
-- privileges, not the calling app_user session's. Without this,
-- has_open_invitation() would fail with "permission denied for table
-- invitations" on every call, for every tenant, unconditionally (caught
-- by this round's own test suite, not the reviewer -- see the commit
-- message).
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitations TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY platform_ops_read_access ON invitations
  FOR SELECT TO platform_ops
  USING (true);
-- Round-7 grants audit / round-8 decision 5: UPDATE and DELETE left as
-- they are. UPDATE is confirmed (H06 must set accepted_at in the same
-- transaction as the join, per the comment on this table above); DELETE
-- (canceling a pending invite) is plausible but not spec-confirmed -- H06
-- owns confirming or tightening this.
GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO app_user;
GRANT SELECT ON invitations TO platform_ops;

ALTER TABLE installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE installations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON installations TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- Round-7 grants audit / round-8 decision 5: UPDATE and DELETE left as
-- they are (plausible via H13's installation webhook lifecycle --
-- suspend/uninstall) -- H13 owns confirming or tightening this.
GRANT SELECT, INSERT, UPDATE, DELETE ON installations TO app_user;

ALTER TABLE repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE repos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON repos TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- Round-7 grants audit / round-8 decision 5: UPDATE and DELETE left as
-- they are (plausible via H13's webhook lifecycle -- settings changes,
-- repo removed from an installation) -- H13 owns confirming or
-- tightening this.
GRANT SELECT, INSERT, UPDATE, DELETE ON repos TO app_user;

ALTER TABLE role_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_settings TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- Security fix round 8 (Team Lead decision 4): kept both UPDATE and
-- DELETE, deliberately, after the round-7 audit flagged DELETE here as
-- uncertain. Deleting a role_settings row means reverting that role to
-- its default for the repo -- legitimate tenant self-service, and losing
-- the row costs nothing (it's a toggle, not a record of anything that
-- happened).
GRANT SELECT, INSERT, UPDATE, DELETE ON role_settings TO app_user;

ALTER TABLE work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_items TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- Round-7 grants audit / round-8 decision 5: UPDATE and DELETE left as
-- they are. UPDATE is confirmed (H14/H15's pipeline updates state/
-- wf_run_id as work progresses); DELETE (removing a work_item, e.g. if
-- the upstream issue is deleted) is plausible but not spec-confirmed --
-- H14/H15 own confirming or tightening this.
GRANT SELECT, INSERT, UPDATE, DELETE ON work_items TO app_user;

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_runs TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- Security fix round 8 (Team Lead decision 1, following the round-7
-- grants audit): DELETE dropped. agent_runs is the record of what an
-- agent actually did on a customer's repo, including what it cost
-- (tokens_in/tokens_out/usd) -- the same reason ledger and audit_log are
-- append-only for app_user. UPDATE stays: H09 legitimately updates
-- status, tokens and envelope as a run progresses.
GRANT SELECT, INSERT, UPDATE ON agent_runs TO app_user;

ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON run_events TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- Security fix round 8 (Team Lead decision 2): UPDATE and DELETE dropped.
-- run_events is an append-only event stream -- H11 streams it live to the
-- customer's browser -- and nothing rewrites or removes an event after
-- the fact.
GRANT SELECT, INSERT ON run_events TO app_user;

ALTER TABLE spend_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON spend_reservations TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- Security fix round 8 (Team Lead decision 3): DELETE dropped. A
-- reservation is settled or released (H05: an UPDATE-driven state
-- transition), never removed -- a deletable reservation would be a way
-- to escape a spend cap. UPDATE stays for that same settle/release
-- transition.
GRANT SELECT, INSERT, UPDATE ON spend_reservations TO app_user;

-- ledger and audit_log additionally get an unconditional, read-only
-- platform_ops policy (security fix round 4): billing (ledger) and audit
-- (audit_log) records must stay readable to platform_ops for a
-- soft-deleted account, same as accounts itself. Read-only -- writing
-- ledger/audit_log rows is app_user's job (the tenant's own runs generate
-- them); platform_ops has no need to INSERT/UPDATE/DELETE them here, so no
-- grant beyond SELECT.
--
-- Security fix round 7 (ERROR): app_user held UPDATE and DELETE on BOTH
-- tables until now -- which meant rounds 3 and 4's whole point (a tenant
-- must not be able to erase the record of what it spent or what it did,
-- and neither should a support action taken on its behalf) was only ever
-- enforced against ACCOUNT DELETION. A live tenant session could just run
-- `DELETE FROM ledger WHERE account_id = <its own id>` or rewrite a `usd`
-- value directly, with no account deletion and no RLS bypass needed --
-- RLS was never the problem here, the base GRANT was. app_user now gets
-- SELECT, INSERT only on both: nothing in the Spec needs a tenant to
-- update or delete either table (H05 settles runs by INSERTing ledger
-- rows; H12 writes audit rows on setting changes -- both are appends).
ALTER TABLE ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY platform_ops_read_access ON ledger
  FOR SELECT TO platform_ops
  USING (true);
GRANT SELECT, INSERT ON ledger TO app_user;
GRANT SELECT ON ledger TO platform_ops;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY platform_ops_read_access ON audit_log
  FOR SELECT TO platform_ops
  USING (true);
GRANT SELECT, INSERT ON audit_log TO app_user;
GRANT SELECT ON audit_log TO platform_ops;
