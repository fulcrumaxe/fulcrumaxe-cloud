-- Engine bridge EB-11a: the engine halt, cloud side (0750's pattern, one level up: a repo's engine instead of a work item).
--
-- What a halt is. A person stops the engine running on their own machine for one repository. It is hard: the runner kills the engine
-- (EB-11b), every decide is refused, and the commands that would start or widen work are refused. Only a person can lift it.
--
-- The marker, one row per repo (created the first time anything needs it):
--   halted_at       set by a halt, cleared only by a person's later clear. NULL means not halted.
--   halt_action_id  the halt that set it (NULL exactly when halted_at is NULL).
--   halt_epoch      +1 per halt, never decremented, never changed by a clear: a runner that sees a higher epoch kills the engine,
--                   and a command signed under an older epoch is recognisably stale.
--   cleared_at      when the last clear happened (NULL if none yet). A fact, not a switch: nothing reads it to decide anything.
--
-- The refusal. BEFORE INSERT triggers on engine_decisions (every decide) and engine_commands (start_day, resume_loop, request_spawn and
-- set_dial; pause_loop, answer_ask and stop_agent stay allowed) read the marker FOR SHARE and raise HX409 'engine_halted'. A halt writes the
-- marker under the row's FOR UPDATE lock, which conflicts with FOR SHARE (0750's order):
--   * a decide or command in flight holds the share lock, so the halt waits for it to commit and then lists it;
--   * a halt that committed first is read by the insert (READ COMMITTED re-reads a locked row) and the insert rolls back.
-- The row has to exist for either to block, so the helper and the halt both insert it first (ON CONFLICT DO NOTHING waits for an
-- uncommitted insert of the same key). A decide after the halt committed is therefore impossible, not merely unlikely.
--
-- Who may write. app_user can only read the marker. Setting and clearing are two SECURITY DEFINER functions owned by a NOLOGIN role of
-- their own (engine_halt_definer, 0720's guard_definer shape). Each checks, inside the definer, that the session belongs to a verified member
-- of the session's account (the same row current_member_user_id() reads) whose role is owner or admin, and that the account is active and
-- the repo is one of its own. EXECUTE on them goes to app_user only: the runner channel (agent_run_writer), platform_ops and PUBLIC have none, and
-- a platform_ops login (by role membership, not by name) is refused outright, and so is any runner session (app.runner_id set, or a member of agent_run_writer). An API token is refused one layer up (the route is session-only), and a token's database session
-- is no different from a person's, so that layer is pinned by a route test too.
--
-- The trigger functions are the migration owner's, invoker rights, and call one definer helper, engine_halt_lock, that takes the share
-- lock, then a second, engine_halt_epoch, that reads the epoch for the command channel (stamped into halt_epoch_at_issue under that lock). The helpers refuse unless the account named is the session's (or, with no tenant session, the caller is the migration owner's). EXECUTE on the helper goes to app_user (the commands route inserts as the person), agent_run_writer (the runner's decide path) and
-- the migration owner. An inserting role outside those gets 42501, which fails closed: a later row that inserts as another role must add
-- its own grant, in its own migration.
--
-- Depends on engine_commands (1029) and engine_decisions (1030): it raises when either is missing, because a halt that cannot refuse is worse
-- than a migration that stops. They merge in number order.

CREATE TABLE engine_repo_controls (
  account_id      uuid        NOT NULL,
  repo_id         uuid        NOT NULL,
  halted_at       timestamptz,
  halt_action_id  uuid,
  halt_epoch      integer     NOT NULL DEFAULT 0 CONSTRAINT engine_repo_controls_epoch_check CHECK (halt_epoch >= 0),
  cleared_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, repo_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  CONSTRAINT engine_repo_controls_halt_marker_pair CHECK ((halted_at IS NULL) = (halt_action_id IS NULL))
);

ALTER TABLE engine_repo_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_repo_controls FORCE ROW LEVEL SECURITY;
GRANT SELECT ON engine_repo_controls TO app_user;
CREATE POLICY tenant_isolation_select ON engine_repo_controls FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

-- ---- the role ---------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text := 'engine_halt_definer';
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

GRANT USAGE ON SCHEMA public TO engine_halt_definer;
GRANT SELECT, INSERT, UPDATE ON engine_repo_controls TO engine_halt_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO engine_halt_definer;
GRANT SELECT (id, account_id) ON repos TO engine_halt_definer;
-- account_is_active runs with the caller's rights and reads accounts: the same two columns 0786 grants its definer for it.
GRANT SELECT (id, deleted_at) ON accounts TO engine_halt_definer;
CREATE POLICY engine_halt_definer_select ON accounts FOR SELECT TO engine_halt_definer USING (true);
CREATE POLICY engine_halt_definer_select ON engine_repo_controls FOR SELECT TO engine_halt_definer USING (true);
CREATE POLICY engine_halt_definer_insert ON engine_repo_controls FOR INSERT TO engine_halt_definer WITH CHECK (true);
CREATE POLICY engine_halt_definer_update ON engine_repo_controls FOR UPDATE TO engine_halt_definer USING (true) WITH CHECK (true);
-- Only the caller's own account: the set and clear bodies name the account from the session, and these policies keep a slip from reading another's.
CREATE POLICY engine_halt_definer_select ON account_members FOR SELECT TO engine_halt_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY engine_halt_definer_select ON repos FOR SELECT TO engine_halt_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---- ownership bracket (0750's shape) -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'engine_halt_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_halt_definer; cannot ALTER FUNCTION ... OWNER TO engine_halt_definer';
    END IF;
    GRANT engine_halt_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO engine_halt_definer;

-- ---- the lock helper: the trigger's one call ------------------------------------------------------------------------
-- True when the repo's engine is halted. Names both ids, so nothing leans on a session setting (a fixture may insert outside a tenant context).
CREATE FUNCTION engine_halt_lock(p_account_id uuid, p_repo_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_halted boolean;
  v_acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  -- The account comes from the verified session, never from the argument alone: a session of one tenant cannot read, create a marker for or
  -- lock another tenant's repo. A session with no tenant at all (a fixture, or a maintenance connection) must be the migration owner's.
  IF v_acct IS NULL THEN
    IF NOT pg_has_role(session_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.engine_repo_controls'::regclass), 'MEMBER') THEN
      RAISE EXCEPTION 'engine_halt_lock: no tenant session' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF v_acct IS DISTINCT FROM p_account_id THEN
    RAISE EXCEPTION 'engine_halt_lock: account does not match the session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT halted_at IS NOT NULL INTO v_halted FROM public.engine_repo_controls WHERE account_id = p_account_id AND repo_id = p_repo_id FOR SHARE;
  IF NOT FOUND THEN
    -- No row yet: make it (a halt racing this insert waits on it), then lock it. The FK keeps a made-up repo from creating one.
    INSERT INTO public.engine_repo_controls (account_id, repo_id) VALUES (p_account_id, p_repo_id) ON CONFLICT DO NOTHING;
    SELECT halted_at IS NOT NULL INTO v_halted FROM public.engine_repo_controls WHERE account_id = p_account_id AND repo_id = p_repo_id FOR SHARE;
  END IF;
  RETURN COALESCE(v_halted, false);
END
$$;
REVOKE ALL ON FUNCTION engine_halt_lock(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION engine_halt_lock(uuid, uuid) OWNER TO engine_halt_definer;
GRANT EXECUTE ON FUNCTION engine_halt_lock(uuid, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION engine_halt_lock(uuid, uuid) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION engine_halt_lock(uuid, uuid) TO CURRENT_USER;

-- The repo's current epoch, read in its own statement after engine_halt_lock has taken the share lock (so a halt cannot move it before the
-- caller's transaction ends). Same account rule as the lock helper; a repo with no marker row has never been halted: epoch 0.
CREATE FUNCTION engine_halt_epoch(p_account_id uuid, p_repo_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_epoch integer;
BEGIN
  IF v_acct IS NULL THEN
    IF NOT pg_has_role(session_user, (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.engine_repo_controls'::regclass), 'MEMBER') THEN
      RAISE EXCEPTION 'engine_halt_epoch: no tenant session' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF v_acct IS DISTINCT FROM p_account_id THEN
    RAISE EXCEPTION 'engine_halt_epoch: account does not match the session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT c.halt_epoch INTO v_epoch FROM public.engine_repo_controls c WHERE c.account_id = p_account_id AND c.repo_id = p_repo_id;
  RETURN COALESCE(v_epoch, 0);
END
$$;
REVOKE ALL ON FUNCTION engine_halt_epoch(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION engine_halt_epoch(uuid, uuid) OWNER TO engine_halt_definer;
GRANT EXECUTE ON FUNCTION engine_halt_epoch(uuid, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION engine_halt_epoch(uuid, uuid) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION engine_halt_epoch(uuid, uuid) TO CURRENT_USER;

-- ---- set and clear: a person, an owner or admin, and nothing else ----------------------------------------------------
-- The shared guard. Raises 42501 unless the session is a verified owner or admin member of the session's active account.
CREATE FUNCTION engine_halt_assert_person(p_what text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  v_role text;
BEGIN
  IF pg_has_role(session_user, 'platform_ops', 'MEMBER') THEN
    RAISE EXCEPTION '%: refused for a platform_ops login', p_what USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A runner session is never a person, whatever else it sets: the runner channel's login (agent_run_writer) and any session that names a
  -- runner are refused outright, so a later change that sets app.user_id on the runner's path cannot clear a halt.
  IF NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR pg_has_role(session_user, 'agent_run_writer', 'MEMBER') THEN
    RAISE EXCEPTION '%: refused for a runner session', p_what USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR usr IS NULL OR v_role NOT IN ('owner', 'admin') OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION '%: caller is not an owner or admin of an active account', p_what USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN acct;
END
$$;
REVOKE ALL ON FUNCTION engine_halt_assert_person(text) FROM PUBLIC;
ALTER FUNCTION engine_halt_assert_person(text) OWNER TO engine_halt_definer;

-- Halts the repo's engine. Answers the epoch and whether this call is the one that set it (false: it was halted already, nothing changed).
CREATE FUNCTION engine_halt_set(p_repo_id uuid)
RETURNS TABLE (halt_epoch integer, newly_halted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := public.engine_halt_assert_person('engine_halt_set');
  r    public.engine_repo_controls%ROWTYPE;
BEGIN
  IF p_repo_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.repos rp WHERE rp.account_id = acct AND rp.id = p_repo_id) THEN
    RAISE EXCEPTION 'engine_halt_set: no such repo' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.engine_repo_controls (account_id, repo_id) VALUES (acct, p_repo_id) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.engine_repo_controls c WHERE c.account_id = acct AND c.repo_id = p_repo_id FOR UPDATE;
  IF r.halted_at IS NOT NULL THEN
    RETURN QUERY SELECT r.halt_epoch, false;
    RETURN;
  END IF;
  UPDATE public.engine_repo_controls c
     SET halted_at = clock_timestamp(), halt_action_id = gen_random_uuid(), halt_epoch = c.halt_epoch + 1, updated_at = clock_timestamp()
   WHERE c.account_id = acct AND c.repo_id = p_repo_id
  RETURNING c.halt_epoch INTO halt_epoch;
  newly_halted := true;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION engine_halt_set(uuid) FROM PUBLIC;
ALTER FUNCTION engine_halt_set(uuid) OWNER TO engine_halt_definer;
GRANT EXECUTE ON FUNCTION engine_halt_set(uuid) TO app_user;

-- Lifts the halt. The epoch does not change. Answers it and whether this call is the one that cleared it.
CREATE FUNCTION engine_halt_clear(p_repo_id uuid)
RETURNS TABLE (halt_epoch integer, newly_cleared boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := public.engine_halt_assert_person('engine_halt_clear');
  r    public.engine_repo_controls%ROWTYPE;
BEGIN
  IF p_repo_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.repos rp WHERE rp.account_id = acct AND rp.id = p_repo_id) THEN
    RAISE EXCEPTION 'engine_halt_clear: no such repo' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.engine_repo_controls (account_id, repo_id) VALUES (acct, p_repo_id) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.engine_repo_controls c WHERE c.account_id = acct AND c.repo_id = p_repo_id FOR UPDATE;
  IF r.halted_at IS NULL THEN
    RETURN QUERY SELECT r.halt_epoch, false;
    RETURN;
  END IF;
  UPDATE public.engine_repo_controls c
     SET halted_at = NULL, halt_action_id = NULL, cleared_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE c.account_id = acct AND c.repo_id = p_repo_id
  RETURNING c.halt_epoch INTO halt_epoch;
  newly_cleared := true;
  RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION engine_halt_clear(uuid) FROM PUBLIC;
ALTER FUNCTION engine_halt_clear(uuid) OWNER TO engine_halt_definer;
GRANT EXECUTE ON FUNCTION engine_halt_clear(uuid) TO app_user;

-- engine_halt_assert_person is a helper of the two above, which run as the same owner: nobody else calls it.
REVOKE CREATE ON SCHEMA public FROM engine_halt_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE engine_halt_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- the triggers ---------------------------------------------------------------------------------------------------
-- Invoker rights, the migration owner's, nothing but the helper call.
CREATE FUNCTION engine_commands_refuse_halted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_halted boolean := public.engine_halt_lock(NEW.account_id, NEW.repo_id);
BEGIN
  -- The lock is taken for every kind, so the epoch below cannot move before this insert commits. It is read in its own statement
  -- (a fresh snapshot after the lock wait), and it raises whatever the caller read earlier to the current epoch (never below what the caller stamped): a halt and a clear that commit between
  -- the route's own read and this insert still give the command the current epoch.
  NEW.halt_epoch_at_issue := GREATEST(COALESCE(NEW.halt_epoch_at_issue, 0), public.engine_halt_epoch(NEW.account_id, NEW.repo_id));
  -- pause_loop, answer_ask and stop_agent are the ways a person quiets or answers a halted engine: they stay allowed.
  IF NEW.kind IN ('start_day', 'resume_loop', 'request_spawn', 'set_dial') AND v_halted IS TRUE THEN
    RAISE EXCEPTION 'engine_halted' USING ERRCODE = 'HX409';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION engine_commands_refuse_halted() FROM PUBLIC;

CREATE FUNCTION engine_decisions_refuse_halted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF public.engine_halt_lock(NEW.account_id, NEW.repo_id) IS TRUE THEN
    RAISE EXCEPTION 'engine_halted' USING ERRCODE = 'HX409';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION engine_decisions_refuse_halted() FROM PUBLIC;

DO $$
BEGIN
  IF to_regclass('public.engine_commands') IS NULL OR to_regclass('public.engine_decisions') IS NULL THEN
    RAISE EXCEPTION 'engine_halt: engine_commands (1029) and engine_decisions (1030) must exist before 1031';
  END IF;
END
$$;

CREATE TRIGGER engine_commands_refuse_halted
  BEFORE INSERT ON engine_commands
  FOR EACH ROW EXECUTE FUNCTION engine_commands_refuse_halted();
CREATE TRIGGER engine_decisions_refuse_halted
  BEFORE INSERT ON engine_decisions
  FOR EACH ROW EXECUTE FUNCTION engine_decisions_refuse_halted();
