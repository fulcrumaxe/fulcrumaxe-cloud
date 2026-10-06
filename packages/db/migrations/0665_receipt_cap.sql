-- Decision receipts, class 1: the capped run_events writer (D#7 DP3b,
-- corrections DP-C3a and DP-C3b).
--
-- Class-1 receipts never enter decision_receipts (DP-OD5); they are
-- run_events rows, capped per run. This file adds:
--
--   * run_receipt_counts   the per-run counter. The only table in this
--                          design that is ever UPDATEd, so neither evidence
--                          store gains an UPDATE path. Only receipt_writer
--                          may write it, and counts can only go up.
--   * a run_events guard   a row of kind decision_receipt /
--                          decision_receipt_overflow is refused unless
--                          current_user = 'receipt_writer', i.e. inside the
--                          definer below. app_user can INSERT run_events, so
--                          without this a class-1 receipt could be forged.
--   * decision_receipt_write_class1()
--                          SECURITY DEFINER, owned by receipt_writer, EXECUTE
--                          for receipt_writer_invoker only, no actor or
--                          account parameter (same derivation as
--                          decision_receipt_write, DP-C3d).
--
-- Cap: receipts 1-200 each write one run_events row, the 201st writes one
-- decision_receipt_overflow row and sets class1_collapsed = 1, and 202
-- onwards only add 1 to class1_collapsed. The counter is taken with a single
-- INSERT ... ON CONFLICT DO UPDATE, which holds the run's row lock until the
-- transaction ends, so two writers at count 199 produce one overflow row.
-- Concurrent receipt writers are also serialised on that lock while they
-- compute run_events.seq (MAX+1, as every other run_events writer does).
--
-- Numbering: 0664 is reserved for another task.

-- ---------------------------------------------------------------------
-- 1. run_receipt_counts.
-- ---------------------------------------------------------------------
CREATE TABLE run_receipt_counts (
  account_id        uuid NOT NULL,
  run_id            uuid PRIMARY KEY,
  class1_written    integer NOT NULL DEFAULT 0 CHECK (class1_written >= 0),
  class1_collapsed  integer NOT NULL DEFAULT 0 CHECK (class1_collapsed >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_run_receipt_counts_account_id ON run_receipt_counts (account_id);

ALTER TABLE run_receipt_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_receipt_counts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select ON run_receipt_counts FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY receipt_writer_select ON run_receipt_counts FOR SELECT TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY receipt_writer_insert ON run_receipt_counts FOR INSERT TO receipt_writer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY receipt_writer_update ON run_receipt_counts FOR UPDATE TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

GRANT SELECT ON run_receipt_counts TO app_user;
GRANT SELECT, INSERT ON run_receipt_counts TO receipt_writer;
GRANT UPDATE (class1_written, class1_collapsed, updated_at) ON run_receipt_counts TO receipt_writer;

-- Counts only go up, and the identity never changes (for every role).
CREATE FUNCTION run_receipt_counts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    RAISE EXCEPTION 'run_receipt_counts_identity_frozen: account_id and run_id cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.class1_written < OLD.class1_written OR NEW.class1_collapsed < OLD.class1_collapsed THEN
    RAISE EXCEPTION 'run_receipt_counts_count_lowered: a receipt count cannot go down'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER run_receipt_counts_guard BEFORE UPDATE ON run_receipt_counts
  FOR EACH ROW EXECUTE FUNCTION run_receipt_counts_guard();

-- ---------------------------------------------------------------------
-- 2. The run_events guard (class-1 forgery).
-- ---------------------------------------------------------------------
CREATE FUNCTION run_events_receipt_kind_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.kind IN ('decision_receipt', 'decision_receipt_overflow') AND current_user <> 'receipt_writer' THEN
    RAISE EXCEPTION 'run_events_receipt_kind_forbidden: kind % is written only by the receipt writer', NEW.kind
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER run_events_receipt_kind_guard BEFORE INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION run_events_receipt_kind_guard();

-- What the definer needs on run_events: append the two receipt kinds (the
-- policy pins the kind) and read run_id/seq to number the event.
GRANT INSERT ON run_events TO receipt_writer;
GRANT SELECT (run_id, seq) ON run_events TO receipt_writer;
CREATE POLICY receipt_writer_insert ON run_events FOR INSERT TO receipt_writer
  WITH CHECK (
    kind IN ('decision_receipt', 'decision_receipt_overflow')
    AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY receipt_writer_seq_probe ON run_events FOR SELECT TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- 3. Ownership bracket (0663's shape), then the class-1 definer.
-- ---------------------------------------------------------------------
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

CREATE FUNCTION decision_receipt_write_class1(
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

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
