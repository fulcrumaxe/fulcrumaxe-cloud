-- D#483 S5-b2d-2a: the database half of turning a follow-up (0960) into its own work item.
--
--   1. follow_up_child_create(follow_up): SECURITY DEFINER, owned by follow_up_child_definer, the only writer of work_items.follow_up_id and of
--      work_item_follow_ups.child_id. It makes the child and sets child_id in ONE statement, so a child without its link, or a link without its child, cannot
--      exist. A replay or a concurrent call answers the child that exists and makes no second one (an advisory lock per follow-up, and the unique index on
--      follow_up_id as the backstop). Two modes, told apart by the session: with no user and no token (the sweep's receipt login) the row must be a `child` with
--      no child yet, and the parent must have a person's approval; with a user (an owner or admin on the web login) a `note` row may be made an item too, and
--      the actor goes into one audit row. A token in the session is refused. Either way the parent must not be closed. The child is kind `small` (a constant:
--      no field of the record is read for a category), titled "Follow-up: " plus the follow-up's title cut so the whole is at most 120 characters, and copies
--      the parent's repo and provenance (an external parent's child stays external).
--      Error contract (fixed messages, no argument values): 42501 not permitted; 22023 bad argument; P0002 not found; 55000 with the code as the message:
--      follow_up_not_a_child, parent_closed, parent_not_approved.
--   2. work_items_follow_up_guard is replaced: an INSERT that sets follow_up_id is admitted only while current_user is follow_up_child_definer (0919's pattern);
--      a change after creation is still refused for everybody.
--   3. follow_up_child_list_due(limit, after_created_at, after_id): the cross-account list of `child` follow-ups with no child yet whose parent is not closed and
--      has a person's approval, keyset paged, under its own NOLOGIN role. Names (account, follow-up, created_at) and nothing else.
--   4. work_item_follow_ups_child_only_for_child (0960) is dropped. It forbade a child on a `note` row, which a person's "Make it an item" needs. The
--      disposition column keeps what the setting said when the row was written; child_id says what was made of it since.
--
-- Expand-only: two roles, two functions, grants and policies for them, one replaced trigger function and one dropped check. Rolling the code back leaves
-- functions nothing calls. Numbered 0961: main's highest is 0958, and open work holds 0959 and 0960; re-check right before merge.
-- Neon shape: packages/db/neon-shape.d/0961_follow_up_child_create.conf.

-- ---- roles ----------------------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['follow_up_child_definer', 'follow_up_child_lister'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
      RAISE EXCEPTION 'role % still has a privileged attribute', n;
    END IF;
  END LOOP;
END
$$;

-- ---- 4. a note may be made an item ------------------------------------------------------------------------------------------------------------
ALTER TABLE work_item_follow_ups DROP CONSTRAINT work_item_follow_ups_child_only_for_child;

-- ---- 2. the guard admits the definer ----------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION work_items_follow_up_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.follow_up_id IS NOT NULL AND current_user <> 'follow_up_child_definer' THEN
      RAISE EXCEPTION 'work_items: a follow-up child is created only by the follow-up definer' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.follow_up_id IS DISTINCT FROM OLD.follow_up_id THEN
    RAISE EXCEPTION 'work_items: a follow-up link does not change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- ---- the definer's reach ----------------------------------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO follow_up_child_definer, follow_up_child_lister;
GRANT SELECT (id, deleted_at) ON accounts TO follow_up_child_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO follow_up_child_definer;
GRANT SELECT (account_id, work_item_id) ON work_item_approvals TO follow_up_child_definer;
GRANT SELECT (id, account_id, work_item_id, title, disposition, child_id) ON work_item_follow_ups TO follow_up_child_definer;
GRANT UPDATE (child_id) ON work_item_follow_ups TO follow_up_child_definer;
GRANT SELECT (id, account_id, repo_id, provenance, stage, follow_up_id) ON work_items TO follow_up_child_definer;
GRANT INSERT (account_id, repo_id, kind, provenance, title, parent_id, follow_up_id) ON work_items TO follow_up_child_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO follow_up_child_definer;
CREATE POLICY follow_up_child_definer_select ON accounts FOR SELECT TO follow_up_child_definer
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_child_definer_select ON account_members FOR SELECT TO follow_up_child_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_child_definer_select ON work_item_approvals FOR SELECT TO follow_up_child_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_child_definer_select ON work_item_follow_ups FOR SELECT TO follow_up_child_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_child_definer_update ON work_item_follow_ups FOR UPDATE TO follow_up_child_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_child_definer_select ON work_items FOR SELECT TO follow_up_child_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_child_definer_insert ON work_items FOR INSERT TO follow_up_child_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_child_definer_audit ON audit_log FOR INSERT TO follow_up_child_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'follow_up.made_item');

-- ---- the lister's reach (no tenant in context: it reads across accounts, ids only) -------------------------------------------------------------
GRANT SELECT (id, account_id, work_item_id, disposition, child_id, created_at) ON work_item_follow_ups TO follow_up_child_lister;
GRANT SELECT (id, account_id, stage) ON work_items TO follow_up_child_lister;
GRANT SELECT (account_id, work_item_id) ON work_item_approvals TO follow_up_child_lister;
GRANT SELECT (id, deleted_at, status) ON accounts TO follow_up_child_lister;
CREATE POLICY follow_up_child_lister_select ON work_item_follow_ups FOR SELECT TO follow_up_child_lister USING (disposition = 'child' AND child_id IS NULL);
CREATE POLICY follow_up_child_lister_select ON work_items FOR SELECT TO follow_up_child_lister USING (stage <> 'closed');
CREATE POLICY follow_up_child_lister_select ON work_item_approvals FOR SELECT TO follow_up_child_lister USING (true);
CREATE POLICY follow_up_child_lister_select ON accounts FOR SELECT TO follow_up_child_lister USING (deleted_at IS NULL AND status = 'active');

-- ---- ownership bracket (0960's shape): the migration role holds each role only to hand its functions over ------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['follow_up_child_definer', 'follow_up_child_lister'] LOOP
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot ALTER FUNCTION ... OWNER TO it', r;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', r);
    END IF;
    EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', r);
  END LOOP;
END
$$;

-- ---- 1. follow_up_child_create ----------------------------------------------------------------------------------------------------------------
CREATE FUNCTION follow_up_child_create(p_follow_up uuid)
RETURNS TABLE (o_child_id uuid, o_created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  f      record;
  par    record;
  newid  uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'follow_up_child_create: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'follow_up_child_create: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A person's call is an owner's or an admin's; the sweep's has no person in the session.
  IF usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'follow_up_child_create: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_follow_up IS NULL THEN
    RAISE EXCEPTION 'follow_up_child_create: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('follow_up_child:' || acct::text || ':' || p_follow_up::text, 0));
  SELECT x.work_item_id, x.title, x.disposition, x.child_id INTO f FROM public.work_item_follow_ups x WHERE x.id = p_follow_up AND x.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'follow_up_child_create: not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- A replay answers the child that exists.
  IF f.child_id IS NOT NULL THEN
    RETURN QUERY SELECT f.child_id, false; RETURN;
  END IF;
  IF usr IS NULL AND f.disposition <> 'child' THEN
    RAISE EXCEPTION 'follow_up_not_a_child' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT w.repo_id, w.provenance, w.stage INTO par FROM public.work_items w WHERE w.id = f.work_item_id AND w.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'follow_up_child_create: not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF par.stage = 'closed' THEN
    RAISE EXCEPTION 'parent_closed' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF usr IS NULL AND NOT EXISTS (SELECT 1 FROM public.work_item_approvals a WHERE a.account_id = acct AND a.work_item_id = f.work_item_id) THEN
    RAISE EXCEPTION 'parent_not_approved' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The child and the link in one statement. Conflict on follow_up_id does nothing, so a second maker finds the first's child below.
  WITH made AS (
    INSERT INTO public.work_items (account_id, repo_id, kind, provenance, title, parent_id, follow_up_id)
    VALUES (acct, par.repo_id, 'small', par.provenance, 'Follow-up: ' || rtrim(left(f.title, 109)), f.work_item_id, p_follow_up)
    ON CONFLICT (follow_up_id) WHERE follow_up_id IS NOT NULL DO NOTHING
    RETURNING id
  ), linked AS (
    UPDATE public.work_item_follow_ups u SET child_id = (SELECT id FROM made)
     WHERE u.id = p_follow_up AND u.account_id = acct AND u.child_id IS NULL AND EXISTS (SELECT 1 FROM made)
    RETURNING 1
  )
  SELECT id INTO newid FROM made;
  IF newid IS NULL THEN
    SELECT w.id INTO newid FROM public.work_items w WHERE w.account_id = acct AND w.follow_up_id = p_follow_up;
    RETURN QUERY SELECT newid, false; RETURN;
  END IF;
  IF usr IS NOT NULL THEN
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    VALUES (acct, usr::text, 'follow_up.made_item', jsonb_build_object('follow_up_id', p_follow_up, 'child_id', newid), clock_timestamp());
  END IF;
  RETURN QUERY SELECT newid, true;
END $$;

-- ---- 3. follow_up_child_list_due --------------------------------------------------------------------------------------------------------------
CREATE FUNCTION follow_up_child_list_due(p_limit integer, p_after_created_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL)
RETURNS TABLE (account_id uuid, follow_up_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'follow_up_child_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR (p_after_created_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'follow_up_child_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT f.account_id, f.id, date_trunc('milliseconds', f.created_at)
    FROM public.work_item_follow_ups f
    JOIN public.accounts a ON a.id = f.account_id AND a.deleted_at IS NULL AND a.status = 'active'
    JOIN public.work_items p ON p.account_id = f.account_id AND p.id = f.work_item_id AND p.stage <> 'closed'
   WHERE f.disposition = 'child' AND f.child_id IS NULL
     AND EXISTS (SELECT 1 FROM public.work_item_approvals ap WHERE ap.account_id = f.account_id AND ap.work_item_id = f.work_item_id)
     AND (p_after_created_at IS NULL OR (date_trunc('milliseconds', f.created_at), f.id) > (p_after_created_at, p_after_id))
   ORDER BY date_trunc('milliseconds', f.created_at), f.id
   LIMIT p_limit;
END $$;

-- ---- ownership and EXECUTE ----------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION follow_up_child_create(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION follow_up_child_list_due(integer, timestamptz, uuid) FROM PUBLIC;
ALTER FUNCTION follow_up_child_create(uuid) OWNER TO follow_up_child_definer;
ALTER FUNCTION follow_up_child_list_due(integer, timestamptz, uuid) OWNER TO follow_up_child_lister;
-- EXECUTE after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION follow_up_child_create(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION follow_up_child_list_due(integer, timestamptz, uuid) TO receipt_writer_invoker;

REVOKE CREATE ON SCHEMA public FROM follow_up_child_definer, follow_up_child_lister;
DO $$
DECLARE
  r text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH r IN ARRAY ARRAY['follow_up_child_definer', 'follow_up_child_lister'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', r);
    END LOOP;
  END IF;
END
$$;
