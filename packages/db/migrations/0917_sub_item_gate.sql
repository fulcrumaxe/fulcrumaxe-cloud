-- D#483 S5-b2a part 2: what the fix-round gate (the driver's call into resolveSubItemLaunch) needs from the database.
--
--   1. sub_item_ask_key(ask, key): names the sub-item an ask is about. The raiser (decision_ask_raise) has no such parameter, so the gate raises the ask and, in the same
--      transaction, sets the key on that ask. Only a launch_sub_item ask of the caller's own tenant that is still waiting and has no key yet; true when it moved.
--   2. decision_asks_sub_item_live_once: at most one waiting ask per (work item, key). A second raise of the same question fails on this index and rolls its
--      transaction back, so a replay or a race can never leave two open asks for one round.
--   3. decision_receipts.approval_id: the person approval row a policy launch relied on (nullable; a person's Approve leaves none).
--   4. sub_item_policy_receipt_write(...): the receipt the dial leaves when it launches without a click (Balanced, Autonomous). The actor is `policy`, and the definer
--      REFUSES a session that has a user: a person's receipt is sub_item_approval_receipt_write's. Same unique row as the person's receipt (one per key per Spec version),
--      so a replay answers the row that is there and writes nothing. It also refuses unless the approval it names is the item's NEWEST approval row and names the Spec version
--      it is written under (the gate trusts any keyed receipt as decided, so this is the only database guard), and unless the repo's current launch_sub_item dial is not `ask`.
--      For that it reads work_item_approvals and decision_settings (column-scoped, tenant-bound policies for receipt_writer).
--
-- Expand-only. Both functions: SECURITY DEFINER, owned by receipt_writer, EXECUTE for receipt_writer_invoker only, no account, user or actor parameter.
-- Numbered above main's highest (0916); re-check right before merging.

ALTER TABLE decision_receipts ADD COLUMN approval_id uuid;
ALTER TABLE decision_receipts
  ADD CONSTRAINT decision_receipts_approval_needs_key CHECK (approval_id IS NULL OR sub_item_key IS NOT NULL),
  ADD CONSTRAINT decision_receipts_approval_fk FOREIGN KEY (account_id, approval_id) REFERENCES work_item_approvals (account_id, id);

CREATE UNIQUE INDEX decision_asks_sub_item_live_once
  ON decision_asks (account_id, work_item_id, sub_item_key) WHERE sub_item_key IS NOT NULL AND decision_type = 'launch_sub_item' AND state IN ('open', 'overdue');
GRANT UPDATE (sub_item_key) ON decision_asks TO receipt_writer;

-- What the policy receipt definer checks before it writes: the item's newest approval, and the repo's current dial. Read-only, tenant-bound.
GRANT SELECT (id, account_id, work_item_id, spec_version_id, created_at) ON work_item_approvals TO receipt_writer;
CREATE POLICY receipt_writer_select ON work_item_approvals FOR SELECT TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT (account_id, repo_id, decision_type, disposition, version) ON decision_settings TO receipt_writer;
CREATE POLICY receipt_writer_select ON decision_settings FOR SELECT TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

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

CREATE FUNCTION sub_item_ask_key(p_ask_id uuid, p_sub_item_key text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_moved  integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'ask_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_ask_id IS NULL OR p_sub_item_key IS NULL OR p_sub_item_key !~ '^[a-z0-9-]{1,32}$' THEN
    RAISE EXCEPTION 'sub_item_ask_key: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.decision_asks SET sub_item_key = p_sub_item_key
   WHERE id = p_ask_id AND account_id = v_tenant AND decision_type = 'launch_sub_item' AND sub_item_key IS NULL AND state IN ('open', 'overdue');
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RETURN v_moved = 1;
END $$;

REVOKE ALL ON FUNCTION sub_item_ask_key(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sub_item_ask_key(uuid, text) TO receipt_writer_invoker;
ALTER FUNCTION sub_item_ask_key(uuid, text) OWNER TO receipt_writer;

CREATE FUNCTION sub_item_policy_receipt_write(
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
  -- The approval must be this item's newest one and must name the Spec version the receipt is written under.
  SELECT a.id, a.spec_version_id INTO v_appr, v_appr_spec FROM public.work_item_approvals a
   WHERE a.account_id = v_tenant AND a.work_item_id = p_work_item_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1;
  IF v_appr IS DISTINCT FROM p_approval_id OR v_appr_spec IS DISTINCT FROM p_spec_version_id THEN
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

REVOKE ALL ON FUNCTION sub_item_policy_receipt_write(uuid, text, uuid, uuid, uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sub_item_policy_receipt_write(uuid, text, uuid, uuid, uuid, text, integer, integer) TO receipt_writer_invoker;
ALTER FUNCTION sub_item_policy_receipt_write(uuid, text, uuid, uuid, uuid, text, integer, integer) OWNER TO receipt_writer;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
