-- D#2 H14c-3-2a2 (builds on 0658).
-- 1. run_action_perform_principal(action id): when a claimed cancel runs, the
--    database decides who it runs as and whether that principal may still do it
--    (a token is re-checked now, not at request time). The caller passes only the id.
-- 2. run_action_settle: same signature, ACL and owner, but a terminal settle also
--    writes its run_action.settled event (plus run_action.failed when failed) and
--    an audit row in the same transaction. A repeat and an 'accepted' re-queue
--    write nothing. Payloads are ids and enums only (the SSE poller streams them).
-- Privilege brackets as in 0616/0621: INHERIT on platform_ops to drop its
-- function, CREATE on schema public for the ownership transfers.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

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

  IF NOT ok THEN
    RETURN QUERY SELECT false, r.account_id, r.kind, r.target_id, r.principal_kind, NULL::uuid, NULL::uuid;
  ELSE
    RETURN QUERY SELECT true, r.account_id, r.kind, r.target_id, r.principal_kind, uid, tid;
  END IF;
END $$;

-- Dropped and recreated (not CREATE OR REPLACE): a Neon-shaped migrator cannot
-- replace it, because platform_ops (the owner) holds no EXECUTE on it (0658 revoked it).
DROP FUNCTION run_action_settle(uuid, text, jsonb, text, int);
CREATE FUNCTION run_action_settle(p_action_id uuid, p_state text, p_outcome jsonb, p_error_code text, p_retry_after_seconds int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r  public.run_action_requests;
  to_state text := p_state;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_action_settle: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('accepted', 'done', 'refused', 'failed')
     OR COALESCE(p_retry_after_seconds, 0) NOT BETWEEN 0 AND 86400 THEN
    RAISE EXCEPTION 'run_action_settle: bad state or retry delay' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM public.run_action_requests q WHERE q.id = p_action_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_action_settle: no such action' USING ERRCODE = 'P0002';
  END IF;
  IF r.state = p_state AND p_state <> 'accepted' THEN RETURN; END IF;
  IF r.state <> 'claimed' THEN
    RAISE EXCEPTION 'run_action_settle: action is % and not claimed', r.state USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF to_state = 'accepted' AND r.attempts >= 5 THEN to_state := 'failed'; END IF;
  IF to_state = 'accepted' THEN
    UPDATE public.run_action_requests q SET state = 'accepted', claimed_until = NULL, updated_at = now(),
           not_before = now() + make_interval(secs => COALESCE(p_retry_after_seconds, 0))
     WHERE q.id = p_action_id;
  ELSE
    UPDATE public.run_action_requests q SET state = to_state, claimed_until = NULL, finished_at = now(), updated_at = now(),
           outcome = p_outcome, error_code = p_error_code
     WHERE q.id = p_action_id;
    INSERT INTO public.domain_events (account_id, type, subject_id, payload)
    VALUES (r.account_id, 'run_action.settled', r.id::text,
            jsonb_build_object('actionId', r.id, 'kind', r.kind, 'targetId', r.target_id, 'state', to_state));
    IF to_state = 'failed' THEN
      INSERT INTO public.domain_events (account_id, type, subject_id, payload)
      VALUES (r.account_id, 'run_action.failed', r.id::text,
              jsonb_build_object('actionId', r.id, 'kind', r.kind, 'targetId', r.target_id, 'errorCode', p_error_code));
    END IF;
    -- The actor is the requester recorded on the row (token:<id> for a token
    -- action), never a value from the caller.
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    VALUES (r.account_id, r.requested_by, 'run_action.settled',
            jsonb_build_object('action_id', r.id, 'kind', r.kind, 'target_id', r.target_id, 'state', to_state,
                               'error_code', p_error_code), clock_timestamp());
  END IF;
END $$;

-- The 0658 ACL for both: EXECUTE for agent_run_writer only (revoked from the owner first).
REVOKE ALL ON FUNCTION run_action_perform_principal(uuid) FROM PUBLIC, CURRENT_USER;
REVOKE ALL ON FUNCTION run_action_settle(uuid, text, jsonb, text, int) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION run_action_perform_principal(uuid) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION run_action_settle(uuid, text, jsonb, text, int) TO agent_run_writer;
ALTER FUNCTION run_action_perform_principal(uuid) OWNER TO platform_ops;
ALTER FUNCTION run_action_settle(uuid, text, jsonb, text, int) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
