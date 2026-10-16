-- Decision asks: withdrawal of a question nobody can answer any more (D#7 DP4b-1, correction DP-C11 R-7-DP4b-3).
--
-- A parked item can move on without the ask being answered: it is closed or merged, a person halts it, or a
-- person presses Approve / Build again and a newer executor run exists. The ask must then leave "Needs you" and
-- must not come back when the item is reopened. Withdrawn is a stamp because it records something that happened.
--
--   * decision_asks.withdrawn_reason   nullable, one of item_closed | item_halted | superseded, only on a
--                                      withdrawn row, and frozen once set (the small trigger below; 0666's guard
--                                      keeps the transition table and the other terminal columns).
--   * decision_ask_withdraw(limit)     SECURITY DEFINER, owned by receipt_writer, EXECUTE for
--                                      receipt_writer_invoker only (0663/0665/0666/0797's split). One statement:
--                                      find the asks of this kind, lock them SKIP LOCKED, move them to
--                                      withdrawn, answer which ones moved and why. Works across tenants, like the
--                                      invariant sweep, and is for the worker's tick only.
--
-- The answer (0797) and this sweep race on the same compare-and-set, `state IN ('open','overdue')`, so there is
-- exactly one winner. A sweep that finds a row locked by an answer skips it (SKIP LOCKED); an answer that finds
-- the row withdrawn raises ask_already_answered.
--
-- Cross-tenant access, kept narrow. receipt_writer's existing policies are tenant-bound (app.account_id). The sweep
-- adds policies for receipt_writer only: decision_asks rows that are still open or overdue (update: to withdrawn,
-- with a reason, and nothing else), and, for the two tables it must read to decide, only the rows of an item that
-- has an open or overdue ask, and only the columns granted here (stage and halted_at on work_items; role and
-- created_at on agent_runs). 0797's answer and 0666's raise filter by the session tenant themselves and are
-- unchanged. Expand-only: one nullable column, no drop, no rename, no NOT NULL.

ALTER TABLE decision_asks ADD COLUMN withdrawn_reason text;
ALTER TABLE decision_asks
  ADD CONSTRAINT decision_asks_withdrawn_reason_known
    CHECK (withdrawn_reason IS NULL OR withdrawn_reason IN ('item_closed', 'item_halted', 'superseded')),
  ADD CONSTRAINT decision_asks_withdrawn_reason_state
    CHECK (withdrawn_reason IS NULL OR state = 'withdrawn');

-- A withdrawn row is terminal: its reason cannot be changed or cleared afterwards. (0666's guard names the other
-- terminal columns; the reason is new, so it is guarded here and not by editing that function.)
CREATE FUNCTION decision_asks_withdrawn_reason_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.state = 'withdrawn' AND NEW.withdrawn_reason IS DISTINCT FROM OLD.withdrawn_reason THEN
    RAISE EXCEPTION 'decision_asks_terminal: a withdrawn ask''s reason cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER decision_asks_withdrawn_reason_guard BEFORE UPDATE ON decision_asks
  FOR EACH ROW EXECUTE FUNCTION decision_asks_withdrawn_reason_guard();

-- What the definer reads and writes.
GRANT SELECT (work_item_id, raised_at) ON decision_asks TO receipt_writer;
GRANT UPDATE (withdrawn_reason) ON decision_asks TO receipt_writer;
GRANT SELECT (stage, halted_at) ON work_items TO receipt_writer;
GRANT SELECT (role, created_at) ON agent_runs TO receipt_writer;

-- The select policy also admits a row that has just been withdrawn: an UPDATE that reads columns in its WHERE must leave a new row the same role could
-- select, or Postgres refuses it. That shows a withdrawn row, with its reason, to receipt_writer's definers only; nothing returns it.
CREATE POLICY receipt_writer_sweep_select ON decision_asks FOR SELECT TO receipt_writer
  USING (state IN ('open', 'overdue') OR (state = 'withdrawn' AND withdrawn_reason IS NOT NULL));
CREATE POLICY receipt_writer_sweep_update ON decision_asks FOR UPDATE TO receipt_writer
  USING (state IN ('open', 'overdue'))
  WITH CHECK (state = 'withdrawn' AND withdrawn_reason IS NOT NULL);
CREATE POLICY receipt_writer_sweep_select ON work_items FOR SELECT TO receipt_writer
  USING (EXISTS (
    SELECT 1 FROM decision_asks a
     WHERE a.account_id = work_items.account_id AND a.work_item_id = work_items.id AND a.state IN ('open', 'overdue')));
CREATE POLICY receipt_writer_sweep_select ON agent_runs FOR SELECT TO receipt_writer
  USING (EXISTS (
    SELECT 1 FROM decision_asks a
     WHERE a.account_id = agent_runs.account_id AND a.work_item_id = agent_runs.work_item_id AND a.state IN ('open', 'overdue')));

-- Ownership bracket (0797's shape), then the withdraw definer.
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

CREATE FUNCTION decision_ask_withdraw(p_limit integer)
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
                ELSE 'superseded' END AS due_why
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
  -- Every row in `due` is locked FOR UPDATE above, so no other writer can have changed it before `moved` runs: the rows listed here are exactly the
  -- rows moved. (No RETURNING on the UPDATE: it would make the new, withdrawn row pass a SELECT policy, and the narrow sweep policy above stops at
  -- open and overdue on purpose.) A data-modifying CTE runs to completion whether or not the outer query reads it.
  SELECT due.due_id, due.due_why FROM due;
END;
$$;

REVOKE ALL ON FUNCTION decision_ask_withdraw(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision_ask_withdraw(integer) TO receipt_writer_invoker;
ALTER FUNCTION decision_ask_withdraw(integer) OWNER TO receipt_writer;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
