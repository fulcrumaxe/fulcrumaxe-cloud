-- D#483 S3-L2a: removing an imported plan, and the start rule's read of the proposal behind a work item.
--
-- Two additions, both expand-only (no existing object changes):
--
-- 1. remove_repo_plan(repo_id): "Remove imported plan" (DELETE /repos/{id}/plan). plan_importer has no DELETE (0723), so the
--    removal is a SECURITY DEFINER function.
--      * Session only, owner or admin of an active account. A token is refused, as it is for starting an import.
--      * It removes the repo's plan_tasks, plan_milestones and plan_imports rows, and the proposals that are still `new` or
--        `withdrawn`. Approved and rejected proposals are decisions and are kept; the foreign keys of 0723 null their
--        plan_task_id and last_import_id (a kept proposal then simply shows no task and no import).
--      * One import runs at a time per repo, and so does a removal: it takes the lock plan_import_begin takes. A queued or
--        running import younger than 10 minutes refuses it with `import_running`; an older one is closed as `interrupted`
--        first (the same rule as the start), so a dead import never blocks a removal.
--    Privileges: a NEW role, plan_remover (NOLOGIN, no members, a member of nothing), owns the function. platform_ops gains
--    NOTHING (the 0781-style "gives platform_ops nothing" snapshots stay true). plan_remover holds exactly what the body
--    reads and deletes, each column or table named below, with a tenant-bound row policy of its own on every table it touches:
--      accounts(id, deleted_at) SELECT, account_members(account_id, user_id, role) SELECT (only the caller's own row),
--      repos(id, account_id) SELECT, plan_imports(id, account_id, repo_id, state, started_at, created_at) SELECT + UPDATE(state,
--      error_code, finished_at) + DELETE, plan_milestones/plan_tasks (account_id, repo_id) SELECT + DELETE, proposals(account_id,
--      repo_id, state) SELECT + DELETE, audit_log INSERT of `plan.removed`, USAGE on public.
--    It writes one audit row, `plan.removed`, with what it removed: the role holds INSERT on the five audit_log columns the
--    row uses (the precedent of 0790), and a policy that lets it insert only its own action name for the account in context.
--    A BEFORE DELETE guard on proposals, owned by the migration role, refuses plan_remover a delete of an approved or rejected
--    row even if a later edit of the function got its WHERE wrong. EXECUTE goes to app_user only.
--
-- 2. The runner login reads which proposal stands behind a work item. The stage driver's advance_work_item performer must
--    refuse a work item whose proposal is owned by the internal loop (E8), and it runs as a member of agent_run_writer. That
--    role gets three columns of proposals (account_id, work_item_id, owner_process) and a row policy for its own tenant.
--
-- Error contract of the new function (the API maps these): 55000 `import_running`; P0002 repo not found; 42501 not a session
-- owner or admin.
-- Numbered above the highest migration claimed (0831 is the paired-push record). Re-check against main right before merging.

DO $$
DECLARE
  n text := 'plan_remover';
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

-- ---------------------------------------------------------------------
-- 1. Grants and policies.
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO plan_remover;
GRANT SELECT (id, deleted_at) ON accounts TO plan_remover;
GRANT SELECT (account_id, user_id, role) ON account_members TO plan_remover;
GRANT SELECT (id, account_id) ON repos TO plan_remover;
GRANT SELECT (id, account_id, repo_id, state, started_at, created_at) ON plan_imports TO plan_remover;
GRANT UPDATE (state, error_code, finished_at) ON plan_imports TO plan_remover;
GRANT SELECT (account_id, repo_id) ON plan_milestones TO plan_remover;
GRANT SELECT (account_id, repo_id) ON plan_tasks TO plan_remover;
GRANT SELECT (account_id, repo_id, state) ON proposals TO plan_remover;
GRANT DELETE ON plan_imports, plan_milestones, plan_tasks, proposals TO plan_remover;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO plan_remover;
CREATE POLICY plan_remover_audit ON audit_log FOR INSERT TO plan_remover
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'plan.removed');

CREATE POLICY plan_remover_select ON accounts FOR SELECT TO plan_remover
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY plan_remover_definer_select ON account_members FOR SELECT TO plan_remover
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY plan_remover_select ON repos FOR SELECT TO plan_remover
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY plan_remover_select ON plan_imports FOR SELECT TO plan_remover
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY plan_remover_update ON plan_imports FOR UPDATE TO plan_remover
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY plan_remover_delete ON plan_imports FOR DELETE TO plan_remover
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY plan_remover_select ON plan_milestones FOR SELECT TO plan_remover
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY plan_remover_delete ON plan_milestones FOR DELETE TO plan_remover
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY plan_remover_select ON plan_tasks FOR SELECT TO plan_remover
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY plan_remover_delete ON plan_tasks FOR DELETE TO plan_remover
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY plan_remover_select ON proposals FOR SELECT TO plan_remover
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY plan_remover_delete ON proposals FOR DELETE TO plan_remover
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- Owned by the migration role, never plan_remover: plan_remover may delete only a proposal nobody decided.
CREATE FUNCTION proposals_delete_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'plan_remover' AND OLD.state NOT IN ('new', 'withdrawn') THEN
    RAISE EXCEPTION 'proposals: a decided proposal (%) is never deleted by the plan removal', OLD.state USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER proposals_delete_guard BEFORE DELETE ON proposals FOR EACH ROW EXECUTE FUNCTION proposals_delete_guard();

-- ---------------------------------------------------------------------
-- 2. The definer.
-- ---------------------------------------------------------------------
CREATE FUNCTION remove_repo_plan(p_repo_id uuid)
RETURNS TABLE (proposals_removed integer, tasks_removed integer, milestones_removed integer, imports_removed integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_role text;
  n_p  integer;
  n_t  integer;
  n_m  integer;
  n_i  integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'remove_repo_plan: platform_ops may not call this directly' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A member session of an active account: the policies show plan_remover only the caller's own membership row and the
  -- account in context, so a user who is not a member of it (or no user at all) finds no role.
  IF acct IS NULL OR usr IS NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = acct AND a.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'remove_repo_plan: a member session of an active account is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.role INTO v_role FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr;
  IF COALESCE(v_role, '') NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'remove_repo_plan: owner or admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL THEN
    RAISE EXCEPTION 'remove_repo_plan: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.repos r WHERE r.id = p_repo_id AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remove_repo_plan: repo not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- The same lock as plan_import_begin, so a start and a removal cannot interleave.
  PERFORM pg_advisory_xact_lock(hashtextextended('plan_import_begin:' || p_repo_id::text, 0));
  UPDATE public.plan_imports SET state = 'failed', error_code = 'interrupted', finished_at = now()
   WHERE repo_id = p_repo_id AND account_id = acct AND state IN ('queued', 'running')
     AND COALESCE(started_at, created_at) < now() - interval '10 minutes';
  IF EXISTS (SELECT 1 FROM public.plan_imports x WHERE x.repo_id = p_repo_id AND x.account_id = acct AND x.state IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'import_running' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  DELETE FROM public.proposals x WHERE x.repo_id = p_repo_id AND x.account_id = acct AND x.state IN ('new', 'withdrawn');
  GET DIAGNOSTICS n_p = ROW_COUNT;
  DELETE FROM public.plan_tasks x WHERE x.repo_id = p_repo_id AND x.account_id = acct;
  GET DIAGNOSTICS n_t = ROW_COUNT;
  DELETE FROM public.plan_milestones x WHERE x.repo_id = p_repo_id AND x.account_id = acct;
  GET DIAGNOSTICS n_m = ROW_COUNT;
  DELETE FROM public.plan_imports x WHERE x.repo_id = p_repo_id AND x.account_id = acct;
  GET DIAGNOSTICS n_i = ROW_COUNT;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'plan.removed',
          jsonb_build_object('repo_id', p_repo_id, 'proposals', n_p, 'tasks', n_t, 'milestones', n_m, 'imports', n_i), clock_timestamp());
  RETURN QUERY SELECT n_p, n_t, n_m, n_i;
END $$;

-- Ownership bracket (0828's shape).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'plan_remover'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on plan_remover; cannot ALTER FUNCTION ... OWNER TO plan_remover';
    END IF;
    GRANT plan_remover TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO plan_remover;

REVOKE ALL ON FUNCTION remove_repo_plan(uuid) FROM PUBLIC;
ALTER FUNCTION remove_repo_plan(uuid) OWNER TO plan_remover;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION remove_repo_plan(uuid) TO app_user;

REVOKE CREATE ON SCHEMA public FROM plan_remover;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE plan_remover FROM CURRENT_USER;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 3. E8: the runner login reads which proposal stands behind a work item.
-- ---------------------------------------------------------------------
GRANT SELECT (account_id, work_item_id, owner_process) ON proposals TO agent_run_writer;
CREATE POLICY runner_tenant_read ON proposals FOR SELECT TO agent_run_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
