-- D#483 P1: a run action of its own for "approve a work item into the pipeline".
-- `continue_work_item` is reserved for executor continuation (a run picking up
-- where a failed one stopped), so the stage driver gets `advance_work_item`.
--   1. run_action_requests.kind accepts the new kind (the CHECK is dropped and
--      added again, same name, wider list).
--   2. run_action_request (the app_user definer) accepts it. Same body, signature,
--      owner and ACL as 0685's, with two changes: the new kind is a session
--      owner or admin only (a token can never request it, as for every kind but
--      the two cancels), and its target is looked up in work_items like a
--      cancel_work_item's.
-- Privilege brackets as in 0658/0682/0685.
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
  CHECK (kind IN ('cancel_run', 'cancel_work_item', 'retry_run', 'continue_work_item', 'start_preview', 'advance_work_item'));

-- Dropped and recreated (no CASCADE) with the same signature, owner and ACL: a
-- Neon-shaped migrator cannot replace it, because platform_ops (the owner) holds
-- no EXECUTE on it.
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
  IF p_kind IS NULL OR p_kind NOT IN ('cancel_run', 'cancel_work_item', 'retry_run', 'continue_work_item', 'start_preview', 'advance_work_item')
     OR char_length(COALESCE(p_request_hash, '')) NOT BETWEEN 1 AND 128
     OR char_length(COALESCE(p_idempotency_key, 'k')) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'run_action_request: invalid kind, key or hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF pkind = 'token' AND NOT (p_kind IN ('cancel_run', 'cancel_work_item') AND 'runs:cancel' = ANY (scopes)) THEN
    RAISE EXCEPTION 'run_action_request: token may not request %', p_kind USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind IN ('start_preview', 'advance_work_item') AND pkind = 'session' AND COALESCE(current_member_role(), '') NOT IN ('owner', 'admin') THEN
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
    SELECT * INTO r FROM public.run_action_requests q
     WHERE q.account_id = acct AND q.kind = p_kind AND q.target_id = p_target_id AND q.state IN ('accepted', 'claimed');
    IF FOUND THEN
      RETURN QUERY SELECT r.id, r.state, true; RETURN;
    END IF;
    IF p_kind IN ('cancel_run', 'retry_run') THEN
      PERFORM 1 FROM public.agent_runs x WHERE x.id = p_target_id AND x.account_id = acct;
    ELSIF p_kind = 'start_preview' THEN
      PERFORM 1 FROM public.onboarding_previews x WHERE x.id = p_target_id AND x.account_id = acct AND x.state = 'requested';
    ELSE
      PERFORM 1 FROM public.work_items x WHERE x.id = p_target_id AND x.account_id = acct;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'run_action_request: target not found' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO public.run_action_requests (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash)
    VALUES (acct, p_kind, p_target_id, who, pkind, p_idempotency_key, p_request_hash)
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

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
