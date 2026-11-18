-- D#587 B-7a: host limits and a sandbox inventory, reported by a runner and used for routing and display only.
--
--   1. runner_facts gains max_vms, max_vcpus, max_memory_mb and bootable_templates (null / empty = never reported). Written only by
--      runner_sandbox_facts_record, which names the runner from app.runner_id (set only by the signature-verifying runner middleware).
--   2. runner_sandboxes: the runner's sandboxes, metadata only (name, state, times, bytes, counts: no content, no log, no path). At most 200 rows per
--      runner, by construction: `slot` is 0..199 and (runner_id, slot) is the primary key, so no code path can store a 201st row.
--   3. runner_sandbox_reports: one row per runner that has reported, with the time of its last report. It tells "reported an empty list" from "never reported".
--   Both tables are written only by runner_sandboxes_record, which replaces the runner's whole list in one statement block and refuses unknown keys, a name
--   outside the VM helper's id pattern, a state outside the closed set, more than 200 rows, duplicate names, and any runner whose hello declared a protocol
--   below 21.
--
-- Nothing here is a security input. The role is the existing runner_facts_definer (0783): it gains grants on these two tables and nothing else changes.
-- platform_ops gets no privilege on either table or either function. Both functions are SECURITY DEFINER with a pinned search_path, REVOKEd from PUBLIC,
-- and executable by app_user alone.
--
-- Numbered 1040 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

CREATE FUNCTION runner_templates_valid(p text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p IS NOT NULL AND cardinality(p) <= 8 AND (cardinality(p) = 0 OR array_ndims(p) = 1)
     AND coalesce((SELECT bool_and(coalesce(t ~ '^[a-z0-9][a-z0-9-]{0,39}$', false)) AND count(*) = count(DISTINCT t) FROM unnest(p) AS t), true)
$$;
REVOKE ALL ON FUNCTION runner_templates_valid(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_templates_valid(text[]) TO runner_facts_definer;

ALTER TABLE runner_facts
  ADD COLUMN max_vms smallint CONSTRAINT runner_facts_max_vms_check CHECK (max_vms BETWEEN 0 AND 256),
  ADD COLUMN max_vcpus smallint CONSTRAINT runner_facts_max_vcpus_check CHECK (max_vcpus BETWEEN 0 AND 4096),
  ADD COLUMN max_memory_mb integer CONSTRAINT runner_facts_max_memory_check CHECK (max_memory_mb BETWEEN 0 AND 16777216),
  ADD COLUMN bootable_templates text[] NOT NULL DEFAULT '{}' CONSTRAINT runner_facts_templates_check CHECK (runner_templates_valid(bootable_templates));

CREATE TABLE runner_sandboxes (
  runner_id      uuid NOT NULL,
  slot           smallint NOT NULL CONSTRAINT runner_sandboxes_slot_check CHECK (slot BETWEEN 0 AND 199),
  account_id     uuid NOT NULL,
  name           text NOT NULL CONSTRAINT runner_sandboxes_name_check CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  state          text NOT NULL CONSTRAINT runner_sandboxes_state_check CHECK (state IN ('creating', 'running', 'stopped', 'snapshotted', 'error')),
  created_at     timestamptz NOT NULL,
  last_used_at   timestamptz,
  disk_bytes     bigint NOT NULL CONSTRAINT runner_sandboxes_disk_check CHECK (disk_bytes BETWEEN 0 AND 999999999999999),
  snapshot_count integer NOT NULL CONSTRAINT runner_sandboxes_snapshots_check CHECK (snapshot_count BETWEEN 0 AND 10000),
  snapshot_age_s bigint CONSTRAINT runner_sandboxes_snapshot_age_check CHECK (snapshot_age_s BETWEEN 0 AND 2147483647),
  PRIMARY KEY (runner_id, slot),
  UNIQUE (runner_id, name),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE
);
ALTER TABLE runner_sandboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_sandboxes FORCE ROW LEVEL SECURITY;

CREATE TABLE runner_sandbox_reports (
  runner_id  uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  row_count  smallint NOT NULL CONSTRAINT runner_sandbox_reports_count_check CHECK (row_count BETWEEN 0 AND 200),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE
);
ALTER TABLE runner_sandbox_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_sandbox_reports FORCE ROW LEVEL SECURITY;

-- ---- grants and policies --------------------------------------------------------------------------------------------
GRANT SELECT (protocol_version) ON runners TO runner_facts_definer;
GRANT SELECT (max_vms, max_vcpus, max_memory_mb, bootable_templates), UPDATE (max_vms, max_vcpus, max_memory_mb, bootable_templates) ON runner_facts TO runner_facts_definer;
GRANT SELECT (max_vms, max_vcpus, max_memory_mb, bootable_templates) ON runner_facts TO app_user;

GRANT SELECT, INSERT, DELETE ON runner_sandboxes TO runner_facts_definer;
GRANT SELECT, INSERT, UPDATE ON runner_sandbox_reports TO runner_facts_definer;
GRANT SELECT ON runner_sandboxes, runner_sandbox_reports TO app_user;

CREATE POLICY tenant_isolation_select ON runner_sandboxes FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY tenant_isolation_select ON runner_sandbox_reports FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

CREATE POLICY runner_sandboxes_definer_select ON runner_sandboxes FOR SELECT TO runner_facts_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_sandboxes_definer_insert ON runner_sandboxes FOR INSERT TO runner_facts_definer WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_sandboxes_definer_delete ON runner_sandboxes FOR DELETE TO runner_facts_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_sandbox_reports_definer_select ON runner_sandbox_reports FOR SELECT TO runner_facts_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_sandbox_reports_definer_insert ON runner_sandbox_reports FOR INSERT TO runner_facts_definer WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_sandbox_reports_definer_update ON runner_sandbox_reports FOR UPDATE TO runner_facts_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---- ownership bracket (0783's shape) -------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_facts_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_facts_definer; cannot ALTER FUNCTION ... OWNER';
    END IF;
    GRANT runner_facts_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_facts_definer;

-- Host limits for the runner the session names. The facts row is made by runner_facts_record on the same hello, so a missing row is an error, not a guess.
-- Null clears a column (a runner that stops reporting a limit stops being credited with it). Values are claims: used for routing and display only.
CREATE FUNCTION runner_sandbox_facts_record(p_max_vms integer, p_max_vcpus integer, p_max_memory_mb integer, p_templates text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rid  uuid;
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
  v_protocol integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION '%: refused for a platform_ops login', 'runner_sandbox_facts_record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A live runner of an active account, named by the session (as in runner_facts_record): no runner in the session, a revoked one or another account's one writes nothing.
  IF acct IS NULL OR NOT account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION '%: the session is not a live runner of an active account', 'runner_sandbox_facts_record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  rid := raw::uuid;
  IF (p_max_vms IS NOT NULL AND p_max_vms NOT BETWEEN 0 AND 256) OR (p_max_vcpus IS NOT NULL AND p_max_vcpus NOT BETWEEN 0 AND 4096)
     OR (p_max_memory_mb IS NOT NULL AND p_max_memory_mb NOT BETWEEN 0 AND 16777216) OR NOT public.runner_templates_valid(COALESCE(p_templates, '{}')) THEN
    RAISE EXCEPTION 'runner_sandbox_facts_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT r.protocol_version INTO v_protocol FROM public.runners r WHERE r.id = rid AND r.account_id = acct;
  IF (p_max_vms IS NOT NULL OR p_max_vcpus IS NOT NULL OR p_max_memory_mb IS NOT NULL OR cardinality(COALESCE(p_templates, '{}')) > 0) AND COALESCE(v_protocol, 0) < 21 THEN
    RAISE EXCEPTION 'runner_sandbox_facts_record: the runner declared a protocol below 21' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.runner_facts f SET max_vms = p_max_vms, max_vcpus = p_max_vcpus, max_memory_mb = p_max_memory_mb, bootable_templates = COALESCE(p_templates, '{}')
   WHERE f.runner_id = rid AND f.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_sandbox_facts_record: the runner has reported no facts' USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- Replaces the runner's whole inventory with the list sent. Refuses, before any write: a protocol below 21, a non-array, more than 200 rows, a row with an
-- unknown or missing key, a bad name, state, time or number, and a repeated name. A refusal leaves the old list and the old seen_at untouched.
CREATE FUNCTION runner_sandboxes_record(p_rows jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rid  uuid;
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
  v_protocol integer;
  n    integer;
  e    jsonb;
  k    text;
  keys text[] := ARRAY['name', 'state', 'created_at', 'last_used_at', 'disk_bytes', 'snapshot_count', 'snapshot_age_s'];
  ts   text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$';
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION '%: refused for a platform_ops login', 'runner_sandboxes_record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A live runner of an active account, named by the session (as in runner_facts_record): no runner in the session, a revoked one or another account's one writes nothing.
  IF acct IS NULL OR NOT account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION '%: the session is not a live runner of an active account', 'runner_sandboxes_record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  rid := raw::uuid;
  SELECT r.protocol_version INTO v_protocol FROM public.runners r WHERE r.id = rid AND r.account_id = acct;
  IF COALESCE(v_protocol, 0) < 21 THEN
    RAISE EXCEPTION 'runner_sandboxes_record: the runner declared a protocol below 21' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 200 THEN
    RAISE EXCEPTION 'runner_sandboxes_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  n := jsonb_array_length(p_rows);
  FOR e IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(e) <> 'object' THEN
      RAISE EXCEPTION 'runner_sandboxes_record: a row is not an object' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    FOR k IN SELECT jsonb_object_keys(e) LOOP
      IF NOT (k = ANY (keys)) THEN
        RAISE EXCEPTION 'runner_sandboxes_record: unknown key' USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END LOOP;
    IF (SELECT count(*) FROM jsonb_object_keys(e)) <> cardinality(keys)
       OR jsonb_typeof(e -> 'name') <> 'string' OR (e ->> 'name') !~ '^[a-z0-9][a-z0-9-]{0,39}$'
       OR jsonb_typeof(e -> 'state') <> 'string' OR (e ->> 'state') NOT IN ('creating', 'running', 'stopped', 'snapshotted', 'error')
       OR jsonb_typeof(e -> 'created_at') <> 'string' OR (e ->> 'created_at') !~ ts
       OR NOT (jsonb_typeof(e -> 'last_used_at') = 'null' OR (jsonb_typeof(e -> 'last_used_at') = 'string' AND (e ->> 'last_used_at') ~ ts))
       OR jsonb_typeof(e -> 'disk_bytes') <> 'number' OR (e ->> 'disk_bytes') !~ '^[0-9]{1,15}$'
       OR jsonb_typeof(e -> 'snapshot_count') <> 'number' OR (e ->> 'snapshot_count') !~ '^[0-9]{1,5}$' OR (e ->> 'snapshot_count')::integer > 10000
       OR NOT (jsonb_typeof(e -> 'snapshot_age_s') = 'null' OR (jsonb_typeof(e -> 'snapshot_age_s') = 'number' AND (e ->> 'snapshot_age_s') ~ '^[0-9]{1,10}$' AND (e ->> 'snapshot_age_s')::bigint <= 2147483647)) THEN
      RAISE EXCEPTION 'runner_sandboxes_record: invalid row' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT x ->> 'name') FROM jsonb_array_elements(p_rows) AS x) <> n THEN
    RAISE EXCEPTION 'runner_sandboxes_record: a name appears twice' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM public.runner_sandboxes s WHERE s.runner_id = rid AND s.account_id = acct;
  INSERT INTO public.runner_sandboxes (runner_id, slot, account_id, name, state, created_at, last_used_at, disk_bytes, snapshot_count, snapshot_age_s)
  SELECT rid, (t.ord - 1)::smallint, acct, t.x ->> 'name', t.x ->> 'state', (t.x ->> 'created_at')::timestamptz, (t.x ->> 'last_used_at')::timestamptz,
         (t.x ->> 'disk_bytes')::bigint, (t.x ->> 'snapshot_count')::integer, (t.x ->> 'snapshot_age_s')::bigint
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(x, ord);
  INSERT INTO public.runner_sandbox_reports AS rep (runner_id, account_id, seen_at, row_count) VALUES (rid, acct, now(), n)
  ON CONFLICT (runner_id) DO UPDATE SET seen_at = now(), row_count = EXCLUDED.row_count;
END;
$$;

-- ---- owners, execute grants, and the bracket closed -----------------------------------------------------------------
REVOKE ALL ON FUNCTION runner_sandbox_facts_record(integer, integer, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_sandbox_facts_record(integer, integer, integer, text[]) TO app_user;
ALTER FUNCTION runner_sandbox_facts_record(integer, integer, integer, text[]) OWNER TO runner_facts_definer;
REVOKE ALL ON FUNCTION runner_sandboxes_record(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_sandboxes_record(jsonb) TO app_user;
ALTER FUNCTION runner_sandboxes_record(jsonb) OWNER TO runner_facts_definer;
REVOKE CREATE ON SCHEMA public FROM runner_facts_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_facts_definer FROM CURRENT_USER;
  END IF;
END
$$;
