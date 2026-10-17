-- D#483 / D#7: the rule-deny half of the "already decided under this envelope version" memory, through the definer role.
--
-- 0864 let envelope_pause_asks hold a receipt_id instead of an ask_id (a deny rule leaves a receipt, not an ask), and the worker inserted that
-- row directly. 0865 then revoked app_user's INSERT on the table and made envelope_pause_ask_record() the only writer, but that function can
-- only name an ask. A deny under approval rules therefore failed with a privilege error. This migration adds the matching writer for a receipt,
-- and leaves the invariant as 0865 set it: app_user cannot write envelope_pause_asks directly.
--
--   envelope_pause_receipt_record(item, envelope, v, receipt)   same shape, owner, search_path and EXECUTE grant as envelope_pause_ask_record.
--                                                               It requires a real deny receipt for spend_past_envelope on that item, so the
--                                                               memory can never stand without the decision it stands for.
--
-- Error contract is 0865's: 22023 invalid arguments; 42501 not permitted; P0002 not found; 55000 `envelope_mismatch`, `no_such_receipt`.
-- Expand-only: one function, two column grants and one row policy for envelope_definer. Numbered 0866 (main's highest is 0865); re-check
-- against main right before merging.

GRANT SELECT (id, account_id, work_item_id, decision_type, chosen) ON decision_receipts TO envelope_definer;
CREATE POLICY envelope_definer_select ON decision_receipts FOR SELECT TO envelope_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT INSERT (receipt_id) ON envelope_pause_asks TO envelope_definer;

CREATE FUNCTION envelope_pause_receipt_record(p_work_item_id uuid, p_envelope_id uuid, p_version integer, p_receipt_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  item_envelope uuid;
  n integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'envelope_pause_receipt_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'envelope_pause_receipt_record: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_envelope_id IS NULL OR p_receipt_id IS NULL OR p_version IS NULL OR p_version < 1 THEN
    RAISE EXCEPTION 'envelope_pause_receipt_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT w.envelope_id INTO item_envelope FROM public.work_items w WHERE w.id = p_work_item_id AND w.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF item_envelope IS DISTINCT FROM p_envelope_id THEN
    RAISE EXCEPTION 'envelope_mismatch' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.approval_envelopes v WHERE v.account_id = acct AND v.id = p_envelope_id AND v.version = p_version) THEN
    RAISE EXCEPTION 'envelope not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- The memory exists only beside the decision it stands for: a deny receipt for spend_past_envelope on this item.
  IF NOT EXISTS (
    SELECT 1 FROM public.decision_receipts r
     WHERE r.account_id = acct AND r.id = p_receipt_id AND r.work_item_id = p_work_item_id
       AND r.decision_type = 'spend_past_envelope' AND r.chosen = 'deny'
  ) THEN
    RAISE EXCEPTION 'no_such_receipt' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  INSERT INTO public.envelope_pause_asks (account_id, work_item_id, envelope_id, envelope_version, receipt_id)
  VALUES (acct, p_work_item_id, p_envelope_id, p_version, p_receipt_id)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- Ownership bracket (0865's shape): the migration role holds envelope_definer only to hand the function over; both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'envelope_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on envelope_definer; cannot ALTER FUNCTION ... OWNER TO envelope_definer';
    END IF;
    GRANT envelope_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO envelope_definer;

REVOKE ALL ON FUNCTION envelope_pause_receipt_record(uuid, uuid, integer, uuid) FROM PUBLIC;
ALTER FUNCTION envelope_pause_receipt_record(uuid, uuid, integer, uuid) OWNER TO envelope_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION envelope_pause_receipt_record(uuid, uuid, integer, uuid) TO app_user;

REVOKE CREATE ON SCHEMA public FROM envelope_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE envelope_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- Rollback. Nothing is dropped. The previous deploy's worker inserted the deny row directly, which 0865 already refuses, so there is no
-- older behaviour to return to; rolling forward again needs no data repair.
