-- D#483: a maintainer's `fulcrumaxe:product` label on an issue hands that issue to the product, and removing it hands it back.
--
-- The owner of a proposal was fixed when its row was created: the import role may not change it (0753, 0918) and no other role holds an
-- UPDATE grant on the column, so a label applied after the proposal existed (the usual order) could never move it. One definer,
-- proposal_owner_from_label, now writes owner_process after creation, owned by its own NOLOGIN role (proposal_owner_definer) with exactly the
-- columns it reads and writes. It moves ONE proposal, only when it belongs to a GitHub issue of the caller's tenant and repository, is still
-- `new`, has no work item (and no work item carries the issue's number), and the owner really changes (a replay writes nothing). The CALLER
-- establishes that whoever applied the label holds maintain or admin; the definer accepts only those two values and records the one it was
-- given. It needs a tenant session of an active account (no token principal, no platform_ops login). It never touches verification: the caller
-- re-queues the check (0904, 0918) after a move to product. Each move writes an audit row (proposal.owner_changed, actor policy:product_label)
-- with ids, both owners and the permission; no issue text, no login. Expand-only: a new role, function and policies. Ownership bracket as in 0986.

DO $$
DECLARE
  n text := 'proposal_owner_definer';
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

GRANT USAGE ON SCHEMA public TO proposal_owner_definer;
GRANT SELECT (id, deleted_at) ON accounts TO proposal_owner_definer;
GRANT SELECT (id, account_id, repo_id, dedupe_key, sources, state, owner_process, work_item_id),
      UPDATE (owner_process, updated_at) ON proposals TO proposal_owner_definer;
GRANT SELECT (account_id, repo_id, gh_number) ON work_items TO proposal_owner_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO proposal_owner_definer;
-- Every role that writes a proposal evaluates the 0950 row check and its title index for that write (0950 gives them EXECUTE and PUBLIC none).
GRANT EXECUTE ON FUNCTION proposal_analysis_refs_ok(text[]) TO proposal_owner_definer;
GRANT EXECUTE ON FUNCTION proposal_title_norm(text) TO proposal_owner_definer;

-- Every policy is bound to the caller's tenant; an inactive account writes nothing.
CREATE POLICY proposal_owner_definer_select ON accounts FOR SELECT TO proposal_owner_definer USING (true);
CREATE POLICY proposal_owner_definer_select ON proposals FOR SELECT TO proposal_owner_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY proposal_owner_definer_update ON proposals FOR UPDATE TO proposal_owner_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state = 'new' AND work_item_id IS NULL)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state = 'new' AND work_item_id IS NULL
              AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY proposal_owner_definer_select ON work_items FOR SELECT TO proposal_owner_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY proposal_owner_definer_audit ON audit_log FOR INSERT TO proposal_owner_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND actor = 'policy:product_label' AND action = 'proposal.owner_changed');

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'proposal_owner_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on proposal_owner_definer; cannot ALTER FUNCTION ... OWNER TO proposal_owner_definer';
    END IF;
    GRANT proposal_owner_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO proposal_owner_definer;

-- Answers the proposal's id when its owner moved, NULL when nothing changed (no such proposal, not `new`, has a work item, already
-- owned by p_to). Refusals: 42501 not permitted, 22023 invalid argument.
CREATE FUNCTION proposal_owner_from_label(p_repo_id uuid, p_gh_number integer, p_to text, p_permission text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  p    record;
  n    integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'proposal_owner_from_label: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'proposal_owner_from_label: a tenant session of an active account is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL OR p_gh_number IS NULL OR p_gh_number < 1 OR p_to NOT IN ('product', 'internal_loop') OR p_permission NOT IN ('maintain', 'admin') THEN
    RAISE EXCEPTION 'proposal_owner_from_label: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.id, x.state, x.owner_process, x.work_item_id INTO p
    FROM public.proposals x
   WHERE x.account_id = acct AND x.repo_id = p_repo_id AND x.dedupe_key = 'gh:issue:' || p_gh_number AND 'github_issue' = ANY (x.sources)
     FOR UPDATE;
  IF NOT FOUND OR p.state <> 'new' OR p.work_item_id IS NOT NULL OR p.owner_process = p_to THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.work_items w WHERE w.account_id = acct AND w.repo_id = p_repo_id AND w.gh_number = p_gh_number) THEN
    RETURN NULL;
  END IF;
  UPDATE public.proposals SET owner_process = p_to, updated_at = now() WHERE id = p.id AND account_id = acct;
  -- The row policy above is a second guard on state and work item; a write it filtered out is not a move and is not audited.
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'policy:product_label', 'proposal.owner_changed',
          jsonb_build_object('proposal_id', p.id, 'repo_id', p_repo_id, 'gh_number', p_gh_number, 'from', p.owner_process, 'to', p_to, 'permission', p_permission),
          clock_timestamp());
  RETURN p.id;
END $$;

REVOKE ALL ON FUNCTION proposal_owner_from_label(uuid, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION proposal_owner_from_label(uuid, integer, text, text) TO app_user;
ALTER FUNCTION proposal_owner_from_label(uuid, integer, text, text) OWNER TO proposal_owner_definer;

REVOKE CREATE ON SCHEMA public FROM proposal_owner_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE proposal_owner_definer FROM CURRENT_USER;
  END IF;
END
$$;
