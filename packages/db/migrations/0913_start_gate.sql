-- D#7 start gate, part (a): start asks and start receipts anchored on the WORK ITEM, not on a run.
--
-- Why: the ask/receipt/answer path of 0666/0797 hangs every receipt on a run, and a start decision happens before the item has one
-- (decision_ask_answer refuses `ask_no_run`; a resume has nothing to resume). This adds the work-item-anchored half beside it. Nothing
-- existing changes; no code calls the new functions yet.
--
--   1. start_gate: one row per (work item, start decision type). It is the idempotency key: a second claim for the same pair finds
--      the first row instead of making a second ask or a second start. It also holds the preset, the dial version and the outcome,
--      for the later card line. Outcome: `asked` (an ask is open), `started`, `declined`. Written by the definers below only; app_user
--      reads its own tenant's rows. Terminal outcomes and the identity columns never change (trigger, every role).
--   2. start_gate_claim(...): claims the pair. The dial-driven ask raises it with `asked`; a start nobody asked about (the dial said go,
--      or a person clicked) claims `started`. Returns whether this call made the row.
--   3. start_gate_attach(...): links the ask just raised (outcome asked) or the receipt just written (outcome started) to the row.
--   4. start_receipt_write(...): the receipt for a start decision, run_id NULL. The actor comes from the session: a signed-in owner or
--      admin, or `policy` when no person is in it. `policy` may only record `start` for a class 2 type: a class 3 start (a feature,
--      a reclassified item) and every hold or deny are a person's.
--   5. start_ask_answer(...): the answer. Same checks as decision_ask_answer, for an ask that has no run and belongs to a gate row;
--      it moves the ask to answered and the gate row to started (choice `start`) or declined (anything else), in one statement each.
--      The advance request is made by the caller, in the same transaction, through run_action_request (a person's own request).
--
-- All four functions: SECURITY DEFINER, owned by receipt_writer, EXECUTE for receipt_writer_invoker only, no account, user or actor
-- parameter (the tenant is app.account_id, the person app.user_id). app_user and platform_ops hold no EXECUTE. Each commit-relevant
-- change writes an audit row from the definer (receipt_writer gets a column-scoped INSERT on audit_log, limited by policy to the two
-- start_gate actions, as 0901 does for its own role). Expand-only: a new table, new functions, new grants and policies.

-- ---- 1. the table ------------------------------------------------------------------------------------------------------------------------
CREATE TABLE start_gate (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id  uuid NOT NULL,
  decision_type text NOT NULL CHECK (decision_type IN ('start_work_small', 'start_work_bug', 'start_work_doc', 'start_parent_item', 'start_after_reclassify')),
  preset        text NOT NULL CHECK (preset IN ('cautious', 'balanced', 'autonomous')),
  dial_version  integer NOT NULL CHECK (dial_version >= 0),
  outcome       text NOT NULL CHECK (outcome IN ('asked', 'started', 'declined')),
  ask_id        uuid,
  receipt_id    uuid,
  decided_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE NO ACTION,
  CONSTRAINT start_gate_asked_open CHECK (outcome <> 'asked' OR (receipt_id IS NULL AND decided_at IS NULL)),
  CONSTRAINT start_gate_declined_by_ask CHECK (outcome <> 'declined' OR ask_id IS NOT NULL),
  CONSTRAINT start_gate_decided_stamp CHECK ((outcome = 'asked') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX start_gate_item_decision_key ON start_gate (account_id, work_item_id, decision_type);
CREATE UNIQUE INDEX start_gate_ask_key ON start_gate (ask_id) WHERE ask_id IS NOT NULL;
CREATE UNIQUE INDEX start_gate_receipt_key ON start_gate (receipt_id) WHERE receipt_id IS NOT NULL;

ALTER TABLE start_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE start_gate FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON start_gate FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
GRANT SELECT ON start_gate TO app_user;

GRANT SELECT, INSERT ON start_gate TO receipt_writer;
GRANT UPDATE (outcome, ask_id, receipt_id, decided_by, decided_at) ON start_gate TO receipt_writer;
CREATE POLICY receipt_writer_select ON start_gate FOR SELECT TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY receipt_writer_insert ON start_gate FOR INSERT TO receipt_writer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY receipt_writer_update ON start_gate FOR UPDATE TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- Identity and terminal rows are frozen for every role. asked -> started | declined; started and declined never change; ask_id and
-- receipt_id are set once.
CREATE FUNCTION start_gate_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.id, NEW.account_id, NEW.work_item_id, NEW.decision_type, NEW.preset, NEW.dial_version, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.work_item_id, OLD.decision_type, OLD.preset, OLD.dial_version, OLD.created_at) THEN
    RAISE EXCEPTION 'start_gate_frozen: a start gate row''s identity cannot change' USING ERRCODE = 'check_violation';
  END IF;
  -- A decided row is terminal once it names its receipt; until then (a start claimed, its receipt not yet attached) only the receipt may be added.
  IF OLD.outcome IN ('started', 'declined') AND (
       NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.ask_id IS DISTINCT FROM OLD.ask_id OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id)) THEN
    RAISE EXCEPTION 'start_gate_terminal: a % start gate row cannot change', OLD.outcome USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.ask_id IS NOT NULL AND NEW.ask_id IS DISTINCT FROM OLD.ask_id) OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id) THEN
    RAISE EXCEPTION 'start_gate_frozen: the ask and the receipt are set once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER start_gate_guard BEFORE UPDATE ON start_gate FOR EACH ROW EXECUTE FUNCTION start_gate_guard();

-- At commit, a row is whole: an `asked` row names its ask, a decided row names its receipt. Inside the transaction it is built in steps. A deferred
-- trigger's NEW is the row as it was when the event was queued, so the function reads the row as it stands now.
CREATE FUNCTION start_gate_whole() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.start_gate g WHERE g.id = NEW.id
               AND ((g.outcome = 'asked' AND g.ask_id IS NULL) OR (g.outcome IN ('started', 'declined') AND g.receipt_id IS NULL))) THEN
    RAISE EXCEPTION 'start_gate_incomplete: the row is not linked to its ask or receipt' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER start_gate_whole AFTER INSERT OR UPDATE ON start_gate
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION start_gate_whole();

-- ---- grants the definers need --------------------------------------------------------------------------------------------------------------
GRANT SELECT (work_item_id) ON decision_asks TO receipt_writer;
GRANT SELECT (id, account_id, work_item_id, decision_type, chosen, run_id, actor, rejected_alternative) ON decision_receipts TO receipt_writer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO receipt_writer;
CREATE POLICY receipt_writer_start_gate_audit ON audit_log FOR INSERT TO receipt_writer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND action IN ('start_gate.recorded', 'start_gate.answered'));

-- ---- ownership bracket (0797's shape) ------------------------------------------------------------------------------------------------------
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

-- ---- 2. claim ------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION start_gate_claim(p_work_item_id uuid, p_decision_type text, p_preset text, p_dial_version integer, p_outcome text)
RETURNS TABLE (o_id uuid, o_claimed boolean, o_outcome text, o_ask_id uuid, o_receipt_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_token  text := NULLIF(current_setting('app.token_id', true), '');
  v_user   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_actor  text;
  v_id     uuid;
  v_row    public.start_gate;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'start_gate_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_token IS NOT NULL OR NOT public.account_is_active(v_tenant) THEN
    RAISE EXCEPTION 'start_gate_claim: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL THEN
    v_actor := 'policy';
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = v_tenant AND m.user_id = v_user AND m.role IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'start_gate_forbidden: starting work needs the owner or admin role' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_actor := v_user::text;
  END IF;
  IF p_work_item_id IS NULL OR p_decision_type IS NULL OR p_preset IS NULL OR p_dial_version IS NULL OR p_dial_version < 0
     OR p_outcome IS NULL OR p_outcome NOT IN ('asked', 'started')
     OR p_decision_type NOT IN ('start_work_small', 'start_work_bug', 'start_work_doc', 'start_parent_item', 'start_after_reclassify')
     OR p_preset NOT IN ('cautious', 'balanced', 'autonomous') THEN
    RAISE EXCEPTION 'start_gate_claim: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- A dial raises an ask; a person never does. A policy start is class 2 only (a class 3 start is always a person's).
  IF p_outcome = 'asked' AND v_user IS NOT NULL THEN
    RAISE EXCEPTION 'start_gate_claim: only the dial raises a start ask' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_outcome = 'started' AND v_user IS NULL AND p_decision_type NOT IN ('start_work_small', 'start_work_bug', 'start_work_doc') THEN
    RAISE EXCEPTION 'start_gate_claim: this start is always a person''s' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.work_items w WHERE w.id = p_work_item_id AND w.account_id = v_tenant) THEN
    RAISE EXCEPTION 'start_gate_work_item_not_found: no such work item in this account' USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO public.start_gate (account_id, work_item_id, decision_type, preset, dial_version, outcome, decided_by, decided_at)
  VALUES (v_tenant, p_work_item_id, p_decision_type, p_preset, p_dial_version, p_outcome,
          CASE WHEN p_outcome = 'started' THEN v_actor END, CASE WHEN p_outcome = 'started' THEN now() END)
  ON CONFLICT (account_id, work_item_id, decision_type) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    VALUES (v_tenant, v_actor, 'start_gate.recorded',
            jsonb_build_object('gate_id', v_id, 'work_item_id', p_work_item_id, 'decision_type', p_decision_type, 'preset', p_preset,
                               'dial_version', p_dial_version, 'outcome', p_outcome),
            clock_timestamp());
    RETURN QUERY SELECT v_id, true, p_outcome, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO v_row FROM public.start_gate g WHERE g.account_id = v_tenant AND g.work_item_id = p_work_item_id AND g.decision_type = p_decision_type;
  RETURN QUERY SELECT v_row.id, false, v_row.outcome, v_row.ask_id, v_row.receipt_id;
END $$;

-- ---- 3. attach ----------------------------------------------------------------------------------------------------------------------------
-- Exactly one of the ask and the receipt. The ask must be this gate's: this item, this decision, no run, still open, and a dial raised it
-- (no person in the session). The receipt must be this item's start receipt for this decision, run-less, by the session's own actor.
CREATE FUNCTION start_gate_attach(p_gate_id uuid, p_ask_id uuid, p_receipt_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_token  text := NULLIF(current_setting('app.token_id', true), '');
  v_user   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_actor  text;
  g        public.start_gate;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'start_gate_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_token IS NOT NULL THEN
    RAISE EXCEPTION 'start_gate_attach: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_actor := COALESCE(v_user::text, 'policy');
  IF p_gate_id IS NULL OR (p_ask_id IS NULL) = (p_receipt_id IS NULL) THEN
    RAISE EXCEPTION 'start_gate_attach: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO g FROM public.start_gate x WHERE x.id = p_gate_id AND x.account_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'start_gate_not_found: no such gate row in this account' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_ask_id IS NOT NULL THEN
    IF g.outcome <> 'asked' OR g.ask_id IS NOT NULL OR v_user IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM public.decision_asks a
       WHERE a.id = p_ask_id AND a.account_id = v_tenant AND a.work_item_id = g.work_item_id AND a.decision_type = g.decision_type
         AND a.run_id IS NULL AND a.state = 'open' AND a.receipt_id IS NULL) THEN
      RAISE EXCEPTION 'start_gate_attach: that ask is not this gate''s' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    UPDATE public.start_gate SET ask_id = p_ask_id WHERE id = g.id;
  ELSE
    IF g.outcome <> 'started' OR g.receipt_id IS NOT NULL OR g.decided_by IS DISTINCT FROM v_actor OR NOT EXISTS (
      SELECT 1 FROM public.decision_receipts r
       WHERE r.id = p_receipt_id AND r.account_id = v_tenant AND r.work_item_id = g.work_item_id AND r.decision_type = g.decision_type
         AND r.run_id IS NULL AND r.chosen = 'start' AND r.actor = v_actor) THEN
      RAISE EXCEPTION 'start_gate_attach: that receipt is not this gate''s' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    UPDATE public.start_gate SET receipt_id = p_receipt_id WHERE id = g.id;
  END IF;
END $$;

-- ---- 4. receipt ---------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION start_receipt_write(
  p_work_item_id uuid, p_decision_type text, p_chosen text, p_rejected_alternative text, p_dial_version integer, p_catalogue_version integer
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_token  text := NULLIF(current_setting('app.token_id', true), '');
  v_user   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_actor  text;
  v_class  text;
  v_id     uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'receipt_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_token IS NOT NULL OR NOT public.account_is_active(v_tenant) THEN
    RAISE EXCEPTION 'start_receipt_write: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_decision_type IS NULL OR p_chosen IS NULL OR p_rejected_alternative IS NULL
     OR p_chosen NOT IN ('start', 'hold', 'deny') OR p_rejected_alternative NOT IN ('start', 'wait_for_approval')
     OR p_dial_version IS NULL OR p_dial_version < 0 OR p_catalogue_version IS NULL OR p_catalogue_version < 1 THEN
    RAISE EXCEPTION 'start_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_class := CASE WHEN p_decision_type IN ('start_work_small', 'start_work_bug', 'start_work_doc') THEN 'human_over_the_loop'
                  WHEN p_decision_type IN ('start_parent_item', 'start_after_reclassify') THEN 'human_in_the_loop' END;
  IF v_class IS NULL THEN
    RAISE EXCEPTION 'start_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_user IS NULL THEN
    -- The dial's own record: a class 2 start only. Holds, denials and class 3 starts are a person's.
    IF v_class <> 'human_over_the_loop' OR p_chosen <> 'start' THEN
      RAISE EXCEPTION 'start_receipt_write: this receipt is a person''s' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_actor := 'policy';
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = v_tenant AND m.user_id = v_user AND m.role IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'start_receipt_forbidden: this needs the owner or admin role' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_actor := v_user::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.work_items w WHERE w.id = p_work_item_id AND w.account_id = v_tenant) THEN
    RAISE EXCEPTION 'start_gate_work_item_not_found: no such work item in this account' USING ERRCODE = 'foreign_key_violation';
  END IF;
  INSERT INTO public.decision_receipts
    (account_id, run_id, work_item_id, decision_type, class, chosen, rejected_alternative, dial_version, input_trust_classes, actor, catalogue_version)
  VALUES
    (v_tenant, NULL, p_work_item_id, p_decision_type, v_class, p_chosen, p_rejected_alternative, p_dial_version, '[]'::jsonb, v_actor, p_catalogue_version)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---- 5. answer ----------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION start_ask_answer(p_ask_id uuid, p_choice text, p_receipt_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_token   text := NULLIF(current_setting('app.token_id', true), '');
  v_user    uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_role    text;
  v_ask     record;
  v_gate    public.start_gate;
  v_outcome text;
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
  SELECT a.id, a.work_item_id, a.decision_type, a.options, a.run_id INTO v_ask
    FROM public.decision_asks a WHERE a.id = p_ask_id AND a.account_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ask_not_found: no such ask in this account' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_choice IS NULL OR (p_choice <> 'deny'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_ask.options) o WHERE o ->> 'id' = p_choice)) THEN
    RAISE EXCEPTION 'ask_bad_choice: the choice is not one of the ask''s options' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_gate FROM public.start_gate g WHERE g.account_id = v_tenant AND g.ask_id = p_ask_id;
  IF v_ask.run_id IS NOT NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'ask_receipt_mismatch: this is not a start ask' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF p_receipt_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.decision_receipts r
        WHERE r.id = p_receipt_id AND r.account_id = v_tenant AND r.work_item_id = v_ask.work_item_id
          AND r.decision_type = v_ask.decision_type AND r.chosen = p_choice AND r.run_id IS NULL AND r.actor = v_user::text)
     OR EXISTS (SELECT 1 FROM public.decision_asks o WHERE o.receipt_id = p_receipt_id AND o.id <> p_ask_id) THEN
    RAISE EXCEPTION 'ask_receipt_mismatch: the receipt is not this person''s receipt for this ask' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  UPDATE public.decision_asks
     SET state = 'answered', answered_option = p_choice, answered_by = v_user, answered_at = now(), receipt_id = p_receipt_id
   WHERE id = p_ask_id AND account_id = v_tenant AND state IN ('open', 'overdue');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ask_already_answered: the ask is no longer open' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_outcome := CASE WHEN p_choice = 'start' THEN 'started' ELSE 'declined' END;
  UPDATE public.start_gate
     SET outcome = v_outcome, receipt_id = p_receipt_id, decided_by = v_user::text, decided_at = now()
   WHERE id = v_gate.id AND account_id = v_tenant AND outcome = 'asked';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ask_already_answered: the gate row is no longer waiting' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (v_tenant, v_user::text, 'start_gate.answered',
          jsonb_build_object('gate_id', v_gate.id, 'ask_id', p_ask_id, 'work_item_id', v_ask.work_item_id, 'decision_type', v_ask.decision_type,
                             'receipt_id', p_receipt_id, 'outcome', v_outcome),
          clock_timestamp());
  RETURN v_outcome;
END $$;

REVOKE ALL ON FUNCTION start_gate_claim(uuid, text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION start_gate_attach(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION start_receipt_write(uuid, text, text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION start_ask_answer(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_gate_claim(uuid, text, text, integer, text) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION start_gate_attach(uuid, uuid, uuid) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION start_receipt_write(uuid, text, text, text, integer, integer) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION start_ask_answer(uuid, text, uuid) TO receipt_writer_invoker;
ALTER FUNCTION start_gate_claim(uuid, text, text, integer, text) OWNER TO receipt_writer;
ALTER FUNCTION start_gate_attach(uuid, uuid, uuid) OWNER TO receipt_writer;
ALTER FUNCTION start_receipt_write(uuid, text, text, text, integer, integer) OWNER TO receipt_writer;
ALTER FUNCTION start_ask_answer(uuid, text, uuid) OWNER TO receipt_writer;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
