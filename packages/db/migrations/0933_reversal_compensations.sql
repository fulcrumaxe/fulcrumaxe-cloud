-- DP7-2b (D#7 C26): the record of what a reversal sets in motion. decision_receipts cannot be updated after insert (0400), so the work a
-- reversal causes (nothing yet, a re-run, a revert pull request, a refusal) lives in its own table, one row per reversal receipt.
--
--   * reversal_compensations: account_id, the reversal receipt (unique), the work item, kind, state, a reason code from a fixed list, a priced
--     estimate (null unless priced), the pull request number, the run action id, an attempt count and the ask that allowed it (unique when set,
--     the replay key for an over-cap answer). No free-text column. RLS per account: app_user reads its own rows and holds no write grant.
--   * Writes go only through three SECURITY DEFINER functions owned by platform_ops (the 0860 / 0927 / 0930 precedent for rows that are not
--     receipts), search_path pinned, EXECUTE for receipt_writer_invoker only (the receipt login: the answer path inserts, the worker claims and
--     finishes), nothing for PUBLIC. Each refuses a platform_ops login.
--       reversal_compensation_insert  takes the receipt, kind, state, reason, estimate and ask. The account comes from the session; the work item
--                                     is read from the receipt, which must be this account's own reversal. A repeat for the same receipt or the
--                                     same ask answers the first row (o_replayed) and writes nothing.
--       reversal_compensation_claim   compare-and-set to 'running' from 'pending' (or from 'failed' while attempts < 3); counts the attempt.
--       reversal_compensation_finish  'running' to 'done' or 'failed' with a reason code, the pull request number and the run action id.
--   * What platform_ops is given, and nothing else: INSERT and column-scoped UPDATE on the new table, SELECT on four receipt columns, each behind
--     a policy that applies only to a session that is not a platform_ops login.
-- Expand-only: one table, its policies and grants, three functions.

CREATE TABLE reversal_compensations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  reversal_receipt_id uuid NOT NULL UNIQUE REFERENCES decision_receipts (id) ON DELETE NO ACTION,
  work_item_id        uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('none_before_build', 'rerun', 'revert_pr', 'refused', 'unavailable')),
  state               text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'awaiting_confirm', 'running', 'done', 'failed')),
  reason_code         text CHECK (reason_code IN ('not_reversible', 'irreversible_effect', 'retraction_unavailable', 'revert_refused',
                                                  'rerun_refused', 'state_changed', 'head_moved', 'person_managed', 'cap_allowed', 'tooling_error')),
  estimate_usd        numeric(12, 4) CHECK (estimate_usd IS NULL OR estimate_usd >= 0),
  pr_number           integer CHECK (pr_number IS NULL OR pr_number > 0),
  run_action_id       uuid,
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  ask_id              uuid UNIQUE REFERENCES decision_asks (id) ON DELETE NO ACTION,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (kind NOT IN ('refused', 'unavailable') OR (reason_code IS NOT NULL AND state IN ('done', 'failed'))),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE NO ACTION
);
CREATE INDEX idx_reversal_compensations_account_id ON reversal_compensations (account_id);
CREATE INDEX idx_reversal_compensations_work_item ON reversal_compensations (account_id, work_item_id);
CREATE INDEX idx_reversal_compensations_pending ON reversal_compensations (created_at) WHERE state IN ('pending', 'failed');

ALTER TABLE reversal_compensations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reversal_compensations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select ON reversal_compensations FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT ON reversal_compensations TO app_user;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

GRANT SELECT ON reversal_compensations TO platform_ops;
GRANT INSERT (account_id, reversal_receipt_id, work_item_id, kind, state, reason_code, estimate_usd, ask_id) ON reversal_compensations TO platform_ops;
GRANT UPDATE (state, reason_code, pr_number, run_action_id, attempts, updated_at) ON reversal_compensations TO platform_ops;
CREATE POLICY platform_ops_compensation_select ON reversal_compensations FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops');
CREATE POLICY platform_ops_compensation_insert ON reversal_compensations FOR INSERT TO platform_ops
  WITH CHECK (session_user <> 'platform_ops'
              AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND state IN ('pending', 'awaiting_confirm', 'done', 'failed'));
CREATE POLICY platform_ops_compensation_update ON reversal_compensations FOR UPDATE TO platform_ops
  USING (session_user <> 'platform_ops' AND state IN ('pending', 'failed', 'running'))
  WITH CHECK (session_user <> 'platform_ops');

-- What the insert definer reads: the receipt it points at, in the caller's own account.
GRANT SELECT (id, account_id, work_item_id, reverses_receipt_id) ON decision_receipts TO platform_ops;
CREATE POLICY platform_ops_compensation_receipt_select ON decision_receipts FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

CREATE FUNCTION reversal_compensation_insert(
  p_reversal_receipt_id uuid,
  p_kind                text,
  p_state               text,
  p_reason_code         text,
  p_estimate_usd        numeric,
  p_ask_id              uuid
)
RETURNS TABLE (o_id uuid, o_replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_item   uuid;
  v_rev    uuid;
  v_found  boolean;
  v_id     uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'reversal_compensation_insert: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'receipt_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reversal_receipt_id IS NULL OR p_kind IS NULL OR p_state IS NULL
     OR p_kind NOT IN ('none_before_build', 'rerun', 'revert_pr', 'refused', 'unavailable')
     OR p_state NOT IN ('pending', 'awaiting_confirm', 'done', 'failed') THEN
    RAISE EXCEPTION 'reversal_compensation_insert: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A repeat answers the first row and writes nothing: by receipt, or by the ask that allowed it.
  SELECT c.id INTO v_id FROM public.reversal_compensations c
   WHERE c.account_id = v_tenant AND (c.reversal_receipt_id = p_reversal_receipt_id OR (p_ask_id IS NOT NULL AND c.ask_id = p_ask_id))
   ORDER BY c.created_at LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, true; RETURN;
  END IF;

  -- The account clause is defence in depth: the receipt policy above already hides other accounts' receipts from this definer.
  SELECT r.work_item_id, r.reverses_receipt_id, true INTO v_item, v_rev, v_found
    FROM public.decision_receipts r WHERE r.id = p_reversal_receipt_id AND r.account_id = v_tenant;
  IF v_found IS NOT TRUE OR v_item IS NULL OR v_rev IS NULL THEN
    RAISE EXCEPTION 'compensation_receipt_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.reversal_compensations (account_id, reversal_receipt_id, work_item_id, kind, state, reason_code, estimate_usd, ask_id)
  VALUES (v_tenant, p_reversal_receipt_id, v_item, p_kind, p_state, p_reason_code, p_estimate_usd, p_ask_id)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, false;
END $$;

CREATE FUNCTION reversal_compensation_claim(p_id uuid)
RETURNS TABLE (o_id uuid, o_account_id uuid, o_work_item_id uuid, o_reversal_receipt_id uuid, o_kind text, o_attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'reversal_compensation_claim: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  UPDATE public.reversal_compensations c
     SET state = 'running', attempts = c.attempts + 1, updated_at = clock_timestamp()
   WHERE c.id = p_id AND c.state IN ('pending', 'failed') AND c.attempts < 3 AND c.kind IN ('rerun', 'revert_pr')
     AND (SELECT public.account_is_active(c.account_id))
  RETURNING c.id, c.account_id, c.work_item_id, c.reversal_receipt_id, c.kind, c.attempts;
END $$;

CREATE FUNCTION reversal_compensation_finish(p_id uuid, p_state text, p_reason_code text, p_pr_number integer, p_run_action_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'reversal_compensation_finish: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL OR p_state IS NULL OR p_state NOT IN ('done', 'failed') THEN
    RAISE EXCEPTION 'reversal_compensation_finish: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.reversal_compensations
     SET state = p_state, reason_code = p_reason_code, pr_number = p_pr_number, run_action_id = p_run_action_id, updated_at = clock_timestamp()
   WHERE id = p_id AND state = 'running';
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION reversal_compensation_insert(uuid, text, text, text, numeric, uuid) FROM PUBLIC, CURRENT_USER;
REVOKE ALL ON FUNCTION reversal_compensation_claim(uuid) FROM PUBLIC, CURRENT_USER;
REVOKE ALL ON FUNCTION reversal_compensation_finish(uuid, text, text, integer, uuid) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION reversal_compensation_insert(uuid, text, text, text, numeric, uuid) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION reversal_compensation_claim(uuid) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION reversal_compensation_finish(uuid, text, text, integer, uuid) TO receipt_writer_invoker;
ALTER FUNCTION reversal_compensation_insert(uuid, text, text, text, numeric, uuid) OWNER TO platform_ops;
ALTER FUNCTION reversal_compensation_claim(uuid) OWNER TO platform_ops;
ALTER FUNCTION reversal_compensation_finish(uuid, text, text, integer, uuid) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
