-- The 7-day metering flag-rate check as a counts-only database function
-- (D#2 CARRY-17-Q), plus a forgery guard for the run.metering kind.
--
-- Why a definer and not a grant. platform_ops is the login the internet-facing
-- handlers use, and since 0646 it reads run_events through a policy that needs
-- a single tenant's app.account_id and a session that is not platform_ops
-- itself. Widening that (a created_at/seq grant plus a cross-tenant policy)
-- would put every tenant's run.metering rows within reach of those handlers.
-- Instead:
--
--   * metering_reporter   NOLOGIN, hardened, NO members. Owns the function.
--                         Its only table privilege is SELECT on five
--                         run_events columns (no account_id), through one
--                         policy that pins the kind to run.metering.
--   * run_metering_flag_rate(p_days)
--                         SECURITY DEFINER, EXECUTE for platform_ops only.
--                         Returns ONE row of platform-wide counts: no account,
--                         run, payload, amount or timestamp leaves it.
--   * a run_events guard  a run.metering row is refused unless the inserting
--                         login is a member of agent_run_writer (the runner's
--                         login). app_user can INSERT run_events, so without
--                         this a tenant could move the flag rate either way.
--                         0665's receipt guard is left as it is.
--
-- platform_ops, app_user and partner_user gain no table privilege and no
-- policy here.

-- ---------------------------------------------------------------------
-- 1. metering_reporter (0663's hardened attributes and assertion).
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r record;
  bad text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metering_reporter') THEN
    CREATE ROLE metering_reporter NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE metering_reporter NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO r FROM pg_roles WHERE rolname = 'metering_reporter';
  bad := '{}';
  IF r.rolcanlogin THEN bad := array_append(bad, 'rolcanlogin'); END IF;
  IF r.rolsuper THEN bad := array_append(bad, 'rolsuper'); END IF;
  IF r.rolcreatedb THEN bad := array_append(bad, 'rolcreatedb'); END IF;
  IF r.rolcreaterole THEN bad := array_append(bad, 'rolcreaterole'); END IF;
  IF r.rolreplication THEN bad := array_append(bad, 'rolreplication'); END IF;
  IF r.rolbypassrls THEN bad := array_append(bad, 'rolbypassrls'); END IF;
  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION 'role metering_reporter still has privileged attribute(s): %', array_to_string(bad, ', ');
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- 2. What the definer may read: five columns, one kind. FORCE RLS applies
-- to metering_reporter (it is not the table owner), so the policy is what
-- limits it; even the function's owner can read no other kind.
-- ---------------------------------------------------------------------
GRANT SELECT (run_id, seq, kind, payload, created_at) ON run_events TO metering_reporter;
CREATE POLICY metering_reporter_read ON run_events
  FOR SELECT TO metering_reporter
  USING (kind = 'run.metering');

-- The 7-day scan is by created_at over one kind. A plain CREATE INDEX (not
-- CONCURRENTLY) is fine at today's table size.
CREATE INDEX run_events_metering_created_at ON run_events (created_at) WHERE kind = 'run.metering';

-- ---------------------------------------------------------------------
-- 3. The run.metering write guard.
-- ---------------------------------------------------------------------
CREATE FUNCTION run_events_metering_kind_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.kind = 'run.metering' AND NOT pg_has_role(current_user, 'agent_run_writer', 'MEMBER') THEN
    RAISE EXCEPTION 'run_events_metering_kind_forbidden: kind run.metering is written only by the runner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER run_events_metering_kind_guard BEFORE INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION run_events_metering_kind_guard();

-- ---------------------------------------------------------------------
-- 4. Ownership bracket (0663's shape): a non-superuser migrator needs SET
-- on the role for ALTER ... OWNER TO, and the role needs CREATE on public
-- at that instant. The membership is removed again afterwards.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'metering_reporter'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on metering_reporter; cannot ALTER FUNCTION ... OWNER TO metering_reporter';
    END IF;
    GRANT metering_reporter TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO metering_reporter;

-- ---------------------------------------------------------------------
-- 5. The definer. One run is one run.metering row: the lowest seq among
-- the rows inside the window. runs_flagged counts runs carrying any of the
-- three trigger flags; no_metering is shown but is not one of them.
-- ---------------------------------------------------------------------
CREATE FUNCTION run_metering_flag_rate(p_days integer)
RETURNS TABLE (
  window_days            integer,
  runs_total             bigint,
  runs_flagged           bigint,
  metering_silent        bigint,
  implausible_usage      bigint,
  reported_below_metered bigint,
  no_metering            bigint,
  flag_rate              numeric,
  trigger_met            boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 30 THEN
    RAISE EXCEPTION 'run_metering_flag_rate: p_days must be between 1 and 30'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  WITH per_run AS (
    SELECT DISTINCT ON (e.run_id)
           CASE WHEN jsonb_typeof(e.payload -> 'flags') = 'array' THEN e.payload -> 'flags' ELSE '[]'::jsonb END AS fl
      FROM public.run_events e
     WHERE e.kind = 'run.metering'
       AND e.created_at >= now() - make_interval(days => p_days)
     ORDER BY e.run_id, e.seq
  ),
  marked AS (
    SELECT fl @> '["metering_silent"]'::jsonb        AS f_silent,
           fl @> '["implausible_usage"]'::jsonb      AS f_implausible,
           fl @> '["reported_below_metered"]'::jsonb AS f_below,
           fl @> '["no_metering"]'::jsonb            AS f_none
      FROM per_run
  ),
  agg AS (
    SELECT count(*)                                                AS n_total,
           count(*) FILTER (WHERE f_silent OR f_implausible OR f_below) AS n_flagged,
           count(*) FILTER (WHERE f_silent)                        AS n_silent,
           count(*) FILTER (WHERE f_implausible)                   AS n_implausible,
           count(*) FILTER (WHERE f_below)                         AS n_below,
           count(*) FILTER (WHERE f_none)                          AS n_none
      FROM marked
  )
  SELECT p_days,
         a.n_total, a.n_flagged, a.n_silent, a.n_implausible, a.n_below, a.n_none,
         CASE WHEN a.n_total = 0 THEN NULL ELSE a.n_flagged::numeric / a.n_total END,
         (a.n_total >= 200 AND a.n_flagged * 100 > a.n_total)
    FROM agg a;
END;
$$;

REVOKE ALL ON FUNCTION run_metering_flag_rate(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION run_metering_flag_rate(integer) TO platform_ops;
ALTER FUNCTION run_metering_flag_rate(integer) OWNER TO metering_reporter;

REVOKE CREATE ON SCHEMA public FROM metering_reporter;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE metering_reporter FROM CURRENT_USER;
  END IF;
END
$$;
