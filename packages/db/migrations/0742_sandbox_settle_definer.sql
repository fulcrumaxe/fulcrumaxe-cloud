-- D#2 PLATFORM-OPS-READ: close the cross-tenant read of the five sandbox settle columns that a direct platform_ops login
-- has had since 0689 (sandbox_requested_at, sandbox_session_ids, sandbox_stopped_at, sandbox_self_measured,
-- compute_settle_due_at). platform_ops held column SELECT and UPDATE on them, under its USING (true) read policy, only because
-- three definers it owned read them: agent_run_sandbox_mark (0706, reads each column it first-wins writes), the settle due-lister
-- compute_settle_list_due (0691, 0694) and the lost-run lister agent_run_list_running (0704).
--
-- All three move together, by ALTER FUNCTION ... OWNER TO, to a new NOLOGIN role that holds only what their bodies read or write
-- (a reader-only move would break every runner mark, which reads the columns it writes). Bodies, search_path and signatures are
-- unchanged and nothing is re-created. Then platform_ops loses SELECT and UPDATE on the five columns and nothing else.
--
--   sandbox_settle_definer   NOLOGIN, no members, a member of nothing. Privileges: column SELECT on agent_runs (13), column
--                            UPDATE on agent_runs (6), column SELECT on spend_reservations (4) and accounts (2), USAGE on public.
--   row policies             for this role only: agent_runs SELECT true; agent_runs UPDATE identical to platform_ops_run_update
--                            (0642: the caller's tenant context is the row and the account is active, so a mark on a deleted
--                            account still updates nothing); open compute reservations; accounts SELECT true (the UPDATE policy
--                            calls the INVOKER account_is_active).
--   EXECUTE                  the mark: agent_run_writer only. The two listers: agent_run_writer and platform_ops, so a direct
--                            platform_ops login is still refused by the function's own check, not by a missing ACL entry.
--
-- Not touched: platform_ops_read_access, platform_ops' other column grants (dispatch_pr_number, compute_settle_failures and
-- _retry_at, UPDATE (sandbox_name)), the 0691 open-compute policy, agent_run_settle_failed and every 0731 object.
-- Privilege brackets as in 0689 (platform_ops, to give up ownership) and 0731 (the new role, to receive it).
DO $$
DECLARE
  n text := 'sandbox_settle_definer';
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

-- What the three bodies read and write, column by column. Each table is row-secured, so each gets a policy for this role only.
GRANT SELECT (id, account_id, role, status, dispatch_repo_id, dispatch_pr_number, sandbox_name, sandbox_requested_at,
              sandbox_session_ids, sandbox_stopped_at, sandbox_self_measured, compute_settle_due_at, compute_settle_retry_at)
  ON agent_runs TO sandbox_settle_definer;
GRANT UPDATE (sandbox_requested_at, sandbox_session_ids, sandbox_stopped_at, sandbox_self_measured, compute_settle_due_at, sandbox_name)
  ON agent_runs TO sandbox_settle_definer;
GRANT SELECT (account_id, run_id, state, budget) ON spend_reservations TO sandbox_settle_definer;
GRANT SELECT (id, deleted_at) ON accounts TO sandbox_settle_definer;
GRANT USAGE ON SCHEMA public TO sandbox_settle_definer;

CREATE POLICY sandbox_settle_definer_select ON agent_runs FOR SELECT TO sandbox_settle_definer USING (true);
CREATE POLICY sandbox_settle_definer_update ON agent_runs FOR UPDATE TO sandbox_settle_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY sandbox_settle_definer_open_compute ON spend_reservations FOR SELECT TO sandbox_settle_definer
  USING (state = 'open' AND budget IN ('foreground_compute', 'background_compute'));
CREATE POLICY sandbox_settle_definer_select ON accounts FOR SELECT TO sandbox_settle_definer USING (true);

-- Ownership brackets. The migrator acts as platform_ops to give the functions up, and holds the new role (with ADMIN from
-- creating it) to receive them; the new role has CREATE on public only for the transfer. Both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'sandbox_settle_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on sandbox_settle_definer; cannot ALTER FUNCTION ... OWNER TO sandbox_settle_definer';
    END IF;
    GRANT sandbox_settle_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO sandbox_settle_definer;

ALTER FUNCTION agent_run_sandbox_mark(uuid, uuid, boolean, text, boolean, jsonb, boolean, text) OWNER TO sandbox_settle_definer;
ALTER FUNCTION compute_settle_list_due(integer) OWNER TO sandbox_settle_definer;
ALTER FUNCTION agent_run_list_running(integer, integer) OWNER TO sandbox_settle_definer;

-- The transfer replaced platform_ops' owner entry with the new owner's. The listers keep a platform_ops entry, as 0694 and
-- 0704 gave them, so a direct platform_ops login reaches the check inside the function. The mark gets none.
GRANT EXECUTE ON FUNCTION compute_settle_list_due(integer) TO platform_ops;
GRANT EXECUTE ON FUNCTION agent_run_list_running(integer, integer) TO platform_ops;

REVOKE SELECT (sandbox_requested_at, sandbox_session_ids, sandbox_stopped_at, sandbox_self_measured, compute_settle_due_at),
       UPDATE (sandbox_requested_at, sandbox_session_ids, sandbox_stopped_at, sandbox_self_measured, compute_settle_due_at)
  ON agent_runs FROM platform_ops;

REVOKE CREATE ON SCHEMA public FROM sandbox_settle_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE sandbox_settle_definer FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
