-- D#7 start gate, part (b): an undo path for a withdrawn start ask, and a person's click that decides a pair whose row is already `asked` or `declined`.
--
-- 0913 left two gaps. (1) A start ask the sweep withdrew (its item closed, halted or superseded) left the gate row `asked` forever, so the pair
-- could never be asked again. (2) A person's click on a pair that already had a row only replayed it: a click on an `asked` pair neither answered
-- the ask nor started anything, and a click on a `declined` pair could never change the hold. A person's click is the person's decision and always
-- wins; a dial never overrides a person's hold.
--
--   1. outcome gains `withdrawn`: the ask is gone and nobody decided. It is a re-raisable state, not a terminal one.
--   2. start_gate_release(gate): `asked` -> `withdrawn`, only when the gate's own ask really is withdrawn (derived from the ask, never a stamp the
--      caller supplies). Idempotent: any other state is returned unchanged.
--   3. start_gate_reopen(gate, outcome): `withdrawn` -> `asked` (the dial asks again; ask_id is cleared so the new ask can be attached), or
--      `declined`/`withdrawn` -> `started` (a person's click; receipt_id is cleared so the new receipt can be attached). A policy start may reopen
--      only a withdrawn class 2 pair: a hold is a person's, and so is a class 3 start.
--   4. start_gate_guard is rewritten with the transitions above. `started` stays terminal.
--
-- Both functions: SECURITY DEFINER, owned by receipt_writer, EXECUTE for receipt_writer_invoker only, no account, user or actor parameter. Each
-- change writes an audit row from the definer; the receipt_writer audit policy is widened by exactly those two actions. Expand-only.

-- ---- 1. the outcome set --------------------------------------------------------------------------------------------------------------------
ALTER TABLE start_gate DROP CONSTRAINT start_gate_outcome_check;
ALTER TABLE start_gate ADD CONSTRAINT start_gate_outcome_check CHECK (outcome IN ('asked', 'started', 'declined', 'withdrawn'));

-- ---- 2. the guard --------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION start_gate_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.id, NEW.account_id, NEW.work_item_id, NEW.decision_type, NEW.preset, NEW.dial_version, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.work_item_id, OLD.decision_type, OLD.preset, OLD.dial_version, OLD.created_at) THEN
    RAISE EXCEPTION 'start_gate_frozen: a start gate row''s identity cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.outcome IS DISTINCT FROM OLD.outcome THEN
    -- asked -> started | declined | withdrawn (the answer, or the sweep); withdrawn -> asked (the dial asks again) | started (a click or a class 2 policy start);
    -- declined -> started (a person changes the hold). Started never changes.
    IF NOT ((OLD.outcome = 'asked' AND NEW.outcome IN ('started', 'declined', 'withdrawn'))
         OR (OLD.outcome = 'withdrawn' AND NEW.outcome IN ('asked', 'started'))
         OR (OLD.outcome = 'declined' AND NEW.outcome = 'started')) THEN
      RAISE EXCEPTION 'start_gate_terminal: a % start gate row cannot become %', OLD.outcome, NEW.outcome USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.outcome = 'withdrawn' AND NEW.outcome = 'asked' AND (NEW.ask_id IS NOT NULL OR NEW.receipt_id IS NOT NULL) THEN
      RAISE EXCEPTION 'start_gate_frozen: a reopened ask starts without an ask' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.outcome IN ('withdrawn', 'declined') AND NEW.outcome = 'started' AND NEW.receipt_id IS NOT NULL THEN
      RAISE EXCEPTION 'start_gate_frozen: a reopened start starts without a receipt' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.outcome = 'asked' AND NEW.outcome IN ('started', 'declined') AND NEW.ask_id IS DISTINCT FROM OLD.ask_id THEN
      RAISE EXCEPTION 'start_gate_frozen: the ask is set once' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.outcome = 'asked' AND NEW.outcome = 'withdrawn' AND (NEW.ask_id IS DISTINCT FROM OLD.ask_id OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id) THEN
      RAISE EXCEPTION 'start_gate_frozen: the ask is set once' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.outcome = 'withdrawn' AND NEW.outcome = 'started' AND NEW.ask_id IS DISTINCT FROM OLD.ask_id THEN
      RAISE EXCEPTION 'start_gate_frozen: the ask is set once' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.outcome = 'declined' AND NEW.outcome = 'started' AND NEW.ask_id IS DISTINCT FROM OLD.ask_id THEN
      RAISE EXCEPTION 'start_gate_frozen: the ask is set once' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- Same outcome. A decided row is final once it names its receipt; until then (a start claimed, its receipt not yet attached) only the receipt may be added.
  IF OLD.outcome IN ('started', 'declined', 'withdrawn') AND (
       NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.ask_id IS DISTINCT FROM OLD.ask_id OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id)
       OR (OLD.outcome = 'withdrawn' AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id)) THEN
    RAISE EXCEPTION 'start_gate_terminal: a % start gate row cannot change', OLD.outcome USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.ask_id IS NOT NULL AND NEW.ask_id IS DISTINCT FROM OLD.ask_id) OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id) THEN
    RAISE EXCEPTION 'start_gate_frozen: the ask and the receipt are set once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---- audit policy: the two new actions -----------------------------------------------------------------------------------------------------
DROP POLICY receipt_writer_start_gate_audit ON audit_log;
CREATE POLICY receipt_writer_start_gate_audit ON audit_log FOR INSERT TO receipt_writer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND action IN ('start_gate.recorded', 'start_gate.answered', 'start_gate.withdrawn', 'start_gate.reopened'));

-- ---- ownership bracket (0913's shape) ------------------------------------------------------------------------------------------------------
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

-- ---- 3. release: asked -> withdrawn ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION start_gate_release(p_gate_id uuid)
RETURNS text
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
  IF v_token IS NOT NULL OR NOT public.account_is_active(v_tenant) THEN
    RAISE EXCEPTION 'start_gate_release: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL THEN
    v_actor := 'policy';
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = v_tenant AND m.user_id = v_user AND m.role IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'start_gate_forbidden: this needs the owner or admin role' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_actor := v_user::text;
  END IF;
  IF p_gate_id IS NULL THEN
    RAISE EXCEPTION 'start_gate_release: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO g FROM public.start_gate x WHERE x.id = p_gate_id AND x.account_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'start_gate_not_found: no such gate row in this account' USING ERRCODE = 'no_data_found';
  END IF;
  IF g.outcome <> 'asked' OR g.ask_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.decision_asks a WHERE a.id = g.ask_id AND a.account_id = v_tenant AND a.state = 'withdrawn') THEN
    RETURN g.outcome;
  END IF;
  UPDATE public.start_gate SET outcome = 'withdrawn', decided_by = v_actor, decided_at = now() WHERE id = g.id;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (v_tenant, v_actor, 'start_gate.withdrawn',
          jsonb_build_object('gate_id', g.id, 'ask_id', g.ask_id, 'work_item_id', g.work_item_id, 'decision_type', g.decision_type),
          clock_timestamp());
  RETURN 'withdrawn';
END $$;

-- ---- 4. reopen: withdrawn -> asked | started, declined -> started ----------------------------------------------------------------------------
CREATE FUNCTION start_gate_reopen(p_gate_id uuid, p_outcome text)
RETURNS text
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
  IF v_token IS NOT NULL OR NOT public.account_is_active(v_tenant) THEN
    RAISE EXCEPTION 'start_gate_reopen: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_gate_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('asked', 'started') THEN
    RAISE EXCEPTION 'start_gate_reopen: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_user IS NULL THEN
    v_actor := 'policy';
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = v_tenant AND m.user_id = v_user AND m.role IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'start_gate_forbidden: starting work needs the owner or admin role' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_actor := v_user::text;
  END IF;
  -- A dial raises an ask; a person never does.
  IF p_outcome = 'asked' AND v_user IS NOT NULL THEN
    RAISE EXCEPTION 'start_gate_reopen: only the dial raises a start ask' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO g FROM public.start_gate x WHERE x.id = p_gate_id AND x.account_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'start_gate_not_found: no such gate row in this account' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_outcome = 'asked' THEN
    IF g.outcome <> 'withdrawn' THEN
      RAISE EXCEPTION 'start_gate_reopen: only a withdrawn ask can be asked again' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    UPDATE public.start_gate SET outcome = 'asked', ask_id = NULL, receipt_id = NULL, decided_by = NULL, decided_at = NULL WHERE id = g.id;
  ELSE
    IF v_user IS NULL THEN
      -- The dial's own start: a withdrawn class 2 pair only. A hold stays a person's to change, and a class 3 start is always a person's.
      IF g.outcome <> 'withdrawn' OR g.decision_type NOT IN ('start_work_small', 'start_work_bug', 'start_work_doc') THEN
        RAISE EXCEPTION 'start_gate_reopen: this start is a person''s' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF g.outcome NOT IN ('declined', 'withdrawn') THEN
      RAISE EXCEPTION 'start_gate_reopen: nothing to decide again' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    UPDATE public.start_gate SET outcome = 'started', receipt_id = NULL, decided_by = v_actor, decided_at = now() WHERE id = g.id;
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (v_tenant, v_actor, 'start_gate.reopened',
          jsonb_build_object('gate_id', g.id, 'work_item_id', g.work_item_id, 'decision_type', g.decision_type, 'from', g.outcome, 'outcome', p_outcome),
          clock_timestamp());
  RETURN p_outcome;
END $$;

REVOKE ALL ON FUNCTION start_gate_release(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION start_gate_reopen(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_gate_release(uuid) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION start_gate_reopen(uuid, text) TO receipt_writer_invoker;
ALTER FUNCTION start_gate_release(uuid) OWNER TO receipt_writer;
ALTER FUNCTION start_gate_reopen(uuid, text) OWNER TO receipt_writer;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
