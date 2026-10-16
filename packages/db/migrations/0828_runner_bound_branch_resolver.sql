-- D#599 PL-2b-2: the gh-proxy re-checks, on every request, that a git ticket naming an item pull request branch (`fx/issue-<n>`) still matches the run's binding.
--
-- Why: PL-2b widens the branch a ticket may name from a run branch to the item's own pull request branch. The cloud signs that branch only when the run's
-- `runner.continues_bound` event, the signed job's `continues.branch` and `fx/issue-<item issue number>` all agree (the ticket route reads them). The proxy
-- holds no tenant context and checks tickets with a public key, so it needs one more question answered by the database for the same lease: "which item
-- branch is this run bound to right now?". A ticket whose `ref` is an item branch is honoured only if the answer is exactly that branch.
--
-- What: resolve_runner_bound_branch(account, run) answers the bound branch or NULL. It applies the same three-way agreement as the application's
-- `readBoundItemBranch` (packages/runner/src/runStatusWriter.ts): the newest `runner.continues_bound` event of the run, the run's own signed job
-- (`continues.branch` and `continues.pr_number`), and `fx/issue-` plus the run's work item's issue number. Any gap answers NULL; there is no fallback.
--
-- Privileges: a NEW role, runner_bound_definer (NOLOGIN, no members, a member of nothing; the shape 0765 gave runner_git_definer), owns the function. It is
-- separate from runner_git_definer on purpose, so that role's pinned grants stay exactly as 0765 and 0784 left them. It holds column SELECT on exactly what the
-- body reads (agent_runs: id, account_id, work_item_id, job_signed; work_items: id, account_id, gh_number; run_events: account_id, run_id, kind, payload, seq)
-- and a row policy of its own on each of those three tables. EXECUTE goes to run_binding_resolver and nobody else, the membership the proxy login already holds.
-- platform_ops gains NOTHING: no new privilege and no new policy for it; the function refuses a platform_ops login like its sibling. It writes nothing and uses
-- no clock.
--
-- Rollback (docs/ops/runbooks/rollback.md, expand/contract): additive only. The previous deploy never calls the function; if this deploy is reverted the
-- proxy simply stops asking, and a ticket naming an item branch can no longer be signed (the route is reverted with it). Nothing is rewritten.
--
-- Numbered above the highest migration queued on the code plane. Re-check against main right before merging and renumber to stay above it.

DO $$
DECLARE
  n text := 'runner_bound_definer';
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

GRANT USAGE ON SCHEMA public TO runner_bound_definer;
GRANT SELECT (id, account_id, work_item_id, job_signed) ON agent_runs TO runner_bound_definer;
GRANT SELECT (id, account_id, gh_number) ON work_items TO runner_bound_definer;
GRANT SELECT (account_id, run_id, kind, payload, seq) ON run_events TO runner_bound_definer;

CREATE POLICY runner_bound_definer_select ON agent_runs FOR SELECT TO runner_bound_definer USING (true);
CREATE POLICY runner_bound_definer_select ON work_items FOR SELECT TO runner_bound_definer USING (true);
CREATE POLICY runner_bound_definer_select ON run_events FOR SELECT TO runner_bound_definer USING (true);

CREATE FUNCTION resolve_runner_bound_branch(p_account_id uuid, p_run_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_branch text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'resolve_runner_bound_branch: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'resolve_runner_bound_branch: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT e.payload->>'branch'
    INTO v_branch
    FROM public.run_events e
    JOIN public.agent_runs a ON a.account_id = e.account_id AND a.id = e.run_id
    JOIN public.work_items w ON w.account_id = a.account_id AND w.id = a.work_item_id
   WHERE e.account_id = p_account_id AND e.run_id = p_run_id AND e.kind = 'runner.continues_bound'
     AND e.payload->>'branch' = a.job_signed->'job'->'continues'->>'branch'
     AND e.payload->>'pr_number' = a.job_signed->'job'->'continues'->>'pr_number'
     AND e.payload->>'branch' = 'fx/issue-' || w.gh_number::text
   ORDER BY e.seq DESC
   LIMIT 1;
  RETURN v_branch;
END;
$$;

-- ---- ownership brackets (the shape 0765 used) ----------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_bound_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_bound_definer; cannot ALTER FUNCTION ... OWNER TO runner_bound_definer';
    END IF;
    GRANT runner_bound_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_bound_definer;

REVOKE ALL ON FUNCTION resolve_runner_bound_branch(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION resolve_runner_bound_branch(uuid, uuid) OWNER TO runner_bound_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION resolve_runner_bound_branch(uuid, uuid) TO run_binding_resolver;

REVOKE CREATE ON SCHEMA public FROM runner_bound_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_bound_definer FROM CURRENT_USER;
  END IF;
END
$$;
