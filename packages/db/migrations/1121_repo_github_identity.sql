-- D#845 ON-19a: a project's GitHub identity, `app` (the default) or `personal`. Only a person who is an owner or admin of the account can change it, through one definer function; app_user can only read.
-- No row means `app`. The token never reaches the cloud: this stores the choice and nothing else. A public repo is refused by the route (GitHub is asked live), not here.
-- audit_write is replaced whole from 1098's body (the newest on main) with `project.github_identity_changed` added, so every earlier action is still accepted. Numbered 1121 by the Team Lead;
-- re-check main's highest, and that every action of the newest earlier restatement is present, right before merging.

CREATE TABLE repo_github_identity (
  account_id uuid NOT NULL,
  repo_id    uuid NOT NULL,
  identity   text NOT NULL CONSTRAINT repo_github_identity_value CHECK (identity IN ('app', 'personal')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, repo_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);
ALTER TABLE repo_github_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE repo_github_identity FORCE ROW LEVEL SECURITY;
GRANT SELECT ON repo_github_identity TO app_user;
CREATE POLICY tenant_isolation_select ON repo_github_identity FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

DO $$
DECLARE
  n text := 'repo_identity_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  ELSIF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
    RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot ALTER FUNCTION ... OWNER TO it', n;
  ELSE
    EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO repo_identity_definer;
GRANT CREATE ON SCHEMA public TO repo_identity_definer;
GRANT SELECT ON repo_github_identity TO repo_identity_definer;
GRANT INSERT (account_id, repo_id, identity) ON repo_github_identity TO repo_identity_definer;
GRANT UPDATE (identity, updated_at) ON repo_github_identity TO repo_identity_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO repo_identity_definer;
GRANT SELECT (id, account_id) ON repos TO repo_identity_definer;
GRANT SELECT (id, deleted_at) ON accounts TO repo_identity_definer;
CREATE POLICY repo_identity_definer_all ON repo_github_identity FOR ALL TO repo_identity_definer USING (true) WITH CHECK (true);
CREATE POLICY repo_identity_definer_select ON accounts FOR SELECT TO repo_identity_definer USING (true);
CREATE POLICY repo_identity_definer_select ON account_members FOR SELECT TO repo_identity_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY repo_identity_definer_select ON repos FOR SELECT TO repo_identity_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- Sets the repo's identity. Raises 42501 unless the session is a verified owner or admin member of the active account (never a runner session or a platform_ops login),
-- P0002 for a repo that is not the account's. Answers the value before (`app` when there was no row) so the caller audits only a real change.
CREATE FUNCTION repo_github_identity_set(p_repo_id uuid, p_identity text)
RETURNS TABLE (previous text, changed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_role text;
  prev   text;
BEGIN
  IF pg_has_role(session_user, 'platform_ops', 'MEMBER') OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR pg_has_role(session_user, 'agent_run_writer', 'MEMBER') THEN
    RAISE EXCEPTION 'repo_github_identity_set: refused for a platform or runner session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.role INTO v_role FROM public.account_members m WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'repo_github_identity_set: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.repos rp WHERE rp.account_id = acct AND rp.id = p_repo_id) THEN
    RAISE EXCEPTION 'repo_github_identity_set: no such repo' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_identity IS NULL OR p_identity NOT IN ('app', 'personal') THEN
    RAISE EXCEPTION 'repo_github_identity_set: identity must be app or personal' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.repo_github_identity (account_id, repo_id, identity) VALUES (acct, p_repo_id, 'app') ON CONFLICT DO NOTHING;
  SELECT i.identity INTO prev FROM public.repo_github_identity i WHERE i.account_id = acct AND i.repo_id = p_repo_id FOR UPDATE;
  IF prev IS DISTINCT FROM p_identity THEN
    UPDATE public.repo_github_identity i SET identity = p_identity, updated_at = clock_timestamp() WHERE i.account_id = acct AND i.repo_id = p_repo_id;
  END IF;
  RETURN QUERY SELECT prev, prev IS DISTINCT FROM p_identity;
END
$$;
REVOKE ALL ON FUNCTION repo_github_identity_set(uuid, text) FROM PUBLIC;
ALTER FUNCTION repo_github_identity_set(uuid, text) OWNER TO repo_identity_definer;
GRANT EXECUTE ON FUNCTION repo_github_identity_set(uuid, text) TO app_user;

REVOKE CREATE ON SCHEMA public FROM repo_identity_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE repo_identity_definer FROM CURRENT_USER;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION audit_write(p_action text, p_payload jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct            uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  who             uuid := current_member_user_id();
  ts              timestamptz := clock_timestamp();
  stamped_payload jsonb := p_payload;
  new_id          uuid;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'audit_write: no app.account_id set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF who IS NULL THEN
    RAISE EXCEPTION 'audit_write: caller is not a verified member of account %', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'audit_write: account % is not active', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The 1098 allowlist carried forward whole, plus `project.github_identity_changed`. NULL fails
  -- closed explicitly (note (b) above) instead of relying on
  -- `NOT (p_action = ANY(...))` evaluating to NULL (falsy for IF) on a
  -- NULL p_action.
  IF p_action IS NULL OR NOT (p_action = ANY (ARRAY[
    'decision_dial_changed',
    'model_connection.connect',
    'model_connection.replace',
    'model_connection.remove',
    'role_settings.mode_changed',
    'role_settings.guard_changed',
    'role_settings.model_changed',
    'run_limits.changed',
    'decision_ask_setting.changed',
    'ask_route.changed',
    'discovery_setting.changed',
    'build_concurrency.changed',
    'envelope.changed',
    'autostart_envelope.changed',
    'envelope_margin.changed',
    'context_rule.saved',
    'context_rule.replaced',
    'context_rule.removed',
    'vercel_connection.connect',
    'vercel_connection.rotate',
    'vercel_connection.remove',
    'plan_writeback_setting.changed',
    'context_budget.changed',
    'verify_settings.changed',
    'engine_bridge.settings_changed',
    'engine_bridge.data_deleted',
    'engine_command.issued',
    'engine_command.acked',
    'engine_command.cancelled',
    'engine_decision.recorded',
    'engine_decision.answered',
    'engine_halt.set',
    'engine_halt.cleared',
    'onboarding.track_chosen',
    'runner.device_approved',
    'runner.device_denied',
    'project.setup_started',
    'project.plan_approved',
    'project.install_merged',
    'project.moved',
    'project.removed',
    'engine_session.started',
    'engine_session.stopped',
    'engine_session.deleted',
    'machine_credential.added',
    'machine_credential.removed',
    'server.create_confirmed',
    'server.deleted',
    'server.orphan_kept',
    'server.unsealed',
    'machine.login_started',
    'machine.linked_notified',
    'machine_server.credential_rebound',
    'project.public_survey_consented',
    'project.github_identity_changed'
  ])) THEN
    RAISE EXCEPTION 'audit_write: action % is not on the allowlist', p_action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Note (c) above: bounds a single payload's serialized size, and
  -- (D#97 fix round 1) fails closed on any TOAST-compressed argument
  -- regardless of its compressed size.
  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Decision (c)/note (a): a caller-supplied `actor`, `account_id` or
  -- `created_at` key inside the payload is overwritten with the stamped
  -- value, never trusted. Every other key (including nested ones) is
  -- stored exactly as sent.
  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(who::text));
  END IF;
  IF stamped_payload ? 'account_id' THEN
    stamped_payload := stamped_payload || jsonb_build_object('account_id', to_jsonb(acct::text));
  END IF;
  IF stamped_payload ? 'created_at' THEN
    stamped_payload := stamped_payload || jsonb_build_object('created_at', to_jsonb(ts));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, who::text, p_action, stamped_payload, ts)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- CREATE OR REPLACE preserves the owner and grants on an unchanged signature; re-run because they are idempotent (0651's pattern).
REVOKE ALL ON FUNCTION audit_write(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO context_rules_definer;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO repo_context_settings_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
