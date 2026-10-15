-- D#519 MQ2: the per-repo merge queue's storage. Two tables, one cross-tenant lister, no change to any existing object.
--
--   merge_queue_entries   one row per work item's pull request that has finished review and wants to merge. The row is the queue: its
--                         order, who holds the repo's merge slot, until when, and what it waits on. It is the ONLY state; nothing lives in
--                         process memory or an advisory lock, so a restart or a redeploy continues the same order.
--   head_refreshes        append-only record of a platform refresh (GitHub's update-branch): from head, to head, the default-branch commit
--                         merged in. MQ3 writes it after it has verified the new head; MQ2 only creates the table and its writer's shape.
--
-- The slot. "At most one merge in flight per repo" is enforced by the database, not by application code: a partial unique index over
-- (account_id, repo_id) WHERE state = 'in_flight'. A holder also carries a lease (lease_until). Every queue step renews it; a step that
-- crashes lets it lapse and the sweep (or the next tick) returns the entry to 'queued'. Holding the slot covers deterministic work only:
-- an entry that needs an agent run (conflict fix, renumber, delta review) leaves 'in_flight' for 'awaiting_work' in the same UPDATE that
-- records the round, so no slot is ever held across an agent run.
--
-- States (a CHECK; the transition table is a trigger below):
--   in_review      the entry exists but its head is not (or no longer) the reviewed head. Not eligible. approved_at is kept.
--   queued         approved on `head_sha`, waiting for the slot (or for a dependency or an open/not-draft PR: those are derived at tick
--                  time from GitHub and from other entries, never stored).
--   in_flight      holds the slot; slot_holder, lease_until and slot_taken_at are set (and only then). `phase` is a free snake_case word
--                  the holder records (refresh, ci, gate, ...); MQ3 owns the words.
--   awaiting_work  released the slot for an agent run of work_kind conflict | renumber | delta_review; re-enters 'queued' when it ends.
--   stopped        needs a person; `reason` is the fixed block code (snake_case, never text from GitHub or a model).
--   merged         final. merged_by says whether the gate merged it or a person did outside the queue.
--   closed         final: the PR was closed without merging.
--   cancelled      final: the item was cancelled, or the repo was disconnected; `reason` says which.
--
-- approved_at is a one-time stamp: the moment the item's reviewers first all passed. It is never updated (a trigger refuses it), so an
-- entry that goes away for a fix and comes back keeps its fairness position. The queue's order is (approved_at, pr_number).
--
-- Room for later entry kinds (D#598 R-598-P5b-3 adds a platform plan write-back kind). Nothing here is keyed on being a work item except
-- the work_item_id column itself: order, slot, lease, states and the lister never read it. A later migration relaxes work_item_id to
-- nullable and adds its own kind column and exactly-one-of check; relaxing NOT NULL is expand-safe, so nothing here needs to change first.
--
-- Who may touch what. app_user, tenant-isolated like work_item_driver_events (0709): SELECT, INSERT, UPDATE on entries; SELECT, INSERT on
-- head_refreshes; nobody deletes (an entry ends in a final state, and a work item or repo delete cascades). platform_ops gains nothing.
-- The one cross-tenant read, the sweep's lister, is a SECURITY DEFINER function owned by merge_queue_sweep_definer (NOLOGIN, no members
-- outside this file, column SELECT on five columns of one table, a row policy for this role only), EXECUTE for agent_run_writer, the
-- login the existing sweeps run as (the 0776 shape).
--
-- Numbered above the highest migration claimed on the code plane. Re-check against main right before merging.

DO $$
DECLARE
  n text := 'merge_queue_sweep_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

CREATE TABLE merge_queue_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id              uuid NOT NULL,
  work_item_id         uuid NOT NULL,
  pr_number            integer NOT NULL CONSTRAINT merge_queue_entries_pr_check CHECK (pr_number > 0),
  -- The head the reviewers passed. Replaced only when the item is enqueued again on a new reviewed head.
  head_sha             text NOT NULL CONSTRAINT merge_queue_entries_head_check CHECK (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  -- A stacked PR: the number of the open PR (same repo) its base branch points at. The entry waits while that PR's entry is not merged.
  depends_on_pr_number integer CONSTRAINT merge_queue_entries_dep_check CHECK (depends_on_pr_number > 0 AND depends_on_pr_number <> pr_number),
  approved_at          timestamptz NOT NULL,
  state                text NOT NULL DEFAULT 'queued'
                         CONSTRAINT merge_queue_entries_state_check CHECK (state IN
                           ('in_review', 'queued', 'in_flight', 'awaiting_work', 'stopped', 'merged', 'closed', 'cancelled')),
  phase                text CONSTRAINT merge_queue_entries_phase_check CHECK (phase ~ '^[a-z][a-z0-9_]{0,63}$'),
  work_kind            text CONSTRAINT merge_queue_entries_work_kind_check CHECK (work_kind IN ('conflict', 'renumber', 'delta_review')),
  -- The agent run the round started, when the caller has one. Informational: no foreign key, so a final entry never has to be updated.
  work_run_id          uuid,
  slot_holder          text CONSTRAINT merge_queue_entries_holder_check CHECK (length(slot_holder) BETWEEN 1 AND 100),
  lease_until          timestamptz,
  slot_taken_at        timestamptz,
  refresh_count        integer NOT NULL DEFAULT 0 CONSTRAINT merge_queue_entries_refresh_check CHECK (refresh_count >= 0),
  conflict_rounds      integer NOT NULL DEFAULT 0 CONSTRAINT merge_queue_entries_rounds_check CHECK (conflict_rounds >= 0),
  reason               text CONSTRAINT merge_queue_entries_reason_check CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  merged_by            text CONSTRAINT merge_queue_entries_merged_by_check CHECK (merged_by IN ('gate', 'person')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id, id),
  -- One entry per item for its whole life (approved_at is stable across fixes) and one per pull request.
  UNIQUE (account_id, work_item_id),
  UNIQUE (account_id, repo_id, pr_number),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,

  -- The slot columns exist exactly while the entry holds the slot.
  CONSTRAINT merge_queue_entries_slot_shape CHECK (
    (state = 'in_flight') = (slot_holder IS NOT NULL AND lease_until IS NOT NULL AND slot_taken_at IS NOT NULL)
    AND (slot_holder IS NULL) = (lease_until IS NULL)
    AND (slot_holder IS NULL) = (slot_taken_at IS NULL)
  ),
  CONSTRAINT merge_queue_entries_phase_shape CHECK (phase IS NULL OR state = 'in_flight'),
  CONSTRAINT merge_queue_entries_work_shape CHECK ((state = 'awaiting_work') = (work_kind IS NOT NULL) AND (work_run_id IS NULL OR state = 'awaiting_work')),
  CONSTRAINT merge_queue_entries_reason_shape CHECK (state IN ('stopped', 'cancelled') OR reason IS NULL),
  CONSTRAINT merge_queue_entries_stopped_reason CHECK (state <> 'stopped' OR reason IS NOT NULL),
  CONSTRAINT merge_queue_entries_merged_shape CHECK ((state = 'merged') = (merged_by IS NOT NULL))
);

-- The database's own guarantee of one merge in flight per repo.
CREATE UNIQUE INDEX merge_queue_one_in_flight ON merge_queue_entries (account_id, repo_id) WHERE state = 'in_flight';
-- The queue read: a repo's live entries in order.
CREATE INDEX merge_queue_entries_order ON merge_queue_entries (account_id, repo_id, approved_at, pr_number)
  WHERE state IN ('in_review', 'queued', 'in_flight', 'awaiting_work', 'stopped');
-- A stacked child finds its parent by number.
CREATE INDEX merge_queue_entries_dependents ON merge_queue_entries (account_id, repo_id, depends_on_pr_number) WHERE depends_on_pr_number IS NOT NULL;
-- The sweep's reclaim.
CREATE INDEX merge_queue_entries_lease ON merge_queue_entries (lease_until) WHERE state = 'in_flight';

-- created_at and updated_at are always the database's own clock.
CREATE FUNCTION merge_queue_entries_clock() RETURNS trigger
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

-- What may change, and in which order. Identity and the fairness stamp never change; a final row never changes; the counters never go
-- down; the states move only along the table below (a move to the same state is a field update and is allowed).
CREATE FUNCTION merge_queue_entries_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.repo_id IS DISTINCT FROM OLD.repo_id
     OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
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

CREATE TRIGGER merge_queue_entries_clock BEFORE INSERT OR UPDATE ON merge_queue_entries
  FOR EACH ROW EXECUTE FUNCTION merge_queue_entries_clock();
CREATE TRIGGER merge_queue_entries_guard BEFORE UPDATE ON merge_queue_entries
  FOR EACH ROW EXECUTE FUNCTION merge_queue_entries_guard();

ALTER TABLE merge_queue_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE merge_queue_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON merge_queue_entries TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON merge_queue_entries FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON merge_queue_entries TO app_user;

-- ---- head_refreshes ----------------------------------------------------------------------------------------------------------
CREATE TABLE head_refreshes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id      uuid NOT NULL,
  work_item_id uuid NOT NULL,
  entry_id     uuid NOT NULL,
  -- The reviewed head, the head after the platform's update-branch merge, and the default-branch commit that merge brought in.
  from_sha     text NOT NULL CONSTRAINT head_refreshes_from_check CHECK (from_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  to_sha       text NOT NULL CONSTRAINT head_refreshes_to_check CHECK (to_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  base_sha     text NOT NULL CONSTRAINT head_refreshes_base_check CHECK (base_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT head_refreshes_moved CHECK (from_sha <> to_sha),
  -- A refresh is recorded once.
  UNIQUE (account_id, entry_id, to_sha),
  FOREIGN KEY (account_id, entry_id) REFERENCES merge_queue_entries (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);
CREATE INDEX head_refreshes_entry ON head_refreshes (account_id, entry_id, created_at);

CREATE FUNCTION head_refreshes_clock() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER head_refreshes_clock BEFORE INSERT ON head_refreshes
  FOR EACH ROW EXECUTE FUNCTION head_refreshes_clock();

ALTER TABLE head_refreshes ENABLE ROW LEVEL SECURITY;
ALTER TABLE head_refreshes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON head_refreshes TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON head_refreshes FROM PUBLIC;
GRANT SELECT, INSERT ON head_refreshes TO app_user;

-- ---- the sweep's lister ------------------------------------------------------------------------------------------------------
-- Cross-tenant, ids only. Lists the repos that need a queue tick: one whose slot lease has lapsed, or one with a queued entry and no
-- live holder. `p_now` is passed in (the caller's clock is injectable); the limit is clamped to 1..200; the oldest-touched repos come
-- first. Nothing else leaves it: no PR number, head or reason.
GRANT USAGE ON SCHEMA public TO merge_queue_sweep_definer;
GRANT SELECT (account_id, repo_id, state, lease_until, updated_at) ON merge_queue_entries TO merge_queue_sweep_definer;
CREATE POLICY merge_queue_sweep_select ON merge_queue_entries FOR SELECT TO merge_queue_sweep_definer USING (true);

CREATE FUNCTION merge_queue_sweep_targets(p_now timestamptz, p_limit int)
RETURNS TABLE (account_id uuid, repo_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT e.account_id, e.repo_id
    FROM public.merge_queue_entries e
   WHERE (e.state = 'in_flight' AND e.lease_until <= p_now)
      OR (e.state = 'queued'
          AND NOT EXISTS (SELECT 1 FROM public.merge_queue_entries h
                           WHERE h.account_id = e.account_id AND h.repo_id = e.repo_id
                             AND h.state = 'in_flight' AND h.lease_until > p_now))
   GROUP BY e.account_id, e.repo_id
   ORDER BY min(e.updated_at), e.account_id, e.repo_id
   LIMIT LEAST(GREATEST(p_limit, 1), 200)
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'merge_queue_sweep_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on merge_queue_sweep_definer; cannot ALTER FUNCTION ... OWNER TO merge_queue_sweep_definer';
    END IF;
    GRANT merge_queue_sweep_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO merge_queue_sweep_definer;

REVOKE ALL ON FUNCTION merge_queue_sweep_targets(timestamptz, int) FROM PUBLIC;
ALTER FUNCTION merge_queue_sweep_targets(timestamptz, int) OWNER TO merge_queue_sweep_definer;
GRANT EXECUTE ON FUNCTION merge_queue_sweep_targets(timestamptz, int) TO agent_run_writer;

REVOKE CREATE ON SCHEMA public FROM merge_queue_sweep_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE merge_queue_sweep_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- The trigger functions are ours only; nobody calls them.
REVOKE ALL ON FUNCTION merge_queue_entries_clock() FROM PUBLIC;
REVOKE ALL ON FUNCTION merge_queue_entries_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION head_refreshes_clock() FROM PUBLIC;
