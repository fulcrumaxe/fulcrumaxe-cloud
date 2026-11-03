-- D#598 P1g-2: the platform raises "someone pushed to the public branch" itself, and stores the head the person was shown.
--
-- A fix round that finds the item's public branch somewhere other than where the platform left it pauses the item and asks a person what to do
-- (keep their version, replace it, withdraw). Today nothing creates that request: 0856 only lets an `agent` row exist for this kind, and an agent
-- row needs a person to be its creator. The request is raised from facts the platform observed on GitHub, never proposed by a model, so it is a
-- `derived` row (recomputed from current state, no creator), like the parity-drift request, and only for this kind.
--
-- seen_head is the branch head the platform saw when it raised the request (a full sha, never text from a commit). A later confirmed Replace takes
-- its lease on exactly this head, so a push between the request and the confirmation refuses again. A newer push while the request is open
-- moves seen_head and the words with it (an open derived request may be refreshed; nothing else about it moves). It is set only on this kind.
--
-- Who may write: the person's own session still resolves (Keep, Withdraw) as before. The platform's raise and refresh carry no person, because the
-- code that sees the branch (a fix round's start, or a round's end) runs without one. A row policy therefore lets a no-person INSERT through only
-- for a derived branch_pushed_by_person row whose work item has a public push record in the same account, in the state a pushed pull request is in;
-- and a no-person UPDATE only on such a row and only to what the guard allows (refresh, or close as `condition_cleared`). Every other row, kind and
-- write keeps the policies of 0856 exactly (restated below, with the added branch the only difference).
--
-- Expand-only: one nullable column, constraints and policies widened to admit a row that was refused before; nothing is dropped from the data.
-- Numbered above the highest migration on the code plane and the open PRs' claims; re-checked right before opening.

ALTER TABLE setup_requests
  ADD COLUMN seen_head text CONSTRAINT setup_requests_seen_head_check CHECK (seen_head ~ '^([0-9a-f]{40}|[0-9a-f]{64})$');

ALTER TABLE setup_requests DROP CONSTRAINT setup_requests_origin_shape;
ALTER TABLE setup_requests ADD CONSTRAINT setup_requests_origin_shape CHECK (
  (origin = 'derived' AND kind = 'parity_drift' AND created_by IS NULL AND check_kind IS NULL AND seen_head IS NULL)
  OR (origin = 'derived' AND kind = 'branch_pushed_by_person' AND created_by IS NULL AND check_kind IS NULL AND work_item_id IS NOT NULL AND seen_head IS NOT NULL)
  OR (origin = 'agent' AND kind <> 'parity_drift' AND created_by IS NOT NULL AND seen_head IS NULL));

CREATE OR REPLACE FUNCTION setup_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.account_id, NEW.repo_id, NEW.work_item_id, NEW.origin, NEW.kind, NEW.env_name, NEW.target_environment, NEW.provider_url, NEW.check_kind, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.repo_id, OLD.work_item_id, OLD.origin, OLD.kind, OLD.env_name, OLD.target_environment, OLD.provider_url, OLD.check_kind, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'setup_requests_frozen: a request''s identity and stamped terms cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'withdrawn' THEN
    RAISE EXCEPTION 'setup_requests_terminal: a withdrawn request cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.target, NEW.reason, NEW.seen_head) IS DISTINCT FROM (OLD.target, OLD.reason, OLD.seen_head)
     AND NOT (OLD.origin = 'derived' AND OLD.state = 'open' AND NEW.state = 'open') THEN
    RAISE EXCEPTION 'setup_requests_frozen: only an open derived request may be refreshed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT ((OLD.state = 'open' AND NEW.state IN ('done', 'withdrawn'))
         OR (OLD.state = 'done' AND NEW.state = 'open' AND OLD.check_kind IS NOT NULL AND NEW.check_reason IS NOT NULL)) THEN
      RAISE EXCEPTION 'setup_requests_illegal_transition: % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state <> 'open' THEN
      NEW.resolved_at := now();
    END IF;
  ELSIF (NEW.resolution, NEW.resolved_by, NEW.resolved_at) IS DISTINCT FROM (OLD.resolution, OLD.resolved_by, OLD.resolved_at) THEN
    RAISE EXCEPTION 'setup_requests_frozen: a resolution cannot change without a transition' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP POLICY tenant_insert ON setup_requests;
CREATE POLICY tenant_insert ON setup_requests
  FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND state = 'open'
    AND (
      EXISTS (
        SELECT 1 FROM account_members m
        WHERE m.account_id = setup_requests.account_id
          AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
          AND (origin = 'derived' OR (m.role IN ('owner', 'admin') AND created_by = m.user_id))
      )
      OR (
        origin = 'derived' AND kind = 'branch_pushed_by_person'
        AND EXISTS (
          SELECT 1 FROM plane_pushes p
          WHERE p.account_id = setup_requests.account_id AND p.work_item_id = setup_requests.work_item_id AND p.repo_id = setup_requests.repo_id
            AND p.state IN ('pr_opened', 'waiting_person_pushed') AND p.managed_by_person_at IS NULL
        )
      )
    )
  );

DROP POLICY tenant_update ON setup_requests;
CREATE POLICY tenant_update ON setup_requests
  FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (
      (origin = 'derived' AND kind = 'branch_pushed_by_person' AND resolved_by IS NULL)
      OR EXISTS (
        SELECT 1 FROM account_members m
        WHERE m.account_id = setup_requests.account_id
          AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
          AND (resolved_by IS NULL OR (m.role IN ('owner', 'admin') AND resolved_by = m.user_id))
      )
    )
  );

GRANT UPDATE (seen_head) ON setup_requests TO app_user;
