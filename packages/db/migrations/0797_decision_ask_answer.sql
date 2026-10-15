-- Decision asks: the answer path (D#7 DP11b, correction DP-C9).
--
-- decision_ask_answer() is the one way an ask is answered: SECURITY DEFINER, owned by
-- receipt_writer, EXECUTE for receipt_writer_invoker only, and no account, user or actor
-- parameter (the tenant is app.account_id, the person is app.user_id). It enforces every
-- check itself with a named exception (branch on the leading name, never on the rest):
-- a session of an owner or admin, an ask in this tenant, a valid choice, a run, and the
-- receipt written a moment earlier in the same transaction. The state change is a
-- compare-and-set that links receipt_id in the same UPDATE (0666's guard makes an answered
-- row immutable). Column-scoped grants for receipt_writer; app_user stays SELECT only.
-- Nothing here touches run_action_requests (the resume request is DP11c's).

-- What the definer reads and writes, all tenant-bound.
GRANT SELECT (id, account_id, decision_type, options, run_id, state, receipt_id) ON decision_asks TO receipt_writer;
GRANT UPDATE (state, answered_option, answered_by, answered_at, receipt_id) ON decision_asks TO receipt_writer;
CREATE POLICY receipt_writer_select ON decision_asks FOR SELECT TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY receipt_writer_update ON decision_asks FOR UPDATE TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

GRANT SELECT (id, account_id, decision_type, chosen, run_id, actor) ON decision_receipts TO receipt_writer;
CREATE POLICY receipt_writer_select ON decision_receipts FOR SELECT TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- The caller's role (0663 granted account_id and user_id only).
GRANT SELECT (account_id, user_id, role) ON account_members TO receipt_writer;

-- One receipt answers one ask.
CREATE UNIQUE INDEX decision_asks_receipt_id_key ON decision_asks (receipt_id) WHERE receipt_id IS NOT NULL;

-- Ownership bracket (0666's shape), then the answer definer.
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

CREATE FUNCTION decision_ask_answer(
  p_ask_id     uuid,
  p_choice     text,
  p_receipt_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_token   text := NULLIF(current_setting('app.token_id', true), '');
  v_user    uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_role    text;
  v_ask     record;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'ask_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_token IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'ask_session_required: only a signed-in person can answer an ask' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.role INTO v_role FROM public.account_members m WHERE m.account_id = v_tenant AND m.user_id = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ask_session_required: the user is not a member of this account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'ask_forbidden: answering an ask needs the owner or admin role' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT a.id, a.decision_type, a.options, a.run_id INTO v_ask
    FROM public.decision_asks a WHERE a.id = p_ask_id AND a.account_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ask_not_found: no such ask in this account' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_choice IS NULL OR (p_choice <> 'deny'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_ask.options) o WHERE o ->> 'id' = p_choice)) THEN
    RAISE EXCEPTION 'ask_bad_choice: the choice is not one of the ask''s options' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_ask.run_id IS NULL THEN
    RAISE EXCEPTION 'ask_no_run: the ask was raised without a run' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_receipt_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.decision_receipts r
        WHERE r.id = p_receipt_id AND r.account_id = v_tenant
          AND r.decision_type = v_ask.decision_type AND r.chosen = p_choice
          AND r.run_id = v_ask.run_id AND r.actor = v_user::text)
     OR EXISTS (
       SELECT 1 FROM public.decision_asks o WHERE o.receipt_id = p_receipt_id AND o.id <> p_ask_id) THEN
    RAISE EXCEPTION 'ask_receipt_mismatch: the receipt is not this person''s receipt for this ask' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  UPDATE public.decision_asks
     SET state = 'answered', answered_option = p_choice, answered_by = v_user, answered_at = now(), receipt_id = p_receipt_id
   WHERE id = p_ask_id AND account_id = v_tenant AND state IN ('open', 'overdue');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ask_already_answered: the ask is no longer open' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION decision_ask_answer(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision_ask_answer(uuid, text, uuid) TO receipt_writer_invoker;
ALTER FUNCTION decision_ask_answer(uuid, text, uuid) OWNER TO receipt_writer;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
