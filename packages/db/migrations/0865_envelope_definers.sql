-- D#483 S5-e1: the only writers of the three envelope facts that 0848 left open.
--
-- 0848 gave app_user INSERT on envelope_run_charges and envelope_pause_asks, and left work_items.envelope_id without a setter. The #301
-- review found three ways to spend or hide money with that:
--   * work_items.envelope_id could be set by an INSERT of a work item (app_user holds table-wide INSERT) as well as by a future UPDATE grant;
--   * a pre-inserted envelope_run_charges row for a run made reserve()'s own insert a no-op (ON CONFLICT DO NOTHING), so a real charge was dropped;
--   * a pre-inserted envelope_pause_asks row made the "raised once" memory say an ask existed when none did, so the person was never asked.
--
-- This migration closes all three. Expand-only: new objects, one trigger, and the removal of two INSERT grants whose only writers move to
-- the definers below in the same deploy (see "Rollback" at the end).
--
--   work_item_set_envelope(work_item, envelope)       the one setter of work_items.envelope_id. A trigger on work_items refuses any other writer
--                                                     (INSERT and UPDATE), so a direct INSERT or UPDATE as app_user fails on a privilege error.
--   envelope_charge_record(run, envelope, usd)        the one writer of envelope_run_charges. A charge only ever goes up (GREATEST), so a pre-written
--                                                     smaller figure cannot hide the real one; it must name the envelope the run's own item draws on.
--   envelope_pause_ask_record(item, envelope, v, ask) the one writer of envelope_pause_asks. It requires a real spend_past_envelope ask on that item,
--                                                     so the memory can never exist without the ask.
--
-- All three belong to a NEW role, envelope_definer (NOLOGIN, no members, a member of nothing), which holds exactly the columns the bodies read
-- and write, each behind a tenant-bound row policy of its own. EXECUTE goes to app_user alone: reserve() runs on that login (the worker's run
-- login is a member), and the ask is raised on the receipt login, which is a member too. platform_ops gains nothing.
--
-- Error contract (fixed messages, no argument value in any): 22023 invalid arguments; 42501 not permitted (no tenant, an inactive account, a
-- platform_ops login, a caller who is not an owner or admin for the setter); P0002 not found; 55000 `work_started`, `envelope_already_set`,
-- `envelope_scope`, `envelope_repo_mismatch`, `envelope_taken`, `envelope_mismatch`, `no_such_ask`.
-- Numbered 0865 (every number up to 0864 is held by main or an open PR). Re-check against main right before merging.

DO $$
DECLARE
  n text := 'envelope_definer';
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

GRANT USAGE ON SCHEMA public TO envelope_definer;
-- account_is_active() is a SECURITY INVOKER function, so the role must be able to read the one account in context.
GRANT SELECT (id, deleted_at) ON accounts TO envelope_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO envelope_definer;
GRANT SELECT (id, account_id, work_item_id) ON agent_runs TO envelope_definer;
GRANT SELECT (id, account_id, repo_id, stage, envelope_id) ON work_items TO envelope_definer;
GRANT UPDATE (envelope_id) ON work_items TO envelope_definer;
GRANT SELECT (id, account_id, version, scope, repo_id) ON approval_envelopes TO envelope_definer;
GRANT SELECT (id, account_id, work_item_id, decision_type) ON decision_asks TO envelope_definer;
GRANT SELECT (account_id, run_id, envelope_id, usd), INSERT (account_id, run_id, envelope_id, usd), UPDATE (usd) ON envelope_run_charges TO envelope_definer;
GRANT SELECT (account_id, work_item_id, envelope_id, envelope_version), INSERT (account_id, work_item_id, envelope_id, envelope_version, ask_id) ON envelope_pause_asks TO envelope_definer;

CREATE POLICY envelope_definer_select ON accounts FOR SELECT TO envelope_definer
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY envelope_definer_select ON account_members FOR SELECT TO envelope_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY envelope_definer_select ON agent_runs FOR SELECT TO envelope_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY envelope_definer_select ON work_items FOR SELECT TO envelope_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY envelope_definer_update ON work_items FOR UPDATE TO envelope_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY envelope_definer_select ON approval_envelopes FOR SELECT TO envelope_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY envelope_definer_select ON decision_asks FOR SELECT TO envelope_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY envelope_definer_select ON envelope_run_charges FOR SELECT TO envelope_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY envelope_definer_insert ON envelope_run_charges FOR INSERT TO envelope_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY envelope_definer_update ON envelope_run_charges FOR UPDATE TO envelope_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY envelope_definer_select ON envelope_pause_asks FOR SELECT TO envelope_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY envelope_definer_insert ON envelope_pause_asks FOR INSERT TO envelope_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---- 1. the setter of work_items.envelope_id --------------------------------------------------------------------------------------------
CREATE FUNCTION work_item_set_envelope(p_work_item_id uuid, p_envelope_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  w    record;
  e    record;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'work_item_set_envelope: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'work_item_set_envelope: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A person's approval attaches an envelope, so the caller is an owner or admin of this account (a token carries no user and is refused).
  IF usr IS NULL OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'work_item_set_envelope: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_envelope_id IS NULL THEN
    RAISE EXCEPTION 'work_item_set_envelope: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT x.id, x.repo_id, x.stage, x.envelope_id INTO w FROM public.work_items x WHERE x.id = p_work_item_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- A replay: already this envelope. Nothing is written.
  IF w.envelope_id = p_envelope_id THEN
    RETURN false;
  END IF;
  IF w.envelope_id IS NOT NULL THEN
    RAISE EXCEPTION 'envelope_already_set' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- An envelope is attached at approval, before any work: at Triaged with no run.
  IF w.stage <> 'triaged' OR EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.account_id = acct AND r.work_item_id = p_work_item_id) THEN
    RAISE EXCEPTION 'work_started' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT v.scope, v.repo_id INTO e FROM public.approval_envelopes v WHERE v.account_id = acct AND v.id = p_envelope_id ORDER BY v.version DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'envelope not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- The weekly auto-start envelope is drawn on by the dial's own gate (S5-b1a), never by a person's click.
  IF e.scope NOT IN ('item', 'batch') THEN
    RAISE EXCEPTION 'envelope_scope' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF e.repo_id IS NOT NULL AND e.repo_id IS DISTINCT FROM w.repo_id THEN
    RAISE EXCEPTION 'envelope_repo_mismatch' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- An item envelope belongs to exactly one item.
  IF e.scope = 'item' AND EXISTS (SELECT 1 FROM public.work_items o WHERE o.account_id = acct AND o.envelope_id = p_envelope_id AND o.id <> p_work_item_id) THEN
    RAISE EXCEPTION 'envelope_taken' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE public.work_items SET envelope_id = p_envelope_id WHERE id = p_work_item_id AND account_id = acct;
  RETURN true;
END $$;

-- ---- 2. the writer of envelope_run_charges ----------------------------------------------------------------------------------------------
CREATE FUNCTION envelope_charge_record(p_run_id uuid, p_envelope_id uuid, p_usd numeric)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  item uuid;
  item_envelope uuid;
  have numeric;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'envelope_charge_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'envelope_charge_record: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL OR p_envelope_id IS NULL OR p_usd IS NULL OR p_usd <= 0 OR p_usd >= 100000000 THEN
    RAISE EXCEPTION 'envelope_charge_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT r.work_item_id INTO item FROM public.agent_runs r WHERE r.id = p_run_id AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT w.envelope_id INTO item_envelope FROM public.work_items w WHERE w.id = item AND w.account_id = acct;
  IF item_envelope IS DISTINCT FROM p_envelope_id THEN
    RAISE EXCEPTION 'envelope_mismatch' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT c.usd INTO have FROM public.envelope_run_charges c WHERE c.account_id = acct AND c.run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.envelope_run_charges (account_id, run_id, envelope_id, usd) VALUES (acct, p_run_id, p_envelope_id, p_usd);
    RETURN true;
  END IF;
  -- A charge only goes up: a smaller figure written earlier can never hide the real one, and a repeat of the same figure writes nothing.
  IF p_usd > have THEN
    UPDATE public.envelope_run_charges SET usd = p_usd WHERE account_id = acct AND run_id = p_run_id;
    RETURN true;
  END IF;
  RETURN false;
END $$;

-- ---- 3. the writer of envelope_pause_asks -----------------------------------------------------------------------------------------------
CREATE FUNCTION envelope_pause_ask_record(p_work_item_id uuid, p_envelope_id uuid, p_version integer, p_ask_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  item_envelope uuid;
  n integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'envelope_pause_ask_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'envelope_pause_ask_record: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_envelope_id IS NULL OR p_ask_id IS NULL OR p_version IS NULL OR p_version < 1 THEN
    RAISE EXCEPTION 'envelope_pause_ask_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT w.envelope_id INTO item_envelope FROM public.work_items w WHERE w.id = p_work_item_id AND w.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF item_envelope IS DISTINCT FROM p_envelope_id THEN
    RAISE EXCEPTION 'envelope_mismatch' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.approval_envelopes v WHERE v.account_id = acct AND v.id = p_envelope_id AND v.version = p_version) THEN
    RAISE EXCEPTION 'envelope not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- The memory exists only beside the ask it stands for: a real spend_past_envelope ask on this item.
  IF NOT EXISTS (SELECT 1 FROM public.decision_asks a WHERE a.account_id = acct AND a.id = p_ask_id AND a.work_item_id = p_work_item_id AND a.decision_type = 'spend_past_envelope') THEN
    RAISE EXCEPTION 'no_such_ask' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  INSERT INTO public.envelope_pause_asks (account_id, work_item_id, envelope_id, envelope_version, ask_id)
  VALUES (acct, p_work_item_id, p_envelope_id, p_version, p_ask_id)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- ---- the guard: nobody else may write work_items.envelope_id ----------------------------------------------------------------------------
-- app_user holds table-wide INSERT on work_items, so a column grant is not enough. The trigger refuses any write that sets or changes the
-- column unless it runs as the definer role (or a superuser, which only a migration or a test fixture is).
CREATE FUNCTION work_items_envelope_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.envelope_id IS NULL THEN RETURN NEW; END IF;
  ELSIF NEW.envelope_id IS NOT DISTINCT FROM OLD.envelope_id THEN
    RETURN NEW;
  END IF;
  IF current_user <> 'envelope_definer' AND NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION '%: envelope_id is written only by work_item_set_envelope', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION work_items_envelope_guard() FROM PUBLIC;
CREATE TRIGGER work_items_envelope_guard BEFORE INSERT OR UPDATE OF envelope_id ON work_items FOR EACH ROW EXECUTE FUNCTION work_items_envelope_guard();

-- ---- ownership and grants ---------------------------------------------------------------------------------------------------------------
-- Ownership bracket (0792's shape): the migration role holds the new role only to hand the functions over; both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'envelope_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on envelope_definer; cannot ALTER FUNCTION ... OWNER TO envelope_definer';
    END IF;
    GRANT envelope_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO envelope_definer;

REVOKE ALL ON FUNCTION work_item_set_envelope(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION envelope_charge_record(uuid, uuid, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION envelope_pause_ask_record(uuid, uuid, integer, uuid) FROM PUBLIC;
ALTER FUNCTION work_item_set_envelope(uuid, uuid) OWNER TO envelope_definer;
ALTER FUNCTION envelope_charge_record(uuid, uuid, numeric) OWNER TO envelope_definer;
ALTER FUNCTION envelope_pause_ask_record(uuid, uuid, integer, uuid) OWNER TO envelope_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION work_item_set_envelope(uuid, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION envelope_charge_record(uuid, uuid, numeric) TO app_user;
GRANT EXECUTE ON FUNCTION envelope_pause_ask_record(uuid, uuid, integer, uuid) TO app_user;

REVOKE CREATE ON SCHEMA public FROM envelope_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE envelope_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- app_user can no longer write the two tables directly: the definers above are their only writers.
REVOKE INSERT ON envelope_run_charges FROM app_user;
REVOKE INSERT ON envelope_pause_asks FROM app_user;

-- Rollback. The previous deploy wrote those two tables with a plain INSERT as app_user, which now fails on a privilege error. That is safe
-- to roll back onto: before this deploy no work item could carry an envelope (nothing set work_items.envelope_id), so no run reads or
-- writes either table until a person approves with an envelope, and the old reserve() fails closed (the run is refused, never undercharged)
-- for any item that has one. Nothing is dropped, so rolling forward again needs no data repair.
