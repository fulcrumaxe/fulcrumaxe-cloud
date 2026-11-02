-- D#483 S5-b2d-2b: the database half of launching a follow-up child (0961 made it, 0962 gave it its own key). A follow-up child is held to its own short Spec and has no
-- planned PR table, so the planned launch rule (0920) refuses it by design. This migration adds the follow-up launch beside it and changes nothing of the planned one.
--
--   1. follow_up_child_blocker(child, person): the launch rule for a follow-up child, an invoker function every reader calls (the definer below, the sweep,
--      a person's Approve). The FIRST failing check as a fixed code, or NULL. Nothing is stored. The checks are 0920's, with the link check in place of "the child is in
--      the approved Spec" and no sibling wait: not_a_child, child_closed, work_started (a no-op replay), child_orphaned (no parent, or the follow-up row does not name
--      this child under this parent), parent_closed, respec_needs_approval, external_needs_approval, needs_person_approval, parent_no_envelope.
--      `person` is a person's Approve and differs from the dial in three ways: an external child may start; a finished or failed run does not count as started work (a
--      short Spec that did not publish is retried by the person's next Approve, while the dial never relaunches, so there is no paid retry loop); and a child an admin
--      made through "Make it an item" (the 0962 audit row `follow_up.made_item` names it) may start, where the dial answers needs_person_approval: that click is not consent to spend.
--   2. dial_launch_follow_up_child(child, receipt): the dial's launch, owned by dial_start_definer (the same capabilities as dial_launch_child; the function's own
--      checks are what differ). It runs the blocker again at the data and requires the keyed policy receipt written in this same transaction: written on the PARENT,
--      keyed by the child's key, naming the Spec version and the approval of the parent's newest approval. Same envelope, request and audit rules as 0920.
--      Error contract (fixed messages, no argument values): 42501 not permitted; 22023 invalid argument; P0002 not found; 55000 with the code as the message.
--   3. follow_up_child_launch_list_due(limit, after_created_at, after_id): the cross-account list of follow-up children still at `triaged` with no run and no live
--      request, in a live active account whose weekly auto-start limit is above 0, keyset paged, under its own NOLOGIN role. Names (account, child, created_at).
--
-- Expand-only: one role, three functions, grants and policies for them. Rolling the code back leaves functions nothing calls. Numbered 0965: re-check against main's
-- highest right before merging. Neon shape: packages/db/neon-shape.d/0965_follow_up_child_launch.conf.

-- ---- role ------------------------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text := 'follow_up_launch_lister';
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

-- ---- grants and policies --------------------------------------------------------------------------------------------------------------------
-- The definer (and the blocker it runs as an invoker) reads the follow-up row that names the child.
GRANT SELECT (follow_up_id) ON work_items TO dial_start_definer;
GRANT SELECT (id, account_id, work_item_id, child_id) ON work_item_follow_ups TO dial_start_definer;
CREATE POLICY dial_start_definer_select ON work_item_follow_ups FOR SELECT TO dial_start_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- The dial (the definer and the lister) tell a child an admin made from the audit row 0962 wrote for it.
GRANT SELECT (account_id, action, payload) ON audit_log TO dial_start_definer, follow_up_launch_lister;
CREATE POLICY dial_start_definer_made_item ON audit_log FOR SELECT TO dial_start_definer
  USING (action = 'follow_up.made_item' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_launch_lister_made_item ON audit_log FOR SELECT TO follow_up_launch_lister USING (action = 'follow_up.made_item');

GRANT USAGE ON SCHEMA public TO follow_up_launch_lister;
GRANT SELECT (id, account_id, parent_id, follow_up_id, stage, created_at) ON work_items TO follow_up_launch_lister;
GRANT SELECT (id, deleted_at, status) ON accounts TO follow_up_launch_lister;
GRANT SELECT (account_id, scope, version, amount_usd) ON approval_envelopes TO follow_up_launch_lister;
GRANT SELECT (account_id, work_item_id, status) ON agent_runs TO follow_up_launch_lister;
GRANT SELECT (account_id, kind, target_id, state) ON run_action_requests TO follow_up_launch_lister;
CREATE POLICY follow_up_launch_lister_select ON work_items FOR SELECT TO follow_up_launch_lister
  USING (follow_up_id IS NOT NULL AND parent_id IS NOT NULL AND stage = 'triaged');
CREATE POLICY follow_up_launch_lister_select ON accounts FOR SELECT TO follow_up_launch_lister USING (deleted_at IS NULL AND status = 'active');
CREATE POLICY follow_up_launch_lister_select ON approval_envelopes FOR SELECT TO follow_up_launch_lister USING (scope = 'weekly_autostart');
CREATE POLICY follow_up_launch_lister_select ON agent_runs FOR SELECT TO follow_up_launch_lister USING (status <> 'cancelled');
CREATE POLICY follow_up_launch_lister_select ON run_action_requests FOR SELECT TO follow_up_launch_lister
  USING (kind = 'advance_work_item' AND state IN ('accepted', 'claimed'));

-- ---- 1. the launch rule (an invoker function: it runs with the caller's own rows and grants) ---------------------------------------------------
CREATE FUNCTION follow_up_child_blocker(p_child uuid, p_person boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  c        record;
  par      record;
  approved uuid;
  newest   uuid;
BEGIN
  SELECT w.parent_id, w.repo_id, w.provenance, w.stage, w.follow_up_id INTO c FROM public.work_items w WHERE w.id = p_child AND w.account_id = acct;
  IF NOT FOUND OR c.follow_up_id IS NULL THEN
    RETURN 'not_a_child';
  END IF;
  IF c.stage = 'closed' THEN
    RETURN 'child_closed';
  END IF;
  IF c.stage <> 'triaged'
     OR EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.account_id = acct AND r.work_item_id = p_child
                  AND CASE WHEN p_person THEN r.status NOT IN ('succeeded', 'failed', 'timed_out', 'killed_spend', 'refused_spend', 'cancelled') ELSE r.status <> 'cancelled' END)
     OR EXISTS (SELECT 1 FROM public.run_action_requests q WHERE q.account_id = acct AND q.kind = 'advance_work_item' AND q.target_id = p_child AND q.state IN ('accepted', 'claimed')) THEN
    RETURN 'work_started';
  END IF;
  IF c.parent_id IS NULL THEN
    RETURN 'child_orphaned';
  END IF;
  SELECT w.stage, w.repo_id, w.envelope_id INTO par FROM public.work_items w WHERE w.id = c.parent_id AND w.account_id = acct;
  -- The link: the follow-up row names this child, and was recorded on the parent itself or on one of its planned PR children (the parent is the root, C29 2.4).
  IF NOT FOUND OR NOT EXISTS (
       SELECT 1 FROM public.work_item_follow_ups f
        WHERE f.account_id = acct AND f.id = c.follow_up_id AND f.child_id = p_child
          AND (f.work_item_id = c.parent_id OR EXISTS (SELECT 1 FROM public.work_items rec WHERE rec.account_id = acct AND rec.id = f.work_item_id AND rec.parent_id = c.parent_id))) THEN
    RETURN 'child_orphaned';
  END IF;
  IF par.stage = 'closed' OR par.repo_id IS DISTINCT FROM c.repo_id THEN
    RETURN 'parent_closed';
  END IF;
  SELECT a.spec_version_id INTO approved FROM public.work_item_approvals a
   WHERE a.account_id = acct AND a.work_item_id = c.parent_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1;
  SELECT s.id INTO newest FROM public.spec_versions s
   WHERE s.account_id = acct AND s.work_item_id = c.parent_id AND s.erased_at IS NULL ORDER BY s.version DESC LIMIT 1;
  IF approved IS NULL OR approved IS DISTINCT FROM newest THEN
    RETURN 'respec_needs_approval';
  END IF;
  IF NOT p_person AND c.provenance IS DISTINCT FROM 'internal' THEN
    RETURN 'external_needs_approval';
  END IF;
  IF NOT p_person THEN
    IF EXISTS (SELECT 1 FROM public.audit_log a WHERE a.account_id = acct AND a.action = 'follow_up.made_item' AND a.payload ->> 'child_id' = p_child::text) THEN
      RETURN 'needs_person_approval';
    END IF;
  END IF;
  IF par.envelope_id IS NULL THEN
    RETURN 'parent_no_envelope';
  END IF;
  RETURN NULL;
END $$;

-- ---- ownership bracket (0865's shape): the migration role holds each role only to hand its functions over ---------------------------------------
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['dial_start_definer', 'follow_up_launch_lister'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members m WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option
      ) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot ALTER FUNCTION ... OWNER TO it', n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
    END LOOP;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO dial_start_definer, follow_up_launch_lister;

-- ---- 2. the dial's launch of a follow-up child (dial_start_definer) -------------------------------------------------------------------------
CREATE FUNCTION dial_launch_follow_up_child(p_child uuid, p_receipt_id uuid)
RETURNS TABLE (action_id uuid, state text, replayed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  c        record;
  blocker  text;
  d        record;
  appr     record;
  env      uuid;
  cur      record;
  who      text;
  k        text := 'dial:' || p_receipt_id::text;
  r        record;
  new_id   uuid;
  child_env uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'dial_launch_follow_up_child: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct)
     OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'dial_launch_follow_up_child: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_child IS NULL OR p_receipt_id IS NULL THEN
    RAISE EXCEPTION 'dial_launch_follow_up_child: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (SELECT a.status FROM public.accounts a WHERE a.id = acct) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'account_not_active' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The same lock as dial_launch_child and the sweep: one launch of one child at a time.
  PERFORM pg_advisory_xact_lock(hashtextextended('child_launch:' || acct::text || ':' || p_child::text, 0));
  SELECT x.parent_id, x.planned_pr_key INTO c FROM public.work_items x WHERE x.id = p_child AND x.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dial_launch_follow_up_child: work item not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- The launch rule again at the data: the worker's own checks are not trusted.
  blocker := public.follow_up_child_blocker(p_child, false);
  IF blocker IS NOT NULL THEN
    IF blocker = 'not_a_child' THEN
      RAISE EXCEPTION 'dial_launch_follow_up_child: not a follow-up child' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RAISE EXCEPTION '%', blocker USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The receipt: this tenant's, written in THIS transaction, the policy's keyed launch of this child's key on the parent, under the parent's newest approval and the
  -- Spec version that approval names.
  SELECT x.decision_type, x.chosen, x.rejected_alternative, x.actor, x.work_item_id, x.sub_item_key, x.spec_version_id, x.approval_id,
         x.xmin = pg_current_xact_id()::xid AS this_txn
    INTO d FROM public.decision_receipts x WHERE x.id = p_receipt_id AND x.account_id = acct;
  IF NOT FOUND OR NOT d.this_txn THEN
    RAISE EXCEPTION 'receipt_not_in_transaction' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT a.id, a.spec_version_id INTO appr FROM public.work_item_approvals a
   WHERE a.account_id = acct AND a.work_item_id = c.parent_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1;
  IF d.decision_type IS DISTINCT FROM 'launch_sub_item' OR d.chosen NOT IN ('launch', 'announce') OR d.rejected_alternative IS DISTINCT FROM 'wait_for_approval'
     OR d.actor IS DISTINCT FROM 'policy' OR d.work_item_id IS DISTINCT FROM c.parent_id OR d.sub_item_key IS DISTINCT FROM c.planned_pr_key
     OR d.spec_version_id IS DISTINCT FROM appr.spec_version_id OR d.approval_id IS DISTINCT FROM appr.id THEN
    RAISE EXCEPTION 'receipt_mismatch' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The dial acts for the person who confirmed the weekly auto-start limit, as long as they still are an owner or admin (0901).
  SELECT v.id INTO env FROM public.approval_envelopes v WHERE v.account_id = acct AND v.scope = 'weekly_autostart' AND v.version = 1;
  IF env IS NULL THEN
    RAISE EXCEPTION 'autostart_off' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT v.amount_usd, v.created_by INTO cur FROM public.approval_envelopes v WHERE v.account_id = acct AND v.id = env ORDER BY v.version DESC LIMIT 1;
  IF cur.amount_usd <= 0 THEN
    RAISE EXCEPTION 'autostart_off' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = cur.created_by AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'autostart_confirmer_not_admin' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  who := 'session:' || cur.created_by::text;
  -- The child draws on its parent's envelope.
  child_env := public.work_item_set_child_envelope(p_child);

  SELECT q.id, q.state INTO r FROM public.run_action_requests q WHERE q.account_id = acct AND q.requested_by = who AND q.idempotency_key = k;
  IF FOUND THEN
    RETURN QUERY SELECT r.id, r.state, true; RETURN;
  END IF;
  INSERT INTO public.run_action_requests (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash)
  VALUES (acct, 'advance_work_item', p_child, who, 'session', k, 'advance_work_item:' || p_child::text)
  ON CONFLICT DO NOTHING RETURNING id INTO new_id;
  IF new_id IS NULL THEN
    RAISE EXCEPTION 'dial_launch_follow_up_child: concurrent request could not be resolved' USING ERRCODE = 'serialization_failure';
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'policy', 'child_launch.dial',
          jsonb_build_object('parent_id', c.parent_id, 'child_id', p_child, 'key', c.planned_pr_key, 'receipt_id', p_receipt_id, 'action_id', new_id,
                             'envelope_id', child_env, 'on_behalf_of', cur.created_by),
          clock_timestamp());
  RETURN QUERY SELECT new_id, 'accepted'::text, false;
END $$;

-- ---- 3. the launch's cross-account list (follow_up_launch_lister) ---------------------------------------------------------------------------
CREATE FUNCTION follow_up_child_launch_list_due(p_limit integer, p_after_created_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL)
RETURNS TABLE (account_id uuid, child_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'follow_up_child_launch_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR (p_after_created_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'follow_up_child_launch_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT w.account_id, w.id, date_trunc('milliseconds', w.created_at)
    FROM public.work_items w
    JOIN public.accounts a ON a.id = w.account_id AND a.deleted_at IS NULL AND a.status = 'active'
   WHERE w.follow_up_id IS NOT NULL AND w.parent_id IS NOT NULL AND w.stage = 'triaged'
     AND NOT EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.account_id = w.account_id AND r.work_item_id = w.id AND r.status <> 'cancelled')
     AND NOT EXISTS (SELECT 1 FROM public.run_action_requests q WHERE q.account_id = w.account_id AND q.kind = 'advance_work_item' AND q.target_id = w.id AND q.state IN ('accepted', 'claimed'))
     AND NOT EXISTS (SELECT 1 FROM public.audit_log a WHERE a.account_id = w.account_id AND a.action = 'follow_up.made_item' AND a.payload ->> 'child_id' = w.id::text)
     AND (SELECT e.amount_usd FROM public.approval_envelopes e
           WHERE e.account_id = w.account_id AND e.scope = 'weekly_autostart' ORDER BY e.version DESC LIMIT 1) > 0
     AND (p_after_created_at IS NULL OR (date_trunc('milliseconds', w.created_at), w.id) > (p_after_created_at, p_after_id))
   ORDER BY date_trunc('milliseconds', w.created_at), w.id
   LIMIT p_limit;
END $$;

-- ---- ownership and EXECUTE -----------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION follow_up_child_blocker(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION dial_launch_follow_up_child(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION follow_up_child_launch_list_due(integer, timestamptz, uuid) FROM PUBLIC;
ALTER FUNCTION dial_launch_follow_up_child(uuid, uuid) OWNER TO dial_start_definer;
ALTER FUNCTION follow_up_child_launch_list_due(integer, timestamptz, uuid) OWNER TO follow_up_launch_lister;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one. The blocker stays owned by the migration role (the callers run it
-- as themselves): the definer above and app_user, which the receipt login belongs to. platform_ops holds none.
GRANT EXECUTE ON FUNCTION follow_up_child_blocker(uuid, boolean) TO app_user, dial_start_definer;
GRANT EXECUTE ON FUNCTION dial_launch_follow_up_child(uuid, uuid) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION follow_up_child_launch_list_due(integer, timestamptz, uuid) TO receipt_writer_invoker;

REVOKE CREATE ON SCHEMA public FROM dial_start_definer, follow_up_launch_lister;
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['dial_start_definer', 'follow_up_launch_lister'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', n);
    END LOOP;
  END IF;
END
$$;
