-- D#694 B7-1: a fifth runner capability, 'plane_merge_queue_v1', and a new terminal state of a merge order, 'enqueued'.
--
-- 1. 'plane_merge_queue_v1' says the runner can put a paired item's public pull request into GitHub's merge queue (a merge order whose code repository merges through a
--    queue). The cloud sends the order's merge mode only to a runner that lists it. The table's CHECK and runner_capabilities_record's closed list widen by one value,
--    from {'proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1'}; everything else of the function is 0940's, verbatim (the ADMIN-option bracket, the
--    pinned search_path, the grants).
-- 2. 'enqueued' is the state of an order whose pull request the runner put in the queue. It is terminal, it is reached only from 'authorized', and it needs the write
--    credential's issue time (as 'merged' does). It is never 'merged': the merge itself is GitHub's, recorded from its own events. The one-open index covers only
--    pending, claimed and authorized, so a new order can be placed for the item afterwards. The state CHECK, the finished-shape CHECK and the whole guard function
--    are restated here (the guard is 0912's, verbatim, but for the two places 'enqueued' is added).
--
-- Expand-only: two lists widen by one value and one new state is allowed. Numbered above 0946; re-check before the pull request is opened and before merging.

ALTER TABLE plane_merge_orders DROP CONSTRAINT plane_merge_orders_state_check;
ALTER TABLE plane_merge_orders ADD CONSTRAINT plane_merge_orders_state_check CHECK (state IN
  ('pending', 'claimed', 'authorized', 'merged', 'enqueued', 'blocked', 'head_moved', 'superseded', 'failed', 'expired'));
ALTER TABLE plane_merge_orders DROP CONSTRAINT plane_merge_orders_finished_shape;
ALTER TABLE plane_merge_orders ADD CONSTRAINT plane_merge_orders_finished_shape CHECK (
  (state IN ('merged', 'enqueued', 'blocked', 'head_moved', 'superseded', 'failed', 'expired')) = (finished_at IS NOT NULL)
  AND (finished_at IS NULL OR outcome_code IS NOT NULL));
ALTER TABLE plane_merge_orders ADD CONSTRAINT plane_merge_orders_enqueued_shape CHECK (state <> 'enqueued' OR write_token_issued_at IS NOT NULL);

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
  IF OLD.state IN ('merged', 'enqueued', 'blocked', 'head_moved', 'superseded', 'failed', 'expired') THEN
    RAISE EXCEPTION 'plane_merge_orders: a finished order does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'pending'    AND NEW.state IN ('claimed', 'blocked', 'superseded', 'expired'))
    OR (OLD.state = 'claimed'    AND NEW.state IN ('pending', 'authorized', 'blocked', 'head_moved', 'superseded', 'failed', 'expired'))
    OR (OLD.state = 'authorized' AND NEW.state IN ('merged', 'enqueued', 'head_moved', 'superseded', 'failed', 'expired'))) THEN
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

ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1']::text[]));

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_capabilities_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_capabilities_definer; cannot replace runner_capabilities_record';
    END IF;
    EXECUTE 'GRANT runner_capabilities_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION runner_capabilities_record(p_capabilities text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_capabilities_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A live runner of an active account, named by the session: no runner in the session, a revoked one or another account's one writes nothing.
  IF acct IS NULL OR NOT account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'runner_capabilities_record: the session is not a live runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Closed codes, each once, a flat list: anything else is refused, not repaired, so what is stored is exactly what was sent.
  IF p_capabilities IS NULL OR (cardinality(p_capabilities) > 0 AND array_ndims(p_capabilities) <> 1)
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1']))
     OR (SELECT count(*) <> count(DISTINCT c) FROM unnest(p_capabilities) c) THEN
    RAISE EXCEPTION 'runner_capabilities_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.runner_capabilities AS c (runner_id, account_id, capabilities)
  VALUES (raw::uuid, acct, p_capabilities)
  ON CONFLICT (runner_id) DO UPDATE SET capabilities = EXCLUDED.capabilities, reported_at = now();
END;
$$;
REVOKE ALL ON FUNCTION runner_capabilities_record(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_capabilities_record(text[]) TO app_user;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE 'REVOKE runner_capabilities_definer FROM CURRENT_USER';
  END IF;
END
$$;
