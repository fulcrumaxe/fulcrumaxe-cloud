-- D#483 S5-b2d-2b-0a: the database identity of a follow-up child. 0961 made a child with a parent, a follow-up id and kind `small`, and nothing else; every place that
-- decides "is this a child, which branch, which Spec" reads `planned_pr_key`, so such a child read as a top-level item with no issue. It now gets its own key.
--
--   1. The key is `fu-` plus the first 12 hex characters of its follow_up_id, stamped by the definer at creation and never later. A CHECK makes the database hold
--      it as a pure function of follow_up_id: a row without follow_up_id may not carry a `fu-` key (the prefix is reserved, like fix- and check-); a row with one
--      must carry exactly the derived key (a missing key fails too) and no pinned Spec version (a follow-up child reads its own Spec, never its parent's pinned one).
--      The rows are checked first and the migration stops with a fixed message if one breaks the rule (an admin-made 0961 child has no key); NOT VALID, then VALIDATE.
--   2. work_items_planned_pr_guard (0920) is replaced: an INSERT that sets planned_pr_key is also admitted for follow_up_child_definer, and only when the row sets
--      follow_up_id. Everything else in the body is 0920's, word for word: the key never changes, the pin only moves forward by the approval definer.
--   3. follow_up_child_create is replaced (same signature, owner and grants). Anchor: when the follow-up's item is itself a keyed child, the new child hangs from that
--      item's parent (the root); otherwise from the item. Approval, closed, repo and provenance all read the anchor. Worker mode (no user) now needs the receipt login
--      (a member of receipt_writer_invoker) and refuses a follow-up recorded on a follow-up child as `follow_up_nested`; an owner or admin may still make it an item,
--      anchored at the root. The key and the link are written in one statement; a key already taken under the root answers `follow_up_key_taken` and leaves the
--      follow-up without a child.
--   4. follow_up_child_list_due is replaced: it lists by the same anchor and never lists a follow-up recorded on a follow-up child. Only the anchor (root) must be open,
--      as in the definer: a follow-up recorded on a planned child that has since closed is still made. follow_up_child_lister's row policy on work_items loses its
--      `stage <> 'closed'` clause for that (the role reads ids, keys and the stage only; the function tests the anchor's stage).
--   5. sub_item_anchor_ok is replaced: the selector for "reads its own Spec" is `planned_pr_key IS NULL OR follow_up_id IS NOT NULL`. A planned child whose pin was cleared
--      by 0919's ON DELETE SET NULL still fails closed. Everything else is 0922's, word for word.
--   6. planned_pr_child_lister's row policy gains `follow_up_id IS NULL`, so the planned launch lister never names a follow-up child (the function is not copied).
--
-- New column grants: follow_up_child_definer INSERT (planned_pr_key), SELECT (parent_id, planned_pr_key); follow_up_child_lister SELECT (parent_id, planned_pr_key,
-- follow_up_id); planned_pr_child_lister SELECT (follow_up_id); work_item_approval_definer SELECT (follow_up_id). No function is added, no owner or EXECUTE changes.
-- Expand-only: one CHECK over rows that satisfy it, one guard and three function bodies replaced, one policy. Rolling back: a later migration drops the CHECK and puts the
-- 0961 bodies back. Numbered 0962: #662 holds 0961; re-check against main's highest right before merging. Neon shape: packages/db/neon-shape.d/0962_follow_up_child_identity.conf.

-- ---- 1. the key is a function of the follow-up id ------------------------------------------------------------------------------------------
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM work_items w
   WHERE NOT (CASE WHEN w.follow_up_id IS NULL THEN w.planned_pr_key IS NULL OR w.planned_pr_key !~ '^fu-'
                   ELSE w.planned_pr_key IS NOT DISTINCT FROM 'fu-' || substr(replace(w.follow_up_id::text, '-', ''), 1, 12) AND w.planned_pr_spec_version_id IS NULL END);
  IF n > 0 THEN
    RAISE EXCEPTION '0962: % work item row(s) break the follow-up key rule (a fu- key without a follow-up, or a follow-up child without its derived key); fix them before this constraint can be added', n USING ERRCODE = 'check_violation';
  END IF;
END
$$;
ALTER TABLE work_items ADD CONSTRAINT work_items_follow_up_key CHECK (
  CASE WHEN follow_up_id IS NULL THEN planned_pr_key IS NULL OR planned_pr_key !~ '^fu-'
       ELSE planned_pr_key IS NOT DISTINCT FROM 'fu-' || substr(replace(follow_up_id::text, '-', ''), 1, 12) AND planned_pr_spec_version_id IS NULL END) NOT VALID;
ALTER TABLE work_items VALIDATE CONSTRAINT work_items_follow_up_key;

-- ---- grants and the planned lister's policy -------------------------------------------------------------------------------------------------
GRANT INSERT (planned_pr_key) ON work_items TO follow_up_child_definer;
GRANT SELECT (parent_id, planned_pr_key) ON work_items TO follow_up_child_definer;
GRANT SELECT (parent_id, planned_pr_key, follow_up_id) ON work_items TO follow_up_child_lister;
GRANT SELECT (follow_up_id) ON work_items TO planned_pr_child_lister;
GRANT SELECT (follow_up_id) ON work_items TO work_item_approval_definer;
DROP POLICY follow_up_child_lister_select ON work_items;
CREATE POLICY follow_up_child_lister_select ON work_items FOR SELECT TO follow_up_child_lister USING (true);
DROP POLICY planned_pr_child_lister_select ON work_items;
CREATE POLICY planned_pr_child_lister_select ON work_items FOR SELECT TO planned_pr_child_lister
  USING (planned_pr_key IS NOT NULL AND parent_id IS NOT NULL AND stage = 'triaged' AND follow_up_id IS NULL);

-- ---- 2. the guard admits the follow-up definer for a follow-up row's key ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION work_items_planned_pr_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.planned_pr_key IS NOT NULL OR NEW.planned_pr_spec_version_id IS NOT NULL) AND current_user <> 'work_item_approval_definer'
       AND NOT (current_user = 'follow_up_child_definer' AND NEW.follow_up_id IS NOT NULL) THEN
      RAISE EXCEPTION 'work_items: a planned PR is created only by a person''s approval' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.planned_pr_key IS DISTINCT FROM OLD.planned_pr_key THEN
    RAISE EXCEPTION 'work_items: a planned PR key does not change' USING ERRCODE = 'insufficient_privilege';
  ELSIF NEW.planned_pr_spec_version_id IS DISTINCT FROM OLD.planned_pr_spec_version_id AND NEW.planned_pr_spec_version_id IS NOT NULL THEN
    -- Only the approval's own re-stamp, and only forward: a newer, unerased version of THIS child's parent.
    IF current_user <> 'work_item_approval_definer' OR OLD.planned_pr_spec_version_id IS NULL OR NEW.parent_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.spec_versions n
           JOIN public.spec_versions o ON o.account_id = n.account_id AND o.id = OLD.planned_pr_spec_version_id
          WHERE n.id = NEW.planned_pr_spec_version_id AND n.account_id = NEW.account_id AND n.work_item_id = NEW.parent_id AND o.work_item_id = NEW.parent_id
            AND n.version > o.version AND n.erased_at IS NULL) THEN
      RAISE EXCEPTION 'work_items: a planned PR Spec version only moves forward, by an approval' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---- ownership bracket: the migration role holds each owner only to replace the functions it owns -----------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH r IN ARRAY ARRAY['follow_up_child_definer', 'follow_up_child_lister', 'work_item_approval_definer'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot replace functions it owns', r;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', r);
    END LOOP;
  END IF;
END
$$;

-- ---- 3. follow_up_child_create: key, anchor, nesting, worker-mode pin ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION follow_up_child_create(p_follow_up uuid)
RETURNS TABLE (o_child_id uuid, o_created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  f      record;
  it     record;
  root   uuid;
  par    record;
  newid  uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'follow_up_child_create: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'follow_up_child_create: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A person's call is an owner's or an admin's. With no person in the session the call is the sweep's, and only the receipt login makes it: a web-tier
  -- session with no user set (app_user alone) is refused.
  IF usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'follow_up_child_create: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF usr IS NULL AND NOT pg_has_role(session_user, 'receipt_writer_invoker', 'MEMBER') THEN
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
  SELECT w.parent_id, w.planned_pr_key, w.follow_up_id INTO it FROM public.work_items w WHERE w.id = f.work_item_id AND w.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'follow_up_child_create: not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- A chain of follow-ups has no bound on cost: the sweep never makes a child of a follow-up child's follow-up.
  IF usr IS NULL AND it.follow_up_id IS NOT NULL THEN
    RAISE EXCEPTION 'follow_up_nested' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The anchor: the issue number the child builds on is the root's, so a keyed child's follow-up hangs from that child's parent.
  root := CASE WHEN it.planned_pr_key IS NOT NULL AND it.parent_id IS NOT NULL THEN it.parent_id ELSE f.work_item_id END;
  SELECT w.repo_id, w.provenance, w.stage INTO par FROM public.work_items w WHERE w.id = root AND w.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'follow_up_child_create: not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF par.stage = 'closed' THEN
    RAISE EXCEPTION 'parent_closed' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF usr IS NULL AND NOT EXISTS (SELECT 1 FROM public.work_item_approvals a WHERE a.account_id = acct AND a.work_item_id = root) THEN
    RAISE EXCEPTION 'parent_not_approved' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The child, its key and the link in one statement. A conflict does nothing: on follow_up_id, a second maker finds the first's child below; on the key under the
  -- root, no child exists below and the answer is the fixed code.
  WITH made AS (
    INSERT INTO public.work_items (account_id, repo_id, kind, provenance, title, parent_id, follow_up_id, planned_pr_key)
    VALUES (acct, par.repo_id, 'small', par.provenance, 'Follow-up: ' || rtrim(left(f.title, 109)), root, p_follow_up,
            'fu-' || substr(replace(p_follow_up::text, '-', ''), 1, 12))
    ON CONFLICT DO NOTHING
    RETURNING id
  ), linked AS (
    UPDATE public.work_item_follow_ups u SET child_id = (SELECT id FROM made)
     WHERE u.id = p_follow_up AND u.account_id = acct AND u.child_id IS NULL AND EXISTS (SELECT 1 FROM made)
    RETURNING 1
  )
  SELECT id INTO newid FROM made;
  IF newid IS NULL THEN
    SELECT w.id INTO newid FROM public.work_items w WHERE w.account_id = acct AND w.follow_up_id = p_follow_up;
    IF newid IS NULL THEN
      RAISE EXCEPTION 'follow_up_key_taken' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN QUERY SELECT newid, false; RETURN;
  END IF;
  IF usr IS NOT NULL THEN
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    VALUES (acct, usr::text, 'follow_up.made_item', jsonb_build_object('follow_up_id', p_follow_up, 'child_id', newid), clock_timestamp());
  END IF;
  RETURN QUERY SELECT newid, true;
END $$;

-- ---- 4. follow_up_child_list_due: the same anchor, and no nested follow-up ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION follow_up_child_list_due(p_limit integer, p_after_created_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL)
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
    JOIN public.work_items p ON p.account_id = f.account_id AND p.id = f.work_item_id AND p.follow_up_id IS NULL
    JOIN public.work_items r ON r.account_id = f.account_id AND r.stage <> 'closed'
                            AND r.id = CASE WHEN p.planned_pr_key IS NOT NULL AND p.parent_id IS NOT NULL THEN p.parent_id ELSE p.id END
   WHERE f.disposition = 'child' AND f.child_id IS NULL
     AND EXISTS (SELECT 1 FROM public.work_item_approvals ap WHERE ap.account_id = f.account_id AND ap.work_item_id = r.id)
     AND (p_after_created_at IS NULL OR (date_trunc('milliseconds', f.created_at), f.id) > (p_after_created_at, p_after_id))
   ORDER BY date_trunc('milliseconds', f.created_at), f.id
   LIMIT p_limit;
END $$;

-- ---- 5. sub_item_anchor_ok: a follow-up child reads its own Spec ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sub_item_anchor_ok(p_work_item_id uuid, p_spec_version_id uuid, p_run_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_spec_version_id IS NOT NULL AND p_run_id IS NOT NULL
     AND p_spec_version_id IS NOT DISTINCT FROM (
           SELECT CASE WHEN w.planned_pr_key IS NULL OR w.follow_up_id IS NOT NULL
                       -- Every other item, and a follow-up child: its own newest non-erased Spec version (0906, unchanged).
                       THEN (SELECT s.id FROM public.spec_versions s
                              WHERE s.account_id = w.account_id AND s.work_item_id = w.id AND s.erased_at IS NULL
                              ORDER BY s.version DESC LIMIT 1)
                       -- A planned PR child: the one version of its parent it is pinned to, if that version still exists.
                       ELSE (SELECT s.id FROM public.spec_versions s
                              WHERE s.account_id = w.account_id AND s.id = w.planned_pr_spec_version_id AND s.work_item_id = w.parent_id AND s.erased_at IS NULL)
                  END
             FROM public.work_items w
            WHERE w.id = p_work_item_id AND w.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
     AND EXISTS (SELECT 1 FROM public.agent_runs r
                  WHERE r.id = p_run_id AND r.work_item_id = p_work_item_id AND r.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
$$;

DO $$
DECLARE
  r text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH r IN ARRAY ARRAY['follow_up_child_definer', 'follow_up_child_lister', 'work_item_approval_definer'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', r);
    END LOOP;
  END IF;
END
$$;
