-- D#483 S5-b2c-3: the database half of giving a planned PR child the rounds a top-level item has (fix rounds, check-fix rounds, continuations).
--
-- A child (0919) has no issue number of its own, no Spec version of its own and no approval of its own. It builds on its PARENT's issue, on `fx/<parent#>-<key>`, against the one
-- version of the parent it is pinned to, and the person approved the PARENT. The keyed receipt a fix round needs (0906, 0917) was written for an item that has all three, so a child
-- could never get one: the Spec version had to be the item's own newest, and the approval the item's own newest. This migration teaches the three places that decide, and keeps
-- every top-level item exactly as it was.
--
--   1. work_items_planned_pr_child_no_issue_number: a CHECK that a planned PR child never has a `gh_number`. The consumers that build a branch name read the identity from the parent
--      and fail closed on a child with a number of its own; the constraint is the database's line behind them. The rows are checked before it is added (below), so a deploy never
--      meets it half-way: the migration stops with a message if any row breaks it. Writers of `gh_number`: the plan import and the issue-intake update names no child (it sets the
--      number on the root of an issue triage), and `planned_pr_children_create` (0919/0920) inserts children without one.
--   2. sub_item_anchor_ok(item, version, run): for an item with a `planned_pr_key` the version must be the child's PINNED `planned_pr_spec_version_id` (a version of its parent, not erased),
--      and the run must be the child's own; for every other item the body is 0906's, word for word. Owner, grants and signature are unchanged. Both receipt writers call it, so the
--      person's receipt and the policy receipt of a child are both held to the pin and to the child's own run.
--   3. sub_item_policy_receipt_write: the approval must be the PARENT's newest approval for a child (the child has none), and the check that the approval names the receipt's Spec version
--      is skipped for a child (the pin was checked by the anchor, and after the parent is approved again a started child's pin is older than the approval, by design: R11). For every
--      other item the body is 0917's, word for word. receipt_writer gains SELECT on exactly `work_items (parent_id, planned_pr_key)`, under the tenant policy it already has.
--   4. resolve_runner_bound_branch(account, run): the gh-proxy's per-request check of an item branch. For a child the item's own branch is `fx/<parent's number>-<key>` (a top-level item's
--      is `fx/issue-<n>` as before); anything else, and a child whose parent has no number, answers NULL as it always did. runner_bound_definer gains SELECT on exactly
--      `work_items (parent_id, planned_pr_key)`, under the row policy it already has. Without this a child's runner continuation would be signed a ticket the proxy then refuses.
--
-- The 0886 cleanup lister does not filter on `gh_number` (it lists by stage and the item's push row), so it is not replaced. platform_ops and app_user gain no EXECUTE and no privilege.
--
-- Expand-only: one CHECK over rows that satisfy it, three replaced function bodies with their signatures, owners and grants unchanged, and two column grants. Rolling the code back
-- leaves functions that behave as before for every top-level item. Numbered 0922 (0921 is queued by an open pull request); re-check against main's highest right before opening and again
-- before merging. Neon shape: packages/db/neon-shape.d/0922_child_round_receipts.conf.

-- ---- 1. a child has no issue number of its own ------------------------------------------------------------------------------------------
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM work_items WHERE planned_pr_key IS NOT NULL AND gh_number IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '0922: % planned PR child row(s) have a gh_number; clear them before this constraint can be added', n USING ERRCODE = 'check_violation';
  END IF;
END
$$;
-- Added NOT VALID, then validated in the same migration: the first step takes only a brief lock and checks new writes at once, the second scans the rows without blocking writers.
ALTER TABLE work_items
  ADD CONSTRAINT work_items_planned_pr_child_no_issue_number CHECK (planned_pr_key IS NULL OR gh_number IS NULL) NOT VALID;
ALTER TABLE work_items VALIDATE CONSTRAINT work_items_planned_pr_child_no_issue_number;

GRANT SELECT (parent_id, planned_pr_key) ON work_items TO receipt_writer;
GRANT SELECT (parent_id, planned_pr_key) ON work_items TO runner_bound_definer;

-- ---- 2. the anchor: a child is held to its pinned version and its own run -----------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'work_item_approval_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on work_item_approval_definer; cannot replace functions it owns';
    END IF;
    GRANT work_item_approval_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION sub_item_anchor_ok(p_work_item_id uuid, p_spec_version_id uuid, p_run_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_spec_version_id IS NOT NULL AND p_run_id IS NOT NULL
     AND p_spec_version_id IS NOT DISTINCT FROM (
           SELECT CASE WHEN w.planned_pr_key IS NULL
                       -- Every other item: its own newest non-erased Spec version (0906, unchanged).
                       THEN (SELECT s.id FROM public.spec_versions s
                              WHERE s.account_id = w.account_id AND s.work_item_id = w.id AND s.erased_at IS NULL
                              ORDER BY s.version DESC LIMIT 1)
                       -- A planned PR child: the one version of its parent it is pinned to, if that version still exists.
                       ELSE (SELECT s.id FROM public.spec_versions s
                              WHERE s.account_id = w.account_id AND s.id = w.planned_pr_spec_version_id AND s.work_item_id = w.parent_id AND s.erased_at IS NULL)
                  END
             FROM public.work_items w
            WHERE w.id = p_work_item_id AND w.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
     AND EXISTS (SELECT 1 FROM public.agent_runs r
                  WHERE r.id = p_run_id AND r.work_item_id = p_work_item_id AND r.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE work_item_approval_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- 3. the policy receipt: a child's approval is its parent's newest -------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'receipt_writer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on receipt_writer; cannot replace functions it owns';
    END IF;
    GRANT receipt_writer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION sub_item_policy_receipt_write(
  p_work_item_id uuid, p_sub_item_key text, p_spec_version_id uuid, p_run_id uuid, p_approval_id uuid, p_chosen text, p_dial_version integer, p_catalogue_version integer
)
RETURNS TABLE (o_id uuid, o_replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_token  text := NULLIF(current_setting('app.token_id', true), '');
  v_user   text := NULLIF(current_setting('app.user_id', true), '');
  v_id     uuid;
  v_appr   uuid;
  v_appr_spec uuid;
  v_disp   text;
  v_child  boolean;
  v_parent uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'receipt_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_token IS NOT NULL OR v_user IS NOT NULL THEN
    RAISE EXCEPTION 'receipt_policy_only: a person approves through sub_item_approval_receipt_write' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_spec_version_id IS NULL OR p_run_id IS NULL OR p_approval_id IS NULL OR p_sub_item_key IS NULL
     OR p_sub_item_key !~ '^[a-z0-9-]{1,32}$' OR p_chosen IS NULL OR p_chosen NOT IN ('launch', 'announce')
     OR p_dial_version IS NULL OR p_dial_version < 0 OR p_catalogue_version IS NULL OR p_catalogue_version < 1 THEN
    RAISE EXCEPTION 'sub_item_policy_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT public.sub_item_anchor_ok(p_work_item_id, p_spec_version_id, p_run_id) THEN
    RAISE EXCEPTION 'sub_item_policy_receipt_write: the run or the Spec version is not this work item''s current one' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- A planned PR child has no approval of its own: the one that counts is its PARENT's newest. The anchor above already held the version to the child's pin, which after the parent is
  -- approved again is older than that approval by design, so the approval's version is not compared with the receipt's for a child. Every other item: its own newest approval, which must
  -- name the Spec version the receipt is written under.
  SELECT (w.planned_pr_key IS NOT NULL), w.parent_id INTO v_child, v_parent FROM public.work_items w WHERE w.id = p_work_item_id AND w.account_id = v_tenant;
  IF v_child IS NULL OR (v_child AND v_parent IS NULL) THEN
    RAISE EXCEPTION 'sub_item_policy_receipt_write: the approval is not this work item''s newest one for this Spec version' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT a.id, a.spec_version_id INTO v_appr, v_appr_spec FROM public.work_item_approvals a
   WHERE a.account_id = v_tenant AND a.work_item_id = CASE WHEN v_child THEN v_parent ELSE p_work_item_id END ORDER BY a.created_at DESC, a.id DESC LIMIT 1;
  IF v_appr IS DISTINCT FROM p_approval_id OR (NOT v_child AND v_appr_spec IS DISTINCT FROM p_spec_version_id) THEN
    RAISE EXCEPTION 'sub_item_policy_receipt_write: the approval is not this work item''s newest one for this Spec version' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- A repo whose dial says ask never launches without a click.
  SELECT s.disposition INTO v_disp FROM public.decision_settings s JOIN public.work_items w ON w.account_id = s.account_id AND w.repo_id = s.repo_id
   WHERE w.id = p_work_item_id AND w.account_id = v_tenant AND s.decision_type = 'launch_sub_item' ORDER BY s.version DESC LIMIT 1;
  IF v_disp = 'ask' THEN
    RAISE EXCEPTION 'sub_item_policy_receipt_write: the dial asks before a launch' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.decision_receipts
    (account_id, run_id, work_item_id, decision_type, class, chosen, rejected_alternative, dial_version, input_trust_classes,
     actor, catalogue_version, sub_item_key, spec_version_id, approval_id)
  VALUES
    (v_tenant, p_run_id, p_work_item_id, 'launch_sub_item', 'human_over_the_loop', p_chosen, 'wait_for_approval', p_dial_version, '[]'::jsonb,
     'policy', p_catalogue_version, p_sub_item_key, p_spec_version_id, p_approval_id)
  ON CONFLICT (account_id, work_item_id, decision_type, sub_item_key, spec_version_id) WHERE sub_item_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, false; RETURN;
  END IF;
  SELECT r.id INTO v_id FROM public.decision_receipts r
   WHERE r.account_id = v_tenant AND r.work_item_id = p_work_item_id AND r.decision_type = 'launch_sub_item'
     AND r.sub_item_key = p_sub_item_key AND r.spec_version_id = p_spec_version_id;
  RETURN QUERY SELECT v_id, true;
END $$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- 4. the proxy's per-request branch check knows a child's branch -------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_bound_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_bound_definer; cannot replace functions it owns';
    END IF;
    GRANT runner_bound_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION resolve_runner_bound_branch(p_account_id uuid, p_run_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_branch text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'resolve_runner_bound_branch: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'resolve_runner_bound_branch: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The item's own branch: `fx/issue-<its number>`, or for a planned PR child `fx/<its parent's number>-<its key>`. A missing number makes the comparison NULL, so nothing matches.
  SELECT e.payload->>'branch'
    INTO v_branch
    FROM public.run_events e
    JOIN public.agent_runs a ON a.account_id = e.account_id AND a.id = e.run_id
    JOIN public.work_items w ON w.account_id = a.account_id AND w.id = a.work_item_id
    LEFT JOIN public.work_items p ON p.account_id = w.account_id AND p.id = w.parent_id AND w.planned_pr_key IS NOT NULL
   WHERE e.account_id = p_account_id AND e.run_id = p_run_id AND e.kind = 'runner.continues_bound'
     AND e.payload->>'branch' = a.job_signed->'job'->'continues'->>'branch'
     AND e.payload->>'pr_number' = a.job_signed->'job'->'continues'->>'pr_number'
     AND e.payload->>'branch' = CASE WHEN w.planned_pr_key IS NULL THEN 'fx/issue-' || w.gh_number::text ELSE 'fx/' || p.gh_number::text || '-' || w.planned_pr_key END
   ORDER BY e.seq DESC
   LIMIT 1;
  RETURN v_branch;
END;
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_bound_definer FROM CURRENT_USER;
  END IF;
END
$$;
