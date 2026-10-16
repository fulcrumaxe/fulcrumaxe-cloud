-- D#598 P5b (Correction C3, R-598-P5b-3): the platform's plan write-back, and the second kind of merge-queue entry that carries it.
--
--   plan_writebacks       one row per write-back pull request the platform opens on the repo that holds the plan file: its branch, its
--                         pull request, the head sha the platform itself pushed, and the default-branch commit its content was built on.
--                         This is the platform's own record. It is what lets a later step tell "the head I pushed" from "someone else
--                         pushed here", so no decision about a write-back ever rests on the author login of a commit or a pull request.
--   merge_queue_entries   gains `entry_kind` ('work_item' by default, or 'plan_writeback') and `plan_writeback_id`. A write-back entry has
--                         no work item: `work_item_id` becomes nullable and a CHECK requires EXACTLY ONE of the two ids, chosen by the kind.
--                         Dropping NOT NULL is expand-safe (old code still writes work items). A write-back entry can never be awaiting
--                         work: it carries no work kind, no run and no conflict round, because the platform never starts an agent run for it.
--   head_refreshes        `work_item_id` becomes nullable too, so a verified platform refresh of a write-back head can be recorded.
--
-- At most one write-back is live per repo (a partial unique index): the second merge in a row finds the first one open and extends it, it
-- does not open another. A live row is `opening` (the branch is being made), `open`, `changed_by_other` (the head is no longer the one the
-- platform recorded; the platform stops writing to it) or `needs_setup` (nothing could be opened: the reason is a fixed code).
--
-- Numbered above the highest migration claimed on the code plane (0824, merge queue core). Re-check against main right before merging.

CREATE TABLE plan_writebacks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id    uuid NOT NULL,
  state      text NOT NULL DEFAULT 'opening'
               CONSTRAINT plan_writebacks_state_check CHECK (state IN
                 ('opening', 'open', 'changed_by_other', 'needs_setup', 'merged', 'closed', 'superseded', 'abandoned')),
  -- The plan file's path in the repo, as the last roadmap import read it.
  plan_path  text NOT NULL CONSTRAINT plan_writebacks_path_check CHECK (length(plan_path) BETWEEN 1 AND 200),
  -- Only the platform's own namespace (the port's write allowlist is the same prefix): a row can never name the default branch.
  branch     text CONSTRAINT plan_writebacks_branch_check CHECK (branch ~ '^fulcrumaxe/plan-update-[A-Za-z0-9._-]{1,100}$' AND branch NOT LIKE '%..%' AND branch NOT LIKE '%.lock'),
  pr_number  integer CONSTRAINT plan_writebacks_pr_check CHECK (pr_number > 0),
  -- The head the platform last pushed, and the default-branch commit the content was computed on.
  head_sha   text CONSTRAINT plan_writebacks_head_check CHECK (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  base_sha   text CONSTRAINT plan_writebacks_base_check CHECK (base_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  -- 1 for a first attempt; a restart after a refused refresh opens attempt n + 1 from current truth.
  attempt    integer NOT NULL DEFAULT 1 CONSTRAINT plan_writebacks_attempt_check CHECK (attempt >= 1),
  -- A fixed snake_case code: why the row is `needs_setup`, `changed_by_other` or `superseded`. Never text from GitHub or a model.
  reason     text CONSTRAINT plan_writebacks_reason_check CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id, id),
  -- Lets a queue entry reference the write-back together with its repo (see merge_queue_entries_writeback_fk below).
  CONSTRAINT plan_writebacks_account_repo_id_key UNIQUE (account_id, repo_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,

  CONSTRAINT plan_writebacks_pr_shape CHECK (
    (pr_number IS NULL) = (head_sha IS NULL) AND (head_sha IS NULL) = (base_sha IS NULL)
    AND (state IN ('open', 'changed_by_other', 'merged', 'closed', 'superseded')) = (pr_number IS NOT NULL)
  ),
  CONSTRAINT plan_writebacks_branch_shape CHECK ((state = 'needs_setup') = (branch IS NULL) OR state = 'abandoned'),
  CONSTRAINT plan_writebacks_reason_shape CHECK (state <> 'needs_setup' OR reason IS NOT NULL)
);

-- The database's own guarantee of one live write-back per repo.
CREATE UNIQUE INDEX plan_writebacks_one_live ON plan_writebacks (account_id, repo_id)
  WHERE state IN ('opening', 'open', 'changed_by_other', 'needs_setup');
CREATE UNIQUE INDEX plan_writebacks_branch_unique ON plan_writebacks (account_id, repo_id, branch) WHERE branch IS NOT NULL;
CREATE INDEX plan_writebacks_by_pr ON plan_writebacks (account_id, repo_id, pr_number) WHERE pr_number IS NOT NULL;

CREATE FUNCTION plan_writebacks_clock() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Identity never changes, a branch and a pull request are set once, the head moves only while the row is `open`, a final row never
-- changes, and the states move only along the table below.
CREATE FUNCTION plan_writebacks_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.repo_id IS DISTINCT FROM OLD.repo_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.plan_path IS DISTINCT FROM OLD.plan_path THEN
    RAISE EXCEPTION 'plan_writebacks: identity, attempt and plan_path are fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('merged', 'closed', 'superseded', 'abandoned') THEN
    RAISE EXCEPTION 'plan_writebacks: a final row does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.branch IS NOT NULL AND NEW.branch IS DISTINCT FROM OLD.branch) OR (OLD.pr_number IS NOT NULL AND NEW.pr_number IS DISTINCT FROM OLD.pr_number) THEN
    RAISE EXCEPTION 'plan_writebacks: the branch and the pull request are set once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.head_sha IS DISTINCT FROM OLD.head_sha AND NOT (OLD.state IN ('opening', 'open') AND NEW.state = 'open') THEN
    RAISE EXCEPTION 'plan_writebacks: the recorded head moves only while the write-back is open' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'opening'          AND NEW.state IN ('open', 'abandoned'))
    OR (OLD.state = 'open'             AND NEW.state IN ('changed_by_other', 'merged', 'closed', 'superseded'))
    OR (OLD.state = 'changed_by_other' AND NEW.state IN ('merged', 'closed', 'superseded'))
    OR (OLD.state = 'needs_setup'      AND NEW.state IN ('abandoned'))
  ) THEN
    RAISE EXCEPTION 'plan_writebacks: that state move is not allowed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER plan_writebacks_clock BEFORE INSERT OR UPDATE ON plan_writebacks
  FOR EACH ROW EXECUTE FUNCTION plan_writebacks_clock();
CREATE TRIGGER plan_writebacks_guard BEFORE UPDATE ON plan_writebacks
  FOR EACH ROW EXECUTE FUNCTION plan_writebacks_guard();

ALTER TABLE plan_writebacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_writebacks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON plan_writebacks TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON plan_writebacks FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON plan_writebacks TO app_user;
REVOKE ALL ON FUNCTION plan_writebacks_clock() FROM PUBLIC;
REVOKE ALL ON FUNCTION plan_writebacks_guard() FROM PUBLIC;

-- ---- the second entry kind ---------------------------------------------------------------------------------------------------

ALTER TABLE merge_queue_entries
  ADD COLUMN entry_kind text NOT NULL DEFAULT 'work_item'
    CONSTRAINT merge_queue_entries_kind_check CHECK (entry_kind IN ('work_item', 'plan_writeback')),
  ADD COLUMN plan_writeback_id uuid;
ALTER TABLE merge_queue_entries ALTER COLUMN work_item_id DROP NOT NULL;

ALTER TABLE merge_queue_entries
  ADD CONSTRAINT merge_queue_entries_kind_shape CHECK (
    (entry_kind = 'work_item' AND work_item_id IS NOT NULL AND plan_writeback_id IS NULL)
    OR (entry_kind = 'plan_writeback' AND work_item_id IS NULL AND plan_writeback_id IS NOT NULL)
  ),
  -- The platform never starts an agent run for a write-back: no fix round, no stack parent, no work kind, never `awaiting_work`.
  ADD CONSTRAINT merge_queue_entries_writeback_no_agent CHECK (
    entry_kind = 'work_item'
    OR (work_kind IS NULL AND work_run_id IS NULL AND state <> 'awaiting_work' AND conflict_rounds = 0 AND depends_on_pr_number IS NULL)
  ),
  ADD CONSTRAINT merge_queue_entries_writeback_unique UNIQUE (account_id, plan_writeback_id),
  -- The entry's repo is structurally the write-back's repo: the link cannot cross repos, let alone tenants.
  ADD CONSTRAINT merge_queue_entries_writeback_fk FOREIGN KEY (account_id, repo_id, plan_writeback_id)
    REFERENCES plan_writebacks (account_id, repo_id, id) ON DELETE CASCADE;

ALTER TABLE head_refreshes ALTER COLUMN work_item_id DROP NOT NULL;

-- Same guard as 0824, with the two new identity columns fixed as well.
CREATE OR REPLACE FUNCTION merge_queue_entries_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.repo_id IS DISTINCT FROM OLD.repo_id
     OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
     OR NEW.entry_kind IS DISTINCT FROM OLD.entry_kind OR NEW.plan_writeback_id IS DISTINCT FROM OLD.plan_writeback_id
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'merge_queue_entries: identity and approved_at are fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('merged', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'merge_queue_entries: a final entry does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.refresh_count < OLD.refresh_count OR NEW.conflict_rounds < OLD.conflict_rounds THEN
    RAISE EXCEPTION 'merge_queue_entries: counters only go up' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'in_review'     AND NEW.state IN ('queued', 'stopped', 'merged', 'closed', 'cancelled'))
    OR (OLD.state = 'queued'        AND NEW.state IN ('in_flight', 'in_review', 'stopped', 'merged', 'closed', 'cancelled'))
    OR (OLD.state = 'in_flight'     AND NEW.state IN ('queued', 'awaiting_work', 'in_review', 'stopped', 'merged', 'closed', 'cancelled'))
    OR (OLD.state = 'awaiting_work' AND NEW.state IN ('queued', 'in_review', 'stopped', 'merged', 'closed', 'cancelled'))
    OR (OLD.state = 'stopped'       AND NEW.state IN ('queued', 'in_review', 'merged', 'closed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'merge_queue_entries: that state move is not allowed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
