-- D#605 FL-2: the name a runner gives itself when it registers.
--
-- A register request is signed by the new runner's own key and made on a code, so the session has an account (the code's) and no user and no
-- runner yet: runner_settings_apply (0783) re-derives a member's role from app.user_id and cannot be called here. Two ways were open: let the
-- register path act as the registrant (set app.user_id to runners.registered_by, which is the minter and not the caller, and run the member matrix),
-- or give the register path its own narrow definer. This is the second: nothing in the session claims to be a person, and the function can do
-- exactly one thing.
--
-- runner_name_initial(runner, name) writes the DEFAULT name of a runner that this same transaction has just created, and nothing else:
--   * the runner exists in the session's account, is not revoked, and has runners.created_at = now(), i.e. it was inserted by this transaction.
--     now() is the transaction's start time, so a later request, a rename, or a runner made by another transaction can never satisfy it;
--   * runner_settings has no name for it yet (a second call, or a name someone already set, changes 0 rows, never overwrites);
--   * the name is the FL-1 rule (runner_name_valid): 1 to 64 characters, no control, invisible or bidirectional character. Refused, never trimmed.
-- It touches no other column of runner_settings (labels, rank, pause and drain stay at their defaults), and it is no authorization input: the
-- name is a display string and routing never reads it.
--
-- Its own role, runner_name_initial_definer, not runner_settings_definer: the role-shape and exception-shape checks (test-neon-shape.sh) pin each
-- definer to one function, and this one needs a column of runners (created_at) the settings definer does not. NOLOGIN, no member, a member of
-- nothing, column grants for exactly what the body reads and writes, a pinned search_path, EXECUTE for app_user alone; platform_ops gets nothing.
--
-- Numbered above the highest migration on the code plane (0789 is reserved for this change). Re-check against main right before merging.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runner_name_initial_definer') THEN
    CREATE ROLE runner_name_initial_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE runner_name_initial_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runner_name_initial_definer' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role runner_name_initial_definer still has a privileged attribute';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO runner_name_initial_definer;
GRANT SELECT (runner_id, account_id, name) ON runner_settings TO runner_name_initial_definer;
GRANT INSERT (runner_id, account_id, updated_by) ON runner_settings TO runner_name_initial_definer;
GRANT UPDATE (name, updated_by, updated_at) ON runner_settings TO runner_name_initial_definer;
GRANT SELECT (id, account_id, registered_by, revoked_at, created_at) ON runners TO runner_name_initial_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_name_initial_definer;
GRANT EXECUTE ON FUNCTION runner_name_valid(text) TO runner_name_initial_definer;
-- The row it inserts takes the default labels, and the table's CHECK on labels runs as the inserting role.
GRANT EXECUTE ON FUNCTION runner_labels_valid(text[]) TO runner_name_initial_definer;

CREATE POLICY runner_name_initial_select ON runner_settings FOR SELECT TO runner_name_initial_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_name_initial_insert ON runner_settings FOR INSERT TO runner_name_initial_definer WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_name_initial_update ON runner_settings FOR UPDATE TO runner_name_initial_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_name_initial_select ON runners FOR SELECT TO runner_name_initial_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_name_initial_select ON accounts FOR SELECT TO runner_name_initial_definer USING (true);

-- ---- ownership bracket (0777's shape) -------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_name_initial_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_name_initial_definer; cannot ALTER FUNCTION ... OWNER TO runner_name_initial_definer';
    END IF;
    GRANT runner_name_initial_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_name_initial_definer;

CREATE FUNCTION runner_name_initial(p_runner uuid, p_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_reg uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_name_initial: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'runner_name_initial: no active account in the session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Text is refused, not repaired: what is stored is exactly what the runner sent.
  IF p_runner IS NULL OR NOT public.runner_name_valid(p_name) THEN
    RAISE EXCEPTION 'runner_name_initial: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Only a runner this transaction created: created_at = now() (the transaction's start). Anything older is refused, so this is never a rename.
  SELECT r.registered_by INTO v_reg FROM public.runners r
   WHERE r.id = p_runner AND r.account_id = acct AND r.revoked_at IS NULL AND r.created_at = now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_name_initial: not a runner created by this registration' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.runner_settings (runner_id, account_id, updated_by) VALUES (p_runner, acct, v_reg) ON CONFLICT (runner_id) DO NOTHING;
  UPDATE public.runner_settings s SET name = p_name, updated_by = v_reg, updated_at = now()
   WHERE s.runner_id = p_runner AND s.account_id = acct AND s.name IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION runner_name_initial(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_name_initial(uuid, text) TO app_user;
ALTER FUNCTION runner_name_initial(uuid, text) OWNER TO runner_name_initial_definer;
REVOKE CREATE ON SCHEMA public FROM runner_name_initial_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_name_initial_definer FROM CURRENT_USER;
  END IF;
END
$$;
