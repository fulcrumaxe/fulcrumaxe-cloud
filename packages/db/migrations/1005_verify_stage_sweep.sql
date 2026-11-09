-- D#749 V3a: what the verify stage's sweep needs from the database. Three things, all expand-only.
--
-- 1. verify_deploy_orders.verify_row_id now names a real verify row. Migration 1004 left it without a foreign key because the row table (1003) was a sibling that had
--    to be testable on its own; the stage that places orders is this change, and it creates the row first. The key is composite, (account_id, verify_row_id) against
--    verify_rows (account_id, id), so an order can never name a row of another account, and it cascades: a row that goes (with its repository or work item) takes its
--    orders with it. No order has ever been placed (nothing wrote to the table before this change), so the key validates against an empty table.
--
-- 2. verify_settings.enabled_since: the moment verification was last switched on. It is the intake boundary of the sweep (a merge that landed before it is not verified
--    late). It is stamped by a trigger and only on the off -> on move (an insert that is enabled counts as one); every other save, enabled or not, leaves it alone, and a
--    save that turns verification off clears it. The old boundary, updated_at, moves on every save, so an admin editing the journeys while a merge waited for its commit
--    would have made the sweep skip that merge for good. The trigger ignores any value a writer supplies, so no login (app_user holds no grant on the column either)
--    can move the boundary. Rows that are enabled when this runs take their updated_at (none exist yet: the stage ships off).
--
-- 3. verify_stage_list_enabled(limit, after_repo): the sweep's cross-account list. The pass runs in the claim verifier's 15-minute tick and works across accounts,
--    but verify is off by default, so the list names only the repositories whose settings say `enabled` (in a live active account), and everything else the pass
--    reads and writes it does under that account's own tenant. It is built like the other listers (0950, 0965): its own NOLOGIN role that holds exactly the column
--    reads the body makes and one row policy per table for itself alone, a pinned search_path, EXECUTE for the run-writer login only, refused for platform_ops. It
--    returns two ids and nothing else; keyset paged on the repository id so a deployment with many enabled repositories is walked in order, never starved at the front.
--
-- Numbered 1005: the next free number above main's highest (1003) and the number the sibling runner-protocol migration holds (1004). The plan reserves 1005 for a later
-- change of the stage; whichever merges second takes the next free number. Re-checked against main right before opening. Neon shape: packages/db/neon-shape.d/1005_verify_stage_sweep.conf.

ALTER TABLE verify_deploy_orders
  ADD CONSTRAINT verify_deploy_orders_row_fk FOREIGN KEY (account_id, verify_row_id) REFERENCES verify_rows (account_id, id) ON DELETE CASCADE;

ALTER TABLE verify_settings ADD COLUMN enabled_since timestamptz NULL;
UPDATE verify_settings SET enabled_since = updated_at WHERE enabled;
ALTER TABLE verify_settings ADD CONSTRAINT verify_settings_enabled_since_check CHECK (enabled = (enabled_since IS NOT NULL));

-- Not SECURITY DEFINER: it reads and writes only the row it is given.
CREATE FUNCTION verify_settings_stamp_enabled_since() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT NEW.enabled THEN
    NEW.enabled_since := NULL;
  ELSIF TG_OP = 'INSERT' OR NOT OLD.enabled THEN
    NEW.enabled_since := now();
  ELSE
    NEW.enabled_since := OLD.enabled_since;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER verify_settings_stamp_enabled_since BEFORE INSERT OR UPDATE ON verify_settings FOR EACH ROW EXECUTE FUNCTION verify_settings_stamp_enabled_since();

DO $$
DECLARE
  n text := 'verify_stage_lister';
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

GRANT USAGE ON SCHEMA public TO verify_stage_lister;
GRANT SELECT (repo_id, account_id, enabled) ON verify_settings TO verify_stage_lister;
GRANT SELECT (id, deleted_at, status) ON accounts TO verify_stage_lister;
CREATE POLICY verify_stage_lister_select ON verify_settings FOR SELECT TO verify_stage_lister USING (enabled);
CREATE POLICY verify_stage_lister_select ON accounts FOR SELECT TO verify_stage_lister USING (deleted_at IS NULL AND status = 'active');

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'verify_stage_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on verify_stage_lister; cannot ALTER FUNCTION ... OWNER TO verify_stage_lister';
    END IF;
    GRANT verify_stage_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO verify_stage_lister;

CREATE FUNCTION verify_stage_list_enabled(p_limit int, p_after_repo uuid DEFAULT NULL)
RETURNS TABLE (account_id uuid, repo_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'verify_stage_list_enabled: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'verify_stage_list_enabled: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT s.account_id, s.repo_id
    FROM public.verify_settings s
    JOIN public.accounts a ON a.id = s.account_id AND a.deleted_at IS NULL AND a.status = 'active'
   WHERE s.enabled AND (p_after_repo IS NULL OR s.repo_id > p_after_repo)
   ORDER BY s.repo_id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION verify_stage_list_enabled(int, uuid) FROM PUBLIC;
ALTER FUNCTION verify_stage_list_enabled(int, uuid) OWNER TO verify_stage_lister;
-- EXECUTE after the transfer, to the run-writer login alone, as 0950 does.
GRANT EXECUTE ON FUNCTION verify_stage_list_enabled(int, uuid) TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM verify_stage_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE verify_stage_lister FROM CURRENT_USER;
  END IF;
END
$$;
