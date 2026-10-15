-- D#601 MEM-3: what the retriever needs from the database. Two additions, both expand-only (nothing is dropped, renamed or made NOT NULL).
--
--   repos.gh_node_id        the GitHub node id of the repository. A repo's memory is keyed on '<node id>@<installation id>' (0793's scope_ref), and
--                           nothing in the schema stored the node id, so the retriever could not name a repo's memory. Nullable: a repo without it
--                           has no repo-scope memory recalled (it never falls back to another key). This file adds the column; a writer that fills
--                           it from the GitHub API is a later change.
--   memory_mark_recalled    stamps `last_recalled_at` on approved entries a run has just been given. The retirement sweep of an unused entry (90 days)
--                           reads that stamp. One NOLOGIN role of its own, memory_recall_definer, holds UPDATE on that one column and nothing else on
--                           the table; EXECUTE is for app_user alone. It is refused for a platform_ops login, for a session with no active account,
--                           and for a session with a USER in it: recall is the pipeline's driver action, so a person's click cannot keep an entry
--                           alive. It only touches `approved` rows of the session's own account, 500 ids at most, and it writes no audit row (it
--                           would be one per run per entry; the entry's history is the permanent record of changes, not of reads).
--
-- Numbered 0806 (reserved for MEM-3); re-check against main's highest right before merging. Role created in this file in the shape of 0793:
-- NOLOGIN, no members, a pinned search_path, column grants for exactly what the body reads and writes, row policies for this role only.
DO $$
DECLARE
  n text := 'memory_recall_definer';
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

ALTER TABLE repos ADD COLUMN gh_node_id text;
ALTER TABLE repos ADD CONSTRAINT repos_gh_node_id_check CHECK (gh_node_id IS NULL OR gh_node_id ~ '^[A-Za-z0-9_=-]{4,100}$');

GRANT USAGE ON SCHEMA public TO memory_recall_definer;
GRANT SELECT (id, account_id, status) ON memory_entries TO memory_recall_definer;
GRANT UPDATE (last_recalled_at) ON memory_entries TO memory_recall_definer;
GRANT SELECT (id, deleted_at) ON accounts TO memory_recall_definer;

CREATE POLICY memory_recall_definer_select ON memory_entries FOR SELECT TO memory_recall_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY memory_recall_definer_update ON memory_entries FOR UPDATE TO memory_recall_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND status = 'approved')
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND status = 'approved');
CREATE POLICY memory_recall_definer_select ON accounts FOR SELECT TO memory_recall_definer USING (true);

-- Ownership bracket (0763's shape, as in 0793): the migrator needs SET on the role for ALTER ... OWNER TO, and the role has CREATE on public
-- only for that transfer. Both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'memory_recall_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on memory_recall_definer; cannot ALTER FUNCTION ... OWNER TO memory_recall_definer';
    END IF;
    GRANT memory_recall_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO memory_recall_definer;

CREATE FUNCTION memory_mark_recalled(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  a uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  u uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  n integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'memory_mark_recalled: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF a IS NULL OR NOT public.account_is_active(a) THEN
    RAISE EXCEPTION 'memory_mark_recalled: no active account in the session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF u IS NOT NULL THEN
    RAISE EXCEPTION 'memory_mark_recalled: a recall is a pipeline action, not a person''s' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'invalid_message: at most 500 ids' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.memory_entries e SET last_recalled_at = clock_timestamp()
   WHERE e.account_id = a AND e.id = ANY (p_ids) AND e.status = 'approved';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION memory_mark_recalled(uuid[]) FROM PUBLIC;
ALTER FUNCTION memory_mark_recalled(uuid[]) OWNER TO memory_recall_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner), to app_user alone.
GRANT EXECUTE ON FUNCTION memory_mark_recalled(uuid[]) TO app_user;
REVOKE CREATE ON SCHEMA public FROM memory_recall_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE memory_recall_definer FROM CURRENT_USER;
  END IF;
END
$$;
