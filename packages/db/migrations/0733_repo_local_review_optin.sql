-- D#6 R2b (correction C12 section 1 safeguard (a), section 5 "Opt-in"): the per-repo opt-in for auto-merge on a runner
-- repo's local reviews. Off by default. An owner or admin of the repo's account turns it on for one repo at a time, and
-- the change writes an audit_log row. The merge gate (packages/pipeline, `LocalReviewOptInPort`) reads this table and
-- counts a trusted runner's reviewer verdict only while a row exists; with no row, runner verdicts stay advisory.
--
-- What is stored, and why this shape. The opt-in is a ROW, not a boolean: repo_local_review_optins has a row for a repo
-- exactly while the repo's admin has the opt-in on. Off is the absence of a row, so there is no stale "false" to keep in
-- step and nothing to default wrongly.
--
-- The row is tied to the repo's mode. It carries execution_mode, which its CHECK pins to 'runner_local', and a composite
-- foreign key (account_id, repo_id, execution_mode) -> repos(account_id, id, execution_mode), for which this file adds
-- the unique constraint it needs. Two things follow, both enforced by the database and neither by a trigger:
--   * the opt-in can only exist for a repo that is on a runner;
--   * a repo's mode cannot be changed away from 'runner_local' while the opt-in is on (the update fails with 23503). The
--     route that changes a repo's mode (execution-mode, the next child) turns the opt-in off first in the same
--     transaction, with repo_local_review_optin_set(repo, false). That also means a repo that goes to the sandbox and
--     back to a runner can never come back with the old opt-in silently on: it must be turned on again, with the
--     confirmation step.
-- The foreign key's check locks the repo row, so an enable that races a mode change is serialised against it by Postgres.
--
-- Who can write. app_user may only read the table (its tenant policy, while the account is active). repos is writable by
-- app_user (0001), which is why the setting is not a column there: any member could have written it. The one write path
-- is repo_local_review_optin_set, a SECURITY DEFINER owned by platform_ops, executable by app_user only, with a pinned
-- search_path. It takes the account and the acting user from the tenant session (app.account_id, app.user_id), requires
-- that user to be an owner or admin of the account, writes the audit row in the same transaction, and refuses a
-- platform_ops login outright (platform_ops is the web tier's login for identity work, and passes the row policy of any
-- tenant it sets a context for). A trigger refuses a statement issued straight from a platform_ops login, as 0724 does for
-- the runner tables; statements nested in another trigger or a foreign-key action (the cascade when a repo or account
-- goes) are not refused.
--
-- The optional third argument is the sha256 of the "Local auto-merge" copy the client showed before the change. It is
-- validated (64 lowercase hex characters) and recorded in the audit row's payload as copy_sha256, so the log shows which
-- wording was confirmed. The route that checks it against the shipped copy comes later; this function only records it.
--
-- Refusals (fixed SQLSTATEs and messages, never an argument value):
--   42501 not permitted (no tenant or user context, not an owner or admin, a platform_ops login)
--   22023 invalid argument
--   P0002 no such repo in the account
--   55000 the repo is not on a runner (enable only)
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO platform_ops;

ALTER TABLE repos ADD CONSTRAINT repos_account_id_id_execution_mode_key UNIQUE (account_id, id, execution_mode);

CREATE TABLE repo_local_review_optins (
  account_id      uuid NOT NULL,
  repo_id         uuid NOT NULL,
  execution_mode  text NOT NULL DEFAULT 'runner_local',
  enabled_by      uuid NOT NULL REFERENCES users (id),
  enabled_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, repo_id),
  CONSTRAINT repo_local_review_optins_mode_check CHECK (execution_mode = 'runner_local'),
  CONSTRAINT repo_local_review_optins_repo_fk FOREIGN KEY (account_id, repo_id, execution_mode)
    REFERENCES repos (account_id, id, execution_mode) ON DELETE CASCADE
);

ALTER TABLE repo_local_review_optins ENABLE ROW LEVEL SECURITY;
ALTER TABLE repo_local_review_optins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON repo_local_review_optins FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY platform_ops_full_access ON repo_local_review_optins TO platform_ops USING (true) WITH CHECK (true);

REVOKE ALL ON repo_local_review_optins FROM PUBLIC;
GRANT SELECT ON repo_local_review_optins TO app_user;
-- The owner of the definer needs these; a direct platform_ops session is refused by the trigger below.
GRANT SELECT, INSERT, DELETE ON repo_local_review_optins TO platform_ops;

CREATE TRIGGER repo_local_review_optins_platform_ops_guard
  BEFORE INSERT OR UPDATE OR DELETE ON repo_local_review_optins
  FOR EACH ROW EXECUTE FUNCTION runner_tables_platform_ops_guard();

CREATE FUNCTION repo_local_review_optin_set(p_repo_id uuid, p_enabled boolean, p_copy_sha256 text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr     uuid := current_member_user_id();
  rl      text := current_member_role();
  v_rows  integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'repo_local_review_optin_set: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR rl IS NULL OR rl NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'repo_local_review_optin_set: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL OR p_enabled IS NULL OR (p_copy_sha256 IS NOT NULL AND p_copy_sha256 !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'repo_local_review_optin_set: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- platform_ops may read a repo's id and account (0613), which is all this needs: whether the repo is on a runner is
  -- decided by the foreign key below, atomically, rather than by a read that could be stale by the time of the insert.
  PERFORM 1 FROM public.repos r WHERE r.id = p_repo_id AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repo_local_review_optin_set: no such repo' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_enabled THEN
    BEGIN
      INSERT INTO public.repo_local_review_optins (account_id, repo_id, enabled_by)
      VALUES (acct, p_repo_id, usr)
      ON CONFLICT (account_id, repo_id) DO NOTHING;
    EXCEPTION WHEN foreign_key_violation THEN
      -- The repo is not on a runner (its mode is not 'runner_local').
      RAISE EXCEPTION 'repo_local_review_optin_set: the repo is not on a runner' USING ERRCODE = 'object_not_in_prerequisite_state';
    END;
  ELSE
    DELETE FROM public.repo_local_review_optins WHERE account_id = acct AND repo_id = p_repo_id;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- One audit row per change of state; a repeat that changes nothing writes none.
  IF v_rows = 1 THEN
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    VALUES (acct, usr::text,
            CASE WHEN p_enabled THEN 'repo.local_review_auto_merge.enabled' ELSE 'repo.local_review_auto_merge.disabled' END,
            jsonb_build_object('repo_id', p_repo_id)
              || CASE WHEN p_copy_sha256 IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('copy_sha256', p_copy_sha256) END,
            clock_timestamp());
  END IF;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION repo_local_review_optin_set(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION repo_local_review_optin_set(uuid, boolean, text) TO app_user;
ALTER FUNCTION repo_local_review_optin_set(uuid, boolean, text) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
