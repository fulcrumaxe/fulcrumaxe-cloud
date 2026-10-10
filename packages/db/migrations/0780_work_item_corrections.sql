-- D#597 CC-1: corrections. A correction is something a person (or, later, an agent's proposal the person decides on) says about a work
-- item in flight: a question, a note for the next run, a Spec amendment, a new item, a pause, a priority change. This file is the data
-- model only; the routes, the delivery of amendments and notes, and the driver's attach step come in later changes.
--
--   work_item_corrections          one row per correction. The body and its content hash are written once and never updated; the
--                                  status and its decision stamps move along a short, fixed set of legal steps (below).
--   work_item_correction_create    a member records a correction as `proposed`.
--   work_item_correction_decide    an owner or admin accepts, rejects or supersedes it.
--   work_item_correction_mark_applied
--                                  stamps an accepted correction as applied (a run note names the run that used it).
--
-- Legal status steps:   proposed -> accepted | rejected | superseded      accepted -> applied | rejected | superseded
-- `applied`, `rejected` and `superseded` are final. Rejecting an accepted correction is allowed until it is applied; after that the
-- stamp stays, because the run already used it, and the fix is a new correction.
--
-- Audit. Every write goes through one of the three functions, and each writes its audit_log row in the same transaction as the table
-- change, so a status change and its audit row cannot come apart, and a call that changes nothing writes nothing. The row's action is
-- work_item.correction_<new status>; its payload has fixed keys only (correction_id, work_item_id, kind, from_status, to_status,
-- origin, decided_via, applied_run_id). The correction's text is never copied into audit_log. Accepting twice is not an error at this
-- layer: the second call changes 0 rows, writes nothing, and answers 'already_decided'.
--
-- Who may touch it: platform_ops holds NOTHING on the table and gains nothing anywhere (no migration after 0765 gives that login
-- anything). The functions and the rows are owned by a role of their own, work_item_correction_definer, in the shape of 0770's
-- runner_allowance_definer: NOLOGIN, no members (the migration role holds it only inside this file), a member of nothing, column-level
-- grants for exactly what the bodies read and write, row policies for this role only, a pinned search_path, EXECUTE for app_user alone,
-- and a refusal when the login itself is platform_ops. app_user can only READ the table (column-level SELECT, tenant row policy); it
-- cannot insert or update it, so the functions are the only way to write a correction.
--   * create: any active member of the account. `origin` agent is storable (a proposal an agent drafted) but is still only `proposed`.
--   * decide: owner or admin; decided_via workspace or terminal. 'auto' (the per-kind autonomy toggle) is in the enum but is REFUSED
--     here: nothing acts without a click until an owner ruling and a later migration open that path.
--   * mark_applied: the driver's userless tenant session (app.user_id empty), or an owner or admin. A session that names a user who is
--     not an owner or admin of the account is refused. It can only move an `accepted` row to `applied`; a run note needs a run of the
--     same item that was created at or after the moment the note was accepted, so a note accepted mid-run goes to the next run.
--
-- Numbered above the highest migration on the code plane (0778). Re-check against main right before merging and renumber to stay above it.
--
-- The text is stored as the caller sent it. Sanitising (D#1588) is applied where the text is used as an instruction or published,
-- not here: content_hash binds the stored text, and an approving token carries that hash.
DO $$
DECLARE
  n text := 'work_item_correction_definer';
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

CREATE TABLE work_item_corrections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id     uuid NOT NULL,
  origin           text NOT NULL,
  kind             text NOT NULL,
  body             text NOT NULL,
  status           text NOT NULL DEFAULT 'proposed',
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_via      text,
  content_hash     text NOT NULL,
  applied_run_id   uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  applied_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, applied_run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (applied_run_id),
  CONSTRAINT work_item_corrections_origin_check CHECK (origin IN ('person', 'agent')),
  CONSTRAINT work_item_corrections_kind_check CHECK (kind IN ('question', 'run_note', 'spec_amend', 'new_item', 'pause', 'priority')),
  CONSTRAINT work_item_corrections_status_check CHECK (status IN ('proposed', 'accepted', 'rejected', 'applied', 'superseded')),
  CONSTRAINT work_item_corrections_decided_via_check CHECK (decided_via IS NULL OR decided_via IN ('workspace', 'terminal', 'auto')),
  -- characters, not bytes: char_length counts code points
  CONSTRAINT work_item_corrections_body_check CHECK (char_length(body) <= 4000),
  CONSTRAINT work_item_corrections_hash_check CHECK (content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex')),
  -- A decision stamp exists exactly when the correction has left `proposed`; a run or an applied time only on an applied one.
  CONSTRAINT work_item_corrections_decision_shape CHECK ((status = 'proposed') = (decided_via IS NULL)),
  CONSTRAINT work_item_corrections_applied_shape CHECK (
    (applied_at IS NULL OR status = 'applied') AND (applied_run_id IS NULL OR status = 'applied')
  )
);
CREATE INDEX work_item_corrections_item_idx ON work_item_corrections (account_id, work_item_id, created_at DESC, id);
-- What the driver will read at a run boundary: accepted run notes not yet applied.
CREATE INDEX work_item_corrections_unapplied_notes_idx ON work_item_corrections (account_id, work_item_id, created_at, id)
  WHERE status = 'accepted' AND kind = 'run_note';

ALTER TABLE work_item_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_corrections FORCE ROW LEVEL SECURITY;

-- What the bodies read and write, column by column. agent_runs: that a run belongs to the account and the item. account_members: the
-- caller's own row. accounts: that the account is active. audit_log: one row per change.
GRANT USAGE ON SCHEMA public TO work_item_correction_definer;
GRANT SELECT (id, account_id, work_item_id, origin, kind, status, decided_via, decided_at, applied_run_id),
      INSERT (id, account_id, work_item_id, origin, kind, body, status, created_by, content_hash),
      UPDATE (status, decided_by, decided_via, decided_at, applied_run_id, applied_at, updated_at) ON work_item_corrections TO work_item_correction_definer;
GRANT SELECT (id, account_id, work_item_id, created_at) ON agent_runs TO work_item_correction_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO work_item_correction_definer;
GRANT SELECT (id, deleted_at) ON accounts TO work_item_correction_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO work_item_correction_definer;

-- Read only, for the tenant (any member). No write for anyone but the functions.
GRANT SELECT (id, account_id, work_item_id, origin, kind, body, status, created_by, decided_by, decided_via, content_hash, applied_run_id, created_at, decided_at, applied_at, updated_at)
  ON work_item_corrections TO app_user;

CREATE POLICY tenant_isolation_select ON work_item_corrections FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY work_item_correction_definer_select ON work_item_corrections FOR SELECT TO work_item_correction_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_correction_definer_insert ON work_item_corrections FOR INSERT TO work_item_correction_definer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND status = 'proposed'
    AND created_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = work_item_corrections.account_id AND m.user_id = work_item_corrections.created_by)
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY work_item_correction_definer_update ON work_item_corrections FOR UPDATE TO work_item_correction_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY work_item_correction_definer_select ON agent_runs FOR SELECT TO work_item_correction_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- Shows this role only the caller's own membership row, as 0757, 0759 and 0770 do.
CREATE POLICY work_item_correction_definer_select ON account_members FOR SELECT TO work_item_correction_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY work_item_correction_definer_select ON accounts FOR SELECT TO work_item_correction_definer USING (true);
CREATE POLICY work_item_correction_definer_audit ON audit_log FOR INSERT TO work_item_correction_definer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND action IN ('work_item.correction_proposed', 'work_item.correction_accepted', 'work_item.correction_rejected',
                   'work_item.correction_superseded', 'work_item.correction_applied')
  );

-- Ownership bracket (0763's shape): a non-superuser migrator needs SET on the role for ALTER ... OWNER TO, and the role has CREATE on
-- public only for that transfer. Both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'work_item_correction_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on work_item_correction_definer; cannot ALTER FUNCTION ... OWNER TO work_item_correction_definer';
    END IF;
    GRANT work_item_correction_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO work_item_correction_definer;

-- ---- create -------------------------------------------------------------------------------------------------------
CREATE FUNCTION work_item_correction_create(p_work_item_id uuid, p_origin text, p_kind text, p_body text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  new_id uuid := gen_random_uuid();
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'work_item_correction_create: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id INTO usr FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL THEN
    RAISE EXCEPTION 'work_item_correction_create: caller is not a member of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_work_item_id IS NULL OR p_origin IS NULL OR p_kind IS NULL OR p_body IS NULL THEN
    RAISE EXCEPTION 'work_item_correction_create: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The enum values and the length are held by CHECKs (a bad value raises 23514); the work item by the composite foreign key,
  -- so another tenant's item is a 23503 and reveals nothing.
  INSERT INTO public.work_item_corrections (id, account_id, work_item_id, origin, kind, body, status, created_by, content_hash)
  VALUES (new_id, acct, p_work_item_id, p_origin, p_kind, p_body, 'proposed', usr,
          encode(sha256(convert_to(p_body, 'UTF8')), 'hex'));

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'work_item.correction_proposed',
          jsonb_build_object('correction_id', new_id, 'work_item_id', p_work_item_id, 'kind', p_kind, 'from_status', NULL,
                             'to_status', 'proposed', 'origin', p_origin, 'decided_via', NULL, 'applied_run_id', NULL),
          clock_timestamp());
  RETURN new_id;
END;
$$;

-- ---- decide -------------------------------------------------------------------------------------------------------
CREATE FUNCTION work_item_correction_decide(p_id uuid, p_to_status text, p_via text)
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
  SELECT c.id, c.work_item_id, c.kind, c.origin, c.status INTO cur
    FROM public.work_item_corrections c WHERE c.id = p_id AND c.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_item_correction_decide: no such correction' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (
       (p_to_status = 'accepted' AND cur.status = 'proposed')
    OR (p_to_status IN ('rejected', 'superseded') AND cur.status IN ('proposed', 'accepted'))
  ) THEN
    RETURN 'already_decided';
  END IF;

  UPDATE public.work_item_corrections
     SET status = p_to_status, decided_by = usr, decided_via = p_via, decided_at = ts, updated_at = ts
   WHERE id = cur.id AND account_id = acct;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'work_item.correction_' || p_to_status,
          jsonb_build_object('correction_id', cur.id, 'work_item_id', cur.work_item_id, 'kind', cur.kind, 'from_status', cur.status,
                             'to_status', p_to_status, 'origin', cur.origin, 'decided_via', p_via, 'applied_run_id', NULL),
          ts);
  RETURN 'decided';
END;
$$;

-- ---- mark applied -------------------------------------------------------------------------------------------------
CREATE FUNCTION work_item_correction_mark_applied(p_id uuid, p_run_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  v_role text;
  ts     timestamptz := clock_timestamp();
  cur    record;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'work_item_correction_mark_applied: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'work_item_correction_mark_applied: no active account in the session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'work_item_correction_mark_applied: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- No user in the session is the driver's own tenant transaction. A session that names a user must be an owner or admin of the
  -- account; a plain member, a non-member and a removed member are refused.
  IF NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
    SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
     WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
    IF usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'work_item_correction_mark_applied: caller is not the driver or an owner or admin' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT c.id, c.work_item_id, c.kind, c.origin, c.status, c.decided_via, c.decided_at INTO cur
    FROM public.work_item_corrections c WHERE c.id = p_id AND c.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_item_correction_mark_applied: no such correction' USING ERRCODE = 'no_data_found';
  END IF;
  IF cur.status <> 'accepted' THEN
    RETURN 'not_accepted';
  END IF;
  -- A run note is applied by a run of its own item; any other kind is applied by the accept itself and names no run.
  IF cur.kind = 'run_note' THEN
    IF p_run_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.agent_runs r WHERE r.id = p_run_id AND r.account_id = acct AND r.work_item_id = cur.work_item_id AND r.created_at >= cur.decided_at) THEN
      RAISE EXCEPTION 'work_item_correction_mark_applied: a run note is applied by a run of the same work item that started after it was accepted' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'work_item_correction_mark_applied: only a run note names a run' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.work_item_corrections
     SET status = 'applied', applied_run_id = p_run_id, applied_at = ts, updated_at = ts
   WHERE id = cur.id AND account_id = acct;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, COALESCE(usr::text, 'system:driver'), 'work_item.correction_applied',
          jsonb_build_object('correction_id', cur.id, 'work_item_id', cur.work_item_id, 'kind', cur.kind, 'from_status', 'accepted',
                             'to_status', 'applied', 'origin', cur.origin, 'decided_via', cur.decided_via, 'applied_run_id', p_run_id),
          ts);
  RETURN 'applied';
END;
$$;

REVOKE ALL ON FUNCTION work_item_correction_create(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work_item_correction_decide(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION work_item_correction_mark_applied(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION work_item_correction_create(uuid, text, text, text) OWNER TO work_item_correction_definer;
ALTER FUNCTION work_item_correction_decide(uuid, text, text) OWNER TO work_item_correction_definer;
ALTER FUNCTION work_item_correction_mark_applied(uuid, uuid) OWNER TO work_item_correction_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner), to app_user alone.
GRANT EXECUTE ON FUNCTION work_item_correction_create(uuid, text, text, text) TO app_user;
GRANT EXECUTE ON FUNCTION work_item_correction_decide(uuid, text, text) TO app_user;
GRANT EXECUTE ON FUNCTION work_item_correction_mark_applied(uuid, uuid) TO app_user;
REVOKE CREATE ON SCHEMA public FROM work_item_correction_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE work_item_correction_definer FROM CURRENT_USER;
  END IF;
END
$$;
