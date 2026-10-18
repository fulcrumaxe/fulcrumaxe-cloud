-- D#601 MEM-8a: the record shape, the promote path and the correction step that the item-sources view and recall (MEM-8b) stand on.
-- Three things, nothing else. No view, no retriever and no route here.
--
--   1. run_context_item_sources    what a run's prompt was given that is NOT a memory entry: a correction note or a handoff note. One row per
--                                  source per run; no text column at all, only the source's id, the sha256 of the text as rendered and whether it
--                                  was cut. run_context_inputs (0833, CX-8b's) keeps its arrays, its CHECKs, its cap of 50 and its GIN index.
--   2. work_item_corrections       "editing" a correction is a superseding correction: its text is never changed (no body UPDATE, the hash CHECK
--                                  and the three definers stay). An edit is a new correction and the old one becomes `superseded`. For a note a
--                                  run already used, two things change on 0780's shape: the applied-shape CHECK also allows applied_at and
--                                  applied_run_id on a `superseded` row, and work_item_correction_decide allows applied -> superseded (an owner or
--                                  admin; the same audit row work_item.correction_superseded with from_status = 'applied'; a second call answers
--                                  'already_decided'). The applied stamps stay. Every other step out of `applied` stays refused.
--   3. memory_promote_receipt      promotes a decision receipt to an `approved` account entry that holds a REFERENCE, never a copy: provenance names the
--                                  receipt and the body is a fixed label made from non-free fields only (`Decision <decision_type> (receipt <first 8
--                                  characters of the id>)`). The receipt's own text is read live at recall (MEM-8b). Owner or admin only; the receipt
--                                  must belong to the caller's account (else no_data_found); a receipt with a live promoted entry is refused with
--                                  `already_promoted` (a partial unique index is the arbiter behind the check). The reference has no foreign key: a
--                                  receipt is append-only for tenants and only removing the account removes it, which removes the entry too.
--
-- Definer pattern as 0759/0771/0780/0793: the new function belongs to memory_definer (NOLOGIN, no members outside this file, pinned search_path,
-- rights re-derived inside, EXECUTE for app_user alone, a refusal for a platform_ops login). memory_definer gains exactly: SELECT on
-- decision_receipts (id, account_id, decision_type) with a tenant row policy for that role, and the one audit action below. platform_ops gains nothing.
-- The audit row of a promote has fixed keys only (entry_id, scope, kind, author_kind, from_status, to_status, version, receipt_id); no text.
--
-- run_context_item_sources row security is 0833's: a member reads its own account's rows and the build step inserts them in the account's own session;
-- nothing updates or deletes (a row goes with its run, ON DELETE CASCADE). At most 6 rows per run (5 correction notes and 1 handoff note), held by a
-- trigger that takes a per-run lock so two concurrent inserts cannot both pass.
--
-- Not an expand-only file: it drops and re-adds one CHECK (widening it) and replaces one function body and one policy. No data is dropped or rewritten.
-- Numbered 0880 (0877 to 0879 are held by other changes); re-check against main's highest right before merging, and migrations merge in number order.

-- ---- 1. run_context_item_sources -------------------------------------------------------------------------------------------
CREATE TABLE run_context_item_sources (
  account_id     uuid NOT NULL,
  run_id         uuid NOT NULL,
  source_kind    text NOT NULL,
  source_id      uuid NOT NULL,
  content_sha256 text NOT NULL,
  cut            boolean NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, run_id, source_kind, source_id),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE,
  CONSTRAINT run_context_item_sources_kind_check CHECK (source_kind IN ('correction', 'handoff')),
  CONSTRAINT run_context_item_sources_hash_check CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION run_context_item_sources_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Two inserts for one run take turns: the second one's count (a fresh statement snapshot) sees the first.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('run_context_item_sources:' || NEW.account_id::text || ':' || NEW.run_id::text, 0));
  IF (SELECT count(*) FROM public.run_context_item_sources s WHERE s.account_id = NEW.account_id AND s.run_id = NEW.run_id) >= 6 THEN
    RAISE EXCEPTION 'run_context_item_sources: a run records at most 6 item sources' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION run_context_item_sources_cap() FROM PUBLIC;
CREATE TRIGGER run_context_item_sources_cap BEFORE INSERT ON run_context_item_sources
  FOR EACH ROW EXECUTE FUNCTION run_context_item_sources_cap();

ALTER TABLE run_context_item_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_context_item_sources FORCE ROW LEVEL SECURITY;

GRANT SELECT (account_id, run_id, source_kind, source_id, content_sha256, cut, recorded_at) ON run_context_item_sources TO app_user;
GRANT INSERT (account_id, run_id, source_kind, source_id, content_sha256, cut) ON run_context_item_sources TO app_user;

CREATE POLICY tenant_isolation_select ON run_context_item_sources FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY tenant_isolation_insert ON run_context_item_sources FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

-- ---- 3 (data side). the promote path's table pieces --------------------------------------------------------------------------
-- One live promoted entry per receipt. "Live" is every status but deleted and superseded, so a retired entry still holds the receipt (restore it).
CREATE UNIQUE INDEX memory_entries_receipt_idx ON memory_entries (account_id, (provenance ->> 'receipt_id'))
  WHERE provenance ? 'receipt_id' AND status NOT IN ('deleted', 'superseded');

GRANT SELECT (id, account_id, decision_type) ON decision_receipts TO memory_definer;
CREATE POLICY memory_definer_select ON decision_receipts FOR SELECT TO memory_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- The one new audit action. The policy is replaced as a whole, with every action 0793 listed plus the new one.
DROP POLICY memory_definer_audit ON audit_log;
CREATE POLICY memory_definer_audit ON audit_log FOR INSERT TO memory_definer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND action IN ('memory.proposed', 'memory.written', 'memory.approved', 'memory.rejected', 'memory.retired', 'memory.reverted',
                   'memory.edited', 'memory.deleted', 'memory.restored', 'memory.receipt_promoted')
  );

-- ---- 2 (data side). the applied-shape CHECK ---------------------------------------------------------------------------------
ALTER TABLE work_item_corrections DROP CONSTRAINT work_item_corrections_applied_shape;
ALTER TABLE work_item_corrections ADD CONSTRAINT work_item_corrections_applied_shape CHECK (
  (applied_at IS NULL OR status IN ('applied', 'superseded')) AND (applied_run_id IS NULL OR status IN ('applied', 'superseded'))
);

-- Second layer behind memory_validate: an entry that names a receipt is exactly the promote path's shape (a decision, account scope, person, the fixed label).
ALTER TABLE memory_entries ADD CONSTRAINT memory_entries_receipt_shape CHECK (
  NOT (provenance ? 'receipt_id')
  OR (kind = 'decision' AND scope = 'account' AND author_kind = 'person' AND body ~ '^Decision [A-Za-z0-9._:/-]{1,128} \(receipt [0-9a-f]{8}\)$')
);

-- ---- ownership brackets (0763's shape) ------------------------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH r IN ARRAY ARRAY['work_item_correction_definer', 'memory_definer'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members m
        WHERE m.roleid = r::regrole AND m.member = current_user::regrole AND m.admin_option
      ) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot replace or create its functions', r;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', r);
    END LOOP;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO work_item_correction_definer;
GRANT CREATE ON SCHEMA public TO memory_definer;

-- ---- decide: applied -> superseded -------------------------------------------------------------------------------------------------
-- 0780's body with two changes: `superseded` is also legal from `applied`, and the audit row carries the note's applied run for that step.
-- Everything else out of `applied` (to accepted or rejected) still answers 'already_decided' and changes nothing; 'proposed' is not a status a person can set.
CREATE OR REPLACE FUNCTION work_item_correction_decide(p_id uuid, p_to_status text, p_via text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  v_role text;
  ts     timestamptz := clock_timestamp();
  cur    record;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'work_item_correction_decide: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'work_item_correction_decide: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL OR p_to_status IS NULL OR p_to_status NOT IN ('accepted', 'rejected', 'superseded') THEN
    RAISE EXCEPTION 'work_item_correction_decide: status is not one a person can set' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_via IS NULL OR p_via NOT IN ('workspace', 'terminal') THEN
    RAISE EXCEPTION 'work_item_correction_decide: decided_via must be workspace or terminal' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The row lock makes two concurrent accepts take turns: the second reads the first's result.
  SELECT c.id, c.work_item_id, c.kind, c.origin, c.status, c.applied_run_id INTO cur
    FROM public.work_item_corrections c WHERE c.id = p_id AND c.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_item_correction_decide: no such correction' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (
       (p_to_status = 'accepted' AND cur.status = 'proposed')
    OR (p_to_status = 'rejected' AND cur.status IN ('proposed', 'accepted'))
    OR (p_to_status = 'superseded' AND cur.status IN ('proposed', 'accepted', 'applied'))
  ) THEN
    RETURN 'already_decided';
  END IF;

  -- applied_at and applied_run_id are not in this SET list: the stamps of a note a run used stay.
  UPDATE public.work_item_corrections
     SET status = p_to_status, decided_by = usr, decided_via = p_via, decided_at = ts, updated_at = ts
   WHERE id = cur.id AND account_id = acct;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'work_item.correction_' || p_to_status,
          jsonb_build_object('correction_id', cur.id, 'work_item_id', cur.work_item_id, 'kind', cur.kind, 'from_status', cur.status,
                             'to_status', p_to_status, 'origin', cur.origin, 'decided_via', p_via,
                             'applied_run_id', CASE WHEN cur.status = 'applied' THEN cur.applied_run_id END),
          ts);
  RETURN 'decided';
END;
$$;

-- ---- memory_promote_receipt --------------------------------------------------------------------------------------------------------------
-- memory_validate: 0793's body with one change, a provenance holding `receipt_id` is refused (invalid_message). Only memory_promote_receipt writes that key.
-- memory_propose and memory_write refuse it, and memory_edit validates the entry's existing provenance, so a promoted entry cannot be edited (retire or
-- delete it and promote again). A table CHECK (above) keeps the key tied to the fixed-label shape as a second layer.
CREATE OR REPLACE FUNCTION memory_validate(p_scope text, p_ref text, p_kind text, p_body text, p_why text, p_author text, p_prov jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ref_bad boolean;
BEGIN
  IF p_scope IS NULL OR p_scope NOT IN ('account', 'repo', 'item', 'role') THEN
    RAISE EXCEPTION 'invalid_message: unknown scope' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  ref_bad := CASE p_scope
       WHEN 'account' THEN p_ref IS NOT NULL
       WHEN 'repo' THEN p_ref IS NULL OR p_ref !~ '^[A-Za-z0-9_=-]{4,100}@[0-9]{1,20}$'
       WHEN 'item' THEN p_ref IS NULL OR p_ref !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       ELSE p_ref IS NULL OR p_ref !~ '^[a-z][a-z0-9_-]{0,63}$'
     END;
  IF ref_bad THEN
    RAISE EXCEPTION 'invalid_message: scope_ref does not fit the scope' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('convention', 'command', 'fact', 'gotcha', 'preference', 'decision') THEN
    RAISE EXCEPTION 'invalid_message: unknown kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_author IS NULL OR p_author NOT IN ('person', 'agent', 'assistant', 'import', 'runner_agent') THEN
    RAISE EXCEPTION 'invalid_message: unknown author_kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_scope = 'account' AND p_author <> 'person' THEN
    RAISE EXCEPTION 'invalid_message: account entries are written by a person' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_body IS NULL OR octet_length(p_body) NOT BETWEEN 1 AND 1024 OR btrim(p_body) = '' THEN
    RAISE EXCEPTION 'invalid_message: body must be 1 to 1024 bytes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_why IS NOT NULL AND octet_length(p_why) > 256 THEN
    RAISE EXCEPTION 'invalid_message: why must be at most 256 bytes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_body ~ '[\x01-\x08\x0b-\x1f\x7f]' OR COALESCE(p_why, '') ~ '[\x01-\x08\x0b-\x1f\x7f]'
     OR position('<<UNTRUSTED EXTERNAL CONTENT>>' IN p_body || COALESCE(p_why, '')) > 0
     OR position('<<END UNTRUSTED>>' IN p_body || COALESCE(p_why, '')) > 0 THEN
    RAISE EXCEPTION 'invalid_message: body or why holds control characters or a fence delimiter' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- receipt_id is not on this list: only memory_promote_receipt, which inserts directly and never calls this, writes that key.
  IF p_prov IS NULL OR jsonb_typeof(p_prov) <> 'object' OR length(p_prov::text) > 4096
     OR p_prov - ARRAY['source_run_id', 'backend', 'model_id', 'input_trust_classes', 'source_commit', 'file_sha', 'source_path', 'evidence'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_message: provenance holds an unknown key or is too large' USING ERRCODE = 'invalid_parameter_value';
  END IF;
END;
$$;

CREATE FUNCTION memory_promote_receipt(p_account_id uuid, p_receipt_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s      record;
  r      record;
  new_id uuid := gen_random_uuid();
  ts     timestamptz := clock_timestamp();
  v_label text;
BEGIN
  SELECT * INTO s FROM public.memory_session('memory_promote_receipt', false);
  IF p_account_id IS NULL OR p_receipt_id IS NULL THEN
    RAISE EXCEPTION 'invalid_message: an account and a receipt are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The account argument must be the session's own: a caller cannot promote on behalf of another account.
  IF p_account_id <> s.acct OR s.member_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'memory_promote_receipt: only an owner or admin of the account promotes a receipt' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT d.id, d.decision_type INTO r FROM public.decision_receipts d WHERE d.id = p_receipt_id AND d.account_id = s.acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'memory_promote_receipt: no such receipt' USING ERRCODE = 'no_data_found';
  END IF;
  -- decision_type is a catalogue key, not free text. A value outside that shape would put unvetted text into the label, so it is refused.
  IF r.decision_type !~ '^[A-Za-z0-9._:/-]{1,128}$' THEN
    RAISE EXCEPTION 'invalid_message: the receipt''s decision type cannot be shown as a label' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_label := 'Decision ' || r.decision_type || ' (receipt ' || substr(r.id::text, 1, 8) || ')';
  -- Two promotes of one receipt take turns; the unique index stays the arbiter behind the check.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('memory_promote_receipt:' || s.acct::text || ':' || p_receipt_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.memory_entries e
              WHERE e.account_id = s.acct AND e.provenance ->> 'receipt_id' = p_receipt_id::text AND e.status NOT IN ('deleted', 'superseded')) THEN
    RAISE EXCEPTION 'already_promoted: that receipt is already a memory entry' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM public.memory_assert_room(s.acct, 'account', NULL, NULL);
  INSERT INTO public.memory_entries (id, account_id, scope, scope_ref, kind, body, why, author_kind, provenance, status, created_by, approved_by, approved_at, version, content_sha256)
  VALUES (new_id, s.acct, 'account', NULL, 'decision', v_label, NULL, 'person', jsonb_build_object('receipt_id', p_receipt_id), 'approved', s.usr, s.usr, ts, 1,
          encode(sha256(convert_to(v_label, 'UTF8')), 'hex'));
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (s.acct, s.usr::text, 'memory.receipt_promoted',
          jsonb_build_object('entry_id', new_id, 'scope', 'account', 'kind', 'decision', 'author_kind', 'person', 'from_status', NULL,
                             'to_status', 'approved', 'version', 1, 'receipt_id', p_receipt_id), ts);
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION work_item_correction_decide(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_promote_receipt(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION memory_promote_receipt(uuid, uuid) OWNER TO memory_definer;
-- EXECUTE after the transfer, to app_user alone (decide keeps its owner and its ACL; the lines are repeated so the file does not depend on that).
GRANT EXECUTE ON FUNCTION work_item_correction_decide(uuid, text, text) TO app_user;
GRANT EXECUTE ON FUNCTION memory_promote_receipt(uuid, uuid) TO app_user;
REVOKE CREATE ON SCHEMA public FROM work_item_correction_definer;
REVOKE CREATE ON SCHEMA public FROM memory_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE work_item_correction_definer FROM CURRENT_USER;
    REVOKE memory_definer FROM CURRENT_USER;
  END IF;
END
$$;
