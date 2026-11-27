-- D#845 ON-27d4a: what the twin sweep needs from the database. Four things, all expand-only.
--
--   1. The cross-tenant lists (owned by setup_request_lister, 0874/0951's role, EXECUTE for the run-writer login alone, as plane_parity_list_due): twin_parity_list_due (twins whose parity check has a due time) and twin_work_list
--      (twins that need a seed, a publish or a sync issued or checked). Each names the account, the twin and what to do, and nothing else: no sha, path or result. The role gains column SELECT on the few columns they read
--      and one row policy on repo_twins and on twin_parity_checks.
--   2. twin_work_claim (a person-less or owner/admin session, in the twin's account): the lease. A parity check is claimed by moving its due time five minutes ahead (a push that races the claim can be delayed by up to five minutes, because the claim overwrites its earlier time, but it is never lost: a result clears the due mark only while mark_seq is still the claim's, so the push's mark stays due; the answer
--      carries mark_seq and the synced tip the check will be computed from). A seed, publish or sync is claimed by stamping work_lease_until five minutes ahead, so a job that cannot be issued is looked at again after the lease,
--      not on every tick. Each claim re-checks the same facts the list read.
--   3. FU-312: twin_parity_record, restated with the anchor the check was computed from (p_anchor, the synced_public_sha the claim returned). The result is written only while the stored anchor is still that one; if it has
--      moved, the result is dropped ('stale': nothing written but a due time of now, so the next tick computes it again). The old 11-argument function is dropped; nothing calls it yet.
--   4. FU-311: twin_visibility_record (what the cloud read of the two repositories' visibility). A private twin that is now public is refused with closed code twin_not_private, and nothing is issued for it. A public repository that
--      turned private is not a refusal: the twin keeps working and repo_twins.note says public_repo_private (cleared when it is public again). The sentences for both belong to TWIN_WORDS (ON-27e).
--
-- Numbered 1116 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE repo_twins ADD COLUMN note text CONSTRAINT repo_twins_note_check CHECK (note IN ('public_repo_private'));
GRANT UPDATE (note) ON repo_twins TO repo_twins_owner;
ALTER TABLE twin_parity_checks ADD COLUMN work_lease_until timestamptz;
GRANT INSERT (work_lease_until), UPDATE (work_lease_until) ON twin_parity_checks TO repo_twins_owner;

-- ---- the lister's reach ----------------------------------------------------------------------------------------------------------------------------------
GRANT SELECT (id, account_id, state, private_repo_id, sync_pr) ON repo_twins TO setup_request_lister;
GRANT SELECT (twin_id, account_id, due_at, last_result, work_lease_until) ON twin_parity_checks TO setup_request_lister;
CREATE POLICY setup_request_lister_select ON repo_twins FOR SELECT TO setup_request_lister USING (state IN ('seeding', 'ready', 'conflict') AND private_repo_id IS NOT NULL);
CREATE POLICY setup_request_lister_select ON twin_parity_checks FOR SELECT TO setup_request_lister USING (due_at IS NOT NULL OR work_lease_until IS NOT NULL OR last_result IN ('publish_pending', 'sync_pending'));

-- ---- ownership brackets (0951's for setup_request_lister, 1112's for repo_twins_owner) ----------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH r IN ARRAY ARRAY['setup_request_lister', 'repo_twins_owner'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot ALTER FUNCTION ... OWNER TO %', r, r;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', r);
    END LOOP;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO setup_request_lister, repo_twins_owner;

-- ---- 1. the lists ------------------------------------------------------------------------------------------------------------------------------------------
-- Twins with a parity due time (ready or in conflict), earliest first; the sweep runs the ones due now and asks for the next tick at the earliest of the rest.
CREATE FUNCTION twin_parity_list_due(p_limit int)
RETURNS TABLE (account_id uuid, twin_id uuid, due_at timestamptz, due_now boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'twin_parity_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'twin_parity_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT c.account_id, c.twin_id, c.due_at, c.due_at <= now()
    FROM public.twin_parity_checks c
    JOIN public.repo_twins t ON t.account_id = c.account_id AND t.id = c.twin_id AND t.state IN ('ready', 'conflict') AND t.private_repo_id IS NOT NULL
    JOIN public.accounts a ON a.id = c.account_id AND a.deleted_at IS NULL
   WHERE c.due_at IS NOT NULL
   ORDER BY c.due_at, c.twin_id
   LIMIT p_limit;
END $$;

-- Twins whose next step is a job: o_kind seed (seeding: issue the copy, or check it once its job is done), publish (ready, the check found private changes to publish) or sync (ready, public changes to bring in, no sync pull request open).
-- A twin under a lease is left out until it ends.
CREATE FUNCTION twin_work_list(p_limit int)
RETURNS TABLE (account_id uuid, twin_id uuid, o_kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'twin_work_list: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'twin_work_list: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT w.account_id, w.id, w.kind FROM (
    SELECT t.account_id, t.id,
           CASE WHEN t.state = 'seeding' THEN 'seed' WHEN c.last_result = 'publish_pending' THEN 'publish' WHEN c.last_result = 'sync_pending' AND t.sync_pr IS NULL THEN 'sync' END AS kind
      FROM public.repo_twins t
      LEFT JOIN public.twin_parity_checks c ON c.account_id = t.account_id AND c.twin_id = t.id
      JOIN public.accounts a ON a.id = t.account_id AND a.deleted_at IS NULL
     WHERE t.private_repo_id IS NOT NULL AND t.state IN ('seeding', 'ready') AND (c.work_lease_until IS NULL OR c.work_lease_until <= now())
  ) w
  WHERE w.kind IS NOT NULL
  ORDER BY w.id
  LIMIT p_limit;
END $$;

-- ---- 2. the claim ------------------------------------------------------------------------------------------------------------------------------------------
-- o_result: ok | not_found | bad_state (the twin is not in the state the kind needs) | not_due (a parity check not yet due, or already claimed) | leased (another tick holds the work).
-- On ok: o_mark_seq is the due mark's counter (hand it back to twin_parity_record) and o_anchor the synced tip the check is computed from (NULL for a twin never synced).
CREATE FUNCTION twin_work_claim(p_twin uuid, p_kind text) RETURNS TABLE (o_result text, o_mark_seq bigint, o_anchor text)
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
  v_has boolean;
  v_seq bigint;
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
     OR (usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin'))) THEN
    RAISE EXCEPTION 'twin_work_claim: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_twin IS NULL OR p_kind IS NULL OR p_kind NOT IN ('parity', 'seed', 'publish', 'sync') THEN
    RAISE EXCEPTION 'twin_work_claim: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.id, x.state, x.private_repo_id, x.synced_public_sha, x.sync_pr INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::bigint, NULL::text; RETURN; END IF;
  SELECT y.mark_seq, y.due_at, y.last_result, y.work_lease_until INTO c FROM public.twin_parity_checks y WHERE y.twin_id = t.id AND y.account_id = acct;
  v_has := FOUND;
  v_seq := CASE WHEN v_has THEN c.mark_seq ELSE 0 END;
  IF t.private_repo_id IS NULL
     OR NOT (CASE p_kind WHEN 'parity' THEN t.state IN ('ready', 'conflict') WHEN 'seed' THEN t.state = 'seeding'
                         WHEN 'publish' THEN t.state = 'ready' AND v_has AND c.last_result = 'publish_pending'
                         ELSE t.state = 'ready' AND v_has AND c.last_result = 'sync_pending' AND t.sync_pr IS NULL END) THEN
    RETURN QUERY SELECT 'bad_state', NULL::bigint, NULL::text; RETURN;
  END IF;
  IF p_kind = 'parity' THEN
    IF NOT v_has OR c.due_at IS NULL OR c.due_at > now() THEN RETURN QUERY SELECT 'not_due', NULL::bigint, NULL::text; RETURN; END IF;
    UPDATE public.twin_parity_checks SET due_at = now() + interval '300 seconds' WHERE twin_id = t.id AND account_id = acct;
  ELSE
    IF v_has AND c.work_lease_until IS NOT NULL AND c.work_lease_until > now() THEN RETURN QUERY SELECT 'leased', NULL::bigint, NULL::text; RETURN; END IF;
    INSERT INTO public.twin_parity_checks (twin_id, account_id, work_lease_until) VALUES (t.id, acct, now() + interval '300 seconds')
    ON CONFLICT (twin_id) DO UPDATE SET work_lease_until = EXCLUDED.work_lease_until WHERE public.twin_parity_checks.account_id = acct;
  END IF;
  RETURN QUERY SELECT 'ok', v_seq, t.synced_public_sha;
END;
$$;

-- ---- 3. FU-312: twin_parity_record with the anchor ----------------------------------------------------------------------------------------------------------
DROP FUNCTION twin_parity_record(uuid, bigint, text, text, text, text[], integer, integer, integer, integer, text);

-- Records one parity result (1112's, with p_anchor). p_anchor is the synced_public_sha the claim returned: the result is written only while it is still the twin's stored anchor. o_result: ok | not_found | bad_state | stale.
-- Everything else is 1112's: p_mark_seq clears the due mark only if no push arrived since, the result must agree with its counts and paths, and p_advance_to moves synced_public_sha only when it is the public tip compared.
CREATE FUNCTION twin_parity_record(p_twin uuid, p_mark_seq bigint, p_anchor text, p_result text, p_private_sha text, p_public_sha text, p_paths text[], p_path_count integer,
                                   p_publish_count integer, p_sync_count integer, p_conflict_count integer, p_advance_to text) RETURNS TABLE (o_result text, o_state text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  t    record;
  v_new text;
  v_own integer;
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
     OR (usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin'))) THEN
    RAISE EXCEPTION 'twin_parity_record: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_twin IS NULL OR p_mark_seq IS NULL OR p_mark_seq < 0 OR p_anchor IS NULL OR p_anchor !~ '^[0-9a-f]{40}$' OR p_result IS NULL OR p_result NOT IN ('in_parity', 'publish_pending', 'sync_pending', 'conflict')
     OR (p_private_sha IS NOT NULL AND p_private_sha !~ '^[0-9a-f]{40}$') OR (p_public_sha IS NOT NULL AND p_public_sha !~ '^[0-9a-f]{40}$')
     OR (p_advance_to IS NOT NULL AND p_advance_to !~ '^[0-9a-f]{40}$')
     OR p_paths IS NULL OR cardinality(p_paths) > 200 OR array_position(p_paths, NULL) IS NOT NULL
     OR EXISTS (SELECT 1 FROM unnest(p_paths) AS x(p) WHERE length(x.p) > 1024 OR x.p !~ '^[^/\x01-\x1f][^\x01-\x1f]*$' OR x.p ~ '(^|/)\.\.?(/|$)' OR x.p ~ '//')
     OR (SELECT count(DISTINCT x) FROM unnest(p_paths) AS x) <> cardinality(p_paths)
     OR p_path_count IS NULL OR p_publish_count IS NULL OR p_sync_count IS NULL OR p_conflict_count IS NULL
     OR p_path_count < 0 OR p_publish_count < 0 OR p_sync_count < 0 OR p_conflict_count < 0 THEN
    RAISE EXCEPTION 'twin_parity_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_own := CASE p_result WHEN 'publish_pending' THEN p_publish_count WHEN 'sync_pending' THEN p_sync_count WHEN 'conflict' THEN p_conflict_count ELSE 0 END;
  IF p_path_count <> v_own OR cardinality(p_paths) <> LEAST(p_path_count, 200)
     OR (p_result = 'in_parity' AND (p_publish_count + p_sync_count + p_conflict_count) <> 0)
     OR (p_result = 'publish_pending' AND (p_publish_count < 1 OR p_sync_count <> 0 OR p_conflict_count <> 0))
     OR (p_result = 'sync_pending' AND (p_sync_count < 1 OR p_conflict_count <> 0))
     OR (p_result = 'conflict' AND p_conflict_count < 1)
     OR (p_advance_to IS NOT NULL AND (p_result NOT IN ('in_parity', 'publish_pending') OR p_advance_to IS DISTINCT FROM p_public_sha)) THEN
    RAISE EXCEPTION 'twin_parity_record: inconsistent result' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.id, x.state, x.private_repo_id, x.published_private_sha, x.synced_public_sha INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::text; RETURN; END IF;
  IF t.state NOT IN ('ready', 'conflict') OR t.private_repo_id IS NULL OR t.published_private_sha IS NULL OR t.synced_public_sha IS NULL THEN
    UPDATE public.twin_parity_checks SET due_at = NULL WHERE twin_id = t.id AND account_id = acct AND mark_seq = p_mark_seq;
    RETURN QUERY SELECT 'bad_state', t.state; RETURN;
  END IF;
  -- FU-312: the result was computed against p_anchor, the synced tip the checker claimed. If the stored anchor has moved since (a sync merged, say), the result describes a past state: it is dropped, nothing of it is written,
  -- and the twin is due at once so the next tick computes it again from the anchor it now has.
  IF t.synced_public_sha IS DISTINCT FROM p_anchor THEN
    UPDATE public.twin_parity_checks SET due_at = now() WHERE twin_id = t.id AND account_id = acct;
    RETURN QUERY SELECT 'stale', t.state; RETURN;
  END IF;
  v_new := CASE WHEN p_result = 'conflict' THEN 'conflict' ELSE 'ready' END;
  IF t.state IS DISTINCT FROM v_new OR (p_advance_to IS NOT NULL AND p_advance_to IS DISTINCT FROM t.synced_public_sha) THEN
    UPDATE public.repo_twins SET state = v_new, synced_public_sha = COALESCE(p_advance_to, synced_public_sha), updated_at = now() WHERE id = t.id AND account_id = acct;
  END IF;
  INSERT INTO public.twin_parity_checks (twin_id, account_id, due_at, mark_seq, last_result, private_sha, public_sha, paths, path_count, publish_count, sync_count, conflict_count, checked_at)
  VALUES (t.id, acct, NULL, 0, p_result, p_private_sha, p_public_sha, p_paths, p_path_count, p_publish_count, p_sync_count, p_conflict_count, now())
  ON CONFLICT (twin_id) DO UPDATE SET
    due_at = CASE WHEN public.twin_parity_checks.mark_seq = p_mark_seq THEN NULL ELSE public.twin_parity_checks.due_at END,
    last_result = EXCLUDED.last_result, private_sha = EXCLUDED.private_sha, public_sha = EXCLUDED.public_sha, paths = EXCLUDED.paths, path_count = EXCLUDED.path_count,
    publish_count = EXCLUDED.publish_count, sync_count = EXCLUDED.sync_count, conflict_count = EXCLUDED.conflict_count, checked_at = EXCLUDED.checked_at
   WHERE public.twin_parity_checks.account_id = acct;
  RETURN QUERY SELECT 'ok', v_new;
END;
$$;

-- ---- 4. FU-311: the visibility of the two repositories ----------------------------------------------------------------------------------------------------
-- p_private_seen is what the cloud read of the twin's private repository (private | public), p_public_seen of its public repository (private | public | NULL when it could not be read: the note is then left as it is).
-- o_result: ok | refused (the private repository is public: the twin is refused, code twin_not_private, and one twin.refused audit row is written; asking again says refused too) | not_found | bad_state (not a live twin, or refused for another reason).
CREATE FUNCTION twin_visibility_record(p_twin uuid, p_private_seen text, p_public_seen text) RETURNS TABLE (o_result text)
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
    IF t.state NOT IN ('seeding', 'ready', 'conflict', 'failed') THEN RETURN QUERY SELECT 'bad_state'; RETURN; END IF;
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

-- The refusal writes an audit row, so the definers' audit policy (1103's) is restated with twin.refused.
DROP POLICY repo_twins_owner_audit ON audit_log;
CREATE POLICY repo_twins_owner_audit ON audit_log FOR INSERT TO repo_twins_owner
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND action IN ('twin.created', 'twin.paused', 'twin.resumed', 'twin.removed', 'twin.connected', 'twin.paths_changed', 'twin.install_paths_added', 'twin.refused'));

-- ---- ownership and grants ------------------------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION twin_parity_list_due(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION twin_work_list(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION twin_work_claim(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION twin_parity_record(uuid, bigint, text, text, text, text, text[], integer, integer, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION twin_visibility_record(uuid, text, text) FROM PUBLIC;
ALTER FUNCTION twin_parity_list_due(int) OWNER TO setup_request_lister;
ALTER FUNCTION twin_work_list(int) OWNER TO setup_request_lister;
ALTER FUNCTION twin_work_claim(uuid, text) OWNER TO repo_twins_owner;
ALTER FUNCTION twin_parity_record(uuid, bigint, text, text, text, text, text[], integer, integer, integer, integer, text) OWNER TO repo_twins_owner;
ALTER FUNCTION twin_visibility_record(uuid, text, text) OWNER TO repo_twins_owner;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION twin_parity_list_due(int) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION twin_work_list(int) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION twin_work_claim(uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION twin_parity_record(uuid, bigint, text, text, text, text, text[], integer, integer, integer, integer, text) TO app_user;
GRANT EXECUTE ON FUNCTION twin_visibility_record(uuid, text, text) TO app_user;

REVOKE CREATE ON SCHEMA public FROM setup_request_lister, repo_twins_owner;
DO $$
DECLARE
  r text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH r IN ARRAY ARRAY['setup_request_lister', 'repo_twins_owner'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', r);
    END LOOP;
  END IF;
END
$$;
