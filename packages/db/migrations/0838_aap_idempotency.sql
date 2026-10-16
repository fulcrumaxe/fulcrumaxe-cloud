-- D#7 AAP-d1-ii: the replay guard of request creation, and the housekeeping sweep (acceptance 8 and 9).
--
--   aap_idempotency   (instance, operation, key) -> the request it created and a hash of the parsed fields. Written only by
--                     aap_request_create_idempotent; a repeat with the same fields returns the same request, different fields give
--                     idempotency_conflict. Leaving pending starts the record's seven days (the trigger below); a later delivery
--                     row may extend purge_after.
--   aap_sweep         the worker tick's cross-tenant housekeeping. It has no clock argument: it runs aap_sweep_at at clock_timestamp(), so a caller
--                     cannot push time forward. aap_sweep_at (a clock-taking plain function nobody can call but its owner and a superuser) is how the
--                     tests cross the 7- and 30-day boundaries. EXECUTE on aap_sweep goes to its own role, aap_sweeper, which only the receipt login
--                     holds; aap_invoker (the request path) cannot run it.
--   action_approvals  a deleted instance's record is removed after seven days, but its approvals are receipts: the instance reference is set to null
--                     (not deleted), so the hash and byte count stay (owner ruling). The account still owns them, and removing the account removes them.
-- Expand-safe: a table, a role, functions and a trigger are new; one NOT NULL is relaxed and one delete action changes on a table nothing has used yet.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aap_sweeper') THEN
    CREATE ROLE aap_sweeper NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE aap_sweeper NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aap_sweeper' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role aap_sweeper still has a privileged attribute';
  END IF;
END
$$;

CREATE TABLE aap_idempotency (
  instance_id    uuid NOT NULL REFERENCES aap_instances (id) ON DELETE CASCADE,
  operation      text NOT NULL CONSTRAINT aap_idempotency_operation_check CHECK (operation IN ('create_request')),
  key            text NOT NULL CONSTRAINT aap_idempotency_key_check CHECK (length(key) BETWEEN 1 AND 255),
  request_sha256 text NOT NULL CONSTRAINT aap_idempotency_sha_check CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  response_ref   uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  purge_after    timestamptz NOT NULL,
  PRIMARY KEY (instance_id, operation, key)
);
CREATE INDEX aap_idempotency_purge ON aap_idempotency (purge_after);
CREATE INDEX aap_idempotency_ref ON aap_idempotency (instance_id, response_ref);


-- What the sweep scans.
CREATE INDEX aap_instances_deleted ON aap_instances (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX action_approvals_pending ON action_approvals (deadline_at) WHERE status = 'pending';
CREATE INDEX action_approvals_sealed ON action_approvals (decided_at) WHERE arguments_sealed IS NOT NULL AND status <> 'pending';

ALTER TABLE aap_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE aap_idempotency FORCE ROW LEVEL SECURITY;
REVOKE ALL ON aap_idempotency FROM PUBLIC;
CREATE POLICY aap_definer_all ON aap_idempotency FOR ALL TO aap_definer USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON aap_idempotency TO aap_definer;

-- Leaving pending starts the replay record's seven days.
CREATE FUNCTION action_approvals_idempotency_clock() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.aap_idempotency SET purge_after = NEW.decided_at + interval '7 days' WHERE instance_id = NEW.instance_id AND response_ref = NEW.id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER action_approvals_idempotency_clock AFTER UPDATE OF status ON action_approvals
  FOR EACH ROW WHEN (OLD.status = 'pending' AND NEW.status <> 'pending') EXECUTE FUNCTION action_approvals_idempotency_clock();

-- A deleted instance leaves its approvals behind as receipts: the guard now lets the foreign key null the reference (and nothing else change it).
CREATE OR REPLACE FUNCTION action_approvals_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR (NEW.instance_id IS DISTINCT FROM OLD.instance_id AND NEW.instance_id IS NOT NULL)
     OR NEW.tool IS DISTINCT FROM OLD.tool OR NEW.server IS DISTINCT FROM OLD.server OR NEW.arguments_sha256 IS DISTINCT FROM OLD.arguments_sha256
     OR NEW.arguments_bytes IS DISTINCT FROM OLD.arguments_bytes OR NEW.agent_reasoning IS DISTINCT FROM OLD.agent_reasoning
     OR NEW.context IS DISTINCT FROM OLD.context OR NEW.requested_timeout_s IS DISTINCT FROM OLD.requested_timeout_s
     OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'action_approvals: the request itself does not change' USING ERRCODE = 'check_violation';
  END IF;
  -- The sealed arguments may only be purged (set to null together with their version), never replaced.
  IF (NEW.arguments_sealed IS DISTINCT FROM OLD.arguments_sealed OR NEW.arguments_kek_version IS DISTINCT FROM OLD.arguments_kek_version)
     AND NOT (NEW.arguments_sealed IS NULL AND NEW.arguments_kek_version IS NULL AND OLD.status <> 'pending') THEN
    RAISE EXCEPTION 'action_approvals: sealed arguments are only ever purged, after the row leaves pending' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('approved', 'denied', 'expired', 'cancelled')) THEN
    RAISE EXCEPTION 'action_approvals: that state move is not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND (NEW.decided_by_kind IS DISTINCT FROM OLD.decided_by_kind OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
     OR NEW.rule_id IS DISTINCT FROM OLD.rule_id OR NEW.rule_set_version IS DISTINCT FROM OLD.rule_set_version
     OR NEW.route_version IS DISTINCT FROM OLD.route_version OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
    RAISE EXCEPTION 'action_approvals: a decision is final' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
     OR (OLD.outcome IS NOT NULL AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.outcome_note IS DISTINCT FROM OLD.outcome_note
                                      OR NEW.outcome_at IS DISTINCT FROM OLD.outcome_at)) THEN
    RAISE EXCEPTION 'action_approvals: consume and outcome happen once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE action_approvals ALTER COLUMN instance_id DROP NOT NULL;
ALTER TABLE action_approvals
  DROP CONSTRAINT action_approvals_account_id_instance_id_fkey,
  ADD CONSTRAINT action_approvals_instance_fkey FOREIGN KEY (account_id, instance_id) REFERENCES aap_instances (account_id, id) ON DELETE SET NULL (instance_id),
  ADD CONSTRAINT action_approvals_account_fkey FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'aap_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on aap_definer; cannot ALTER FUNCTION ... OWNER TO aap_definer';
    END IF;
    GRANT aap_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO aap_definer;

-- Creates a request once per key. Authenticates first, claims the key, then hands the insert to aap_request_create.
CREATE FUNCTION aap_request_create_idempotent(
  p_credential_sha256 text, p_id uuid, p_tool text, p_server text, p_sealed bytea, p_kek_version integer, p_args_sha256 text, p_args_bytes integer,
  p_reasoning text, p_context jsonb, p_requested_timeout_s integer, p_deadline_at timestamptz, p_idempotency_key text, p_request_sha256 text)
RETURNS aap_approval_view
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_auth record;
  v_prior record;
BEGIN
  SELECT * INTO v_auth FROM public.aap_instance_authenticate(p_credential_sha256);
  IF p_deadline_at <= now() OR p_deadline_at > now() + interval '14 days' THEN
    RAISE EXCEPTION 'invalid_request: a deadline within 14 days is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.aap_idempotency (instance_id, operation, key, request_sha256, response_ref, purge_after)
  VALUES (v_auth.o_instance_id, 'create_request', p_idempotency_key, p_request_sha256, p_id, p_deadline_at + interval '7 days')
  ON CONFLICT DO NOTHING;
  IF FOUND THEN
    RETURN public.aap_request_create(p_credential_sha256, p_id, p_tool, p_server, p_sealed, p_kek_version, p_args_sha256, p_args_bytes,
                                     p_reasoning, p_context, p_requested_timeout_s, p_deadline_at);
  END IF;
  SELECT * INTO v_prior FROM public.aap_idempotency WHERE instance_id = v_auth.o_instance_id AND operation = 'create_request' AND key = p_idempotency_key;
  IF v_prior.request_sha256 <> p_request_sha256 THEN
    RAISE EXCEPTION 'idempotency_conflict: the key was used with different fields' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN (SELECT public.aap_view(a, true) FROM public.action_approvals a WHERE a.id = v_prior.response_ref AND a.instance_id = v_auth.o_instance_id);
END;
$$;

-- The worker tick's housekeeping, cross-tenant, in batches of at most p_limit per step: expire what passed its deadline; null sealed
-- arguments 30 days after a row left pending; drop replay records past purge_after; drop a deleted instance's record 7 days after deletion
-- (its replay records go with it; its approvals stay as receipts with the instance reference nulled). aap_sweep_at takes the clock so the
-- boundaries can be tested; it is plain, owned by aap_definer, and has no grantee.
CREATE FUNCTION aap_sweep_at(p_now timestamptz, p_limit integer)
RETURNS TABLE (o_expired integer, o_arguments_purged integer, o_idempotency_purged integer, o_instances_purged integer)
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_now IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'aap_sweep_bad_input: a time and a limit of 1 to 1000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH due AS (SELECT id FROM public.action_approvals WHERE status = 'pending' AND deadline_at <= p_now ORDER BY deadline_at LIMIT p_limit FOR UPDATE SKIP LOCKED),
       u AS (UPDATE public.action_approvals a SET status = 'expired', decided_at = p_now FROM due WHERE a.id = due.id RETURNING 1)
  SELECT count(*)::integer INTO o_expired FROM u;
  WITH due AS (SELECT id FROM public.action_approvals WHERE arguments_sealed IS NOT NULL AND status <> 'pending' AND decided_at <= p_now - interval '30 days'
                ORDER BY decided_at LIMIT p_limit FOR UPDATE SKIP LOCKED),
       u AS (UPDATE public.action_approvals a SET arguments_sealed = NULL, arguments_kek_version = NULL FROM due WHERE a.id = due.id RETURNING 1)
  SELECT count(*)::integer INTO o_arguments_purged FROM u;
  WITH due AS (SELECT instance_id, operation, key FROM public.aap_idempotency WHERE purge_after <= p_now ORDER BY purge_after LIMIT p_limit FOR UPDATE SKIP LOCKED),
       d AS (DELETE FROM public.aap_idempotency i USING due WHERE i.instance_id = due.instance_id AND i.operation = due.operation AND i.key = due.key RETURNING 1)
  SELECT count(*)::integer INTO o_idempotency_purged FROM d;
  WITH due AS (SELECT id FROM public.aap_instances WHERE deleted_at <= p_now - interval '7 days' ORDER BY deleted_at LIMIT p_limit FOR UPDATE SKIP LOCKED),
       d AS (DELETE FROM public.aap_instances i USING due WHERE i.id = due.id RETURNING 1)
  SELECT count(*)::integer INTO o_instances_purged FROM d;
  RETURN NEXT;
END;
$$;

-- The only entry point for the tick: the database's own clock, never the caller's.
CREATE FUNCTION aap_sweep(p_limit integer)
RETURNS TABLE (o_expired integer, o_arguments_purged integer, o_idempotency_purged integer, o_instances_purged integer)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM public.aap_sweep_at(clock_timestamp(), p_limit)
$$;
-- Ownership and EXECUTE: the request path (aap_invoker) gets the idempotent create, the sweep login (aap_sweeper) gets aap_sweep, the clock-taking
-- function gets no grantee.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname, p.prosecdef FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('aap_request_create_idempotent', 'aap_sweep', 'aap_sweep_at') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('ALTER FUNCTION %s OWNER TO aap_definer', f.sig);
    IF f.prosecdef THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f.sig, CASE WHEN f.proname = 'aap_sweep' THEN 'aap_sweeper' ELSE 'aap_invoker' END);
    END IF;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION action_approvals_idempotency_clock() FROM PUBLIC;

REVOKE CREATE ON SCHEMA public FROM aap_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE aap_definer FROM CURRENT_USER;
  END IF;
END
$$;