-- Class-1 receipt definer: take the run_events seq lock (D#2 RECEIPT-SEQ-LOCK).
--
-- 0665 numbers a receipt's run_events row with MAX(seq)+1 and its header says
-- concurrent receipt writers are serialised on the run_receipt_counts row
-- lock. That holds only between receipt writers. The other run_events writers
-- (the runner's status/agent-output inserts and the discussion comments
-- writer) serialise on a per-run transaction advisory lock instead, so a
-- receipt racing one of them for the same run could compute the same seq and
-- lose on UNIQUE (run_id, seq), dropping a row.
--
-- This replaces decision_receipt_write_class1 with a body identical to 0665's
-- plus one statement: pg_advisory_xact_lock on the same key the TypeScript
-- writers use (hashtextextended('run_events_seq:' || run id, 0)). It sits
-- after the tenant, run-id, catalogue-version and actor checks and before the
-- run_receipt_counts upsert, so every transaction takes the advisory lock
-- first and the counter row second. The TS writers take only the advisory
-- lock (re-entrant within a transaction), so no two orders can deadlock. The
-- 'collapsed' path takes the lock too although it writes no run_events row;
-- that costs one uncontended lock.
--
-- Name, argument types, return type, owner, grants and search_path are
-- unchanged (the DP-C4 exception shape). 0665 is not edited.

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

-- The function already exists and receipt_writer owns it, and CREATE OR REPLACE / REVOKE / GRANT need the
-- owner (0665 created it, so it could run them as the creator). The grant above is SET TRUE, so act as the owner.
SET LOCAL ROLE receipt_writer;

CREATE OR REPLACE FUNCTION decision_receipt_write_class1(
  p_decision_type        text,
  p_chosen               text,
  p_rejected_alternative text,
  p_dial_version         integer,
  p_input_trust_classes  jsonb,
  p_work_item_id         uuid,
  p_run_id               uuid,
  p_catalogue_version    integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_session   text := NULLIF(current_setting('app.user_id', true), '');
  v_actor     text;
  v_collapsed integer;
  v_seq       bigint;
  v_kind      text;
  v_payload   jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'receipt_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'receipt_missing_run_id' USING ERRCODE = 'not_null_violation';
  END IF;
  IF p_catalogue_version IS NULL THEN
    RAISE EXCEPTION 'receipt_missing_catalogue_version' USING ERRCODE = 'not_null_violation';
  END IF;

  IF v_session IS NULL THEN
    v_actor := 'policy';
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.account_members m
       WHERE m.account_id = v_tenant AND m.user_id = v_session::uuid
    ) THEN
      RAISE EXCEPTION 'receipt_actor_not_member: user is not a member of the tenant account'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_actor := v_session;
  END IF;

  -- One lock order for every run_events writer: the per-run advisory lock first, then the counter row.
  -- The key is the one the TypeScript writers use (runStatusWriter.ts, discussions comments.ts).
  PERFORM pg_advisory_xact_lock(hashtextextended('run_events_seq:' || p_run_id::text, 0));

  INSERT INTO public.run_receipt_counts AS c (account_id, run_id, class1_written, class1_collapsed)
  VALUES (v_tenant, p_run_id, 1, 0)
  ON CONFLICT (run_id) DO UPDATE SET
    class1_written   = CASE WHEN c.class1_written < 200 THEN c.class1_written + 1 ELSE c.class1_written END,
    class1_collapsed = CASE WHEN c.class1_written < 200 THEN c.class1_collapsed ELSE c.class1_collapsed + 1 END,
    updated_at       = now()
  RETURNING c.class1_collapsed INTO v_collapsed;

  IF v_collapsed = 0 THEN
    v_kind := 'decision_receipt';
    v_payload := jsonb_build_object(
      'class', 'automated_with_monitoring', 'decision_type', p_decision_type, 'chosen', p_chosen,
      'rejected_alternative', p_rejected_alternative, 'dial_version', p_dial_version,
      'input_trust_classes', p_input_trust_classes, 'work_item_id', p_work_item_id,
      'actor', v_actor, 'catalogue_version', p_catalogue_version);
  ELSIF v_collapsed = 1 THEN
    v_kind := 'decision_receipt_overflow';
    v_payload := jsonb_build_object('cap', 200, 'counter', 'run_receipt_counts');
  ELSE
    RETURN 'collapsed';
  END IF;

  SELECT COALESCE(MAX(e.seq), 0) + 1 INTO v_seq FROM public.run_events e WHERE e.run_id = p_run_id;
  INSERT INTO public.run_events (account_id, run_id, seq, kind, payload)
  VALUES (v_tenant, p_run_id, v_seq, v_kind, v_payload);
  RETURN CASE v_kind WHEN 'decision_receipt' THEN 'written' ELSE 'overflow' END;
END;
$$;

REVOKE ALL ON FUNCTION decision_receipt_write_class1(text, text, text, integer, jsonb, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision_receipt_write_class1(text, text, text, integer, jsonb, uuid, uuid, integer) TO receipt_writer_invoker;
ALTER FUNCTION decision_receipt_write_class1(text, text, text, integer, jsonb, uuid, uuid, integer) OWNER TO receipt_writer;
RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
