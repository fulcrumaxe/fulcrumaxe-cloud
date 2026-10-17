-- Decision asks: what happens when the answer window ends (D#7 DP12a-2, corrections DP-C5 and DP-C9).
--
-- An unanswered ask has exactly two ends (R1), never "denied": stop_and_flag moves it open -> overdue (the
-- question stays answerable), proceed_recommended moves it open -> proceeded on the option the agent proposed,
-- with a receipt whose actor is 'policy'. Two definers, both owned by receipt_writer with EXECUTE for
-- receipt_writer_invoker only (0663/0665/0666/0797/0826's split), and no account, user or actor parameter:
--
--   * decision_ask_due(now, limit)               The one cross-tenant read: which open asks are past their
--                                                 answer_due_at, as (ask id, account id) pairs. Nothing is locked or
--                                                 written. Skips accounts that are not active.
--   * decision_ask_time_out(ask, now, to, receipt)  One ask, under its own tenant (app.account_id), by the system
--                                                 (no app.user_id, no app.token_id): locks the row FOR UPDATE SKIP LOCKED,
--                                                 and moves it only if it is still open and past due. It returns false
--                                                 when it moved nothing (the row is locked by an answer or a withdrawal,
--                                                 or is no longer open): the caller rolls back whatever it wrote for it.
--                                                 'proceeded' is allowed only for a proceed_recommended ask that has a run,
--                                                 and only with the policy receipt written a moment earlier on the same
--                                                 transaction, whose chosen option is the ask's proposed option.
--
-- The answer (0797), the withdrawal (0826) and this move all go through the same compare-and-set on state, so an
-- ask has exactly one winner. `now` comes from the caller's clock so that a test can run on a fake one; a time
-- more than a minute ahead of the database clock is refused, so a caller cannot make a window end early.
-- Expand-only: column grants, no new table, no schema change.

-- What the definers read beyond 0797 and 0826's grants. The UPDATE grant and the tenant UPDATE policy are 0797's.
GRANT SELECT (answer_due_at, timeout_outcome, proposed) ON decision_asks TO receipt_writer;

-- The list has no session tenant, so account_is_active() cannot see the account row through 0663's tenant-bound policy and
-- would call every account inactive. This policy shows receipt_writer the account row (0663's columns: id and deleted_at,
-- nothing else) of an account that has an open ask, and no other. Without the active check, asks of a deleted account would
-- sit at the front of the oldest-first list and starve the rest.
CREATE POLICY receipt_writer_sweep_select ON accounts FOR SELECT TO receipt_writer
  USING (EXISTS (SELECT 1 FROM decision_asks a WHERE a.account_id = accounts.id AND a.state = 'open'));

-- Ownership bracket (0826's shape), then the definers.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'receipt_writer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on receipt_writer; cannot ALTER FUNCTION ... OWNER TO receipt_writer';
    END IF;
    GRANT receipt_writer TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO receipt_writer;

CREATE FUNCTION decision_ask_due(p_now timestamptz, p_limit integer)
RETURNS TABLE (o_ask_id uuid, o_account_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_now IS NULL OR p_now > clock_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'ask_sweep_bad_time: the time is missing or ahead of the database clock' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'ask_sweep_bad_limit: the limit is 1 to 500' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT a.id, a.account_id
    FROM public.decision_asks a
   WHERE a.state = 'open'
     AND a.answer_due_at <= p_now
     AND (SELECT public.account_is_active(a.account_id))
   ORDER BY a.answer_due_at, a.id
   LIMIT p_limit;
END;
$$;

CREATE FUNCTION decision_ask_time_out(p_ask_id uuid, p_now timestamptz, p_to text, p_receipt_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_token  text := NULLIF(current_setting('app.token_id', true), '');
  v_user   text := NULLIF(current_setting('app.user_id', true), '');
  v_ask    record;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'ask_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_token IS NOT NULL OR v_user IS NOT NULL THEN
    RAISE EXCEPTION 'ask_sweep_system_only: a window ends by the system, not by a person or a token' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_now IS NULL OR p_now > clock_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'ask_sweep_bad_time: the time is missing or ahead of the database clock' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_to IS NULL OR p_to NOT IN ('overdue', 'proceeded') THEN
    RAISE EXCEPTION 'ask_sweep_bad_outcome: the outcome is overdue or proceeded' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ask_id IS NULL THEN
    RETURN false;
  END IF;

  -- The claim. A row locked by an answer or a withdrawal, one that is no longer open, or one not yet due is not ours.
  SELECT a.id, a.decision_type, a.run_id, a.proposed, a.timeout_outcome INTO v_ask
    FROM public.decision_asks a
   WHERE a.id = p_ask_id AND a.account_id = v_tenant AND a.state = 'open' AND a.answer_due_at <= p_now
     FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_to = 'overdue' THEN
    IF p_receipt_id IS NOT NULL THEN
      RAISE EXCEPTION 'ask_receipt_mismatch: an overdue ask has no receipt' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    UPDATE public.decision_asks SET state = 'overdue' WHERE id = p_ask_id AND account_id = v_tenant AND state = 'open';
    RETURN true;
  END IF;

  IF v_ask.timeout_outcome <> 'proceed_recommended' THEN
    RAISE EXCEPTION 'ask_sweep_not_proceedable: this ask stops and flags when its window ends' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_ask.run_id IS NULL THEN
    RAISE EXCEPTION 'ask_no_run: the ask was raised without a run' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_receipt_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.decision_receipts r
        WHERE r.id = p_receipt_id AND r.account_id = v_tenant
          AND r.decision_type = v_ask.decision_type AND r.chosen = v_ask.proposed
          AND r.run_id = v_ask.run_id AND r.actor = 'policy')
     OR EXISTS (
       SELECT 1 FROM public.decision_asks o WHERE o.receipt_id = p_receipt_id AND o.id <> p_ask_id) THEN
    RAISE EXCEPTION 'ask_receipt_mismatch: the receipt is not the policy receipt for this ask' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- answered_by stays NULL (it is the person who answered); the policy receipt carries the actor.
  UPDATE public.decision_asks
     SET state = 'proceeded', answered_option = v_ask.proposed, answered_at = now(), receipt_id = p_receipt_id
   WHERE id = p_ask_id AND account_id = v_tenant AND state = 'open';
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION decision_ask_due(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision_ask_due(timestamptz, integer) TO receipt_writer_invoker;
ALTER FUNCTION decision_ask_due(timestamptz, integer) OWNER TO receipt_writer;
REVOKE ALL ON FUNCTION decision_ask_time_out(uuid, timestamptz, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision_ask_time_out(uuid, timestamptz, text, uuid) TO receipt_writer_invoker;
ALTER FUNCTION decision_ask_time_out(uuid, timestamptz, text, uuid) OWNER TO receipt_writer;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
