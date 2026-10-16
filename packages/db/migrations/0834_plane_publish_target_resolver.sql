-- D#598 P1f-4a (Correction C5, R-598-P1f-5): the gh-proxy can ask which paired PUBLIC repo and branch a sandbox's publish run may name, from our rows only.
--
-- Why: the proxy decides from resolve_sandbox_run, which answers the run's private dispatch repo and never reads plane_pushes. The proxy's database login
-- (run_binding_resolver) holds no table or column grant, and two pinned tests assert that. So a `plane_publish` run, which reads the private repo and writes
-- the paired public repo, has no way to be told which public repo and branch are its own. Granting the group SELECT on the new tables would break the
-- "reads nothing" guarantee, and putting the answer into resolve_sandbox_run would touch a function whose signature and grants earlier migrations and tests
-- pin. A new definer is the shape 0765 and 0828 already use for this.
--
-- What: resolve_plane_publish_target(p_sandbox_name) answers exactly one row of (code_repo, branch), or no row at all (fail closed, no detail). Its only
-- input is the sandbox name taken from the verified OIDC claim. The name is an opaque key compared for equality with agent_runs.sandbox_name: nothing
-- parses it, nothing is derived from its text, and nothing an agent wrote reaches the function. A row comes back only when all of these hold:
--   1. exactly one LIVE agent_runs row (pending, running, paused) carries the name (the rule 0707 uses; an ended run neither resolves nor counts);
--   2. that run's role is plane_publish;
--   3. one plane_push_attempts row has run_id equal to that run and finished_at null (a finished attempt stops resolving at once);
--   4. its plane_pushes row has the same account, the same work item as the run, and repo_id equal to the run's dispatch_repo_id;
--   5. that plane_pushes row has managed_by_person_at null;
--   6. exactly one row matches 1-5 (a run with two unfinished attempts on two pushes resolves to nothing).
--
-- Privileges: a NEW role, plane_publish_definer (NOLOGIN, no members, a member of nothing; the shape 0828 gave runner_bound_definer), owns the function.
-- It holds column SELECT on exactly what the body reads, and a row policy of its own on each of the three tables:
--   agent_runs          id, account_id, work_item_id, role, status, sandbox_name, dispatch_repo_id
--   plane_push_attempts account_id, plane_push_id, run_id, finished_at
--   plane_pushes        id, account_id, work_item_id, repo_id, code_repo, branch, managed_by_person_at
-- plane_push_id is on the attempts list because the join from an attempt to its push cannot be written without reading it. EXECUTE goes to
-- run_binding_resolver and nobody else, the membership the proxy login already holds. platform_ops gains NOTHING: no new privilege and no new policy for it;
-- the function refuses a platform_ops login like its siblings. It writes nothing and uses no clock. 0831 is not edited and still grants the proxy group nothing.
--
-- Rollback (docs/ops/runbooks/rollback.md, expand/contract): additive only (a role, a function, grants, policies). If this deploy is reverted the proxy
-- stops calling the function and publish runs deny. Nothing is rewritten, dropped or made NOT NULL.
--
-- Numbered above the highest migration on the code plane and above the numbers 0832 and 0833 held for other work. Re-check against main right before
-- merging and renumber to stay above it.

DO $$
DECLARE
  n text := 'plane_publish_definer';
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

GRANT USAGE ON SCHEMA public TO plane_publish_definer;
GRANT SELECT (id, account_id, work_item_id, role, status, sandbox_name, dispatch_repo_id) ON agent_runs TO plane_publish_definer;
GRANT SELECT (account_id, plane_push_id, run_id, finished_at) ON plane_push_attempts TO plane_publish_definer;
GRANT SELECT (id, account_id, work_item_id, repo_id, code_repo, branch, managed_by_person_at) ON plane_pushes TO plane_publish_definer;

CREATE POLICY plane_publish_definer_select ON agent_runs FOR SELECT TO plane_publish_definer USING (true);
CREATE POLICY plane_publish_definer_select ON plane_push_attempts FOR SELECT TO plane_publish_definer USING (true);
CREATE POLICY plane_publish_definer_select ON plane_pushes FOR SELECT TO plane_publish_definer USING (true);

CREATE FUNCTION resolve_plane_publish_target(p_sandbox_name text)
RETURNS TABLE (code_repo text, branch text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'resolve_plane_publish_target: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH live AS (
    SELECT a.id AS l_id, a.account_id AS l_account, a.work_item_id AS l_item, a.role AS l_role, a.dispatch_repo_id AS l_repo
      FROM public.agent_runs a
     WHERE a.sandbox_name = p_sandbox_name
       AND a.status IN ('pending', 'running', 'paused')
  ),
  m AS (
    SELECT p.code_repo AS m_repo, p.branch AS m_branch
      FROM live l
      JOIN public.plane_push_attempts t ON t.account_id = l.l_account AND t.run_id = l.l_id AND t.finished_at IS NULL
      JOIN public.plane_pushes p ON p.account_id = t.account_id AND p.id = t.plane_push_id
                                AND p.work_item_id = l.l_item AND p.repo_id = l.l_repo
     WHERE (SELECT count(*) FROM live) = 1
       AND l.l_role = 'plane_publish'
       AND p.managed_by_person_at IS NULL
  )
  SELECT m.m_repo, m.m_branch
    FROM m
   WHERE (SELECT count(*) FROM m) = 1;
END;
$$;

-- ---- ownership brackets (the shape 0828 used) ----------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'plane_publish_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on plane_publish_definer; cannot ALTER FUNCTION ... OWNER TO plane_publish_definer';
    END IF;
    GRANT plane_publish_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO plane_publish_definer;

REVOKE ALL ON FUNCTION resolve_plane_publish_target(text) FROM PUBLIC;
ALTER FUNCTION resolve_plane_publish_target(text) OWNER TO plane_publish_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION resolve_plane_publish_target(text) TO run_binding_resolver;

REVOKE CREATE ON SCHEMA public FROM plane_publish_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE plane_publish_definer FROM CURRENT_USER;
  END IF;
END
$$;
