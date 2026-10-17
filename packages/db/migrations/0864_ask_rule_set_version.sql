-- The rule-set version on asks and receipts, and the "decided by a rule" memory of the spend_past_envelope ask
-- (D#7 AAP-a4, correction C22 A2/A3; AAP-a2 criterion 9 made true at the platform raise site).
--
--   * decision_asks.rule_set_version      the version of the customer's approval rules the ask was raised under; 0 is "no rule set".
--                                        A one-time stamp: a rule change after the raise does not touch a waiting ask. No UPDATE
--                                        grant reaches the column (0797 grants column-scoped UPDATE, and this column is not in it).
--   * decision_receipts.rule_set_version / rule_id
--                                        what decided, on the receipt. Both nullable (every older receipt has neither).
--   * decision_ask_raise()               gains p_rule_set_version integer NOT NULL. The old signature is dropped and the new one created
--                                        in this one transaction, with the same owner, search_path and EXECUTE grant (receipt pool
--                                        invoker only). A version above the highest action_rules version of the item's scope is
--                                        refused (22023): the repo's own set when the item's repo has one, else the account's.
--   * decision_receipt_write_ruled()     the receipt writer for a decision a rule had a hand in. A NEW function: decision_receipt_write()
--                                        keeps its signature, because 0767 and 0774 call it by that signature from their own definers.
--   * envelope_pause_asks                gains receipt_id; ask_id becomes nullable; exactly one of the two is set. A deny leaves a
--                                        receipt instead of an ask, in the same "already decided under this envelope version" row.
--
-- Numbered above the highest migration on main (0852; 0853-0856 and 0860-0863 are held). Re-check against main before merging.
-- 0666 and every earlier migration are untouched. receipt_writer reads action_rules (three columns, tenant-bound) to check a version.

ALTER TABLE decision_asks
  ADD COLUMN rule_set_version integer NOT NULL DEFAULT 0 CONSTRAINT decision_asks_rule_set_version_check CHECK (rule_set_version >= 0);

ALTER TABLE decision_receipts
  ADD COLUMN rule_set_version integer CONSTRAINT decision_receipts_rule_set_version_check CHECK (rule_set_version >= 0),
  ADD COLUMN rule_id text CONSTRAINT decision_receipts_rule_id_check CHECK (rule_id ~ '^[A-Za-z0-9_.-]{1,64}$');

ALTER TABLE decision_receipts
  ADD CONSTRAINT decision_receipts_rule_id_needs_version CHECK (rule_id IS NULL OR rule_set_version >= 1);

ALTER TABLE envelope_pause_asks ALTER COLUMN ask_id DROP NOT NULL;
ALTER TABLE envelope_pause_asks ADD COLUMN receipt_id uuid;
ALTER TABLE envelope_pause_asks
  ADD CONSTRAINT envelope_pause_asks_ask_xor_receipt CHECK ((ask_id IS NULL) <> (receipt_id IS NULL));

GRANT SELECT (account_id, repo_id, version) ON action_rules TO receipt_writer;
CREATE POLICY receipt_writer_select ON action_rules FOR SELECT TO receipt_writer
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

DROP FUNCTION decision_ask_raise(text, text, uuid, uuid, jsonb, text, text, jsonb, integer, text);

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
  p_timeout_outcome       text,
  p_rule_set_version      integer
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
  v_max    integer;
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

  -- The set the version names is the one that applies to this item: its repo's own when the repo has one, else the account's (0 when neither).
  SELECT max(a.version) INTO v_max FROM public.action_rules a WHERE a.account_id = v_tenant AND a.repo_id = v_repo;
  IF v_max IS NULL THEN
    SELECT max(a.version) INTO v_max FROM public.action_rules a WHERE a.account_id = v_tenant AND a.repo_id IS NULL;
  END IF;
  IF p_rule_set_version IS NULL OR p_rule_set_version < 0 OR p_rule_set_version > COALESCE(v_max, 0) THEN
    RAISE EXCEPTION 'ask_rule_set_version_invalid: the version is above the highest rule-set version of this scope' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.decision_asks
    (id, account_id, repo_id, work_item_id, run_id, decision_type, options, proposed, rationale,
     input_trust_classes, answer_due_at, timeout_outcome, rule_set_version)
  VALUES
    (v_id, v_tenant, v_repo, p_work_item_id, p_run_id, p_decision_type, p_options, p_proposed, p_rationale,
     p_input_trust_classes, now() + make_interval(mins => p_answer_window_minutes), p_timeout_outcome, p_rule_set_version);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION decision_ask_raise(text, text, uuid, uuid, jsonb, text, text, jsonb, integer, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision_ask_raise(text, text, uuid, uuid, jsonb, text, text, jsonb, integer, text, integer) TO receipt_writer_invoker;
ALTER FUNCTION decision_ask_raise(text, text, uuid, uuid, jsonb, text, text, jsonb, integer, text, integer) OWNER TO receipt_writer;

-- The receipt for a decision a rule had a hand in (a deny, or an answer to an ask raised under a rule set). Like decision_receipt_write()
-- (0663): no actor, user or account parameter; with no user session the actor is `policy`.
CREATE FUNCTION decision_receipt_write_ruled(
  p_class                text,
  p_decision_type        text,
  p_chosen               text,
  p_rejected_alternative text,
  p_dial_version         integer,
  p_input_trust_classes  jsonb,
  p_work_item_id         uuid,
  p_run_id               uuid,
  p_catalogue_version    integer,
  p_rule_set_version     integer,
  p_rule_id              text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id      uuid := gen_random_uuid();
  v_tenant  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_session text := NULLIF(current_setting('app.user_id', true), '');
  v_actor   text;
  v_max     integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'receipt_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_class = 'automated_with_monitoring' THEN
    RAISE EXCEPTION 'receipt_class1_not_durable: class 1 receipts are written to run_events, not decision_receipts'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_catalogue_version IS NULL THEN
    RAISE EXCEPTION 'receipt_missing_catalogue_version' USING ERRCODE = 'not_null_violation';
  END IF;
  IF p_rule_set_version IS NULL OR p_rule_set_version < 0 THEN
    RAISE EXCEPTION 'receipt_rule_set_version_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_rule_set_version > 0 THEN
    SELECT max(a.version) INTO v_max FROM public.action_rules a WHERE a.account_id = v_tenant;
    IF p_rule_set_version > COALESCE(v_max, 0) THEN
      RAISE EXCEPTION 'receipt_rule_set_version_invalid: the version is above the highest rule-set version of this account' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  IF v_session IS NULL THEN
    v_actor := 'policy';
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.account_members m
       WHERE m.account_id = v_tenant AND m.user_id = v_session::uuid
    ) THEN
      RAISE EXCEPTION 'receipt_actor_not_member: user is not a member of the tenant account'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_actor := v_session;
  END IF;

  INSERT INTO public.decision_receipts
    (id, account_id, run_id, work_item_id, decision_type, class, chosen, rejected_alternative,
     dial_version, input_trust_classes, actor, catalogue_version, rule_set_version, rule_id)
  VALUES
    (v_id, v_tenant, p_run_id, p_work_item_id, p_decision_type, p_class, p_chosen,
     p_rejected_alternative, p_dial_version, p_input_trust_classes, v_actor, p_catalogue_version, p_rule_set_version, p_rule_id);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION decision_receipt_write_ruled(text, text, text, text, integer, jsonb, uuid, uuid, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision_receipt_write_ruled(text, text, text, text, integer, jsonb, uuid, uuid, integer, integer, text) TO receipt_writer_invoker;
ALTER FUNCTION decision_receipt_write_ruled(text, text, text, text, integer, jsonb, uuid, uuid, integer, integer, text) OWNER TO receipt_writer;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
