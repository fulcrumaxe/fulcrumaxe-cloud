-- ASK-WIRE-1: when does the next open ask's answer window end? The invariant sweep's cron gate keeps one marker per sweep, and a marker
-- for a later time never replaces an earlier one (pendingWork.ts markWorkPending). So after a tick moves the asks that are due, it needs
-- to read the soonest window still ahead and store that as the marker again; otherwise a second ask raised while the first was waiting
-- would be left to the half-hour backstop. This is the cross-tenant read for that, and nothing else.
--
-- decision_ask_next_due(now): the earliest answer_due_at after `now` among open asks of active accounts, or NULL. A read only: no row id,
-- no account id, no text leaves it. Owned by platform_ops (the neon-shape rule for a definer with no entry of its own; 0860's
-- resume_decision_reconcile is the precedent), EXECUTE for receipt_writer_invoker only, as decision_ask_due (0853). A `now` more than a minute ahead of the database clock is refused, as in 0853.
-- Expand-only: one new function.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

-- What platform_ops is given for this, and nothing else: the answer_due_at column of decision_asks (0860 already gave it id, account_id and state) and a
-- policy that shows it open asks, only to a session that is not a platform_ops login (the same guard as 0860's), so only a definer it owns, called by
-- another role, reads them. accounts needs nothing new: platform_ops_full_access (0001) already lets account_is_active() see the account row.
GRANT SELECT (answer_due_at) ON decision_asks TO platform_ops;
CREATE POLICY platform_ops_ask_next_due_select ON decision_asks FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops' AND state = 'open');

CREATE FUNCTION decision_ask_next_due(p_now timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_next timestamptz;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'decision_ask_next_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_now IS NULL OR p_now > clock_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'ask_sweep_bad_time: the time is missing or ahead of the database clock' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT min(a.answer_due_at) INTO v_next
    FROM public.decision_asks a
   WHERE a.state = 'open'
     AND a.answer_due_at > p_now
     AND (SELECT public.account_is_active(a.account_id));
  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION decision_ask_next_due(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision_ask_next_due(timestamptz) TO receipt_writer_invoker;
ALTER FUNCTION decision_ask_next_due(timestamptz) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
