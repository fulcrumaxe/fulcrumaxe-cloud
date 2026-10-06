-- Decision receipts: the durable writer (D#7 DP3a, correction DP-C3).
--
-- Until now nothing could INSERT into decision_receipts: app_user holds
-- SELECT only (0400, C4). This file adds the one path in.
--
--   * receipt_writer          NOLOGIN, hardened, NO members. Owns the definer
--                             and holds INSERT on decision_receipts. Because
--                             withTenant never runs SET ROLE, a login that
--                             were a member of this role would inherit a
--                             direct INSERT and could pick its own actor.
--   * receipt_writer_invoker  NOLOGIN, hardened. Its only privilege is
--                             EXECUTE on the definer. The login that writes
--                             receipts (an ops step, never the runner's
--                             login) is a member of app_user and of this
--                             role.
--
-- decision_receipt_write() is SECURITY DEFINER and takes neither an actor
-- nor an account: both come from the session (app.user_id / app.account_id,
-- set by withTenant). No user id means 'policy' (resolved by the dial).
-- Class 1 never enters this table (DP-OD5), so it is refused here.
--
-- Numbering: 0661 and 0662 are reserved for other tasks.

-- ---------------------------------------------------------------------
-- 1. Roles (0642's hardened attributes and post-create assertion).
-- ---------------------------------------------------------------------
DO $$
DECLARE
  n text;
  r record;
  bad text[];
BEGIN
  FOREACH n IN ARRAY ARRAY['receipt_writer', 'receipt_writer_invoker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      INTO r FROM pg_roles WHERE rolname = n;
    bad := '{}';
    IF r.rolcanlogin THEN bad := array_append(bad, 'rolcanlogin'); END IF;
    IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
    IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
    IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
    IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
    IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
    IF array_length(bad, 1) > 0 THEN
      RAISE EXCEPTION 'role % still has privileged attribute(s): %', n, array_to_string(bad, ', ');
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------
-- 2. catalogue_version (DP-C3b). Nullable at the database like the other
-- content columns; the definer refuses NULL with a named error.
-- ---------------------------------------------------------------------
ALTER TABLE decision_receipts
  ADD COLUMN catalogue_version integer CHECK (catalogue_version >= 1);

-- ---------------------------------------------------------------------
-- 3. Grants and policies for receipt_writer. FORCE RLS applies to it (it
-- is not the table owner), so each read/write the definer performs needs
-- a tenant-bound policy. It reads accounts (via account_is_active) and
-- account_members (the actor check) column-scoped, and writes nothing else.
-- ---------------------------------------------------------------------
GRANT INSERT ON decision_receipts TO receipt_writer;
GRANT SELECT (id, deleted_at) ON accounts TO receipt_writer;
GRANT SELECT (account_id, user_id) ON account_members TO receipt_writer;

CREATE POLICY receipt_writer_insert ON decision_receipts
  FOR INSERT TO receipt_writer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY receipt_writer_select ON accounts
  FOR SELECT TO receipt_writer
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY receipt_writer_select ON account_members
  FOR SELECT TO receipt_writer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- 4. Ownership bracket (0618's shape): a non-superuser migrator needs SET
-- on receipt_writer for ALTER ... OWNER TO, and the role needs CREATE on
-- public at that instant. The membership is removed again afterwards so
-- the role ends with no members.
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

-- ---------------------------------------------------------------------
-- 5. The definer. No actor, user or account parameter.
-- ---------------------------------------------------------------------
CREATE FUNCTION decision_receipt_write(
  p_class                text,
  p_decision_type        text,
  p_chosen               text,
  p_rejected_alternative text,
  p_dial_version         integer,
  p_input_trust_classes  jsonb,
  p_work_item_id         uuid,
  p_run_id               uuid,
  p_catalogue_version    integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id      uuid := gen_random_uuid();
  v_tenant  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_session text := NULLIF(current_setting('app.user_id', true), '');
  v_actor   text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'receipt_no_tenant: app.account_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_class = 'automated_with_monitoring' THEN
    RAISE EXCEPTION 'receipt_class1_not_durable: class 1 receipts are written to run_events, not decision_receipts'
      USING ERRCODE = 'check_violation';
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

  INSERT INTO public.decision_receipts
    (id, account_id, run_id, work_item_id, decision_type, class, chosen, rejected_alternative,
     dial_version, input_trust_classes, actor, catalogue_version)
  VALUES
    (v_id, v_tenant, p_run_id, p_work_item_id, p_decision_type, p_class, p_chosen,
     p_rejected_alternative, p_dial_version, p_input_trust_classes, v_actor, p_catalogue_version);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION decision_receipt_write(text, text, text, text, integer, jsonb, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decision_receipt_write(text, text, text, text, integer, jsonb, uuid, uuid, integer) TO receipt_writer_invoker;
ALTER FUNCTION decision_receipt_write(text, text, text, text, integer, jsonb, uuid, uuid, integer) OWNER TO receipt_writer;

REVOKE CREATE ON SCHEMA public FROM receipt_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE receipt_writer FROM CURRENT_USER;
  END IF;
END
$$;
