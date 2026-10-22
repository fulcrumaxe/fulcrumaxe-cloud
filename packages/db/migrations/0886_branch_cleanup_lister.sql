-- D#598 P1f-5d: delete a paired item's private branches once the item is closed or merged, and the cross-tenant list the cleanup sweep starts from.
--
-- 1. branch_cleanups: the record of one cleanup of one CLOSE of a work item. It is keyed to the move into the final stage it covers (`transition_id`,
--    the item's newest move into merged, closed_unmerged or closed; null for an item with no recorded move), so an item that is reopened, pushes again and
--    closes again has a new close with no row and is listed again: "still has work" is derived from the item's current history, not from a one-time stamp.
--    A row is `final` when every branch it covers has a final outcome (deleted, already gone, left because its head moved, because it is protected or is the
--    default branch, because the repository or its installation is gone, or because the attempts ran out). `outcomes` holds one fixed-shape entry per branch:
--    {branch, outcome} and nothing else. A row is `retrying` when GitHub could not be asked: it keeps the attempts so far, the outcomes already reached (so a
--    partial retry keeps "deleted" distinct from "already gone") and `next_attempt_at`, which backs off 15, 30, 60 and 120 minutes; the fifth failed attempt
--    makes the row final with the outcome `gave_up`. The row is also the note on the item.
-- 2. branch_cleanup_list_due: the cross-tenant list. A cleanup row is tenant-only (app_user, FORCE row security), so no sweep login can ask "which
--    closed or merged paired items still have branches" across accounts. The list names the item (account, id) and nothing else; everything after it
--    (reading the recorded heads, deleting, writing the row) runs one item at a time under that item's own tenant. It lists an item when its stage is
--    merged, closed_unmerged or closed, it has a plane_pushes row (it is paired), its account is live, and its newest close has no row or only a
--    `retrying` row that is due. Items never tried come first, then the one tried longest ago, and an item that is backing off is not listed, so items that
--    keep failing cannot hold the 10 places an account gets in one call. It writes nothing (STABLE), refuses a platform_ops login and returns no title,
--    repository, branch or sha.
--
-- Who owns it: platform_ops gains nothing. The function belongs to a role of its own, branch_cleanup_lister (same bracket as 0874): NOLOGIN, no
-- members, column grants for exactly what the body reads, one row policy per table for this role alone, a pinned search_path, and EXECUTE for the
-- run-writer login and nobody else.
--
-- Expand-only: a new table, a role and a function; nothing existing is dropped, renamed or narrowed. Numbered above the highest migration on the code
-- plane (0883) and above the claims of two open pull requests (0884, 0885); re-checked right before the pull request is opened.

CREATE TABLE branch_cleanups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id    uuid NOT NULL,
  -- The move into a final stage this row covers (work_item_transitions.id); null when the item has no recorded move.
  transition_id   uuid,
  state           text NOT NULL CONSTRAINT branch_cleanups_state_check CHECK (state IN ('final', 'retrying')),
  attempts        integer NOT NULL DEFAULT 1 CONSTRAINT branch_cleanups_attempts_check CHECK (attempts BETWEEN 1 AND 5),
  next_attempt_at timestamptz,
  outcomes        jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT branch_cleanups_outcomes_check CHECK (jsonb_typeof(outcomes) = 'array' AND jsonb_array_length(outcomes) <= 50),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT branch_cleanups_retry_shape CHECK ((state = 'retrying') = (next_attempt_at IS NOT NULL)),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);
-- One row per close of an item (a null move counts as one value).
CREATE UNIQUE INDEX branch_cleanups_item_close_key ON branch_cleanups (account_id, work_item_id, (COALESCE(transition_id, '00000000-0000-0000-0000-000000000000'::uuid)));

ALTER TABLE branch_cleanups ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_cleanups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON branch_cleanups TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON branch_cleanups FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON branch_cleanups TO app_user;

DO $$
DECLARE
  n text := 'branch_cleanup_lister';
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

-- The lister's whole reach: item ids, accounts and stage words, the item's final-stage moves, whether a push row or a cleanup row exists (and whether that row is
-- waiting to retry), and whether the account is live.
GRANT USAGE ON SCHEMA public TO branch_cleanup_lister;
GRANT SELECT (id, account_id, stage, updated_at) ON work_items TO branch_cleanup_lister;
GRANT SELECT (account_id, work_item_id) ON plane_pushes TO branch_cleanup_lister;
GRANT SELECT (id, account_id, work_item_id, transition_id, state, next_attempt_at, updated_at) ON branch_cleanups TO branch_cleanup_lister;
GRANT SELECT (id, account_id, work_item_id, to_stage, created_at) ON work_item_transitions TO branch_cleanup_lister;
GRANT SELECT (id, deleted_at) ON accounts TO branch_cleanup_lister;
CREATE POLICY branch_cleanup_lister_select ON work_items FOR SELECT TO branch_cleanup_lister USING (stage IN ('merged', 'closed_unmerged', 'closed'));
CREATE POLICY branch_cleanup_lister_select ON plane_pushes FOR SELECT TO branch_cleanup_lister USING (true);
CREATE POLICY branch_cleanup_lister_select ON branch_cleanups FOR SELECT TO branch_cleanup_lister USING (true);
CREATE POLICY branch_cleanup_lister_select ON work_item_transitions FOR SELECT TO branch_cleanup_lister USING (to_stage IN ('merged', 'closed_unmerged', 'closed'));
CREATE POLICY branch_cleanup_lister_select ON accounts FOR SELECT TO branch_cleanup_lister USING (deleted_at IS NULL);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'branch_cleanup_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on branch_cleanup_lister; cannot ALTER FUNCTION ... OWNER TO branch_cleanup_lister';
    END IF;
    GRANT branch_cleanup_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO branch_cleanup_lister;

CREATE FUNCTION branch_cleanup_list_due(p_limit int)
RETURNS TABLE (account_id uuid, work_item_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'branch_cleanup_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'branch_cleanup_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT d.account_id, d.id
    FROM (
      SELECT w.account_id, w.id, c.updated_at, w.updated_at AS item_updated_at,
             row_number() OVER (PARTITION BY w.account_id ORDER BY c.updated_at NULLS FIRST, w.updated_at, w.id) AS rn
        FROM public.work_items w
        JOIN public.accounts a ON a.id = w.account_id AND a.deleted_at IS NULL
        LEFT JOIN LATERAL (
          SELECT t.id FROM public.work_item_transitions t
           WHERE t.account_id = w.account_id AND t.work_item_id = w.id AND t.to_stage IN ('merged', 'closed_unmerged', 'closed')
           ORDER BY t.created_at DESC, t.id DESC LIMIT 1
        ) lt ON true
        LEFT JOIN public.branch_cleanups c
          ON c.account_id = w.account_id AND c.work_item_id = w.id
         AND COALESCE(c.transition_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(lt.id, '00000000-0000-0000-0000-000000000000'::uuid)
       WHERE w.stage IN ('merged', 'closed_unmerged', 'closed')
         AND EXISTS (SELECT 1 FROM public.plane_pushes p WHERE p.account_id = w.account_id AND p.work_item_id = w.id)
         AND (c.id IS NULL OR (c.state = 'retrying' AND c.next_attempt_at <= now()))
    ) d
   WHERE d.rn <= 10
   ORDER BY d.updated_at NULLS FIRST, d.item_updated_at, d.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION branch_cleanup_list_due(int) FROM PUBLIC;
ALTER FUNCTION branch_cleanup_list_due(int) OWNER TO branch_cleanup_lister;
-- EXECUTE after the transfer, to the run-writer login alone, as 0874 does.
GRANT EXECUTE ON FUNCTION branch_cleanup_list_due(int) TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM branch_cleanup_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE branch_cleanup_lister FROM CURRENT_USER;
  END IF;
END
$$;
