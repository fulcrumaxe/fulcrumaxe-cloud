-- PI-3: the project interview's sessions.
--
-- interview_sessions: one row per interview. The answers and the follow-ups are jsonb documents the service validates against the manifest version pinned at start. The
-- row is the whole resume state, so a phone and a laptop read the same one, and `rev` is what makes two writers safe: every write names the rev it read and a stale one matches
-- no row.
--   * rev is the server's. No role can write it: a BEFORE UPDATE trigger adds one whenever the answers, the follow-ups, the repo or the status change, so a write that only
--     moves a counter does not make a person's open screen stale;
--   * status, spent_usd, turn_count, turn_in_flight_until, project_discussion_id and finished_at are not writable by app_user at all, and neither is a row's own identity. A person
--     writes answers, followups and repo_id on their own live session, and nothing else;
--   * a finished or abandoned session is read-only: its answers, follow-ups, repo, status and discussion link cannot change, whoever asks (a trigger, so a later definer
--     cannot lift it). Only the cost counters and turn_in_flight_until may still move, because a turn that was in flight when the person left must still settle;
--   * the whole answers document is at most 64 KiB, the same ceiling the rendered body has to fit under.
-- Row security is forced. A person reads and writes their own sessions; an owner or admin reads every session of the account; any other member sees none of them (the row is
-- not there for them, so the route answers 404 and never 403). Neither is app.user_id alone: the two row tests go through current_member_user_id() and current_member_role(), which join account_members. A runner session sees nothing.
--
-- Writers that must not be a plain UPDATE are three SECURITY DEFINER functions owned by a NOLOGIN role of their own (the 1031 shape), executable by app_user only:
--   interview_session_start(manifest_id, manifest_version, repo_id)   takes an account lock, applies the session bounds, inserts. A person cannot insert a row any other way
--   interview_session_abandon(id, rev)                                 the one status move a person makes; stale rev, not live and not yours are answered, not raised
--   interview_session_counts()                                         the account's and the caller's live sessions and the day's starts, for the bounds' own message
-- The bounds (one table in the Spec, one set of numbers here; packages/interview/src/limits.ts repeats them for display and a test pins the two together):
--   active sessions (active or capped) per account: 2 when the account has not paid for a hosted plan, none when it has;
--   active sessions per user: 2 unpaid, 3 paid;
--   starts per account in a rolling 24 hours (abandoned ones still count): 10 unpaid, 20 paid.
-- A refused start raises 'interview_limit' with SQLSTATE IV429 and the bound's name as the DETAIL. Every refusal is a plain fact the UI can show. "Paid" is read here from the
-- account, never passed in.
--
-- interview_turns: the link from a session to the agent_runs row of each model turn it made, in order. app_user reads it through the session's own visibility; nothing writes it
-- yet (the turn ledger's definer pair does, in a later row). v_interview_funnel: one row per session with its start, finish and status, security_invoker, so the caller's own
-- visibility applies; the metrics job reads it through the tenant-bypassing admin connection.
--
-- Rollback (expand/contract): drop the view, the functions, the two tables and the role; nothing else depends on them.

DO $$
DECLARE
  n text := 'interview_session_definer';
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

CREATE TABLE interview_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_by            uuid NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'capped', 'finished', 'abandoned')),
  manifest_id           text NOT NULL CHECK (manifest_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  manifest_version      text NOT NULL CHECK (manifest_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  repo_id               uuid,
  answers               jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object' AND octet_length(answers::text) <= 65536),
  followups             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(followups) = 'object' AND octet_length(followups::text) <= 65536),
  rev                   integer NOT NULL DEFAULT 1 CHECK (rev >= 1),
  -- A display cache written by the turn service; the cap check sums the ledger.
  spent_usd             numeric(12, 6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  turn_count            integer NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  turn_in_flight_until  timestamptz,
  project_discussion_id uuid,
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, created_by) REFERENCES account_members (account_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE SET NULL (repo_id),
  CONSTRAINT interview_sessions_finished_pair CHECK ((status = 'finished') = (finished_at IS NOT NULL))
);
-- The bounds count a user's and an account's live rows and the day's starts.
CREATE INDEX interview_sessions_account_started ON interview_sessions (account_id, started_at DESC);
CREATE INDEX interview_sessions_user_live ON interview_sessions (account_id, created_by) WHERE status IN ('active', 'capped');

ALTER TABLE interview_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_sessions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON interview_sessions FROM PUBLIC;
GRANT SELECT ON interview_sessions TO app_user;
GRANT UPDATE (answers, followups, repo_id) ON interview_sessions TO app_user;

-- The two row tests the policies share. plpgsql, so the helper bodies from 0005 are looked up when they run (a database that is missing 0005 can still apply this file).
CREATE FUNCTION interview_session_is_own(p_created_by uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN p_created_by = current_member_user_id();
END;
$$;
CREATE FUNCTION interview_session_is_readable(p_created_by uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN p_created_by = current_member_user_id() OR COALESCE(current_member_role(), '') IN ('owner', 'admin');
END;
$$;
REVOKE ALL ON FUNCTION interview_session_is_own(uuid), interview_session_is_readable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION interview_session_is_own(uuid), interview_session_is_readable(uuid) TO app_user;

CREATE POLICY own_or_admin_select ON interview_sessions FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (SELECT interview_session_is_readable(created_by))
  );

CREATE POLICY own_live_update ON interview_sessions FOR UPDATE TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (SELECT interview_session_is_own(created_by))
    AND status IN ('active', 'capped')
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT interview_session_is_own(created_by))
  );

-- ---- the trigger: rev, updated_at, what can no longer move ----------------------------------------------------------------------------------
CREATE FUNCTION interview_sessions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.manifest_id IS DISTINCT FROM OLD.manifest_id OR NEW.manifest_version IS DISTINCT FROM OLD.manifest_version OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'interview_sessions: identity and the pinned manifest never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.project_discussion_id IS NOT NULL AND NEW.project_discussion_id IS DISTINCT FROM OLD.project_discussion_id THEN
    RAISE EXCEPTION 'interview_sessions: the project link is set once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('finished', 'abandoned')
     AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.answers IS DISTINCT FROM OLD.answers OR NEW.followups IS DISTINCT FROM OLD.followups
          OR (NEW.repo_id IS DISTINCT FROM OLD.repo_id AND NEW.repo_id IS NOT NULL) OR NEW.project_discussion_id IS DISTINCT FROM OLD.project_discussion_id OR NEW.finished_at IS DISTINCT FROM OLD.finished_at) THEN
    RAISE EXCEPTION 'interview_sessions: a % session is read-only', OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- A terminal row's repo link may still be cleared (the foreign key does it when the repo is deleted); that moves nothing a person sees, so rev stays.
  IF OLD.status IN ('active', 'capped')
     AND (NEW.answers IS DISTINCT FROM OLD.answers OR NEW.followups IS DISTINCT FROM OLD.followups OR NEW.repo_id IS DISTINCT FROM OLD.repo_id OR NEW.status IS DISTINCT FROM OLD.status) THEN
    NEW.rev := OLD.rev + 1;
  ELSE
    NEW.rev := OLD.rev;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION interview_sessions_guard() FROM PUBLIC;
CREATE TRIGGER interview_sessions_guard BEFORE UPDATE ON interview_sessions FOR EACH ROW EXECUTE FUNCTION interview_sessions_guard();

-- ---- the turn link and the funnel view -------------------------------------------------------------------------------------------------------
CREATE TABLE interview_turns (
  account_id   uuid NOT NULL,
  session_id   uuid NOT NULL,
  seq          integer NOT NULL CHECK (seq >= 1),
  agent_run_id uuid NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (account_id, session_id) REFERENCES interview_sessions (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, agent_run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE
);
ALTER TABLE interview_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_turns FORCE ROW LEVEL SECURITY;
REVOKE ALL ON interview_turns FROM PUBLIC;
GRANT SELECT ON interview_turns TO app_user;
-- Visible exactly when the session is: the subquery runs under the caller's own session policy.
CREATE POLICY session_visible_select ON interview_turns FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL
    AND EXISTS (SELECT 1 FROM interview_sessions s WHERE s.account_id = interview_turns.account_id AND s.id = interview_turns.session_id)
  );

CREATE VIEW v_interview_funnel WITH (security_invoker = true) AS
  SELECT id AS session_id, account_id, created_by, manifest_id, status, started_at, finished_at FROM interview_sessions;
GRANT SELECT ON v_interview_funnel TO app_user;

-- ---- the definer's own rights (narrow, and bound to the session's account) -------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO interview_session_definer;
GRANT SELECT, INSERT, UPDATE ON interview_sessions TO interview_session_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO interview_session_definer;
GRANT SELECT (id, deleted_at, hosted_plan_paid) ON accounts TO interview_session_definer;
CREATE POLICY interview_definer_select ON interview_sessions FOR SELECT TO interview_session_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY interview_definer_insert ON interview_sessions FOR INSERT TO interview_session_definer WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY interview_definer_update ON interview_sessions FOR UPDATE TO interview_session_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY interview_definer_select ON account_members FOR SELECT TO interview_session_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY interview_definer_select ON accounts FOR SELECT TO interview_session_definer USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'interview_session_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on interview_session_definer; cannot ALTER FUNCTION ... OWNER TO interview_session_definer';
    END IF;
    GRANT interview_session_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO interview_session_definer;

-- Raises 42501 unless the session is a verified member of its own live account, not a runner and not a platform_ops login. Answers the account and the user.
CREATE FUNCTION interview_assert_person(p_what text)
RETURNS TABLE (account_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid;
BEGIN
  IF pg_has_role(session_user, 'platform_ops', 'MEMBER') OR pg_has_role(session_user, 'agent_run_writer', 'MEMBER')
     OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION '%: refused for this login', p_what USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id INTO usr FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR usr IS NULL OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = acct AND a.deleted_at IS NULL) THEN
    RAISE EXCEPTION '%: caller is not a member of a live account', p_what USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT acct, usr;
END
$$;
REVOKE ALL ON FUNCTION interview_assert_person(text) FROM PUBLIC;
ALTER FUNCTION interview_assert_person(text) OWNER TO interview_session_definer;

CREATE FUNCTION interview_session_start(p_manifest_id text, p_manifest_version text, p_repo_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct      uuid;
  usr       uuid;
  v_paid    boolean;
  v_acct_n  integer;
  v_user_n  integer;
  v_starts  integer;
  v_user_max integer;
  v_starts_max integer;
  v_id      uuid;
BEGIN
  SELECT p.account_id, p.user_id INTO acct, usr FROM public.interview_assert_person('interview_session_start') p;
  SELECT a.hosted_plan_paid INTO v_paid FROM public.accounts a WHERE a.id = acct;
  -- One start at a time per account, so two requests cannot both slip under a bound.
  PERFORM pg_advisory_xact_lock(hashtextextended('interview_start:' || acct::text, 0));
  SELECT count(*) FILTER (WHERE s.status IN ('active', 'capped')),
         count(*) FILTER (WHERE s.status IN ('active', 'capped') AND s.created_by = usr),
         count(*) FILTER (WHERE s.started_at > now() - interval '24 hours')
    INTO v_acct_n, v_user_n, v_starts
    FROM public.interview_sessions s WHERE s.account_id = acct;
  v_user_max := CASE WHEN v_paid THEN 3 ELSE 2 END;
  v_starts_max := CASE WHEN v_paid THEN 20 ELSE 10 END;
  IF NOT v_paid AND v_acct_n >= 2 THEN
    RAISE EXCEPTION 'interview_limit' USING ERRCODE = 'IV429', DETAIL = 'active_per_account';
  ELSIF v_user_n >= v_user_max THEN
    RAISE EXCEPTION 'interview_limit' USING ERRCODE = 'IV429', DETAIL = 'active_per_user';
  ELSIF v_starts >= v_starts_max THEN
    RAISE EXCEPTION 'interview_limit' USING ERRCODE = 'IV429', DETAIL = 'starts_per_day';
  END IF;
  INSERT INTO public.interview_sessions (account_id, created_by, manifest_id, manifest_version, repo_id)
  VALUES (acct, usr, p_manifest_id, p_manifest_version, p_repo_id) RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION interview_session_start(text, text, uuid) FROM PUBLIC;
ALTER FUNCTION interview_session_start(text, text, uuid) OWNER TO interview_session_definer;
GRANT EXECUTE ON FUNCTION interview_session_start(text, text, uuid) TO app_user;

-- 'ok', 'stale_rev', 'not_active' (finished or abandoned already) or 'not_found' (no such session of the caller's).
CREATE FUNCTION interview_session_abandon(p_id uuid, p_rev integer)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid;
  usr  uuid;
  r    public.interview_sessions%ROWTYPE;
BEGIN
  SELECT p.account_id, p.user_id INTO acct, usr FROM public.interview_assert_person('interview_session_abandon') p;
  SELECT * INTO r FROM public.interview_sessions s WHERE s.id = p_id AND s.account_id = acct AND s.created_by = usr FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF r.status NOT IN ('active', 'capped') THEN RETURN 'not_active'; END IF;
  IF r.rev <> p_rev THEN RETURN 'stale_rev'; END IF;
  UPDATE public.interview_sessions s SET status = 'abandoned' WHERE s.id = p_id AND s.account_id = acct;
  RETURN 'ok';
END
$$;
REVOKE ALL ON FUNCTION interview_session_abandon(uuid, integer) FROM PUBLIC;
ALTER FUNCTION interview_session_abandon(uuid, integer) OWNER TO interview_session_definer;
GRANT EXECUTE ON FUNCTION interview_session_abandon(uuid, integer) TO app_user;

CREATE FUNCTION interview_session_counts()
RETURNS TABLE (hosted_plan_paid boolean, active_account integer, active_user integer, starts_24h integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid;
  usr  uuid;
BEGIN
  SELECT p.account_id, p.user_id INTO acct, usr FROM public.interview_assert_person('interview_session_counts') p;
  RETURN QUERY
    SELECT a.hosted_plan_paid,
           (count(*) FILTER (WHERE s.status IN ('active', 'capped')))::integer,
           (count(*) FILTER (WHERE s.status IN ('active', 'capped') AND s.created_by = usr))::integer,
           (count(*) FILTER (WHERE s.started_at > now() - interval '24 hours'))::integer
      FROM public.accounts a LEFT JOIN public.interview_sessions s ON s.account_id = a.id
     WHERE a.id = acct GROUP BY a.hosted_plan_paid;
END
$$;
REVOKE ALL ON FUNCTION interview_session_counts() FROM PUBLIC;
ALTER FUNCTION interview_session_counts() OWNER TO interview_session_definer;
GRANT EXECUTE ON FUNCTION interview_session_counts() TO app_user;

-- The assert helper is called only by the three above, which run as the same owner.
REVOKE CREATE ON SCHEMA public FROM interview_session_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE interview_session_definer FROM CURRENT_USER;
  END IF;
END
$$;
