-- D#845 ON-27d2b: where a private twin and its public repository stand, stored. Two things are kept per twin in one small table, twin_parity_checks (modelled on 0951's plane_parity_checks):
--
--   the due mark       due_at is NULL while nothing is due. A push to either repository of a ready or conflicting twin sets it to now() + 60 s (kept if already earlier). mark_seq counts the marks, so a result
--                      clears the mark only when no push arrived since the check began (the checker reads mark_seq when it claims the twin and hands it back).
--   the last result    last_result (in_parity | publish_pending | sync_pending | conflict), the two tips compared, the paths of the result's own kind (at most 200) and the three exact counts.
--
-- Two SECURITY DEFINER functions, owned by repo_twins_owner (1097), EXECUTE for app_user alone, each for the session's account only:
--   twin_parity_mark_due(twin, pushed repo id, pushed repo full name): the push webhook's call. It marks the twin only if the pushed repository really is one of its two sides, and only while the twin is ready or conflicting.
--   twin_parity_record(...): records one result, sets the twin's state (conflict, or back to ready), and moves synced_public_sha ONLY when the caller passes the tip the check said it may advance to (nothing public left to
--   bring in, nothing in dispute: it must be the public tip that was compared). Never touches sync_pr, sync_head or sync_verified_at (1111's), publish_pr or published_private_sha.
-- The caller is the push webhook's or the reconcile tick's session (no person) or an owner or admin: never a runner's, never platform_ops's. app_user may read the table under row security and writes nothing directly.
-- Nothing calls these yet (ON-27d4 wires them).
--
-- Numbered 1112 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

CREATE TABLE twin_parity_checks (
  twin_id        uuid PRIMARY KEY,
  account_id     uuid NOT NULL,
  due_at         timestamptz,
  mark_seq       bigint NOT NULL DEFAULT 0 CONSTRAINT twin_parity_checks_mark_seq_check CHECK (mark_seq >= 0),
  last_result    text CONSTRAINT twin_parity_checks_result_check CHECK (last_result IN ('in_parity', 'publish_pending', 'sync_pending', 'conflict')),
  private_sha    text CONSTRAINT twin_parity_checks_private_sha_check CHECK (private_sha ~ '^[0-9a-f]{40}$'),
  public_sha     text CONSTRAINT twin_parity_checks_public_sha_check CHECK (public_sha ~ '^[0-9a-f]{40}$'),
  paths          text[] NOT NULL DEFAULT '{}' CONSTRAINT twin_parity_checks_paths_check CHECK (cardinality(paths) <= 200),
  path_count     integer NOT NULL DEFAULT 0 CONSTRAINT twin_parity_checks_path_count_check CHECK (path_count >= 0),
  publish_count  integer NOT NULL DEFAULT 0 CONSTRAINT twin_parity_checks_publish_count_check CHECK (publish_count >= 0),
  sync_count     integer NOT NULL DEFAULT 0 CONSTRAINT twin_parity_checks_sync_count_check CHECK (sync_count >= 0),
  conflict_count integer NOT NULL DEFAULT 0 CONSTRAINT twin_parity_checks_conflict_count_check CHECK (conflict_count >= 0),
  checked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, twin_id) REFERENCES repo_twins (account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_twin_parity_checks_due ON twin_parity_checks (due_at) INCLUDE (account_id, twin_id) WHERE due_at IS NOT NULL;

ALTER TABLE twin_parity_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE twin_parity_checks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON twin_parity_checks FROM PUBLIC;
GRANT SELECT ON twin_parity_checks TO app_user;
CREATE POLICY tenant_isolation_select ON twin_parity_checks FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

-- What repo_twins_owner reads and writes here, by column, in the session's account only. Its reads of repo_twins and repos are 1097's and 1099's.
GRANT SELECT ON twin_parity_checks TO repo_twins_owner;
GRANT INSERT (twin_id, account_id, due_at, mark_seq, last_result, private_sha, public_sha, paths, path_count, publish_count, sync_count, conflict_count, checked_at) ON twin_parity_checks TO repo_twins_owner;
GRANT UPDATE (due_at, mark_seq, last_result, private_sha, public_sha, paths, path_count, publish_count, sync_count, conflict_count, checked_at) ON twin_parity_checks TO repo_twins_owner;
CREATE POLICY repo_twins_owner_use ON twin_parity_checks FOR ALL TO repo_twins_owner
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---- ownership: the migration role holds repo_twins_owner only to hand the functions over (1097's shape) --------------------------------------------------
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

-- The push webhook's mark. o_result: ok | not_found (no such twin in the account) | repo_mismatch (the pushed repository is neither side of the twin) | bad_state (not ready or conflict, or no private repo).
CREATE FUNCTION twin_parity_mark_due(p_twin uuid, p_repo uuid, p_full_name text) RETURNS TABLE (o_result text)
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
    RAISE EXCEPTION 'twin_parity_mark_due: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_twin IS NULL OR (p_repo IS NULL AND p_full_name IS NULL) OR (p_full_name IS NOT NULL AND p_full_name !~ '^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$') THEN
    RAISE EXCEPTION 'twin_parity_mark_due: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.id, x.state, x.public_repo_id, x.private_repo_id INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'; RETURN; END IF;
  IF NOT ((p_repo IS NOT NULL AND p_repo IN (t.public_repo_id, t.private_repo_id))
          OR (p_full_name IS NOT NULL AND EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = acct AND r.id IN (t.public_repo_id, t.private_repo_id) AND lower(r.gh_owner || '/' || r.gh_name) = lower(p_full_name)))) THEN
    RETURN QUERY SELECT 'repo_mismatch'; RETURN;
  END IF;
  IF t.state NOT IN ('ready', 'conflict') OR t.private_repo_id IS NULL THEN RETURN QUERY SELECT 'bad_state'; RETURN; END IF;
  INSERT INTO public.twin_parity_checks (twin_id, account_id, due_at, mark_seq) VALUES (t.id, acct, now() + interval '60 seconds', 1)
  ON CONFLICT (twin_id) DO UPDATE SET due_at = LEAST(public.twin_parity_checks.due_at, EXCLUDED.due_at), mark_seq = public.twin_parity_checks.mark_seq + 1
   WHERE public.twin_parity_checks.account_id = acct;
  RETURN QUERY SELECT 'ok';
END;
$$;

-- Records one parity result. p_mark_seq is the mark_seq the checker read when it claimed the twin (0 if it had no row): the due mark is cleared only while it still equals it, so a push that arrived during the check keeps the twin due.
-- The twin goes to `conflict` for a conflict result and to `ready` for any other (a conflict clears when it is resolved). The result must be consistent with its counts and paths (the pipeline's TwinParityOutcome): in_parity has none of
-- the three counts, publish_pending only publish, sync_pending sync and no conflict, conflict at least one conflict; path_count is the result's own kind's count and paths are that many (at most 200), distinct.
-- p_advance_to moves synced_public_sha and is accepted only for in_parity and publish_pending, and only when it is the public tip that was compared (p_public_sha).
-- o_result: ok | not_found | bad_state (the twin is not ready or conflict, has no private repo, or was never seeded: the due mark is cleared and nothing else is written).
CREATE FUNCTION twin_parity_record(p_twin uuid, p_mark_seq bigint, p_result text, p_private_sha text, p_public_sha text, p_paths text[], p_path_count integer,
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
  IF p_twin IS NULL OR p_mark_seq IS NULL OR p_mark_seq < 0 OR p_result IS NULL OR p_result NOT IN ('in_parity', 'publish_pending', 'sync_pending', 'conflict')
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

REVOKE ALL ON FUNCTION twin_parity_mark_due(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION twin_parity_record(uuid, bigint, text, text, text, text[], integer, integer, integer, integer, text) FROM PUBLIC;
ALTER FUNCTION twin_parity_mark_due(uuid, uuid, text) OWNER TO repo_twins_owner;
ALTER FUNCTION twin_parity_record(uuid, bigint, text, text, text, text[], integer, integer, integer, integer, text) OWNER TO repo_twins_owner;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION twin_parity_mark_due(uuid, uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION twin_parity_record(uuid, bigint, text, text, text, text[], integer, integer, integer, integer, text) TO app_user;

REVOKE CREATE ON SCHEMA public FROM repo_twins_owner;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE repo_twins_owner FROM CURRENT_USER;
  END IF;
END
$$;
