-- D#2 H-EXPO (amendment 18488789, H04/H09): every new agent_runs row carries
-- the exposure that was resolved for its account when the run was created.
--
-- Criterion: resolved_exposure and exposure_digest are non-null on every new
-- agent_runs row. 0611 added the two columns (nullable, because rows that
-- predate them cannot be backfilled honestly). The only INSERT path is the
-- agent_run_create definer (0642), so the guarantee is made there: it takes
-- both values as parameters and refuses to insert without them. A caller
-- that resolved nothing gets an error and no row (fail closed).
--
-- The runner computes both values server-side from the account's own
-- account_features rows (packages/features resolveExposure, inside the
-- tenant context); no request field feeds them. This function also checks
-- the tenant context as before, so a value resolved for one account cannot
-- be written onto another account's row.
--
-- The signature changes, so the old 11-argument function is dropped and the
-- new 13-argument one is created, owned by platform_ops with EXECUTE for
-- agent_run_writer only, exactly as 0642 left it. platform_ops needs INSERT
-- on the two new columns for the function body; app_user still has no
-- INSERT or UPDATE on them (0611, 0642).
--
-- Numbering: 0648. main ended at 0646; open PR #227 holds 0647.

GRANT INSERT (resolved_exposure, exposure_digest) ON agent_runs TO platform_ops;

DROP FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid);

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
  p_exposure_digest     text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id uuid := COALESCE(p_id, gen_random_uuid());
BEGIN
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

  -- Defence in depth: the exposure was resolved for one account and may only
  -- land on that account's row. The runner builds both from one id; this
  -- refuses a caller that does not.
  IF p_resolved_exposure->>'accountId' IS DISTINCT FROM p_account_id::text THEN
    RAISE EXCEPTION 'agent_run_create: the resolved exposure belongs to a different account'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.agent_runs
    (id, account_id, work_item_id, parent_run_id, role, runtime, status, head_sha,
     execution_mode, dispatch_repo_id, dispatch_pr_number, spec_version_id,
     resolved_exposure, exposure_digest)
  VALUES
    (v_id, p_account_id, p_work_item_id, p_parent_run_id, p_role, p_runtime, 'pending',
     p_head_sha, p_execution_mode, p_dispatch_repo_id, p_dispatch_pr_number, p_spec_version_id,
     p_resolved_exposure, p_exposure_digest);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text) TO agent_run_writer;

GRANT CREATE ON SCHEMA public TO platform_ops;
ALTER FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;
