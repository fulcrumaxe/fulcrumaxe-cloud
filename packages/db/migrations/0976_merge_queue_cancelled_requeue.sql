-- D#483 S5-j2b: an item that was cancelled and then resumed goes back in the merge queue on its own entry. The guard (0824, restated whole by 0825 and 0948)
-- treated `cancelled` as final. It now allows exactly one move out of it: `cancelled -> queued`. `merged` and `closed` stay final, `approved_at` and the
-- identity columns stay fixed, and every other move is unchanged. Whether the item is halted is checked by `enqueueEntry`'s own UPDATE, not here.
--
-- Numbered above the highest migration on the code plane and on every open pull request (0974, 0975). Merge after the per-repository merge lease (0975).
-- Re-check against main right before merging.

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
  IF OLD.state IN ('merged', 'closed') OR (OLD.state = 'cancelled' AND NEW.state <> 'queued') THEN
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
    OR (OLD.state = 'cancelled'     AND NEW.state = 'queued')
  ) THEN
    RAISE EXCEPTION 'merge_queue_entries: that state move is not allowed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
