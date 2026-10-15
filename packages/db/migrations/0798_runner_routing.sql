-- D#605 FL-4: what the runner claim needs from the database to route a run by rules.
--
--   1. agent_runs.claimable_since. The moment a run last became claimable: set by the column's default when a run is made (a dispatch, a follow-up, the
--      child a lost runner leaves, a handoff child are all inserts) and again by a trigger on any later move of the status INTO pending. The prefer
--      hold in the claim counts its 120 s from here, so a requeued run keeps its hold (created_at would end it). app_user may read it (the claim runs
--      as a member of app_user) and nobody but the trigger writes it: no column UPDATE grant exists for it, and INSERT on agent_runs is not granted.
--   2. repos.runner_routing and work_items.runner_routing: jsonb {require:{os,arch,engine,labels[],heavy_labels[]}, prefer:[runner_id...]} or NULL.
--      runner_routing_valid is the one schema check. A BEFORE INSERT OR UPDATE trigger on each table refuses any change to the column from anyone but
--      runner_routing_set's owner (or a superuser, the migrator) and runs the check on what it lets through. The trigger, not a column grant, is the
--      guard because app_user holds a table-wide INSERT and UPDATE on repos and a table-wide INSERT on work_items, which a column revoke cannot narrow
--      (0781's reason for its placement guard). The trigger function calls the check only after the refusal, so a role that writes other columns never
--      needs EXECUTE on it.
--   3. runner_routing_set(kind, id, routing): the only writer. NOLOGIN owner runner_routing_definer, column grants for what the body reads and writes,
--      a pinned search_path, EXECUTE for app_user alone, nothing for platform_ops. It re-derives the caller's membership and role on every call (owner or
--      admin only, 42501), refuses a `prefer` entry that is not a live runner of the caller's account (22023, nothing written), answers P0002 for another
--      account's repo or item, and writes one audit row. A NULL routing clears the rules.
--   4. runner_claim_stamps becomes readable by app_user for the caller's own account (column grant plus a tenant policy, the shape of 0777's
--      runner_capacity). The claim reads the preferred runners' last accepted poll once per poll. Writes stay with runner_lease_definer.
--
-- Facts, labels, preferences and rules only ever narrow or reorder what the claim's existing filters allow. Nothing in this file is an authorization input.
--
-- Numbered above the highest migration on the code plane (0797 is held by another open change). Re-check against main right before merging.

-- ---- 1. claimable_since ---------------------------------------------------------------------------------------------
ALTER TABLE agent_runs ADD COLUMN claimable_since timestamptz NOT NULL DEFAULT now();
GRANT SELECT (claimable_since) ON agent_runs TO app_user;

CREATE FUNCTION agent_runs_claimable_since_touch() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending' THEN
    NEW.claimable_since := now();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION agent_runs_claimable_since_touch() FROM PUBLIC;
CREATE TRIGGER agent_runs_claimable_since BEFORE UPDATE OF status ON agent_runs FOR EACH ROW EXECUTE FUNCTION agent_runs_claimable_since_touch();

-- ---- 2. the rules and their schema check -----------------------------------------------------------------------------
ALTER TABLE repos ADD COLUMN runner_routing jsonb;
ALTER TABLE work_items ADD COLUMN runner_routing jsonb;

DO $$
DECLARE
  n text := 'runner_routing_definer';
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

-- NULL is "no rules". Otherwise an object whose only keys are require and prefer. require holds, each optional: os (linux|macos), arch (x64|arm64), engine
-- (os_sandbox|microvm), labels and heavy_labels (at most 16 distinct labels of ^[a-z0-9][a-z0-9-]{0,31}$ each). prefer is at most 20 distinct runner ids, in order.
CREATE FUNCTION runner_routing_valid(p jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  k    text;
  v    jsonb;
  e    jsonb;
  s    text;
  seen text[];
BEGIN
  IF p IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(p) <> 'object' THEN RETURN false; END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('require', 'prefer') THEN RETURN false; END IF;
  END LOOP;
  IF p ? 'require' THEN
    IF jsonb_typeof(p->'require') <> 'object' THEN RETURN false; END IF;
    FOR k, v IN SELECT * FROM jsonb_each(p->'require') LOOP
      IF k = 'os' THEN
        IF jsonb_typeof(v) <> 'string' OR (v #>> '{}') NOT IN ('linux', 'macos') THEN RETURN false; END IF;
      ELSIF k = 'arch' THEN
        IF jsonb_typeof(v) <> 'string' OR (v #>> '{}') NOT IN ('x64', 'arm64') THEN RETURN false; END IF;
      ELSIF k = 'engine' THEN
        IF jsonb_typeof(v) <> 'string' OR (v #>> '{}') NOT IN ('os_sandbox', 'microvm') THEN RETURN false; END IF;
      ELSIF k IN ('labels', 'heavy_labels') THEN
        IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) > 16 THEN RETURN false; END IF;
        seen := '{}';
        FOR e IN SELECT * FROM jsonb_array_elements(v) LOOP
          IF jsonb_typeof(e) <> 'string' THEN RETURN false; END IF;
          s := e #>> '{}';
          IF s !~ '^[a-z0-9][a-z0-9-]{0,31}$' OR s = ANY (seen) THEN RETURN false; END IF;
          seen := seen || s;
        END LOOP;
      ELSE
        RETURN false;
      END IF;
    END LOOP;
  END IF;
  IF p ? 'prefer' THEN
    IF jsonb_typeof(p->'prefer') <> 'array' OR jsonb_array_length(p->'prefer') > 20 THEN RETURN false; END IF;
    seen := '{}';
    FOR e IN SELECT * FROM jsonb_array_elements(p->'prefer') LOOP
      IF jsonb_typeof(e) <> 'string' THEN RETURN false; END IF;
      s := e #>> '{}';
      IF s !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR s = ANY (seen) THEN RETURN false; END IF;
      seen := seen || s;
    END LOOP;
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION runner_routing_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_routing_valid(jsonb) TO runner_routing_definer;

CREATE FUNCTION runner_routing_write_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.runner_routing IS NULL THEN RETURN NEW; END IF;
  ELSIF NEW.runner_routing IS NOT DISTINCT FROM OLD.runner_routing THEN
    RETURN NEW;
  END IF;
  IF current_user <> 'runner_routing_definer' AND NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION '%: runner_routing is written only by runner_routing_set', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.runner_routing_valid(NEW.runner_routing) THEN
    RAISE EXCEPTION '%: runner_routing does not match its schema', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION runner_routing_write_guard() FROM PUBLIC;
CREATE TRIGGER repos_runner_routing_guard BEFORE INSERT OR UPDATE ON repos FOR EACH ROW EXECUTE FUNCTION runner_routing_write_guard();
CREATE TRIGGER work_items_runner_routing_guard BEFORE INSERT OR UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION runner_routing_write_guard();

-- ---- grants and policies: the one writer -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO runner_routing_definer;
GRANT SELECT (id, account_id, runner_routing), UPDATE (runner_routing) ON repos TO runner_routing_definer;
GRANT SELECT (id, account_id, runner_routing), UPDATE (runner_routing) ON work_items TO runner_routing_definer;
GRANT SELECT (id, account_id, revoked_at) ON runners TO runner_routing_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO runner_routing_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_routing_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO runner_routing_definer;

CREATE POLICY runner_routing_definer_select ON repos FOR SELECT TO runner_routing_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_routing_definer_update ON repos FOR UPDATE TO runner_routing_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_routing_definer_select ON work_items FOR SELECT TO runner_routing_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_routing_definer_update ON work_items FOR UPDATE TO runner_routing_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_routing_definer_select ON runners FOR SELECT TO runner_routing_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- Shows this role only the caller's own membership row, as 0783 does.
CREATE POLICY runner_routing_definer_select ON account_members FOR SELECT TO runner_routing_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY runner_routing_definer_select ON accounts FOR SELECT TO runner_routing_definer USING (true);
CREATE POLICY runner_routing_definer_audit ON audit_log FOR INSERT TO runner_routing_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'runner.routing_set');

-- ---- 4. the claim reads the poll stamps ------------------------------------------------------------------------------
GRANT SELECT (runner_id, account_id, last_claim_at) ON runner_claim_stamps TO app_user;
CREATE POLICY tenant_isolation_select ON runner_claim_stamps FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

-- ---- ownership bracket (0790's shape) --------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_routing_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_routing_definer; cannot ALTER FUNCTION ... OWNER TO runner_routing_definer';
    END IF;
    GRANT runner_routing_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_routing_definer;

CREATE FUNCTION runner_routing_set(p_kind text, p_id uuid, p_routing jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  v_role text;
  v_prev jsonb;
  v_ts   timestamptz := clock_timestamp();
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_routing_set: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'runner_routing_set: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('repo', 'work_item') OR p_id IS NULL OR NOT public.runner_routing_valid(p_routing) THEN
    RAISE EXCEPTION 'runner_routing_set: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- A preferred runner must be a live runner of this account, so a rule can name no other account's machine and no removed one.
  IF p_routing IS NOT NULL AND p_routing ? 'prefer' AND (
       SELECT count(*) FROM jsonb_array_elements_text(p_routing->'prefer') AS x
         JOIN public.runners r ON r.id = x::uuid AND r.account_id = acct AND r.revoked_at IS NULL
     ) <> jsonb_array_length(p_routing->'prefer') THEN
    RAISE EXCEPTION 'runner_routing_set: a preferred runner is not a live runner of the account' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_kind = 'repo' THEN
    SELECT g.runner_routing INTO v_prev FROM public.repos g WHERE g.id = p_id AND g.account_id = acct FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'runner_routing_set: no such repository' USING ERRCODE = 'no_data_found';
    END IF;
    UPDATE public.repos SET runner_routing = p_routing WHERE id = p_id AND account_id = acct;
  ELSE
    SELECT w.runner_routing INTO v_prev FROM public.work_items w WHERE w.id = p_id AND w.account_id = acct FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'runner_routing_set: no such work item' USING ERRCODE = 'no_data_found';
    END IF;
    UPDATE public.work_items SET runner_routing = p_routing WHERE id = p_id AND account_id = acct;
  END IF;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'runner.routing_set', jsonb_build_object('kind', p_kind, 'id', p_id, 'routing', p_routing, 'previous', v_prev), v_ts);
END;
$$;

REVOKE ALL ON FUNCTION runner_routing_set(text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_routing_set(text, uuid, jsonb) TO app_user;
ALTER FUNCTION runner_routing_set(text, uuid, jsonb) OWNER TO runner_routing_definer;
REVOKE CREATE ON SCHEMA public FROM runner_routing_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_routing_definer FROM CURRENT_USER;
  END IF;
END
$$;
