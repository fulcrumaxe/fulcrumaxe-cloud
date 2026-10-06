-- D#483 S3-a (live build L1): the imported plan and the proposal inbox.
--
-- Four tables, one row set per repo, every one tenant-isolated:
--   plan_imports     one row per import run: its state, the level it used, the source file and commit, its counts, the
--                    evidence of what it asked GitHub (the request log and the token's permissions), and how it ended.
--   plan_milestones  the plan's milestones, keyed (repo_id, key). A milestone missing from a later import is marked
--                    removed_at, never deleted.
--   plan_tasks       the plan's tasks with the status the importer decided from GitHub. Same removed_at rule.
--   proposals        the inbox: one row per repo and source item (dedupe_key). A person's decision (approved,
--                    rejected, who, when) is a stamp the importer never changes; new and withdrawn are derived and
--                    recomputed on every import.
--
-- Who writes what (the M0 rule E4 and E5 live here, in the data):
--   * app_user can only READ the four tables. It writes none of them.
--   * plan_importer (a NOLOGIN role; app_user may SET ROLE to it, never inherits it) is the role the import runs its
--     one write transaction under. It can INSERT and UPDATE the four tables, nothing else: no grant at all on
--     work_items, agent_runs or run_action_requests, so an import cannot start work even by mistake.
--     A guard trigger further binds it: on proposals it may only move new <-> withdrawn and can never touch a decision;
--     on plan_imports it can only finish a running row.
--   * platform_ops owns the definers below (SECURITY DEFINER, search_path pinned, EXECUTE for app_user only). A direct
--     platform_ops login (it is the web tier's live login) is refused three ways: the definers check session_user,
--     the platform_ops policies below require session_user <> 'platform_ops', and a write guard trigger refuses it.
--     This is the 0658/0689/0706 shape.
--       plan_import_begin(repo)               the start of an import: owner or admin session, repo connected, at most
--                                             one active import per repo, a per-repo and per-account hourly limit.
--       approve_proposal(proposal, work_item) new -> approved, takes the next roadmap position, links the work item.
--       reject_proposal(proposal, note)       new -> rejected, with an optional note of up to 500 characters.
--       restore_proposal(proposal)            rejected -> new.
--       withdraw_approval(proposal)           approved -> new, only while the work item is at triaged with no run.
--     The work item itself is created (and closed on a withdrawal) by the caller in the same transaction, through the
--     ordinary stage writer; the definers take its id and check what they can see.
--   * Trigger and guard functions are owned by the migration role, never platform_ops.
--
-- Deviation from the Spec's one-sentence description of the policies: the Spec says no policy names platform_ops. The
-- definers are owned by platform_ops, and with FORCE ROW LEVEL SECURITY an owner with no policy reads and writes
-- nothing, so plan_imports and proposals each carry ONE platform_ops policy. It is tenant-bound, covers only those two
-- tables, and is false for a direct platform_ops login (session_user <> 'platform_ops'), exactly as 0658 does.
--
-- Refusals use fixed SQLSTATEs and messages: 42501 not permitted, 22023 invalid argument, P0002 not found,
-- 55000 wrong state (the message is the code the API maps: import_running, repo_not_connected, not_new, not_rejected,
-- owned_by_internal_loop, work_started), 53400 rate limit (the HINT is the seconds to wait), 23505 work item in use.
-- Privilege brackets as in 0712.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

-- ---------------------------------------------------------------------
-- 1. plan_importer: NOLOGIN, hardened attributes (0642 shape).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plan_importer') THEN
    CREATE ROLE plan_importer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE plan_importer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
DO $$
DECLARE
  r   record;
  bad text[] := '{}';
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO r FROM pg_roles WHERE rolname = 'plan_importer';
  IF r.rolcanlogin THEN bad := array_append(bad, 'rolcanlogin'); END IF;
  IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
  IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
  IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
  IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
  IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'role plan_importer still has privileged attribute(s): %', array_to_string(bad, ', ');
  END IF;
END
$$;
-- app_user may SET ROLE to it for the import's write transaction (SET LOCAL ROLE), and does not inherit its privileges.
GRANT plan_importer TO app_user WITH INHERIT FALSE, SET TRUE;

-- ---------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------
CREATE TABLE plan_imports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id              uuid NOT NULL,
  requested_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  -- The run-action request behind a worker import (S3-d). The live build runs the import in the request, so it is null.
  run_action_id        uuid,
  state                text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  level                text CHECK (level IN ('roadmap_file', 'spec_tables', 'issues_discussions')),
  source_path          text CHECK (char_length(source_path) <= 300),
  source_sha           text CHECK (char_length(source_sha) <= 64),
  -- This import's stamp: totals and per milestone. A historical record, never recomputed.
  counts               jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  truncated            boolean NOT NULL DEFAULT false,
  error_code           text CHECK (error_code IN (
                         'repo_not_connected', 'app_permission_missing', 'discussions_disabled', 'plan_file_inconsistent',
                         'plan_file_too_large', 'token_not_read_only', 'github_unavailable', 'rate_limited_by_github',
                         'plan_file_missing', 'plan_file_shape', 'interrupted', 'internal_error')),
  -- The first problem, in words, for the error codes that name one (the inconsistent task key, the shape problem).
  error_detail         text CHECK (char_length(error_detail) <= 500),
  max_merged_pr        integer CHECK (max_merged_pr >= 0),
  -- Evidence of what the import asked GitHub and what the minted token could do (acceptance A2).
  github_requests      jsonb CHECK (jsonb_typeof(github_requests) = 'array'),
  token_permissions    jsonb CHECK (jsonb_typeof(token_permissions) = 'object'),
  started_at           timestamptz,
  finished_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  CHECK ((state IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)),
  CHECK ((state = 'failed') = (error_code IS NOT NULL))
);
-- One queued or running import per repo.
CREATE UNIQUE INDEX plan_imports_one_active ON plan_imports (repo_id) WHERE state IN ('queued', 'running');
CREATE INDEX plan_imports_repo_created ON plan_imports (repo_id, created_at DESC);
CREATE INDEX plan_imports_account_created ON plan_imports (account_id, created_at DESC);

CREATE TABLE plan_milestones (
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id        uuid NOT NULL,
  key            text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 120),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  position       integer NOT NULL CHECK (position >= 0),
  last_import_id uuid,
  removed_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, key),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, last_import_id) REFERENCES plan_imports (account_id, id) ON DELETE SET NULL (last_import_id)
);

CREATE TABLE plan_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id             uuid NOT NULL,
  task_key            text NOT NULL CHECK (char_length(task_key) BETWEEN 1 AND 200),
  milestone_key       text NOT NULL,
  discussion_number   integer CHECK (discussion_number > 0),
  title               text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  planned_prs         integer NOT NULL CHECK (planned_prs >= 0),
  merged_prs          integer[] NOT NULL DEFAULT '{}',
  open_prs            integer[] NOT NULL DEFAULT '{}',
  status              text NOT NULL CHECK (status IN ('done', 'partial', 'open', 'not_started', 'pending_spec')),
  is_leaf             boolean NOT NULL DEFAULT true,
  parent_key          text CHECK (char_length(parent_key) <= 200),
  owner_process       text NOT NULL CHECK (owner_process IN ('product', 'internal_loop')),
  evidence            jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  evidence_dropped    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_dropped) = 'array'),
  first_import_id     uuid,
  last_import_id      uuid,
  removed_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id, task_key),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (repo_id, milestone_key) REFERENCES plan_milestones (repo_id, key),
  FOREIGN KEY (account_id, first_import_id) REFERENCES plan_imports (account_id, id) ON DELETE SET NULL (first_import_id),
  FOREIGN KEY (account_id, last_import_id) REFERENCES plan_imports (account_id, id) ON DELETE SET NULL (last_import_id),
  -- done is derived from the merged pull requests; the row cannot say done without them.
  CHECK (status <> 'done' OR (planned_prs >= 1 AND cardinality(merged_prs) >= planned_prs))
);
CREATE INDEX plan_tasks_repo_milestone ON plan_tasks (repo_id, milestone_key, task_key);

CREATE TABLE proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id            uuid NOT NULL,
  dedupe_key         text NOT NULL CHECK (dedupe_key ~ '^(gh:issue:[0-9]+|gh:discussion:[0-9]+|plan:.{1,200})$'),
  sources            text[] NOT NULL CHECK (cardinality(sources) >= 1
                                            AND sources <@ ARRAY['github_issue', 'github_discussion', 'plan_task', 'preview']::text[]),
  gh_number          integer CHECK (gh_number > 0),
  discussion_number  integer CHECK (discussion_number > 0),
  plan_task_id       uuid,
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 256),
  -- Sanitized before insert (the importer strips control-plane tokens); never raw repository text.
  summary            text CHECK (char_length(summary) <= 2000),
  category_hint      text CHECK (char_length(category_hint) <= 60),
  estimate_usd       numeric(10, 4) CHECK (estimate_usd >= 0),
  provenance         text NOT NULL CHECK (provenance IN ('internal', 'external')),
  owner_process      text NOT NULL CHECK (owner_process IN ('product', 'internal_loop')),
  state              text NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'approved', 'rejected', 'withdrawn')),
  decided_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at         timestamptz,
  reject_note        text CHECK (char_length(reject_note) <= 500),
  roadmap_position   integer CHECK (roadmap_position >= 1),
  work_item_id       uuid,
  last_import_id     uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id, dedupe_key),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, plan_task_id) REFERENCES plan_tasks (account_id, id) ON DELETE SET NULL (plan_task_id),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE SET NULL (work_item_id),
  FOREIGN KEY (account_id, last_import_id) REFERENCES plan_imports (account_id, id) ON DELETE SET NULL (last_import_id),
  -- E5: one process per item, at the data. A product approval needs a product-owned item.
  CONSTRAINT proposals_approved_needs_product CHECK (state <> 'approved' OR owner_process = 'product'),
  CONSTRAINT proposals_approved_iff_position CHECK ((state = 'approved') = (roadmap_position IS NOT NULL)),
  CONSTRAINT proposals_decision_stamped CHECK (state NOT IN ('approved', 'rejected') OR decided_at IS NOT NULL),
  CONSTRAINT proposals_note_only_when_rejected CHECK (reject_note IS NULL OR state = 'rejected')
);
CREATE UNIQUE INDEX proposals_work_item_once ON proposals (work_item_id) WHERE work_item_id IS NOT NULL;
CREATE UNIQUE INDEX proposals_position_once ON proposals (repo_id, roadmap_position) WHERE roadmap_position IS NOT NULL;
CREATE INDEX proposals_repo_state ON proposals (repo_id, state, created_at DESC);

-- ---------------------------------------------------------------------
-- 3. Row level security: exactly one tenant_isolation policy on each table.
-- ---------------------------------------------------------------------
-- plan_importer evaluates account_is_active() as itself, so it may read the one account row of its tenant, two columns.
GRANT SELECT (id, deleted_at) ON accounts TO plan_importer;
CREATE POLICY plan_importer_account_state ON accounts FOR SELECT TO plan_importer
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);

ALTER TABLE plan_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_milestones FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON plan_imports TO app_user, plan_importer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY tenant_isolation ON plan_milestones TO app_user, plan_importer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY tenant_isolation ON plan_tasks TO app_user, plan_importer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY tenant_isolation ON proposals TO app_user, plan_importer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

-- The definers' owner. Tenant-bound, and false for a direct platform_ops login (0658's shape).
CREATE POLICY platform_ops_definer ON plan_imports TO platform_ops
  USING (session_user <> 'platform_ops' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (session_user <> 'platform_ops' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY platform_ops_definer ON proposals TO platform_ops
  USING (session_user <> 'platform_ops' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (session_user <> 'platform_ops' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

-- ---------------------------------------------------------------------
-- 4. Grants. Narrow, column-scoped where the writer needs less than the table.
-- ---------------------------------------------------------------------
GRANT SELECT ON plan_imports, plan_milestones, plan_tasks, proposals TO app_user;

-- plan_importer: no grant on work_items, agent_runs or run_action_requests (E4), and no DELETE anywhere.
GRANT SELECT ON plan_imports, plan_milestones, plan_tasks, proposals TO plan_importer;
GRANT UPDATE (state, level, source_path, source_sha, counts, truncated, error_code, error_detail, max_merged_pr,
              github_requests, token_permissions, finished_at)
  ON plan_imports TO plan_importer;
GRANT INSERT ON plan_milestones TO plan_importer;
GRANT UPDATE (title, position, last_import_id, removed_at) ON plan_milestones TO plan_importer;
GRANT INSERT ON plan_tasks TO plan_importer;
GRANT UPDATE (milestone_key, discussion_number, title, planned_prs, merged_prs, open_prs, status, is_leaf, parent_key,
              owner_process, evidence, evidence_dropped, last_import_id, removed_at, updated_at)
  ON plan_tasks TO plan_importer;
GRANT INSERT (account_id, repo_id, dedupe_key, sources, gh_number, discussion_number, plan_task_id, title, summary,
              category_hint, estimate_usd, provenance, owner_process, state, last_import_id)
  ON proposals TO plan_importer;
GRANT UPDATE (sources, gh_number, discussion_number, plan_task_id, title, summary, category_hint, estimate_usd,
              provenance, owner_process, state, last_import_id, updated_at)
  ON proposals TO plan_importer;

-- platform_ops (the definers' owner): exactly the columns the definers write, and the reads they make.
GRANT SELECT ON plan_imports, proposals TO platform_ops;
GRANT INSERT (account_id, repo_id, requested_by_user_id, state, started_at) ON plan_imports TO platform_ops;
GRANT UPDATE (state, error_code, finished_at) ON plan_imports TO platform_ops;
GRANT UPDATE (state, decided_by_user_id, decided_at, reject_note, roadmap_position, work_item_id, updated_at)
  ON proposals TO platform_ops;
-- withdraw_approval reads the work item's stage (the 0658 policy already ties the read to the tenant and refuses a direct login).
GRANT SELECT (stage) ON work_items TO platform_ops;

-- ---------------------------------------------------------------------
-- 5. Guards (owned by the migration role, never platform_ops).
-- ---------------------------------------------------------------------
CREATE FUNCTION plan_tables_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION '%: platform_ops may not write directly', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_imports_write_guard BEFORE INSERT OR UPDATE ON plan_imports FOR EACH ROW EXECUTE FUNCTION plan_tables_write_guard();
CREATE TRIGGER plan_milestones_write_guard BEFORE INSERT OR UPDATE ON plan_milestones FOR EACH ROW EXECUTE FUNCTION plan_tables_write_guard();
CREATE TRIGGER plan_tasks_write_guard BEFORE INSERT OR UPDATE ON plan_tasks FOR EACH ROW EXECUTE FUNCTION plan_tables_write_guard();
CREATE TRIGGER proposals_write_guard BEFORE INSERT OR UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION plan_tables_write_guard();

-- The import's own role may create a proposal only as new and may only move new <-> withdrawn: a person's decision
-- (approved, rejected, who, when, the position, the work item) is never the importer's to write or to undo.
CREATE FUNCTION proposals_importer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user <> 'plan_importer' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'new' OR NEW.decided_at IS NOT NULL OR NEW.decided_by_user_id IS NOT NULL
       OR NEW.roadmap_position IS NOT NULL OR NEW.work_item_id IS NOT NULL OR NEW.reject_note IS NOT NULL THEN
      RAISE EXCEPTION 'proposals: an import may only create a new proposal' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT ((OLD.state = 'new' AND NEW.state = 'withdrawn') OR (OLD.state = 'withdrawn' AND NEW.state = 'new')) THEN
    RAISE EXCEPTION 'proposals: an import may not change a decision (% to %)', OLD.state, NEW.state USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.state = 'approved' AND NEW.owner_process IS DISTINCT FROM OLD.owner_process THEN
    RAISE EXCEPTION 'proposals: an import may not change the owner of an approved proposal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proposals_importer_guard BEFORE INSERT OR UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION proposals_importer_guard();

-- An import row is finished once: only a queued or running row can be written by the import's role.
CREATE FUNCTION plan_imports_importer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'plan_importer' AND OLD.state IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'plan_imports: a finished import is not changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user = 'plan_importer' AND NEW.state NOT IN ('running', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'plan_imports: an import ends running, succeeded or failed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plan_imports_importer_guard BEFORE UPDATE ON plan_imports FOR EACH ROW EXECUTE FUNCTION plan_imports_importer_guard();

-- ---------------------------------------------------------------------
-- 6. Definers (SECURITY DEFINER, owner platform_ops, search_path pinned, EXECUTE for app_user only).
-- ---------------------------------------------------------------------
CREATE FUNCTION plan_import_begin(p_repo_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr      uuid := current_member_user_id();
  v_inst   uuid;
  v_oldest timestamptz;
  v_wait   integer;
  new_id   uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'plan_import_begin: platform_ops may not call this directly' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL
     OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'plan_import_begin: a member session of an active account is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF COALESCE(current_member_role(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'plan_import_begin: owner or admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL THEN
    RAISE EXCEPTION 'plan_import_begin: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT r.installation_id INTO v_inst FROM public.repos r WHERE r.id = p_repo_id AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_import_begin: repo not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_inst IS NULL THEN
    RAISE EXCEPTION 'repo_not_connected' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- One start at a time per repo, so the limits and the one-active rule cannot be raced.
  PERFORM pg_advisory_xact_lock(hashtextextended('plan_import_begin:' || p_repo_id::text, 0));

  -- An import whose request died leaves a running row; after 10 minutes it is closed as interrupted so a new one can start.
  UPDATE public.plan_imports SET state = 'failed', error_code = 'interrupted', finished_at = now()
   WHERE repo_id = p_repo_id AND account_id = acct AND state IN ('queued', 'running')
     AND COALESCE(started_at, created_at) < now() - interval '10 minutes';
  IF EXISTS (SELECT 1 FROM public.plan_imports x WHERE x.repo_id = p_repo_id AND x.account_id = acct AND x.state IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'import_running' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- 6 per repo and 20 per account per hour.
  SELECT min(created_at) INTO v_oldest FROM public.plan_imports x
   WHERE x.repo_id = p_repo_id AND x.account_id = acct AND x.created_at > now() - interval '1 hour';
  IF (SELECT count(*) FROM public.plan_imports x WHERE x.repo_id = p_repo_id AND x.account_id = acct AND x.created_at > now() - interval '1 hour') >= 6 THEN
    v_wait := GREATEST(1, ceil(extract(epoch FROM (v_oldest + interval '1 hour' - now())))::integer);
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'configuration_limit_exceeded', HINT = v_wait::text;
  END IF;
  SELECT min(created_at) INTO v_oldest FROM public.plan_imports x
   WHERE x.account_id = acct AND x.created_at > now() - interval '1 hour';
  IF (SELECT count(*) FROM public.plan_imports x WHERE x.account_id = acct AND x.created_at > now() - interval '1 hour') >= 20 THEN
    v_wait := GREATEST(1, ceil(extract(epoch FROM (v_oldest + interval '1 hour' - now())))::integer);
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'configuration_limit_exceeded', HINT = v_wait::text;
  END IF;

  INSERT INTO public.plan_imports (account_id, repo_id, requested_by_user_id, state, started_at)
  VALUES (acct, p_repo_id, usr, 'running', now())
  RETURNING id INTO new_id;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'plan_import.started', jsonb_build_object('import_id', new_id, 'repo_id', p_repo_id), clock_timestamp());
  RETURN new_id;
END $$;

-- The caller of a proposal decision: a session owner or admin (returns the user id), or a live token with work_items:write
-- (returns null). Anyone else is refused. Shared by the four decision definers.
-- An authorization helper, so it is NOT owned by platform_ops (an owner could ALTER it IMMUTABLE and have one caller's
-- answer reused for every later caller on a pooled connection). It stays owned by the migration role, VOLATILE and
-- SECURITY INVOKER: it is only called from inside the platform_ops-owned decision definers, so it still runs as platform_ops.
CREATE FUNCTION proposal_decider(p_fn text)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  tok    uuid := NULLIF(current_setting('app.token_id', true), '')::uuid;
  usr    uuid := current_member_user_id();
  scopes text[];
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION '%: platform_ops may not call this directly', p_fn USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION '%: no active account in context', p_fn USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF tok IS NOT NULL THEN
    SELECT t.scopes INTO scopes FROM public.api_tokens t
     WHERE t.id = tok AND t.account_id = acct AND t.revoked_at IS NULL AND t.expires_at > now();
    IF NOT FOUND OR NOT ('work_items:write' = ANY (scopes)) THEN
      RAISE EXCEPTION '%: the token may not decide proposals', p_fn USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NULL;
  END IF;
  IF usr IS NULL OR COALESCE(current_member_role(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION '%: owner or admin only', p_fn USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN usr;
END $$;

CREATE FUNCTION approve_proposal(p_proposal_id uuid, p_work_item_id uuid)
RETURNS TABLE (state text, roadmap_position integer, work_item_id uuid, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid;
  p    public.proposals;
  pos  integer;
BEGIN
  usr := public.proposal_decider('approve_proposal');
  IF p_proposal_id IS NULL OR p_work_item_id IS NULL THEN
    RAISE EXCEPTION 'approve_proposal: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_proposal: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- The same call twice (a retry) is the same answer and writes nothing.
  IF p.state = 'approved' AND p.work_item_id = p_work_item_id THEN
    RETURN QUERY SELECT p.state, p.roadmap_position, p.work_item_id, true; RETURN;
  END IF;
  IF p.state <> 'new' THEN
    RAISE EXCEPTION 'not_new' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- E5: the data would refuse it too (proposals_approved_needs_product); this gives the caller the code.
  IF p.owner_process <> 'product' THEN
    RAISE EXCEPTION 'owned_by_internal_loop' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.id = p.repo_id AND r.account_id = acct AND r.installation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'repo_not_connected' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('proposal_position:' || p.repo_id::text, 0));
  SELECT COALESCE(max(x.roadmap_position), 0) + 1 INTO pos FROM public.proposals x WHERE x.repo_id = p.repo_id;
  BEGIN
    UPDATE public.proposals
       SET state = 'approved', decided_by_user_id = usr, decided_at = now(), roadmap_position = pos,
           work_item_id = p_work_item_id, updated_at = now()
     WHERE id = p.id AND account_id = acct;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'approve_proposal: that work item already belongs to a proposal' USING ERRCODE = 'unique_violation';
  END;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, COALESCE(usr::text, 'token:' || current_setting('app.token_id', true)), 'proposal.approved',
          jsonb_build_object('proposal_id', p.id, 'repo_id', p.repo_id, 'work_item_id', p_work_item_id, 'roadmap_position', pos),
          clock_timestamp());
  RETURN QUERY SELECT 'approved'::text, pos, p_work_item_id, false;
END $$;

CREATE FUNCTION reject_proposal(p_proposal_id uuid, p_note text DEFAULT NULL)
RETURNS TABLE (state text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid;
  p    public.proposals;
  note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  usr := public.proposal_decider('reject_proposal');
  IF p_proposal_id IS NULL OR (note IS NOT NULL AND char_length(note) > 500) THEN
    RAISE EXCEPTION 'reject_proposal: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reject_proposal: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p.state = 'rejected' AND p.reject_note IS NOT DISTINCT FROM note THEN
    RETURN QUERY SELECT p.state, true; RETURN;
  END IF;
  IF p.state <> 'new' THEN
    RAISE EXCEPTION 'not_new' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE public.proposals
     SET state = 'rejected', decided_by_user_id = usr, decided_at = now(), reject_note = note, updated_at = now()
   WHERE id = p.id AND account_id = acct;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, COALESCE(usr::text, 'token:' || current_setting('app.token_id', true)), 'proposal.rejected',
          jsonb_build_object('proposal_id', p.id, 'repo_id', p.repo_id), clock_timestamp());
  RETURN QUERY SELECT 'rejected'::text, false;
END $$;

CREATE FUNCTION restore_proposal(p_proposal_id uuid)
RETURNS TABLE (state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid;
  p    public.proposals;
BEGIN
  usr := public.proposal_decider('restore_proposal');
  IF p_proposal_id IS NULL THEN
    RAISE EXCEPTION 'restore_proposal: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'restore_proposal: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p.state <> 'rejected' THEN
    RAISE EXCEPTION 'not_rejected' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE public.proposals
     SET state = 'new', decided_by_user_id = NULL, decided_at = NULL, reject_note = NULL, updated_at = now()
   WHERE id = p.id AND account_id = acct;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, COALESCE(usr::text, 'token:' || current_setting('app.token_id', true)), 'proposal.restored',
          jsonb_build_object('proposal_id', p.id, 'repo_id', p.repo_id), clock_timestamp());
  RETURN QUERY SELECT 'new'::text;
END $$;

-- approved -> new, only while the work item is at triaged and no run was ever made for it. The caller closes the work item
-- (triaged -> closed) in the same transaction through the ordinary stage writer, after this returns.
CREATE FUNCTION withdraw_approval(p_proposal_id uuid)
RETURNS TABLE (state text, work_item_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr   uuid;
  p     public.proposals;
  stage text;
BEGIN
  usr := public.proposal_decider('withdraw_approval');
  IF p_proposal_id IS NULL THEN
    RAISE EXCEPTION 'withdraw_approval: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'withdraw_approval: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p.state <> 'approved' THEN
    RAISE EXCEPTION 'not_approved' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT w.stage INTO stage FROM public.work_items w WHERE w.id = p.work_item_id AND w.account_id = acct;
  IF stage IS DISTINCT FROM 'triaged'
     OR EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.account_id = acct AND r.work_item_id = p.work_item_id) THEN
    RAISE EXCEPTION 'work_started' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE public.proposals
     SET state = 'new', decided_by_user_id = NULL, decided_at = NULL, roadmap_position = NULL, work_item_id = NULL, updated_at = now()
   WHERE id = p.id AND account_id = acct;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, COALESCE(usr::text, 'token:' || current_setting('app.token_id', true)), 'proposal.approval_withdrawn',
          jsonb_build_object('proposal_id', p.id, 'repo_id', p.repo_id, 'work_item_id', p.work_item_id), clock_timestamp());
  RETURN QUERY SELECT 'new'::text, p.work_item_id;
END $$;

REVOKE ALL ON FUNCTION plan_import_begin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION proposal_decider(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_proposal(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_proposal(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION restore_proposal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION withdraw_approval(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION plan_import_begin(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION approve_proposal(uuid, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION reject_proposal(uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION restore_proposal(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION withdraw_approval(uuid) TO app_user;
ALTER FUNCTION plan_import_begin(uuid) OWNER TO platform_ops;
GRANT EXECUTE ON FUNCTION proposal_decider(text) TO platform_ops;
ALTER FUNCTION approve_proposal(uuid, uuid) OWNER TO platform_ops;
ALTER FUNCTION reject_proposal(uuid, text) OWNER TO platform_ops;
ALTER FUNCTION restore_proposal(uuid) OWNER TO platform_ops;
ALTER FUNCTION withdraw_approval(uuid) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
