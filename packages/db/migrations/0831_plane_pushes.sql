-- D#598 P1f-1 (Correction C4, R-598-P1f-2): the platform's record of what it pushed to a paired PUBLIC repo for a work item, and the
-- attempts that pushed it.
--
--   plane_pushes          one row per work item per paired repo, stamped when the build starts: the paired repo's full name, a digest of the
--                         pairing as it was read (so a later push can tell the pairing moved), and the public branch name. After that the
--                         row holds the head sha the platform last pushed, the public main tip it was built on, the pull request, and one
--                         of the fixed states. It is a STAMP of what the platform last saw: GitHub's branch head wins on every read.
--   plane_push_attempts   one row per try. A runner run gets exactly one token per (run, lease generation), enforced by the unique index
--                         below; a push has at most three attempts per row (the hosted "Try the push again" of a sandbox run).
--
-- The public branch name is `fx/p-<plane_pushes.id>`, a GENERATED column: it is computed from our own row, never taken from a caller, on
-- either runtime, and it carries no private issue number or title.
--
-- `state` holds the P1f values and the P1g values together (point 3 of the correction), so P1g needs no migration. `refusals` holds at
-- most 100 entries of fixed-shape text (kind, place, rule key); it has no field that can hold a matched value, a file's content or a token,
-- and the checks below keep the array small and typed (the strings' shape is checked by the writer's schema).
--
-- Expand-only: two new tables, nothing dropped, renamed or made NOT NULL on an existing table.
-- Numbered above the highest migration on the code plane (0826), after the queued 0828 and 0830. Re-check against main right before merging.

CREATE TABLE plane_pushes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id         uuid NOT NULL,
  -- The PRIVATE repo the item is built in.
  repo_id              uuid NOT NULL,
  -- The paired public repo's full name, as the pairing said at build start.
  code_repo            text NOT NULL
    CONSTRAINT plane_pushes_code_repo_check CHECK (
      code_repo ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9._-]{1,100}$'
      AND split_part(code_repo, '/', 2) NOT IN ('.', '..')),
  -- A hash of code_repo, the overlay globs and the rule-file paths at build start (hex sha-256).
  pairing_digest       text NOT NULL CONSTRAINT plane_pushes_digest_check CHECK (pairing_digest ~ '^[0-9a-f]{64}$'),
  branch               text GENERATED ALWAYS AS ('fx/p-' || id::text) STORED,
  -- The last sha the platform pushed, the public main tip that commit was built on, and the pull request.
  head_sha             text CONSTRAINT plane_pushes_head_check CHECK (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  tip_sha              text CONSTRAINT plane_pushes_tip_check CHECK (tip_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  pr_number            integer CONSTRAINT plane_pushes_pr_check CHECK (pr_number > 0),
  pr_url               text CONSTRAINT plane_pushes_pr_url_check CHECK (pr_url ~ '^https://github\.com/[A-Za-z0-9._/-]{3,200}/pull/[0-9]{1,9}$'),
  state                text NOT NULL DEFAULT 'building'
    CONSTRAINT plane_pushes_state_check CHECK (state IN
      ('building', 'scanning', 'pushed', 'pr_opened', 'refused', 'pushed_pr_not_opened', 'no_public_change',
       'updating', 'updated', 'waiting_person_pushed', 'managed_by_person', 'pr_closed', 'pr_merged')),
  -- A fixed snake_case refusal code (a PlaneRefusalCode); never text from GitHub, a repo or a model.
  code                 text CONSTRAINT plane_pushes_code_check CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  refusals             jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT plane_pushes_refusals_check CHECK (jsonb_typeof(refusals) = 'array' AND jsonb_array_length(refusals) <= 100),
  -- Set by a person who took over the public branch (P1g); the platform stops pushing while it is set.
  managed_by_person_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,

  CONSTRAINT plane_pushes_pr_shape CHECK ((pr_number IS NULL) = (pr_url IS NULL)),
  -- A state that says something was pushed has the sha and the tip it was built on; one that says a PR is open has the PR.
  CONSTRAINT plane_pushes_pushed_shape CHECK (state NOT IN ('pushed', 'pr_opened', 'pushed_pr_not_opened') OR (head_sha IS NOT NULL AND tip_sha IS NOT NULL)),
  CONSTRAINT plane_pushes_pr_opened_shape CHECK (state <> 'pr_opened' OR pr_number IS NOT NULL),
  -- A refusal always says why; no other state carries a code.
  CONSTRAINT plane_pushes_code_shape CHECK ((state = 'refused') = (code IS NOT NULL))
);

CREATE INDEX plane_pushes_by_repo ON plane_pushes (account_id, repo_id);
-- One record per item and public repo. GitHub names are case-insensitive and the stamp reads code_repo that way, so a pairing re-saved with
-- different case must not add a second row.
CREATE UNIQUE INDEX plane_pushes_item_repo_key ON plane_pushes (account_id, work_item_id, lower(code_repo));

CREATE FUNCTION plane_pushes_clock() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Identity never changes: not the owner, the item or the repos (the branch is generated from the id, so it cannot be written at all). The digest is re-stamped by a new build, so it may move.
CREATE FUNCTION plane_pushes_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
     OR NEW.repo_id IS DISTINCT FROM OLD.repo_id OR NEW.code_repo IS DISTINCT FROM OLD.code_repo
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'plane_pushes: identity is fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER plane_pushes_clock BEFORE INSERT OR UPDATE ON plane_pushes
  FOR EACH ROW EXECUTE FUNCTION plane_pushes_clock();
CREATE TRIGGER plane_pushes_guard BEFORE UPDATE ON plane_pushes
  FOR EACH ROW EXECUTE FUNCTION plane_pushes_guard();

ALTER TABLE plane_pushes ENABLE ROW LEVEL SECURITY;
ALTER TABLE plane_pushes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON plane_pushes TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON plane_pushes FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON plane_pushes TO app_user;
REVOKE ALL ON FUNCTION plane_pushes_clock() FROM PUBLIC;
REVOKE ALL ON FUNCTION plane_pushes_guard() FROM PUBLIC;

-- ---- the attempts ---------------------------------------------------------------------------------------------------------------

CREATE TABLE plane_push_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  plane_push_id    uuid NOT NULL,
  -- The agent run this attempt belongs to. Null for a hosted attempt that has no run (the PR-open retry).
  run_id           uuid,
  -- A runner run's lease generation (the unit a token is granted for); null for a sandbox or hosted attempt.
  lease_generation integer CONSTRAINT plane_push_attempts_lease_check CHECK (lease_generation >= 0),
  runtime          text NOT NULL CONSTRAINT plane_push_attempts_runtime_check CHECK (runtime IN ('runner', 'sandbox', 'hosted')),
  kind             text NOT NULL CONSTRAINT plane_push_attempts_kind_check CHECK (kind IN ('push', 'pr_open', 'fix_round')),
  attempt_no       integer NOT NULL CONSTRAINT plane_push_attempts_no_check CHECK (attempt_no >= 1),
  token_issued_at  timestamptz,
  -- Whether the restricted token was revoked after use; false when the daemon died first (the token then lapses within the hour).
  token_revoked    boolean,
  finished_at      timestamptz,
  -- A fixed snake_case outcome (a refusal code, or a phase name); never text from GitHub or a model.
  outcome          text CONSTRAINT plane_push_attempts_outcome_check CHECK (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id, id),
  CONSTRAINT plane_push_attempts_no_key UNIQUE (plane_push_id, attempt_no),
  FOREIGN KEY (account_id, plane_push_id) REFERENCES plane_pushes (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (run_id),

  -- A push has at most three attempts per row.
  CONSTRAINT plane_push_attempts_push_cap CHECK (kind <> 'push' OR attempt_no BETWEEN 1 AND 3),
  -- A runner attempt names its lease generation; the others do not have one.
  CONSTRAINT plane_push_attempts_lease_shape CHECK ((runtime = 'runner') = (lease_generation IS NOT NULL)),
  CONSTRAINT plane_push_attempts_revoked_shape CHECK (token_revoked IS NULL OR token_issued_at IS NOT NULL)
);

-- One token per lease generation of a run: the second request for the same pair finds this row.
CREATE UNIQUE INDEX plane_push_attempts_one_token ON plane_push_attempts (run_id, lease_generation) WHERE runtime = 'runner';
CREATE INDEX plane_push_attempts_by_push ON plane_push_attempts (account_id, plane_push_id);

-- The identity of an attempt never changes (its run may only become null, when the run row is deleted), and a token issue time is set once.
CREATE FUNCTION plane_push_attempts_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.plane_push_id IS DISTINCT FROM OLD.plane_push_id
     OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL) OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation
     OR NEW.runtime IS DISTINCT FROM OLD.runtime OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'plane_push_attempts: identity is fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.token_issued_at IS NOT NULL AND NEW.token_issued_at IS DISTINCT FROM OLD.token_issued_at THEN
    RAISE EXCEPTION 'plane_push_attempts: the token issue time is set once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plane_push_attempts_guard BEFORE UPDATE ON plane_push_attempts
  FOR EACH ROW EXECUTE FUNCTION plane_push_attempts_guard();

ALTER TABLE plane_push_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE plane_push_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON plane_push_attempts TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON plane_push_attempts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON plane_push_attempts TO app_user;
REVOKE ALL ON FUNCTION plane_push_attempts_guard() FROM PUBLIC;
