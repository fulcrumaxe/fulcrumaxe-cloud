-- A person's launch of a planned PR that came from their approval of the PARENT ("Approve the Spec and build" on a split parent), told apart from the same
-- person's Approve on the child's own card.
--
--   * sub_item_approval_receipt_write(..., p_approval_id): an overload of 0906's person receipt that also records decision_receipts.approval_id (0917: the
--     person approval row a launch relied on). Everything 0906 checks is checked again here, plus: the approval must be the work item's NEWEST one, name the
--     Spec version the receipt is written under, and have been made by the person in the session. A card click keeps calling the six-argument function and
--     leaves approval_id NULL, so the two are told apart by the receipt alone, and the approval row names the parent work item and who approved it.
--   * receipt_writer reads one more column of work_item_approvals (approved_by), under 0917's tenant-bound policy.
--
-- Owned by receipt_writer (the 0663 / 0906 / 0931 bracket) with EXECUTE for receipt_writer_invoker only. app_user and platform_ops gain nothing.
-- Expand-only: one column SELECT and one new function; 0906's function is unchanged.

GRANT SELECT (approved_by) ON work_item_approvals TO receipt_writer;

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

CREATE FUNCTION sub_item_approval_receipt_write(
  p_work_item_id uuid, p_sub_item_key text, p_spec_version_id uuid, p_run_id uuid, p_dial_version integer, p_catalogue_version integer, p_approval_id uuid
)
RETURNS TABLE (o_id uuid, o_replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_token  text := NULLIF(current_setting('app.token_id', true), '');
  v_user   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_role   text;
  v_id     uuid;
  v_appr   record;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'sub_item_approval_receipt_write: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'receipt_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_token IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'receipt_session_required: only a signed-in person approves a sub-item' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.role INTO v_role FROM public.account_members m WHERE m.account_id = v_tenant AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'receipt_forbidden: approving a sub-item needs the owner or admin role' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_spec_version_id IS NULL OR p_run_id IS NULL OR p_approval_id IS NULL OR p_sub_item_key IS NULL
     OR p_sub_item_key !~ '^[a-z0-9-]{1,32}$' OR p_dial_version IS NULL OR p_dial_version < 0 OR p_catalogue_version IS NULL OR p_catalogue_version < 1 THEN
    RAISE EXCEPTION 'sub_item_approval_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT public.sub_item_anchor_ok(p_work_item_id, p_spec_version_id, p_run_id) THEN
    RAISE EXCEPTION 'sub_item_approval_receipt_write: the run or the Spec version is not this work item''s current one' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The approval the launch came from: this work item's newest, for this Spec version, made by this person.
  SELECT a.id, a.spec_version_id, a.approved_by INTO v_appr FROM public.work_item_approvals a
   WHERE a.account_id = v_tenant AND a.work_item_id = p_work_item_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1;
  IF NOT FOUND OR v_appr.id IS DISTINCT FROM p_approval_id OR v_appr.spec_version_id IS DISTINCT FROM p_spec_version_id OR v_appr.approved_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'sub_item_approval_receipt_write: the approval is not this person''s newest one of this work item for this Spec version' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.decision_receipts
    (account_id, run_id, work_item_id, decision_type, class, chosen, rejected_alternative, dial_version, input_trust_classes,
     actor, catalogue_version, sub_item_key, spec_version_id, approval_id)
  VALUES
    (v_tenant, p_run_id, p_work_item_id, 'launch_sub_item', 'human_over_the_loop', 'launch', 'wait_for_approval', p_dial_version, '[]'::jsonb,
     v_user::text, p_catalogue_version, p_sub_item_key, p_spec_version_id, p_approval_id)
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
REVOKE ALL ON FUNCTION sub_item_approval_receipt_write(uuid, text, uuid, uuid, integer, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sub_item_approval_receipt_write(uuid, text, uuid, uuid, integer, integer, uuid) TO receipt_writer_invoker;
ALTER FUNCTION sub_item_approval_receipt_write(uuid, text, uuid, uuid, integer, integer, uuid) OWNER TO receipt_writer;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
