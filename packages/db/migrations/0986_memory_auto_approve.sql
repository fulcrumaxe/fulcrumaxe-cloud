-- D#601 MEM-10: the autonomy dial that approves a low-risk memory proposal without a click.
--
-- The proposal intake runs in the pipeline's userless tenant session, and the only function that moves a proposal to `approved` (memory_decide, 0793)
-- refuses a session with no user. So a dial that approves has to be a function of its own, and it holds in SQL the rules listed below, which are about
-- who may be approved, where, by whom and at what dial version. Two rules live only in the intake's TypeScript and are NOT held here: that the run
-- succeeded, and that a person has not already declined the same text (see the accepted risk below):
--
-- memory_auto_approve(entry, repo, run, dial version, catalogue version) -> the receipt id. It approves ONE proposal and leaves ONE class 2 receipt
-- (decision type memory_auto_approve, actor `policy`, the dial version named), through the existing writer decision_receipt_write and nothing else.
-- The function is owned by memory_auto_approve_definer, a NOLOGIN role with no INSERT on decision_receipts (it is a member of receipt_writer_invoker,
-- whose only privilege is EXECUTE on the receipt definers, 0983's way) and with row policies that let it do exactly one change to memory_entries:
-- a `proposed` fact or command, item or repo scope, written by an agent or an assistant, becomes `approved`.
--
--   * The account comes from the session (app.account_id), never from an argument. A session that carries a person or a token is refused: the actor
--     is the policy, so a person's click can not leave a policy approval and a policy approval can not name a person. approved_by stays NULL; the
--     approval is recorded by the audit row (action memory.approved, actor policy:memory_auto_approve, receipt id and dial version in its payload),
--     so the history reader (memory_history_read, 0900) shows it with no change.
--   * The entry must be this account's, still `proposed` and unexpired, kind fact or command, scope item or repo, author kind agent or assistant (never
--     import or runner_agent: those stay in the queue until a person has opened each one). The author kind is the one the intake stored, derived from the ingest path.
--   * The entry must have been proposed by the named run (provenance.source_run_id), the run must have a work item of this account, and the entry's
--     place must be that work item (item scope) or the repository of the run's work item (repo scope, by its node id and installation). The repository
--     named must be that work item's repository.
--   * The dial must really be raised: the repository's CURRENT memory_auto_approve version must be the one named and must say `announce`. A stale
--     version, a lowered dial or no row (the catalogue default, ask) is refused, so lowering the dial stops new approvals at once.
--   * The memory cap of the place (30 approved per item, 200 per repo, the same caps and the same lock as memory_assert_room) is held here too; an
--     entry that does not fit is refused and stays a proposal.
--   * Receipt and approval are one transaction: if the receipt cannot be written the approval is not made. A second call for the same entry finds it
--     no longer `proposed` and is refused, so a replay writes no second receipt.
--
-- memory_auto_approve_reversal(entry, catalogue version) -> the reversal receipt id, or NULL. The Undo of an auto-approval is the review screen's retire
-- (memory_decide, a person's click); this leaves the receipt of that Undo, through decision_receipt_write_reversal, so its actor is the person whose
-- session called it (never `policy`) and a repeat answers the first receipt. It writes nothing for an entry whose latest approval was not the policy's
-- (NULL), and refuses an entry that is not retired. It reads the approval's audit row and the original receipt, and writes only through the receipt writer.
--
-- Refusals use fixed SQLSTATEs and messages, never an argument value: 42501 not permitted, P0002 nothing eligible, 22023 invalid argument, 54000 the
-- place is full.
--
-- Accepted risk, stated plainly, as shown running as app_user (the application's login, which can execute this function):
--   * The login can set app.user_id to an owner's id and insert the 'announce' dial row itself, because the dial table's policy checks a setting the
--     caller controls. So "a person raised the dial" is only as strong as that setting is, here exactly as for memory_decide.
--   * The function does not check who proposed the entry: it can approve another run's waiting proposal (same account, eligible kind, scope and author
--     kind), as long as the caller names that run and the repository.
--   * It does not check that the run succeeded: it approved a failed run's proposal. The intake refuses that case in TypeScript only.
--   * It does not check whether a person already declined the same text: it approved a previously rejected text. The intake's look-back at declined
--     text is TypeScript only.
--   * A raw memory_propose call skips prepareMemoryText (the secret and fence scan), so a body the intake would have refused can be proposed and then
--     approved by this function. Recall's re-scan at read time still applies to it.
--   * It can name any account the session is set to, since app.account_id is also caller-set; the row policies hold it to that one account.
--   Still true: it cannot forge audit rows of another action or actor, it cannot call the receipt writers directly (no INSERT on the receipt table,
--   and only the definer role may call them), and the dial adds no power to this caller, who can already call memory_decide as an owner and approve
--   any proposal with no dial at all.
--
-- Expand-only: one role, three functions (the third is the review screen's reader), grants and row policies for the role. No column, constraint or existing function changes. Numbered after the
-- migrations held by the open changes (0984, 0985); re-check against the code plane's highest right before merging, migrations merge in number order.

DO $$
DECLARE
  n text := 'memory_auto_approve_definer';
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

-- What the body reads and writes, column by column, each behind a row policy of its own held to the caller's tenant.
GRANT USAGE ON SCHEMA public TO memory_auto_approve_definer;
GRANT SELECT (id, deleted_at) ON accounts TO memory_auto_approve_definer;
GRANT SELECT (id, account_id, scope, scope_ref, kind, author_kind, provenance, status, version, expires_at),
      UPDATE (status, approved_at, expires_at, updated_at) ON memory_entries TO memory_auto_approve_definer;
GRANT SELECT (id, account_id, repo_id) ON work_items TO memory_auto_approve_definer;
GRANT SELECT (id, account_id, work_item_id) ON agent_runs TO memory_auto_approve_definer;
GRANT SELECT (id, account_id, installation_id, gh_node_id) ON repos TO memory_auto_approve_definer;
GRANT SELECT (id, account_id, gh_installation_id) ON installations TO memory_auto_approve_definer;
GRANT SELECT (account_id, repo_id, decision_type, disposition, version) ON decision_settings TO memory_auto_approve_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO memory_auto_approve_definer;
GRANT SELECT (account_id, actor, action, payload, created_at) ON audit_log TO memory_auto_approve_definer;
GRANT SELECT (id, account_id, run_id, dial_version, decision_type) ON decision_receipts TO memory_auto_approve_definer;

CREATE POLICY memory_auto_approve_definer_select ON accounts FOR SELECT TO memory_auto_approve_definer USING (true);
CREATE POLICY memory_auto_approve_definer_select ON memory_entries FOR SELECT TO memory_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- The one change this role can make, whatever a function body says: a proposed fact or command of item or repo scope, written by an agent or an
-- assistant, becomes approved (no person on it), nothing else about it.
CREATE POLICY memory_auto_approve_definer_update ON memory_entries FOR UPDATE TO memory_auto_approve_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND status = 'proposed' AND kind IN ('fact', 'command') AND scope IN ('item', 'repo') AND author_kind IN ('agent', 'assistant')
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND status = 'approved' AND kind IN ('fact', 'command') AND scope IN ('item', 'repo') AND author_kind IN ('agent', 'assistant')
  );
CREATE POLICY memory_auto_approve_definer_select ON work_items FOR SELECT TO memory_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY memory_auto_approve_definer_select ON agent_runs FOR SELECT TO memory_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY memory_auto_approve_definer_select ON repos FOR SELECT TO memory_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY memory_auto_approve_definer_select ON installations FOR SELECT TO memory_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY memory_auto_approve_definer_select ON decision_settings FOR SELECT TO memory_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY memory_auto_approve_definer_audit ON audit_log FOR INSERT TO memory_auto_approve_definer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND action = 'memory.approved' AND actor = 'policy:memory_auto_approve'
  );

CREATE POLICY memory_auto_approve_definer_select ON audit_log FOR SELECT TO memory_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action IN ('memory.approved', 'memory.restored', 'memory.reverted'));
CREATE POLICY memory_auto_approve_definer_select ON decision_receipts FOR SELECT TO memory_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- How the body calls decision_receipt_write without any INSERT grant of its own (0767's way).
GRANT receipt_writer_invoker TO memory_auto_approve_definer;

-- Ownership bracket (0757's shape): a non-superuser migrator needs SET on the role for ALTER ... OWNER TO. Reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'memory_auto_approve_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on memory_auto_approve_definer; cannot ALTER FUNCTION ... OWNER TO memory_auto_approve_definer';
    END IF;
    GRANT memory_auto_approve_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO memory_auto_approve_definer;

CREATE FUNCTION memory_auto_approve(p_entry_id uuid, p_repo_id uuid, p_run_id uuid, p_dial_version integer, p_catalogue_version integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  e        record;
  v_item   uuid;
  v_wi_repo uuid;
  v_node   text;
  v_inst   text;
  v_cur    integer;
  v_disp   text;
  v_cap    integer;
  v_id     uuid;
  ts       timestamptz := clock_timestamp();
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'memory_auto_approve: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'memory_auto_approve: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The actor is the policy: a session that has a person or a token is refused rather than recorded under that name.
  IF NULLIF(current_setting('app.user_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'memory_auto_approve: only a policy session approves this way' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_entry_id IS NULL OR p_repo_id IS NULL OR p_run_id IS NULL OR p_dial_version IS NULL OR p_dial_version < 1
     OR p_catalogue_version IS NULL OR p_catalogue_version < 1 THEN
    RAISE EXCEPTION 'memory_auto_approve: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The row lock makes a second caller wait and then find the entry no longer proposed.
  SELECT m.id, m.scope, m.scope_ref, m.kind, m.author_kind, m.status, m.provenance, m.version, m.expires_at INTO e
    FROM public.memory_entries m WHERE m.id = p_entry_id AND m.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory_auto_approve: no such entry' USING ERRCODE = 'no_data_found';
  END IF;
  IF e.status <> 'proposed' OR e.expires_at IS NULL OR e.expires_at <= now()
     OR e.kind NOT IN ('fact', 'command') OR e.scope NOT IN ('item', 'repo') OR e.author_kind NOT IN ('agent', 'assistant') THEN
    RAISE EXCEPTION 'memory_auto_approve: the entry is not eligible' USING ERRCODE = 'no_data_found';
  END IF;

  -- The run proposed it, and the run's work item is the receipt's.
  IF e.provenance ->> 'source_run_id' IS DISTINCT FROM p_run_id::text THEN
    RAISE EXCEPTION 'memory_auto_approve: the entry is not this run''s' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT a.work_item_id INTO v_item FROM public.agent_runs a WHERE a.account_id = acct AND a.id = p_run_id;
  IF NOT FOUND OR v_item IS NULL THEN
    RAISE EXCEPTION 'memory_auto_approve: the run has no work item' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT w.repo_id INTO v_wi_repo FROM public.work_items w WHERE w.account_id = acct AND w.id = v_item;
  IF NOT FOUND OR v_wi_repo IS DISTINCT FROM p_repo_id THEN
    RAISE EXCEPTION 'memory_auto_approve: the repository is not the work item''s' USING ERRCODE = 'no_data_found';
  END IF;
  IF e.scope = 'item' THEN
    IF e.scope_ref IS DISTINCT FROM v_item::text THEN
      RAISE EXCEPTION 'memory_auto_approve: the entry is not this work item''s' USING ERRCODE = 'no_data_found';
    END IF;
  ELSE
    SELECT r.gh_node_id, i.gh_installation_id::text INTO v_node, v_inst
      FROM public.repos r JOIN public.installations i ON i.account_id = r.account_id AND i.id = r.installation_id
     WHERE r.account_id = acct AND r.id = p_repo_id;
    IF v_node IS NULL OR v_inst IS NULL OR e.scope_ref IS DISTINCT FROM v_node || '@' || v_inst THEN
      RAISE EXCEPTION 'memory_auto_approve: the entry is not this repository''s' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  -- The dial must really be raised, at its current version.
  SELECT s.version, s.disposition INTO v_cur, v_disp FROM public.decision_settings s
   WHERE s.account_id = acct AND s.repo_id = p_repo_id AND s.decision_type = 'memory_auto_approve' ORDER BY s.version DESC LIMIT 1;
  IF NOT FOUND OR v_cur IS DISTINCT FROM p_dial_version OR v_disp IS DISTINCT FROM 'announce' THEN
    RAISE EXCEPTION 'memory_auto_approve: the dial is not raised at that version' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The place's cap, as memory_assert_room holds it (same lock key, same numbers).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('memory_cap:' || acct::text || ':' || e.scope || ':' || COALESCE(e.scope_ref, ''), 0));
  v_cap := CASE e.scope WHEN 'repo' THEN 200 ELSE 30 END;
  IF (SELECT count(*) FROM public.memory_entries x
       WHERE x.account_id = acct AND x.scope = e.scope AND x.scope_ref IS NOT DISTINCT FROM e.scope_ref AND x.status = 'approved' AND x.id <> e.id) >= v_cap THEN
    RAISE EXCEPTION 'memory_full: % scope already holds % approved entries', e.scope, v_cap USING ERRCODE = 'program_limit_exceeded';
  END IF;

  UPDATE public.memory_entries SET status = 'approved', approved_at = ts, expires_at = NULL, updated_at = ts WHERE id = e.id AND account_id = acct;

  -- The receipt: the policy approved, the dial said announce, the alternative was to ask. Written last, so a failure rolls the approval back.
  v_id := public.decision_receipt_write('human_over_the_loop', 'memory_auto_approve', 'announce', 'ask', p_dial_version, '["untrusted"]'::jsonb, v_item, p_run_id, p_catalogue_version);

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'policy:memory_auto_approve', 'memory.approved',
          jsonb_build_object('entry_id', e.id, 'scope', e.scope, 'kind', e.kind, 'author_kind', e.author_kind, 'from_status', 'proposed',
                             'to_status', 'approved', 'version', e.version, 'receipt_id', v_id, 'dial_version', p_dial_version), ts);
  RETURN v_id;
END;
$$;

CREATE FUNCTION memory_auto_approve_reversal(p_entry_id uuid, p_catalogue_version integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr     uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_status text;
  v_actor  text;
  v_payload jsonb;
  v_orig   uuid;
  v_run    uuid;
  v_dial   integer;
  v_id     uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'memory_auto_approve_reversal: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'memory_auto_approve_reversal: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A reversal is a person's: the receipt writer takes the actor from this session and checks the membership.
  IF usr IS NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'memory_auto_approve_reversal: only a member''s session reverses' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_entry_id IS NULL OR p_catalogue_version IS NULL OR p_catalogue_version < 1 THEN
    RAISE EXCEPTION 'memory_auto_approve_reversal: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT m.status INTO v_status FROM public.memory_entries m WHERE m.id = p_entry_id AND m.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory_auto_approve_reversal: no such entry' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status <> 'retired' THEN
    RAISE EXCEPTION 'memory_auto_approve_reversal: the entry is not retired' USING ERRCODE = 'no_data_found';
  END IF;
  -- The latest step that put the entry in force must be the policy's approval; a person's approval or restore after it means nothing to reverse here.
  SELECT a.actor, a.payload INTO v_actor, v_payload FROM public.audit_log a
   WHERE a.account_id = acct AND a.action IN ('memory.approved', 'memory.restored', 'memory.reverted') AND a.payload ->> 'entry_id' = p_entry_id::text
   ORDER BY a.created_at DESC LIMIT 1;
  IF NOT FOUND OR v_actor IS DISTINCT FROM 'policy:memory_auto_approve' THEN
    RETURN NULL;
  END IF;
  v_orig := NULLIF(v_payload ->> 'receipt_id', '')::uuid;
  SELECT r.run_id, r.dial_version INTO v_run, v_dial FROM public.decision_receipts r
   WHERE r.id = v_orig AND r.account_id = acct AND r.decision_type = 'memory_auto_approve';
  IF NOT FOUND OR v_run IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT o_id INTO v_id FROM public.decision_receipt_write_reversal(v_orig, 'reversed', 'reverse_refused', v_dial, v_run, p_catalogue_version);
  RETURN v_id;
END;
$$;

-- The review screen's reader (0653's and 0900's shape: the audit table is read through a function, never from application code). The ids of this
-- account's approved entries that no person approved and whose latest step into force (approved, restored or reverted) is the policy's, approved in
-- the last p_days days (clamped 1..30, NULL means 7). SECURITY INVOKER: the caller's row security and tenant setting apply, and the account is the
-- session's, never an argument. It reads the account's audit rows once per candidate entry, so it grows with the audit log until an index covers it.
CREATE FUNCTION memory_auto_approved_ids(p_days integer DEFAULT 7)
RETURNS TABLE (entry_id uuid)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.id
    FROM public.memory_entries m
   WHERE m.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
     AND m.status = 'approved' AND m.approved_by IS NULL
     AND m.approved_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 7), 1), 30))
     AND (SELECT a.actor FROM public.audit_log a
           WHERE a.account_id = m.account_id AND a.action IN ('memory.approved', 'memory.restored', 'memory.reverted') AND a.payload ->> 'entry_id' = m.id::text
           ORDER BY a.created_at DESC, a.id DESC LIMIT 1) = 'policy:memory_auto_approve'
$$;
REVOKE ALL ON FUNCTION memory_auto_approved_ids(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_auto_approved_ids(integer) TO app_user;

REVOKE ALL ON FUNCTION memory_auto_approve(uuid, uuid, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_auto_approve_reversal(uuid, integer) FROM PUBLIC;
ALTER FUNCTION memory_auto_approve_reversal(uuid, integer) OWNER TO memory_auto_approve_definer;
ALTER FUNCTION memory_auto_approve(uuid, uuid, uuid, integer, integer) OWNER TO memory_auto_approve_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner), to app_user alone.
GRANT EXECUTE ON FUNCTION memory_auto_approve(uuid, uuid, uuid, integer, integer) TO app_user;
GRANT EXECUTE ON FUNCTION memory_auto_approve_reversal(uuid, integer) TO app_user;

REVOKE CREATE ON SCHEMA public FROM memory_auto_approve_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE memory_auto_approve_definer FROM CURRENT_USER;
  END IF;
END
$$;
