-- D#7 DW-R7: a runner run on a member's plan under the repo's "ask" setting raises one ask in Needs you, and only the plan holder answers it.
--
-- Today such a run waits unseen: the claim offers a subscription runner only the runs its registrant started or approved, or that the
-- claim approves by itself (0767, dial announce or act). Under "ask" none of those hold, so no one is told. The worker now raises one
-- `runner_run_on_member_plan` ask for the run (the existing ask machinery) and records here whose plan it would spend.
--
--   runner_plan_asks             one row per run, ever: (run) is the key, so a repeat claim attempt, or a run that was asked and answered "no", never
--                                gets a second ask. It names the ask, the runner and the plan holder (the runner's registrant). The holder is read by the
--                                writer below from the runner row, never passed in. app_user reads its own tenant's rows (the ask list shows the holder's
--                                name and who may answer); nobody but the definer writes.
--   runner_plan_ask_record(ask, run, runner)   the one writer. It refuses unless every one of these holds right now: a live subscription runner of this
--                                account that lists the run's repo, whose registrant is an owner or admin; the run is pending, unclaimed and unapproved on
--                                that repo; the ask is a runner_run_on_member_plan ask on exactly this run; and the repo's current dial is `ask`.
--                                True when it wrote the row, false when the run already had one.
--
-- Owner: a NEW role, runner_plan_ask_definer (NOLOGIN, no members, a member of nothing), with column SELECT on exactly what the body reads, the dial
-- included, and INSERT on the new table's columns; it holds no UPDATE on any table and no lock on a run (the caller's advisory lock covers the race).
-- EXECUTE: app_user (the receipt login that raises the ask is a member of it). platform_ops gains nothing. Expand-only: one new table, one new
-- function, one new role, column grants and policies. Numbered above 0981 (the highest claim among open pull requests); re-checked right before opening.

DO $$
DECLARE
  n text := 'runner_plan_ask_definer';
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



CREATE TABLE runner_plan_asks (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  run_id      uuid NOT NULL,
  ask_id      uuid NOT NULL REFERENCES decision_asks (id) ON DELETE CASCADE,
  runner_id   uuid NOT NULL,
  plan_holder uuid REFERENCES users (id) ON DELETE SET NULL, -- null once the person's account is deleted: the ask stays, names no one, and nobody can answer it
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, run_id),
  UNIQUE (ask_id),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE
);
ALTER TABLE runner_plan_asks ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_plan_asks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON runner_plan_asks FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT ON runner_plan_asks TO app_user;

GRANT USAGE ON SCHEMA public TO runner_plan_ask_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_plan_ask_definer;
GRANT SELECT (id, account_id, dispatch_repo_id, status, runtime, approved_by, runner_id) ON agent_runs TO runner_plan_ask_definer;
GRANT SELECT (id, account_id, registered_by, credential_mode, allowed_repo_ids, revoked_at) ON runners TO runner_plan_ask_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO runner_plan_ask_definer;
GRANT SELECT (account_id, repo_id, decision_type, disposition, version) ON decision_settings TO runner_plan_ask_definer;
GRANT SELECT (id, account_id, run_id, decision_type) ON decision_asks TO runner_plan_ask_definer;
GRANT SELECT (account_id, run_id), INSERT (account_id, run_id, ask_id, runner_id, plan_holder) ON runner_plan_asks TO runner_plan_ask_definer;

CREATE POLICY runner_plan_ask_definer_select ON accounts FOR SELECT TO runner_plan_ask_definer
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_plan_ask_definer_select ON agent_runs FOR SELECT TO runner_plan_ask_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_plan_ask_definer_select ON runners FOR SELECT TO runner_plan_ask_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_plan_ask_definer_select ON account_members FOR SELECT TO runner_plan_ask_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_plan_ask_definer_select ON decision_settings FOR SELECT TO runner_plan_ask_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_plan_ask_definer_select ON decision_asks FOR SELECT TO runner_plan_ask_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_plan_ask_definer_select ON runner_plan_asks FOR SELECT TO runner_plan_ask_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_plan_ask_definer_insert ON runner_plan_asks FOR INSERT TO runner_plan_ask_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- Ownership bracket (0865's shape): the migration role holds the new role only to hand the function over.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_plan_ask_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_plan_ask_definer; cannot ALTER FUNCTION ... OWNER TO runner_plan_ask_definer';
    END IF;
    GRANT runner_plan_ask_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_plan_ask_definer;

CREATE FUNCTION runner_plan_ask_record(p_ask_id uuid, p_run_id uuid, p_runner_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct        uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_repo      uuid;
  v_holder    uuid;
  v_dial      text;
  n           integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_plan_ask_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'runner_plan_ask_record: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_ask_id IS NULL OR p_run_id IS NULL OR p_runner_id IS NULL THEN
    RAISE EXCEPTION 'runner_plan_ask_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The run: pending, unclaimed and unapproved, on a repo.
  SELECT a.dispatch_repo_id INTO v_repo FROM public.agent_runs a
   WHERE a.account_id = acct AND a.id = p_run_id AND a.status = 'pending' AND a.runtime = 'runner' AND a.approved_by IS NULL AND a.runner_id IS NULL;
  IF NOT FOUND OR v_repo IS NULL THEN
    RAISE EXCEPTION 'run_not_waiting' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The runner's registrant is the plan holder: read here, never passed in. A live subscription runner that lists the repo, held by an owner or admin.
  SELECT r.registered_by INTO v_holder FROM public.runners r
   WHERE r.account_id = acct AND r.id = p_runner_id AND r.credential_mode = 'subscription' AND r.revoked_at IS NULL AND v_repo = ANY (r.allowed_repo_ids);
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = v_holder AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'no_plan_holder' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The dial is `ask` now (a later or earlier setting is not asked about).
  SELECT d.disposition INTO v_dial FROM public.decision_settings d
   WHERE d.account_id = acct AND d.repo_id = v_repo AND d.decision_type = 'runner_run_on_member_plan' ORDER BY d.version DESC LIMIT 1;
  IF COALESCE(v_dial, 'announce') <> 'ask' THEN
    RAISE EXCEPTION 'dial_not_ask' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The ask just raised: this decision, on this run.
  IF NOT EXISTS (SELECT 1 FROM public.decision_asks k WHERE k.account_id = acct AND k.id = p_ask_id AND k.run_id = p_run_id AND k.decision_type = 'runner_run_on_member_plan') THEN
    RAISE EXCEPTION 'no_such_ask' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  INSERT INTO public.runner_plan_asks (account_id, run_id, ask_id, runner_id, plan_holder) VALUES (acct, p_run_id, p_ask_id, p_runner_id, v_holder)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END
$$;

REVOKE ALL ON FUNCTION runner_plan_ask_record(uuid, uuid, uuid) FROM PUBLIC;
ALTER FUNCTION runner_plan_ask_record(uuid, uuid, uuid) OWNER TO runner_plan_ask_definer;
GRANT EXECUTE ON FUNCTION runner_plan_ask_record(uuid, uuid, uuid) TO app_user;

REVOKE CREATE ON SCHEMA public FROM runner_plan_ask_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_plan_ask_definer FROM CURRENT_USER;
  END IF;
END
$$;
