-- D#5 E9: a run records the environment it used, and a build has a fixed set of states.
--
-- 1. agent_run_create gains p_env_version_id and p_image_digest, the two columns 0674 added as nullable. They are written
--    here and nowhere else. Both or neither: a run with an image digest and no version (or the reverse) is a half-record
--    that replay could not trust, so the function refuses it. Both default to NULL, so every existing caller (a run in a
--    repo with no environment) keeps working. The 14-argument function is dropped so there is one create path.
--    The values are shaped by the 0674 CHECKs (64 hex, sha256:<64 hex>); the function does not read env_versions, which
--    platform_ops cannot select, so it does not check that the digest belongs to the version. The caller is the runner's
--    own login (agent_run_writer), which took both values from the env_versions row it just read under the tenant.
--
-- 2. platform_ops gains INSERT on exactly those two columns, as 0648 gave it INSERT on the exposure columns: the definer
--    runs as its owner. A direct platform_ops session still cannot insert an agent_runs row at all (0642's write guard),
--    so the grant is not a way to forge the record. No other column is added to what platform_ops can write.
--
-- 3. env_builds.status gets a fixed set. 0674 left it free text; nothing wrote a build row before E9.
--      running    the build has started (the reservation is taken, the builder is working)
--      succeeded  the image is built and its digest recorded
--      failed     a step failed; failing_step names it
--      killed     the build hit its dollar or time cap (C12)
--
-- Numbering: main ended at 0734; open PRs hold 0735, 0736 and 0737. Re-check before merging.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO platform_ops;

GRANT INSERT (env_version_id, image_digest) ON agent_runs TO platform_ops;

DROP FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text, uuid);

CREATE FUNCTION agent_run_create(
  p_id                  uuid,
  p_account_id          uuid,
  p_work_item_id        uuid,
  p_parent_run_id       uuid,
  p_role                text,
  p_runtime             text,
  p_head_sha            text,
  p_execution_mode      text,
  p_dispatch_repo_id    uuid,
  p_dispatch_pr_number  bigint,
  p_spec_version_id     uuid,
  p_resolved_exposure   jsonb,
  p_exposure_digest     text,
  p_initiated_by        uuid DEFAULT NULL,
  p_env_version_id      text DEFAULT NULL,
  p_image_digest        text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id uuid := COALESCE(p_id, gen_random_uuid());
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_create: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account_id IS NULL
     OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'agent_run_create: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_resolved_exposure IS NULL OR jsonb_typeof(p_resolved_exposure) IS DISTINCT FROM 'object'
     OR p_exposure_digest IS NULL OR p_exposure_digest !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'agent_run_create: a run needs a resolved exposure and its digest'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_resolved_exposure->>'accountId' IS DISTINCT FROM p_account_id::text THEN
    RAISE EXCEPTION 'agent_run_create: the resolved exposure belongs to a different account'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_initiated_by IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.account_members m
        WHERE m.account_id = p_account_id AND m.user_id = p_initiated_by
     )
  THEN
    RAISE EXCEPTION 'agent_run_create: the user who started the run is not a member of the account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The environment record is whole or absent: replay needs both the version and the digest it resolved to.
  IF (p_env_version_id IS NULL) IS DISTINCT FROM (p_image_digest IS NULL) THEN
    RAISE EXCEPTION 'agent_run_create: env_version_id and image_digest are recorded together or not at all'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.agent_runs
    (id, account_id, work_item_id, parent_run_id, role, runtime, status, head_sha,
     execution_mode, dispatch_repo_id, dispatch_pr_number, spec_version_id,
     resolved_exposure, exposure_digest, initiated_by, env_version_id, image_digest)
  VALUES
    (v_id, p_account_id, p_work_item_id, p_parent_run_id, p_role, p_runtime, 'pending',
     p_head_sha, p_execution_mode, p_dispatch_repo_id, p_dispatch_pr_number, p_spec_version_id,
     p_resolved_exposure, p_exposure_digest, p_initiated_by, p_env_version_id, p_image_digest);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text, uuid, text, text) TO agent_run_writer;
ALTER FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text, uuid, text, text) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;

-- 4. The two run columns are write-once, in the schema and not only through grants: a trigger refuses any later change
--    to either, from every role (the table owner included), in the shape 0714 gave initiated_by.
CREATE FUNCTION agent_runs_env_columns_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.env_version_id IS DISTINCT FROM OLD.env_version_id OR NEW.image_digest IS DISTINCT FROM OLD.image_digest THEN
    RAISE EXCEPTION 'agent_runs.env_version_id and image_digest are written at insert only (run %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION agent_runs_env_columns_immutable() FROM PUBLIC;

CREATE TRIGGER agent_runs_env_columns_immutable
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_env_columns_immutable();

-- 5. A build's lifecycle is enforced here. `running` is exactly the state with no finish time, so a build cannot be
--    finished without a time or left open with one, and a finished build is frozen: no role can reopen it or rewrite its
--    cost, outcome or log (the only write a finished row ever gets is none).
ALTER TABLE env_builds
  ADD CONSTRAINT env_builds_status_known_check CHECK (status IN ('running', 'succeeded', 'failed', 'killed')),
  ADD CONSTRAINT env_builds_lifecycle_check CHECK ((status = 'running') = (finished_at IS NULL));

CREATE FUNCTION env_builds_finished_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'env_builds: a finished build cannot change (build %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION env_builds_finished_frozen() FROM PUBLIC;

CREATE TRIGGER env_builds_finished_frozen
  BEFORE UPDATE ON env_builds
  FOR EACH ROW
  EXECUTE FUNCTION env_builds_finished_frozen();

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
