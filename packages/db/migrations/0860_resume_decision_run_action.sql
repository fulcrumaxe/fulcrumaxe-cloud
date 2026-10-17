-- D#7 DP11c (corrections DP-C9 section 5 and DP-C11 R-7-DP4b-3): a run action of its own for resuming a parked item from the answer to its ask
-- (`resume_decision`). The answer (0797) writes the request in its own transaction; a proceed-recommended timeout and an answer made before this
-- shipped are covered by a reconcile on the worker tick.
--   1. run_action_requests: `kind` accepts the new kind (same drop/re-add as 0791); `principal_kind` accepts 'system' (the reconcile's, and only for
--      this kind: a table CHECK ties 'system' to requested_by = 'system'); `resume_halt_epoch` records the item's halt epoch when the request was made
--      (set by the definers from the database, never by a caller), so a halt after the answer is seen even when it was lifted again; and a unique index
--      makes ONE resume per ask across principals (the session's and the system's differ in requested_by, so the per-requester key cannot).
--   2. run_action_request (the app_user definer): same body, signature, owner and ACL as 0791's, plus the new kind: a session owner or admin only (a token
--      can never request it), its target is an ASK of this tenant in state 'answered', and a repeat for the same ask returns the first request in any state.
--   3. run_action_perform_principal: the 'system' principal is allowed for this kind only (user_id NULL); every performer of another kind already refuses a
--      row with no user.
--   4. resume_decision_reconcile(limit): the system path. Owned by platform_ops (which already writes this table), EXECUTE for receipt_writer_invoker only,
--      never app_user. One statement: every answered or proceeded ask (with a run, answered in the last 30 days, in an active account) that has no
--      resume_decision request of any state gets one, requested_by the literal 'system'. 30 days is under the 90 the purge keeps finished requests, so a
--      purged request can never make the ask look unresumed. Concurrent ticks lose to the unique index (ON CONFLICT DO NOTHING).
--   5. run_action_defer_resume(action, seconds): the one transition for a resume whose start is waiting on something that clears by itself (a spending limit a
--      person raises, a sandbox being reaped, another run still live). It puts a live claim of this kind back to accepted, due after the delay, and gives the
--      claim's attempt back, so a pause that lasts days does not use up the five attempts a failure gets (0686 does the same for a page of progress). It stops
--      at 14 days after the request was made ('expired', changing nothing); the caller then settles the request, and the item shows why.
--   6. work_item_driver_events gains the kind `resume_refused`: the fixed code a refused or failed resume leaves on the item, so a person can tell it from nothing happening.
-- What platform_ops is given for this, and nothing else: column-scoped SELECT on decision_asks and work_items.halt_epoch, a policy that shows it answered or
-- proceeded asks (and the work item of one) across tenants, and an INSERT policy for system resume rows.
-- Numbered 0860 (reserved); the highest on the code plane at writing is 0851. Privilege brackets as in 0658/0682/0791.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

ALTER TABLE run_action_requests DROP CONSTRAINT run_action_requests_kind_check;
ALTER TABLE run_action_requests ADD CONSTRAINT run_action_requests_kind_check
  CHECK (kind IN ('cancel_run', 'cancel_work_item', 'retry_run', 'continue_work_item', 'start_preview', 'advance_work_item', 'respec_work_item', 'amend_spec_work_item', 'resume_decision'));
ALTER TABLE run_action_requests DROP CONSTRAINT run_action_requests_principal_kind_check;
ALTER TABLE run_action_requests ADD CONSTRAINT run_action_requests_principal_kind_check CHECK (principal_kind IN ('session', 'token', 'system'));
ALTER TABLE run_action_requests ADD CONSTRAINT run_action_requests_system_shape
  CHECK ((principal_kind = 'system') = (requested_by = 'system') AND (principal_kind <> 'system' OR kind = 'resume_decision'));
ALTER TABLE run_action_requests ADD COLUMN resume_halt_epoch integer;
ALTER TABLE run_action_requests ADD CONSTRAINT run_action_requests_resume_epoch CHECK ((kind = 'resume_decision') = (resume_halt_epoch IS NOT NULL));
CREATE UNIQUE INDEX run_action_requests_one_resume_per_ask ON run_action_requests (account_id, target_id) WHERE kind = 'resume_decision';

GRANT INSERT (resume_halt_epoch) ON run_action_requests TO platform_ops;
CREATE POLICY platform_ops_insert_system_resume ON run_action_requests FOR INSERT TO platform_ops
  WITH CHECK (session_user <> 'platform_ops' AND kind = 'resume_decision' AND principal_kind = 'system' AND requested_by = 'system'
              AND (SELECT account_is_active(account_id)));

-- What the two definers read. The tenant branch serves the session path (the ask must be this tenant's); the state branch serves the reconcile, which has no
-- tenant, and shows only asks that are answered or proceeded.
GRANT SELECT (id, account_id, work_item_id, run_id, state, answered_at) ON decision_asks TO platform_ops;
CREATE POLICY platform_ops_resume_select ON decision_asks FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops'
         AND (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid OR state IN ('answered', 'proceeded')));
GRANT SELECT (halt_epoch) ON work_items TO platform_ops;
CREATE POLICY platform_ops_resume_reconcile ON work_items FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops'
         AND EXISTS (SELECT 1 FROM decision_asks a
                      WHERE a.account_id = work_items.account_id AND a.work_item_id = work_items.id AND a.state IN ('answered', 'proceeded')));

-- Dropped and recreated (no CASCADE) with the same signature, owner and ACL: a Neon-shaped migrator cannot replace it, because platform_ops (the owner)
-- holds no EXECUTE on the performer-side ones, and 0791 did the same for this one.
DROP FUNCTION run_action_request(text, uuid, text, text);
CREATE FUNCTION run_action_request(p_kind text, p_target_id uuid, p_idempotency_key text, p_request_hash text)
RETURNS TABLE (action_id uuid, state text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  tok    uuid := NULLIF(current_setting('app.token_id', true), '')::uuid;
  usr    uuid := current_member_user_id();
  scopes text[];
  who    text;
  pkind  text;
  r      public.run_action_requests;
  new_id uuid;
  v_epoch integer;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'run_action_request: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF tok IS NOT NULL THEN
    SELECT t.scopes INTO scopes FROM public.api_tokens t
     WHERE t.id = tok AND t.account_id = acct AND t.revoked_at IS NULL AND t.expires_at > now();
    IF NOT FOUND THEN
      RAISE EXCEPTION 'run_action_request: caller token is not a live token of this account' USING ERRCODE = 'insufficient_privilege';
    END IF;
    who := 'token:' || tok::text; pkind := 'token';
  ELSIF usr IS NOT NULL THEN
    who := 'session:' || usr::text; pkind := 'session';
  ELSE
    RAISE EXCEPTION 'run_action_request: caller is neither a verified member nor a resolved token' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('cancel_run', 'cancel_work_item', 'retry_run', 'continue_work_item', 'start_preview', 'advance_work_item', 'respec_work_item', 'amend_spec_work_item', 'resume_decision')
     OR char_length(COALESCE(p_request_hash, '')) NOT BETWEEN 1 AND 128
     OR char_length(COALESCE(p_idempotency_key, 'k')) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'run_action_request: invalid kind, key or hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF pkind = 'token' AND NOT (p_kind IN ('cancel_run', 'cancel_work_item') AND 'runs:cancel' = ANY (scopes)) THEN
    RAISE EXCEPTION 'run_action_request: token may not request %', p_kind USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind IN ('start_preview', 'advance_work_item', 'respec_work_item', 'amend_spec_work_item', 'resume_decision') AND pkind = 'session' AND COALESCE(current_member_role(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'run_action_request: a session owner or admin only may request %', p_kind USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR i IN 1..3 LOOP
    IF p_idempotency_key IS NOT NULL THEN
      SELECT * INTO r FROM public.run_action_requests q
       WHERE q.account_id = acct AND q.requested_by = who AND q.idempotency_key = p_idempotency_key;
      IF FOUND THEN
        IF r.request_hash <> p_request_hash THEN
          RAISE EXCEPTION 'run_action_request: idempotency key reused with a different request' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        RETURN QUERY SELECT r.id, r.state, true; RETURN;
      END IF;
    END IF;
    -- One resume per ask, whoever asked and whatever became of the first request.
    IF p_kind = 'resume_decision' THEN
      SELECT * INTO r FROM public.run_action_requests q WHERE q.account_id = acct AND q.kind = 'resume_decision' AND q.target_id = p_target_id;
      IF FOUND THEN
        RETURN QUERY SELECT r.id, r.state, true; RETURN;
      END IF;
    END IF;
    SELECT * INTO r FROM public.run_action_requests q
     WHERE q.account_id = acct AND q.kind = p_kind AND q.target_id = p_target_id AND q.state IN ('accepted', 'claimed');
    IF FOUND THEN
      RETURN QUERY SELECT r.id, r.state, true; RETURN;
    END IF;
    IF p_kind IN ('cancel_run', 'retry_run') THEN
      PERFORM 1 FROM public.agent_runs x WHERE x.id = p_target_id AND x.account_id = acct;
    ELSIF p_kind = 'start_preview' THEN
      PERFORM 1 FROM public.onboarding_previews x WHERE x.id = p_target_id AND x.account_id = acct AND x.state = 'requested';
    ELSIF p_kind = 'resume_decision' THEN
      -- The target is an ASK of this tenant that a person answered. The item's halt epoch is recorded from the database, here and now.
      SELECT w.halt_epoch INTO v_epoch FROM public.decision_asks x
        JOIN public.work_items w ON w.account_id = x.account_id AND w.id = x.work_item_id
       WHERE x.id = p_target_id AND x.account_id = acct AND x.state = 'answered';
    ELSE
      PERFORM 1 FROM public.work_items x WHERE x.id = p_target_id AND x.account_id = acct;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'run_action_request: target not found' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO public.run_action_requests (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash, resume_halt_epoch)
    VALUES (acct, p_kind, p_target_id, who, pkind, p_idempotency_key, p_request_hash, v_epoch)
    ON CONFLICT DO NOTHING RETURNING id INTO new_id;
    IF new_id IS NOT NULL THEN
      INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
      VALUES (acct, who, 'run_action.requested', jsonb_build_object(
        'action_id', new_id, 'kind', p_kind, 'target_id', p_target_id, 'principal_kind', pkind), clock_timestamp());
      RETURN QUERY SELECT new_id, 'accepted'::text, false; RETURN;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'run_action_request: concurrent request could not be resolved' USING ERRCODE = 'serialization_failure';
END $$;

REVOKE ALL ON FUNCTION run_action_request(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION run_action_request(text, uuid, text, text) TO app_user;
ALTER FUNCTION run_action_request(text, uuid, text, text) OWNER TO platform_ops;

-- The perform-side principal (0682's body), plus the system principal: allowed only for this kind, with no user to run as (the performer finds one itself).
DROP FUNCTION run_action_perform_principal(uuid);
CREATE FUNCTION run_action_perform_principal(p_action_id uuid)
RETURNS TABLE (allowed boolean, account_id uuid, kind text, target_id uuid, principal_kind text, user_id uuid, token_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  r   public.run_action_requests;
  m   text[];
  ok  boolean := false;
  uid uuid;
  tid uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_action_perform_principal: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM public.run_action_requests q WHERE q.id = p_action_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_action_perform_principal: no such action' USING ERRCODE = 'P0002';
  END IF;
  -- The replay guard: only a live lease may be performed.
  IF r.state <> 'claimed' OR r.claimed_until IS NULL OR r.claimed_until <= now() THEN
    RAISE EXCEPTION 'run_action_perform_principal: action has no live lease' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF r.principal_kind = 'system' THEN
    -- Only the reconcile makes these (the table CHECK ties them to this kind and to the literal requester).
    ok := r.requested_by = 'system' AND r.kind = 'resume_decision'
          AND public.account_is_active(r.account_id)
          AND (SELECT a.status FROM public.accounts a WHERE a.id = r.account_id) <> 'paused';
  ELSE
    m := regexp_match(r.requested_by, '^(session|token):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
    IF m IS NOT NULL AND m[1] = r.principal_kind
       AND public.account_is_active(r.account_id)
       AND (SELECT a.status FROM public.accounts a WHERE a.id = r.account_id) <> 'paused' THEN
      IF m[1] = 'session' THEN
        PERFORM 1 FROM public.account_members am WHERE am.account_id = r.account_id AND am.user_id = m[2]::uuid;
        IF FOUND THEN ok := true; uid := m[2]::uuid; END IF;
      ELSE
        -- The route's rule: scope runs:cancel, and the creator is still a member.
        SELECT t.id, t.created_by INTO tid, uid
          FROM public.api_tokens t
          JOIN public.account_members am ON am.account_id = t.account_id AND am.user_id = t.created_by
         WHERE t.id = m[2]::uuid AND t.account_id = r.account_id
           AND t.revoked_at IS NULL AND t.expires_at > now()
           AND 'runs:cancel' = ANY (t.scopes)
           AND r.kind IN ('cancel_run', 'cancel_work_item');
        ok := FOUND;
      END IF;
    END IF;
  END IF;

  IF NOT ok THEN
    RETURN QUERY SELECT false, r.account_id, r.kind, r.target_id, r.principal_kind, NULL::uuid, NULL::uuid;
  ELSE
    RETURN QUERY SELECT true, r.account_id, r.kind, r.target_id, r.principal_kind, uid, tid;
  END IF;
END $$;
REVOKE ALL ON FUNCTION run_action_perform_principal(uuid) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION run_action_perform_principal(uuid) TO agent_run_writer;
ALTER FUNCTION run_action_perform_principal(uuid) OWNER TO platform_ops;

-- The reconcile. No tenant, no user and no account parameter: it reads and writes across tenants, for the worker's tick only.
CREATE FUNCTION resume_decision_reconcile(p_limit integer)
RETURNS TABLE (o_action_id uuid, o_ask_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'resume_decision_reconcile: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'resume_decision_reconcile: the limit is 1 to 500' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT a.id AS ask_id, a.account_id, w.halt_epoch
      FROM public.decision_asks a
      JOIN public.work_items w ON w.account_id = a.account_id AND w.id = a.work_item_id
     WHERE a.state IN ('answered', 'proceeded') AND a.run_id IS NOT NULL
       AND a.answered_at > now() - interval '30 days'
       AND public.account_is_active(a.account_id)
       AND NOT EXISTS (SELECT 1 FROM public.run_action_requests q
                        WHERE q.account_id = a.account_id AND q.kind = 'resume_decision' AND q.target_id = a.id)
     ORDER BY a.answered_at, a.id
     LIMIT p_limit
  ),
  ins AS (
    INSERT INTO public.run_action_requests (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash, resume_halt_epoch)
    SELECT d.account_id, 'resume_decision', d.ask_id, 'system', 'system', 'ask:' || d.ask_id::text, 'resume:' || d.ask_id::text, d.halt_epoch FROM due d
    ON CONFLICT DO NOTHING
    RETURNING id, account_id, target_id
  ),
  aud AS (
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    SELECT i.account_id, 'system', 'run_action.requested',
           jsonb_build_object('action_id', i.id, 'kind', 'resume_decision', 'target_id', i.target_id, 'principal_kind', 'system'), clock_timestamp()
      FROM ins i
  )
  -- A data-modifying CTE runs to completion whether or not the outer query reads it.
  SELECT i.id, i.target_id FROM ins i;
END $$;
REVOKE ALL ON FUNCTION resume_decision_reconcile(integer) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION resume_decision_reconcile(integer) TO receipt_writer_invoker;
ALTER FUNCTION resume_decision_reconcile(integer) OWNER TO platform_ops;

-- The deferral. Same shape and ACL as 0686's run_action_requeue_progress: EXECUTE for the run-writer login alone, a lease that is still live, one kind.
-- Pinned to RESUME_DEFER_MAX_DAYS in packages/worker/src/resumeDecision.ts by a test.
CREATE FUNCTION run_action_defer_resume(p_action_id uuid, p_delay_seconds integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r public.run_action_requests;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_action_defer_resume: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'run_action_defer_resume: the delay is 1 to 3600 seconds' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM public.run_action_requests q WHERE q.id = p_action_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_action_defer_resume: no such action' USING ERRCODE = 'P0002';
  END IF;
  IF r.kind <> 'resume_decision' OR r.state <> 'claimed' OR r.claimed_until IS NULL OR r.claimed_until <= now() THEN
    RAISE EXCEPTION 'run_action_defer_resume: action is not a live resume_decision claim' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF r.created_at < now() - interval '14 days' THEN
    RETURN 'expired';
  END IF;
  UPDATE public.run_action_requests q
     SET state = 'accepted', claimed_until = NULL, not_before = now() + make_interval(secs => p_delay_seconds),
         attempts = GREATEST(q.attempts - 1, 0), updated_at = now()
   WHERE q.id = p_action_id;
  RETURN 'deferred';
END $$;
REVOKE ALL ON FUNCTION run_action_defer_resume(uuid, integer) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION run_action_defer_resume(uuid, integer) TO agent_run_writer;
ALTER FUNCTION run_action_defer_resume(uuid, integer) OWNER TO platform_ops;

-- The refusal fact. A fixed code on the item (the table holds ids and fixed words only); no grant moves, app_user and the run writer already insert here.
ALTER TABLE work_item_driver_events DROP CONSTRAINT work_item_driver_events_kind_check;
ALTER TABLE work_item_driver_events
  ADD CONSTRAINT work_item_driver_events_kind_check CHECK (kind IN (
    'build_refused', 'build_waiting', 'stage_waiting', 'review_started', 'security_review_required', 'review_verdicts',
    'fix_round_started', 'fix_round_refused', 'fix_pushed_nothing', 'fix_round_failed', 'escalated',
    'review_status', 'merge_gate', 'merged_by_gate', 'stopped', 'pr_head_pushed', 'platform_check', 'correction_applied', 'resume_refused'
  ));

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
