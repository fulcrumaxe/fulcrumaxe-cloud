-- D#7 AAP-d1 (correction C16, DP-C12 part 2): storage for the Agent Approval Protocol provider. Two tables here (provisioner tokens arrive in 0839, the replay table in 0838), all written only
-- through SECURITY DEFINER functions.
--
--   aap_instances          one row per customer adapter ("instance"). Its credential is 32 random bytes the caller generates and shows once;
--                          only sha256 and a 4-character hint are stored. Revoking or deleting an instance cancels its pending approvals.
--   action_approvals       one row per tool call that asks for a go or no-go. Arguments are stored sealed (the caller seals them under
--                          FX_KEK_V<n>), purged 30 days after the row leaves "pending"; sha256 and the byte count stay.
--
-- Who may do what. The tables are owned by the migration role. aap_definer (NOLOGIN, no members, 0824's shape) owns every function below and
-- holds the table privileges they need; aap_invoker (NOLOGIN) holds EXECUTE on those functions and nothing else; the logins that call them
-- are members of it (set up in ops, never by this file). app_user can only SELECT, and only the columns granted here: never a credential
-- hash. A credential-bound function takes the credential's sha256, finds the instance itself and refuses a revoked, deleted or other-account
-- one with the same error as a missing one. The functions that manage instances and tokens take either a provisioner token (sha256) or, with
-- none, need a signed-in session of an owner or admin (0797's checks).
--
-- States. pending -> approved | denied | expired | cancelled and nothing else; a terminal row never changes except for consumed_at and
-- outcome on an approved one. `decided_at` is the time the row left pending, whatever the state. Credential validity is derived from
-- revoked_at/deleted_at, so a revoked key stops at once; statuses and stamps are one-time.
--
-- Expand-only: new tables, roles and functions; no existing object changes.

DO $$
DECLARE
  n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['aap_definer', 'aap_invoker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
      RAISE EXCEPTION 'role % still has a privileged attribute', n;
    END IF;
  END LOOP;
END
$$;

-- ---- tables ------------------------------------------------------------------------------------------------------------------
CREATE TABLE aap_instances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name            text NOT NULL CONSTRAINT aap_instances_name_check CHECK (length(name) BETWEEN 1 AND 100),
  credential_sha256 text NOT NULL CONSTRAINT aap_instances_sha_check CHECK (credential_sha256 ~ '^[0-9a-f]{64}$'),
  credential_hint text NOT NULL CONSTRAINT aap_instances_hint_check CHECK (length(credential_hint) = 4),
  created_by      text NOT NULL CONSTRAINT aap_instances_created_by_check CHECK (created_by ~ '^(user|token):[0-9a-f-]{36}$'),
  revoked_at      timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (credential_sha256)
);
CREATE INDEX aap_instances_account ON aap_instances (account_id, created_at);

CREATE TABLE action_approvals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL,
  instance_id           uuid NOT NULL,
  tool                  text NOT NULL CONSTRAINT action_approvals_tool_check CHECK (length(tool) BETWEEN 1 AND 200),
  server                text NOT NULL CONSTRAINT action_approvals_server_check CHECK (length(server) BETWEEN 1 AND 200),
  -- Sealed arguments: nonce (12) || ciphertext || tag (16), so the length is the byte count plus 28. Null once purged.
  arguments_sealed      bytea,
  arguments_kek_version integer,
  arguments_sha256      text NOT NULL CONSTRAINT action_approvals_args_sha_check CHECK (arguments_sha256 ~ '^[0-9a-f]{64}$'),
  arguments_bytes       integer NOT NULL CONSTRAINT action_approvals_args_bytes_check CHECK (arguments_bytes BETWEEN 0 AND 65536),
  agent_reasoning       text CONSTRAINT action_approvals_reasoning_check CHECK (octet_length(agent_reasoning) <= 8192),
  context               jsonb CONSTRAINT action_approvals_context_check CHECK (octet_length(context::text) <= 8192),
  requested_timeout_s   integer CONSTRAINT action_approvals_timeout_check CHECK (requested_timeout_s > 0),
  deadline_at           timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'pending' CONSTRAINT action_approvals_status_check CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  decided_by_kind       text CONSTRAINT action_approvals_kind_check CHECK (decided_by_kind IN ('person', 'policy', 'provider')),
  decided_by            text CONSTRAINT action_approvals_decided_by_check CHECK (length(decided_by) BETWEEN 1 AND 200),
  rule_id               text,
  rule_set_version      integer,
  route_version         integer,
  note                  text CONSTRAINT action_approvals_note_check CHECK (length(note) <= 1000),
  decided_at            timestamptz,
  expires_at            timestamptz,
  consumed_at           timestamptz,
  outcome               text CONSTRAINT action_approvals_outcome_check CHECK (outcome IN ('succeeded', 'failed')),
  outcome_note          text CONSTRAINT action_approvals_outcome_note_check CHECK (length(outcome_note) <= 1000),
  outcome_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, instance_id) REFERENCES aap_instances (account_id, id) ON DELETE CASCADE,
  CONSTRAINT action_approvals_sealed_shape CHECK (
    (arguments_sealed IS NULL) = (arguments_kek_version IS NULL)
    AND (arguments_sealed IS NULL OR (arguments_kek_version >= 1 AND octet_length(arguments_sealed) = arguments_bytes + 28))),
  CONSTRAINT action_approvals_decided_shape CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT action_approvals_kind_shape CHECK ((status IN ('approved', 'denied')) = (decided_by_kind IS NOT NULL AND decided_by IS NOT NULL)),
  CONSTRAINT action_approvals_expiry_shape CHECK ((status = 'approved') = (expires_at IS NOT NULL)),
  CONSTRAINT action_approvals_consume_shape CHECK (consumed_at IS NULL OR status = 'approved'),
  CONSTRAINT action_approvals_outcome_shape CHECK (
    (outcome IS NULL) = (outcome_at IS NULL) AND (outcome IS NULL OR consumed_at IS NOT NULL) AND (outcome_note IS NULL OR outcome IS NOT NULL))
);
CREATE INDEX action_approvals_instance ON action_approvals (instance_id, created_at);
CREATE INDEX action_approvals_account_pending ON action_approvals (account_id, created_at) WHERE status = 'pending';

-- ---- the state machine --------------------------------------------------------------------------------------------------------
CREATE FUNCTION action_approvals_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.instance_id IS DISTINCT FROM OLD.instance_id
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
CREATE TRIGGER action_approvals_guard BEFORE UPDATE ON action_approvals FOR EACH ROW EXECUTE FUNCTION action_approvals_guard();

-- ---- row security and grants ---------------------------------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['aap_instances', 'action_approvals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    -- aap_definer has no member and no login; its functions check the caller themselves, so its rows are not tenant-filtered here.
    EXECUTE format('CREATE POLICY aap_definer_all ON %I FOR ALL TO aap_definer USING (true) WITH CHECK (true)', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['aap_instances', 'action_approvals'] LOOP
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR SELECT TO app_user
      USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)))$p$, t);
  END LOOP;
END
$$;

-- app_user reads (never a hash) and writes nothing.
GRANT SELECT (id, account_id, name, credential_hint, created_by, revoked_at, deleted_at, created_at) ON aap_instances TO app_user;
GRANT SELECT ON action_approvals TO app_user;

GRANT USAGE ON SCHEMA public TO aap_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON aap_instances TO aap_definer;
GRANT SELECT, INSERT, UPDATE ON action_approvals TO aap_definer;
-- The session check and the account check (0663's columns and 0797's policy shape).
GRANT SELECT (account_id, user_id, role) ON account_members TO aap_definer;
GRANT SELECT (id, deleted_at) ON accounts TO aap_definer;
CREATE POLICY aap_definer_select ON account_members FOR SELECT TO aap_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY aap_definer_select ON accounts FOR SELECT TO aap_definer USING (true);

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

CREATE TYPE aap_approval_view AS (
  id uuid, instance_id uuid, account_id uuid, tool text, server text, status text, deadline_at timestamptz, expires_at timestamptz,
  consumed_at timestamptz, outcome text, decided_by_kind text, decided_at timestamptz, note text, requested_timeout_s integer,
  created_at timestamptz, replayed boolean);

-- The caller-facing shape of a request (never the sealed arguments). Plain, like aap_manager_account.
CREATE FUNCTION aap_view(a public.action_approvals, p_replayed boolean) RETURNS aap_approval_view
LANGUAGE sql
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT ROW(a.id, a.instance_id, a.account_id, a.tool, a.server, a.status, a.deadline_at, a.expires_at, a.consumed_at, a.outcome,
             a.decided_by_kind, a.decided_at, a.note, a.requested_timeout_s, a.created_at, p_replayed)::public.aap_approval_view
$$;

-- The caller of an instance-management function: a signed-in owner or admin session (a provisioner token is refused until 0839). Returns the account.
-- Plain (not a definer): it runs as aap_definer inside the definers below, and nothing else can call it.
CREATE FUNCTION aap_manager_account(p_token text, OUT o_account uuid, OUT o_actor text) RETURNS record
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_user   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_role   text;
BEGIN
  IF p_token IS NOT NULL THEN
    RAISE EXCEPTION 'unauthenticated: provisioner tokens arrive with migration 0839' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_tenant IS NULL OR v_user IS NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'session_required: only a signed-in person can do this' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.role INTO v_role FROM public.account_members m WHERE m.account_id = v_tenant AND m.user_id = v_user;
  IF v_role IS NULL OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = v_tenant AND a.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'session_required: the user is not a member of this account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'forbidden: this needs the owner or admin role' USING ERRCODE = 'insufficient_privilege';
  END IF;
  o_account := v_tenant;
  o_actor := 'user:' || v_user;
END;
$$;

-- The instance behind a credential, locked FOR SHARE: aap_instance_close takes the row FOR UPDATE and cancels pending requests, so a request being created
-- either waits for the close and then fails to authenticate, or the close waits for it and cancels it. Same error whatever is wrong with it (missing, revoked, deleted, other account's, account gone).
CREATE FUNCTION aap_instance_authenticate(p_credential_sha256 text) RETURNS TABLE (o_instance_id uuid, o_account_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT i.id, i.account_id FROM public.aap_instances i
   WHERE i.credential_sha256 = p_credential_sha256 AND i.revoked_at IS NULL AND i.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = i.account_id AND a.deleted_at IS NULL)
   FOR SHARE OF i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unauthenticated: the credential is not valid' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;
CREATE FUNCTION aap_instance_create(p_token text, p_name text, p_credential_sha256 text, p_hint text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_who record;
  v_id  uuid;
BEGIN
  SELECT * INTO v_who FROM public.aap_manager_account(p_token);
  INSERT INTO public.aap_instances (account_id, name, credential_sha256, credential_hint, created_by)
  VALUES (v_who.o_account, p_name, p_credential_sha256, p_hint, v_who.o_actor) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
-- Revoke (p_delete false) or delete (true). Both stop the credential now and cancel every pending approval in the same transaction.
-- Deleting keeps the record for seven days (the sweep removes it). Repeating either is a no-op.
CREATE FUNCTION aap_instance_close(p_token text, p_id uuid, p_delete boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_who record;
BEGIN
  SELECT * INTO v_who FROM public.aap_manager_account(p_token);
  PERFORM 1 FROM public.aap_instances WHERE id = p_id AND account_id = v_who.o_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such instance' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE public.aap_instances SET revoked_at = COALESCE(revoked_at, now()), deleted_at = CASE WHEN p_delete THEN COALESCE(deleted_at, now()) ELSE deleted_at END
   WHERE id = p_id;
  UPDATE public.action_approvals SET status = 'cancelled', decided_at = now() WHERE instance_id = p_id AND status = 'pending';
END;
$$;
CREATE FUNCTION aap_request_create(
  p_credential_sha256 text, p_id uuid, p_tool text, p_server text, p_sealed bytea, p_kek_version integer, p_args_sha256 text, p_args_bytes integer,
  p_reasoning text, p_context jsonb, p_requested_timeout_s integer, p_deadline_at timestamptz)
RETURNS aap_approval_view
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_auth record;
  v_row public.action_approvals;
BEGIN
  SELECT * INTO v_auth FROM public.aap_instance_authenticate(p_credential_sha256);
  IF p_sealed IS NULL OR p_deadline_at <= now() OR p_deadline_at > now() + interval '14 days' THEN
    RAISE EXCEPTION 'invalid_request: sealed arguments and a deadline within 14 days are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.action_approvals (id, account_id, instance_id, tool, server, arguments_sealed, arguments_kek_version, arguments_sha256, arguments_bytes,
                                       agent_reasoning, context, requested_timeout_s, deadline_at)
  VALUES (p_id, v_auth.o_account_id, v_auth.o_instance_id, p_tool, p_server, p_sealed, p_kek_version, p_args_sha256, p_args_bytes,
          p_reasoning, p_context, p_requested_timeout_s, p_deadline_at) RETURNING * INTO v_row;
  RETURN public.aap_view(v_row, false);
END;
$$;
-- Get and cancel share one body: cancel moves a pending row to cancelled first. An id of another instance or account is simply not found.
CREATE FUNCTION aap_request_get(p_credential_sha256 text, p_id uuid, p_cancel boolean) RETURNS aap_approval_view
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_auth record;
  a public.action_approvals;
BEGIN
  SELECT * INTO v_auth FROM public.aap_instance_authenticate(p_credential_sha256);
  IF p_cancel THEN
    UPDATE public.action_approvals SET status = 'cancelled', decided_at = now() WHERE id = p_id AND instance_id = v_auth.o_instance_id AND status = 'pending';
  END IF;
  SELECT * INTO a FROM public.action_approvals WHERE id = p_id AND instance_id = v_auth.o_instance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such request' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN public.aap_view(a, false);
END;
$$;
-- One conditional UPDATE decides the race; the diagnosis below it only names why it did not win.
CREATE FUNCTION aap_request_consume(p_credential_sha256 text, p_id uuid) RETURNS aap_approval_view
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_auth record;
  a public.action_approvals;
BEGIN
  SELECT * INTO v_auth FROM public.aap_instance_authenticate(p_credential_sha256);
  UPDATE public.action_approvals SET consumed_at = now()
   WHERE id = p_id AND instance_id = v_auth.o_instance_id AND status = 'approved' AND consumed_at IS NULL AND expires_at > clock_timestamp()
   RETURNING * INTO a;
  IF NOT FOUND THEN
    SELECT * INTO a FROM public.action_approvals WHERE id = p_id AND instance_id = v_auth.o_instance_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found: no such request' USING ERRCODE = 'no_data_found';
    ELSIF a.status <> 'approved' THEN
      RAISE EXCEPTION 'not_approved: the request is %', a.status USING ERRCODE = 'object_not_in_prerequisite_state';
    ELSIF a.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'already_consumed: the approval was used' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RAISE EXCEPTION 'approval_expired: the approval is past its expiry' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN public.aap_view(a, false);
END;
$$;
-- What happened after the approval was used. Once, only after consume, and it never touches the decision.
CREATE FUNCTION aap_request_outcome(p_credential_sha256 text, p_id uuid, p_outcome text, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_auth record;
  a public.action_approvals;
BEGIN
  SELECT * INTO v_auth FROM public.aap_instance_authenticate(p_credential_sha256);
  SELECT * INTO a FROM public.action_approvals WHERE id = p_id AND instance_id = v_auth.o_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found: no such request' USING ERRCODE = 'no_data_found';
  ELSIF a.consumed_at IS NULL THEN
    RAISE EXCEPTION 'not_consumed: the approval has not been used' USING ERRCODE = 'object_not_in_prerequisite_state';
  ELSIF a.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'outcome_already_recorded: the outcome was reported' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE public.action_approvals SET outcome = p_outcome, outcome_note = p_note, outcome_at = now() WHERE id = p_id;
END;
$$;
-- A person's answer (0797's session checks). The rule and provider paths arrive with AAP-d3; until then they cannot decide anything.
CREATE FUNCTION aap_approval_decide(p_id uuid, p_approve boolean, p_note text, p_valid_for_s integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_who record;
BEGIN
  SELECT * INTO v_who FROM public.aap_manager_account(NULL);
  IF p_approve IS NULL OR (p_approve AND (p_valid_for_s IS NULL OR p_valid_for_s NOT BETWEEN 60 AND 172800)) THEN
    RAISE EXCEPTION 'invalid_request: answer yes or no; an approval is valid for 60 seconds to 48 hours' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.action_approvals
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'denied' END, decided_by_kind = 'person', decided_by = split_part(v_who.o_actor, ':', 2),
         note = p_note, decided_at = now(), expires_at = CASE WHEN p_approve THEN now() + make_interval(secs => p_valid_for_s) END
   WHERE id = p_id AND account_id = v_who.o_account AND status = 'pending' AND deadline_at > now();
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.action_approvals WHERE id = p_id AND account_id = v_who.o_account) THEN
      RAISE EXCEPTION 'not_found: no such request' USING ERRCODE = 'no_data_found';
    END IF;
    RAISE EXCEPTION 'already_decided: the request is no longer pending' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;
-- Ownership and EXECUTE. Definers: aap_invoker only. The plain helper is reachable from the definers alone.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.prosecdef FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('aap_manager_account', 'aap_view', 'aap_instance_authenticate', 'aap_instance_create', 'aap_instance_close', 'aap_request_create', 'aap_request_get', 'aap_request_consume', 'aap_request_outcome', 'aap_approval_decide') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('ALTER FUNCTION %s OWNER TO aap_definer', f.sig);
    IF f.prosecdef THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO aap_invoker', f.sig);
    END IF;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION action_approvals_guard() FROM PUBLIC;

REVOKE CREATE ON SCHEMA public FROM aap_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE aap_definer FROM CURRENT_USER;
  END IF;
END
$$;