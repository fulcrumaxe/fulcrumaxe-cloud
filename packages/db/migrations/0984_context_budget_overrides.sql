-- D#600 CX-12: a context budget per role and per work item, written by one definer function.
-- context_budget_overrides holds one row per override; a missing row reads as "use the next level" (item, role, repository, role default), derived when a run
-- is assembled and never stamped. scope 'role': a role's budget in one repository (repo_id and role set). scope 'item': a budget for one work item that applies
-- to every role's runs on it (work_item_id set). Both are keyed to their repository or item with ON DELETE CASCADE, so an override goes with the item, with a
-- disconnected repository, and a repository added again starts with none. The roles are the closed list below; a stored role that is not on it is ignored by the reader.
-- The upper bound for each level (the role default times 2, the largest role default times 2) is the application's, because the defaults are provisional
-- and live in code; the table and the function hold only the absolute range 4096..2097152 (the repository budget's), and the reader clamps at use.
-- context_budget_override_apply(p_scope, p_repo, p_item, p_role, p_bytes) is the only writer, owned by repo_context_settings_definer (0796, 0974): an owner or admin
-- of the active account re-derived from the session, never a platform_ops login; NULL removes the override; an equal value writes nothing; one audit row
-- ('context_budget.changed', already on the allowlist) per real change with the ids, the role and the old and new size, nothing else.
-- run_context_inputs gains budget_source ('item', 'role' or 'repo'; NULL when the role default applied or the run predates it): which level the run's budget came from.
--
-- Numbered 0984: #720 holds 0983. Re-check against main's highest right before merging.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'repo_context_settings_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on repo_context_settings_definer; cannot create its function';
    END IF;
    GRANT repo_context_settings_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO repo_context_settings_definer;

CREATE TABLE context_budget_overrides (
  account_id   uuid NOT NULL,
  scope        text NOT NULL CHECK (scope IN ('role', 'item')),
  repo_id      uuid,
  work_item_id uuid,
  role         text,
  bytes        integer NOT NULL CHECK (bytes BETWEEN 4096 AND 2097152),
  updated_by   uuid NOT NULL REFERENCES users (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'role' AND repo_id IS NOT NULL AND work_item_id IS NULL AND role IN ('executor', 'fix', 'code-reviewer', 'acceptance-tester', 'security-reviewer', 'debater'))
      OR (scope = 'item' AND work_item_id IS NOT NULL AND repo_id IS NULL AND role IS NULL)),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX context_budget_overrides_role ON context_budget_overrides (account_id, repo_id, role) WHERE scope = 'role';
CREATE UNIQUE INDEX context_budget_overrides_item ON context_budget_overrides (account_id, work_item_id) WHERE scope = 'item';

ALTER TABLE context_budget_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_budget_overrides FORCE ROW LEVEL SECURITY;
GRANT SELECT (account_id, scope, repo_id, work_item_id, role, bytes, updated_at) ON context_budget_overrides TO app_user;
CREATE POLICY tenant_isolation_select ON context_budget_overrides FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

GRANT SELECT (account_id, scope, repo_id, work_item_id, role, bytes), INSERT (account_id, scope, repo_id, work_item_id, role, bytes, updated_by),
      UPDATE (bytes, updated_by, updated_at), DELETE ON context_budget_overrides TO repo_context_settings_definer;
GRANT SELECT (id, account_id) ON work_items TO repo_context_settings_definer;
CREATE POLICY repo_context_settings_definer_select ON context_budget_overrides FOR SELECT TO repo_context_settings_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY repo_context_settings_definer_insert ON context_budget_overrides FOR INSERT TO repo_context_settings_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY repo_context_settings_definer_update ON context_budget_overrides FOR UPDATE TO repo_context_settings_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY repo_context_settings_definer_delete ON context_budget_overrides FOR DELETE TO repo_context_settings_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY repo_context_settings_definer_select ON work_items FOR SELECT TO repo_context_settings_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

CREATE FUNCTION context_budget_override_apply(p_scope text, p_repo uuid, p_item uuid, p_role text, p_bytes integer)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  v_role text;
  v_old  integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'context_budget_override_apply: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'context_budget_override_apply: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('role', 'item')
     OR (p_scope = 'role' AND (p_repo IS NULL OR p_item IS NOT NULL OR p_role IS NULL OR p_role NOT IN ('executor', 'fix', 'code-reviewer', 'acceptance-tester', 'security-reviewer', 'debater')))
     OR (p_scope = 'item' AND (p_item IS NULL OR p_repo IS NOT NULL OR p_role IS NOT NULL))
     OR (p_bytes IS NOT NULL AND p_bytes NOT BETWEEN 4096 AND 2097152) THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_scope = 'role' THEN
    PERFORM 1 FROM public.repos r WHERE r.id = p_repo AND r.account_id = acct;
  ELSE
    PERFORM 1 FROM public.work_items w WHERE w.id = p_item AND w.account_id = acct;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'context_budget_override_apply: no such repository or item' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_scope = 'role' THEN
    SELECT o.bytes INTO v_old FROM public.context_budget_overrides o WHERE o.account_id = acct AND o.scope = 'role' AND o.repo_id = p_repo AND o.role = p_role FOR UPDATE;
  ELSE
    SELECT o.bytes INTO v_old FROM public.context_budget_overrides o WHERE o.account_id = acct AND o.scope = 'item' AND o.work_item_id = p_item FOR UPDATE;
  END IF;
  IF p_bytes IS NOT DISTINCT FROM v_old THEN
    RETURN;
  END IF;
  IF p_bytes IS NULL THEN
    IF p_scope = 'role' THEN
      DELETE FROM public.context_budget_overrides o WHERE o.account_id = acct AND o.scope = 'role' AND o.repo_id = p_repo AND o.role = p_role;
    ELSE
      DELETE FROM public.context_budget_overrides o WHERE o.account_id = acct AND o.scope = 'item' AND o.work_item_id = p_item;
    END IF;
  ELSIF p_scope = 'role' THEN
    INSERT INTO public.context_budget_overrides AS o (account_id, scope, repo_id, role, bytes, updated_by)
    VALUES (acct, 'role', p_repo, p_role, p_bytes, usr)
    ON CONFLICT (account_id, repo_id, role) WHERE scope = 'role' DO UPDATE SET bytes = EXCLUDED.bytes, updated_by = usr, updated_at = now();
  ELSE
    INSERT INTO public.context_budget_overrides AS o (account_id, scope, work_item_id, bytes, updated_by)
    VALUES (acct, 'item', p_item, p_bytes, usr)
    ON CONFLICT (account_id, work_item_id) WHERE scope = 'item' DO UPDATE SET bytes = EXCLUDED.bytes, updated_by = usr, updated_at = now();
  END IF;
  PERFORM public.audit_write('context_budget.changed', jsonb_build_object('scope', p_scope, 'repo_id', p_repo, 'work_item_id', p_item, 'role', p_role, 'from', v_old, 'to', p_bytes));
END;
$$;

REVOKE ALL ON FUNCTION context_budget_override_apply(text, uuid, uuid, text, integer) FROM PUBLIC;
ALTER FUNCTION context_budget_override_apply(text, uuid, uuid, text, integer) OWNER TO repo_context_settings_definer;
GRANT EXECUTE ON FUNCTION context_budget_override_apply(text, uuid, uuid, text, integer) TO app_user;

REVOKE CREATE ON SCHEMA public FROM repo_context_settings_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE repo_context_settings_definer FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

ALTER TABLE run_context_inputs ADD COLUMN budget_source text CHECK (budget_source IN ('item', 'role', 'repo'));
GRANT SELECT (budget_source), INSERT (budget_source) ON run_context_inputs TO app_user;
