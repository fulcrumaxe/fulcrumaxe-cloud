-- D#31 API-6a-1 (D#2 C52): durable, leased run actions (cancel now; retry,
-- continue and preview kinds are in the CHECK so no second migration is needed).
-- A request row is inserted ONLY by run_action_request (app_user, with its own
-- run_action.requested audit row in the 0616 shape -- audit_write is untouched).
-- State changes are ONLY by four agent_run_writer definers (0642 shape); nothing
-- holds a table-level write grant except platform_ops' column-scoped ones, and a
-- trigger refuses any write from a direct platform_ops login.
GRANT CREATE ON SCHEMA public TO platform_ops;

CREATE TABLE run_action_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('cancel_run', 'cancel_work_item', 'retry_run', 'continue_work_item', 'start_preview')),
  target_id       uuid NOT NULL,
  requested_by    text NOT NULL,
  principal_kind  text NOT NULL CHECK (principal_kind IN ('session', 'token')),
  idempotency_key text CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  request_hash    text NOT NULL CHECK (char_length(request_hash) BETWEEN 1 AND 128),
  state           text NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted', 'claimed', 'done', 'refused', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  claimed_until   timestamptz,
  not_before      timestamptz,
  outcome         jsonb,
  error_code      text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  CONSTRAINT run_action_requests_finished_iff_terminal CHECK ((state IN ('done', 'refused', 'failed')) = (finished_at IS NOT NULL)),
  CONSTRAINT run_action_requests_lease_iff_claimed CHECK ((state = 'claimed') = (claimed_until IS NOT NULL)),
  CONSTRAINT run_action_requests_idempotency_key UNIQUE (account_id, requested_by, idempotency_key)
);
CREATE UNIQUE INDEX run_action_requests_one_live ON run_action_requests (account_id, kind, target_id)
  WHERE state IN ('accepted', 'claimed');
CREATE INDEX run_action_requests_pending ON run_action_requests (state, created_at)
  WHERE state IN ('accepted', 'claimed');

ALTER TABLE run_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_action_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON run_action_requests FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
REVOKE ALL ON run_action_requests FROM app_user;
GRANT SELECT ON run_action_requests TO app_user;

-- platform_ops owns the definers, so it gets only what their bodies need. Every
-- policy also needs session_user <> 'platform_ops' (a direct web-pool login).
GRANT SELECT, DELETE ON run_action_requests TO platform_ops;
GRANT INSERT (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash)
  ON run_action_requests TO platform_ops;
GRANT UPDATE (state, attempts, claimed_until, not_before, outcome, error_code, updated_at, finished_at)
  ON run_action_requests TO platform_ops;
CREATE POLICY platform_ops_select ON run_action_requests FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops');
CREATE POLICY platform_ops_insert ON run_action_requests FOR INSERT TO platform_ops
  WITH CHECK (session_user <> 'platform_ops'
              AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY platform_ops_update ON run_action_requests FOR UPDATE TO platform_ops
  USING (session_user <> 'platform_ops') WITH CHECK (session_user <> 'platform_ops');
CREATE POLICY platform_ops_delete ON run_action_requests FOR DELETE TO platform_ops
  USING (session_user <> 'platform_ops');
-- The request definer checks a work item's existence in this tenant.
GRANT SELECT (id, account_id) ON work_items TO platform_ops;
CREATE POLICY platform_ops_run_action_target ON work_items FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- 0642's guard shape: a direct platform_ops login writes nothing. For every
-- other non-superuser the state machine binds the table itself: legal edges
-- only, a terminal row is frozen, and only a terminal row can be deleted.
CREATE FUNCTION run_action_requests_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_action_requests: platform_ops may not write directly' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'accepted' OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'run_action_requests: a request is inserted as accepted with no attempts' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT ((OLD.state, NEW.state) IN (('accepted', 'claimed'), ('claimed', 'claimed'), ('claimed', 'accepted'),
                                        ('claimed', 'done'), ('claimed', 'refused'), ('claimed', 'failed'))) THEN
      RAISE EXCEPTION 'run_action_requests: illegal transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.state IN ('accepted', 'claimed') THEN
    RAISE EXCEPTION 'run_action_requests: a live request is never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER run_action_requests_write_guard BEFORE INSERT OR UPDATE OR DELETE ON run_action_requests
  FOR EACH ROW EXECUTE FUNCTION run_action_requests_write_guard();

-- ---------------------------------------------------------------------
-- The request definer (app_user). Account from app.account_id, caller from
-- app.token_id / current_member_user_id(), never from a parameter. Writes its
-- own run_action.requested audit row in the same transaction (0616 shape).
-- ---------------------------------------------------------------------
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
  IF p_kind IS NULL OR p_kind NOT IN ('cancel_run', 'cancel_work_item', 'retry_run', 'continue_work_item', 'start_preview')
     OR char_length(COALESCE(p_request_hash, '')) NOT BETWEEN 1 AND 128
     OR char_length(COALESCE(p_idempotency_key, 'k')) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'run_action_request: invalid kind, key or hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF pkind = 'token' AND NOT (p_kind IN ('cancel_run', 'cancel_work_item') AND 'runs:cancel' = ANY (scopes)) THEN
    RAISE EXCEPTION 'run_action_request: token may not request %', p_kind USING ERRCODE = 'insufficient_privilege';
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

-- ---------------------------------------------------------------------
-- Writer-only definers (agent_run_writer). No tenant context: the sweep
-- claims across accounts. Each refuses a direct platform_ops session.
-- ---------------------------------------------------------------------
CREATE FUNCTION run_action_claim(p_action_id uuid, p_lease_seconds int) RETURNS run_action_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.run_action_requests;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_action_claim: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'run_action_claim: lease must be 1 to 3600 seconds' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.run_action_requests q
     SET state = 'claimed', claimed_until = now() + make_interval(secs => p_lease_seconds),
         attempts = q.attempts + 1, updated_at = now()
   WHERE q.id = p_action_id
     AND ((q.state = 'accepted' AND (q.not_before IS NULL OR q.not_before <= now()))
          OR (q.state = 'claimed' AND q.claimed_until < now()))
  RETURNING q.* INTO r;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN r;
END $$;

-- The lease is fixed at 60 s: the signature has no lease parameter.
CREATE FUNCTION run_action_claim_due(p_min_age_seconds int, p_limit int) RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_action_claim_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_min_age_seconds IS NULL OR p_min_age_seconds < 0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'run_action_claim_due: bad age or limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT q.id FROM public.run_action_requests q
     WHERE (q.state = 'accepted' AND q.created_at < now() - make_interval(secs => p_min_age_seconds)
            AND (q.not_before IS NULL OR q.not_before <= now()))
        OR (q.state = 'claimed' AND q.claimed_until < now())
     ORDER BY q.created_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  UPDATE public.run_action_requests u
     SET state = 'claimed', claimed_until = now() + interval '60 seconds', attempts = u.attempts + 1, updated_at = now()
    FROM due WHERE u.id = due.id
  RETURNING u.id;
END $$;

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
  END IF;
END $$;

CREATE FUNCTION run_action_purge(p_older_than interval, p_limit int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_action_purge: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_older_than IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'run_action_purge: bad age or limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH old AS (
    SELECT q.id FROM public.run_action_requests q
     WHERE q.state IN ('done', 'refused', 'failed') AND q.finished_at < now() - p_older_than
     ORDER BY q.finished_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM public.run_action_requests d USING old WHERE d.id = old.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ACLs. The four writer definers: EXECUTE for agent_run_writer only -- not
-- PUBLIC and not even the owner (revoked before the owner changes).
REVOKE ALL ON FUNCTION run_action_request(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION run_action_request(text, uuid, text, text) TO app_user;
REVOKE ALL ON FUNCTION run_action_claim(uuid, int) FROM PUBLIC, CURRENT_USER;
REVOKE ALL ON FUNCTION run_action_claim_due(int, int) FROM PUBLIC, CURRENT_USER;
REVOKE ALL ON FUNCTION run_action_settle(uuid, text, jsonb, text, int) FROM PUBLIC, CURRENT_USER;
REVOKE ALL ON FUNCTION run_action_purge(interval, int) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION run_action_claim(uuid, int) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION run_action_claim_due(int, int) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION run_action_settle(uuid, text, jsonb, text, int) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION run_action_purge(interval, int) TO agent_run_writer;

ALTER FUNCTION run_action_request(text, uuid, text, text) OWNER TO platform_ops;
ALTER FUNCTION run_action_claim(uuid, int) OWNER TO platform_ops;
ALTER FUNCTION run_action_claim_due(int, int) OWNER TO platform_ops;
ALTER FUNCTION run_action_settle(uuid, text, jsonb, text, int) OWNER TO platform_ops;
ALTER FUNCTION run_action_purge(interval, int) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;
