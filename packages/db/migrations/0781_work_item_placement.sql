-- D#599 PL-1: an item can say where its runs go. work_items.placement is 'cloud', 'runner' or NULL (NULL means "follow the repo",
-- derived from the repo's mode at the time of reading, never stamped). 'runner_verified' is NOT a value here: the runner flavour always
-- comes from the repo, so an item can never pick the cloud-verified mode on its own.
--
-- app_user gets NO column grant on placement (and an insert guard below covers its table-wide INSERT). Whoever sets it (the placement
-- route, a later PR) does it through a definer that re-derives owner/admin, so a member's login cannot write the column even by a bug
-- in a route. Reads come from the table-wide SELECT.
--
-- One new role owns two definers, in the shape 0759 gave runner_mode_switch_definer (and 0771 widened):
--
--   work_item_placement_definer   NOLOGIN, no members, a member of nothing. Column grants for what the bodies read and write, a row
--                                 policy for this role only on each row-secured table it touches, a pinned search_path, EXECUTE for
--                                 app_user alone. platform_ops gains NOTHING (a test diffs its privileges against the migrations
--                                 without this file).
--
-- 1. work_item_cancel_pending_runs(p_item_id, p_leaving) moves the item's PENDING runs on the side being left ('cloud' = sandbox
--    runs, 'runner' = runs in either runner mode) to cancelled, by calling agent_run_set_status, and answers their ids. The web
--    tier writes each run's run.status_changed event with failureReason `placement_changed` (same split as 0759: the definer holds
--    no grant on run_events). Running runs are untouched. It re-derives every precondition:
--      * the caller is an owner or admin of an active account, read through a policy that shows the role only the caller's own row;
--      * the item is that account's (P0002 for another tenant's item and for an unknown one: the same answer);
--      * the item's effective side NOW (its placement, else the repo's mode) is not the side being left (55000), so the function is
--        not a bulk cancel for an item that still runs there. The caller changes the placement first, in the same transaction;
--      * the runs are locked first, through a policy that shows this role pending runs of this tenant only, and each move is the
--        compare-and-set writer, so a run that stopped being pending is not counted. Only this item's runs are ever selected.
--
-- 2. work_item_placement_audit(p_item_id, p_from, p_to, p_cancelled_runs) writes one audit_log row. The item's stored placement must
--    already be p_to (current truth, so a row cannot describe a change that did not happen), and a cancelled count is accepted only
--    for a change that moves the item's effective side.
--
-- Numbered above the highest migration on the code plane (0778). Re-check against main right before merging.

ALTER TABLE work_items ADD COLUMN placement text;
ALTER TABLE work_items ADD CONSTRAINT work_items_placement_check CHECK (placement IN ('cloud', 'runner'));

-- app_user holds a table-wide INSERT on work_items, which a column revoke cannot narrow, so an INSERT could still set the column.
-- A trigger refuses a non-NULL placement from anyone who is not a member of platform_ops (the 0003/0200/0656 form: pg_has_role on
-- current_user, so a login created IN ROLE app_user, which inherits the INSERT and the row policy, is refused too; a superuser
-- satisfies it, which covers the migrator). A new item starts as NULL (follow the repo).
CREATE FUNCTION work_items_placement_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.placement IS NOT NULL AND NOT pg_has_role(current_user, 'platform_ops', 'USAGE') THEN
    RAISE EXCEPTION 'work_items: placement is set by the placement definers, not on insert' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION work_items_placement_insert_guard() FROM PUBLIC;
CREATE TRIGGER work_items_placement_insert_guard BEFORE INSERT ON work_items FOR EACH ROW EXECUTE FUNCTION work_items_placement_insert_guard();

DO $$
DECLARE
  n text := 'work_item_placement_definer';
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

-- What the two bodies read and write, column by column. agent_runs: which runs of the item are pending and on which side (and updated_at,
-- the one column a row lock needs a privilege on). work_items: the item's id, tenant, repo and placement. repos: the repo's mode.
GRANT USAGE ON SCHEMA public TO work_item_placement_definer;
GRANT SELECT (id, account_id, status, execution_mode, work_item_id), UPDATE (updated_at) ON agent_runs TO work_item_placement_definer;
GRANT SELECT (id, account_id, repo_id, placement) ON work_items TO work_item_placement_definer;
GRANT SELECT (id, account_id, execution_mode) ON repos TO work_item_placement_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO work_item_placement_definer;
GRANT SELECT (id, deleted_at) ON accounts TO work_item_placement_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO work_item_placement_definer;

CREATE POLICY work_item_placement_definer_select ON agent_runs FOR SELECT TO work_item_placement_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_placement_definer_update ON agent_runs FOR UPDATE TO work_item_placement_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND status = 'pending')
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_placement_definer_select ON work_items FOR SELECT TO work_item_placement_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_placement_definer_select ON repos FOR SELECT TO work_item_placement_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_placement_definer_select ON account_members FOR SELECT TO work_item_placement_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY work_item_placement_definer_select ON accounts FOR SELECT TO work_item_placement_definer USING (true);
CREATE POLICY work_item_placement_definer_audit ON audit_log FOR INSERT TO work_item_placement_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'work_item.placement.changed');

-- ---- ownership brackets (as 0759) ---------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'work_item_placement_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on work_item_placement_definer; cannot ALTER FUNCTION ... OWNER TO work_item_placement_definer';
    END IF;
    GRANT work_item_placement_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO work_item_placement_definer;

CREATE FUNCTION work_item_cancel_pending_runs(p_item_id uuid, p_leaving text)
RETURNS TABLE (run_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr     uuid;
  v_role  text;
  v_repo  uuid;
  v_place text;
  v_mode  text;
  v_side  text;
  r       record;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'work_item_cancel_pending_runs: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'work_item_cancel_pending_runs: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_item_id IS NULL OR p_leaving IS NULL OR p_leaving NOT IN ('cloud', 'runner') THEN
    RAISE EXCEPTION 'work_item_cancel_pending_runs: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT w.repo_id, w.placement INTO v_repo, v_place FROM public.work_items w WHERE w.id = p_item_id AND w.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_item_cancel_pending_runs: no such item' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT g.execution_mode INTO v_mode FROM public.repos g WHERE g.id = v_repo AND g.account_id = acct;
  -- The side the item runs on now: its own placement, else what its repo says (no repo: the cloud).
  v_side := COALESCE(v_place, CASE WHEN v_mode IN ('runner_local', 'runner_verified') THEN 'runner' ELSE 'cloud' END);
  IF v_side = p_leaving THEN
    RAISE EXCEPTION 'work_item_cancel_pending_runs: the item still runs on that side' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- Lock first (the lock applies this role's UPDATE policy: pending runs of the tenant), then move each through the compare-and-set
  -- writer. Only this item's runs on the side being left are selected; a run that stopped being pending in between is not counted.
  FOR r IN
    SELECT a.id FROM public.agent_runs a
     WHERE a.account_id = acct AND a.work_item_id = p_item_id AND a.status = 'pending'
       AND CASE p_leaving WHEN 'runner' THEN a.execution_mode IN ('runner_local', 'runner_verified') ELSE a.execution_mode = 'sandbox' END
     ORDER BY a.id
       FOR UPDATE
  LOOP
    IF public.agent_run_set_status(acct, r.id, 'pending', 'cancelled', NULL, NULL, NULL, NULL, NULL, NULL) THEN
      run_id := r.id;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION work_item_placement_audit(p_item_id uuid, p_from text, p_to text, p_cancelled_runs integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct        uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr         uuid;
  v_role      text;
  v_repo      uuid;
  v_place     text;
  v_mode      text;
  v_repo_side text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'work_item_placement_audit: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'work_item_placement_audit: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_item_id IS NULL OR p_cancelled_runs IS NULL OR p_cancelled_runs < 0
     OR (p_from IS NOT NULL AND p_from NOT IN ('cloud', 'runner'))
     OR (p_to IS NOT NULL AND p_to NOT IN ('cloud', 'runner'))
     OR p_from IS NOT DISTINCT FROM p_to THEN
    RAISE EXCEPTION 'work_item_placement_audit: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT w.repo_id, w.placement INTO v_repo, v_place FROM public.work_items w WHERE w.id = p_item_id AND w.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_item_placement_audit: no such item' USING ERRCODE = 'no_data_found';
  END IF;
  -- The row describes a change that happened: the stored placement is the new one.
  IF v_place IS DISTINCT FROM p_to THEN
    RAISE EXCEPTION 'work_item_placement_audit: the item''s placement is not the one being recorded' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT g.execution_mode INTO v_mode FROM public.repos g WHERE g.id = v_repo AND g.account_id = acct;
  v_repo_side := CASE WHEN v_mode IN ('runner_local', 'runner_verified') THEN 'runner' ELSE 'cloud' END;
  -- Runs are cancelled only by a change that moves the item's effective side.
  IF p_cancelled_runs > 0 AND COALESCE(p_from, v_repo_side) = COALESCE(p_to, v_repo_side) THEN
    RAISE EXCEPTION 'work_item_placement_audit: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'work_item.placement.changed',
          jsonb_build_object('item_id', p_item_id, 'from', p_from, 'to', p_to, 'cancelled_runs', p_cancelled_runs),
          clock_timestamp());
END;
$$;

REVOKE ALL ON FUNCTION work_item_cancel_pending_runs(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work_item_placement_audit(uuid, text, text, integer) FROM PUBLIC;
ALTER FUNCTION work_item_cancel_pending_runs(uuid, text) OWNER TO work_item_placement_definer;
ALTER FUNCTION work_item_placement_audit(uuid, text, text, integer) OWNER TO work_item_placement_definer;
GRANT EXECUTE ON FUNCTION work_item_cancel_pending_runs(uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION work_item_placement_audit(uuid, text, text, integer) TO app_user;
GRANT EXECUTE ON FUNCTION agent_run_set_status(uuid, uuid, text, text, jsonb, bigint, bigint, numeric, text, integer) TO work_item_placement_definer;

REVOKE CREATE ON SCHEMA public FROM work_item_placement_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE work_item_placement_definer FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
