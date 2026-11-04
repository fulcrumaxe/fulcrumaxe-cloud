-- D#7 DW-R4: the receipt behind a merge made by policy, and behind a pull request the merge dial left for a person. The merge gate runs in the web
-- app, whose database login is not the receipt login (and should not become one), so the app login gets one narrow function instead, in the shape of 0767.
--
-- merge_receipt_write(work item, head, run, outcome, chosen, dial version, catalogue version) writes ONE class 2 receipt of the type
-- merge_after_reviews, through the existing writer decision_receipt_write and nothing else. It is owned by merge_receipt_definer, a NOLOGIN
-- role with no INSERT on decision_receipts of its own (it is a member of receipt_writer_invoker, whose only privilege is EXECUTE on the
-- receipt definers), so a mistake in the body cannot write a receipt by another route.
--
--   * The account comes from the session (app.account_id), never from an argument; the actor is `policy` by construction: a session that
--     carries a user or a token is refused, so a person's click can not leave a policy receipt and a policy receipt can not name a person.
--   * The run must be one of this work item's own runs.
--   * outcome 'merged': the item must have a merge recorded at that head, either a merged_by_gate fact (the gate writes it once GitHub has said the merge
--     happened) or a merged_via_queue fact (the webhook or the reconcile writes it for a merge GitHub's queue made of a pull request the gate had put
--     there), at the head that fact records. chosen is act or announce and must be what the repository's dial said at the version named (version 0 is
--     the catalogue default, act).
--   * outcome 'ready': the repository's dial must itself say ask at the version named (a hold caused only by the role setting gets no receipt), the
--     newest merge_gate fact at that head must say ready_human_merges with auto_merge_not_allowed as its only reason, and nothing merged at that head.
--     chosen is ask.
--   * A work item of another account has no rows in the caller's tenant: it answers "no such work item" like a missing one.
--   * At most one receipt per merge, and one per held head, including two callers at once. The receipt is keyed on the merge, not on the run: an
--     advisory lock per work item, then a look for a receipt of the same kind written at or after the first fact of that merge (or of that hold) at that
--     head. A review that re-runs, or a second writer arriving late, therefore answers the receipt that is there. There is no unique index on
--     decision_receipts for this type, so the lock is what makes it one.
--
-- Accepted risk, stated plainly: a caller that holds raw SQL on the app login can insert a merge fact itself and then ask for a receipt for it, because the
-- same login both merges and records that fact. The same caller can also name dial version 0 with `act` for a repository whose dial says otherwise; that
-- changes only what the receipt says, never what the gate decides. The ordinary code paths cannot choose a fact kind. This function stops a call that names a merge nobody
-- recorded; it does not stop someone who can write the record.
--
-- Refusals use fixed SQLSTATEs and messages, never an argument value: 42501 not permitted, P0002 nothing recorded, 22023 invalid argument.
-- EXECUTE for app_user alone (the runner login is a member of it). Expand-only. Numbered above the others in flight (0981, 0982).

DO $$
DECLARE
  n text := 'merge_receipt_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

-- What the body reads, column by column, each behind a row policy of its own held to the caller's tenant.
GRANT USAGE ON SCHEMA public TO merge_receipt_definer;
GRANT SELECT (id, deleted_at) ON accounts TO merge_receipt_definer;
GRANT SELECT (id, account_id, repo_id) ON work_items TO merge_receipt_definer;
GRANT SELECT (account_id, work_item_id, kind, code, reasons, head_sha, seq, created_at) ON work_item_driver_events TO merge_receipt_definer;
GRANT SELECT (id, account_id, work_item_id) ON agent_runs TO merge_receipt_definer;
GRANT SELECT (account_id, repo_id, decision_type, disposition, preset, version) ON decision_settings TO merge_receipt_definer;
GRANT SELECT (id, account_id, work_item_id, decision_type, run_id, chosen, created_at) ON decision_receipts TO merge_receipt_definer;

CREATE POLICY merge_receipt_definer_select ON accounts FOR SELECT TO merge_receipt_definer USING (true);
CREATE POLICY merge_receipt_definer_select ON work_items FOR SELECT TO merge_receipt_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY merge_receipt_definer_select ON work_item_driver_events FOR SELECT TO merge_receipt_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY merge_receipt_definer_select ON agent_runs FOR SELECT TO merge_receipt_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY merge_receipt_definer_select ON decision_settings FOR SELECT TO merge_receipt_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY merge_receipt_definer_select ON decision_receipts FOR SELECT TO merge_receipt_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- How the body calls decision_receipt_write without any INSERT grant of its own (0767's way).
GRANT receipt_writer_invoker TO merge_receipt_definer;

-- Ownership bracket (0757's shape): a non-superuser migrator needs SET on the role for ALTER ... OWNER TO.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'merge_receipt_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on merge_receipt_definer; cannot ALTER FUNCTION ... OWNER TO merge_receipt_definer';
    END IF;
    GRANT merge_receipt_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO merge_receipt_definer;

CREATE FUNCTION merge_receipt_write(
  p_work_item_id uuid, p_head_sha text, p_run_id uuid, p_outcome text, p_chosen text, p_dial_version integer, p_catalogue_version integer
)
RETURNS TABLE (o_id uuid, o_replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_repo   uuid;
  v_id     uuid;
  v_disp   text;
  v_preset text;
  v_code   text;
  v_reasons text[];
  v_fact_at timestamptz;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'merge_receipt_write: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'merge_receipt_write: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The actor is `policy`: a session that has a person or a token is refused rather than recorded under that name.
  IF NULLIF(current_setting('app.user_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'merge_receipt_write: only a policy session writes this receipt' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_run_id IS NULL OR p_head_sha IS NULL OR p_head_sha !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
     OR p_outcome IS NULL OR p_outcome NOT IN ('merged', 'ready')
     OR p_chosen IS NULL OR (p_outcome = 'ready' AND p_chosen <> 'ask')
     OR (p_outcome = 'merged' AND p_chosen NOT IN ('act', 'announce'))
     OR p_dial_version IS NULL OR p_dial_version < 0 OR p_catalogue_version IS NULL OR p_catalogue_version < 1 THEN
    RAISE EXCEPTION 'merge_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Only this tenant's items are visible, so another account's item answers like a missing one.
  SELECT w.repo_id INTO v_repo FROM public.work_items w WHERE w.account_id = acct AND w.id = p_work_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge_receipt_write: no such work item' USING ERRCODE = 'no_data_found';
  END IF;

  -- The run must be this item's own.
  IF NOT EXISTS (SELECT 1 FROM public.agent_runs a WHERE a.account_id = acct AND a.id = p_run_id AND a.work_item_id = p_work_item_id) THEN
    RAISE EXCEPTION 'merge_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The first fact of this merge (or of this hold) at that head; nothing recorded there, nothing to receipt.
  IF p_outcome = 'merged' THEN
    SELECT min(e.created_at) INTO v_fact_at FROM public.work_item_driver_events e
     WHERE e.account_id = acct AND e.work_item_id = p_work_item_id AND e.kind IN ('merged_by_gate', 'merged_via_queue') AND e.head_sha = p_head_sha;
    IF v_fact_at IS NULL THEN
      RAISE EXCEPTION 'merge_receipt_write: no merge is recorded at that head' USING ERRCODE = 'no_data_found';
    END IF;
  ELSE
    SELECT min(e.created_at) INTO v_fact_at FROM public.work_item_driver_events e
     WHERE e.account_id = acct AND e.work_item_id = p_work_item_id AND e.kind = 'merge_gate' AND e.head_sha = p_head_sha
       AND e.code = 'ready_human_merges' AND e.reasons = ARRAY['auto_merge_not_allowed']::text[];
    IF v_fact_at IS NULL THEN
      RAISE EXCEPTION 'merge_receipt_write: the gate left no policy-only hold at that head' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  -- One receipt per merge (and per held head): serialise on the item, then look for one of this kind written at or after the first fact. A receipt that is
  -- there answers first, before any check of what the facts say now: a later gate fact at the same head must not turn a replay into an error.
  PERFORM pg_advisory_xact_lock(hashtextextended('merge_receipt:' || acct::text || ':' || p_work_item_id::text, 0));
  SELECT r.id INTO v_id FROM public.decision_receipts r
   WHERE r.account_id = acct AND r.work_item_id = p_work_item_id AND r.decision_type = 'merge_after_reviews'
     AND (r.chosen IN ('act', 'announce')) = (p_outcome = 'merged') AND r.created_at >= v_fact_at
   ORDER BY r.created_at, r.id LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_id, true; RETURN;
  END IF;

  IF p_outcome = 'ready' THEN
    -- A new hold receipt needs the newest fact at the head to be the policy-only hold, and nothing merged there.
    SELECT e.code, e.reasons INTO v_code, v_reasons FROM public.work_item_driver_events e
     WHERE e.account_id = acct AND e.work_item_id = p_work_item_id AND e.kind = 'merge_gate' AND e.head_sha = p_head_sha
     ORDER BY e.seq DESC LIMIT 1;
    IF v_code IS DISTINCT FROM 'ready_human_merges' OR v_reasons IS DISTINCT FROM ARRAY['auto_merge_not_allowed']::text[]
       OR EXISTS (SELECT 1 FROM public.work_item_driver_events e
                   WHERE e.account_id = acct AND e.work_item_id = p_work_item_id AND e.kind IN ('merged_by_gate', 'merged_via_queue') AND e.head_sha = p_head_sha) THEN
      RAISE EXCEPTION 'merge_receipt_write: the gate left no policy-only hold at that head' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  -- What the receipt names must be what the dial said at the version given: version 0 is the catalogue default (act); a "use the default" version is act too.
  IF p_dial_version > 0 THEN
    SELECT s.disposition, s.preset INTO v_disp, v_preset FROM public.decision_settings s
     WHERE s.account_id = acct AND s.repo_id = v_repo AND s.decision_type = 'merge_after_reviews' AND s.version = p_dial_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'merge_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_disp := CASE WHEN v_preset = 'default' THEN 'act' ELSE v_disp END;
  ELSE
    v_disp := 'act';
  END IF;
  IF p_chosen IS DISTINCT FROM v_disp THEN
    RAISE EXCEPTION 'merge_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_id := public.decision_receipt_write('human_over_the_loop', 'merge_after_reviews', p_chosen, CASE p_outcome WHEN 'merged' THEN 'ask' ELSE 'act' END,
                                        p_dial_version, '[]'::jsonb, p_work_item_id, p_run_id, p_catalogue_version);
  RETURN QUERY SELECT v_id, false;
END;
$$;

REVOKE ALL ON FUNCTION merge_receipt_write(uuid, text, uuid, text, text, integer, integer) FROM PUBLIC;
ALTER FUNCTION merge_receipt_write(uuid, text, uuid, text, text, integer, integer) OWNER TO merge_receipt_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner), to app_user alone.
GRANT EXECUTE ON FUNCTION merge_receipt_write(uuid, text, uuid, text, text, integer, integer) TO app_user;

REVOKE CREATE ON SCHEMA public FROM merge_receipt_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE merge_receipt_definer FROM CURRENT_USER;
  END IF;
END
$$;
