-- D#845 MC-9b2a: the storage for the engine's state-directory carry on a move. The old machine's stop uploads the state tar in 4 MiB chunks; the cloud holds them sealed (the sealing is the route's, in a later change);
-- the new machine's start fetches them and the rows go. Nothing here ever picks a fallback: an open carry blocks every start that is not its own.
--   1. state_carries (one header per carry, one open per repo) and state_carry_chunks (the sealed content). Both have row security and no direct write for app_user; the header's columns are readable, the content's are not.
--      A carry stays open until it is imported, abandoned, retried or cancelled. A failure (the machine said so, 24 h passed, the old machine was removed before it handed over) is a failure_code on the open carry,
--      so the person decides (Try again, or Start without the memory); the content rows of a failed carry are gone. The header of a closed carry is kept 30 days.
--   2. Runner definers (machine_jobs_owner, the runner's own session and its own delivered job): begin, chunk_put, seal, fail (the old machine's stop), chunk_take, imported (the new machine's start).
--      Person definers (an owner or admin, never a runner): request, retarget, abandon, retry. The sweep and the start guard (a BEFORE INSERT trigger on machine_jobs) are engine_start_definer's.
--   3. machine_cleanup_move_due (the 1083 rule) and machine_cleanup_issue are re-made (1083's bodies carried forward): a move delete is not due while the cleanup has an open carry, and a stop carries exactly the
--      open unsealed carry's id, or no carry at all.
--   4. The capability list takes 'engine_carry_v1' (1122's, with it last).
-- Numbered 1123 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest; carry any capability a lower migration added.

CREATE TABLE state_carries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id        uuid NOT NULL,
  from_runner_id uuid NOT NULL,
  to_runner_id   uuid NOT NULL,
  cleanup_id     uuid NOT NULL,
  requested_by   uuid NOT NULL REFERENCES users (id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  bytes          integer,
  chunks         integer,
  sha256         text,
  begun_at       timestamptz,
  sealed_at      timestamptz,
  failure_code   text CONSTRAINT state_carries_failure_check CHECK (failure_code IN ('too_large', 'link', 'export_failed', 'import_failed', 'expired', 'source_removed', 'runner_update_needed')),
  closed_at      timestamptz,
  closed_reason  text CONSTRAINT state_carries_closed_reason_check CHECK (closed_reason IN ('imported', 'abandoned', 'retried', 'cancelled')),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, from_runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, to_runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, cleanup_id) REFERENCES machine_cleanups (account_id, id) ON DELETE CASCADE,
  CONSTRAINT state_carries_two_machines CHECK (from_runner_id <> to_runner_id),
  -- Begun means all three facts are there: at most 50 MiB in at most 13 chunks of 4 MiB, and the whole bundle's sha256.
  CONSTRAINT state_carries_begun CHECK ((begun_at IS NULL) = (bytes IS NULL) AND (bytes IS NULL) = (chunks IS NULL) AND (bytes IS NULL) = (sha256 IS NULL)
    AND (bytes IS NULL OR (bytes BETWEEN 1 AND 52428800 AND chunks = (bytes + 4194303) / 4194304 AND sha256 ~ '^[0-9a-f]{64}$'))),
  CONSTRAINT state_carries_sealed CHECK (sealed_at IS NULL OR begun_at IS NOT NULL),
  CONSTRAINT state_carries_closed CHECK ((closed_at IS NULL) = (closed_reason IS NULL))
);
CREATE UNIQUE INDEX state_carries_one_open ON state_carries (account_id, repo_id) WHERE closed_at IS NULL;

CREATE TABLE state_carry_chunks (
  account_id     uuid NOT NULL,
  carry_id       uuid NOT NULL,
  idx            integer NOT NULL CONSTRAINT state_carry_chunks_idx_check CHECK (idx BETWEEN 0 AND 12),
  size           integer NOT NULL CONSTRAINT state_carry_chunks_size_check CHECK (size BETWEEN 1 AND 4194304),
  sha256         text NOT NULL CONSTRAINT state_carry_chunks_sha_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  kek_version    integer NOT NULL CONSTRAINT state_carry_chunks_kek_check CHECK (kek_version >= 1),
  nonce          bytea NOT NULL CONSTRAINT state_carry_chunks_nonce_check CHECK (octet_length(nonce) BETWEEN 1 AND 64),
  wrapped_dek    bytea NOT NULL CONSTRAINT state_carry_chunks_dek_check CHECK (octet_length(wrapped_dek) BETWEEN 1 AND 512),
  ciphertext     bytea NOT NULL CONSTRAINT state_carry_chunks_ciphertext_check CHECK (octet_length(ciphertext) BETWEEN 1 AND 4194304 + 1024),
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  fetched_job_id uuid,
  fetched_at     timestamptz,
  PRIMARY KEY (account_id, carry_id, idx),
  FOREIGN KEY (account_id, carry_id) REFERENCES state_carries (account_id, id) ON DELETE CASCADE
);

ALTER TABLE state_carries ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_carries FORCE ROW LEVEL SECURITY;
ALTER TABLE state_carry_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_carry_chunks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON state_carries, state_carry_chunks FROM PUBLIC;
-- app_user reads the header (a runner session only its own source machine's) and the chunk's non-content columns (a person's session only); it writes neither table.
GRANT SELECT ON state_carries TO app_user;
GRANT SELECT (account_id, carry_id, idx, size, uploaded_at) ON state_carry_chunks TO app_user;
CREATE POLICY tenant_isolation_select ON state_carries FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (NULLIF(current_setting('app.runner_id', true), '') IS NULL OR from_runner_id::text = lower(current_setting('app.runner_id', true))));
CREATE POLICY tenant_isolation_select ON state_carry_chunks FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND NULLIF(current_setting('app.runner_id', true), '') IS NULL);

-- machine_jobs_owner: the definers' reads and writes, in the session's account only. engine_start_definer: the sweep and the guard, across accounts (their callers are platform_ops and the trigger), columns only.
GRANT SELECT, INSERT, UPDATE, DELETE ON state_carries, state_carry_chunks TO machine_jobs_owner;
CREATE POLICY machine_jobs_owner_use ON state_carries FOR ALL TO machine_jobs_owner
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY machine_jobs_owner_use ON state_carry_chunks FOR ALL TO machine_jobs_owner
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT (id, account_id, repo_id, from_runner_id, to_runner_id, begun_at, sealed_at, failure_code, closed_at), UPDATE (failure_code, closed_at, closed_reason) ON state_carries TO engine_start_definer;
GRANT SELECT (account_id, carry_id) ON state_carry_chunks TO engine_start_definer;
GRANT DELETE ON state_carries, state_carry_chunks TO engine_start_definer;
CREATE POLICY engine_start_definer_use ON state_carries FOR ALL TO engine_start_definer USING (true) WITH CHECK (true);
CREATE POLICY engine_start_definer_use ON state_carry_chunks FOR ALL TO engine_start_definer USING (true) WITH CHECK (true);

-- ---- the capability: a hello that declares 'engine_carry_v1' must store (1122's list, 'engine_carry_v1' last) ---------------------------------------------------------
ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1', 'engine_lease_v1', 'survey_public_v1', 'twin_v1', 'platform_fact_v1', 'engine_carry_v1']::text[]));

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_capabilities_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_capabilities_definer; cannot replace runner_capabilities_record';
    END IF;
    EXECUTE 'GRANT runner_capabilities_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION runner_capabilities_record(p_capabilities text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_capabilities_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A live runner of an active account, named by the session: no runner in the session, a revoked one or another account's one writes nothing.
  IF acct IS NULL OR NOT account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'runner_capabilities_record: the session is not a live runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Closed codes, each once, a flat list: anything else is refused, not repaired, so what is stored is exactly what was sent.
  IF p_capabilities IS NULL OR (cardinality(p_capabilities) > 0 AND array_ndims(p_capabilities) <> 1)
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1', 'engine_lease_v1', 'survey_public_v1', 'twin_v1', 'platform_fact_v1', 'engine_carry_v1']))
     OR (SELECT count(*) <> count(DISTINCT c) FROM unnest(p_capabilities) c) THEN
    RAISE EXCEPTION 'runner_capabilities_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.runner_capabilities AS c (runner_id, account_id, capabilities)
  VALUES (raw::uuid, acct, p_capabilities)
  ON CONFLICT (runner_id) DO UPDATE SET capabilities = EXCLUDED.capabilities, reported_at = now();
END;
$$;
REVOKE ALL ON FUNCTION runner_capabilities_record(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_capabilities_record(text[]) TO app_user;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE 'REVOKE runner_capabilities_definer FROM CURRENT_USER';
  END IF;
END
$$;

-- ---- ownership, then the functions ---------------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
  r text;
BEGIN
  IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.machine_cleanup_due()'::regprocedure) IS DISTINCT FROM 'machine_jobs_owner' THEN
    RAISE EXCEPTION 'machine_cleanup_due is not owned by machine_jobs_owner; this migration was written for 1082''s owner';
  END IF;
  FOREACH r IN ARRAY ARRAY['machine_jobs_owner', 'engine_start_definer'] LOOP
    IF NOT super THEN
      IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot create the state carry functions', r;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', r);
    END IF;
    EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', r);
  END LOOP;

  -- Helpers (invoker rights, the definers' own, no EXECUTE for app_user). The person: an owner or admin of the session's active account, never a runner or platform_ops. The job: the session runner's own DELIVERED
  -- job of the kind, whose signed args name a carry whose source (a stop) or target (a start) is that runner; the carry row comes back locked. Anything else is refused, one answer.
  CREATE FUNCTION public.state_carry_person() RETURNS uuid
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR usr IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'state_carry: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN acct;
  END;
  $f$;

  CREATE FUNCTION public.state_carry_for_job(p_job uuid, p_kind text, p_states text[]) RETURNS public.state_carries
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    rid  uuid := public.machine_job_runner();
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    c    public.state_carries%ROWTYPE;
  BEGIN
    PERFORM public.machine_job_expire(rid);
    SELECT sc.* INTO c FROM public.state_carries sc
     WHERE sc.account_id = acct
       AND sc.id::text = (SELECT j.job #>> '{job,args,carry,id}' FROM public.machine_jobs j
                           WHERE j.id = p_job AND j.account_id = acct AND j.runner_id = rid AND j.kind = p_kind AND j.state = ANY (p_states))
       AND CASE p_kind WHEN 'engine_session_stop' THEN sc.from_runner_id ELSE sc.to_runner_id END = rid
     FOR UPDATE OF sc;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'state_carry: no such carry for this job' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN c;
  END;
  $f$;

  -- The old machine's stop: begin (the three facts, once), chunk_put (the chunk's exact size for its place; the same sha256 again is a no-op, another one before the seal replaces it), seal (every index, sizes adding up), fail.
  CREATE FUNCTION public.state_carry_begin(p_job uuid, p_bytes integer, p_chunks integer, p_sha256 text) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE c public.state_carries%ROWTYPE;
  BEGIN
    c := public.state_carry_for_job(p_job, 'engine_session_stop', ARRAY['delivered']);
    IF c.closed_at IS NOT NULL OR c.sealed_at IS NOT NULL OR c.failure_code IS NOT NULL OR p_bytes IS NULL OR p_chunks IS NULL OR p_sha256 IS NULL
       OR p_bytes NOT BETWEEN 1 AND 52428800 OR p_chunks <> (p_bytes + 4194303) / 4194304 OR p_sha256 !~ '^[0-9a-f]{64}$'
       OR (c.begun_at IS NOT NULL AND (c.bytes, c.chunks, c.sha256) IS DISTINCT FROM (p_bytes, p_chunks, p_sha256)) THEN
      RAISE EXCEPTION 'state_carry_begin: refused' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE public.state_carries SET bytes = p_bytes, chunks = p_chunks, sha256 = p_sha256, begun_at = COALESCE(begun_at, now()) WHERE id = c.id AND account_id = c.account_id;
  END;
  $f$;

  CREATE FUNCTION public.state_carry_chunk_put(p_job uuid, p_idx integer, p_size integer, p_sha256 text, p_kek_version integer, p_nonce bytea, p_wrapped_dek bytea, p_ciphertext bytea) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE c public.state_carries%ROWTYPE;
  BEGIN
    c := public.state_carry_for_job(p_job, 'engine_session_stop', ARRAY['delivered']);
    IF c.closed_at IS NOT NULL OR c.sealed_at IS NOT NULL OR c.failure_code IS NOT NULL OR c.begun_at IS NULL OR p_idx IS NULL OR p_idx NOT BETWEEN 0 AND c.chunks - 1
       OR p_size IS DISTINCT FROM (CASE WHEN p_idx < c.chunks - 1 THEN 4194304 ELSE c.bytes - (c.chunks - 1) * 4194304 END) THEN
      RAISE EXCEPTION 'state_carry_chunk_put: refused' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO public.state_carry_chunks AS k (account_id, carry_id, idx, size, sha256, kek_version, nonce, wrapped_dek, ciphertext)
    VALUES (c.account_id, c.id, p_idx, p_size, p_sha256, p_kek_version, p_nonce, p_wrapped_dek, p_ciphertext)
    ON CONFLICT (account_id, carry_id, idx) DO UPDATE
      SET size = EXCLUDED.size, sha256 = EXCLUDED.sha256, kek_version = EXCLUDED.kek_version, nonce = EXCLUDED.nonce, wrapped_dek = EXCLUDED.wrapped_dek, ciphertext = EXCLUDED.ciphertext,
          uploaded_at = now(), fetched_job_id = NULL, fetched_at = NULL
      WHERE k.sha256 <> EXCLUDED.sha256;
  END;
  $f$;

  CREATE FUNCTION public.state_carry_seal(p_job uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE c public.state_carries%ROWTYPE;
  BEGIN
    c := public.state_carry_for_job(p_job, 'engine_session_stop', ARRAY['delivered']);
    IF c.closed_at IS NOT NULL OR c.sealed_at IS NOT NULL OR c.failure_code IS NOT NULL OR c.begun_at IS NULL
       OR (SELECT count(DISTINCT k.idx) FROM public.state_carry_chunks k WHERE k.account_id = c.account_id AND k.carry_id = c.id AND k.idx < c.chunks) <> c.chunks
       OR (SELECT sum(k.size) FROM public.state_carry_chunks k WHERE k.account_id = c.account_id AND k.carry_id = c.id) IS DISTINCT FROM c.bytes THEN
      RAISE EXCEPTION 'state_carry_seal: refused' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE public.state_carries SET sealed_at = now() WHERE id = c.id AND account_id = c.account_id;
  END;
  $f$;

  CREATE FUNCTION public.state_carry_fail(p_job uuid, p_code text) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE c public.state_carries%ROWTYPE;
  BEGIN
    c := public.state_carry_for_job(p_job, 'engine_session_stop', ARRAY['delivered']);
    IF c.closed_at IS NOT NULL OR c.sealed_at IS NOT NULL OR c.failure_code IS NOT NULL OR p_code IS NULL OR p_code <> ALL (ARRAY['too_large', 'link', 'export_failed']) THEN
      RAISE EXCEPTION 'state_carry_fail: refused' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE public.state_carries SET failure_code = p_code WHERE id = c.id AND account_id = c.account_id;
    DELETE FROM public.state_carry_chunks WHERE account_id = c.account_id AND carry_id = c.id;
  END;
  $f$;

  -- The new machine's start: each chunk once per job (a second take by the same job is 55000, a later job may take it again), then imported, which deletes the content and closes the carry.
  CREATE FUNCTION public.state_carry_chunk_take(p_job uuid, p_idx integer)
  RETURNS TABLE (o_size integer, o_sha256 text, o_kek_version integer, o_nonce bytea, o_wrapped_dek bytea, o_ciphertext bytea, o_carry_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    c public.state_carries%ROWTYPE;
    v_fetched uuid;
  BEGIN
    c := public.state_carry_for_job(p_job, 'engine_session_start', ARRAY['delivered']);
    IF c.closed_at IS NOT NULL OR c.sealed_at IS NULL OR c.failure_code IS NOT NULL OR p_idx IS NULL THEN
      RAISE EXCEPTION 'state_carry_chunk_take: refused' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT k.fetched_job_id INTO v_fetched FROM public.state_carry_chunks k WHERE k.account_id = c.account_id AND k.carry_id = c.id AND k.idx = p_idx FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'state_carry_chunk_take: no such chunk' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_fetched = p_job THEN
      RAISE EXCEPTION 'state_carry_chunk_take: carry_fetched' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN QUERY UPDATE public.state_carry_chunks k SET fetched_job_id = p_job, fetched_at = now() WHERE k.account_id = c.account_id AND k.carry_id = c.id AND k.idx = p_idx
      RETURNING k.size, k.sha256, k.kek_version, k.nonce, k.wrapped_dek, k.ciphertext, k.carry_id;
  END;
  $f$;

  -- The carry id the old machine's delivered stop names, for the upload route to bind into each chunk's AAD (never taken from the caller).
  CREATE FUNCTION public.state_carry_job_carry(p_job uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  BEGIN
    RETURN (public.state_carry_for_job(p_job, 'engine_session_stop', ARRAY['delivered'])).id;
  END;
  $f$;

  CREATE FUNCTION public.state_carry_imported(p_job uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE c public.state_carries%ROWTYPE;
  BEGIN
    c := public.state_carry_for_job(p_job, 'engine_session_start', ARRAY['delivered', 'done']);
    IF c.closed_reason = 'imported' THEN RETURN; END IF;
    IF c.closed_at IS NOT NULL OR c.sealed_at IS NULL OR c.failure_code IS NOT NULL THEN
      RAISE EXCEPTION 'state_carry_imported: refused' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    DELETE FROM public.state_carry_chunks WHERE account_id = c.account_id AND carry_id = c.id;
    UPDATE public.state_carries SET closed_at = now(), closed_reason = 'imported' WHERE id = c.id AND account_id = c.account_id;
  END;
  $f$;

  -- The person's: request (inside the move, for the cleanup the move just wrote, to the machine the repo is placed on now), retarget (a re-move: the open carry's target follows, its source stays), abandon (Start without the
  -- memory) and retry (the open carry closes, a new one opens for the same source and the cleanup's chain restarts).
  CREATE FUNCTION public.state_carry_request(p_cleanup uuid, p_to uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := public.state_carry_person();
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
    c    public.machine_cleanups%ROWTYPE;
    v_id uuid;
  BEGIN
    SELECT * INTO c FROM public.machine_cleanups x WHERE x.id = p_cleanup AND x.account_id = acct AND x.reason = 'move';
    IF NOT FOUND OR p_to IS NULL OR p_to = c.runner_id
       OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.account_id = acct AND r.id = p_to AND r.revoked_at IS NULL)
       OR NOT EXISTS (SELECT 1 FROM public.project_placements pl WHERE pl.account_id = acct AND pl.repo_id = c.repo_id AND pl.runner_id = p_to) THEN
      RAISE EXCEPTION 'state_carry_request: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO public.state_carries (account_id, repo_id, from_runner_id, to_runner_id, cleanup_id, requested_by) VALUES (acct, c.repo_id, c.runner_id, p_to, c.id, usr) RETURNING id INTO v_id;
    RETURN v_id;
  END;
  $f$;

  CREATE FUNCTION public.state_carry_retarget(p_repo uuid, p_to uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE acct uuid := public.state_carry_person();
  BEGIN
    UPDATE public.state_carries c SET to_runner_id = p_to
     WHERE c.account_id = acct AND c.repo_id = p_repo AND c.closed_at IS NULL AND c.from_runner_id <> p_to
       AND EXISTS (SELECT 1 FROM public.runners r WHERE r.account_id = acct AND r.id = p_to AND r.revoked_at IS NULL)
       AND EXISTS (SELECT 1 FROM public.project_placements pl WHERE pl.account_id = acct AND pl.repo_id = p_repo AND pl.runner_id = p_to);
    RETURN FOUND;
  END;
  $f$;

  CREATE FUNCTION public.state_carry_abandon(p_carry uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE acct uuid := public.state_carry_person();
  BEGIN
    UPDATE public.state_carries SET closed_at = now(), closed_reason = 'abandoned' WHERE id = p_carry AND account_id = acct AND closed_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'state_carry_abandon: no open carry' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    DELETE FROM public.state_carry_chunks WHERE account_id = acct AND carry_id = p_carry;
  END;
  $f$;

  CREATE FUNCTION public.state_carry_retry(p_carry uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := public.state_carry_person();
    c    public.state_carries%ROWTYPE;
    v_to uuid;
    v_id uuid;
    v_cl uuid;
  BEGIN
    SELECT * INTO c FROM public.state_carries x WHERE x.id = p_carry AND x.account_id = acct AND x.closed_at IS NULL FOR UPDATE;
    SELECT pl.runner_id INTO v_to FROM public.project_placements pl WHERE pl.account_id = acct AND pl.repo_id = c.repo_id;
    IF NOT FOUND OR c.failure_code = 'source_removed' OR v_to = c.from_runner_id
       OR EXISTS (SELECT 1 FROM public.runners r WHERE r.account_id = acct AND r.id = c.from_runner_id AND r.revoked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'state_carry_retry: nothing to retry' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE public.state_carries SET closed_at = now(), closed_reason = 'retried' WHERE id = c.id AND account_id = acct;
    DELETE FROM public.state_carry_chunks WHERE account_id = acct AND carry_id = c.id;
    v_cl := public.machine_cleanup_request_move(c.repo_id, c.from_runner_id);
    INSERT INTO public.state_carries (account_id, repo_id, from_runner_id, to_runner_id, cleanup_id, requested_by)
    VALUES (acct, c.repo_id, c.from_runner_id, v_to, v_cl, NULLIF(current_setting('app.user_id', true), '')::uuid) RETURNING id INTO v_id;
    RETURN v_id;
  END;
  $f$;

  -- engine_start_definer's. The guard: a start of a repo with an open carry is refused (55000) unless it is that carry's own, sealed, unfailed, for its target machine. The sweep (platform_ops): 24 h after the seal
  -- (or after an unsealed begin) the carry is expired; an unsealed carry whose source was removed is source_removed (a sealed one stays importable); the content of a failed or closed carry goes; a carry of a
  -- repo with no placement is cancelled; a closed header is deleted after 30 days. It returns how many carries it marked, cancelled or deleted.
  CREATE FUNCTION public.state_carry_start_guard() RETURNS trigger
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  BEGIN
    IF EXISTS (SELECT 1 FROM public.state_carries c WHERE c.account_id = NEW.account_id AND c.repo_id = NEW.repo_id AND c.closed_at IS NULL
                  AND NOT (COALESCE(c.id::text = NEW.job #>> '{job,args,carry,id}', false) AND c.sealed_at IS NOT NULL AND c.failure_code IS NULL AND c.to_runner_id = NEW.runner_id)) THEN
      RAISE EXCEPTION 'state_carry_start_guard: a carry is open for this project' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END;
  $f$;
  CREATE TRIGGER state_carry_start_guard BEFORE INSERT ON public.machine_jobs FOR EACH ROW WHEN (NEW.kind = 'engine_session_start') EXECUTE FUNCTION public.state_carry_start_guard();

  CREATE FUNCTION public.state_carry_sweep() RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    n integer := 0;
    k integer;
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'state_carry_sweep: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE public.state_carries c SET failure_code = 'expired'
     WHERE c.closed_at IS NULL AND c.failure_code IS NULL
       AND ((c.sealed_at IS NOT NULL AND c.sealed_at < now() - interval '24 hours') OR (c.sealed_at IS NULL AND c.begun_at < now() - interval '24 hours'));
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    UPDATE public.state_carries c SET failure_code = 'source_removed'
     WHERE c.closed_at IS NULL AND c.failure_code IS NULL AND c.sealed_at IS NULL
       AND EXISTS (SELECT 1 FROM public.runners r WHERE r.account_id = c.account_id AND r.id = c.from_runner_id AND r.revoked_at IS NOT NULL);
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    UPDATE public.state_carries c SET closed_at = now(), closed_reason = 'cancelled'
     WHERE c.closed_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.project_placements pl WHERE pl.account_id = c.account_id AND pl.repo_id = c.repo_id);
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    DELETE FROM public.state_carry_chunks x
     WHERE EXISTS (SELECT 1 FROM public.state_carries c WHERE c.account_id = x.account_id AND c.id = x.carry_id AND (c.closed_at IS NOT NULL OR c.failure_code IS NOT NULL));
    DELETE FROM public.state_carries c WHERE c.closed_at < now() - interval '30 days';
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
    RETURN n;
  END;
  $f$;

  -- 1083's two rule functions, re-made. Move rule: a delete is not due while the cleanup has an open carry. Stop: its signed args carry exactly the cleanup's open unsealed carry ({id}), or no `carry` key.

  CREATE OR REPLACE FUNCTION public.machine_cleanup_move_due(p_cleanup uuid, p_kind text) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
    SELECT COALESCE((
      SELECT p_kind IN ('engine_session_stop', 'engine_session_delete')
         AND NOT EXISTS (
               SELECT 1 FROM public.machine_jobs x
                WHERE x.account_id = c.account_id AND x.repo_id = c.repo_id AND x.runner_id = c.runner_id AND x.kind = p_kind AND x.issued_at >= c.requested_at
                  AND (x.state IN ('issued', 'delivered', 'done') OR (x.state = 'failed' AND x.ended_at > now() - interval '60 minutes')))
         AND (p_kind = 'engine_session_stop'
              OR (NOT EXISTS (SELECT 1 FROM public.state_carries sc WHERE sc.account_id = c.account_id AND sc.cleanup_id = c.id AND sc.closed_at IS NULL)
                  AND (NOT EXISTS (SELECT 1 FROM public.project_placements pl WHERE pl.account_id = c.account_id AND pl.repo_id = c.repo_id)
              OR EXISTS (SELECT 1 FROM public.project_placements pl
                           JOIN public.engine_sessions es ON es.account_id = pl.account_id AND es.repo_id = pl.repo_id AND es.runner_id = pl.runner_id
                          WHERE pl.account_id = c.account_id AND pl.repo_id = c.repo_id AND pl.runner_id <> c.runner_id
                            AND es.session_kind = 'engine' AND es.last_heartbeat_at >= c.requested_at))))
        FROM public.machine_cleanups c
       WHERE c.id = p_cleanup AND c.reason = 'move' AND c.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    ), false);
  $f$;

  CREATE OR REPLACE FUNCTION public.machine_cleanup_issue(p_cleanup uuid, p_id uuid, p_kind text, p_job jsonb, p_issued_at timestamptz, p_expires_at timestamptz)
  RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    rid   uuid := public.machine_job_runner();
    acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    c     public.machine_cleanups%ROWTYPE;
    s     public.machine_cleanup_states%ROWTYPE;
    v_gh  bigint;
    v_carry uuid;
    epoch integer;
    j     jsonb := p_job #> '{job}';
    ok    boolean;
  BEGIN
    IF p_cleanup IS NULL OR p_id IS NULL OR p_kind IS NULL OR p_job IS NULL OR p_issued_at IS NULL OR p_expires_at IS NULL OR jsonb_typeof(j) IS DISTINCT FROM 'object'
       OR p_kind NOT IN ('engine_session_stop', 'engine_session_delete') THEN
      RAISE EXCEPTION 'machine_cleanup_issue: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO c FROM public.machine_cleanups x WHERE x.id = p_cleanup AND x.account_id = acct AND x.runner_id = rid FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'machine_cleanup_issue: no such cleanup for this runner' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM public.machine_job_expire(rid);
    SELECT x.id INTO v_carry FROM public.state_carries x WHERE x.account_id = acct AND x.cleanup_id = c.id AND x.closed_at IS NULL AND x.sealed_at IS NULL;
    SELECT * INTO s FROM public.machine_cleanup_states x WHERE x.id = c.id AND x.account_id = acct;
    IF NOT FOUND OR NOT s.open OR (p_kind = 'engine_session_delete' AND NOT c.delete_sandbox) THEN
      RAISE EXCEPTION 'machine_cleanup_issue: the cleanup is closed or the kind is not in its chain' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF c.reason = 'move' THEN
      ok := public.machine_cleanup_move_due(c.id, p_kind);
    ELSE
      ok := NOT s.live AND (s.newest_state IS NULL OR s.newest_state IN ('expired', 'superseded') OR (s.newest_state = 'failed' AND s.newest_ended_at <= now() - interval '60 minutes'));
      IF NOT ok AND p_kind = 'engine_session_delete' THEN
        -- The chain's second job: the newest stop or delete of the repo on this runner is this claim's stop, still issued, 1 ms earlier.
        ok := EXISTS (
          SELECT 1 FROM public.machine_jobs st
           WHERE st.account_id = acct AND st.repo_id = c.repo_id AND st.runner_id = rid AND st.kind = 'engine_session_stop' AND st.state = 'issued'
             AND st.issued_at >= c.requested_at AND st.issued_at = p_issued_at - interval '1 millisecond'
             AND NOT EXISTS (SELECT 1 FROM public.machine_jobs n WHERE n.account_id = acct AND n.repo_id = c.repo_id AND n.runner_id = rid
                               AND n.kind IN ('engine_session_stop', 'engine_session_delete') AND (n.issued_at, n.id) > (st.issued_at, st.id)));
      END IF;
    END IF;
    IF NOT ok THEN
      RAISE EXCEPTION 'machine_cleanup_issue: the cleanup is not due' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT r.gh_repo_id INTO v_gh FROM public.repos r WHERE r.account_id = acct AND r.id = c.repo_id;
    epoch := COALESCE((SELECT st.operate_epoch FROM public.engine_bridge_settings st WHERE st.account_id = acct), 0);
    IF j ->> 'job_id' IS DISTINCT FROM p_id::text OR j ->> 'kind' IS DISTINCT FROM p_kind OR j ->> 'runner_id' IS DISTINCT FROM rid::text
       OR jsonb_typeof(j -> 'repo_gh_id') IS DISTINCT FROM 'number' OR j ->> 'repo_gh_id' IS DISTINCT FROM v_gh::text
       OR j ? 'setup_id' OR j ->> 'requires_engine' IS DISTINCT FROM 'any'
       OR j ->> 'issued_at' IS NULL OR j ->> 'expires_at' IS NULL OR (j ->> 'issued_at')::timestamptz IS DISTINCT FROM p_issued_at OR (j ->> 'expires_at')::timestamptz IS DISTINCT FROM p_expires_at
       OR p_expires_at <= p_issued_at OR p_expires_at > p_issued_at + interval '30 minutes'
       OR p_issued_at < now() - interval '60 seconds' OR p_issued_at > now() + interval '60 seconds' OR p_issued_at < c.requested_at
       OR jsonb_typeof(j -> 'args') IS DISTINCT FROM 'object'
       OR jsonb_typeof(j #> '{args,operate_epoch}') IS DISTINCT FROM 'number' OR j #>> '{args,operate_epoch}' IS DISTINCT FROM epoch::text
       OR (p_kind = 'engine_session_stop' AND ((j -> 'args') - 'reason' - 'operate_epoch' - 'carry' <> '{}'::jsonb OR j #>> '{args,reason}' IS DISTINCT FROM c.reason
            OR (j #> '{args,carry}') IS DISTINCT FROM (CASE WHEN v_carry IS NULL THEN NULL ELSE jsonb_build_object('id', v_carry) END)))
       OR (p_kind = 'engine_session_delete' AND (j -> 'args') - 'operate_epoch' <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'machine_cleanup_issue: the job does not match the cleanup' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at)
    VALUES (p_id, acct, rid, c.repo_id, NULL, p_kind, p_job, 1, p_issued_at, p_expires_at);
  END;
  $f$;

  -- Ownership and grants (EXECUTE after the transfer: a transfer rewrites the ACL entries that named the old owner). The two helpers and the sweep reach no tenant role; the trigger function is granted as in 1105 (it cannot be called outside a trigger).
  REVOKE ALL ON FUNCTION public.state_carry_person() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_for_job(uuid, text, text[]) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_begin(uuid, integer, integer, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_chunk_put(uuid, integer, integer, text, integer, bytea, bytea, bytea) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_seal(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_fail(uuid, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_chunk_take(uuid, integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_imported(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_job_carry(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_request(uuid, uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_retarget(uuid, uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_abandon(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_retry(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_start_guard() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_sweep() FROM PUBLIC;
  ALTER FUNCTION public.state_carry_person() OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_for_job(uuid, text, text[]) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_begin(uuid, integer, integer, text) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_chunk_put(uuid, integer, integer, text, integer, bytea, bytea, bytea) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_seal(uuid) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_fail(uuid, text) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_chunk_take(uuid, integer) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_imported(uuid) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_job_carry(uuid) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_request(uuid, uuid) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_retarget(uuid, uuid) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_abandon(uuid) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_retry(uuid) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.state_carry_start_guard() OWNER TO engine_start_definer;
  ALTER FUNCTION public.state_carry_sweep() OWNER TO engine_start_definer;
  GRANT EXECUTE ON FUNCTION public.state_carry_begin(uuid, integer, integer, text) TO app_user;
  GRANT EXECUTE ON FUNCTION public.state_carry_chunk_put(uuid, integer, integer, text, integer, bytea, bytea, bytea) TO app_user;
  GRANT EXECUTE ON FUNCTION public.state_carry_seal(uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.state_carry_fail(uuid, text) TO app_user;
  GRANT EXECUTE ON FUNCTION public.state_carry_chunk_take(uuid, integer) TO app_user;
  GRANT EXECUTE ON FUNCTION public.state_carry_imported(uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.state_carry_job_carry(uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.state_carry_request(uuid, uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.state_carry_retarget(uuid, uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.state_carry_abandon(uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.state_carry_retry(uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.state_carry_sweep() TO platform_ops;
  GRANT EXECUTE ON FUNCTION public.state_carry_start_guard() TO app_user;

  REVOKE CREATE ON SCHEMA public FROM machine_jobs_owner, engine_start_definer;
  IF NOT super THEN
    REVOKE machine_jobs_owner FROM CURRENT_USER;
    REVOKE engine_start_definer FROM CURRENT_USER;
  END IF;
END
$$;
