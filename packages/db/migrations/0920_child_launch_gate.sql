-- D#483 S5-b2c-1: the database half of launching a planned PR child. A child (0919) is a work item at `triaged` with a parent, a key and the Spec version it came
-- from. This migration lets the dial, or a person, start one, and keeps every other path out.
--
--   1. planned_pr_child_blocker / planned_pr_child_waiting_on: the one launch rule, as two invoker functions every reader calls (the definer below, the sweep, a
--      person's Approve, the card). The blocker answers the FIRST failing check as a fixed code, or NULL when the child may launch. Nothing is stored: each answer is
--      derived from the rows as they are now, because each can clear (a sibling merges, the envelope is raised, the parent is approved again).
--        child_closed        the child was closed (Close removes it for good)
--        work_started        a run (not a cancelled one) or a live advance request exists, or the child left `triaged`: a no-op replay, not a refusal
--        child_orphaned      the parent was deleted (parent_id is null)
--        parent_closed       the parent is closed, or is not in the child's repo
--        respec_needs_approval  the parent's newest approval does not name its newest unerased Spec version
--        key_not_in_approved_spec  the child's pinned version is not the approved one, or the key is not in that version's table
--        waiting_on_planned_pr  a depends_on sibling's PR has not merged (a person may skip this one)
--        external_needs_approval  the child is not internal (only a person's Approve starts it)
--        parent_no_envelope  the parent has no spend envelope for the child to draw on
--   2. dial_launch_child(child, receipt): the dial's launch. It runs the blocker again at the data, requires the keyed `launch_sub_item` POLICY receipt written in this
--      same transaction (xmin = the current transaction, as 0901), points the child at its parent's envelope, files `advance_work_item` for it under `dial:<receipt>` on
--      behalf of the person who confirmed the weekly auto-start limit, and writes one audit row. SECURITY DEFINER, owned by dial_start_definer, EXECUTE for
--      receipt_writer_invoker only: no route connection reaches it. Error contract (fixed messages, no argument values): 42501 not permitted; 22023 invalid argument;
--      P0002 not found; 55000 with the code as the message: account_not_active, the blocker's codes above, receipt_not_in_transaction, receipt_mismatch, autostart_off,
--      autostart_confirmer_not_admin, parent_no_envelope, envelope_already_set, not_a_child.
--   3. work_item_set_child_envelope(child): owned by envelope_definer, the ONLY writer of a child's envelope_id. It copies the parent's envelope onto a child that
--      has none (a child that already has the parent's is answered as it is), and refuses a started child. EXECUTE for dial_start_definer and for the receipt login's
--      role (the person path) only.
--   4. planned_pr_child_list_due(limit, after_created_at, after_id): the cross-account list of children the gate may look at, keyset paged like 0901's proposal list,
--      under its own NOLOGIN role. Lists a child still at `triaged` with no run and no live advance request whose parent link is set (an orphan is never listed) in a
--      live active account whose weekly auto-start limit is above 0. Names (account, child, created_at) and nothing else.
--   5. R6: a re-approved parent moves its not-yet-started children forward. planned_pr_children_create also re-stamps planned_pr_spec_version_id on each existing child
--      of the parent whose key is in the new table and which never started (stage triaged, no run but a cancelled one, no live advance request). 0919's trigger is
--      replaced to allow exactly that update: by work_item_approval_definer only, and only to a newer, unerased version of the same parent. A child that started, or
--      whose key left the table, keeps its version. Nobody else changes either planned PR column.
--
-- Expand-only: new roles and functions, grants and policies for them, a replaced trigger function and a replaced creator that only add behaviour. Rolling the code back
-- leaves functions nothing calls. Numbered 0920: main's highest is 0919; re-check against main right before merging. Neon shape: packages/db/neon-shape.d/0920_child_launch_gate.conf.

-- ---- roles ----------------------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text := 'planned_pr_child_lister';
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

-- ---- 5. R6: the guard lets the approval definer move a not-started child to a newer version of its own parent --------------------------------
CREATE OR REPLACE FUNCTION work_items_planned_pr_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (NEW.planned_pr_key IS NOT NULL OR NEW.planned_pr_spec_version_id IS NOT NULL) AND current_user <> 'work_item_approval_definer' THEN
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

GRANT SELECT (stage) ON work_items TO work_item_approval_definer;
GRANT UPDATE (planned_pr_spec_version_id) ON work_items TO work_item_approval_definer;
GRANT SELECT (status) ON agent_runs TO work_item_approval_definer;
GRANT SELECT (account_id, kind, target_id, state) ON run_action_requests TO work_item_approval_definer;
CREATE POLICY work_item_approval_definer_update ON work_items FOR UPDATE TO work_item_approval_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_approval_definer_select ON run_action_requests FOR SELECT TO work_item_approval_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- 0919's creator plus the re-stamp (same signature, owner and grants).
CREATE OR REPLACE FUNCTION planned_pr_children_create(p_parent uuid, p_spec_version_id uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  tbl   jsonb;
  newv  integer;
  n     integer;
  par   record;
  made  integer;
BEGIN
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'planned_pr_children_create: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_parent IS NULL OR p_spec_version_id IS NULL THEN
    RAISE EXCEPTION 'planned_pr_children_create: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The version must be this item's own, in this tenant, and not erased: the only table read is the approved version's.
  SELECT s.frontmatter -> 'planned_prs', s.version INTO tbl, newv FROM public.spec_versions s
   WHERE s.id = p_spec_version_id AND s.account_id = acct AND s.work_item_id = p_parent AND s.erased_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'planned_pr_children_create: the Spec version is not this work item''s' USING ERRCODE = 'no_data_found';
  END IF;
  IF tbl IS NULL THEN
    RETURN 0;
  END IF;
  IF jsonb_typeof(tbl) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'planned_prs_invalid' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  n := jsonb_array_length(tbl);
  IF n < 2 THEN
    RETURN 0;
  END IF;
  IF n > 12
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(tbl) e
                 WHERE NOT coalesce(jsonb_typeof(e) = 'object' AND jsonb_typeof(e -> 'key') = 'string' AND jsonb_typeof(e -> 'title') = 'string'
                                    AND (e ->> 'key') ~ '^[a-z0-9-]{1,32}$' AND (e ->> 'key') !~ '^(fix|check)-'
                                    AND char_length(e ->> 'title') BETWEEN 1 AND 120 AND (e ->> 'title') !~ '[[:cntrl:]|`]', false))
     OR (SELECT count(DISTINCT e ->> 'key') FROM jsonb_array_elements(tbl) e) <> n THEN
    RAISE EXCEPTION 'planned_prs_invalid' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT w.repo_id, w.kind, w.provenance INTO par FROM public.work_items w WHERE w.id = p_parent AND w.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.work_items (account_id, repo_id, kind, provenance, title, parent_id, planned_pr_key, planned_pr_spec_version_id)
  SELECT acct, par.repo_id, par.kind, par.provenance, e.v ->> 'title', p_parent, e.v ->> 'key', p_spec_version_id
    FROM jsonb_array_elements(tbl) WITH ORDINALITY AS e (v, ord) ORDER BY e.ord
  ON CONFLICT (account_id, parent_id, planned_pr_key) WHERE planned_pr_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS made = ROW_COUNT;
  -- R6: a child that never started and whose key is in this version moves to it. A started child, and a child whose key left the table, keep the version they have.
  UPDATE public.work_items c SET planned_pr_spec_version_id = p_spec_version_id
   WHERE c.account_id = acct AND c.parent_id = p_parent AND c.planned_pr_key IS NOT NULL
     AND c.stage = 'triaged'
     AND c.planned_pr_key IN (SELECT e ->> 'key' FROM jsonb_array_elements(tbl) e)
     AND EXISTS (SELECT 1 FROM public.spec_versions o WHERE o.account_id = acct AND o.id = c.planned_pr_spec_version_id AND o.work_item_id = p_parent AND o.version < newv)
     AND NOT EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.account_id = acct AND r.work_item_id = c.id AND r.status <> 'cancelled')
     AND NOT EXISTS (SELECT 1 FROM public.run_action_requests q WHERE q.account_id = acct AND q.kind = 'advance_work_item' AND q.target_id = c.id AND q.state IN ('accepted', 'claimed'));
  RETURN made;
END $$;

-- ---- grants and policies the dial's launch reads through -------------------------------------------------------------------------------------
GRANT SELECT (parent_id, provenance, planned_pr_key, planned_pr_spec_version_id) ON work_items TO dial_start_definer;
GRANT SELECT (id, account_id, work_item_id, version, erased_at, frontmatter) ON spec_versions TO dial_start_definer;
GRANT SELECT (id, account_id, work_item_id, spec_version_id, created_at) ON work_item_approvals TO dial_start_definer;
GRANT SELECT (id, account_id, work_item_id, status) ON agent_runs TO dial_start_definer;
GRANT SELECT (sub_item_key, spec_version_id, approval_id) ON decision_receipts TO dial_start_definer;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['spec_versions', 'work_item_approvals', 'agent_runs'] LOOP
    EXECUTE format($p$CREATE POLICY dial_start_definer_select ON %I FOR SELECT TO dial_start_definer
      USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)$p$, t);
  END LOOP;
END
$$;
DROP POLICY dial_start_definer_audit ON audit_log;
CREATE POLICY dial_start_definer_audit ON audit_log FOR INSERT TO dial_start_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND actor = 'policy'
              AND action IN ('proposal.approved', 'run_action.requested', 'child_launch.dial'));

GRANT SELECT (parent_id, planned_pr_key) ON work_items TO envelope_definer;
GRANT SELECT (status) ON agent_runs TO envelope_definer;

GRANT USAGE ON SCHEMA public TO planned_pr_child_lister;
GRANT SELECT (id, account_id, parent_id, planned_pr_key, stage, created_at) ON work_items TO planned_pr_child_lister;
GRANT SELECT (id, deleted_at, status) ON accounts TO planned_pr_child_lister;
GRANT SELECT (account_id, scope, version, amount_usd) ON approval_envelopes TO planned_pr_child_lister;
GRANT SELECT (account_id, work_item_id, status) ON agent_runs TO planned_pr_child_lister;
GRANT SELECT (account_id, kind, target_id, state) ON run_action_requests TO planned_pr_child_lister;
CREATE POLICY planned_pr_child_lister_select ON work_items FOR SELECT TO planned_pr_child_lister
  USING (planned_pr_key IS NOT NULL AND parent_id IS NOT NULL AND stage = 'triaged');
CREATE POLICY planned_pr_child_lister_select ON accounts FOR SELECT TO planned_pr_child_lister USING (deleted_at IS NULL AND status = 'active');
CREATE POLICY planned_pr_child_lister_select ON approval_envelopes FOR SELECT TO planned_pr_child_lister USING (scope = 'weekly_autostart');
CREATE POLICY planned_pr_child_lister_select ON agent_runs FOR SELECT TO planned_pr_child_lister USING (status <> 'cancelled');
CREATE POLICY planned_pr_child_lister_select ON run_action_requests FOR SELECT TO planned_pr_child_lister
  USING (kind = 'advance_work_item' AND state IN ('accepted', 'claimed'));

-- ---- 1. the launch rule (invoker functions: they run with the caller's own rows and grants) -------------------------------------------------
-- The unmerged dependencies of a child, in the order its table lists them. A depends_on key is satisfied only by a sibling (same parent) whose PR merged.
CREATE FUNCTION planned_pr_child_waiting_on(p_child uuid)
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  c    record;
  out  text[];
BEGIN
  SELECT w.parent_id, w.planned_pr_key, w.planned_pr_spec_version_id INTO c FROM public.work_items w WHERE w.id = p_child AND w.account_id = acct;
  IF NOT FOUND OR c.planned_pr_key IS NULL OR c.parent_id IS NULL OR c.planned_pr_spec_version_id IS NULL THEN
    RETURN ARRAY[]::text[];
  END IF;
  SELECT coalesce(array_agg(d.dep ORDER BY d.ord), ARRAY[]::text[]) INTO out
    FROM (
      SELECT dd.dep, dd.ord
        FROM public.spec_versions s,
             LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.frontmatter -> 'planned_prs') = 'array' THEN s.frontmatter -> 'planned_prs' ELSE '[]'::jsonb END) AS e,
             LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e -> 'depends_on') = 'array' THEN e -> 'depends_on' ELSE '[]'::jsonb END) WITH ORDINALITY AS dd (dep, ord)
       WHERE s.id = c.planned_pr_spec_version_id AND s.account_id = acct AND s.work_item_id = c.parent_id AND (e ->> 'key') = c.planned_pr_key
    ) d
   WHERE NOT EXISTS (SELECT 1 FROM public.work_items sib WHERE sib.account_id = acct AND sib.parent_id = c.parent_id AND sib.planned_pr_key = d.dep AND sib.stage = 'merged');
  RETURN out;
END $$;

CREATE FUNCTION planned_pr_child_blocker(p_child uuid, p_skip_waiting boolean DEFAULT false, p_skip_external boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  c      record;
  par    record;
  approved uuid;
  newest uuid;
BEGIN
  SELECT w.parent_id, w.repo_id, w.provenance, w.stage, w.planned_pr_key, w.planned_pr_spec_version_id INTO c
    FROM public.work_items w WHERE w.id = p_child AND w.account_id = acct;
  IF NOT FOUND OR c.planned_pr_key IS NULL THEN
    RETURN 'not_a_child';
  END IF;
  IF c.stage = 'closed' THEN
    RETURN 'child_closed';
  END IF;
  -- Check 9: started is a no-op replay. A cancelled run does not count: a cancelled child launches again on a new Approve.
  IF c.stage <> 'triaged'
     OR EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.account_id = acct AND r.work_item_id = p_child AND r.status <> 'cancelled')
     OR EXISTS (SELECT 1 FROM public.run_action_requests q WHERE q.account_id = acct AND q.kind = 'advance_work_item' AND q.target_id = p_child AND q.state IN ('accepted', 'claimed')) THEN
    RETURN 'work_started';
  END IF;
  -- 1
  IF c.parent_id IS NULL THEN
    RETURN 'child_orphaned';
  END IF;
  -- 2
  SELECT w.stage, w.repo_id, w.envelope_id INTO par FROM public.work_items w WHERE w.id = c.parent_id AND w.account_id = acct;
  IF NOT FOUND THEN
    RETURN 'child_orphaned';
  END IF;
  IF par.stage = 'closed' OR par.repo_id IS DISTINCT FROM c.repo_id THEN
    RETURN 'parent_closed';
  END IF;
  -- 3
  SELECT a.spec_version_id INTO approved FROM public.work_item_approvals a
   WHERE a.account_id = acct AND a.work_item_id = c.parent_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1;
  SELECT s.id INTO newest FROM public.spec_versions s
   WHERE s.account_id = acct AND s.work_item_id = c.parent_id AND s.erased_at IS NULL ORDER BY s.version DESC LIMIT 1;
  IF approved IS NULL OR approved IS DISTINCT FROM newest THEN
    RETURN 'respec_needs_approval';
  END IF;
  -- 4
  IF c.planned_pr_spec_version_id IS DISTINCT FROM approved OR NOT coalesce((
       SELECT bool_or((e ->> 'key') = c.planned_pr_key)
         FROM public.spec_versions s,
              LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.frontmatter -> 'planned_prs') = 'array' THEN s.frontmatter -> 'planned_prs' ELSE '[]'::jsonb END) AS e
        WHERE s.id = approved AND s.account_id = acct AND s.work_item_id = c.parent_id), false) THEN
    RETURN 'key_not_in_approved_spec';
  END IF;
  -- 5
  IF NOT p_skip_waiting AND cardinality(public.planned_pr_child_waiting_on(p_child)) > 0 THEN
    RETURN 'waiting_on_planned_pr';
  END IF;
  -- 6
  IF NOT p_skip_external AND c.provenance IS DISTINCT FROM 'internal' THEN
    RETURN 'external_needs_approval';
  END IF;
  -- 7
  IF par.envelope_id IS NULL THEN
    RETURN 'parent_no_envelope';
  END IF;
  RETURN NULL;
END $$;

-- ---- ownership bracket (0865's shape): the migration role holds each role only to hand its functions over -----------------------------------
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['envelope_definer', 'dial_start_definer', 'planned_pr_child_lister'] LOOP
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
GRANT CREATE ON SCHEMA public TO envelope_definer, dial_start_definer, planned_pr_child_lister;

-- ---- 3. the child's envelope (envelope_definer) -----------------------------------------------------------------------------------------------
CREATE FUNCTION work_item_set_child_envelope(p_child uuid)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  w    record;
  penv uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'work_item_set_child_envelope: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'work_item_set_child_envelope: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A person's launch sets it in the person's own session: an owner or admin only. The dial's has no user in the session.
  IF usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'work_item_set_child_envelope: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_child IS NULL THEN
    RAISE EXCEPTION 'work_item_set_child_envelope: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.parent_id, x.planned_pr_key, x.stage, x.envelope_id INTO w FROM public.work_items x WHERE x.id = p_child AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF w.planned_pr_key IS NULL OR w.parent_id IS NULL THEN
    RAISE EXCEPTION 'not_a_child' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT p.envelope_id INTO penv FROM public.work_items p WHERE p.id = w.parent_id AND p.account_id = acct;
  IF penv IS NULL THEN
    RAISE EXCEPTION 'parent_no_envelope' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF w.envelope_id = penv THEN
    RETURN penv;
  END IF;
  IF w.envelope_id IS NOT NULL THEN
    RAISE EXCEPTION 'envelope_already_set' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF w.stage <> 'triaged' OR EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.account_id = acct AND r.work_item_id = p_child AND r.status <> 'cancelled') THEN
    RAISE EXCEPTION 'work_started' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE public.work_items SET envelope_id = penv WHERE id = p_child AND account_id = acct;
  RETURN penv;
END $$;

-- ---- 2. the dial's launch (dial_start_definer) ------------------------------------------------------------------------------------------------
CREATE FUNCTION dial_launch_child(p_child uuid, p_receipt_id uuid)
RETURNS TABLE (action_id uuid, state text, replayed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  c        record;
  blocker  text;
  d        record;
  appr     uuid;
  env      uuid;
  cur      record;
  who      text;
  k        text := 'dial:' || p_receipt_id::text;
  r        record;
  new_id   uuid;
  child_env uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'dial_launch_child: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct)
     OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'dial_launch_child: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_child IS NULL OR p_receipt_id IS NULL THEN
    RAISE EXCEPTION 'dial_launch_child: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (SELECT a.status FROM public.accounts a WHERE a.id = acct) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'account_not_active' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- One launch of one child at a time (the sweep takes the same lock before it writes the receipt).
  PERFORM pg_advisory_xact_lock(hashtextextended('child_launch:' || acct::text || ':' || p_child::text, 0));
  SELECT x.parent_id, x.planned_pr_key, x.planned_pr_spec_version_id INTO c FROM public.work_items x WHERE x.id = p_child AND x.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dial_launch_child: work item not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- Checks 1 to 4, 6 and 9, again at the data: the worker's own checks are not trusted. (Check 5, the sibling hold, is the sweep's.)
  blocker := public.planned_pr_child_blocker(p_child, true, false);
  IF blocker IS NOT NULL THEN
    IF blocker = 'not_a_child' THEN
      RAISE EXCEPTION 'dial_launch_child: not a planned PR' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RAISE EXCEPTION '%', blocker USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The receipt: this tenant's, written in THIS transaction, the policy's keyed launch of this child's key under its parent's newest approval.
  SELECT x.decision_type, x.chosen, x.rejected_alternative, x.actor, x.work_item_id, x.sub_item_key, x.spec_version_id, x.approval_id,
         x.xmin = pg_current_xact_id()::xid AS this_txn
    INTO d FROM public.decision_receipts x WHERE x.id = p_receipt_id AND x.account_id = acct;
  IF NOT FOUND OR NOT d.this_txn THEN
    RAISE EXCEPTION 'receipt_not_in_transaction' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT a.id INTO appr FROM public.work_item_approvals a
   WHERE a.account_id = acct AND a.work_item_id = c.parent_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1;
  IF d.decision_type IS DISTINCT FROM 'launch_sub_item' OR d.chosen NOT IN ('launch', 'announce') OR d.rejected_alternative IS DISTINCT FROM 'wait_for_approval'
     OR d.actor IS DISTINCT FROM 'policy' OR d.work_item_id IS DISTINCT FROM c.parent_id OR d.sub_item_key IS DISTINCT FROM c.planned_pr_key
     OR d.spec_version_id IS DISTINCT FROM c.planned_pr_spec_version_id OR d.approval_id IS DISTINCT FROM appr THEN
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
    RAISE EXCEPTION 'dial_launch_child: concurrent request could not be resolved' USING ERRCODE = 'serialization_failure';
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'policy', 'child_launch.dial',
          jsonb_build_object('parent_id', c.parent_id, 'child_id', p_child, 'key', c.planned_pr_key, 'receipt_id', p_receipt_id, 'action_id', new_id,
                             'envelope_id', child_env, 'on_behalf_of', cur.created_by),
          clock_timestamp());
  RETURN QUERY SELECT new_id, 'accepted'::text, false;
END $$;

-- ---- 4. the gate's cross-account list (planned_pr_child_lister) -------------------------------------------------------------------------------
CREATE FUNCTION planned_pr_child_list_due(p_limit integer, p_after_created_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL)
RETURNS TABLE (account_id uuid, child_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'planned_pr_child_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR (p_after_created_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'planned_pr_child_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT w.account_id, w.id, date_trunc('milliseconds', w.created_at)
    FROM public.work_items w
    JOIN public.accounts a ON a.id = w.account_id AND a.deleted_at IS NULL AND a.status = 'active'
   WHERE w.planned_pr_key IS NOT NULL AND w.parent_id IS NOT NULL AND w.stage = 'triaged'
     AND NOT EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.account_id = w.account_id AND r.work_item_id = w.id AND r.status <> 'cancelled')
     AND NOT EXISTS (SELECT 1 FROM public.run_action_requests q WHERE q.account_id = w.account_id AND q.kind = 'advance_work_item' AND q.target_id = w.id AND q.state IN ('accepted', 'claimed'))
     AND (SELECT e.amount_usd FROM public.approval_envelopes e
           WHERE e.account_id = w.account_id AND e.scope = 'weekly_autostart' ORDER BY e.version DESC LIMIT 1) > 0
     AND (p_after_created_at IS NULL OR (date_trunc('milliseconds', w.created_at), w.id) > (p_after_created_at, p_after_id))
   ORDER BY date_trunc('milliseconds', w.created_at), w.id
   LIMIT p_limit;
END $$;

-- ---- ownership and EXECUTE ----------------------------------------------------------------------------------------------------------------------
-- The two rule functions stay owned by the migration role (invoker functions the callers run as themselves). Callers: the definer above (dial_start_definer) and the
-- receipt login, which is a member of app_user (a person's Approve, the sweep's pass, the card read). platform_ops holds none.
REVOKE ALL ON FUNCTION planned_pr_child_waiting_on(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION planned_pr_child_blocker(uuid, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION work_item_set_child_envelope(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION dial_launch_child(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION planned_pr_child_list_due(integer, timestamptz, uuid) FROM PUBLIC;
ALTER FUNCTION work_item_set_child_envelope(uuid) OWNER TO envelope_definer;
ALTER FUNCTION dial_launch_child(uuid, uuid) OWNER TO dial_start_definer;
ALTER FUNCTION planned_pr_child_list_due(integer, timestamptz, uuid) OWNER TO planned_pr_child_lister;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION planned_pr_child_waiting_on(uuid) TO app_user, dial_start_definer;
GRANT EXECUTE ON FUNCTION planned_pr_child_blocker(uuid, boolean, boolean) TO app_user, dial_start_definer;
GRANT EXECUTE ON FUNCTION work_item_set_child_envelope(uuid) TO dial_start_definer, receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION dial_launch_child(uuid, uuid) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION planned_pr_child_list_due(integer, timestamptz, uuid) TO receipt_writer_invoker;

REVOKE CREATE ON SCHEMA public FROM envelope_definer, dial_start_definer, planned_pr_child_lister;
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['envelope_definer', 'dial_start_definer', 'planned_pr_child_lister'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', n);
    END LOOP;
  END IF;
END
$$;
