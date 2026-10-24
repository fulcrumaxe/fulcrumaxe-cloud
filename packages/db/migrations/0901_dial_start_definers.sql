-- D#483 S5-b1a-1: the start gate's database half. A verified proposal may be approved and started by the person's own dial,
-- without a click, but only through the functions below and only inside the transaction that writes the dial's receipt.
--
-- Who a dial start acts for: the person who confirmed the account's weekly auto-start limit (the current version of the
-- `weekly_autostart` envelope names them in created_by). Their confirmation is what lets anything start on its own. If they
-- are no longer an owner or admin of the account, nothing starts (fail closed) until someone who is confirms the limit again.
--
--   1. proposals.decided_by_kind ('person' or 'dial') and proposals.decision_receipt_id. A dial approval needs a receipt id and
--      a receipt id means a dial approval (CHECKs); one receipt approves at most one proposal (unique index). The receipt id is a
--      plain column, not a foreign key: receipts are pruned after 24 months and the approval keeps the id. A trigger owned by
--      the migration role stamps 'person' on every other approval, clears both columns when a proposal leaves `approved`
--      (withdraw approval), never lets them change on a row that stays approved, and lets only dial_start_definer write 'dial'.
--      An approved row from before this migration keeps NULL, which reads as a person's approval.
--   2. work_item_set_autostart_envelope(work_item): owned by envelope_definer, the one writer of work_items.envelope_id for the
--      weekly envelope (work_item_set_envelope keeps refusing that scope). EXECUTE for dial_start_definer only, which calls it from
--      inside approve_proposal_by_dial after every check below; envelope_definer gains no grant (it reads what 0865 gave it).
--   3. approve_proposal_by_dial(proposal, work_item, receipt) and run_action_request_by_dial(work_item, receipt): owned by a new
--      role, dial_start_definer (NOLOGIN, no members, a member of nothing). EXECUTE for receipt_writer_invoker only: the receipt
--      login's role. app_user (every API route's connection) and platform_ops hold no EXECUTE, so no route can reach them.
--   4. proposal_gate_list_due(limit, after_verified_at, after_id): the cross-account list of proposals the gate may look at,
--      in 0889's shape (its own role, proposal_gate_lister). Keyset paging: a proposal the dial left waiting stays `new`, so a
--      fixed "oldest N" would show the same rows forever.
--
-- What both definers require, at the data: no person and no token in the session (the dial acts, actor `policy`); an account
-- that is not deleted and whose status is `active` (the free preview, a pause, a past-due or cancelled account all refuse); a
-- decision_receipts row of this tenant written IN THIS TRANSACTION (its xmin is the current transaction id; a receipt written
-- under a savepoint does not qualify, which fails closed), of class human_over_the_loop, decision type start_work_small, _bug or
-- _doc, chosen `start`, rejected alternative `wait_for_approval`, actor `policy`, naming this work item. The approval also
-- requires the proposal to be `new`, product-owned, internal, verified or partly verified, its repo connected, the receipt
-- anchored on the proposal's verified_run_id, and the receipt's dial_version to be the repo's CURRENT decision_settings row for
-- that decision type with disposition act or announce (the catalogue default for these types is ask, so version 0 never starts).
--
-- Error contract (fixed messages, no argument values): 42501 not permitted (platform_ops login, no tenant, an inactive account,
-- a person or token in the session); 22023 invalid argument; P0002 not found; 23505 the work item or receipt is already used;
-- 55000 with the code as the message: account_not_active, not_new, dial_withdrawn, owned_by_internal_loop, external_needs_approval, not_checked,
-- repo_not_connected, receipt_not_in_transaction, receipt_mismatch, receipt_wrong_anchor, dial_not_open, work_item_wrong_repo,
-- work_item_wrong_stage, work_started, envelope_already_set, autostart_off, autostart_confirmer_not_admin, not_dial_approved.
--
-- Expand-only: two nullable columns, three CHECKs every existing row meets, new roles and functions, column grants and policies
-- for those roles alone. Rolling the code back leaves functions nothing calls. Numbered 0901 (0900 is main's highest); re-check
-- against main right before merging. Ownership brackets as in 0865 and 0889. Neon shape: the new roles are declared in
-- packages/db/neon-shape.d/0901_dial_start_definers.conf, and envelope_definer's two checks in test-neon-shape.sh name its fifth function.

-- ---- 1. who decided an approval -----------------------------------------------------------------------------------------------------------
-- dial_withdrawn_at / dial_withdrawn_by: a person withdrew an approval the dial had made. While it is set, the dial never approves
-- that proposal again and the gate never lists it; only a person's (or their token's) own approval through approve_proposal clears
-- it. No dial path, and no newer dial version, clears it. dial_withdrawn_by is the session's user, or NULL when a token withdrew; a
-- plain column (no foreign key), as the stamp is a record of who acted.
ALTER TABLE proposals
  ADD COLUMN decided_by_kind text CONSTRAINT proposals_decided_by_kind_check CHECK (decided_by_kind IN ('person', 'dial')),
  ADD COLUMN decision_receipt_id uuid,
  ADD COLUMN dial_withdrawn_at timestamptz,
  ADD COLUMN dial_withdrawn_by uuid;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_dial_needs_receipt CHECK (decided_by_kind IS DISTINCT FROM 'dial' OR decision_receipt_id IS NOT NULL),
  ADD CONSTRAINT proposals_receipt_only_for_dial CHECK (decision_receipt_id IS NULL OR decided_by_kind = 'dial'),
  ADD CONSTRAINT proposals_decided_by_only_when_approved CHECK (decided_by_kind IS NULL OR state = 'approved'),
  ADD CONSTRAINT proposals_dial_withdrawn_by_needs_at CHECK (dial_withdrawn_by IS NULL OR dial_withdrawn_at IS NOT NULL),
  ADD CONSTRAINT proposals_dial_withdrawn_not_approved CHECK (dial_withdrawn_at IS NULL OR state <> 'approved');
CREATE UNIQUE INDEX proposals_receipt_once ON proposals (decision_receipt_id) WHERE decision_receipt_id IS NOT NULL;

DO $$
DECLARE
  n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['dial_start_definer', 'proposal_gate_lister'] LOOP
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

-- Owned by the migration role, never by a definer's role, so no definer can rewrite its own guard. It is the only writer of the
-- withdrawal stamp: no role but a superuser (a migration or a test fixture) may name those columns in a write.
CREATE FUNCTION proposals_decided_by_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  is_super boolean := COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false);
BEGIN
  IF NOT is_super AND (
       (TG_OP = 'INSERT' AND (NEW.dial_withdrawn_at IS NOT NULL OR NEW.dial_withdrawn_by IS NOT NULL))
       OR (TG_OP = 'UPDATE' AND (NEW.dial_withdrawn_at, NEW.dial_withdrawn_by) IS DISTINCT FROM (OLD.dial_withdrawn_at, OLD.dial_withdrawn_by))) THEN
    RAISE EXCEPTION 'proposals: the dial withdrawal stamp is written only by its trigger' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.state <> 'approved' THEN
    -- Withdrawing (or any move out of) a dial approval is remembered, so the next gate pass does not approve it again.
    IF TG_OP = 'UPDATE' AND OLD.state = 'approved' AND OLD.decided_by_kind = 'dial' THEN
      NEW.dial_withdrawn_at := now();
      NEW.dial_withdrawn_by := NULLIF(current_setting('app.user_id', true), '')::uuid;
    END IF;
    NEW.decided_by_kind := NULL;
    NEW.decision_receipt_id := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'approved' THEN
    IF (NEW.decided_by_kind, NEW.decision_receipt_id) IS DISTINCT FROM (OLD.decided_by_kind, OLD.decision_receipt_id) THEN
      RAISE EXCEPTION 'proposals: who decided an approval is never rewritten' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF is_super THEN
    NEW.decided_by_kind := COALESCE(NEW.decided_by_kind, 'person');
    IF NEW.decided_by_kind = 'person' THEN
      NEW.dial_withdrawn_at := NULL;
      NEW.dial_withdrawn_by := NULL;
    END IF;
  ELSIF current_user = 'dial_start_definer' THEN
    IF NEW.decided_by_kind IS DISTINCT FROM 'dial' OR NEW.decision_receipt_id IS NULL THEN
      RAISE EXCEPTION 'proposals: the dial approves only as the dial, with its receipt' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.dial_withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'proposals: a person withdrew the dial approval; only a person approves it again' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.decided_by_kind IS NOT NULL OR NEW.decision_receipt_id IS NOT NULL THEN
    RAISE EXCEPTION 'proposals: only the dial start definer records who decided' USING ERRCODE = 'insufficient_privilege';
  ELSE
    -- A person's own approval (approve_proposal: a session owner or admin, or their token) clears a withdrawal of the dial's.
    NEW.decided_by_kind := 'person';
    NEW.dial_withdrawn_at := NULL;
    NEW.dial_withdrawn_by := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION proposals_decided_by_stamp() FROM PUBLIC;
CREATE TRIGGER proposals_decided_by_stamp BEFORE INSERT OR UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION proposals_decided_by_stamp();

-- ---- 2. grants and policies -----------------------------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO dial_start_definer;
GRANT SELECT (id, deleted_at, status) ON accounts TO dial_start_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO dial_start_definer;
GRANT SELECT (id, account_id, installation_id) ON repos TO dial_start_definer;
GRANT SELECT (id, account_id, repo_id, stage, envelope_id) ON work_items TO dial_start_definer;
GRANT SELECT (id, account_id, repo_id, state, owner_process, provenance, verification, verified_run_id, roadmap_position,
              work_item_id, decided_by_kind, decision_receipt_id, dial_withdrawn_at) ON proposals TO dial_start_definer;
GRANT UPDATE (state, decided_at, roadmap_position, work_item_id, decided_by_kind, decision_receipt_id, updated_at) ON proposals TO dial_start_definer;
GRANT SELECT (id, account_id, run_id, work_item_id, decision_type, class, chosen, rejected_alternative, dial_version, actor, xmin)
  ON decision_receipts TO dial_start_definer;
GRANT SELECT (account_id, repo_id, decision_type, disposition, version) ON decision_settings TO dial_start_definer;
GRANT SELECT (id, account_id, scope, version, amount_usd, created_by) ON approval_envelopes TO dial_start_definer;
GRANT SELECT (id, account_id, kind, target_id, requested_by, idempotency_key, request_hash, state) ON run_action_requests TO dial_start_definer;
GRANT INSERT (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash) ON run_action_requests TO dial_start_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO dial_start_definer;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account_members', 'repos', 'work_items', 'proposals', 'decision_receipts', 'decision_settings', 'approval_envelopes', 'run_action_requests'] LOOP
    EXECUTE format($p$CREATE POLICY dial_start_definer_select ON %I FOR SELECT TO dial_start_definer
      USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)$p$, t);
  END LOOP;
END
$$;
CREATE POLICY dial_start_definer_select ON accounts FOR SELECT TO dial_start_definer
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY dial_start_definer_update ON proposals FOR UPDATE TO dial_start_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND state = 'approved' AND decided_by_kind = 'dial');
CREATE POLICY dial_start_definer_insert ON run_action_requests FOR INSERT TO dial_start_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND kind = 'advance_work_item' AND principal_kind = 'session');
CREATE POLICY dial_start_definer_audit ON audit_log FOR INSERT TO dial_start_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND actor = 'policy'
              AND action IN ('proposal.approved', 'run_action.requested'));

GRANT USAGE ON SCHEMA public TO proposal_gate_lister;
GRANT SELECT (id, account_id, state, owner_process, provenance, verification, verified_run_id, verified_at, dial_withdrawn_at) ON proposals TO proposal_gate_lister;
GRANT SELECT (id, deleted_at, status) ON accounts TO proposal_gate_lister;
GRANT SELECT (account_id, scope, version, amount_usd) ON approval_envelopes TO proposal_gate_lister;
CREATE POLICY proposal_gate_lister_select ON proposals FOR SELECT TO proposal_gate_lister
  USING (state = 'new' AND owner_process = 'product' AND provenance = 'internal' AND verification IN ('verified', 'partly_verified')
         AND verified_run_id IS NOT NULL AND dial_withdrawn_at IS NULL);
CREATE POLICY proposal_gate_lister_select ON accounts FOR SELECT TO proposal_gate_lister USING (deleted_at IS NULL AND status = 'active');
CREATE POLICY proposal_gate_lister_select ON approval_envelopes FOR SELECT TO proposal_gate_lister USING (scope = 'weekly_autostart');

-- ---- ownership bracket (0865's shape): the migration role holds each role only to hand its functions over --------------------------------
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['envelope_definer', 'dial_start_definer', 'proposal_gate_lister'] LOOP
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
GRANT CREATE ON SCHEMA public TO envelope_definer, dial_start_definer, proposal_gate_lister;

-- ---- 3. the weekly envelope's attach helper (envelope_definer) ----------------------------------------------------------------------------
-- Only the dial's approval calls it, after its own checks of the receipt, the limit and the person it acts for. On its own it still
-- refuses a person or a token in the session, a started item and an item that already draws on another envelope.
CREATE FUNCTION work_item_set_autostart_envelope(p_work_item_id uuid)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  w    record;
  env  uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'work_item_set_autostart_envelope: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct)
     OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'work_item_set_autostart_envelope: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL THEN
    RAISE EXCEPTION 'work_item_set_autostart_envelope: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.id, x.stage, x.envelope_id INTO w FROM public.work_items x WHERE x.id = p_work_item_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work item not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT v.id INTO env FROM public.approval_envelopes v WHERE v.account_id = acct AND v.scope = 'weekly_autostart' AND v.version = 1;
  IF env IS NULL THEN
    RAISE EXCEPTION 'autostart_off' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF w.envelope_id = env THEN
    RETURN env;
  END IF;
  IF w.envelope_id IS NOT NULL THEN
    RAISE EXCEPTION 'envelope_already_set' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF w.stage <> 'triaged' OR EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.account_id = acct AND r.work_item_id = p_work_item_id) THEN
    RAISE EXCEPTION 'work_started' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE public.work_items SET envelope_id = env WHERE id = p_work_item_id AND account_id = acct;
  RETURN env;
END $$;

-- ---- 4. the dial's approval (dial_start_definer) ------------------------------------------------------------------------------------------
-- Shared by both definers: the session is the dial's (a tenant, an active account, no person, no token); the receipt is this
-- transaction's start receipt for this work item; and the weekly limit is on (above 0) and was confirmed by someone who is still an
-- owner or admin. Returns the receipt's anchor run, decision type and dial version, the weekly envelope and the person it acts for.
CREATE FUNCTION dial_start_receipt(p_fn text, p_work_item_id uuid, p_receipt_id uuid)
RETURNS TABLE (run_id uuid, decision_type text, dial_version integer, envelope_id uuid, on_behalf_of uuid)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  d    record;
  env  uuid;
  cur  record;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION '%: refused for a platform_ops login', p_fn USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct)
     OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION '%: not permitted', p_fn USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_receipt_id IS NULL THEN
    RAISE EXCEPTION '%: invalid argument', p_fn USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (SELECT a.status FROM public.accounts a WHERE a.id = acct) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'account_not_active' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT x.run_id, x.work_item_id, x.decision_type, x.class, x.chosen, x.rejected_alternative, x.dial_version, x.actor,
         x.xmin = pg_current_xact_id()::xid AS this_txn
    INTO d FROM public.decision_receipts x WHERE x.id = p_receipt_id AND x.account_id = acct;
  IF NOT FOUND OR NOT d.this_txn THEN
    RAISE EXCEPTION 'receipt_not_in_transaction' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF d.class IS DISTINCT FROM 'human_over_the_loop' OR d.decision_type NOT IN ('start_work_small', 'start_work_bug', 'start_work_doc')
     OR d.chosen IS DISTINCT FROM 'start' OR d.rejected_alternative IS DISTINCT FROM 'wait_for_approval'
     OR d.actor IS DISTINCT FROM 'policy' OR d.work_item_id IS DISTINCT FROM p_work_item_id THEN
    RAISE EXCEPTION 'receipt_mismatch' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
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
  RETURN QUERY SELECT d.run_id, d.decision_type, d.dial_version, env, cur.created_by;
END $$;
REVOKE ALL ON FUNCTION dial_start_receipt(text, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION approve_proposal_by_dial(p_proposal_id uuid, p_work_item_id uuid, p_receipt_id uuid)
RETURNS TABLE (state text, roadmap_position integer, work_item_id uuid, envelope_id uuid, replayed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  p    record;
  rc   record;
  w    record;
  env  uuid;
  pos  integer;
BEGIN
  IF p_proposal_id IS NULL THEN
    RAISE EXCEPTION 'approve_proposal_by_dial: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO rc FROM public.dial_start_receipt('approve_proposal_by_dial', p_work_item_id, p_receipt_id);
  SELECT x.id, x.repo_id, x.state, x.owner_process, x.provenance, x.verification, x.verified_run_id, x.roadmap_position, x.work_item_id, x.decision_receipt_id,
         x.dial_withdrawn_at
    INTO p FROM public.proposals x WHERE x.id = p_proposal_id AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_proposal_by_dial: proposal not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p.state = 'approved' AND p.work_item_id = p_work_item_id AND p.decision_receipt_id = p_receipt_id THEN
    RETURN QUERY SELECT p.state, p.roadmap_position, p.work_item_id,
      (SELECT x.envelope_id FROM public.work_items x WHERE x.id = p_work_item_id AND x.account_id = acct), true;
    RETURN;
  END IF;
  -- The hard rules, again at the data: whatever the caller resolved, these never start on their own.
  IF p.state <> 'new' THEN RAISE EXCEPTION 'not_new' USING ERRCODE = 'object_not_in_prerequisite_state'; END IF;
  -- A person withdrew an earlier dial approval of this proposal: only a person approves it again.
  IF p.dial_withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'dial_withdrawn' USING ERRCODE = 'object_not_in_prerequisite_state'; END IF;
  IF p.owner_process <> 'product' THEN RAISE EXCEPTION 'owned_by_internal_loop' USING ERRCODE = 'object_not_in_prerequisite_state'; END IF;
  IF p.provenance <> 'internal' THEN RAISE EXCEPTION 'external_needs_approval' USING ERRCODE = 'object_not_in_prerequisite_state'; END IF;
  IF p.verification NOT IN ('verified', 'partly_verified') OR p.verified_run_id IS NULL THEN
    RAISE EXCEPTION 'not_checked' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.id = p.repo_id AND r.account_id = acct AND r.installation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'repo_not_connected' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The receipt is anchored on the run whose verdict let this proposal start.
  IF rc.run_id IS DISTINCT FROM p.verified_run_id THEN
    RAISE EXCEPTION 'receipt_wrong_anchor' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- The dial the receipt names is the repo's current one for that type, and it starts work.
  IF rc.dial_version IS NULL OR rc.dial_version < 1 OR NOT EXISTS (
       SELECT 1 FROM public.decision_settings s
        WHERE s.account_id = acct AND s.repo_id = p.repo_id AND s.decision_type = rc.decision_type AND s.version = rc.dial_version
          AND s.disposition IN ('act', 'announce'))
     OR EXISTS (
       SELECT 1 FROM public.decision_settings s
        WHERE s.account_id = acct AND s.repo_id = p.repo_id AND s.decision_type = rc.decision_type AND s.version > rc.dial_version) THEN
    RAISE EXCEPTION 'dial_not_open' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT x.repo_id, x.stage INTO w FROM public.work_items x WHERE x.id = p_work_item_id AND x.account_id = acct;
  IF NOT FOUND OR w.repo_id IS DISTINCT FROM p.repo_id THEN
    RAISE EXCEPTION 'work_item_wrong_repo' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF w.stage IS DISTINCT FROM 'triaged' THEN
    RAISE EXCEPTION 'work_item_wrong_stage' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  env := public.work_item_set_autostart_envelope(p_work_item_id);

  PERFORM pg_advisory_xact_lock(hashtextextended('proposal_position:' || p.repo_id::text, 0));
  SELECT COALESCE(max(x.roadmap_position), 0) + 1 INTO pos FROM public.proposals x WHERE x.account_id = acct AND x.repo_id = p.repo_id;
  BEGIN
    UPDATE public.proposals
       SET state = 'approved', decided_at = now(), roadmap_position = pos, work_item_id = p_work_item_id,
           decided_by_kind = 'dial', decision_receipt_id = p_receipt_id, updated_at = now()
     WHERE id = p.id AND account_id = acct;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'approve_proposal_by_dial: that work item or receipt is already used' USING ERRCODE = 'unique_violation';
  END;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'policy', 'proposal.approved',
          jsonb_build_object('proposal_id', p.id, 'repo_id', p.repo_id, 'work_item_id', p_work_item_id, 'roadmap_position', pos,
                             'decided_by_kind', 'dial', 'receipt_id', p_receipt_id, 'envelope_id', env),
          clock_timestamp());
  RETURN QUERY SELECT 'approved'::text, pos, p_work_item_id, env, false;
END $$;

-- ---- 5. the start, on behalf of the person who confirmed the weekly limit (dial_start_definer) --------------------------------------------
CREATE FUNCTION run_action_request_by_dial(p_work_item_id uuid, p_receipt_id uuid)
RETURNS TABLE (action_id uuid, state text, replayed boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  rc     record;
  who    text;
  k      text := 'dial:' || p_receipt_id::text;
  r      record;
  new_id uuid;
BEGIN
  SELECT * INTO rc FROM public.dial_start_receipt('run_action_request_by_dial', p_work_item_id, p_receipt_id);
  IF NOT EXISTS (SELECT 1 FROM public.proposals x
                  WHERE x.account_id = acct AND x.work_item_id = p_work_item_id AND x.state = 'approved'
                    AND x.decided_by_kind = 'dial' AND x.decision_receipt_id = p_receipt_id) THEN
    RAISE EXCEPTION 'not_dial_approved' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF (SELECT x.envelope_id FROM public.work_items x WHERE x.id = p_work_item_id AND x.account_id = acct) IS DISTINCT FROM rc.envelope_id THEN
    RAISE EXCEPTION 'not_dial_approved' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  who := 'session:' || rc.on_behalf_of::text;

  SELECT q.id, q.state INTO r FROM public.run_action_requests q WHERE q.account_id = acct AND q.requested_by = who AND q.idempotency_key = k;
  IF FOUND THEN
    RETURN QUERY SELECT r.id, r.state, true; RETURN;
  END IF;
  SELECT q.id, q.state INTO r FROM public.run_action_requests q
   WHERE q.account_id = acct AND q.kind = 'advance_work_item' AND q.target_id = p_work_item_id AND q.state IN ('accepted', 'claimed');
  IF FOUND THEN
    RETURN QUERY SELECT r.id, r.state, true; RETURN;
  END IF;
  INSERT INTO public.run_action_requests (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash)
  VALUES (acct, 'advance_work_item', p_work_item_id, who, 'session', k, 'advance_work_item:' || p_work_item_id::text)
  ON CONFLICT DO NOTHING RETURNING id INTO new_id;
  IF new_id IS NULL THEN
    RAISE EXCEPTION 'run_action_request_by_dial: concurrent request could not be resolved' USING ERRCODE = 'serialization_failure';
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'policy', 'run_action.requested',
          jsonb_build_object('action_id', new_id, 'kind', 'advance_work_item', 'target_id', p_work_item_id, 'principal_kind', 'session',
                             'on_behalf_of', rc.on_behalf_of, 'receipt_id', p_receipt_id),
          clock_timestamp());
  RETURN QUERY SELECT new_id, 'accepted'::text, false;
END $$;

-- ---- 6. the gate's cross-account list (proposal_gate_lister) ------------------------------------------------------------------------------
-- Names (account, proposal, verified_at) and nothing else. Lists a proposal still `new`, product-owned and internal, verified or
-- partly verified with its run, not withdrawn from the dial by a person, in a live active account whose weekly auto-start limit is above 0. Ordered by (verified_at, id);
-- pass the last row's pair to read the next page. verified_at is cut to whole milliseconds, so the pair survives a JavaScript Date
-- unchanged and a page never repeats its last row. Writes nothing.
CREATE FUNCTION proposal_gate_list_due(p_limit integer, p_after_verified_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL)
RETURNS TABLE (account_id uuid, proposal_id uuid, verified_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'proposal_gate_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR (p_after_verified_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'proposal_gate_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT p.account_id, p.id, date_trunc('milliseconds', p.verified_at)
    FROM public.proposals p
    JOIN public.accounts a ON a.id = p.account_id AND a.deleted_at IS NULL AND a.status = 'active'
   WHERE p.state = 'new' AND p.owner_process = 'product' AND p.provenance = 'internal'
     AND p.verification IN ('verified', 'partly_verified') AND p.verified_run_id IS NOT NULL AND p.dial_withdrawn_at IS NULL
     AND (SELECT e.amount_usd FROM public.approval_envelopes e
           WHERE e.account_id = p.account_id AND e.scope = 'weekly_autostart' ORDER BY e.version DESC LIMIT 1) > 0
     AND (p_after_verified_at IS NULL OR (date_trunc('milliseconds', p.verified_at), p.id) > (p_after_verified_at, p_after_id))
   ORDER BY date_trunc('milliseconds', p.verified_at), p.id
   LIMIT p_limit;
END $$;

-- ---- ownership and EXECUTE --------------------------------------------------------------------------------------------------------------
-- receipt_writer_invoker: 0663 describes it as holding EXECUTE on the receipt definers only, and 0767 made runner_auto_approve_definer
-- a member so its body can write receipts. From here the role also holds EXECUTE on the three dial functions below, so the receipt
-- login (its intended caller) and runner_auto_approve_definer both inherit it. That is acceptable: runner_auto_approve_definer is a
-- NOLOGIN role whose only code is its own fixed function bodies, none of which calls these functions, and every dial function refuses
-- a session with a person or token in it and re-checks its facts at the data. 0889 widened agent_run_writer's EXECUTE the same way.
REVOKE ALL ON FUNCTION work_item_set_autostart_envelope(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_proposal_by_dial(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION run_action_request_by_dial(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION proposal_gate_list_due(integer, timestamptz, uuid) FROM PUBLIC;
ALTER FUNCTION work_item_set_autostart_envelope(uuid) OWNER TO envelope_definer;
ALTER FUNCTION approve_proposal_by_dial(uuid, uuid, uuid) OWNER TO dial_start_definer;
ALTER FUNCTION run_action_request_by_dial(uuid, uuid) OWNER TO dial_start_definer;
ALTER FUNCTION proposal_gate_list_due(integer, timestamptz, uuid) OWNER TO proposal_gate_lister;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one. The shared receipt check
-- stays owned by the migration role (an invoker function its definers call as themselves).
GRANT EXECUTE ON FUNCTION work_item_set_autostart_envelope(uuid) TO dial_start_definer;
GRANT EXECUTE ON FUNCTION dial_start_receipt(text, uuid, uuid) TO dial_start_definer;
GRANT EXECUTE ON FUNCTION approve_proposal_by_dial(uuid, uuid, uuid) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION run_action_request_by_dial(uuid, uuid) TO receipt_writer_invoker;
GRANT EXECUTE ON FUNCTION proposal_gate_list_due(integer, timestamptz, uuid) TO receipt_writer_invoker;

REVOKE CREATE ON SCHEMA public FROM envelope_definer, dial_start_definer, proposal_gate_lister;
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['envelope_definer', 'dial_start_definer', 'proposal_gate_lister'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', n);
    END LOOP;
  END IF;
END
$$;
