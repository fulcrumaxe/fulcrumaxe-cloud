-- D#519 MQ4-e2-b: the runner's conflict verdict, stored on the merge order it ended.
--
-- When the runner's merge call is refused with a 405, its report may carry a closed verdict about the private pull request (MQ4-e2-a). The cloud keeps it on the order it ends: four
-- nullable columns, all set or all null, set in the same statement as the order's end and never changed. Only the two verdicts that act are stored (`conflict_platform`,
-- `conflict_foreign`); `unknown` and a report with no field store nothing and the order ends as it always did. The columns hold shas, a ref name and at most 100 paths, held to the
-- detail table's own rules (0957 `driver_event_paths_ok`, `driver_event_ref_ok`); no content. The guard is 0947's, verbatim but for the two places the columns are added.
--
-- Expand-only: four nullable columns and CHECKs, and one function replaced. The number is a placeholder above main's highest (0965) and the numbers open work holds (0967, 0968, 0969);
-- the Team Lead renumbers it before merge.

ALTER TABLE plane_merge_orders ADD COLUMN conflict_verdict text, ADD COLUMN conflict_base_sha text, ADD COLUMN conflict_base_ref text, ADD COLUMN conflict_files text[];
-- The ref and path rules are the shared SQL functions of 0957. Those two CHECKs are NOT VALID: the columns are new and all null, so there is nothing to validate, and the functions' character ranges need a UTF-8
-- database (the Neon-shape harness's cluster is SQL_ASCII and cannot even plan them). Every new write is held to them either way.
ALTER TABLE plane_merge_orders
  ADD CONSTRAINT plane_merge_orders_conflict_verdict_check CHECK (conflict_verdict IN ('conflict_platform', 'conflict_foreign')),
  ADD CONSTRAINT plane_merge_orders_conflict_base_sha_check CHECK (conflict_base_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  ADD CONSTRAINT plane_merge_orders_conflict_base_ref_check CHECK (driver_event_ref_ok(conflict_base_ref)) NOT VALID,
  ADD CONSTRAINT plane_merge_orders_conflict_files_check CHECK (conflict_files IS NULL OR (cardinality(conflict_files) BETWEEN 1 AND 100 AND driver_event_paths_ok(conflict_files))) NOT VALID;

-- All four or none; only a failed order carries them, with the code that matches the verdict.
ALTER TABLE plane_merge_orders ADD CONSTRAINT plane_merge_orders_conflict_shape CHECK (
  (conflict_verdict IS NULL AND conflict_base_sha IS NULL AND conflict_base_ref IS NULL AND conflict_files IS NULL)
  OR (conflict_verdict IS NOT NULL AND conflict_base_sha IS NOT NULL AND conflict_base_ref IS NOT NULL AND conflict_files IS NOT NULL AND state = 'failed' AND write_token_issued_at IS NOT NULL
      AND outcome_code = CASE conflict_verdict WHEN 'conflict_platform' THEN 'merge_conflict_runner' ELSE 'merge_conflict_foreign' END));

CREATE OR REPLACE FUNCTION plane_merge_orders_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'pending' OR NEW.runner_id IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.lease_generation <> 0 OR NEW.attempts <> 0
       OR NEW.read_token_generation IS NOT NULL OR NEW.write_token_issued_at IS NOT NULL OR NEW.outcome_code IS NOT NULL OR NEW.finished_at IS NOT NULL
       OR NEW.conflict_verdict IS NOT NULL OR NEW.conflict_base_sha IS NOT NULL OR NEW.conflict_base_ref IS NOT NULL OR NEW.conflict_files IS NOT NULL THEN
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
  IF OLD.state IN ('merged', 'enqueued', 'blocked', 'head_moved', 'superseded', 'failed', 'expired') THEN
    RAISE EXCEPTION 'plane_merge_orders: a finished order does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'pending'    AND NEW.state IN ('claimed', 'blocked', 'superseded', 'expired'))
    OR (OLD.state = 'claimed'    AND NEW.state IN ('pending', 'authorized', 'blocked', 'head_moved', 'superseded', 'failed', 'expired'))
    OR (OLD.state = 'authorized' AND NEW.state IN ('merged', 'enqueued', 'head_moved', 'superseded', 'failed', 'expired'))) THEN
    RAISE EXCEPTION 'plane_merge_orders: % cannot become %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  -- The runner's verdict is written once, in the statement that ends the order, and never changes.
  IF (NEW.conflict_verdict, NEW.conflict_base_sha, NEW.conflict_base_ref, NEW.conflict_files) IS DISTINCT FROM (OLD.conflict_verdict, OLD.conflict_base_sha, OLD.conflict_base_ref, OLD.conflict_files)
     AND NEW.state IN ('pending', 'claimed', 'authorized') THEN
    RAISE EXCEPTION 'plane_merge_orders: the conflict verdict is written with the order''s end' USING ERRCODE = 'check_violation';
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

