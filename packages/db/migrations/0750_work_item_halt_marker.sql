-- 0750: a halt marker on work_items, checked inside the create transaction of every agent run.
--
-- Why. A customer halt used to be "the item sits at needs_human". That signal depends on the stage graph (three stages
-- have no edge into needs_human), is moved by automatic writers (a review round can leave needs_human) and is read before
-- a run exists, so a start could land after the halt listed its runs. The marker below does not depend on the stage:
--   halted_at       set by a halt, cleared only by a person's later resume. NULL means not halted.
--   halt_action_id  the cancel_work_item request that set it (NULL exactly when halted_at is NULL).
--   halt_epoch      +1 per halt action, never decremented: it fences a workflow that started before the halt.
--
-- The check. A BEFORE INSERT trigger on agent_runs reads the item FOR SHARE and raises HX409 when it is halted. The halt
-- writes the marker under the row's FOR UPDATE lock, which conflicts with FOR SHARE:
--   * a create in flight holds the share lock, so the halt waits for it to commit and its list then sees that run;
--   * a halt that committed first is read by the create (READ COMMITTED re-reads a locked row), and the whole create
--     rolls back before any sandbox exists.
-- Every run is created through agent_run_create, so no caller can forget the check.
--
-- Shape. A trigger function owned by platform_ops would let that login drop it (trigger-function-ownership), so the
-- trigger function is the migration owner's, invoker rights, and calls one SECURITY DEFINER helper that takes the lock
-- (the split that test names). The helper is owned by a NOLOGIN role of its own, work_item_halt_definer (0720's
-- guard_definer shape): it holds only SELECT (id, account_id, halted_at) and UPDATE (halted_at) on work_items, and policies
-- for that role only: a read policy, and an update policy whose WITH CHECK is false so FOR SHARE can lock a row and nothing
-- can change one. platform_ops gets no grant and no policy on work_items from this file. (A policy for platform_ops would
-- OR with its tenant-scoped ones and make every definer it owns blind to tenants on work_items.) The helper names both
-- ids, so nothing leans on a session setting: the create may run outside a tenant context, e.g. a fixture. It answers one
-- boolean. EXECUTE goes to platform_ops (agent_run_create is its definer) and the migration role (a direct insert).
--
-- Grants: the three columns are updatable by exactly the roles that can update work_items.stage (app_user, which the
-- worker's run-writer login inherits). A test pins that.

ALTER TABLE work_items
  ADD COLUMN halted_at timestamptz NULL,
  ADD COLUMN halt_action_id uuid NULL,
  ADD COLUMN halt_epoch integer NOT NULL DEFAULT 0;

ALTER TABLE work_items
  ADD CONSTRAINT work_items_halt_marker_pair CHECK ((halted_at IS NULL) = (halt_action_id IS NULL));

GRANT UPDATE (halted_at, halt_action_id, halt_epoch) ON work_items TO app_user;

-- ---- the role ---------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text := 'work_item_halt_definer';
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

GRANT USAGE ON SCHEMA public TO work_item_halt_definer;
GRANT SELECT (id, account_id, halted_at), UPDATE (halted_at) ON work_items TO work_item_halt_definer;
CREATE POLICY work_item_halt_definer_select ON work_items FOR SELECT TO work_item_halt_definer USING (true);
CREATE POLICY work_item_halt_definer_lock ON work_items FOR UPDATE TO work_item_halt_definer
  USING (true) WITH CHECK (false);

-- Privilege bracket (0720's shape): the migration role holds the new role (with the ADMIN it got by creating it) only
-- inside this file, to receive the function; it is removed again below.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'work_item_halt_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on work_item_halt_definer; cannot ALTER FUNCTION ... OWNER TO work_item_halt_definer';
    END IF;
    GRANT work_item_halt_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO work_item_halt_definer;

CREATE FUNCTION work_item_halt_lock(p_account_id uuid, p_work_item_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT halted_at IS NOT NULL FROM public.work_items WHERE id = p_work_item_id AND account_id = p_account_id FOR SHARE
$$;
REVOKE ALL ON FUNCTION work_item_halt_lock(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION work_item_halt_lock(uuid, uuid) OWNER TO work_item_halt_definer;
-- After the owner change (it rewrites the ACL entries that named the old owner). The invokers of the trigger below: the
-- migration owner (a direct insert as the table owner) and, inside agent_run_create, platform_ops. Nobody else can call it.
GRANT EXECUTE ON FUNCTION work_item_halt_lock(uuid, uuid) TO platform_ops;
GRANT EXECUTE ON FUNCTION work_item_halt_lock(uuid, uuid) TO CURRENT_USER;

REVOKE CREATE ON SCHEMA public FROM work_item_halt_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE work_item_halt_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- The trigger function: invoker rights, the migration owner's, nothing but the helper call.
CREATE FUNCTION agent_runs_refuse_halted_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.work_item_id IS NOT NULL AND public.work_item_halt_lock(NEW.account_id, NEW.work_item_id) IS TRUE THEN
    RAISE EXCEPTION 'work_item_halted' USING ERRCODE = 'HX409';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION agent_runs_refuse_halted_item() FROM PUBLIC;

CREATE TRIGGER agent_runs_refuse_halted_item
  BEFORE INSERT ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_refuse_halted_item();
