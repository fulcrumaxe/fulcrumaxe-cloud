-- A split parent gets its spend envelope at the person's approval.
--
-- A short Spec that plans two or more pull requests is approved from the card (work_item_approval_record, which also makes the children). The parent
-- sits at spec_ready with the planner's run behind it, and work_item_set_envelope (0865) only attaches an envelope at Triaged with no run, so the parent
-- could never get one; every child was then held with `parent_no_envelope` and the card had no way out.
--
-- This replaces the body of work_item_set_envelope (same signature, owner and grants) to let ONE case past the "work already started" refusal:
-- the item has no envelope yet, and the person's approval of it was written in THIS transaction (a work_item_approve row stamped with the
-- transaction's own timestamp) and made at least two planned-PR children on the approved Spec version. Every other check is unchanged: the caller is a
-- signed-in owner or admin, the scope is item or batch, the repo matches, an item envelope belongs to one item, and an item that already has an
-- envelope keeps it (envelope_already_set). A replay of the same envelope still writes nothing.
--
-- envelope_definer gains read access to the two facts the test needs: the approval rows (behind a tenant-bound row policy of its own) and the
-- Spec version a child was made from. Expand-only; rolling back the code leaves a function that refuses exactly as before.
-- Numbered above main's highest (0928); re-check against main right before merging.

GRANT SELECT (account_id, work_item_id, spec_version_id, source, created_at) ON work_item_approvals TO envelope_definer;
GRANT SELECT (planned_pr_spec_version_id) ON work_items TO envelope_definer;
CREATE POLICY envelope_definer_select ON work_item_approvals FOR SELECT TO envelope_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- Ownership bracket (0865's shape): the migration role holds envelope_definer only to replace the function it owns; reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'envelope_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on envelope_definer; cannot replace a function it owns';
    END IF;
    GRANT envelope_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION work_item_set_envelope(p_work_item_id uuid, p_envelope_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  w    record;
  e    record;
  split_approval boolean;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'work_item_set_envelope: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'work_item_set_envelope: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A person's approval attaches an envelope, so the caller is an owner or admin of this account (a token carries no user and is refused).
  IF usr IS NULL OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'work_item_set_envelope: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_envelope_id IS NULL THEN
    RAISE EXCEPTION 'work_item_set_envelope: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT x.id, x.repo_id, x.stage, x.envelope_id INTO w FROM public.work_items x WHERE x.id = p_work_item_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- A replay: already this envelope. Nothing is written.
  IF w.envelope_id = p_envelope_id THEN
    RETURN false;
  END IF;
  IF w.envelope_id IS NOT NULL THEN
    RAISE EXCEPTION 'envelope_already_set' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- An envelope is attached at approval, before any work: at Triaged with no run. One exception: a split parent, in the transaction that approves it.
  IF w.stage <> 'triaged' OR EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.account_id = acct AND r.work_item_id = p_work_item_id) THEN
    SELECT EXISTS (
      SELECT 1 FROM public.work_item_approvals a
       WHERE a.account_id = acct AND a.work_item_id = p_work_item_id AND a.source = 'work_item_approve'
         AND a.created_at = transaction_timestamp() AND a.spec_version_id IS NOT NULL
         AND (SELECT count(*) FROM public.work_items c
               WHERE c.account_id = acct AND c.parent_id = p_work_item_id AND c.planned_pr_key IS NOT NULL
                 AND c.planned_pr_spec_version_id = a.spec_version_id) >= 2
    ) INTO split_approval;
    IF NOT split_approval THEN
      RAISE EXCEPTION 'work_started' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  SELECT v.scope, v.repo_id INTO e FROM public.approval_envelopes v WHERE v.account_id = acct AND v.id = p_envelope_id ORDER BY v.version DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'envelope not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- The weekly auto-start envelope is drawn on by the dial's own gate (S5-b1a), never by a person's click.
  IF e.scope NOT IN ('item', 'batch') THEN
    RAISE EXCEPTION 'envelope_scope' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF e.repo_id IS NOT NULL AND e.repo_id IS DISTINCT FROM w.repo_id THEN
    RAISE EXCEPTION 'envelope_repo_mismatch' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- An item envelope belongs to exactly one item.
  IF e.scope = 'item' AND EXISTS (SELECT 1 FROM public.work_items o WHERE o.account_id = acct AND o.envelope_id = p_envelope_id AND o.id <> p_work_item_id) THEN
    RAISE EXCEPTION 'envelope_taken' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE public.work_items SET envelope_id = p_envelope_id WHERE id = p_work_item_id AND account_id = acct;
  RETURN true;
END $$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE envelope_definer FROM CURRENT_USER;
  END IF;
END
$$;
