-- D#483 S4-e2: the proposal follows its root.
--
-- Triage of an approved item creates a root work item and retires the approved one as `superseded:<root>`. The proposal's
-- `work_item_id` kept pointing at the retired item, so the Inbox (which reads the stage of the item behind the link) showed a
-- closed item for the whole life of the work, and a root that had no issue number could not find its proposal.
--
-- Expand-only: one new role, one new function, the grants and row policies the function's body needs. No existing object changes
-- and no column is added; the link stays the single column proposals.work_item_id.
--
-- proposal_follow_root(p_proposal_id, p_old_work_item_id, p_root_work_item_id) is the only writer of that repoint. In one call
-- it refuses unless every one of these holds (each is checked inside the function, in the caller's tenant):
--   * the proposal is `approved`, and its work_item_id is the old id (or is already the root: a no-op replay returns false);
--   * the old item is `closed` and carries a stage transition to `closed` whose source ref is exactly `superseded:<root>`;
--   * the root is visible in the same account and has the same repo as the old item and the proposal.
-- It then sets work_item_id and updated_at on that row and nothing else. The role holds UPDATE on those two columns only, so
-- state, provenance, owner_process and roadmap_position cannot change through it whatever the body says. The unique index
-- proposals_work_item_once is untouched: the repoint is one UPDATE, so it is never violated by the move itself.
--
-- Privileges. A NEW role, proposal_follower (NOLOGIN, no members, a member of nothing), owns the function. platform_ops gains
-- nothing. EXECUTE goes to agent_run_writer alone: that is the role of the stage driver's runner login (the only login in both
-- app_user and agent_run_writer), and no API route connection (app_user) can call it. The role holds exactly what the body
-- reads and writes, column by column, each with a tenant-bound row policy of its own.
--
-- Error contract (fixed messages, no argument value in any): 22023 invalid arguments; 42501 not permitted (no tenant, an inactive
-- account, a platform_ops login); 55000 `not_approved`, `not_current_link`, `old_not_superseded`, `root_mismatch`; P0002 proposal
-- not found.
-- Numbered 0843 (reserved for S4-e2). Re-check against main right before merging.

DO $$
DECLARE
  n text := 'proposal_follower';
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

GRANT USAGE ON SCHEMA public TO proposal_follower;
GRANT SELECT (id, account_id, repo_id, state, work_item_id) ON proposals TO proposal_follower;
GRANT UPDATE (work_item_id, updated_at) ON proposals TO proposal_follower;
GRANT SELECT (id, account_id, repo_id, stage) ON work_items TO proposal_follower;
GRANT SELECT (account_id, work_item_id, to_stage, source_ref) ON work_item_transitions TO proposal_follower;
-- account_is_active() is a SECURITY INVOKER function, so the role must be able to read the one account in context.
GRANT SELECT (id, deleted_at) ON accounts TO proposal_follower;
CREATE POLICY proposal_follower_select ON accounts FOR SELECT TO proposal_follower
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);

CREATE POLICY proposal_follower_select ON proposals FOR SELECT TO proposal_follower
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY proposal_follower_update ON proposals FOR UPDATE TO proposal_follower
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY proposal_follower_select ON work_items FOR SELECT TO proposal_follower
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY proposal_follower_select ON work_item_transitions FOR SELECT TO proposal_follower
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

CREATE FUNCTION proposal_follow_root(p_proposal_id uuid, p_old_work_item_id uuid, p_root_work_item_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  p        record;
  old_repo uuid;
  old_stage text;
  root_repo uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'proposal_follow_root: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'proposal_follow_root: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_proposal_id IS NULL OR p_old_work_item_id IS NULL OR p_root_work_item_id IS NULL OR p_old_work_item_id = p_root_work_item_id THEN
    RAISE EXCEPTION 'proposal_follow_root: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT x.id, x.state, x.work_item_id, x.repo_id INTO p
    FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proposal_follow_root: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p.state <> 'approved' THEN
    RAISE EXCEPTION 'not_approved' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- A replay after the move: the link is already the root. Nothing is written.
  IF p.work_item_id = p_root_work_item_id THEN
    RETURN false;
  END IF;
  IF p.work_item_id IS DISTINCT FROM p_old_work_item_id THEN
    RAISE EXCEPTION 'not_current_link' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT w.stage, w.repo_id INTO old_stage, old_repo FROM public.work_items w WHERE w.id = p_old_work_item_id AND w.account_id = acct;
  IF NOT FOUND OR old_stage <> 'closed'
     OR NOT EXISTS (SELECT 1 FROM public.work_item_transitions t
                     WHERE t.account_id = acct AND t.work_item_id = p_old_work_item_id AND t.to_stage = 'closed'
                       AND t.source_ref = 'superseded:' || p_root_work_item_id::text) THEN
    RAISE EXCEPTION 'old_not_superseded' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- The row policy shows this role only the caller's own account, so a root in another account is simply not found.
  SELECT w.repo_id INTO root_repo FROM public.work_items w WHERE w.id = p_root_work_item_id AND w.account_id = acct;
  IF NOT FOUND OR root_repo IS NULL OR root_repo IS DISTINCT FROM old_repo OR root_repo IS DISTINCT FROM p.repo_id THEN
    RAISE EXCEPTION 'root_mismatch' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE public.proposals SET work_item_id = p_root_work_item_id, updated_at = now()
   WHERE id = p_proposal_id AND account_id = acct;
  RETURN true;
END $$;

-- Ownership bracket (0792's shape): the migration role holds the new role only to hand the function over; both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'proposal_follower'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on proposal_follower; cannot ALTER FUNCTION ... OWNER TO proposal_follower';
    END IF;
    GRANT proposal_follower TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO proposal_follower;

REVOKE ALL ON FUNCTION proposal_follow_root(uuid, uuid, uuid) FROM PUBLIC;
ALTER FUNCTION proposal_follow_root(uuid, uuid, uuid) OWNER TO proposal_follower;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION proposal_follow_root(uuid, uuid, uuid) TO agent_run_writer;

REVOKE CREATE ON SCHEMA public FROM proposal_follower;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE proposal_follower FROM CURRENT_USER;
  END IF;
END
$$;
