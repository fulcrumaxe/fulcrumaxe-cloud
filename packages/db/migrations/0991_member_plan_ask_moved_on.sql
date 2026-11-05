-- D#7 DW-R7 follow-up: a member-plan ask whose run has moved on is withdrawn by the sweep.
--
-- A `runner_run_on_member_plan` ask is open while its run waits (pending, unapproved, unclaimed). Once the run is approved some other way (the Runs card, or the
-- claim's own approval), claimed, cancelled or finished, nobody can answer the ask (a Yes or a No is refused as moot) and Needs you no longer lists it, yet the
-- row stayed open: the item read as waiting on an answer, the stalled row was hidden, the continuation was held, and the tick moved it to overdue and owed a
-- reminder about a question nobody can see. The withdraw sweep (0826) now closes such an ask, with a new reason:
--
--   decision_asks_withdrawn_reason_known   the CHECK gains `run_moved_on` (the one value added; the stored reasons stay valid).
--   decision_ask_withdraw(limit)           0826's body, plus one condition: a member-plan ask whose run is not (pending and unapproved and unclaimed) is due, with
--                                          reason `run_moved_on` (item closed, halted and superseded still win over it, in that order). It is derived from the
--                                          run's current state, never a stamp, so an ask already stuck on a live database is cleared by the next tick. The tick runs
--                                          withdrawals before the overdue pass, so no overdue event and no reminder follow.
--   receipt_writer                         column SELECT on agent_runs (status, approved_by, runner_id), the three columns the new condition reads. The sweep's
--                                          existing row policy (rows of an item that has an open or overdue ask) is the only row access it has; nothing else changes.
--
-- Owner, grants and signature of the function are unchanged (CREATE OR REPLACE): owned by receipt_writer, EXECUTE for receipt_writer_invoker only. Expand-only
-- apart from widening one CHECK. Numbered above 0990, the highest claimed by an open pull request; re-checked right before opening.

ALTER TABLE decision_asks DROP CONSTRAINT decision_asks_withdrawn_reason_known;
ALTER TABLE decision_asks
  ADD CONSTRAINT decision_asks_withdrawn_reason_known
    CHECK (withdrawn_reason IS NULL OR withdrawn_reason IN ('item_closed', 'item_halted', 'superseded', 'run_moved_on'));

GRANT SELECT (status, approved_by, runner_id) ON agent_runs TO receipt_writer;

-- Ownership bracket (0826's shape).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'receipt_writer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on receipt_writer; cannot replace its function';
    END IF;
    GRANT receipt_writer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION decision_ask_withdraw(p_limit integer)
RETURNS TABLE (o_ask_id uuid, o_reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'ask_withdraw_bad_limit: the limit is 1 to 500' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT a.id AS due_id,
           CASE WHEN w.stage IN ('merged', 'closed_unmerged', 'closed') THEN 'item_closed'
                WHEN w.halted_at IS NOT NULL THEN 'item_halted'
                WHEN EXISTS (
                  SELECT 1 FROM public.agent_runs r2
                   WHERE r2.account_id = a.account_id AND r2.work_item_id = a.work_item_id AND r2.role = 'executor'
                     AND r2.created_at > COALESCE(
                       (SELECT r1.created_at FROM public.agent_runs r1 WHERE r1.account_id = a.account_id AND r1.id = a.run_id),
                       a.raised_at)) THEN 'superseded'
                ELSE 'run_moved_on' END AS due_why
      FROM public.decision_asks a
      JOIN public.work_items w ON w.account_id = a.account_id AND w.id = a.work_item_id
     WHERE a.state IN ('open', 'overdue')
       AND (
         w.stage IN ('merged', 'closed_unmerged', 'closed')
         OR w.halted_at IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM public.agent_runs r2
            WHERE r2.account_id = a.account_id AND r2.work_item_id = a.work_item_id AND r2.role = 'executor'
              AND r2.created_at > COALESCE(
                (SELECT r1.created_at FROM public.agent_runs r1 WHERE r1.account_id = a.account_id AND r1.id = a.run_id),
                a.raised_at))
         -- A member-plan ask waits only while its run does: pending, unapproved and unclaimed. Any other state of the run (approved elsewhere, claimed, cancelled,
         -- finished, gone) leaves nobody who can answer it.
         OR (a.decision_type = 'runner_run_on_member_plan' AND a.run_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.agent_runs m
            WHERE m.account_id = a.account_id AND m.id = a.run_id AND m.status = 'pending' AND m.approved_by IS NULL AND m.runner_id IS NULL))
       )
     ORDER BY a.raised_at, a.id
     LIMIT p_limit
       FOR UPDATE OF a SKIP LOCKED
  ),
  moved AS (
    UPDATE public.decision_asks d
       SET state = 'withdrawn', withdrawn_reason = due.due_why
      FROM due
     WHERE d.id = due.due_id AND d.state IN ('open', 'overdue')
  )
  -- Every row in `due` is locked FOR UPDATE above, so the rows listed here are exactly the rows moved (see 0826 for why the UPDATE has no RETURNING).
  SELECT due.due_id, due.due_why FROM due;
END;
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
