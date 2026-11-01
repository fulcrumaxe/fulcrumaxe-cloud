-- D#598 P1d-3: the durable "a parity check is due" mark for a paired repository, and the last result of the check.
--
-- A push to the default branch of either repo of a pairing sets due_at to now() + 60 s (kept if already earlier), and the existing
-- setup-request-check sweep runs the check when it falls due. The webhook makes no GitHub call; the pending-work marker is only a hint, so
-- the mark has to be a row. One row per pairing; it goes with the pairing (ON DELETE CASCADE).
--
--   due_at              NULL while nothing is due; the time the check may run otherwise (a back-off after "unavailable" lands here too)
--   last_result         what the last check found; NULL before the first one
--   private_sha, public_sha, sync_sha   the commits that check compared (full ids, or NULL)
--   checked_at          when it ended; unavailable_streak counts "unavailable" in a row (reset by a push or any other result)
--
-- app_user may read and insert rows of its own account and update the due and result columns, and may not delete (the pairing's cascade does).
--
-- The cross-account list the sweep starts from is plane_parity_list_due, owned by the existing setup_request_lister role (0874): the role gains
-- column SELECT on three columns of this table, on account_members.created_at (to pick the writer: the account's longest-standing owner or
-- admin), one row policy, and this second function. It sees no sha, result or path. EXECUTE goes to the run-writer login alone.
--
-- Expand-only. Numbered above the highest migration on the code plane and the open PRs' claims; re-checked right before merge.

CREATE TABLE plane_parity_checks (
  repo_id            uuid PRIMARY KEY REFERENCES repo_pairing (repo_id) ON DELETE CASCADE,
  account_id         uuid NOT NULL,
  due_at             timestamptz,
  last_result        text CONSTRAINT plane_parity_checks_result_check CHECK (
    last_result IN ('in_parity', 'lag', 'drift', 'no_shared_history', 'too_large', 'invalid_overlay', 'unsupported_branch', 'unavailable')),
  private_sha        text CONSTRAINT plane_parity_checks_private_sha_check CHECK (private_sha IS NULL OR private_sha ~ '^[0-9a-f]{40}$'),
  public_sha         text CONSTRAINT plane_parity_checks_public_sha_check CHECK (public_sha IS NULL OR public_sha ~ '^[0-9a-f]{40}$'),
  sync_sha           text CONSTRAINT plane_parity_checks_sync_sha_check CHECK (sync_sha IS NULL OR sync_sha ~ '^[0-9a-f]{40}$'),
  checked_at         timestamptz,
  unavailable_streak integer NOT NULL DEFAULT 0 CONSTRAINT plane_parity_checks_streak_check CHECK (unavailable_streak >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_plane_parity_checks_due ON plane_parity_checks (due_at) INCLUDE (account_id, repo_id) WHERE due_at IS NOT NULL;

ALTER TABLE plane_parity_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE plane_parity_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON plane_parity_checks TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT ON plane_parity_checks TO app_user;
GRANT UPDATE (due_at, last_result, private_sha, public_sha, sync_sha, checked_at, unavailable_streak) ON plane_parity_checks TO app_user;

-- ---- the lister: the existing setup_request_lister role gains the one read it needs ----------------------------------
GRANT SELECT (repo_id, account_id, due_at) ON plane_parity_checks TO setup_request_lister;
GRANT SELECT (created_at) ON account_members TO setup_request_lister;
CREATE POLICY setup_request_lister_select ON plane_parity_checks FOR SELECT TO setup_request_lister USING (due_at IS NOT NULL);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'setup_request_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on setup_request_lister; cannot ALTER FUNCTION ... OWNER TO setup_request_lister';
    END IF;
    GRANT setup_request_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO setup_request_lister;

-- Every pairing with a due_at (due now or later), earliest first: the sweep runs the ones whose time has come and asks for the next tick at the
-- earliest of the rest. The writer is the account's longest-standing owner or admin (the derived request is written by a member).
CREATE FUNCTION plane_parity_list_due(p_limit int)
RETURNS TABLE (account_id uuid, repo_id uuid, user_id uuid, due_at timestamptz, due_now boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'plane_parity_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'plane_parity_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT c.account_id, c.repo_id, w.user_id, c.due_at, c.due_at <= now()
    FROM public.plane_parity_checks c
    JOIN public.accounts a ON a.id = c.account_id AND a.deleted_at IS NULL
    JOIN LATERAL (
      SELECT m.user_id FROM public.account_members m
       WHERE m.account_id = c.account_id AND m.role IN ('owner', 'admin') ORDER BY m.created_at, m.user_id LIMIT 1
    ) w ON true
   WHERE c.due_at IS NOT NULL
   ORDER BY c.due_at, c.repo_id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION plane_parity_list_due(int) FROM PUBLIC;
ALTER FUNCTION plane_parity_list_due(int) OWNER TO setup_request_lister;
GRANT EXECUTE ON FUNCTION plane_parity_list_due(int) TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM setup_request_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE setup_request_lister FROM CURRENT_USER;
  END IF;
END
$$;
