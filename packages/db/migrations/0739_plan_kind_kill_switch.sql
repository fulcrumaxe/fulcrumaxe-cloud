-- D#221 KS part 1 of 2 (migration 0739): the kill switch store and the customer-notice acknowledgement record for the two plan-based
-- Codex credential kinds (codex_access_token, chatgpt_oauth). Part 2 (refusing at admit, withdrawing the firewall
-- injection rule, the admit-side acknowledgement check) lands with or after the model-connection kinds work and only
-- READS what this file creates.
--
-- 1. plan_kind_switches: one row per plan-based kind, platform-wide (no account). The two rows are seeded here and the
--    table has no INSERT or DELETE grant for anyone, so the set of kinds cannot grow or shrink at runtime. The seed is
--    enabled = false: a kind is usable only after platform_ops turns it on, and a missing or unreadable row is read as
--    off by the reader (fail closed). Only platform_ops may UPDATE, and only enabled / updated_by / updated_at.
--    app_user may SELECT, because admit runs under a tenant context and the state is not secret.
-- 2. plan_kind_switch_audit: append-only. An AFTER UPDATE trigger writes one row for every change of `enabled`, in the
--    same transaction as the flip, so no write path (this package's setter or a hand-typed UPDATE by platform_ops)
--    can flip the switch without leaving a row, and a flip that does not also set updated_by is refused. The row
--    records the caller's free-text actor and session_user. The insert is made by a SECURITY DEFINER helper, called from the (invoker) trigger function, and platform_ops
--    holds SELECT only, so the role that flips the switch cannot insert, edit or remove a row. The helper is owned by the
--    dedicated NOLOGIN role plan_kind_audit_writer (INSERT on the audit table and a three-column SELECT of the switch table). The existing audit_log cannot be used:
--    it requires an account, and the switch is platform-wide.
-- 3. plan_notice_acks: the customer's recorded acknowledgement of the notice, per account, connection id, kind and
--    notice version. The connection id has NO foreign key on purpose: the notice is acknowledged BEFORE the connection
--    is saved (the caller pre-allocates the id). app_user may SELECT and INSERT own-account rows, where the row's
--    acknowledged_by is the session user and that user is an owner or admin of the account; there is no UPDATE or DELETE.
--    The time is the server's clock: acknowledged_at and id are outside app_user's column-level INSERT grant.
--    notice_version is bounded to the versions that exist; a new notice version is a new migration. A row with the same (account, connection, kind,
--    version) is recorded once.
-- Row-level security is on for all three tables (and forced). The ownership bracket is the 0618 / 0702 one, for plan_kind_audit_writer.

-- 0. The audit writer role (0702's shape): NOLOGIN, NOBYPASSRLS, member of nothing, granted to nobody. It owns the audit
--    helper function and holds INSERT on the audit table plus SELECT of three columns of the switch table, so the definer never runs with the
--    migration role's attributes (on a hosted install those include BYPASSRLS and CREATEROLE).
DO $$
DECLARE
  n text := 'plan_kind_audit_writer';
  r record;
  bad text[];
BEGIN
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
END
$$;

CREATE TABLE plan_kind_switches (
  kind        text PRIMARY KEY CHECK (kind IN ('codex_access_token', 'chatgpt_oauth')),
  enabled     boolean NOT NULL DEFAULT false,
  updated_by  text NOT NULL DEFAULT 'migration' CHECK (length(updated_by) BETWEEN 1 AND 200),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO plan_kind_switches (kind) VALUES ('codex_access_token'), ('chatgpt_oauth');

ALTER TABLE plan_kind_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_kind_switches FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_ops_read ON plan_kind_switches FOR SELECT TO platform_ops USING (true);
CREATE POLICY platform_ops_update ON plan_kind_switches FOR UPDATE TO platform_ops USING (true) WITH CHECK (true);
CREATE POLICY app_user_read ON plan_kind_switches FOR SELECT TO app_user USING (true);
GRANT SELECT ON plan_kind_switches TO app_user;
GRANT SELECT ON plan_kind_switches TO platform_ops;
GRANT UPDATE (enabled, updated_by, updated_at) ON plan_kind_switches TO platform_ops;

CREATE TABLE plan_kind_switch_audit (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('codex_access_token', 'chatgpt_oauth')),
  previous_enabled boolean NOT NULL,
  enabled          boolean NOT NULL,
  actor            text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  db_session_user  text NOT NULL,
  changed_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_plan_kind_switch_audit_kind ON plan_kind_switch_audit (kind, changed_at);

-- The only writer is the SECURITY DEFINER helper below, owned by plan_kind_audit_writer. RLS is forced like every
-- tenant table, so the insert policy names that role alone: nobody else, platform_ops included, holds INSERT or a policy
-- that would let a row in (a forged or back-dated one included). Same shape as 0618's eraser_access and platform_audit
-- (0611), where platform_ops can only SELECT.
ALTER TABLE plan_kind_switch_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_kind_switch_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_ops_read ON plan_kind_switch_audit FOR SELECT TO platform_ops USING (true);
CREATE POLICY audit_writer_insert ON plan_kind_switch_audit FOR INSERT TO plan_kind_audit_writer WITH CHECK (true);
GRANT SELECT ON plan_kind_switch_audit TO platform_ops;
GRANT INSERT ON plan_kind_switch_audit TO plan_kind_audit_writer;

-- Attribution. A flip must say who made it: a BEFORE trigger refuses a change of `enabled` unless the same UPDATE also
-- set `updated_by` (so a hand-typed UPDATE that leaves it out cannot be credited to the previous actor), and stamps
-- updated_at itself. `UPDATE OF updated_by` fires only when the column is in the statement's SET list, which is how
-- "was it set" is told apart from "has it a value"; the mark is transaction-local and consumed by the guard. The two
-- triggers run in name order (a_ before b_). The mark guards against mistakes (an UPDATE that forgets updated_by), not
-- against a deliberate caller: a platform_ops session can set the mark by hand, which gets it no more than writing
-- `updated_by = updated_by` does. The free-text actor is the caller's word. The audit row also records session_user,
-- which is truthful, but it is the shared platform_ops login, so the free-text actor is what tells operators apart.
CREATE FUNCTION plan_kind_switch_mark_actor() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM set_config('fx.plan_kind_actor_set', NEW.kind, true);
  RETURN NEW;
END $$;

CREATE FUNCTION plan_kind_switch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  marked text := current_setting('fx.plan_kind_actor_set', true);
BEGIN
  PERFORM set_config('fx.plan_kind_actor_set', '', true);
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'plan_kind_switches: kind cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.enabled IS DISTINCT FROM OLD.enabled AND marked IS DISTINCT FROM NEW.kind THEN
    RAISE EXCEPTION 'plan_kind_switches: a change of enabled must also set updated_by' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER plan_kind_switches_a_mark BEFORE UPDATE OF updated_by ON plan_kind_switches
  FOR EACH ROW EXECUTE FUNCTION plan_kind_switch_mark_actor();
CREATE TRIGGER plan_kind_switches_b_guard BEFORE UPDATE ON plan_kind_switches
  FOR EACH ROW EXECUTE FUNCTION plan_kind_switch_guard();

-- The trigger function itself is invoker-rights and owned by the migration owner, as every trigger function must be
-- (trigger-function-ownership guard). It calls a SECURITY DEFINER helper, owned by plan_kind_audit_writer, that does the
-- insert. The helper takes only the kind: it reads the flipped row's current enabled / updated_by itself, derives the
-- previous value (a boolean flip), stamps session_user and the clock, and refuses to run outside a trigger
-- (pg_trigger_depth() = 0 is a direct call). So the only thing a caller can make it write is a true description of the
-- current state of a switch that was just flipped, never an invented actor, value or time. EXECUTE is for platform_ops
-- (the invoker) only; the helper has a pinned search_path and schema-qualified references.
CREATE FUNCTION plan_kind_switch_audit_trg() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.enabled IS DISTINCT FROM OLD.enabled THEN
    PERFORM public.plan_kind_switch_audit_write(NEW.kind);
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION plan_kind_switch_audit_write(p_kind text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  cur record;
BEGIN
  IF pg_trigger_depth() = 0 THEN
    RAISE EXCEPTION 'plan_kind_switch_audit_write: only callable from the switch trigger' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.kind, s.enabled, s.updated_by INTO cur FROM public.plan_kind_switches s WHERE s.kind = p_kind;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_kind_switch_audit_write: no such kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.plan_kind_switch_audit (kind, previous_enabled, enabled, actor, db_session_user)
  VALUES (cur.kind, NOT cur.enabled, cur.enabled, cur.updated_by, session_user);
END $$;
REVOKE ALL ON FUNCTION plan_kind_switch_audit_trg() FROM PUBLIC;
REVOKE ALL ON FUNCTION plan_kind_switch_audit_write(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION plan_kind_switch_mark_actor() FROM PUBLIC;
REVOKE ALL ON FUNCTION plan_kind_switch_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION plan_kind_switch_audit_write(text) TO platform_ops;

CREATE TRIGGER plan_kind_switches_audit AFTER UPDATE ON plan_kind_switches
  FOR EACH ROW EXECUTE FUNCTION plan_kind_switch_audit_trg();

-- The helper's owner reads the one row it describes, and nothing else.
GRANT SELECT (kind, enabled, updated_by) ON plan_kind_switches TO plan_kind_audit_writer;
CREATE POLICY audit_writer_read ON plan_kind_switches FOR SELECT TO plan_kind_audit_writer USING (true);

-- Ownership bracket (0618 / 0702's shape): a non-superuser migrator needs SET on the role for ALTER ... OWNER TO, and the
-- role needs CREATE on public at that instant. The membership is removed again afterwards so the role ends with no members.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'plan_kind_audit_writer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on plan_kind_audit_writer; cannot ALTER FUNCTION ... OWNER TO plan_kind_audit_writer';
    END IF;
    GRANT plan_kind_audit_writer TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO plan_kind_audit_writer;
ALTER FUNCTION plan_kind_switch_audit_write(text) OWNER TO plan_kind_audit_writer;
REVOKE CREATE ON SCHEMA public FROM plan_kind_audit_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE plan_kind_audit_writer FROM CURRENT_USER;
  END IF;
END
$$;

CREATE TABLE plan_notice_acks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  connection_id    uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('codex_access_token', 'chatgpt_oauth')),
  notice_version   text NOT NULL CHECK (notice_version IN ('v1')),
  acknowledged_by  uuid NOT NULL REFERENCES users (id),
  acknowledged_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, connection_id, kind, notice_version)
);

ALTER TABLE plan_notice_acks ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_notice_acks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON plan_notice_acks FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY tenant_insert ON plan_notice_acks FOR INSERT TO app_user
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND acknowledged_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM account_members m
       WHERE m.account_id = plan_notice_acks.account_id AND m.user_id = plan_notice_acks.acknowledged_by
         AND m.role IN ('owner', 'admin')
    )
  );
-- Column-level INSERT: id and acknowledged_at are never the caller's to set, so the server-clock rule is held by the database.
GRANT SELECT ON plan_notice_acks TO app_user;
GRANT INSERT (account_id, connection_id, kind, notice_version, acknowledged_by) ON plan_notice_acks TO app_user;
