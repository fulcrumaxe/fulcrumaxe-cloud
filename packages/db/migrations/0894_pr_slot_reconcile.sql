-- D#598: a work item that sits in a pull-request stage after its pull request was closed or merged on GitHub (the pull_request webhook that should have
-- moved it never arrived) holds its repository's build slot for good. The worker now reads the pull request's real state back from GitHub and, when it is
-- closed or merged, moves the item the way the webhook would. This migration adds what that read needs from the database.
--
-- 1. pr_slot_reconciles: one row per work item, the time GitHub was last asked about the item's pull request. It is the bound on the reads: a read is
--    made only by the caller whose upsert moves `checked_at` (a row older than the window, or no row), so two callers at once make one read, and a
--    holder is asked about at most once per window however many waiting items poll. The row is a throttle, not the item's state: the stage is read
--    every time, and nothing about the pull request is stored.
-- 2. pr_slot_reconcile_list_due: the cross-tenant list the periodic sweep starts from. A work item and its throttle row are tenant-only, so no sweep
--    login can ask "which items in a pull-request stage have not been checked lately" across accounts. The list names the item (account, id) and
--    nothing else; the read of GitHub and any move run one item at a time under that item's own tenant. It lists an item when its stage is
--    pr_opened, changes_requested or review_passed, its account is live, and it has no throttle row or one older than the window (600 seconds,
--    PR_RECONCILE_EVERY_SECONDS in packages/worker/src/prSlotReconcile.ts; a test holds the two equal). Items never checked come first, then the one
--    checked longest ago, at most 10 per account per call. It writes nothing (STABLE), refuses a platform_ops login and returns no title, repository,
--    branch or number.
--
-- Who owns the function: a role of its own, pr_slot_reconcile_lister (the same bracket as 0886): NOLOGIN, no members, column grants for exactly what the
-- body reads, one row policy per table for this role alone, a pinned search_path, and EXECUTE for the run-writer login and nobody else.
--
-- Expand-only: a new table, a role and a function; nothing existing is dropped, renamed or narrowed. Numbered above the highest migration on the code
-- plane (0892) and above the one open pull request that claims a number (0893).

CREATE TABLE pr_slot_reconciles (
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL,
  checked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, work_item_id),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);

ALTER TABLE pr_slot_reconciles ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_slot_reconciles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pr_slot_reconciles TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON pr_slot_reconciles FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pr_slot_reconciles TO app_user;

DO $$
DECLARE
  n text := 'pr_slot_reconcile_lister';
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

-- The lister's whole reach: item ids, accounts, stage words and last-move times of items in a pull-request stage, when each was last checked, and
-- whether the account is live.
GRANT USAGE ON SCHEMA public TO pr_slot_reconcile_lister;
GRANT SELECT (id, account_id, stage, updated_at) ON work_items TO pr_slot_reconcile_lister;
GRANT SELECT (account_id, work_item_id, checked_at) ON pr_slot_reconciles TO pr_slot_reconcile_lister;
GRANT SELECT (id, deleted_at) ON accounts TO pr_slot_reconcile_lister;
CREATE POLICY pr_slot_reconcile_lister_select ON work_items FOR SELECT TO pr_slot_reconcile_lister USING (stage IN ('pr_opened', 'changes_requested', 'review_passed'));
CREATE POLICY pr_slot_reconcile_lister_select ON pr_slot_reconciles FOR SELECT TO pr_slot_reconcile_lister USING (true);
CREATE POLICY pr_slot_reconcile_lister_select ON accounts FOR SELECT TO pr_slot_reconcile_lister USING (deleted_at IS NULL);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'pr_slot_reconcile_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on pr_slot_reconcile_lister; cannot ALTER FUNCTION ... OWNER TO pr_slot_reconcile_lister';
    END IF;
    GRANT pr_slot_reconcile_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO pr_slot_reconcile_lister;

CREATE FUNCTION pr_slot_reconcile_list_due(p_limit int)
RETURNS TABLE (account_id uuid, work_item_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'pr_slot_reconcile_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'pr_slot_reconcile_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT d.account_id, d.id
    FROM (
      SELECT w.account_id, w.id, c.checked_at, w.updated_at,
             row_number() OVER (PARTITION BY w.account_id ORDER BY c.checked_at NULLS FIRST, w.updated_at, w.id) AS rn
        FROM public.work_items w
        JOIN public.accounts a ON a.id = w.account_id AND a.deleted_at IS NULL
        LEFT JOIN public.pr_slot_reconciles c ON c.account_id = w.account_id AND c.work_item_id = w.id
       WHERE w.stage IN ('pr_opened', 'changes_requested', 'review_passed')
         AND (c.checked_at IS NULL OR c.checked_at <= now() - interval '600 seconds')
    ) d
   WHERE d.rn <= 10
   ORDER BY d.checked_at NULLS FIRST, d.updated_at, d.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION pr_slot_reconcile_list_due(int) FROM PUBLIC;
ALTER FUNCTION pr_slot_reconcile_list_due(int) OWNER TO pr_slot_reconcile_lister;
-- EXECUTE after the transfer, to the run-writer login alone, as 0886 does.
GRANT EXECUTE ON FUNCTION pr_slot_reconcile_list_due(int) TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM pr_slot_reconcile_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE pr_slot_reconcile_lister FROM CURRENT_USER;
  END IF;
END
$$;
