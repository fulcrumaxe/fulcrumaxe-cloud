-- D#845 ON-13a4: the finish phase of a project setup (Ruling 64, Ruling 93). After the install pull request merges the setup is at phase `finish`, and a level-triggered reconcile job (`setup_finish`) does, from rows:
--   one Discussion per kept row of the approved plan, through the App, recorded one by one in project_seeded_rows (idempotent: a row already recorded is never created again);
--   the team-log issue (Ruling 43.6), its number recorded on the setup;
--   then it records `start_pending` on the setup when the repo is operated (item 9: watch AND operate AND ticked), and moves the setup to phase `done`.
-- It issues no engine start (Ruling 93.2: the system start is ON-13c's, from `start_pending`). A refusal that no retry fixes (Discussions off, no category, the App refused) is the setup's `seed_failed`: phase stays `finish`,
-- state `failed`; the job looks again fifteen minutes later (at most 96 times), and a success clears the failure. A GitHub that cannot be asked is only a retry, but the 24th retry in a row is the same failure (a mint that
-- always fails must surface, not loop unseen).
--
--   1. project_setups: finish_claim_at (the ten minute lease of a pass), finish_tries (failed passes, capped at 96), finish_retries (passes that could not reach GitHub, capped at 24), team_log_issue (the issue's number), start_pending (the record for ON-13c).
--   2. project_seeded_rows (account_id, setup_id, row_key, discussion_number): one row per seeded Discussion. Row security forced; app_user may read its own account's rows and nothing else; only the definer writes.
--   3. setup_finish_definer, a NOLOGIN role of its own, owns six functions that only platform_ops can run (the reconcile login):
--        setup_finish_claim()           the oldest due setup, leased: its repo, the approved plan's kept rows and the rows already seeded.
--        setup_finish_pending()         whether a setup is due or failed within its retry window (the reconcile gate's reason to connect again).
--        setup_finish_seed_record(setup, attempt, row_key, number)   records one seeded Discussion; refuses a row key the approved plan does not keep.
--        setup_finish_complete(setup, attempt, team_log)   when every kept row is recorded: stores the issue, records start_pending, moves the setup to `done`.
--        setup_finish_fail(setup, attempt, code)   the one closed code `seed_failed`.
--        setup_finish_retry(setup, attempt)        counts a pass that could not reach GitHub; the 24th is recorded as `seed_failed` (answers 'retry', 'failed' or 'skipped').
--      Each re-reads the setup under its lock and changes nothing unless it is still at phase `finish` at the attempt the claim saw.
--   4. The reconcile row of the job (900 s; the install merge's webhook marks the reconciler).
-- Numbered 1085 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE project_setups
  ADD COLUMN finish_claim_at timestamptz,
  ADD COLUMN finish_tries smallint NOT NULL DEFAULT 0 CONSTRAINT project_setups_finish_tries_check CHECK (finish_tries BETWEEN 0 AND 96),
  ADD COLUMN finish_retries smallint NOT NULL DEFAULT 0 CONSTRAINT project_setups_finish_retries_check CHECK (finish_retries BETWEEN 0 AND 24),
  ADD COLUMN team_log_issue integer CONSTRAINT project_setups_team_log_issue_check CHECK (team_log_issue IS NULL OR team_log_issue > 0),
  ADD COLUMN start_pending boolean NOT NULL DEFAULT false;

CREATE TABLE project_seeded_rows (
  account_id        uuid NOT NULL,
  setup_id          uuid NOT NULL,
  row_key           text NOT NULL CHECK (row_key ~ '^[A-Z][A-Z0-9-]{0,15}$'),
  discussion_number integer NOT NULL CHECK (discussion_number > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (setup_id, row_key),
  FOREIGN KEY (account_id, setup_id) REFERENCES project_setups (account_id, id) ON DELETE CASCADE
);
CREATE INDEX project_seeded_rows_account ON project_seeded_rows (account_id, setup_id);

ALTER TABLE project_seeded_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_seeded_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_seeded_rows FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
GRANT SELECT ON project_seeded_rows TO app_user;

DO $$
DECLARE
  n text := 'setup_finish_definer';
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

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'setup_finish_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on setup_finish_definer; cannot ALTER FUNCTION ... OWNER TO setup_finish_definer';
    END IF;
    GRANT setup_finish_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO setup_finish_definer;
GRANT USAGE ON SCHEMA public TO setup_finish_definer;

GRANT SELECT (id, account_id, repo_id, phase, sub_step, state, attempt, failure_code, failure_at, finish_claim_at, finish_tries, finish_retries, updated_at) ON project_setups TO setup_finish_definer;
GRANT UPDATE (phase, sub_step, state, failure_code, failure_reason, failure_at, finish_claim_at, finish_tries, finish_retries, team_log_issue, start_pending, updated_at) ON project_setups TO setup_finish_definer;
GRANT SELECT (id, account_id, repo_id, setup_id, status, version, roadmap) ON project_drafts TO setup_finish_definer;
GRANT SELECT (id, account_id, gh_owner, gh_name) ON repos TO setup_finish_definer;
GRANT SELECT (account_id, watch_enabled, operate_enabled) ON engine_bridge_settings TO setup_finish_definer;
GRANT SELECT (account_id, repo_id) ON engine_bridge_repos TO setup_finish_definer;
GRANT SELECT (account_id, setup_id, row_key, discussion_number) ON project_seeded_rows TO setup_finish_definer;
GRANT INSERT (account_id, setup_id, row_key, discussion_number, created_at) ON project_seeded_rows TO setup_finish_definer;
-- account_is_active() reads these two columns as its caller (the same grant and policy the other definers hold).
GRANT SELECT (id, deleted_at) ON accounts TO setup_finish_definer;

CREATE POLICY setup_finish_definer_select ON accounts FOR SELECT TO setup_finish_definer USING (true);
CREATE POLICY setup_finish_definer_select ON project_setups FOR SELECT TO setup_finish_definer USING (phase IN ('finish', 'done'));
CREATE POLICY setup_finish_definer_update ON project_setups FOR UPDATE TO setup_finish_definer USING (phase = 'finish') WITH CHECK (phase IN ('finish', 'done'));
CREATE POLICY setup_finish_definer_select ON project_drafts FOR SELECT TO setup_finish_definer USING (status = 'approved');
CREATE POLICY setup_finish_definer_select ON repos FOR SELECT TO setup_finish_definer USING (true);
CREATE POLICY setup_finish_definer_select ON engine_bridge_settings FOR SELECT TO setup_finish_definer USING (true);
CREATE POLICY setup_finish_definer_select ON engine_bridge_repos FOR SELECT TO setup_finish_definer USING (true);
CREATE POLICY setup_finish_definer_select ON project_seeded_rows FOR SELECT TO setup_finish_definer USING (true);
CREATE POLICY setup_finish_definer_insert ON project_seeded_rows FOR INSERT TO setup_finish_definer WITH CHECK (true);

-- The kept rows of a setup's approved plan, in plan order, with only the fields a Discussion is made of. Used by the definers below only (an invoker function: it runs as the definer that calls it; EXECUTE: its owner alone).
CREATE FUNCTION setup_finish_kept_rows(p_account uuid, p_repo uuid, p_setup uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('row_key', t.e ->> 'row_key', 'title', t.e ->> 'title', 'summary', t.e ->> 'summary', 'size', t.e ->> 'size', 'depends_on', t.e -> 'depends_on') ORDER BY t.ord), '[]'::jsonb)
    FROM (SELECT d.roadmap FROM public.project_drafts d
           WHERE d.account_id = p_account AND d.repo_id = p_repo AND d.setup_id = p_setup AND d.status = 'approved'
           ORDER BY d.version DESC LIMIT 1) draft,
         LATERAL jsonb_array_elements(draft.roadmap) WITH ORDINALITY AS t(e, ord)
   WHERE (t.e ->> 'keep')::boolean;
$$;

-- The oldest due setup, leased. Due: phase finish, and either no failure or a `seed_failed` fifteen minutes old with fewer than 96 failed passes; and no lease of the last ten minutes.
CREATE FUNCTION setup_finish_claim()
RETURNS TABLE (o_account uuid, o_setup uuid, o_repo uuid, o_attempt integer, o_owner text, o_name text, o_roadmap jsonb, o_seeded jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_id uuid; s_account uuid; s_repo uuid; s_attempt integer;
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_finish_claim: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.account_id, x.repo_id, x.attempt INTO s_id, s_account, s_repo, s_attempt FROM public.project_setups x
   WHERE x.phase = 'finish'
     AND (x.state <> 'failed' OR (x.failure_code = 'seed_failed' AND x.failure_at < now() - interval '15 minutes' AND x.finish_tries < 96))
     AND (x.finish_claim_at IS NULL OR x.finish_claim_at < now() - interval '10 minutes')
     AND public.account_is_active(x.account_id)
   ORDER BY x.updated_at, x.id
   LIMIT 1
   FOR UPDATE OF x SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.project_setups x SET finish_claim_at = now() WHERE x.account_id = s_account AND x.id = s_id;
  RETURN QUERY
    SELECT s_account, s_id, s_repo, s_attempt, r.gh_owner, r.gh_name, public.setup_finish_kept_rows(s_account, s_repo, s_id),
           COALESCE((SELECT jsonb_agg(jsonb_build_object('row_key', q.row_key, 'discussion_number', q.discussion_number) ORDER BY q.row_key) FROM public.project_seeded_rows q WHERE q.account_id = s_account AND q.setup_id = s_id), '[]'::jsonb)
      FROM public.repos r WHERE r.account_id = s_account AND r.id = s_repo;
END;
$$;

CREATE FUNCTION setup_finish_pending()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_finish_pending: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.project_setups x
     WHERE x.phase = 'finish' AND (x.state <> 'failed' OR (x.failure_code = 'seed_failed' AND x.finish_tries < 96)) AND public.account_is_active(x.account_id)
  );
END;
$$;

CREATE FUNCTION setup_finish_seed_record(p_setup uuid, p_attempt integer, p_row_key text, p_number integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_account uuid; s_repo uuid; stored integer;
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_finish_seed_record: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_setup IS NULL OR p_attempt IS NULL OR p_row_key IS NULL OR p_row_key !~ '^[A-Z][A-Z0-9-]{0,15}$' OR p_number IS NULL OR p_number < 1 THEN
    RAISE EXCEPTION 'setup_finish_seed_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.account_id, x.repo_id INTO s_account, s_repo FROM public.project_setups x WHERE x.id = p_setup AND x.phase = 'finish' AND x.attempt = p_attempt FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- only a row the approved plan keeps can be recorded
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.setup_finish_kept_rows(s_account, s_repo, p_setup)) k WHERE k ->> 'row_key' = p_row_key) THEN RETURN false; END IF;
  INSERT INTO public.project_seeded_rows (account_id, setup_id, row_key, discussion_number) VALUES (s_account, p_setup, p_row_key, p_number) ON CONFLICT (setup_id, row_key) DO NOTHING;
  SELECT q.discussion_number INTO stored FROM public.project_seeded_rows q WHERE q.account_id = s_account AND q.setup_id = p_setup AND q.row_key = p_row_key;
  RETURN stored = p_number;
END;
$$;

CREATE FUNCTION setup_finish_complete(p_setup uuid, p_attempt integer, p_team_log integer)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_account uuid; s_repo uuid; v_operated boolean;
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_finish_complete: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_setup IS NULL OR p_attempt IS NULL OR p_team_log IS NULL OR p_team_log < 1 THEN
    RAISE EXCEPTION 'setup_finish_complete: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.account_id, x.repo_id INTO s_account, s_repo FROM public.project_setups x WHERE x.id = p_setup AND x.phase = 'finish' AND x.attempt = p_attempt FOR UPDATE;
  IF NOT FOUND THEN RETURN 'skipped'; END IF;
  -- every kept row must be recorded first
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.setup_finish_kept_rows(s_account, s_repo, p_setup)) k
              WHERE NOT EXISTS (SELECT 1 FROM public.project_seeded_rows q WHERE q.account_id = s_account AND q.setup_id = p_setup AND q.row_key = k ->> 'row_key')) THEN
    RETURN 'not_ready';
  END IF;
  -- item 9: operated is watch AND operate AND the repo ticked
  v_operated := COALESCE((SELECT st.watch_enabled AND st.operate_enabled FROM public.engine_bridge_settings st WHERE st.account_id = s_account), false)
                AND EXISTS (SELECT 1 FROM public.engine_bridge_repos br WHERE br.account_id = s_account AND br.repo_id = s_repo);
  UPDATE public.project_setups x SET phase = 'done', sub_step = 'finish', state = 'ok', team_log_issue = p_team_log, start_pending = v_operated, failure_code = NULL, failure_reason = NULL, failure_at = NULL, finish_claim_at = NULL, finish_retries = 0, updated_at = now()
   WHERE x.account_id = s_account AND x.id = p_setup;
  RETURN 'done';
END;
$$;

CREATE FUNCTION setup_finish_fail(p_setup uuid, p_attempt integer, p_code text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_account uuid;
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_finish_fail: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_setup IS NULL OR p_attempt IS NULL OR p_code IS NULL OR p_code <> 'seed_failed' THEN
    RAISE EXCEPTION 'setup_finish_fail: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.account_id INTO s_account FROM public.project_setups x WHERE x.id = p_setup AND x.phase = 'finish' AND x.attempt = p_attempt FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.project_setups x SET sub_step = 'seed', state = 'failed', failure_code = p_code, failure_reason = NULL, failure_at = now(), finish_tries = LEAST(x.finish_tries + 1, 96), finish_retries = 0, finish_claim_at = NULL, updated_at = now()
   WHERE x.account_id = s_account AND x.id = p_setup;
  RETURN true;
END;
$$;

-- A pass that could not reach GitHub (a 5xx, a rate limit, a mint that failed): it is counted, and the 24th in a row is recorded as `seed_failed` like any other failure, so it shows (the lease lapses between passes,
-- so that is about six hours of passes).
CREATE FUNCTION setup_finish_retry(p_setup uuid, p_attempt integer)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_account uuid; n integer;
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_finish_retry: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_setup IS NULL OR p_attempt IS NULL THEN
    RAISE EXCEPTION 'setup_finish_retry: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.account_id, x.finish_retries + 1 INTO s_account, n FROM public.project_setups x WHERE x.id = p_setup AND x.phase = 'finish' AND x.attempt = p_attempt FOR UPDATE;
  IF NOT FOUND THEN RETURN 'skipped'; END IF;
  IF n >= 24 THEN
    UPDATE public.project_setups x SET sub_step = 'seed', state = 'failed', failure_code = 'seed_failed', failure_reason = NULL, failure_at = now(), finish_tries = LEAST(x.finish_tries + 1, 96), finish_retries = 0, finish_claim_at = NULL, updated_at = now()
     WHERE x.account_id = s_account AND x.id = p_setup;
    RETURN 'failed';
  END IF;
  UPDATE public.project_setups x SET finish_retries = n WHERE x.account_id = s_account AND x.id = p_setup;
  RETURN 'retry';
END;
$$;

REVOKE ALL ON FUNCTION setup_finish_kept_rows(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION setup_finish_claim() FROM PUBLIC;
REVOKE ALL ON FUNCTION setup_finish_pending() FROM PUBLIC;
REVOKE ALL ON FUNCTION setup_finish_seed_record(uuid, integer, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION setup_finish_complete(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION setup_finish_fail(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION setup_finish_retry(uuid, integer) FROM PUBLIC;
ALTER FUNCTION setup_finish_kept_rows(uuid, uuid, uuid) OWNER TO setup_finish_definer;
ALTER FUNCTION setup_finish_claim() OWNER TO setup_finish_definer;
ALTER FUNCTION setup_finish_pending() OWNER TO setup_finish_definer;
ALTER FUNCTION setup_finish_seed_record(uuid, integer, text, integer) OWNER TO setup_finish_definer;
ALTER FUNCTION setup_finish_complete(uuid, integer, integer) OWNER TO setup_finish_definer;
ALTER FUNCTION setup_finish_fail(uuid, integer, text) OWNER TO setup_finish_definer;
ALTER FUNCTION setup_finish_retry(uuid, integer) OWNER TO setup_finish_definer;
GRANT EXECUTE ON FUNCTION setup_finish_claim() TO platform_ops;
GRANT EXECUTE ON FUNCTION setup_finish_pending() TO platform_ops;
GRANT EXECUTE ON FUNCTION setup_finish_seed_record(uuid, integer, text, integer) TO platform_ops;
GRANT EXECUTE ON FUNCTION setup_finish_complete(uuid, integer, integer) TO platform_ops;
GRANT EXECUTE ON FUNCTION setup_finish_fail(uuid, integer, text) TO platform_ops;
GRANT EXECUTE ON FUNCTION setup_finish_retry(uuid, integer) TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM setup_finish_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE setup_finish_definer FROM CURRENT_USER;
  END IF;
END
$$;

INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('setup_finish', 900) ON CONFLICT (name) DO NOTHING;
