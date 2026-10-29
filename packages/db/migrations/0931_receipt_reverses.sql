-- DP7-1 (D#7 C25 B1, B3): a reversal is a NEW receipt that points at the receipt it reverses.
--
--   * decision_receipts.reverses_receipt_id: nullable, a foreign key to another receipt, never the row's own id. It is set only at INSERT, through the
--     one definer below. No role holds UPDATE on the table (0400), so the pointer cannot move afterwards. `reversal_state` stays unused.
--   * One receipt is reversed at most once: a partial UNIQUE index on the pointer. A refused reversal (`chosen = 'reverse_refused'`) is a record that
--     nothing was undone, so it neither takes the slot nor counts toward the cap.
--   * decision_receipt_write_reversal(...) takes the original receipt id and nothing about the account or the actor (both come from the session, like
--     decision_receipt_write, 0663). It checks the original belongs to the caller's account, is not itself a reversal and has a work item, then writes
--     `reversal_recorded` (class 2), or `reversal_over_cap` (class 3) when two reversals already stand on that work item. A retry of a reversal that
--     was recorded answers the first receipt (o_replayed = true) and writes nothing.
--   * reversal_count(work_item_id) is derived from the receipts, never stored: a second counter could drift, and an undo is just another row.
--
-- Both functions are owned by receipt_writer (the 0663 / 0665 / 0906 pattern, same ownership bracket) with EXECUTE for receipt_writer_invoker only.
-- app_user and platform_ops gain no EXECUTE and no policy, and both functions refuse a direct platform_ops login.
-- Expand-only: one nullable column, one check, three indexes, one column SELECT and two functions.

ALTER TABLE decision_receipts
  ADD COLUMN reverses_receipt_id uuid REFERENCES decision_receipts (id) ON DELETE NO ACTION,
  ADD CONSTRAINT decision_receipts_reverses_not_self CHECK (reverses_receipt_id IS NULL OR reverses_receipt_id <> id);

CREATE INDEX decision_receipts_reverses_idx ON decision_receipts (reverses_receipt_id) WHERE reverses_receipt_id IS NOT NULL;
CREATE UNIQUE INDEX decision_receipts_reversed_once
  ON decision_receipts (reverses_receipt_id) WHERE reverses_receipt_id IS NOT NULL AND chosen IS DISTINCT FROM 'reverse_refused';
CREATE INDEX decision_receipts_reversals_by_item ON decision_receipts (account_id, work_item_id) WHERE reverses_receipt_id IS NOT NULL;

-- The definer reads the original's pointer (to refuse a reversal of a reversal) and counts pointers. receipt_writer already reads id, account_id,
-- work_item_id, decision_type and chosen (0797, 0906, 0913), under a policy that holds it to the session's account.
GRANT SELECT (reverses_receipt_id) ON decision_receipts TO receipt_writer;

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

CREATE FUNCTION decision_receipt_write_reversal(
  p_reverses_receipt_id  uuid,
  p_chosen               text,
  p_rejected_alternative text,
  p_dial_version         integer,
  p_run_id               uuid,
  p_catalogue_version    integer
)
RETURNS TABLE (o_id uuid, o_decision_type text, o_replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_session  text := NULLIF(current_setting('app.user_id', true), '');
  v_actor    text;
  v_item     uuid;
  v_orig_rev uuid;
  v_found    boolean;
  v_count    integer;
  v_type     text;
  v_class    text;
  v_id       uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'decision_receipt_write_reversal: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'receipt_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reverses_receipt_id IS NULL OR p_run_id IS NULL
     OR p_chosen IS NULL OR p_chosen NOT IN ('reversed', 'reverse_refused')
     OR p_rejected_alternative IS NULL OR p_rejected_alternative NOT IN ('reversed', 'reverse_refused') OR p_rejected_alternative = p_chosen
     OR p_dial_version IS NULL OR p_dial_version < 0 OR p_catalogue_version IS NULL OR p_catalogue_version < 1 THEN
    RAISE EXCEPTION 'decision_receipt_write_reversal: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_session IS NULL THEN
    v_actor := 'policy';
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = v_tenant AND m.user_id = v_session::uuid) THEN
      RAISE EXCEPTION 'receipt_actor_not_member: user is not a member of the tenant account' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_actor := v_session;
  END IF;

  -- The original must be this account's own receipt and carry a work item (the cap is counted per work item).
  SELECT r.work_item_id, r.reverses_receipt_id, true INTO v_item, v_orig_rev, v_found
    FROM public.decision_receipts r WHERE r.id = p_reverses_receipt_id AND r.account_id = v_tenant;
  IF v_found IS NOT TRUE OR v_item IS NULL THEN
    RAISE EXCEPTION 'reversal_original_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_orig_rev IS NOT NULL THEN
    RAISE EXCEPTION 'reversal_of_reversal' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One writer at a time per work item, so two reversals of different receipts cannot both read "one so far" and both stay under the cap.
  PERFORM pg_advisory_xact_lock(hashtextextended('reversal:' || v_tenant::text || ':' || v_item::text, 0));

  IF p_chosen = 'reversed' THEN
    SELECT r.id, r.decision_type INTO v_id, v_type FROM public.decision_receipts r
     WHERE r.account_id = v_tenant AND r.reverses_receipt_id = p_reverses_receipt_id AND r.chosen IS DISTINCT FROM 'reverse_refused';
    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, v_type, true; RETURN;
    END IF;
    SELECT count(*)::integer INTO v_count FROM public.decision_receipts r
     WHERE r.account_id = v_tenant AND r.work_item_id = v_item AND r.reverses_receipt_id IS NOT NULL AND r.chosen IS DISTINCT FROM 'reverse_refused';
  ELSE
    v_count := 0;
  END IF;

  IF v_count >= 2 THEN
    v_type := 'reversal_over_cap'; v_class := 'human_in_the_loop';
  ELSE
    v_type := 'reversal_recorded'; v_class := 'human_over_the_loop';
  END IF;

  INSERT INTO public.decision_receipts
    (account_id, run_id, work_item_id, decision_type, class, chosen, rejected_alternative, dial_version, input_trust_classes,
     actor, catalogue_version, reverses_receipt_id)
  VALUES
    (v_tenant, p_run_id, v_item, v_type, v_class, p_chosen, p_rejected_alternative, p_dial_version, '[]'::jsonb,
     v_actor, p_catalogue_version, p_reverses_receipt_id)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, v_type, false;
END $$;

REVOKE ALL ON FUNCTION decision_receipt_write_reversal(uuid, text, text, integer, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision_receipt_write_reversal(uuid, text, text, integer, uuid, integer) TO receipt_writer_invoker;
ALTER FUNCTION decision_receipt_write_reversal(uuid, text, text, integer, uuid, integer) OWNER TO receipt_writer;

-- How many reversals stand on one work item of the caller's account: receipts that point at another receipt, not counting refused ones.
CREATE FUNCTION reversal_count(p_work_item_id uuid)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_count  integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'reversal_count: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'receipt_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL THEN
    RAISE EXCEPTION 'reversal_count: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT count(*)::integer INTO v_count FROM public.decision_receipts r
   WHERE r.account_id = v_tenant AND r.work_item_id = p_work_item_id AND r.reverses_receipt_id IS NOT NULL AND r.chosen IS DISTINCT FROM 'reverse_refused';
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION reversal_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reversal_count(uuid) TO receipt_writer_invoker;
ALTER FUNCTION reversal_count(uuid) OWNER TO receipt_writer;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
