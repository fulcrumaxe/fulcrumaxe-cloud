-- D#845 MC-8a: the Claude sign-in link, cloud side. A person asks (owner or admin) for a sign-in on a managed server; the runner prints a link, the person opens it and types back the one-time code.
--
-- What:
--   machine_commands          the signed commands about the machine itself, a sibling of sandbox_commands (1041) with the same shape, delivery and row-security split. `kind` is closed
--                             (claude_login_start, claude_login_code, claude_logout); `request_id` names the sign-in request and is NULL for claude_logout only. ON-19 adds its two kinds to this table.
--   machine_login_requests    gains `failure_code`, and its writes narrow: UPDATE names its columns, and a write needs an owner or admin
--                             of the account outside any runner session (RESTRICTIVE policies). A runner session writes nothing here directly.
--   machine_login_report, machine_login_code_take, machine_login_auth_url
--                             the three definers, owned by machine_ops (the only role that reads the sealed columns). The runner's report moves a request along one path only; the code is handed out
--                             sealed and once (the column is set NULL in the same statement); the person's read of the link answers it sealed. None of them unseals anything: the cloud opens the blobs
--                             in memory, in the machine_ops code path, with the AAD account:request:runner:purpose.
--
-- The capability machine_login_v1 is already in the closed list (1053), so no capability change here. No audit action is added: audit_write's allowlist is not replaced by this migration.
--
-- Numbered by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

-- ---- machine_login_requests ---------------------------------------------------------------------------------------------------------------------

ALTER TABLE machine_login_requests ADD COLUMN failure_code text CONSTRAINT machine_login_requests_failure_code_check CHECK (failure_code ~ '^[a-z][a-z0-9_]{0,39}$');
GRANT SELECT (failure_code) ON machine_login_requests TO app_user;
-- The start route answers the request that is already live, under an advisory lock on the runner, so a double click does not start two sign-ins on one machine.

REVOKE UPDATE ON machine_login_requests FROM app_user;
GRANT UPDATE (status, auth_url_ct, code_ct, failure_code) ON machine_login_requests TO app_user;
CREATE POLICY owner_admin_insert ON machine_login_requests AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (
    NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = machine_login_requests.account_id AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND m.role IN ('owner', 'admin'))
    AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY owner_admin_update ON machine_login_requests AS RESTRICTIVE FOR UPDATE TO app_user
  USING (
    NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = machine_login_requests.account_id AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND m.role IN ('owner', 'admin'))
  );
-- The definers below run as machine_ops, inside the caller's tenant: their own account's rows, and only while the request is unexpired (so a tenant session still cannot reach the prune's rows).
CREATE POLICY machine_ops_login ON machine_login_requests FOR ALL TO machine_ops
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND expires_at > now())
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND expires_at > now());

-- ---- machine_commands ---------------------------------------------------------------------------------------------------------------------------

CREATE TABLE machine_commands (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  runner_id    uuid NOT NULL,
  kind         text NOT NULL CONSTRAINT machine_commands_kind_check CHECK (kind IN ('claude_login_start', 'claude_login_code', 'claude_logout')),
  request_id   uuid REFERENCES machine_login_requests (id) ON DELETE CASCADE,
  nonce        uuid NOT NULL DEFAULT gen_random_uuid() CONSTRAINT machine_commands_nonce_key UNIQUE,
  issued_by    uuid NOT NULL REFERENCES users (id),
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  state        text NOT NULL DEFAULT 'pending' CONSTRAINT machine_commands_state_check CHECK (state IN ('pending', 'delivered', 'applied', 'refused', 'expired', 'cancelled')),
  refusal      text CONSTRAINT machine_commands_refusal_check CHECK (refusal IN ('unsupported', 'failed', 'busy')),
  delivered_at timestamptz,
  acked_at     timestamptz,
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  CONSTRAINT machine_commands_request_with_kind CHECK ((kind = 'claude_logout') = (request_id IS NULL)),
  CONSTRAINT machine_commands_life CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '600 seconds'),
  CONSTRAINT machine_commands_delivery CHECK (
    (state IN ('pending', 'cancelled', 'expired') AND delivered_at IS NULL AND acked_at IS NULL)
    OR (state = 'delivered' AND delivered_at IS NOT NULL AND acked_at IS NULL)
    OR (state IN ('applied', 'refused') AND delivered_at IS NOT NULL AND acked_at IS NOT NULL)
  ),
  CONSTRAINT machine_commands_refusal_state CHECK ((state = 'refused') = (refusal IS NOT NULL))
);
CREATE INDEX machine_commands_runner_pending_idx ON machine_commands (runner_id, issued_at, id) WHERE state = 'pending';
CREATE INDEX machine_commands_runner_issued_idx ON machine_commands (account_id, runner_id, issued_at DESC);
CREATE UNIQUE INDEX machine_commands_one_pending_idx ON machine_commands (runner_id, kind, COALESCE(request_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE state = 'pending';

ALTER TABLE machine_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_commands FORCE ROW LEVEL SECURITY;
REVOKE ALL ON machine_commands FROM PUBLIC;
GRANT SELECT, INSERT ON machine_commands TO app_user;
GRANT UPDATE (state, delivered_at, acked_at, refusal) ON machine_commands TO app_user;

CREATE POLICY tenant_isolation_select ON machine_commands FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (NULLIF(current_setting('app.runner_id', true), '') IS NULL OR runner_id::text = lower(current_setting('app.runner_id', true)))
  );
-- Issued by an owner or admin, in their own name, never inside a runner session, for a live runner of the account and (when it names one) a request of the same runner; starts pending.
CREATE POLICY owner_admin_insert ON machine_commands FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND issued_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND state = 'pending' AND refusal IS NULL AND delivered_at IS NULL AND acked_at IS NULL
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = machine_commands.account_id AND m.user_id = machine_commands.issued_by AND m.role IN ('owner', 'admin'))
    AND EXISTS (SELECT 1 FROM runners r WHERE r.id = machine_commands.runner_id AND r.account_id = machine_commands.account_id AND r.revoked_at IS NULL)
    AND (request_id IS NULL OR EXISTS (SELECT 1 FROM machine_login_requests q WHERE q.id = machine_commands.request_id AND q.account_id = machine_commands.account_id AND q.runner_id = machine_commands.runner_id))
  );
CREATE POLICY owner_admin_cancel ON machine_commands FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND state = 'pending'
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = machine_commands.account_id AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND m.role IN ('owner', 'admin'))
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state IN ('cancelled', 'expired'));
CREATE POLICY runner_own_update ON machine_commands FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND runner_id::text = lower(COALESCE(current_setting('app.runner_id', true), ''))
    AND EXISTS (SELECT 1 FROM runners r WHERE r.id = machine_commands.runner_id AND r.account_id = machine_commands.account_id AND r.revoked_at IS NULL)
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND runner_id::text = lower(COALESCE(current_setting('app.runner_id', true), '')));

-- The one path a row may take (1041's rule, for this table). Invoker rights. A connection with no tenant (the migration owner's) is not restricted here.
CREATE FUNCTION machine_commands_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_runner boolean := NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL;
BEGIN
  IF NULLIF(current_setting('app.account_id', true), '') IS NULL THEN
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.account_id, NEW.runner_id, NEW.kind, NEW.request_id, NEW.nonce, NEW.issued_by, NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.runner_id, OLD.kind, OLD.request_id, OLD.nonce, OLD.issued_by, OLD.issued_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'machine_commands: a command is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT v_runner THEN
    IF OLD.state = 'pending' AND NEW.state = 'cancelled' AND OLD.expires_at > now() THEN RETURN NEW; END IF;
    IF OLD.state = 'pending' AND NEW.state = 'expired' AND OLD.expires_at <= now() AND NEW.delivered_at IS NULL AND NEW.acked_at IS NULL AND NEW.refusal IS NULL THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'machine_commands: not a transition a person can make' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.state = 'pending' AND NEW.state = 'delivered' AND OLD.expires_at > now() AND NEW.acked_at IS NULL AND NEW.refusal IS NULL THEN RETURN NEW; END IF;
  IF OLD.state = 'pending' AND NEW.state = 'expired' AND OLD.expires_at <= now() AND NEW.delivered_at IS NULL AND NEW.acked_at IS NULL AND NEW.refusal IS NULL THEN RETURN NEW; END IF;
  IF OLD.state = 'delivered' AND NEW.state IN ('applied', 'refused') AND NEW.delivered_at IS NOT DISTINCT FROM OLD.delivered_at AND NEW.acked_at IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'machine_commands: not a transition a runner can make' USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION machine_commands_guard_update() FROM PUBLIC;
CREATE TRIGGER machine_commands_guard_update BEFORE UPDATE ON machine_commands FOR EACH ROW EXECUTE FUNCTION machine_commands_guard_update();

-- ---- the definers, owned by machine_ops ---------------------------------------------------------------------------------------------------------

-- The runner's report. Only inside a runner session, on that runner's own live request: pending -> awaiting_code (with the sealed link), code_ready -> done, any live state -> failed.
-- A finished request keeps no sealed value. 55000: not in a state that takes this report (or past its life); P0002: no such request for this runner; 22023: a bad argument.
CREATE FUNCTION machine_login_report(p_request uuid, p_state text, p_auth_url_ct bytea, p_failure text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  rid  uuid := NULLIF(current_setting('app.runner_id', true), '')::uuid;
  cur  text;
BEGIN
  IF acct IS NULL OR rid IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'machine_login_report: not a live runner session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_request IS NULL OR p_state IS NULL OR p_state NOT IN ('awaiting_code', 'done', 'failed') OR (p_state = 'awaiting_code') <> (p_auth_url_ct IS NOT NULL)
     OR (p_failure IS NOT NULL AND p_state <> 'failed') THEN
    RAISE EXCEPTION 'machine_login_report: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT r.status INTO cur FROM public.machine_login_requests r
   WHERE r.id = p_request AND r.account_id = acct AND r.runner_id = rid AND r.expires_at > now() FOR UPDATE;
  IF cur IS NULL THEN
    RAISE EXCEPTION 'machine_login_report: no such live request' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT ((p_state = 'awaiting_code' AND cur = 'pending') OR (p_state = 'done' AND cur = 'code_ready') OR (p_state = 'failed' AND cur IN ('pending', 'awaiting_code', 'code_ready'))) THEN
    RAISE EXCEPTION 'machine_login_report: the request is %, not a state that takes this report', cur USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE public.machine_login_requests SET status = p_state, auth_url_ct = p_auth_url_ct, code_ct = CASE WHEN p_state = 'awaiting_code' THEN code_ct END, failure_code = p_failure
   WHERE id = p_request;
  RETURN p_state;
END;
$$;

-- The one-time fetch of the code: the sealed blob once, and NULL in the same statement. NULL when there is none (not typed yet, or already taken): the route answers 410.
CREATE FUNCTION machine_login_code_take(p_request uuid)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  rid  uuid := NULLIF(current_setting('app.runner_id', true), '')::uuid;
  taken bytea;
BEGIN
  IF acct IS NULL OR rid IS NULL OR NOT public.account_is_active(acct) OR p_request IS NULL THEN
    RAISE EXCEPTION 'machine_login_code_take: not a live runner session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT r.code_ct INTO taken FROM public.machine_login_requests r
   WHERE r.id = p_request AND r.account_id = acct AND r.runner_id = rid AND r.status = 'code_ready' AND r.expires_at > now() FOR UPDATE;
  IF taken IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.machine_login_requests SET code_ct = NULL WHERE id = p_request;
  RETURN taken;
END;
$$;

-- The person's read of the sealed link, while the request waits for its code. Never inside a runner session. NULL otherwise.
CREATE FUNCTION machine_login_auth_url(p_request uuid)
RETURNS bytea
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  IF acct IS NULL OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NOT public.account_is_active(acct) OR p_request IS NULL THEN
    RAISE EXCEPTION 'machine_login_auth_url: invalid call' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT r.auth_url_ct FROM public.machine_login_requests r WHERE r.id = p_request AND r.account_id = acct AND r.status = 'awaiting_code' AND r.expires_at > now());
END;
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'machine_ops'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on machine_ops; cannot ALTER FUNCTION ... OWNER TO machine_ops';
    END IF;
    GRANT machine_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO machine_ops;

REVOKE ALL ON FUNCTION machine_login_report(uuid, text, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION machine_login_code_take(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION machine_login_auth_url(uuid) FROM PUBLIC;
ALTER FUNCTION machine_login_report(uuid, text, bytea, text) OWNER TO machine_ops;
ALTER FUNCTION machine_login_code_take(uuid) OWNER TO machine_ops;
ALTER FUNCTION machine_login_auth_url(uuid) OWNER TO machine_ops;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION machine_login_report(uuid, text, bytea, text) TO app_user;
GRANT EXECUTE ON FUNCTION machine_login_code_take(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION machine_login_auth_url(uuid) TO app_user;

REVOKE CREATE ON SCHEMA public FROM machine_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE machine_ops FROM CURRENT_USER;
  END IF;
END
$$;
