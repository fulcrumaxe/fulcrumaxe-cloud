-- D#2 H17c-1: the onboarding preview's table, its request definer, the
-- platform-wide daily compute read, and run_action_request taught a preview
-- target (0658 looked a start_preview up in work_items, which a preview has none of).
--
-- Who writes what:
--   * INSERT  only onboarding_preview_request (app_user; session owner/admin).
--             The GitHub user is copied from installation_installers, never
--             from the caller. It also links the row to its run action.
--   * UPDATE  only the runner login (agent_run_writer): state, run_id,
--             started_at, void_reason, with the legal edges held by a trigger.
--   * app_user can SELECT its own tenant's rows and nothing else.
-- platform_ops reads started rows (gh-proxy's run resolver, H17c-2) through a
-- policy that shows it nothing until a run has started.
-- One preview per GitHub user and per installation, but a void preview (one
-- that never started a run, so spent nothing) frees the slot.
-- Privilege brackets as in 0682.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

CREATE TABLE onboarding_previews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  repo_id         uuid NOT NULL,
  gh_user_id      bigint NOT NULL CHECK (gh_user_id > 0),
  run_action_id   uuid NOT NULL UNIQUE,
  run_id          uuid UNIQUE,
  state           text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'running', 'finished', 'void')),
  model_cap_usd   numeric NOT NULL DEFAULT 20 CHECK (model_cap_usd = 20),
  compute_cap_usd numeric NOT NULL DEFAULT 1 CHECK (compute_cap_usd = 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  void_reason     text CHECK (void_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  FOREIGN KEY (account_id, installation_id) REFERENCES installations (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id),
  CONSTRAINT onboarding_previews_shape CHECK (
    (state = 'requested' AND run_id IS NULL AND started_at IS NULL AND void_reason IS NULL)
    OR (state IN ('running', 'finished') AND run_id IS NOT NULL AND started_at IS NOT NULL AND void_reason IS NULL)
    OR (state = 'void' AND run_id IS NULL AND started_at IS NULL AND void_reason IS NOT NULL))
);
CREATE UNIQUE INDEX onboarding_previews_one_per_user ON onboarding_previews (gh_user_id) WHERE state <> 'void';
CREATE UNIQUE INDEX onboarding_previews_one_per_installation ON onboarding_previews (installation_id) WHERE state <> 'void';

ALTER TABLE onboarding_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_previews FORCE ROW LEVEL SECURITY;
REVOKE ALL ON onboarding_previews FROM PUBLIC, app_user;
GRANT SELECT ON onboarding_previews TO app_user;
CREATE POLICY tenant_isolation_select ON onboarding_previews FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

-- platform_ops owns the definers. A direct platform_ops login (the web pool)
-- writes nothing and, in its own tenantless session, sees only a started row.
GRANT SELECT (id, account_id, run_id, run_action_id, state) ON onboarding_previews TO platform_ops;
GRANT INSERT (account_id, installation_id, repo_id, gh_user_id, run_action_id) ON onboarding_previews TO platform_ops;
GRANT UPDATE (run_action_id) ON onboarding_previews TO platform_ops;
CREATE POLICY platform_ops_read_started ON onboarding_previews FOR SELECT TO platform_ops
  USING (run_id IS NOT NULL);
CREATE POLICY platform_ops_read_tenant ON onboarding_previews FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY platform_ops_insert ON onboarding_previews FOR INSERT TO platform_ops
  WITH CHECK (session_user <> 'platform_ops'
              AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY platform_ops_update ON onboarding_previews FOR UPDATE TO platform_ops
  USING (session_user <> 'platform_ops' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (session_user <> 'platform_ops' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- The worker starts or voids a preview under its row lock (FOR UPDATE needs the
-- UPDATE grant and policy); the trigger below holds every other column fixed.
GRANT UPDATE (state, run_id, started_at, void_reason) ON onboarding_previews TO agent_run_writer;
CREATE POLICY writer_update ON onboarding_previews FOR UPDATE TO agent_run_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- 0658's guard shape: no write from a direct platform_ops login; for every other
-- non-superuser a row is inserted as requested, only requested -> running | void
-- is legal, and the identity, cap and ownership columns never change.
CREATE FUNCTION onboarding_previews_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'onboarding_previews: platform_ops may not write directly' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'requested' THEN
      RAISE EXCEPTION 'onboarding_previews: a preview is inserted as requested' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW.id, NEW.account_id, NEW.installation_id, NEW.repo_id, NEW.gh_user_id, NEW.model_cap_usd, NEW.compute_cap_usd, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.installation_id, OLD.repo_id, OLD.gh_user_id, OLD.model_cap_usd, OLD.compute_cap_usd, OLD.created_at)
     OR NOT ((OLD.state = 'requested' AND NEW.state IN ('requested', 'running', 'void'))
             AND (NEW.run_action_id = OLD.run_action_id OR NEW.state = 'requested')) THEN
    RAISE EXCEPTION 'onboarding_previews: illegal change from %', OLD.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER onboarding_previews_write_guard BEFORE INSERT OR UPDATE ON onboarding_previews
  FOR EACH ROW EXECUTE FUNCTION onboarding_previews_write_guard();

-- ---------------------------------------------------------------------
-- The request definer: session owner or admin only, the repo must belong to
-- the account and sit on a live team_readonly installation with an installer
-- record. Inserts the preview and asks for its run action in one call; a
-- replayed idempotency key returns the original ids and writes nothing.
-- ---------------------------------------------------------------------
CREATE FUNCTION onboarding_preview_request(p_repo_id uuid, p_idempotency_key text, p_request_hash text)
RETURNS TABLE (preview_id uuid, action_id uuid, state text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct      uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr       uuid := current_member_user_id();
  pid       uuid;
  inst      uuid;
  gh_inst   bigint;
  installer bigint;
  ra        record;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'onboarding_preview_request: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NULLIF(current_setting('app.token_id', true), '') IS NOT NULL OR usr IS NULL
     OR COALESCE(current_member_role(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'onboarding_preview_request: a session owner or admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL THEN
    RAISE EXCEPTION 'onboarding_preview_request: repo is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT p.id INTO pid FROM public.onboarding_previews p
      JOIN public.run_action_requests q ON q.id = p.run_action_id AND q.account_id = p.account_id
     WHERE p.account_id = acct AND q.requested_by = 'session:' || usr::text AND q.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      SELECT * INTO ra FROM public.run_action_request('start_preview', pid, p_idempotency_key, p_request_hash);
      RETURN QUERY SELECT pid, ra.action_id, ra.state, true;
      RETURN;
    END IF;
  END IF;

  SELECT r.installation_id, i.gh_installation_id INTO inst, gh_inst
    FROM public.repos r JOIN public.installations i ON i.account_id = r.account_id AND i.id = r.installation_id
   WHERE r.id = p_repo_id AND r.account_id = acct AND i.app_kind = 'team_readonly';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'onboarding_preview_request: repo not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT ii.installer_gh_user_id INTO installer FROM public.installation_installers ii
   WHERE ii.gh_installation_id = gh_inst AND ii.app_kind = 'team_readonly'
     AND ii.deleted_at IS NULL AND ii.suspended_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'onboarding_preview_request: repo not found' USING ERRCODE = 'P0002';
  END IF;

  -- run_action_id is a placeholder until the action exists (it needs this row as its target).
  INSERT INTO public.onboarding_previews (account_id, installation_id, repo_id, gh_user_id, run_action_id)
  VALUES (acct, inst, p_repo_id, installer, gen_random_uuid()) RETURNING id INTO pid;
  SELECT * INTO ra FROM public.run_action_request('start_preview', pid, p_idempotency_key, p_request_hash);
  IF ra.replayed THEN
    RAISE EXCEPTION 'onboarding_preview_request: idempotency key already names another action' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.onboarding_previews p SET run_action_id = ra.action_id WHERE p.id = pid;
  RETURN QUERY SELECT pid, ra.action_id, ra.state, false;
END $$;

-- ---------------------------------------------------------------------
-- Today's (UTC) preview compute reservations across all accounts: one number.
-- platform_ops gains SELECT on five spend_reservations columns (no account,
-- no run), through a policy that shows it only preview compute rows and only
-- to a session that is not a direct platform_ops login. A NOLOGIN reader role
-- would need a new exception in test-neon-shape.sh; this needs none.
-- ---------------------------------------------------------------------
GRANT SELECT (purpose, budget, state, usd_reserved, created_at) ON spend_reservations TO platform_ops;
CREATE POLICY platform_ops_preview_compute ON spend_reservations FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops' AND purpose = 'preview' AND budget IN ('foreground_compute', 'background_compute'));

CREATE FUNCTION preview_daily_compute_usd() RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(SUM(s.usd_reserved), 0)
    FROM public.spend_reservations s
   WHERE s.purpose = 'preview' AND s.budget IN ('foreground_compute', 'background_compute')
     -- Any state: finalize RELEASES a finished run's compute row (nothing records actual
     -- sandbox usd), so filtering on state would drop a preview the moment it ends.
     AND s.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
$$;

-- ---------------------------------------------------------------------
-- run_action_request: 0658's body, with one change: a start_preview target is
-- an onboarding_previews row of this account that is still requested. Dropped
-- and recreated (no CASCADE) with the same signature, owner and ACL.
-- ---------------------------------------------------------------------
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
  IF p_kind IS NULL OR p_kind NOT IN ('cancel_run', 'cancel_work_item', 'retry_run', 'continue_work_item', 'start_preview')
     OR char_length(COALESCE(p_request_hash, '')) NOT BETWEEN 1 AND 128
     OR char_length(COALESCE(p_idempotency_key, 'k')) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'run_action_request: invalid kind, key or hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF pkind = 'token' AND NOT (p_kind IN ('cancel_run', 'cancel_work_item') AND 'runs:cancel' = ANY (scopes)) THEN
    RAISE EXCEPTION 'run_action_request: token may not request %', p_kind USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind = 'start_preview' AND pkind = 'session' AND COALESCE(current_member_role(), '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'run_action_request: a session owner or admin only may start a preview' USING ERRCODE = 'insufficient_privilege';
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
REVOKE ALL ON FUNCTION onboarding_preview_request(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION onboarding_preview_request(uuid, text, text) TO app_user;
REVOKE ALL ON FUNCTION preview_daily_compute_usd() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION preview_daily_compute_usd() TO app_user, agent_run_writer;
ALTER FUNCTION run_action_request(text, uuid, text, text) OWNER TO platform_ops;
ALTER FUNCTION onboarding_preview_request(uuid, text, text) OWNER TO platform_ops;
ALTER FUNCTION preview_daily_compute_usd() OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
