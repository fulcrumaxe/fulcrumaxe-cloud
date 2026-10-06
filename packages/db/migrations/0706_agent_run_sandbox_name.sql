-- The runner records a run's sandbox name, once, so the gh-proxy can find the run.
--
-- Why. The gh-proxy binds a sandbox token to its run through resolve_sandbox_run (0696), which looks the run up
-- by agent_runs.sandbox_name. Nothing wrote that column, so every sandbox request answered 403 "sandbox not
-- resolved". The name is a pure function of the run (sandboxNameFor), known before the sandbox is created.
--
-- How. The existing runner write, agent_run_sandbox_mark (0689), gains one more argument, p_sandbox_name. The
-- runner already calls it before the sandbox request (the request marker), so the name lands in that same
-- statement. The write is first-wins like the other columns it sets: a second call, with the same name or another,
-- leaves the stored name as it is. The name must have the shape the runner builds ("ex-..." or "rn-...").
-- The new argument defaults to null, so a caller that passes the old seven arguments still works.
--
-- The function is re-created (a new signature cannot be CREATE OR REPLACEd, and two overloads would make a seven
-- argument call ambiguous), with the same owner, search_path, tenant-context check and ACL as 0689.
--
-- Staging carried a hand-made stopgap, public.fx_hotfix_set_sandbox_name(uuid, uuid, text), owned by platform_ops
-- and executable by agent_run_writer. This file drops it. Its helper grant, UPDATE (sandbox_name) ON agent_runs
-- TO platform_ops, is KEPT: the definer's owner needs exactly that column privilege to write the name, so it is
-- re-issued here (a no-op where the stopgap already granted it, and the grant a fresh database needs).
-- A BEFORE UPDATE OF sandbox_name trigger refuses a direct platform_ops session and any change of a recorded name,
-- and the definer ties the name to its run (rn-... ends with the run id, ex-... embeds the account id).
-- Privilege brackets as in 0689.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

-- contract-phase: D#2
-- fx_hotfix_set_sandbox_name was a hand-made staging hotfix (D#2), not created by any migration.
DROP FUNCTION IF EXISTS public.fx_hotfix_set_sandbox_name(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.agent_run_sandbox_mark(uuid, uuid, boolean, text, boolean, jsonb, boolean);

GRANT UPDATE (sandbox_name) ON agent_runs TO platform_ops;

-- The column is guarded where it lives, not only inside the definer: platform_ops is also the web tier's live
-- login, and it passes the row policy of any tenant it sets a context for. Same shape as the 0689 guard: a direct
-- platform_ops session may not write the column at all, and a recorded name is never changed (for any role).
-- Inside the definer session_user is the runner's login, so the runner path is unaffected.
CREATE FUNCTION agent_runs_sandbox_name_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_runs: platform_ops may not write sandbox_name; use agent_run_sandbox_mark'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.sandbox_name IS NOT NULL AND NEW.sandbox_name IS DISTINCT FROM OLD.sandbox_name THEN
    RAISE EXCEPTION 'agent_runs: a recorded sandbox name is set once (run %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_runs_sandbox_name_guard
  BEFORE UPDATE OF sandbox_name ON agent_runs FOR EACH ROW EXECUTE FUNCTION agent_runs_sandbox_name_guard();

CREATE FUNCTION agent_run_sandbox_mark(
  p_account_id uuid, p_run_id uuid, p_requested boolean, p_session_id text,
  p_stopped boolean, p_self_measured jsonb, p_due boolean, p_sandbox_name text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_account_id IS NULL OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid THEN
    RAISE EXCEPTION 'agent_run_sandbox_mark: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_sandbox_name IS NOT NULL AND p_sandbox_name !~ '^(ex|rn)-[A-Za-z0-9._-]{1,200}$' THEN
    RAISE EXCEPTION 'agent_run_sandbox_mark: the sandbox name has an unexpected shape' USING ERRCODE = 'check_violation';
  END IF;
  -- The name is bound to the run, as packages/runner/src/sandboxNaming.ts builds it: a non-executor name is
  -- "rn-<role length>-<role>-<run id>", an executor name is "ex-<account id>-<repo id>-<pr number>". So even the
  -- runner's own login cannot record a name that belongs to another run or another tenant.
  IF p_sandbox_name LIKE 'rn-%' AND NOT (p_sandbox_name ~ '^rn-[0-9]{1,3}-.+-[0-9a-f-]{36}$'
                                         AND right(p_sandbox_name, 37) = '-' || p_run_id::text) THEN
    RAISE EXCEPTION 'agent_run_sandbox_mark: the sandbox name does not end with this run''s id' USING ERRCODE = 'check_violation';
  END IF;
  IF p_sandbox_name LIKE 'ex-%' AND NOT (p_sandbox_name ~ '^ex-[0-9a-f-]{36}-[0-9a-f-]{36}-[0-9]{1,18}$'
                                         AND substr(p_sandbox_name, 4, 36) = p_account_id::text) THEN
    RAISE EXCEPTION 'agent_run_sandbox_mark: the sandbox name does not embed this account' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.agent_runs SET
    sandbox_requested_at  = CASE WHEN p_requested THEN COALESCE(sandbox_requested_at, now()) ELSE sandbox_requested_at END,
    sandbox_session_ids   = CASE WHEN p_session_id IS NOT NULL AND NOT (p_session_id = ANY (sandbox_session_ids))
                                 THEN array_append(sandbox_session_ids, p_session_id) ELSE sandbox_session_ids END,
    sandbox_stopped_at    = CASE WHEN p_stopped THEN COALESCE(sandbox_stopped_at, now()) ELSE sandbox_stopped_at END,
    sandbox_self_measured = COALESCE(sandbox_self_measured, p_self_measured),
    compute_settle_due_at = CASE WHEN p_due IS NULL THEN compute_settle_due_at
                                 WHEN p_due THEN COALESCE(compute_settle_due_at, now()) ELSE NULL END,
    sandbox_name          = COALESCE(sandbox_name, p_sandbox_name)
  WHERE account_id = p_account_id AND id = p_run_id;
END $$;
REVOKE ALL ON FUNCTION agent_run_sandbox_mark(uuid, uuid, boolean, text, boolean, jsonb, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_run_sandbox_mark(uuid, uuid, boolean, text, boolean, jsonb, boolean, text) TO agent_run_writer;
ALTER FUNCTION agent_run_sandbox_mark(uuid, uuid, boolean, text, boolean, jsonb, boolean, text) OWNER TO platform_ops;

-- The stopgap is gone, whatever signature it was made with.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname LIKE 'fx\_hotfix\_%') THEN
    RAISE EXCEPTION 'a fx_hotfix_* function is still present after 0706';
  END IF;
END
$$;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
