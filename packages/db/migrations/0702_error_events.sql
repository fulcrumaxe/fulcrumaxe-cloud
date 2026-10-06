-- Error visibility: the stored error classes (hardening plan H1a).
--
-- error_events holds one row per (hour, service, route template, stage, code) with a running count and the first
-- and last time it was seen. It carries no account id, user id, message or stack: a class is four coded labels and a
-- number, so nothing a request or an upstream service wrote can be stored in it. It is platform-wide, not per-tenant,
-- so it has no RLS and is listed in PLATFORM_WIDE_TABLES (packages/db/src/platformWideTables.ts).
--
-- Who may write it. The application login (app_user) holds NO privilege on the table. The one way in is
-- error_event_record(), a SECURITY DEFINER function owned by error_event_writer: a NOLOGIN role with no members
-- (withTenant never runs SET ROLE, so a login that were a member would inherit a direct INSERT), whose only table
-- privileges are on error_events itself (SELECT is needed by the UPDATE's WHERE and the cap count; INSERT and UPDATE
-- are the writes). app_user holds EXECUTE on the function and nothing else; platform_ops is not involved.
--
-- What the function enforces on its own, so a direct call in SQL gets the same rules as the application's sink:
--   * service and stage must match ^[a-z][a-z0-9_.]{0,39}$ and the route a template shape; a violation raises.
--   * a code that does not have the shape of an error code is stored as 'other'; the reserved 'error_overflow' is
--     never accepted from a caller (it is stored as 'other'), so only the function itself can write that class.
--   * at most 200 distinct classes are recorded per hour. The 201st and later are counted in one fixed class,
--     (platform, /, overflow, error_overflow), which the digest alerts on.
--
-- Pruning (30 days) is a reconciler job in a later task and takes its own grant then.

-- ---------------------------------------------------------------------
-- 1. The writer role (0663's hardened attributes and post-create assertion).
-- ---------------------------------------------------------------------
DO $$
DECLARE
  n text := 'error_event_writer';
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

-- ---------------------------------------------------------------------
-- 2. The table.
-- ---------------------------------------------------------------------
CREATE TABLE error_events (
  bucket        timestamptz NOT NULL,
  service       text        NOT NULL CHECK (service ~ '^[a-z][a-z0-9_.]{0,39}$'),
  route         text        NOT NULL CHECK (route ~ '^/[a-z0-9_.:/-]{0,199}$'),
  stage         text        NOT NULL CHECK (stage ~ '^[a-z][a-z0-9_.]{0,39}$'),
  code          text        NOT NULL CHECK (code ~ '^([A-Za-z][A-Za-z0-9_.]{0,63}|[0-9A-Z]{5})$'),
  count         bigint      NOT NULL CHECK (count >= 1),
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  PRIMARY KEY (bucket, service, route, stage, code)
);

-- The digest finds a class's earlier appearances by its labels, not by hour.
CREATE INDEX idx_error_events_class ON error_events (service, route, stage, code, bucket);

REVOKE ALL ON error_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON error_events TO error_event_writer;

-- ---------------------------------------------------------------------
-- 3. Ownership bracket (0618's shape): a non-superuser migrator needs SET on the role for ALTER ... OWNER TO,
-- and the role needs CREATE on public at that instant. The membership is removed again afterwards so the role
-- ends with no members.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'error_event_writer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on error_event_writer; cannot ALTER FUNCTION ... OWNER TO error_event_writer';
    END IF;
    GRANT error_event_writer TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO error_event_writer;

-- ---------------------------------------------------------------------
-- 4. The definer. No account, user or message parameter exists to pass.
-- ---------------------------------------------------------------------
CREATE FUNCTION error_event_record(
  p_service text,
  p_route   text,
  p_stage   text,
  p_code    text,
  p_count   integer DEFAULT 1
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_label    CONSTANT text    := '^[a-z][a-z0-9_.]{0,39}$';
  c_route    CONSTANT text    := '^/[a-z0-9_.:/-]{0,199}$';
  c_code     CONSTANT text    := '^([A-Za-z][A-Za-z0-9_.]{0,63}|[0-9A-Z]{5})$';
  c_max_cls  CONSTANT integer := 200;
  c_max_n    CONSTANT integer := 1000000;
  v_now      timestamptz := now();
  v_bucket   timestamptz := date_trunc('hour', now());
  v_code     text := p_code;
  v_count    integer := LEAST(GREATEST(COALESCE(p_count, 1), 1), c_max_n);
  v_classes  integer;
BEGIN
  IF p_service IS NULL OR p_service !~ c_label THEN
    RAISE EXCEPTION 'error_event_record: service does not match its pattern' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_stage IS NULL OR p_stage !~ c_label THEN
    RAISE EXCEPTION 'error_event_record: stage does not match its pattern' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_route IS NULL OR p_route !~ c_route THEN
    RAISE EXCEPTION 'error_event_record: route is not a route template' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- A code that is not shaped like an error code, or the reserved overflow class, is stored as 'other'.
  IF v_code IS NULL OR v_code !~ c_code OR v_code = 'error_overflow' THEN
    v_code := 'other';
  END IF;

  -- A class already seen this hour: one UPDATE, no lock.
  UPDATE public.error_events
     SET count = count + v_count, last_seen_at = v_now
   WHERE bucket = v_bucket AND service = p_service AND route = p_route AND stage = p_stage AND code = v_code;
  IF FOUND THEN
    RETURN;
  END IF;

  -- A new class: count the hour's classes under one transaction-scoped lock (it is released at COMMIT, so it
  -- holds across a pooled connection), then record it or fold it into the overflow class.
  PERFORM pg_advisory_xact_lock(hashtextextended('error_event_record.class_cap', 0));
  SELECT count(*) INTO v_classes
    FROM public.error_events
   WHERE bucket = v_bucket
     AND NOT (service = 'platform' AND route = '/' AND stage = 'overflow' AND code = 'error_overflow');
  IF v_classes >= c_max_cls THEN
    p_service := 'platform';
    p_route := '/';
    p_stage := 'overflow';
    v_code := 'error_overflow';
  END IF;

  INSERT INTO public.error_events AS e (bucket, service, route, stage, code, count, first_seen_at, last_seen_at)
  VALUES (v_bucket, p_service, p_route, p_stage, v_code, v_count, v_now, v_now)
  ON CONFLICT (bucket, service, route, stage, code)
  DO UPDATE SET count = e.count + EXCLUDED.count, last_seen_at = EXCLUDED.last_seen_at;
END;
$$;

REVOKE ALL ON FUNCTION error_event_record(text, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION error_event_record(text, text, text, text, integer) TO app_user;
ALTER FUNCTION error_event_record(text, text, text, text, integer) OWNER TO error_event_writer;

REVOKE CREATE ON SCHEMA public FROM error_event_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE error_event_writer FROM CURRENT_USER;
  END IF;
END
$$;
