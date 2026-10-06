-- D#71 DS-1: Discussions and work-item store migration.
--
-- Tables: discussion_counters, discussions, discussion_revisions,
-- discussion_comments, spec_versions, spec_corrections, work_item_deps.
-- New columns: work_items.{discussion_id,parent_id,title},
-- agent_runs.spec_version_id. Plus erase_discussion_content(), a
-- SECURITY DEFINER erasure entry point callable only by platform_ops.
--
-- Numbering: origin/main now ends at 0616 (0616_api_tokens.sql, merged
-- as b05df6a). 0614 is reserved for D#2 H13c (open PR #154); 0617 is
-- taken by open PR #155. This file was renumbered to 0618
-- (re-checked against open PRs at push time -- none but #155/#154
-- touch packages/db/migrations/, and neither has taken 0618).
--
-- Provenance vocabulary: D#103's Spec (cross-note on D#71,
-- discussioncomment-18585494) settles it as 'internal'/'external', the
-- same as work_items.provenance after 0608_work_items_provenance_
-- vocabulary.sql. discussions.provenance and discussion_comments.provenance
-- both use that exact CHECK. Read either column back through
-- parseProvenance() (@fx/trust) -- this migration adds no second mapping.
--
-- D#45 S1 dependency: WORK_ITEM_STAGE_TRANSITIONS
-- (packages/core/src/work-items/stages.ts) already carries the 38-edge
-- graph corrected by D#45 Correction C1 (closed -> triaged,
-- needs_human -> discussing) -- confirmed merged before this file was
-- written. DS-1 adds no stage or edge of its own; the graph is enforced
-- in that TypeScript file only, not duplicated here. See the PR body for
-- the full 38-edge table with each edge's evidence.
--
-- ---------------------------------------------------------------------
-- Design note: erase_discussion_content and Correction C3.
--
-- The original DS-1 design owned erase_discussion_content by platform_ops
-- (D#81 bracket rule) and opened a second, GUC-gated policy
-- (platform_ops_erasure_gate) on the five content tables so that owner
-- could reach cross-tenant rows. The security review on PR #148 (head
-- e0d9791) showed live that ANY platform_ops session opens that gate with
-- one SET/set_config/PGOPTIONS value -- a SECURITY DEFINER function owned
-- by platform_ops runs with nothing platform_ops doesn't already have, so
-- no GUC-gate variant can close this off. D#71 Correction C3 (RULED
-- 2026-09-25, NOBYPASSRLS) replaces that design:
--
--   erase_discussion_content is owned by a NEW, dedicated role,
--   discussion_eraser -- NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
--   NOREPLICATION NOBYPASSRLS, a member of nothing, granted to nobody.
--   Nobody can log in as it or SET ROLE to it, so its privileges are only
--   ever exercised inside this one function's body. Each of the five
--   tables the function touches (discussions, discussion_revisions,
--   discussion_comments, spec_versions, spec_corrections) gets exactly
--   one additional policy, eraser_access, FOR ALL TO discussion_eraser
--   USING (true) WITH CHECK (true) -- reaching a row therefore requires
--   BOTH a grant (below, column-scoped to exactly what the function body
--   needs) AND this policy, both visible in pg_policies/information_schema
--   for review. platform_ops holds NO privilege and appears in NO policy
--   on any of these seven tables (criterion 16) -- it can only reach
--   Discussion content by calling the function, which is exactly the
--   "break-glass only" boundary the Spec's staff-access rule requires.
--
--   test-neon-shape.sh criterion 8 ("every SECURITY DEFINER function in
--   public is owned by platform_ops") needed a matching, narrow exception
--   for this one function+owner pair -- that is DS-0a (#151, merged
--   2026-09-25, before this rework). DS-1 itself does not touch
--   test-neon-shape.sh.
--
-- criterion 2 is amended by C3 to read: each of the 7 tables has exactly
-- one tenant_isolation policy; the five content tables also have exactly
-- one eraser_access policy TO discussion_eraser; no other policy exists,
-- and none names platform_ops or PUBLIC. See criteria 13-16 below (C3)
-- for the full erasure/privilege shape.

-- =======================================================================
-- 1. discussion_counters
-- =======================================================================
CREATE TABLE discussion_counters (
  account_id   uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  next_number  bigint NOT NULL DEFAULT 1,
  bytes_used   bigint NOT NULL DEFAULT 0
);

-- Criterion 15 (C3 S3): bytes_used/next_number can never be lowered by the
-- tenant, and an INSERT must start at the documented defaults. A PLAIN
-- (non-SECURITY-DEFINER) trigger -- it only ever reads NEW/OLD, so it needs
-- no elevated privilege and runs fine as whichever role's INSERT/UPDATE
-- fired it (app_user in practice, the only role with any grant on this
-- table). DS-2's bytes_used increment (criterion 11 there) still works:
-- raising either value always succeeds.
CREATE FUNCTION discussion_counters_monotonic() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.next_number <> 1 OR NEW.bytes_used <> 0 THEN
      RAISE EXCEPTION 'discussion_counters: initial next_number must be 1 and bytes_used must be 0 (got next_number=%, bytes_used=%)', NEW.next_number, NEW.bytes_used
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.bytes_used < OLD.bytes_used THEN
      RAISE EXCEPTION 'discussion_counters: bytes_used cannot decrease (old=%, new=%)', OLD.bytes_used, NEW.bytes_used
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.next_number < OLD.next_number THEN
      RAISE EXCEPTION 'discussion_counters: next_number cannot decrease (old=%, new=%)', OLD.next_number, NEW.next_number
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER discussion_counters_monotonic_trigger
  BEFORE INSERT OR UPDATE ON discussion_counters
  FOR EACH ROW EXECUTE FUNCTION discussion_counters_monotonic();

-- =======================================================================
-- 2. discussions
-- =======================================================================
CREATE TABLE discussions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  number              bigint NOT NULL,
  repo_id             uuid,
  kind                text NOT NULL CHECK (kind IN (
                        'feature', 'critical', 'small', 'bug', 'doc', 'process', 'review', 'other'
                      )),
  title               text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 256),
  visibility          text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'repo', 'public')),
  security            boolean NOT NULL DEFAULT false,
  root_work_item_id   uuid NOT NULL,
  -- D#103 vocabulary (see file header).
  provenance          text NOT NULL CHECK (provenance IN ('internal', 'external')),
  created_by_kind     text NOT NULL CHECK (created_by_kind IN ('user', 'agent', 'system', 'github')),
  created_by_user_id  uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  deleted_at          timestamptz,
  UNIQUE (account_id, id),
  UNIQUE (account_id, number),
  CHECK (NOT security OR visibility = 'private'),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE SET NULL (repo_id),
  FOREIGN KEY (account_id, root_work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);

-- =======================================================================
-- 3. discussion_revisions (insert-only)
-- =======================================================================
CREATE TABLE discussion_revisions (
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  discussion_id   uuid NOT NULL,
  rev             int NOT NULL CHECK (rev >= 1),
  body            text NOT NULL,
  author_kind     text NOT NULL,
  author_user_id  uuid REFERENCES users (id),
  agent_run_id    uuid,
  erased_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, discussion_id, rev),
  FOREIGN KEY (account_id, discussion_id) REFERENCES discussions (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, agent_run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (agent_run_id)
);

-- =======================================================================
-- 4. discussion_comments
-- =======================================================================
CREATE TABLE discussion_comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  discussion_id     uuid NOT NULL,
  reply_to_id       uuid,
  author_kind       text NOT NULL CHECK (author_kind IN ('user', 'agent', 'system', 'github')),
  author_user_id    uuid REFERENCES users (id),
  author_gh_login   text,
  role              text,
  agent_run_id      uuid,
  body              text NOT NULL,
  provenance        text NOT NULL CHECK (provenance IN ('internal', 'external')),
  origin            text NOT NULL CHECK (origin IN ('fx', 'github')),
  mirror            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  edited_at         timestamptz,
  deleted_at        timestamptz,
  erased_at         timestamptz,
  UNIQUE (account_id, id),
  CHECK ((author_kind = 'agent') = (agent_run_id IS NOT NULL AND role IS NOT NULL)),
  FOREIGN KEY (account_id, discussion_id) REFERENCES discussions (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, reply_to_id) REFERENCES discussion_comments (account_id, id) ON DELETE SET NULL (reply_to_id),
  FOREIGN KEY (account_id, agent_run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (agent_run_id)
);

-- =======================================================================
-- 5. spec_versions (insert-only)
-- =======================================================================
CREATE TABLE spec_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id        uuid NOT NULL,
  version             int NOT NULL CHECK (version >= 1),
  body                text NOT NULL,
  body_sha256         text NOT NULL,
  frontmatter         jsonb NOT NULL DEFAULT '{}',
  source_path         text,
  source_sha          text,
  created_by_kind     text NOT NULL,
  created_by_user_id  uuid REFERENCES users (id),
  erased_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, work_item_id, version),
  CHECK (body_sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex')),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);

-- =======================================================================
-- 6. spec_corrections (insert-only)
-- =======================================================================
CREATE TABLE spec_corrections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  spec_version_id     uuid NOT NULL,
  code                text NOT NULL CHECK (code ~ '^C[1-9][0-9]*$'),
  body                text NOT NULL,
  applies_to          uuid[] NOT NULL DEFAULT '{}',
  created_by_kind     text NOT NULL,
  created_by_user_id  uuid REFERENCES users (id),
  erased_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Code-review must-fix (PR #148 head e0d9791): every new table with an
  -- id column gets UNIQUE (account_id, id), same as discussions/
  -- discussion_comments/spec_versions above -- makes a future composite FK
  -- into this table tenant-safe by construction.
  UNIQUE (account_id, id),
  UNIQUE (account_id, spec_version_id, code),
  FOREIGN KEY (account_id, spec_version_id) REFERENCES spec_versions (account_id, id) ON DELETE CASCADE
);

-- =======================================================================
-- 7. work_item_deps
-- =======================================================================
CREATE TABLE work_item_deps (
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id   uuid NOT NULL,
  depends_on_id  uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, work_item_id, depends_on_id),
  CHECK (work_item_id <> depends_on_id),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, depends_on_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);

-- =======================================================================
-- 8. work_items and agent_runs gain columns.
-- =======================================================================
ALTER TABLE work_items ADD COLUMN discussion_id uuid;
ALTER TABLE work_items ADD COLUMN parent_id uuid;
ALTER TABLE work_items ADD COLUMN title text;
ALTER TABLE work_items
  ADD FOREIGN KEY (account_id, discussion_id) REFERENCES discussions (account_id, id) ON DELETE SET NULL (discussion_id),
  ADD FOREIGN KEY (account_id, parent_id) REFERENCES work_items (account_id, id) ON DELETE SET NULL (parent_id);

ALTER TABLE agent_runs ADD COLUMN spec_version_id uuid;
ALTER TABLE agent_runs
  ADD FOREIGN KEY (account_id, spec_version_id) REFERENCES spec_versions (account_id, id) ON DELETE SET NULL (spec_version_id);

-- =======================================================================
-- 9. discussion_eraser role (C3 item 1). Created before the RLS section
--    below so the eraser_access policies can name it. Same hardened-
--    attribute shape app_user/platform_ops/exposure_writer use (state
--    every attribute on CREATE, ALTER only when current_user can succeed,
--    then assert none remain) -- NOLOGIN instead of LOGIN, and NOBYPASSRLS
--    is load-bearing here (C3's ruling), not just hygiene: this role's
--    only access to the five content tables is the eraser_access policy
--    below plus the column grants in section 11, nothing role-wide.
-- =======================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'discussion_eraser') THEN
    CREATE ROLE discussion_eraser NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE discussion_eraser NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
DECLARE
  r    record;
  bad  text[] := '{}';
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO r
    FROM pg_roles WHERE rolname = 'discussion_eraser';
  IF r.rolcanlogin THEN bad := array_append(bad, 'rolcanlogin'); END IF;
  IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
  IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
  IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
  IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
  IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'role discussion_eraser still has privileged attribute(s): %', array_to_string(bad, ', ');
  END IF;
END
$$;

-- Ownership-transfer bracket (D#81 per-file rule, same shape platform_ops
-- uses -- see docs/ops/hosted-postgres.md "Decision (b)"): CURRENT_USER
-- needs to be able to SET ROLE discussion_eraser for the OWNER TO step in
-- section 11 below, and discussion_eraser needs CREATE on schema public
-- at the moment that ALTER runs (bracketed around it there, not here). A
-- CREATEROLE role that just created discussion_eraser gets only ADMIN
-- OPTION on it (no SET), so grant SET explicitly -- INHERIT FALSE, since
-- C3 item 1 requires "no runtime role is a member of it" including
-- CURRENT_USER's own membership never inheriting its privileges. Unlike
-- platform_ops's own bracket, no INHERIT-TRUE step is ever needed: this
-- is a first-time CREATE FUNCTION, never a CREATE OR REPLACE of a
-- pre-existing discussion_eraser-owned object. Skipped for a superuser
-- current_user, which needs no membership at all to ALTER ... OWNER TO
-- (and could not be denied one either).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'discussion_eraser'::regrole
        AND m.member = current_user::regrole
        AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on discussion_eraser; cannot grant membership for ALTER FUNCTION ... OWNER TO discussion_eraser';
    END IF;
    GRANT discussion_eraser TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

-- =======================================================================
-- 10. RLS: one tenant_isolation policy per new table, identical shape to
--     work_items' (0001_core.sql:919-927). The five tables
--     erase_discussion_content actually touches also get exactly one
--     eraser_access policy TO discussion_eraser (C3 item 1/2). No policy
--     anywhere in this section names platform_ops or PUBLIC (criterion
--     2, criterion 16).
-- =======================================================================
ALTER TABLE discussion_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE discussion_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON discussion_counters TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT ON discussion_counters TO app_user;
-- Criterion 15: UPDATE is column-scoped to next_number/bytes_used only --
-- account_id is immutable (not granted), and the monotonic trigger above
-- rejects either column decreasing.
GRANT UPDATE (next_number, bytes_used) ON discussion_counters TO app_user;

ALTER TABLE discussions ENABLE ROW LEVEL SECURITY;
ALTER TABLE discussions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON discussions TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY eraser_access ON discussions
  FOR ALL TO discussion_eraser
  USING (true)
  WITH CHECK (true);
GRANT SELECT, INSERT ON discussions TO app_user;
-- Criterion 14: UPDATE is column-scoped so provenance (and the other
-- immutable/system-owned columns) can never flip under app_user -- the
-- same class 0613 already closed on work_items.provenance.
GRANT UPDATE (title, kind, visibility, security, closed_at, deleted_at) ON discussions TO app_user;

ALTER TABLE discussion_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE discussion_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON discussion_revisions TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY eraser_access ON discussion_revisions
  FOR ALL TO discussion_eraser
  USING (true)
  WITH CHECK (true);
-- Append-only (criterion 5): SELECT + INSERT only, no UPDATE/DELETE grant.
GRANT SELECT, INSERT ON discussion_revisions TO app_user;

ALTER TABLE discussion_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE discussion_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON discussion_comments TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY eraser_access ON discussion_comments
  FOR ALL TO discussion_eraser
  USING (true)
  WITH CHECK (true);
GRANT SELECT, INSERT ON discussion_comments TO app_user;
-- Column-scoped UPDATE (criterion 6): body/edited_at/deleted_at only.
-- erased_at is NOT included -- only erase_discussion_content sets it.
-- No DELETE grant at all (criterion 6: DELETE fails 42501).
GRANT UPDATE (body, edited_at, deleted_at) ON discussion_comments TO app_user;

ALTER TABLE spec_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE spec_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON spec_versions TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY eraser_access ON spec_versions
  FOR ALL TO discussion_eraser
  USING (true)
  WITH CHECK (true);
GRANT SELECT, INSERT ON spec_versions TO app_user;

ALTER TABLE spec_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE spec_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON spec_corrections TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY eraser_access ON spec_corrections
  FOR ALL TO discussion_eraser
  USING (true)
  WITH CHECK (true);
GRANT SELECT, INSERT ON spec_corrections TO app_user;

ALTER TABLE work_item_deps ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_deps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_item_deps TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- No eraser_access policy here: erase_discussion_content never touches
-- this table (C3 item 1).
-- deps.add / deps.remove (DS-2 criterion 9): INSERT and DELETE, no UPDATE
-- -- a dependency edge is added or removed, never modified in place.
GRANT SELECT, INSERT, DELETE ON work_item_deps TO app_user;

-- =======================================================================
-- 11. erase_discussion_content(): SECURITY DEFINER, owned by
--     discussion_eraser (C3 item 1). EXECUTE stays granted to
--     platform_ops only, without grant option -- platform_ops itself
--     holds no privilege and appears in no policy on any of the 7 tables
--     (criterion 16); this function is its only path to Discussion
--     content, and every write it makes is scoped to the one discussion
--     (and its root work item's Spec content) named by the caller.
-- =======================================================================

-- Bracket (see the ownership-transfer comment in section 9): discussion_
-- eraser needs CREATE on schema public only for the ALTER ... OWNER TO
-- statement below to succeed as a non-superuser -- closed again
-- immediately after. Harmless no-op if current_user is a superuser or if
-- discussion_eraser already holds it for some other reason.
GRANT CREATE ON SCHEMA public TO discussion_eraser;

CREATE FUNCTION erase_discussion_content(p_discussion_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_account_id        uuid;
  v_root_work_item_id uuid;
  v_erased_sha256     text := encode(sha256(convert_to('[erased]', 'UTF8')), 'hex');
BEGIN
  -- C3 item 4 / criterion 13 S1: an empty or whitespace-only reason is
  -- rejected before anything else runs -- no row changes, no audit row.
  -- btrim() only strips the space character, so a tab- or newline-only
  -- reason survived it (fix round 2 MF1); a negated character-class match
  -- against any non-whitespace character rejects every whitespace-only
  -- input, not just runs of plain spaces.
  IF p_reason IS NULL OR p_reason !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'erase_discussion_content: reason must not be empty or whitespace'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT account_id, root_work_item_id INTO v_account_id, v_root_work_item_id
    FROM discussions WHERE id = p_discussion_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'erase_discussion_content: discussion % not found', p_discussion_id
      USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE discussion_revisions SET body = '[erased]', erased_at = now()
    WHERE account_id = v_account_id AND discussion_id = p_discussion_id;

  UPDATE discussion_comments SET body = '[erased]', erased_at = now()
    WHERE account_id = v_account_id AND discussion_id = p_discussion_id;

  UPDATE spec_versions SET body = '[erased]', body_sha256 = v_erased_sha256, erased_at = now()
    WHERE account_id = v_account_id AND work_item_id = v_root_work_item_id;

  UPDATE spec_corrections SET body = '[erased]', erased_at = now()
    WHERE account_id = v_account_id
      AND spec_version_id IN (
        SELECT id FROM spec_versions WHERE account_id = v_account_id AND work_item_id = v_root_work_item_id
      );

  -- Criterion 13: actor is session_user (the login role that called this
  -- function), never a literal -- attributes an erasure to whoever
  -- actually called it, not to the function owner.
  INSERT INTO audit_log (account_id, actor, action, payload)
  VALUES (v_account_id, session_user, 'discussion.erase',
          jsonb_build_object('discussion_id', p_discussion_id, 'reason', p_reason));
END;
$$;
REVOKE ALL ON FUNCTION erase_discussion_content(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_discussion_content(uuid, text) TO platform_ops;
ALTER FUNCTION erase_discussion_content(uuid, text) OWNER TO discussion_eraser;

REVOKE CREATE ON SCHEMA public FROM discussion_eraser;

-- Column-scoped grants (C3 item 1) -- exactly what the function body
-- above reads/writes, nothing else. No DELETE, no INSERT on any content
-- table, no grant on any other table.
GRANT SELECT (id, account_id, root_work_item_id) ON discussions TO discussion_eraser;

GRANT SELECT (account_id, discussion_id) ON discussion_revisions TO discussion_eraser;
GRANT UPDATE (body, erased_at) ON discussion_revisions TO discussion_eraser;

GRANT SELECT (account_id, discussion_id) ON discussion_comments TO discussion_eraser;
GRANT UPDATE (body, erased_at) ON discussion_comments TO discussion_eraser;

GRANT SELECT (id, account_id, work_item_id) ON spec_versions TO discussion_eraser;
GRANT UPDATE (body, body_sha256, erased_at) ON spec_versions TO discussion_eraser;

GRANT SELECT (account_id, spec_version_id) ON spec_corrections TO discussion_eraser;
GRANT UPDATE (body, erased_at) ON spec_corrections TO discussion_eraser;

-- The audit write (C3 item 1: "column INSERT on audit_log ... Not both"
-- -- audit_write_system() stamps actor as 'system:'||source, which would
-- not satisfy criterion 13's session_user requirement, so this migration
-- uses the direct column-scoped INSERT route instead). audit_log has
-- FORCE ROW LEVEL SECURITY (0001_core.sql) and no existing policy covers
-- discussion_eraser, so a narrow, scoped-to-this-one-action policy is
-- needed alongside the grant -- audit_log is not one of the 7 new tables,
-- so this does not touch criterion 2's policy count on those. Pinned to
-- actor = session_user (fix round 2 SF1), not just the action, so the
-- policy states the same invariant the function body enforces rather than
-- leaving the actor unconstrained.
CREATE POLICY eraser_audit_insert ON audit_log
  FOR INSERT TO discussion_eraser
  WITH CHECK (action = 'discussion.erase' AND actor = session_user::text);
GRANT INSERT (account_id, actor, action, payload) ON audit_log TO discussion_eraser;
