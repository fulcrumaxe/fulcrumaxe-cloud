-- D#600 CX-5a: pins and excludes, the rules store. A rule keeps a repository-relative path in or out of a run's context; the sandbox (CX-5b) and the
-- runner daemon (CX-5c) enforce what this table says. This migration holds the store, its one writer and the read path, and nothing else.
--
-- 1. context_rules: one row per rule.
--      scope        'repo' (repo_id set) or 'item' (work_item_id set); a CHECK ties the two together
--      kind         'pin' (always in the prompt, never cut) or 'exclude' (denied to the agent's Read, Grep and Glob)
--      path         a repository-relative path; an exclude may also be a glob, a pin is an exact path (the definer refuses a glob in a pin)
--    An item rule overrides a repo rule for the same path; that is worked out when the rules are read, never stored, so removing the item rule
--    falls back to the repo rule with no other change. At most one rule per path in a scope (saving the other kind for the same path replaces it).
--    Keyed to the repository row and to the work item row (ON DELETE CASCADE both): rules go with the item, with a disconnected repository, and a
--    repository removed and added again starts with none. Nothing about the default is stamped.
--    Row security is forced and tenant scoped. app_user reads its own account's rows and can write nothing; the only writers are the two
--    functions below. platform_ops gains nothing.
--
-- 2. context_rule_save(p_scope, p_repo, p_item, p_kind, p_path) returns the rule's id, and context_rule_remove(p_id). Both are owned by
--    context_rules_definer (NOLOGIN, a member of nothing, column grants for exactly what the bodies read and write, a pinned search_path).
--    The caller's membership and role are re-derived from the session (app.account_id, app.user_id) on every call: repo scope needs an owner or
--    admin of the active account, item scope any member of it (there is no item membership table, so "item members" are the account's members);
--    otherwise 'insufficient_privilege' (42501). A repository or item outside the caller's account answers 'no_data_found' (P0002), so another
--    account's rows cannot be told from rows that do not exist. A path that is empty, longer than 512 characters, absolute (leading slash, a drive
--    letter, or ~), holds a control character or a backslash, or has an empty, '.' or '..' segment, and a pin whose path holds a wildcard (* or ?)
--    is refused with the fixed message 'invalid_path' (22023) and nothing is written. A bad scope, kind or target is 'invalid_message'
--    (22023). Messages are fixed and never carry an argument value.
--    EXECUTE goes to app_user alone. The pins-over-budget check needs GitHub, which a function cannot call, so it is made by the application
--    (packages/pipeline contextRules.ts) in the same transaction as the save and rolls it back.
--
-- Numbered 0871 (reserved for this PR; main's highest is 0870). Re-check against main's highest right before merging: migrations merge in number order.

DO $$
DECLARE
  n text := 'context_rules_definer';
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

CREATE TABLE context_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL,
  scope        text NOT NULL CHECK (scope IN ('repo', 'item')),
  repo_id      uuid,
  work_item_id uuid,
  kind         text NOT NULL CHECK (kind IN ('pin', 'exclude')),
  path         text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 512),
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'repo' AND repo_id IS NOT NULL AND work_item_id IS NULL) OR (scope = 'item' AND work_item_id IS NOT NULL AND repo_id IS NULL)),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX context_rules_repo_path ON context_rules (account_id, repo_id, path) WHERE scope = 'repo';
CREATE UNIQUE INDEX context_rules_item_path ON context_rules (account_id, work_item_id, path) WHERE scope = 'item';

ALTER TABLE context_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_rules FORCE ROW LEVEL SECURITY;

-- Readers: the account's own members. They can write nothing.
GRANT SELECT (id, account_id, scope, repo_id, work_item_id, kind, path, created_by, created_at) ON context_rules TO app_user;
CREATE POLICY tenant_isolation_select ON context_rules FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

-- The definer role: what the bodies read and write, column by column.
GRANT USAGE ON SCHEMA public TO context_rules_definer;
GRANT SELECT (id, account_id, scope, repo_id, work_item_id, kind, path), INSERT (account_id, scope, repo_id, work_item_id, kind, path, created_by),
      UPDATE (kind, created_by, created_at), DELETE ON context_rules TO context_rules_definer;
GRANT SELECT (id, account_id) ON repos TO context_rules_definer;
GRANT SELECT (id, account_id) ON work_items TO context_rules_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO context_rules_definer;
GRANT SELECT (id, deleted_at) ON accounts TO context_rules_definer;

CREATE POLICY context_rules_definer_select ON context_rules FOR SELECT TO context_rules_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY context_rules_definer_insert ON context_rules FOR INSERT TO context_rules_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY context_rules_definer_update ON context_rules FOR UPDATE TO context_rules_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY context_rules_definer_delete ON context_rules FOR DELETE TO context_rules_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY context_rules_definer_select ON repos FOR SELECT TO context_rules_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY context_rules_definer_select ON work_items FOR SELECT TO context_rules_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- Shows this role only the caller's own membership row, as 0757 and 0783 do.
CREATE POLICY context_rules_definer_select ON account_members FOR SELECT TO context_rules_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY context_rules_definer_select ON accounts FOR SELECT TO context_rules_definer USING (true);

-- Ownership bracket (0796's shape): the migration role holds the role only to hand the functions over, and the role has CREATE on public only for
-- that transfer; both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'context_rules_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on context_rules_definer; cannot ALTER FUNCTION ... OWNER TO context_rules_definer';
    END IF;
    GRANT context_rules_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO context_rules_definer;

CREATE FUNCTION context_rule_save(p_scope text, p_repo uuid, p_item uuid, p_kind text, p_path text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  v_role text;
  v_id   uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'context_rule_save: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The caller's own membership row (the policy shows this role no other); the role is re-derived on every call, never taken from the request.
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL
     OR (p_scope = 'repo' AND v_role NOT IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'context_rule_save: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('repo', 'item') OR p_kind IS NULL OR p_kind NOT IN ('pin', 'exclude')
     OR (p_scope = 'repo' AND (p_repo IS NULL OR p_item IS NOT NULL))
     OR (p_scope = 'item' AND (p_item IS NULL OR p_repo IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_path IS NULL OR p_path = '' OR char_length(p_path) > 512
     OR p_path ~ '[[:cntrl:]]' OR p_path ~ ('[' || chr(133) || chr(8232) || chr(8233) || ']') OR strpos(p_path, chr(92)) > 0
     OR p_path ~ '^/' OR p_path ~ '^~(/|$)' OR p_path ~ '^[A-Za-z]:/'
     OR p_path ~ '(^|/)(\.|\.\.)?(/|$)'
     OR (p_kind = 'pin' AND p_path ~ '[*?]') THEN
    RAISE EXCEPTION 'invalid_path' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_scope = 'repo' THEN
    PERFORM 1 FROM public.repos r WHERE r.id = p_repo AND r.account_id = acct;
  ELSE
    PERFORM 1 FROM public.work_items w WHERE w.id = p_item AND w.account_id = acct;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'context_rule_save: no such repository or item' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_scope = 'repo' THEN
    INSERT INTO public.context_rules AS c (account_id, scope, repo_id, kind, path, created_by)
    VALUES (acct, 'repo', p_repo, p_kind, p_path, usr)
    ON CONFLICT (account_id, repo_id, path) WHERE scope = 'repo'
    DO UPDATE SET kind = EXCLUDED.kind, created_by = usr, created_at = now()
    RETURNING c.id INTO v_id;
  ELSE
    INSERT INTO public.context_rules AS c (account_id, scope, work_item_id, kind, path, created_by)
    VALUES (acct, 'item', p_item, p_kind, p_path, usr)
    ON CONFLICT (account_id, work_item_id, path) WHERE scope = 'item'
    DO UPDATE SET kind = EXCLUDED.kind, created_by = usr, created_at = now()
    RETURNING c.id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

CREATE FUNCTION context_rule_remove(p_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr     uuid;
  v_role  text;
  v_scope text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'context_rule_remove: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'context_rule_remove: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT c.scope INTO v_scope FROM public.context_rules c WHERE c.id = p_id AND c.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'context_rule_remove: no such rule' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_scope = 'repo' AND v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'context_rule_remove: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.context_rules c WHERE c.id = p_id AND c.account_id = acct;
END;
$$;

REVOKE ALL ON FUNCTION context_rule_save(text, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION context_rule_remove(uuid) FROM PUBLIC;
ALTER FUNCTION context_rule_save(text, uuid, uuid, text, text) OWNER TO context_rules_definer;
ALTER FUNCTION context_rule_remove(uuid) OWNER TO context_rules_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION context_rule_save(text, uuid, uuid, text, text) TO app_user;
GRANT EXECUTE ON FUNCTION context_rule_remove(uuid) TO app_user;

REVOKE CREATE ON SCHEMA public FROM context_rules_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE context_rules_definer FROM CURRENT_USER;
  END IF;
END
$$;
