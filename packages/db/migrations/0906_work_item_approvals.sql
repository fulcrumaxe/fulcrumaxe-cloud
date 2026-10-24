-- D#483 S5-b2a part 1: a person's approval of a work item is a record, and a person can approve one sub-item of it.
--
-- The sub-item gate (part 2, the driver) reads three facts this migration makes durable and unforgeable:
--
--   1. work_item_approvals: one append-only row for every approval a PERSON gives an item (a proposal approved, a work item approved,
--      an item approved again after its Spec changed). approved_by is a user (NOT NULL, a foreign key to users), so the dial and the
--      system can never be the approver. spec_version_id is the item's current Spec version at the click, resolved INSIDE the
--      definers (a caller never names it); NULL when the item had no Spec yet. Only the two definers of a new role,
--      work_item_approval_definer, write the table; platform_ops gains no privilege on it or on any other table. app_user reads its own
--      tenant's rows and nothing else.
--      Items approved before this migration have no row: they stay as they are today (the gate covers only items that have one).
--   2. approve_proposal (0753's body, unchanged except for one call) has work_item_approval_for_proposal() write the
--      'proposal_approve' row in the same transaction as the approval, so an approved proposal and its row commit or roll back together.
--      That function refuses a direct platform_ops login and is callable by platform_ops alone. A token approval writes no row (no person
--      clicked), so the sub-item gate asks.
--   3. work_item_approval_record(work_item, source): the one writer for 'work_item_approve' and 'reapprove_after_respec'. The
--      caller's session must be an owner or admin (not a token). A repeat of the same approval of the same Spec version is a replay
--      and writes nothing. A re-approval needs an earlier row and a Spec that differs from the one it named.
--   4. decision_receipts gains sub_item_key and spec_version_id, and sub_item_approval_receipt_write() writes the launch_sub_item
--      receipt a person's Approve leaves, with that person as the actor, keyed (work item, decision type, key, Spec version): one
--      row per key per Spec version, so a re-spec makes the earlier approval stop counting and a replay answers the same receipt.
--   5. decision_ask_withdraw_by_id(ask): the card's Approve closes the matching open launch_sub_item ask with the reason
--      'superseded', so the same decision never stays open in two places. It touches only an ask of that type in the caller's own
--      tenant that is still open or overdue.
--
-- Error contract (fixed messages, no argument values): 42501 not permitted; 22023 invalid argument; P0002 not found; 55000 with the
-- code as the message: person_required, parent_not_approved, no_spec, not_respecced.
-- Neon shape: the new role, its privileges and the two receipt_writer functions are declared in
-- packages/db/neon-shape.d/0906_work_item_approvals.conf.
--
-- Expand-only: a new table, two nullable columns, a new index, new functions and column grants. approve_proposal keeps its
-- signature, owner and grants. Rolling the code back leaves rows and functions nothing calls. Numbered above main's highest (0905);
-- re-check against main right before merging. Ownership brackets as in 0753, 0826 and 0901.

-- ---- 1. the table ---------------------------------------------------------------------------------------------------------------
CREATE TABLE work_item_approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id    uuid NOT NULL,
  -- A person, never the dial: NOT NULL and a user row, and no definer below writes anything else.
  approved_by     uuid NOT NULL REFERENCES users (id),
  spec_version_id uuid,
  envelope_id     uuid,
  source          text NOT NULL CONSTRAINT work_item_approvals_source_check
                    CHECK (source IN ('proposal_approve', 'work_item_approve', 'reapprove_after_respec')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, spec_version_id) REFERENCES spec_versions (account_id, id) ON DELETE CASCADE
);
CREATE INDEX work_item_approvals_item_idx ON work_item_approvals (account_id, work_item_id, created_at DESC, id);

ALTER TABLE work_item_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON work_item_approvals FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
-- Append-only: app_user reads, and only the definer role below writes (no UPDATE or DELETE grant to anyone).
GRANT SELECT ON work_item_approvals TO app_user;

-- ---- 2. the definer role --------------------------------------------------------------------------------------------------------------
-- A role of its own, not platform_ops: platform_ops (the web tier's live login) gains no privilege on any table. approve_proposal, which
-- platform_ops owns, only gains a call to the one function below, and that function refuses a direct platform_ops login.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'work_item_approval_definer') THEN
    CREATE ROLE work_item_approval_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE work_item_approval_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'work_item_approval_definer'
             AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role work_item_approval_definer still has a privileged attribute';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO work_item_approval_definer;
GRANT SELECT, INSERT ON work_item_approvals TO work_item_approval_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO work_item_approval_definer;
GRANT SELECT (id, account_id, envelope_id) ON work_items TO work_item_approval_definer;
GRANT SELECT (id, account_id, work_item_id, version, erased_at) ON spec_versions TO work_item_approval_definer;
GRANT SELECT (id, deleted_at) ON accounts TO work_item_approval_definer;
GRANT SELECT (id, account_id, work_item_id) ON agent_runs TO work_item_approval_definer;

CREATE POLICY work_item_approval_definer_select ON work_item_approvals FOR SELECT TO work_item_approval_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_approval_definer_insert ON work_item_approvals FOR INSERT TO work_item_approval_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_approval_definer_select ON account_members FOR SELECT TO work_item_approval_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_approval_definer_select ON work_items FOR SELECT TO work_item_approval_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_approval_definer_select ON spec_versions FOR SELECT TO work_item_approval_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_approval_definer_select ON agent_runs FOR SELECT TO work_item_approval_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_approval_definer_select ON accounts FOR SELECT TO work_item_approval_definer
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'work_item_approval_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on work_item_approval_definer; cannot ALTER FUNCTION ... OWNER TO it';
    END IF;
    GRANT work_item_approval_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO work_item_approval_definer;

-- The one place that decides what an approval row says. `p_by` is a person who is a member of the tenant; `p_source` is fixed by the
-- two definers below. An invoker function: it runs as the definer that calls it, with that definer's privileges.
CREATE FUNCTION work_item_approval_insert(p_work_item_id uuid, p_by uuid, p_source text, p_with_spec boolean)
RETURNS TABLE (o_approval_id uuid, o_spec_version_id uuid, o_replayed boolean)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  env  uuid;
  cur  uuid;
  prev record;
  nid  uuid;
BEGIN
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'work_item_approval: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_by IS NULL OR p_source IS NULL OR p_source NOT IN ('proposal_approve', 'work_item_approve', 'reapprove_after_respec') THEN
    RAISE EXCEPTION 'work_item_approval: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = p_by) THEN
    RAISE EXCEPTION 'work_item_approval: the approver is not a member of this account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('work_item_approval:' || acct::text || ':' || p_work_item_id::text, 0));
  SELECT w.envelope_id INTO env FROM public.work_items w WHERE w.id = p_work_item_id AND w.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_with_spec THEN
    SELECT s.id INTO cur FROM public.spec_versions s
     WHERE s.account_id = acct AND s.work_item_id = p_work_item_id AND s.erased_at IS NULL ORDER BY s.version DESC LIMIT 1;
  END IF;
  SELECT a.id, a.approved_by, a.spec_version_id, a.source INTO prev FROM public.work_item_approvals a
   WHERE a.account_id = acct AND a.work_item_id = p_work_item_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1;
  IF p_source = 'reapprove_after_respec' THEN
    IF prev.id IS NULL THEN
      RAISE EXCEPTION 'parent_not_approved' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF cur IS NULL THEN
      RAISE EXCEPTION 'no_spec' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
  IF prev.id IS NOT NULL AND prev.approved_by = p_by AND prev.source = p_source AND prev.spec_version_id IS NOT DISTINCT FROM cur THEN
    RETURN QUERY SELECT prev.id, cur, true; RETURN;
  END IF;
  IF p_source = 'reapprove_after_respec' AND prev.spec_version_id IS NOT DISTINCT FROM cur THEN
    RAISE EXCEPTION 'not_respecced' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  INSERT INTO public.work_item_approvals (account_id, work_item_id, approved_by, spec_version_id, envelope_id, source)
  VALUES (acct, p_work_item_id, p_by, cur, env, p_source) RETURNING id INTO nid;
  RETURN QUERY SELECT nid, cur, false;
END $$;
REVOKE ALL ON FUNCTION work_item_approval_insert(uuid, uuid, text, boolean) FROM PUBLIC;

-- ---- 3. the work-item approval writer (a signed-in owner or admin) ---------------------------------------------------------------------
CREATE FUNCTION work_item_approval_record(p_work_item_id uuid, p_source text)
RETURNS TABLE (o_approval_id uuid, o_spec_version_id uuid, o_replayed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  mrole text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'work_item_approval_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'work_item_approval_record: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.role INTO mrole FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr;
  IF mrole IS NULL OR mrole NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'work_item_approval_record: owner or admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'person_required' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('work_item_approve', 'reapprove_after_respec') THEN
    RAISE EXCEPTION 'work_item_approval_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY SELECT * FROM public.work_item_approval_insert(p_work_item_id, usr, p_source, true);
END $$;

-- ---- 4. the proposal approval's row (called only by approve_proposal) ------------------------------------------------------------------
-- No Spec lookup: an item just created from a proposal has none. `p_by` is the person approve_proposal decided for: the session's owner or
-- admin; a token approval passes nothing and writes no row.
CREATE FUNCTION work_item_approval_for_proposal(p_work_item_id uuid, p_by uuid)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  nid uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'work_item_approval_for_proposal: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT o_approval_id INTO nid FROM public.work_item_approval_insert(p_work_item_id, p_by, 'proposal_approve', false);
  RETURN nid;
END $$;

-- For the receipt writer below: the Spec version is this item's NEWEST non-erased one and the run is this item's. Read-only; a boolean, no row.
CREATE FUNCTION sub_item_anchor_ok(p_work_item_id uuid, p_spec_version_id uuid, p_run_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_spec_version_id IS NOT NULL AND p_run_id IS NOT NULL
     AND p_spec_version_id IS NOT DISTINCT FROM (
           SELECT s.id FROM public.spec_versions s
            WHERE s.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND s.work_item_id = p_work_item_id AND s.erased_at IS NULL
            ORDER BY s.version DESC LIMIT 1)
     AND EXISTS (SELECT 1 FROM public.agent_runs r
                  WHERE r.id = p_run_id AND r.work_item_id = p_work_item_id AND r.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
$$;

REVOKE ALL ON FUNCTION sub_item_anchor_ok(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION work_item_approval_record(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work_item_approval_for_proposal(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION sub_item_anchor_ok(uuid, uuid, uuid) OWNER TO work_item_approval_definer;
ALTER FUNCTION work_item_approval_record(uuid, text) OWNER TO work_item_approval_definer;
ALTER FUNCTION work_item_approval_for_proposal(uuid, uuid) OWNER TO work_item_approval_definer;
GRANT EXECUTE ON FUNCTION work_item_approval_insert(uuid, uuid, text, boolean) TO work_item_approval_definer;
GRANT EXECUTE ON FUNCTION work_item_approval_record(uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION sub_item_anchor_ok(uuid, uuid, uuid) TO receipt_writer;
GRANT EXECUTE ON FUNCTION work_item_approval_for_proposal(uuid, uuid) TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM work_item_approval_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE work_item_approval_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- approve_proposal: 0753's body plus one call. platform_ops keeps owning it, with the same signature, grants and search_path.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
CREATE OR REPLACE FUNCTION approve_proposal(p_proposal_id uuid, p_work_item_id uuid)
RETURNS TABLE (state text, roadmap_position integer, work_item_id uuid, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr   uuid;
  p     public.proposals;
  pos   integer;
  w_repo  uuid;
  w_stage text;
  w_found boolean;
BEGIN
  usr := public.proposal_decider('approve_proposal');
  IF p_proposal_id IS NULL OR p_work_item_id IS NULL THEN
    RAISE EXCEPTION 'approve_proposal: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_proposal: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- The same call twice (a retry) is the same answer and writes nothing.
  IF p.state = 'approved' AND p.work_item_id = p_work_item_id THEN
    RETURN QUERY SELECT p.state, p.roadmap_position, p.work_item_id, true; RETURN;
  END IF;
  IF p.state <> 'new' THEN
    RAISE EXCEPTION 'not_new' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- E5: the data would refuse it too (proposals_approved_needs_product); this gives the caller the code.
  IF p.owner_process <> 'product' THEN
    RAISE EXCEPTION 'owned_by_internal_loop' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.id = p.repo_id AND r.account_id = acct AND r.installation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'repo_not_connected' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The work item is the caller's argument: it must be this proposal's repo's, and not yet started.
  SELECT true, l.repo_id, l.stage INTO w_found, w_repo, w_stage
    FROM public.proposal_work_item_lookup(p_work_item_id) l;
  IF w_found IS NOT TRUE OR w_repo IS DISTINCT FROM p.repo_id THEN
    RAISE EXCEPTION 'work_item_wrong_repo' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF w_stage IS DISTINCT FROM 'triaged' THEN
    RAISE EXCEPTION 'work_item_wrong_stage' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('proposal_position:' || p.repo_id::text, 0));
  SELECT COALESCE(max(x.roadmap_position), 0) + 1 INTO pos FROM public.proposals x WHERE x.repo_id = p.repo_id;
  BEGIN
    UPDATE public.proposals
       SET state = 'approved', decided_by_user_id = usr, decided_at = now(), roadmap_position = pos,
           work_item_id = p_work_item_id, updated_at = now()
     WHERE id = p.id AND account_id = acct;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'approve_proposal: that work item already belongs to a proposal' USING ERRCODE = 'unique_violation';
  END;
  -- Only a signed-in person's click is a person's approval. A token has no person who clicked, so it writes no row: the sub-item gate then asks
  -- (parent_not_approved), which is the fail-closed answer.
  IF usr IS NOT NULL THEN
    PERFORM public.work_item_approval_for_proposal(p_work_item_id, usr);
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, COALESCE(usr::text, 'token:' || current_setting('app.token_id', true)), 'proposal.approved',
          jsonb_build_object('proposal_id', p.id, 'repo_id', p.repo_id, 'work_item_id', p_work_item_id, 'roadmap_position', pos),
          clock_timestamp());
  RETURN QUERY SELECT 'approved'::text, pos, p_work_item_id, false;
END $$;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

-- ---- 5. the person's launch_sub_item receipt, and the ask's withdrawal by id ---------------------------------------------------------------
ALTER TABLE decision_receipts
  ADD COLUMN sub_item_key text CONSTRAINT decision_receipts_sub_item_key_check CHECK (sub_item_key ~ '^[a-z0-9-]{1,32}$'),
  ADD COLUMN spec_version_id uuid;
ALTER TABLE decision_receipts
  ADD CONSTRAINT decision_receipts_sub_item_needs_spec CHECK ((sub_item_key IS NULL) = (spec_version_id IS NULL)),
  ADD CONSTRAINT decision_receipts_spec_version_fk FOREIGN KEY (account_id, spec_version_id) REFERENCES spec_versions (account_id, id);
CREATE UNIQUE INDEX decision_receipts_sub_item_once
  ON decision_receipts (account_id, work_item_id, decision_type, sub_item_key, spec_version_id) WHERE sub_item_key IS NOT NULL;
-- The only way back to a receipt of this kind from the cloud is the unique index above; the replay branch reads the same columns.
GRANT SELECT (work_item_id, sub_item_key, spec_version_id) ON decision_receipts TO receipt_writer;

-- The sub-item an ask is about, so approving one planned PR can never close a sibling's ask. Nothing raises such an ask yet; the raiser sets it.
ALTER TABLE decision_asks ADD COLUMN sub_item_key text CONSTRAINT decision_asks_sub_item_key_check CHECK (sub_item_key ~ '^[a-z0-9-]{1,32}$');
GRANT SELECT (sub_item_key) ON decision_asks TO receipt_writer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'receipt_writer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on receipt_writer; cannot ALTER FUNCTION ... OWNER TO receipt_writer';
    END IF;
    GRANT receipt_writer TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO receipt_writer;

-- Like decision_receipt_write (0663): no actor, account or user parameter. The actor is the signed-in owner or admin, never `policy`.
-- The run must be this item's and the Spec version its newest non-erased one (sub_item_anchor_ok); the foreign keys keep every id inside the tenant.
CREATE FUNCTION sub_item_approval_receipt_write(
  p_work_item_id uuid, p_sub_item_key text, p_spec_version_id uuid, p_run_id uuid, p_dial_version integer, p_catalogue_version integer
)
RETURNS TABLE (o_id uuid, o_replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_token  text := NULLIF(current_setting('app.token_id', true), '');
  v_user   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_role   text;
  v_id     uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'receipt_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_token IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'receipt_session_required: only a signed-in person approves a sub-item' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.role INTO v_role FROM public.account_members m WHERE m.account_id = v_tenant AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'receipt_forbidden: approving a sub-item needs the owner or admin role' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_spec_version_id IS NULL OR p_run_id IS NULL OR p_sub_item_key IS NULL
     OR p_sub_item_key !~ '^[a-z0-9-]{1,32}$' OR p_dial_version IS NULL OR p_dial_version < 0 OR p_catalogue_version IS NULL OR p_catalogue_version < 1 THEN
    RAISE EXCEPTION 'sub_item_approval_receipt_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT public.sub_item_anchor_ok(p_work_item_id, p_spec_version_id, p_run_id) THEN
    RAISE EXCEPTION 'sub_item_approval_receipt_write: the run or the Spec version is not this work item''s current one' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.decision_receipts
    (account_id, run_id, work_item_id, decision_type, class, chosen, rejected_alternative, dial_version, input_trust_classes,
     actor, catalogue_version, sub_item_key, spec_version_id)
  VALUES
    (v_tenant, p_run_id, p_work_item_id, 'launch_sub_item', 'human_over_the_loop', 'launch', 'wait_for_approval', p_dial_version, '[]'::jsonb,
     v_user::text, p_catalogue_version, p_sub_item_key, p_spec_version_id)
  ON CONFLICT (account_id, work_item_id, decision_type, sub_item_key, spec_version_id) WHERE sub_item_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, false; RETURN;
  END IF;
  SELECT r.id INTO v_id FROM public.decision_receipts r
   WHERE r.account_id = v_tenant AND r.work_item_id = p_work_item_id AND r.decision_type = 'launch_sub_item'
     AND r.sub_item_key = p_sub_item_key AND r.spec_version_id = p_spec_version_id;
  RETURN QUERY SELECT v_id, true;
END $$;

REVOKE ALL ON FUNCTION sub_item_approval_receipt_write(uuid, text, uuid, uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sub_item_approval_receipt_write(uuid, text, uuid, uuid, integer, integer) TO receipt_writer_invoker;
ALTER FUNCTION sub_item_approval_receipt_write(uuid, text, uuid, uuid, integer, integer) OWNER TO receipt_writer;

-- One ask, by id AND sub-item key, only a launch_sub_item ask of the caller's own tenant that is still waiting, only to `superseded`, only by an owner or admin.
-- True when it moved, false when it was already closed or is not such an ask.
CREATE FUNCTION decision_ask_withdraw_by_id(p_ask_id uuid, p_sub_item_key text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tenant uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_token  text := NULLIF(current_setting('app.token_id', true), '');
  v_user   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_role   text;
  v_moved  integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'ask_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_token IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'ask_session_required: only a signed-in person closes an ask' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.role INTO v_role FROM public.account_members m WHERE m.account_id = v_tenant AND m.user_id = v_user;
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'ask_forbidden: closing an ask needs the owner or admin role' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_ask_id IS NULL OR p_sub_item_key IS NULL OR p_sub_item_key !~ '^[a-z0-9-]{1,32}$' THEN
    RAISE EXCEPTION 'decision_ask_withdraw_by_id: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.decision_asks
     SET state = 'withdrawn', withdrawn_reason = 'superseded'
   WHERE id = p_ask_id AND account_id = v_tenant AND decision_type = 'launch_sub_item' AND sub_item_key = p_sub_item_key AND state IN ('open', 'overdue');
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  RETURN v_moved = 1;
END $$;

REVOKE ALL ON FUNCTION decision_ask_withdraw_by_id(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision_ask_withdraw_by_id(uuid, text) TO receipt_writer_invoker;
ALTER FUNCTION decision_ask_withdraw_by_id(uuid, text) OWNER TO receipt_writer;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
