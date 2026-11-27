-- D#845 ON-27f: "Bring this issue into the private repo". An owner or admin picks one open issue of the twin's public repository and the cloud opens a copy of it in the private twin. This migration is the record that
-- keeps it to once per public issue:
--
--   twin_issue_imports        one row per (twin, public issue): the private issue that was opened for it, who asked and when. account_id is carried so row security can read it (the twin's own FK pins the pair).
--                             app_user may read it under row security (the list marks the issues already brought) and writes nothing directly.
--   twin_issue_claim(twin, public issue)   claim first: the route calls it BEFORE GitHub. It inserts the pair with no private number, a five-minute claim and a fresh claim id (o_claim). o_result: claimed (the caller alone may now call GitHub) | already
--                             (a number is recorded: o_private_issue) | in_progress (a live claim without a number) | not_found | bad_state (not ready, paused or in conflict). An expired claim without a number is retaken.
--   twin_issue_release(twin, public issue, claim)  drops that very claim, while it has no number, after a refusal or a GitHub failure, so the click can be made again at once. Each claim carries its own id (o_claim); record and release must hand it back.
--   twin_issue_record(twin, public issue, private issue)   the route's call AFTER GitHub made the private issue: it sets the number on the claim and writes the one `twin.issue_brought` audit row (actor = the person, payload exactly
--                             {twin_id, public_issue, private_issue}: no title, body, author or repository name). o_result: ok | already (a number was recorded first: o_private_issue) | stale (the claim was retaken: nothing is written) | no_claim | not_found | bad_state.
--                             All three are SECURITY DEFINER, owned by repo_twins_owner, search_path pinned, EXECUTE for app_user alone. The caller must be a person who is an owner or admin of an active account: a runner
--                             session, a platform_ops login, a session with no person and a member are refused (42501).
--   twin_visibility_record    restated (1116's) with one change: a paused twin found public is refused too.
--   repo_twins_owner_audit    restated: 1117's list plus 'twin.issue_brought'.
--
-- Numbered 1118 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

CREATE TABLE twin_issue_imports (
  twin_id       uuid NOT NULL,
  account_id    uuid NOT NULL,
  public_issue  integer NOT NULL CONSTRAINT twin_issue_imports_public_check CHECK (public_issue >= 1),
  private_issue integer CONSTRAINT twin_issue_imports_private_check CHECK (private_issue >= 1),
  claim_until   timestamptz NOT NULL,
  claim_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  brought_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (twin_id, public_issue),
  FOREIGN KEY (account_id, twin_id) REFERENCES repo_twins (account_id, id) ON DELETE CASCADE
);

ALTER TABLE twin_issue_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE twin_issue_imports FORCE ROW LEVEL SECURITY;
REVOKE ALL ON twin_issue_imports FROM PUBLIC;
GRANT SELECT ON twin_issue_imports TO app_user;
CREATE POLICY tenant_isolation_select ON twin_issue_imports FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

GRANT SELECT ON twin_issue_imports TO repo_twins_owner;
GRANT INSERT (twin_id, account_id, public_issue, private_issue, claim_until, claim_id, brought_by) ON twin_issue_imports TO repo_twins_owner;
GRANT UPDATE (private_issue, claim_until, claim_id, brought_by) ON twin_issue_imports TO repo_twins_owner;
GRANT DELETE ON twin_issue_imports TO repo_twins_owner;
CREATE POLICY repo_twins_owner_use ON twin_issue_imports FOR ALL TO repo_twins_owner
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'repo_twins_owner'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on repo_twins_owner; cannot ALTER FUNCTION ... OWNER TO repo_twins_owner';
    END IF;
    GRANT repo_twins_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO repo_twins_owner;

DROP POLICY repo_twins_owner_audit ON audit_log;
CREATE POLICY repo_twins_owner_audit ON audit_log FOR INSERT TO repo_twins_owner
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND action IN ('twin.created', 'twin.paused', 'twin.resumed', 'twin.removed', 'twin.connected', 'twin.paths_changed', 'twin.install_paths_added', 'twin.refused', 'twin.merged', 'twin.issue_brought'));

-- twin_visibility_record (1116), restated for one change: a PAUSED twin whose private repository is found public is refused too (1116 answered bad_state), because Bring now reads the visibility itself in every state it accepts.
CREATE OR REPLACE FUNCTION twin_visibility_record(p_twin uuid, p_private_seen text, p_public_seen text) RETURNS TABLE (o_result text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  t    record;
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
     OR (usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin'))) THEN
    RAISE EXCEPTION 'twin_visibility_record: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_twin IS NULL OR p_private_seen IS NULL OR p_private_seen NOT IN ('private', 'public') OR (p_public_seen IS NOT NULL AND p_public_seen NOT IN ('private', 'public')) THEN
    RAISE EXCEPTION 'twin_visibility_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.id, x.state, x.failure_code, x.note INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'; RETURN; END IF;
  IF p_private_seen = 'public' THEN
    IF t.state = 'refused' AND t.failure_code = 'twin_not_private' THEN RETURN QUERY SELECT 'refused'; RETURN; END IF;
    IF t.state NOT IN ('seeding', 'ready', 'conflict', 'failed', 'paused') THEN RETURN QUERY SELECT 'bad_state'; RETURN; END IF;
    UPDATE public.repo_twins SET state = 'refused', failure_code = 'twin_not_private', failure_reason = NULL, failure_at = now(), updated_at = now() WHERE id = t.id AND account_id = acct;
    -- The refusal is automatic, so the audit row carries no person when the session has none (twin_change's naming style: twin.<verb>).
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    VALUES (acct, usr::text, 'twin.refused', jsonb_build_object('twin_id', t.id, 'code', 'twin_not_private', 'from', t.state), clock_timestamp());
    RETURN QUERY SELECT 'refused'; RETURN;
  END IF;
  IF t.state NOT IN ('seeding', 'ready', 'conflict', 'failed', 'paused') THEN RETURN QUERY SELECT 'bad_state'; RETURN; END IF;
  IF p_public_seen IS NOT NULL AND t.note IS DISTINCT FROM (CASE WHEN p_public_seen = 'private' THEN 'public_repo_private' END) THEN
    UPDATE public.repo_twins SET note = CASE WHEN p_public_seen = 'private' THEN 'public_repo_private' END, updated_at = now() WHERE id = t.id AND account_id = acct;
  END IF;
  RETURN QUERY SELECT 'ok';
END;
$$;

CREATE FUNCTION twin_issue_claim(p_twin uuid, p_public_issue integer) RETURNS TABLE (o_result text, o_private_issue integer, o_claim uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  t    record;
  c    record;
  cid  uuid := gen_random_uuid();
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR usr IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'twin_issue_claim: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_twin IS NULL OR p_public_issue IS NULL OR p_public_issue < 1 THEN
    RAISE EXCEPTION 'twin_issue_claim: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The twin row is locked, so two clicks on one issue take this one after the other: the second sees the first's claim.
  SELECT x.id, x.state INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::integer, NULL::uuid; RETURN; END IF;
  IF t.state NOT IN ('ready', 'paused', 'conflict') THEN RETURN QUERY SELECT 'bad_state', NULL::integer, NULL::uuid; RETURN; END IF;
  SELECT i.private_issue, i.claim_until INTO c FROM public.twin_issue_imports i WHERE i.twin_id = t.id AND i.public_issue = p_public_issue;
  IF FOUND THEN
    IF c.private_issue IS NOT NULL THEN RETURN QUERY SELECT 'already', c.private_issue, NULL::uuid; RETURN; END IF;
    IF c.claim_until > clock_timestamp() THEN RETURN QUERY SELECT 'in_progress', NULL::integer, NULL::uuid; RETURN; END IF;
    UPDATE public.twin_issue_imports SET claim_until = clock_timestamp() + interval '5 minutes', claim_id = cid, brought_by = usr WHERE twin_id = t.id AND public_issue = p_public_issue;
  ELSE
    INSERT INTO public.twin_issue_imports (twin_id, account_id, public_issue, claim_until, claim_id, brought_by) VALUES (t.id, acct, p_public_issue, clock_timestamp() + interval '5 minutes', cid, usr);
  END IF;
  RETURN QUERY SELECT 'claimed', NULL::integer, cid;
END;
$$;

CREATE FUNCTION twin_issue_release(p_twin uuid, p_public_issue integer, p_claim uuid) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR usr IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'twin_issue_release: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only this very claim goes, and only while it has no number: a claim retaken by another click, and a recorded pair, stay.
  DELETE FROM public.twin_issue_imports WHERE twin_id = p_twin AND account_id = acct AND public_issue = p_public_issue AND claim_id = p_claim AND private_issue IS NULL AND brought_by = usr;
END;
$$;

CREATE FUNCTION twin_issue_record(p_twin uuid, p_public_issue integer, p_private_issue integer, p_claim uuid) RETURNS TABLE (o_result text, o_private_issue integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  t    record;
  c    record;
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR usr IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'twin_issue_record: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_twin IS NULL OR p_public_issue IS NULL OR p_public_issue < 1 OR p_private_issue IS NULL OR p_private_issue < 1 OR p_claim IS NULL THEN
    RAISE EXCEPTION 'twin_issue_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.id, x.state INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::integer; RETURN; END IF;
  IF t.state NOT IN ('ready', 'paused', 'conflict') THEN RETURN QUERY SELECT 'bad_state', NULL::integer; RETURN; END IF;
  SELECT i.private_issue, i.claim_id INTO c FROM public.twin_issue_imports i WHERE i.twin_id = t.id AND i.public_issue = p_public_issue;
  IF NOT FOUND THEN RETURN QUERY SELECT 'no_claim', NULL::integer; RETURN; END IF;
  -- The claim must still be the caller's own: one retaken by another click (this bring ran past its five minutes, and the retaker may have recorded already) records nothing.
  IF c.claim_id IS DISTINCT FROM p_claim THEN RETURN QUERY SELECT 'stale', NULL::integer; RETURN; END IF;
  IF c.private_issue IS NOT NULL THEN RETURN QUERY SELECT 'already', c.private_issue; RETURN; END IF;
  UPDATE public.twin_issue_imports SET private_issue = p_private_issue, brought_by = usr WHERE twin_id = t.id AND public_issue = p_public_issue AND claim_id = p_claim;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'twin.issue_brought', jsonb_build_object('twin_id', t.id, 'public_issue', p_public_issue, 'private_issue', p_private_issue), clock_timestamp());
  RETURN QUERY SELECT 'ok', p_private_issue;
END;
$$;

REVOKE ALL ON FUNCTION twin_issue_claim(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION twin_issue_release(uuid, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION twin_issue_record(uuid, integer, integer, uuid) FROM PUBLIC;
ALTER FUNCTION twin_issue_claim(uuid, integer) OWNER TO repo_twins_owner;
ALTER FUNCTION twin_issue_release(uuid, integer, uuid) OWNER TO repo_twins_owner;
ALTER FUNCTION twin_issue_record(uuid, integer, integer, uuid) OWNER TO repo_twins_owner;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION twin_issue_claim(uuid, integer) TO app_user;
GRANT EXECUTE ON FUNCTION twin_issue_release(uuid, integer, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION twin_issue_record(uuid, integer, integer, uuid) TO app_user;

REVOKE CREATE ON SCHEMA public FROM repo_twins_owner;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE repo_twins_owner FROM CURRENT_USER;
  END IF;
END
$$;
