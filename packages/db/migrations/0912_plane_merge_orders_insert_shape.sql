-- D#6 PUBLIC-MERGE PR2b: an order is born pending. 0910's guard enforced the table of moves on UPDATE but let an INSERT choose any state and any counters, so a
-- row could be written already claimed, authorized or merged and skip the table. The guard now holds the INSERT to the one starting shape: pending, no runner,
-- no lease, generation and attempts zero, no credential marks, no outcome, not finished. Together with the update rules that makes the table of moves complete
-- in the database itself, whatever code writes the row.
--
-- Only the INSERT branch of plane_merge_orders_guard() changes; the rest of the function is 0910's, verbatim. Same signature, owner, pinned search_path and grants
-- (CREATE OR REPLACE keeps them). Expand-only: a stricter rule on a table no runner build writes yet. Numbered above 0911; re-check before merging.

CREATE OR REPLACE FUNCTION plane_merge_orders_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'pending' OR NEW.runner_id IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.lease_generation <> 0 OR NEW.attempts <> 0
       OR NEW.read_token_generation IS NOT NULL OR NEW.write_token_issued_at IS NOT NULL OR NEW.outcome_code IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'plane_merge_orders: an order is inserted pending, unleased and unfinished' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
     OR NEW.plane_push_id IS DISTINCT FROM OLD.plane_push_id OR NEW.repo_id IS DISTINCT FROM OLD.repo_id OR NEW.code_repo IS DISTINCT FROM OLD.code_repo
     OR NEW.pr_number IS DISTINCT FROM OLD.pr_number OR NEW.expected_public_head IS DISTINCT FROM OLD.expected_public_head
     OR NEW.reviewed_head IS DISTINCT FROM OLD.reviewed_head OR NEW.pairing_digest IS DISTINCT FROM OLD.pairing_digest
     OR NEW.token_purpose IS DISTINCT FROM OLD.token_purpose OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'plane_merge_orders: identity is fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('merged', 'blocked', 'head_moved', 'superseded', 'failed', 'expired') THEN
    RAISE EXCEPTION 'plane_merge_orders: a finished order does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'pending'    AND NEW.state IN ('claimed', 'blocked', 'superseded', 'expired'))
    OR (OLD.state = 'claimed'    AND NEW.state IN ('pending', 'authorized', 'blocked', 'head_moved', 'superseded', 'failed', 'expired'))
    OR (OLD.state = 'authorized' AND NEW.state IN ('merged', 'head_moved', 'superseded', 'failed', 'expired'))) THEN
    RAISE EXCEPTION 'plane_merge_orders: % cannot become %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lease_generation < OLD.lease_generation OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'plane_merge_orders: the lease generation and the attempts only grow' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.write_token_issued_at IS NOT NULL AND NEW.write_token_issued_at IS DISTINCT FROM OLD.write_token_issued_at THEN
    RAISE EXCEPTION 'plane_merge_orders: the write credential is issued once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.read_token_generation IS NOT NULL AND NEW.read_token_generation IS DISTINCT FROM GREATEST(OLD.read_token_generation, COALESCE(NEW.read_token_generation, 0)) THEN
    RAISE EXCEPTION 'plane_merge_orders: the read credential generation only grows' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
