-- D#519 MQ4-a: round storage for merge-conflict fix rounds, and the one state move a conflict found on a queued entry needs. Inert: nothing writes
-- either yet.
--
-- 1. A conflict the tick finds on an entry that does NOT hold the slot (another entry may) has to send that entry to `awaiting_work` straight from
--    `queued`. The guard (0824, restated whole by 0825) allowed no such move. It now allows `queued -> awaiting_work` only when the same UPDATE sets
--    work_kind to `conflict` or `renumber`; a `delta_review` and a bare move stay refused. Every other move is unchanged.
-- 2. `merge_conflict_rounds`: one append-only row per round, keyed by work item (and by entry when there is one, so the direct path can use it with
--    no second migration). It is NOT head_refreshes: that table means "a verified update-branch commit" and the gate carries a reviewer's pass across
--    it. A conflict resolution must never carry a pass, so it gets its own record. from_sha, base_sha, base_ref and conflict_files are written once, by
--    the INSERT, and never change (no UPDATE grant). run_id, to_sha, outcome and ended_at are set later, each once (trigger).
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging.

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
    OR (OLD.state = 'queued'        AND NEW.state = 'awaiting_work' AND NEW.work_kind IN ('conflict', 'renumber'))
    OR (OLD.state = 'in_flight'     AND NEW.state IN ('queued', 'awaiting_work', 'in_review', 'stopped', 'merged', 'closed', 'cancelled'))
    OR (OLD.state = 'awaiting_work' AND NEW.state IN ('queued', 'in_review', 'stopped', 'merged', 'closed', 'cancelled'))
    OR (OLD.state = 'stopped'       AND NEW.state IN ('queued', 'in_review', 'merged', 'closed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'merge_queue_entries: that state move is not allowed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- An empty list passes (array_ndims is null for it): that is intended, for a round that rolls a branch back and has no conflicting file to name.
-- A repository-relative path a round may list: the context-rule path rule (0871) without the pin-only wildcard test, as a function a CHECK can call.
CREATE FUNCTION merge_conflict_paths_ok(p_paths text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT p_paths IS NOT NULL AND array_ndims(p_paths) = 1 AND cardinality(p_paths) <= 100
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p_paths) AS p(path)
        WHERE p.path IS NULL OR p.path = '' OR char_length(p.path) > 512
           OR p.path ~ '[[:cntrl:]]' OR p.path ~ ('[' || chr(133) || chr(8232) || chr(8233) || ']') OR strpos(p.path, chr(92)) > 0
           OR p.path ~ '^/' OR p.path ~ '^~(/|$)' OR p.path ~ '^[A-Za-z]:/'
           OR p.path ~ '(^|/)(\.|\.\.)?(/|$)'
     )
$$;

-- The CHECK below runs as the writing role (app_user), so it needs EXECUTE; PUBLIC does not (the gh-proxy login and platform_ops would inherit it).
REVOKE ALL ON FUNCTION merge_conflict_paths_ok(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_conflict_paths_ok(text[]) TO app_user;

CREATE TABLE merge_conflict_rounds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id        uuid NOT NULL,
  work_item_id   uuid NOT NULL,
  -- Null for a round with no queue entry (the direct path, MQ4-e).
  entry_id       uuid,
  round          integer NOT NULL CONSTRAINT merge_conflict_rounds_round_check CHECK (round BETWEEN 1 AND 20),
  -- The head before the round, the default-branch tip the round was asked to merge, and the branch it is.
  from_sha       text NOT NULL CONSTRAINT merge_conflict_rounds_from_check CHECK (from_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  base_sha       text NOT NULL CONSTRAINT merge_conflict_rounds_base_check CHECK (base_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  base_ref       text NOT NULL CONSTRAINT merge_conflict_rounds_base_ref_check CHECK (char_length(base_ref) BETWEEN 1 AND 255 AND base_ref !~ '[[:cntrl:]]'),
  conflict_files text[] NOT NULL CONSTRAINT merge_conflict_rounds_files_check CHECK (merge_conflict_paths_ok(conflict_files)),
  run_id         uuid,
  to_sha         text CONSTRAINT merge_conflict_rounds_to_check CHECK (to_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  outcome        text CONSTRAINT merge_conflict_rounds_outcome_check CHECK (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,

  CONSTRAINT merge_conflict_rounds_moved CHECK (to_sha IS NULL OR to_sha <> from_sha),
  CONSTRAINT merge_conflict_rounds_ended_shape CHECK ((outcome IS NULL) = (ended_at IS NULL)),
  UNIQUE (account_id, work_item_id, round),
  FOREIGN KEY (account_id, entry_id) REFERENCES merge_queue_entries (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);
CREATE INDEX merge_conflict_rounds_item ON merge_conflict_rounds (account_id, work_item_id, round);

-- created_at and ended_at are the database's clock: a client cannot choose either (the CI wait of a round is measured from ended_at). The three
-- later-set columns, once set, never change.
CREATE FUNCTION merge_conflict_rounds_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    IF NEW.outcome IS NOT NULL THEN NEW.ended_at := now(); END IF;
    RETURN NEW;
  END IF;
  IF (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id)
     OR (OLD.to_sha IS NOT NULL AND NEW.to_sha IS DISTINCT FROM OLD.to_sha)
     OR (OLD.outcome IS NOT NULL AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.ended_at IS DISTINCT FROM OLD.ended_at)) THEN
    RAISE EXCEPTION 'merge_conflict_rounds: a recorded fact is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.outcome IS NULL AND NEW.outcome IS NOT NULL THEN
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER merge_conflict_rounds_guard BEFORE INSERT OR UPDATE ON merge_conflict_rounds
  FOR EACH ROW EXECUTE FUNCTION merge_conflict_rounds_guard();

ALTER TABLE merge_conflict_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE merge_conflict_rounds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON merge_conflict_rounds TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON merge_conflict_rounds FROM PUBLIC;
GRANT SELECT, INSERT ON merge_conflict_rounds TO app_user;
GRANT UPDATE (run_id, to_sha, outcome, ended_at) ON merge_conflict_rounds TO app_user;
REVOKE ALL ON FUNCTION merge_conflict_rounds_guard() FROM PUBLIC;
