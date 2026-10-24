-- D#6 WAITCANCEL: a failed runner run of a work item that has already finished or given up is not followed.
--
-- Why. runner_follow_up_run (0754, 0762) makes a pending child for a runner run that ended `runner_lost` or `usage_limit`. It asked only whether the
-- run's chain had allowance left. A work item the stage driver had already ended (it ran out of waiting for that very run and moved the item to Needs a
-- person, or the item was merged or closed) therefore still got a queued child, and a runner that restarted later claimed it and spent a run on work
-- nobody waited for. Live, 10-24: run c4ea4ffd.
--
-- What. One yes/no question, answered for a parent run: "has its work item finished, or given up on this run?" True when the item is at merged,
-- closed_unmerged or closed, or is at needs_human by a move made after the parent run was created. A needs_human move made BEFORE the run (Build
-- again, re-spec from Needs a person: the run is what takes the item out of it) does not count. The caller (requestFollowUp) asks it first and treats
-- true as not eligible: no child is made, and the failed parent stays the end of its chain. runner_follow_up_run itself is untouched.
--
-- Owner: runner_lease_definer (0754), which gains SELECT on exactly the columns read here, with a row policy for this role alone. The function
-- answers one boolean, reads the tenant from app.account_id and refuses a platform_ops login, as its sibling does. EXECUTE for agent_run_writer only.
-- Expand-only. Numbered above the highest migration on the code plane (0906); re-check right before merging.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_lease_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_lease_definer; cannot create runner_follow_up_item_finished';
    END IF;
    GRANT runner_lease_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_lease_definer;

GRANT SELECT (id, account_id, stage) ON work_items TO runner_lease_definer;
GRANT SELECT (account_id, work_item_id, to_stage, created_at) ON work_item_transitions TO runner_lease_definer;
CREATE POLICY runner_lease_definer_select ON work_items FOR SELECT TO runner_lease_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_lease_definer_select ON work_item_transitions FOR SELECT TO runner_lease_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

CREATE FUNCTION runner_follow_up_item_finished(p_parent_run_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_follow_up_item_finished: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_acct IS NULL OR NOT account_is_active(v_acct) THEN
    RAISE EXCEPTION 'runner_follow_up_item_finished: no active tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_parent_run_id IS NULL THEN
    RAISE EXCEPTION 'runner_follow_up_item_finished: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.agent_runs a
      JOIN public.work_items w ON w.account_id = a.account_id AND w.id = a.work_item_id
     WHERE a.account_id = v_acct AND a.id = p_parent_run_id
       AND (w.stage IN ('merged', 'closed_unmerged', 'closed')
            OR (w.stage = 'needs_human' AND EXISTS (
                  SELECT 1 FROM public.work_item_transitions t
                   WHERE t.account_id = v_acct AND t.work_item_id = w.id AND t.to_stage = 'needs_human' AND t.created_at >= a.created_at))));
END
$$;

REVOKE ALL ON FUNCTION runner_follow_up_item_finished(uuid) FROM PUBLIC;
ALTER FUNCTION runner_follow_up_item_finished(uuid) OWNER TO runner_lease_definer;
GRANT EXECUTE ON FUNCTION runner_follow_up_item_finished(uuid) TO agent_run_writer;

REVOKE CREATE ON SCHEMA public FROM runner_lease_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_lease_definer FROM CURRENT_USER;
  END IF;
END
$$;
