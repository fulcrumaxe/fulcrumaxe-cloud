-- D#483 S4-e5: the supersede proof cannot be forged.
--
-- 0843 let proposal_follow_root trust a free-text source ref (`superseded:<root>`) on a closing row of work_item_transitions. app_user
-- can append to that table with any ref, so the proof was only as strong as a table the app can write. This migration moves the proof
-- into a record the app cannot write, and makes the retire step the only writer of that record.
--
-- Where the record lives, and why. A small table, work_item_supersedes (one row per retired item: the old item and the root that
-- replaced it), not a column on work_items. app_user holds table-level UPDATE on work_items, and a column cannot be taken away from a role
-- that holds the whole table, so a guarded column would be a trigger and not a privilege boundary. The table has row security forced and
-- NO write grant and NO write policy for any role except the new definer role, so a direct write fails on privileges (42501) for app_user,
-- for the runner login and for platform_ops alike.
--
-- retire_superseded_work_item(p_old, p_root) is the only writer. In one call, in the caller's tenant, it refuses unless the old item and
-- the root are in the same account and have the same (non-null) repo, the root is not the old item, and the old item is not already
-- superseded by a different root. It then closes the old item (`triaged` to `closed`), writes the history row (source ref
-- `superseded:<root>`, kept for the history screen) and the record, all in one statement block. A replay with the same pair is a no-op
-- that answers `already`. A halted item is left exactly as it is and answers `halted` (nothing is closed behind a customer's halt, as the
-- stage writer's own rule says). The answer is text so the caller can tell the three apart without catching an error inside its transaction.
--
-- proposal_follow_root is replaced (same signature, same owner, same ACL) so that it reads the record instead of the ref text. It still
-- requires the old item to be in stage `closed` AND to carry a stage transition whose to_stage is `closed`: those two clauses are not the
-- proof, they are consistency checks on top of it, and each is pinned by its own test with a named mutation.
--
-- Privileges. A NEW role, work_item_retirer (NOLOGIN, no members, a member of nothing), owns the retire function and holds exactly what its
-- body reads and writes, column by column, each with a tenant-bound row policy of its own. EXECUTE goes to agent_run_writer alone (the
-- runner login of the stage driver is the only login in both app_user and agent_run_writer), as for proposal_follow_root. proposal_follower
-- gains one SELECT (three columns) on the new table, so its function can read the record.
--
-- Backfill. Every closed item that already carries a closing transition with a `superseded:<root>` ref whose root is a work item in the
-- same account and the same non-null repo gets its record, so no earlier supersede loses its proof. An item whose ref names nothing real,
-- another repo or another account, or that is not closed, gets nothing.
--
-- 0843 and the earlier migrations are untouched. Numbered 0851 (re-check against main right before merging; merge in number order).

-- ---- the record -------------------------------------------------------------------------------------------------
CREATE TABLE work_item_supersedes (
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  old_work_item_id  uuid NOT NULL,
  root_work_item_id uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, old_work_item_id),
  CONSTRAINT work_item_supersedes_distinct CHECK (old_work_item_id <> root_work_item_id),
  FOREIGN KEY (account_id, old_work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, root_work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_work_item_supersedes_root ON work_item_supersedes (account_id, root_work_item_id);

ALTER TABLE work_item_supersedes ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_supersedes FORCE ROW LEVEL SECURITY;
-- Readers: the tenant, through app_user (the runner login inherits it). Read only: no INSERT, UPDATE or DELETE is granted to app_user.
CREATE POLICY tenant_isolation_select ON work_item_supersedes FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT ON work_item_supersedes TO app_user;

-- ---- the roles --------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text := 'work_item_retirer';
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

GRANT USAGE ON SCHEMA public TO work_item_retirer;
-- account_is_active() is a SECURITY INVOKER function, so the role must be able to read the one account in context.
GRANT SELECT (id, deleted_at) ON accounts TO work_item_retirer;
CREATE POLICY work_item_retirer_select ON accounts FOR SELECT TO work_item_retirer
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);

GRANT SELECT (id, account_id, repo_id, stage, halted_at) ON work_items TO work_item_retirer;
GRANT UPDATE (stage, updated_at) ON work_items TO work_item_retirer;
CREATE POLICY work_item_retirer_select ON work_items FOR SELECT TO work_item_retirer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_retirer_update ON work_items FOR UPDATE TO work_item_retirer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

GRANT INSERT (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) ON work_item_transitions TO work_item_retirer;
CREATE POLICY work_item_retirer_insert ON work_item_transitions FOR INSERT TO work_item_retirer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

GRANT SELECT (account_id, old_work_item_id, root_work_item_id), INSERT (account_id, old_work_item_id, root_work_item_id) ON work_item_supersedes TO work_item_retirer;
CREATE POLICY work_item_retirer_select ON work_item_supersedes FOR SELECT TO work_item_retirer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_retirer_insert ON work_item_supersedes FOR INSERT TO work_item_retirer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- The follower reads the record, and nothing else about it.
GRANT SELECT (account_id, old_work_item_id, root_work_item_id) ON work_item_supersedes TO proposal_follower;
CREATE POLICY proposal_follower_select ON work_item_supersedes FOR SELECT TO proposal_follower
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---- the retire definer -----------------------------------------------------------------------------------------
-- Error contract (fixed messages, no argument value in any): 22023 invalid arguments; 42501 not permitted (no tenant, an inactive
-- account, a platform_ops login); 55000 `root_mismatch`, `superseded_by_other`, `old_not_retirable`; P0002 `old_not_found`.
-- Answers: `retired` (the close and the record were written), `already` (the same pair was recorded before: nothing is written),
-- `halted` (the item carries a customer halt: nothing is written).
CREATE FUNCTION retire_superseded_work_item(p_old_work_item_id uuid, p_root_work_item_id uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct      uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  old_stage text;
  old_repo  uuid;
  old_halted boolean;
  root_repo uuid;
  recorded  uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'retire_superseded_work_item: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'retire_superseded_work_item: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_old_work_item_id IS NULL OR p_root_work_item_id IS NULL OR p_old_work_item_id = p_root_work_item_id THEN
    RAISE EXCEPTION 'retire_superseded_work_item: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT w.stage, w.repo_id, w.halted_at IS NOT NULL INTO old_stage, old_repo, old_halted
    FROM public.work_items w WHERE w.id = p_old_work_item_id AND w.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'old_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  -- The row policy shows this role only the caller's own account, so a root in another account is simply not found.
  SELECT w.repo_id INTO root_repo FROM public.work_items w WHERE w.id = p_root_work_item_id AND w.account_id = acct;
  IF NOT FOUND OR root_repo IS NULL OR old_repo IS NULL OR root_repo <> old_repo THEN
    RAISE EXCEPTION 'root_mismatch' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT s.root_work_item_id INTO recorded FROM public.work_item_supersedes s WHERE s.account_id = acct AND s.old_work_item_id = p_old_work_item_id;
  IF FOUND THEN
    IF recorded = p_root_work_item_id THEN
      RETURN 'already';
    END IF;
    RAISE EXCEPTION 'superseded_by_other' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF old_halted THEN
    RETURN 'halted';
  END IF;
  IF old_stage <> 'triaged' THEN
    RAISE EXCEPTION 'old_not_retirable' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- The history row is for the history screen and is not the proof. A row with this exact key may already exist (the unique key is
  -- account, item, to_stage, ref, and the ref is free text for a writer that is not this function); it stands, and the record below is
  -- what counts.
  INSERT INTO public.work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref)
    VALUES (acct, p_old_work_item_id, 'triaged', 'closed', now(), 'control_plane', 'superseded:' || p_root_work_item_id::text)
    ON CONFLICT DO NOTHING;
  UPDATE public.work_items SET stage = 'closed', updated_at = now() WHERE id = p_old_work_item_id AND account_id = acct;
  INSERT INTO public.work_item_supersedes (account_id, old_work_item_id, root_work_item_id) VALUES (acct, p_old_work_item_id, p_root_work_item_id);
  RETURN 'retired';
END $$;

-- ---- proposal_follow_root reads the record ------------------------------------------------------------------------
-- Same signature, owner and ACL as 0843 (CREATE OR REPLACE keeps all three). The only change is the proof: the old clause matched the
-- free-text ref `superseded:<root>` on a transition row; the new one matches the record. The two consistency clauses stay.
-- The migration role holds the function's owner only for this statement (0792's bracket), as in 0843.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'proposal_follower'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on proposal_follower; cannot CREATE OR REPLACE FUNCTION proposal_follow_root';
    END IF;
    GRANT proposal_follower TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION proposal_follow_root(p_proposal_id uuid, p_old_work_item_id uuid, p_root_work_item_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  p        record;
  old_repo uuid;
  old_stage text;
  root_repo uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'proposal_follow_root: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'proposal_follow_root: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_proposal_id IS NULL OR p_old_work_item_id IS NULL OR p_root_work_item_id IS NULL OR p_old_work_item_id = p_root_work_item_id THEN
    RAISE EXCEPTION 'proposal_follow_root: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT x.id, x.state, x.work_item_id, x.repo_id INTO p
    FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'proposal_follow_root: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p.state <> 'approved' THEN
    RAISE EXCEPTION 'not_approved' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- A replay after the move: the link is already the root. Nothing is written.
  IF p.work_item_id = p_root_work_item_id THEN
    RETURN false;
  END IF;
  IF p.work_item_id IS DISTINCT FROM p_old_work_item_id THEN
    RAISE EXCEPTION 'not_current_link' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- The proof is the record that retire_superseded_work_item wrote for exactly this pair. The ref text on a transition row is never read.
  SELECT w.stage, w.repo_id INTO old_stage, old_repo FROM public.work_items w WHERE w.id = p_old_work_item_id AND w.account_id = acct;
  IF NOT FOUND
     OR old_stage <> 'closed'
     OR NOT EXISTS (SELECT 1 FROM public.work_item_supersedes s
                     WHERE s.account_id = acct AND s.old_work_item_id = p_old_work_item_id AND s.root_work_item_id = p_root_work_item_id)
     OR NOT EXISTS (SELECT 1 FROM public.work_item_transitions t
                     WHERE t.account_id = acct AND t.work_item_id = p_old_work_item_id AND t.to_stage = 'closed') THEN
    RAISE EXCEPTION 'old_not_superseded' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- The row policy shows this role only the caller's own account, so a root in another account is simply not found.
  SELECT w.repo_id INTO root_repo FROM public.work_items w WHERE w.id = p_root_work_item_id AND w.account_id = acct;
  IF NOT FOUND OR root_repo IS NULL OR root_repo IS DISTINCT FROM old_repo OR root_repo IS DISTINCT FROM p.repo_id THEN
    RAISE EXCEPTION 'root_mismatch' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE public.proposals SET work_item_id = p_root_work_item_id, updated_at = now()
   WHERE id = p_proposal_id AND account_id = acct;
  RETURN true;
END $$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE proposal_follower FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- hand the retire function to its role (0792's bracket) -------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'work_item_retirer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on work_item_retirer; cannot ALTER FUNCTION ... OWNER TO work_item_retirer';
    END IF;
    GRANT work_item_retirer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO work_item_retirer;

REVOKE ALL ON FUNCTION retire_superseded_work_item(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION retire_superseded_work_item(uuid, uuid) OWNER TO work_item_retirer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION retire_superseded_work_item(uuid, uuid) TO agent_run_writer;

REVOKE CREATE ON SCHEMA public FROM work_item_retirer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE work_item_retirer FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- the backfill -----------------------------------------------------------------------------------------------
-- Items retired before this migration carry their proof only as the ref text. Each closed item whose closing transition names a root
-- that exists in the same account with the same non-null repo gets its record; the earliest such transition wins when there are
-- several. The ref is compared as text (no cast of free text to uuid), and a ref that names nothing real yields nothing.
INSERT INTO work_item_supersedes (account_id, old_work_item_id, root_work_item_id)
SELECT DISTINCT ON (o.account_id, o.id) o.account_id, o.id, r.id
  FROM work_items o
  JOIN work_item_transitions t
    ON t.account_id = o.account_id AND t.work_item_id = o.id AND t.to_stage = 'closed' AND t.source_ref LIKE 'superseded:%'
  JOIN work_items r
    ON r.account_id = o.account_id AND r.id::text = substr(t.source_ref, length('superseded:') + 1)
 WHERE o.stage = 'closed' AND o.repo_id IS NOT NULL AND r.repo_id = o.repo_id AND r.id <> o.id
 ORDER BY o.account_id, o.id, t.created_at, t.id
ON CONFLICT DO NOTHING;
