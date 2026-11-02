-- D#483 S5-b2d-1: follow-ups that reviewers and executors raise, stored once per parent item, plus the per-repo switch that decides whether a
-- follow-up becomes its own item (`child`) or stays a note on the parent (`note`). Nothing here creates a child item: S5-b2d-2 does that.
--
--   1. follow_up_settings: append-only, one row per change, the highest `version` per repo is the current value. No row means on. app_user reads it;
--      only follow_up_setting_write (below) writes it, together with one audit row naming the actor and both values.
--   2. work_item_follow_ups: append-only. One row per (account, parent, title_key); title_key is the sha256 of the title lowercased, with runs of white
--      space folded to one space and the ends trimmed, so the same follow-up from two reviewers is one row. `disposition` is stamped from the repo's
--      setting when the row is written and never derived later: switching the setting must not create or delete children behind a person's back.
--      `child_id` stays NULL until S5-b2d-2. app_user reads it; only follow_ups_record writes it. No role holds UPDATE or DELETE on either table.
--   3. work_items.follow_up_id: nullable, unique where set. Nobody may set or change it in this migration (a guard trigger, as 0919's); S5-b2d-2
--      replaces the guard to admit its own child-creating definer. No foreign key: a parent's deletion cascades its follow-ups, and a SET NULL on a
--      child would be a change the guard refuses.
--   4. follow_ups_record(run, items): SECURITY DEFINER, owned by follow_ups_record_definer, EXECUTE for agent_run_writer (the worker's runner login,
--      which records review verdicts and reads build ends). It re-checks at the data: the run is this tenant's, SUCCEEDED, on a work item, and one of
--      code-reviewer, security-reviewer, acceptance-tester or executor. Any other run records nothing. Then, per item: a valid shape (an object whose
--      title is a string of 1 to 120 characters and why a string of 0 to 600, no control characters), at most 3 per run, at most 10 per parent.
--      Answers {recorded, duplicates, capped, dropped}: dropped = bad shape or past the run's 3; capped = past the parent's 10.
--   5. follow_up_setting_write(repo, children): SECURITY DEFINER, owned by follow_up_setting_definer, EXECUTE for app_user (the web session login).
--      The session's user must be an owner or admin of the account. Choosing the value in force writes nothing.
--
-- Both definers: their own NOLOGIN role, a pinned search_path, a platform_ops refusal, fixed error messages with no argument values
-- (42501 not permitted, 22023 bad argument, P0002 not found), column grants for exactly what the body reads and writes, and policies confined to the
-- tenant in context. Expand-only: two tables, a nullable column, a trigger and two functions. Numbered 0960: main's highest is 0955 and open work holds
-- 0956 to 0959; re-checked at open and before merge. Neon shape: packages/db/neon-shape.d/0960_follow_ups.conf.

-- ---- roles ----------------------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['follow_ups_record_definer', 'follow_up_setting_definer'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
      RAISE EXCEPTION 'role % still has a privileged attribute', n;
    END IF;
  END LOOP;
END
$$;

-- ---- 1. the setting ---------------------------------------------------------------------------------------------------------------------------
CREATE TABLE follow_up_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id     uuid NOT NULL,
  children    boolean NOT NULL,
  version     integer NOT NULL CONSTRAINT follow_up_settings_version_check CHECK (version >= 1),
  changed_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT follow_up_settings_repo_version_key UNIQUE (account_id, repo_id, version),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE NO ACTION
);
ALTER TABLE follow_up_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON follow_up_settings FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
GRANT SELECT ON follow_up_settings TO app_user;

-- ---- 2. the follow-ups ------------------------------------------------------------------------------------------------------------------------
CREATE TABLE work_item_follow_ups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id  uuid NOT NULL,
  source_run_id uuid,
  source_role   text NOT NULL CONSTRAINT work_item_follow_ups_role_check CHECK (source_role IN ('code-reviewer', 'security-reviewer', 'acceptance-tester', 'executor')),
  title         text NOT NULL CONSTRAINT work_item_follow_ups_title_check CHECK (char_length(title) BETWEEN 1 AND 120 AND title !~ '[[:cntrl:]]'),
  why           text NOT NULL CONSTRAINT work_item_follow_ups_why_check CHECK (char_length(why) <= 600 AND why !~ '[[:cntrl:]]'),
  title_key     text NOT NULL CONSTRAINT work_item_follow_ups_title_key_check CHECK (title_key ~ '^[0-9a-f]{64}$'),
  disposition   text NOT NULL CONSTRAINT work_item_follow_ups_disposition_check CHECK (disposition IN ('child', 'note')),
  child_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_item_follow_ups_once UNIQUE (account_id, work_item_id, title_key),
  CONSTRAINT work_item_follow_ups_child_only_for_child CHECK (child_id IS NULL OR disposition = 'child'),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, work_item_id) REFERENCES work_items (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, source_run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (source_run_id),
  FOREIGN KEY (account_id, child_id) REFERENCES work_items (account_id, id) ON DELETE SET NULL (child_id)
);
CREATE INDEX work_item_follow_ups_source_run ON work_item_follow_ups (account_id, source_run_id);
ALTER TABLE work_item_follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_follow_ups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON work_item_follow_ups FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
         AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
GRANT SELECT ON work_item_follow_ups TO app_user;

-- ---- 3. the child link on work_items ----------------------------------------------------------------------------------------------------------
ALTER TABLE work_items ADD COLUMN follow_up_id uuid;
CREATE UNIQUE INDEX work_items_follow_up_once ON work_items (follow_up_id) WHERE follow_up_id IS NOT NULL;

CREATE FUNCTION work_items_follow_up_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.follow_up_id IS NOT NULL THEN
      RAISE EXCEPTION 'work_items: a follow-up child is created only by the follow-up definer' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.follow_up_id IS DISTINCT FROM OLD.follow_up_id THEN
    RAISE EXCEPTION 'work_items: a follow-up link does not change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION work_items_follow_up_guard() FROM PUBLIC;
CREATE TRIGGER work_items_follow_up_guard BEFORE INSERT OR UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION work_items_follow_up_guard();

-- ---- the definers' reach ----------------------------------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO follow_ups_record_definer, follow_up_setting_definer;
GRANT SELECT (id, deleted_at) ON accounts TO follow_ups_record_definer, follow_up_setting_definer;
CREATE POLICY follow_ups_record_definer_select ON accounts FOR SELECT TO follow_ups_record_definer
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_setting_definer_select ON accounts FOR SELECT TO follow_up_setting_definer
  USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);

GRANT SELECT (id, account_id, role, status, work_item_id) ON agent_runs TO follow_ups_record_definer;
GRANT SELECT (id, account_id, repo_id) ON work_items TO follow_ups_record_definer;
GRANT SELECT (account_id, repo_id, children, version) ON follow_up_settings TO follow_ups_record_definer;
GRANT SELECT (account_id, work_item_id, source_run_id, title_key) ON work_item_follow_ups TO follow_ups_record_definer;
GRANT INSERT (account_id, work_item_id, source_run_id, source_role, title, why, title_key, disposition) ON work_item_follow_ups TO follow_ups_record_definer;
CREATE POLICY follow_ups_record_definer_select ON agent_runs FOR SELECT TO follow_ups_record_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_ups_record_definer_select ON work_items FOR SELECT TO follow_ups_record_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_ups_record_definer_select ON follow_up_settings FOR SELECT TO follow_ups_record_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_ups_record_definer_select ON work_item_follow_ups FOR SELECT TO follow_ups_record_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_ups_record_definer_insert ON work_item_follow_ups FOR INSERT TO follow_ups_record_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

GRANT SELECT (account_id, user_id, role) ON account_members TO follow_up_setting_definer;
GRANT SELECT (id, account_id) ON repos TO follow_up_setting_definer;
GRANT SELECT (account_id, repo_id, children, version) ON follow_up_settings TO follow_up_setting_definer;
GRANT INSERT (account_id, repo_id, children, version, changed_by) ON follow_up_settings TO follow_up_setting_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO follow_up_setting_definer;
CREATE POLICY follow_up_setting_definer_select ON account_members FOR SELECT TO follow_up_setting_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_setting_definer_select ON repos FOR SELECT TO follow_up_setting_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_setting_definer_select ON follow_up_settings FOR SELECT TO follow_up_setting_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_setting_definer_insert ON follow_up_settings FOR INSERT TO follow_up_setting_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY follow_up_setting_definer_audit ON audit_log FOR INSERT TO follow_up_setting_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'follow_up_setting.changed');

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['follow_ups_record_definer', 'follow_up_setting_definer'] LOOP
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot ALTER FUNCTION ... OWNER TO it', r;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', r);
    END IF;
    EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', r);
  END LOOP;
END
$$;

-- ---- 4. follow_ups_record -------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION follow_ups_record(p_run_id uuid, p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct       uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  run        record;
  repo       uuid;
  on_        boolean;
  from_run   integer;
  on_parent  integer;
  e          jsonb;
  pos        integer := 0;
  t          text;
  w          text;
  k          text;
  seen       text[] := ARRAY[]::text[];
  n_rec      integer := 0;
  n_dup      integer := 0;
  n_cap      integer := 0;
  n_drop     integer := 0;
  made       integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'follow_ups_record: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'follow_ups_record: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL OR p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) > 10 THEN
    RAISE EXCEPTION 'follow_ups_record: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The run, re-read here: another tenant's run, a run that did not succeed, a run on no item and any other role (the debater) record nothing.
  SELECT r.role, r.status, r.work_item_id INTO run FROM public.agent_runs r WHERE r.id = p_run_id AND r.account_id = acct;
  IF NOT FOUND OR run.status IS DISTINCT FROM 'succeeded' OR run.work_item_id IS NULL
     OR run.role NOT IN ('code-reviewer', 'security-reviewer', 'acceptance-tester', 'executor') THEN
    RETURN jsonb_build_object('recorded', 0, 'duplicates', 0, 'capped', 0, 'dropped', jsonb_array_length(p_items));
  END IF;
  -- One writer per parent at a time, so the caps are counted against rows that cannot move under the count.
  PERFORM pg_advisory_xact_lock(hashtextextended('follow_ups:' || acct::text || ':' || run.work_item_id::text, 0));
  SELECT w2.repo_id INTO repo FROM public.work_items w2 WHERE w2.id = run.work_item_id AND w2.account_id = acct;
  -- The setting at this moment: no row is on.
  SELECT s.children INTO on_ FROM public.follow_up_settings s
   WHERE s.account_id = acct AND s.repo_id = repo ORDER BY s.version DESC LIMIT 1;
  on_ := coalesce(on_, true);
  SELECT count(*) INTO from_run FROM public.work_item_follow_ups f WHERE f.account_id = acct AND f.source_run_id = p_run_id;
  SELECT count(*) INTO on_parent FROM public.work_item_follow_ups f WHERE f.account_id = acct AND f.work_item_id = run.work_item_id;

  FOR e IN SELECT v FROM jsonb_array_elements(p_items) AS x (v) LOOP
    pos := pos + 1;
    IF pos > 3 OR jsonb_typeof(e) IS DISTINCT FROM 'object' OR jsonb_typeof(e -> 'title') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e -> 'why') IS DISTINCT FROM 'string' THEN
      n_drop := n_drop + 1;
      CONTINUE;
    END IF;
    t := btrim(e ->> 'title');
    w := btrim(e ->> 'why');
    IF char_length(e ->> 'title') > 120 OR char_length(t) < 1 OR t ~ '[[:cntrl:]]' OR char_length(e ->> 'why') > 600 OR w ~ '[[:cntrl:]]' THEN
      n_drop := n_drop + 1;
      CONTINUE;
    END IF;
    k := encode(sha256(convert_to(btrim(regexp_replace(lower(t), '[[:space:]]+', ' ', 'g')), 'UTF8')), 'hex');
    IF k = ANY (seen) OR EXISTS (SELECT 1 FROM public.work_item_follow_ups f WHERE f.account_id = acct AND f.work_item_id = run.work_item_id AND f.title_key = k) THEN
      n_dup := n_dup + 1;
      CONTINUE;
    END IF;
    seen := seen || k;
    IF from_run >= 3 THEN
      n_drop := n_drop + 1;
      CONTINUE;
    END IF;
    IF on_parent >= 10 THEN
      n_cap := n_cap + 1;
      CONTINUE;
    END IF;
    INSERT INTO public.work_item_follow_ups (account_id, work_item_id, source_run_id, source_role, title, why, title_key, disposition)
    VALUES (acct, run.work_item_id, p_run_id, run.role, t, w, k, CASE WHEN on_ THEN 'child' ELSE 'note' END)
    ON CONFLICT (account_id, work_item_id, title_key) DO NOTHING;
    GET DIAGNOSTICS made = ROW_COUNT;
    IF made = 1 THEN
      n_rec := n_rec + 1;
      from_run := from_run + 1;
      on_parent := on_parent + 1;
    ELSE
      n_dup := n_dup + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('recorded', n_rec, 'duplicates', n_dup, 'capped', n_cap, 'dropped', n_drop);
END $$;

-- ---- 5. follow_up_setting_write -------------------------------------------------------------------------------------------------------------
CREATE FUNCTION follow_up_setting_write(p_repo_id uuid, p_children boolean)
RETURNS TABLE (o_children boolean, o_previous boolean, o_version integer, o_written boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr   uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  cur   record;
  prev  boolean;
  nextv integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'follow_up_setting_write: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR usr IS NULL OR NULLIF(current_setting('app.token_id', true), '') IS NOT NULL OR NOT public.account_is_active(acct)
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'follow_up_setting_write: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL OR p_children IS NULL THEN
    RAISE EXCEPTION 'follow_up_setting_write: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.id = p_repo_id AND r.account_id = acct) THEN
    RAISE EXCEPTION 'follow_up_setting_write: not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('follow_up_setting:' || acct::text || ':' || p_repo_id::text, 0));
  SELECT s.children, s.version INTO cur FROM public.follow_up_settings s
   WHERE s.account_id = acct AND s.repo_id = p_repo_id ORDER BY s.version DESC LIMIT 1;
  prev := coalesce(cur.children, true);
  IF prev = p_children THEN
    RETURN QUERY SELECT p_children, prev, cur.version, false; RETURN;
  END IF;
  nextv := coalesce(cur.version, 0) + 1;
  INSERT INTO public.follow_up_settings (account_id, repo_id, children, version, changed_by) VALUES (acct, p_repo_id, p_children, nextv, usr);
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'follow_up_setting.changed',
          jsonb_build_object('repo_id', p_repo_id, 'previous', prev, 'children', p_children, 'version', nextv), clock_timestamp());
  RETURN QUERY SELECT p_children, prev, nextv, true;
END $$;

-- ---- ownership and EXECUTE ----------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION follow_ups_record(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION follow_up_setting_write(uuid, boolean) FROM PUBLIC;
ALTER FUNCTION follow_ups_record(uuid, jsonb) OWNER TO follow_ups_record_definer;
ALTER FUNCTION follow_up_setting_write(uuid, boolean) OWNER TO follow_up_setting_definer;
-- EXECUTE after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION follow_ups_record(uuid, jsonb) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION follow_up_setting_write(uuid, boolean) TO app_user;

REVOKE CREATE ON SCHEMA public FROM follow_ups_record_definer, follow_up_setting_definer;
DO $$
DECLARE
  r text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH r IN ARRAY ARRAY['follow_ups_record_definer', 'follow_up_setting_definer'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', r);
    END LOOP;
  END IF;
END
$$;
