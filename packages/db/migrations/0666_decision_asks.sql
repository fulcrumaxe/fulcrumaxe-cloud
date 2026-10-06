-- Decision asks: the pending question an agent raises for a customer
-- (D#7 DP11a-1, correction DP-C5). Nothing is denied by silence: an unanswered
-- ask ends by timeout_outcome (frozen at raise time), never in DENIED.
--
--   * decision_asks         RLS forced. app_user: SELECT only. The one INSERT
--                           grantee is receipt_writer.
--   * decision_asks_guard   BEFORE UPDATE, for every role: raise-time terms are
--                           frozen, open -> overdue -> answered | proceeded |
--                           withdrawn is enforced, terminal rows are immutable.
--                           Nobody holds UPDATE yet (DP11b, DP12a-2 add definers).
--   * decision_ask_raise()  SECURITY DEFINER, owned by receipt_writer, EXECUTE
--                           for receipt_writer_invoker only (0663/0665's split).
--                           No account or actor parameter: the tenant is
--                           app.account_id and repo_id comes from the work item.
--
-- Catalogue membership is checked in TypeScript (DP11a-2); the definer refuses
-- class 1 and enforces the shape. run_id is SET NULL (an ask outlives its run;
-- agent_runs is not tenant-deletable); work_item_id/repo_id are NO ACTION (0400).
-- receipt_id has no FK: receipts are age-pruned, and SET NULL would UPDATE a
-- terminal ask.

CREATE TABLE decision_asks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id              uuid,
  work_item_id         uuid NOT NULL,
  run_id               uuid,
  decision_type        text NOT NULL CHECK (decision_type <> ''),
  options              jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 6),
  proposed             text NOT NULL,
  rationale            text NOT NULL CHECK (octet_length(rationale) <= 4096),
  input_trust_classes  jsonb NOT NULL CHECK (jsonb_typeof(input_trust_classes) = 'array'),
  raised_at            timestamptz NOT NULL DEFAULT now(),
  answer_due_at        timestamptz NOT NULL,
  timeout_outcome      text NOT NULL CHECK (timeout_outcome IN ('stop_and_flag', 'proceed_recommended')),
  state                text NOT NULL DEFAULT 'open'
                         CHECK (state IN ('open', 'overdue', 'answered', 'proceeded', 'withdrawn')),
  answered_option      text,
  answered_by          uuid REFERENCES users (id),
  answered_at          timestamptz,
  receipt_id           uuid,
  notified_at          timestamptz,
  renotified_at        timestamptz,
  CHECK (answer_due_at >= raised_at + interval '15 minutes' AND answer_due_at <= raised_at + interval '14 days'),
  CHECK ((state = 'answered') = (answered_by IS NOT NULL)),
  CHECK ((state IN ('answered', 'proceeded')) = (answered_option IS NOT NULL)),
  CHECK ((state IN ('answered', 'proceeded')) = (answered_at IS NOT NULL)),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (run_id),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE NO ACTION,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE NO ACTION
);
CREATE INDEX idx_decision_asks_account_id ON decision_asks (account_id);
CREATE INDEX idx_decision_asks_pending ON decision_asks (account_id, answer_due_at) WHERE state IN ('open', 'overdue');

ALTER TABLE decision_asks ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_asks FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select ON decision_asks FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY receipt_writer_insert ON decision_asks FOR INSERT TO receipt_writer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND state = 'open'
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

GRANT SELECT ON decision_asks TO app_user;
GRANT INSERT ON decision_asks TO receipt_writer;

-- What the definer reads: the work item's repo, tenant-bound.
GRANT SELECT (id, account_id, repo_id) ON work_items TO receipt_writer;
GRANT SELECT (id, account_id, work_item_id) ON agent_runs TO receipt_writer;
CREATE POLICY receipt_writer_select ON agent_runs FOR SELECT TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY receipt_writer_select ON work_items FOR SELECT TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- State machine and immutability, for every role including the owner.
-- ---------------------------------------------------------------------
CREATE FUNCTION decision_asks_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- The only column that may change without a transition is run_id going to
  -- NULL (the agent_runs FK action).
  IF NEW.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    RAISE EXCEPTION 'decision_asks_frozen: run_id can only be cleared' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.account_id, NEW.repo_id, NEW.work_item_id, NEW.decision_type, NEW.options, NEW.proposed,
      NEW.rationale, NEW.input_trust_classes, NEW.raised_at, NEW.answer_due_at, NEW.timeout_outcome)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.repo_id, OLD.work_item_id, OLD.decision_type, OLD.options, OLD.proposed,
      OLD.rationale, OLD.input_trust_classes, OLD.raised_at, OLD.answer_due_at, OLD.timeout_outcome) THEN
    RAISE EXCEPTION 'decision_asks_frozen: an ask''s identity and raise-time terms cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT ((OLD.state = 'open' AND NEW.state IN ('overdue', 'answered', 'proceeded', 'withdrawn'))
         OR (OLD.state = 'overdue' AND NEW.state IN ('answered', 'proceeded', 'withdrawn'))) THEN
      RAISE EXCEPTION 'decision_asks_illegal_transition: % -> % is not allowed', OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.state IN ('answered', 'proceeded', 'withdrawn')
    AND (NEW.answered_option, NEW.answered_by, NEW.answered_at, NEW.receipt_id, NEW.notified_at, NEW.renotified_at)
        IS DISTINCT FROM
        (OLD.answered_option, OLD.answered_by, OLD.answered_at, OLD.receipt_id, OLD.notified_at, OLD.renotified_at) THEN
    RAISE EXCEPTION 'decision_asks_terminal: a % ask cannot change', OLD.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.answered_option IS NOT NULL AND NEW.answered_option <> 'deny'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.options) o WHERE o ->> 'id' = NEW.answered_option) THEN
    RAISE EXCEPTION 'decision_asks_bad_answer: answered_option is not one of the ask''s options' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'proceeded' AND NEW.answered_option IS DISTINCT FROM NEW.proposed THEN
    RAISE EXCEPTION 'decision_asks_bad_answer: a proceeded ask resolves to its proposed option' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER decision_asks_guard BEFORE UPDATE ON decision_asks
  FOR EACH ROW EXECUTE FUNCTION decision_asks_guard();

-- ---------------------------------------------------------------------
-- Ownership bracket (0665's shape), then the raise definer.
-- ---------------------------------------------------------------------
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

CREATE FUNCTION decision_ask_raise(
  p_class                 text,
  p_decision_type         text,
  p_work_item_id          uuid,
  p_run_id                uuid,
  p_options               jsonb,
  p_proposed              text,
  p_rationale             text,
  p_input_trust_classes   jsonb,
  p_answer_window_minutes integer,
  p_timeout_outcome       text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id     uuid := gen_random_uuid();
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_repo   uuid;
  v_opt    jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'ask_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_class = 'automated_with_monitoring' THEN
    RAISE EXCEPTION 'ask_class1_never_asks: class 1 decisions are never asked' USING ERRCODE = 'check_violation';
  END IF;
  IF p_class IS DISTINCT FROM 'human_over_the_loop' AND p_class IS DISTINCT FROM 'human_in_the_loop' THEN
    RAISE EXCEPTION 'ask_bad_class: an ask is class 2 or class 3' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision_type IS NULL OR p_decision_type = '' THEN
    RAISE EXCEPTION 'ask_missing_decision_type' USING ERRCODE = 'not_null_violation';
  END IF;
  IF p_options IS NULL OR jsonb_typeof(p_options) <> 'array' OR jsonb_array_length(p_options) NOT BETWEEN 2 AND 6 THEN
    RAISE EXCEPTION 'ask_options_invalid: options must be an array of 2 to 6' USING ERRCODE = 'check_violation';
  END IF;
  FOR v_opt IN SELECT jsonb_array_elements(p_options) LOOP
    IF jsonb_typeof(v_opt) <> 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_opt) k) IS DISTINCT FROM ARRAY['id', 'label']
       OR jsonb_typeof(v_opt -> 'id') <> 'string' OR jsonb_typeof(v_opt -> 'label') <> 'string'
       OR (v_opt ->> 'id') !~ '^[a-z][a-z0-9_]{0,31}$' OR (v_opt ->> 'id') = 'deny'
       OR char_length(v_opt ->> 'label') NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'ask_options_invalid: each option is {id, label} with a valid id and a label of 1-200 characters'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT o ->> 'id') FROM jsonb_array_elements(p_options) o) <> jsonb_array_length(p_options) THEN
    RAISE EXCEPTION 'ask_options_invalid: option ids must be distinct' USING ERRCODE = 'check_violation';
  END IF;
  IF p_proposed IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_options) o WHERE o ->> 'id' = p_proposed) THEN
    RAISE EXCEPTION 'ask_proposed_not_in_options: proposed must be one of the option ids' USING ERRCODE = 'check_violation';
  END IF;
  IF p_rationale IS NULL OR octet_length(p_rationale) > 4096 THEN
    RAISE EXCEPTION 'ask_rationale_invalid: rationale is required and at most 4 KiB' USING ERRCODE = 'check_violation';
  END IF;
  IF p_answer_window_minutes IS NULL OR p_answer_window_minutes NOT BETWEEN 15 AND 20160 THEN
    RAISE EXCEPTION 'ask_window_out_of_range: the answer window is 15 minutes to 14 days' USING ERRCODE = 'check_violation';
  END IF;

  SELECT w.repo_id INTO v_repo FROM public.work_items w WHERE w.id = p_work_item_id AND w.account_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ask_work_item_not_found: no such work item in this account' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.agent_runs r
     WHERE r.id = p_run_id AND r.account_id = v_tenant AND r.work_item_id = p_work_item_id
  ) THEN
    RAISE EXCEPTION 'ask_run_not_for_work_item: the run does not belong to this work item' USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO public.decision_asks
    (id, account_id, repo_id, work_item_id, run_id, decision_type, options, proposed, rationale,
     input_trust_classes, answer_due_at, timeout_outcome)
  VALUES
    (v_id, v_tenant, v_repo, p_work_item_id, p_run_id, p_decision_type, p_options, p_proposed, p_rationale,
     p_input_trust_classes, now() + make_interval(mins => p_answer_window_minutes), p_timeout_outcome);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION decision_ask_raise(text, text, uuid, uuid, jsonb, text, text, jsonb, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision_ask_raise(text, text, uuid, uuid, jsonb, text, text, jsonb, integer, text) TO receipt_writer_invoker;
ALTER FUNCTION decision_ask_raise(text, text, uuid, uuid, jsonb, text, text, jsonb, integer, text) OWNER TO receipt_writer;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
