-- D#483 S5-g2: the daily re-discovery sweep. The discovery trigger gains `sweep` (its reference is the UTC day, or the ISO week for a weekly repository, so the
-- existing UNIQUE (repo_id, trigger, trigger_ref) queues each period once), and discovery_sweep_list_due(p_limit) lists the connected product repositories of live
-- accounts with no sweep run yet for the current period of their frequency (no setting row: daily; `off` is listed under the day so its run records `discovery_off`).
-- Period names are cut in SQL from the clock in UTC, so no time zone can change them. STABLE, writes nothing, refuses a platform_ops login.
-- Owned by its own NOLOGIN role (the 0889/0950 bracket): column grants for exactly what the body reads, one row policy per table, a pinned search_path, EXECUTE for
-- the run-writer login alone. Numbered above main's highest (0950) and the number open work holds (0951); re-checked at open and before merge.

ALTER TABLE discovery_runs DROP CONSTRAINT discovery_runs_trigger_check;
ALTER TABLE discovery_runs ADD CONSTRAINT discovery_runs_trigger_check CHECK (trigger IN ('installation_created', 'repos_added', 'activation', 'sweep'));

DO $$
DECLARE
  n text := 'discovery_sweep_lister';
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

GRANT USAGE ON SCHEMA public TO discovery_sweep_lister;
GRANT SELECT (repo_id, trigger, trigger_ref) ON discovery_runs TO discovery_sweep_lister;
GRANT SELECT (account_id, repo_id, frequency, version) ON discovery_settings TO discovery_sweep_lister;
GRANT SELECT (id, account_id, installation_id, product) ON repos TO discovery_sweep_lister;
GRANT SELECT (id, deleted_at) ON accounts TO discovery_sweep_lister;
CREATE POLICY discovery_sweep_lister_select ON discovery_runs FOR SELECT TO discovery_sweep_lister USING (trigger = 'sweep');
CREATE POLICY discovery_sweep_lister_select ON discovery_settings FOR SELECT TO discovery_sweep_lister USING (true);
CREATE POLICY discovery_sweep_lister_select ON repos FOR SELECT TO discovery_sweep_lister USING (installation_id IS NOT NULL AND product = 'team');
CREATE POLICY discovery_sweep_lister_select ON accounts FOR SELECT TO discovery_sweep_lister USING (deleted_at IS NULL);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'discovery_sweep_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on discovery_sweep_lister; cannot ALTER FUNCTION ... OWNER TO discovery_sweep_lister';
    END IF;
    GRANT discovery_sweep_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO discovery_sweep_lister;

CREATE FUNCTION discovery_sweep_list_due(p_limit int)
RETURNS TABLE (account_id uuid, repo_id uuid, period_ref text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'discovery_sweep_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'discovery_sweep_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT r.account_id, r.id, p.ref
    FROM public.repos r
    JOIN public.accounts a ON a.id = r.account_id AND a.deleted_at IS NULL
    LEFT JOIN LATERAL (SELECT s.frequency FROM public.discovery_settings s WHERE s.account_id = r.account_id AND s.repo_id = r.id ORDER BY s.version DESC LIMIT 1) f ON true
    CROSS JOIN LATERAL (SELECT CASE WHEN f.frequency = 'weekly' THEN to_char(now() AT TIME ZONE 'UTC', 'IYYY-"W"IW') ELSE to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') END AS ref) p
   WHERE r.installation_id IS NOT NULL AND r.product = 'team'
     AND NOT EXISTS (SELECT 1 FROM public.discovery_runs q WHERE q.repo_id = r.id AND q.trigger = 'sweep' AND q.trigger_ref = p.ref)
   ORDER BY r.account_id, r.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION discovery_sweep_list_due(int) FROM PUBLIC;
ALTER FUNCTION discovery_sweep_list_due(int) OWNER TO discovery_sweep_lister;
-- EXECUTE after the transfer, to the run-writer login alone, as 0874, 0886, 0889 and 0950 do.
GRANT EXECUTE ON FUNCTION discovery_sweep_list_due(int) TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM discovery_sweep_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE discovery_sweep_lister FROM CURRENT_USER;
  END IF;
END
$$;
