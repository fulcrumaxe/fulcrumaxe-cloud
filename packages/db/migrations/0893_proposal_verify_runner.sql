-- D#483 S4-b2c: the claim verifier as a light runner job, for cloud-verified repositories.
--
-- Two parts.
--
-- 1. runner_capabilities: the job kinds a runner said on its latest hello that it can run beyond its protocol version (closed codes; today only
--    'proposal_verifier'). One row per runner, rewritten on EVERY hello (an empty list when the runner sent none), so a runner that is downgraded
--    loses what it no longer sends. The claim offers a capability-gated role (the claim verifier) only to a runner whose row lists it. A claim by a
--    semi-trusted machine: it narrows what the claim offers and never widens a permission.
--    A side table, not a column of runners: platform_ops holds a table-wide write on runners (0711), which a new column would inherit (the reason
--    0783 keeps runner_facts aside). Written only by runner_capabilities_record, owned by its own role runner_capabilities_definer (0783's shape:
--    NOLOGIN, no member, a member of nothing, column grants for exactly what the body reads and writes, a pinned search_path, EXECUTE for app_user
--    alone). It names the runner from app.runner_id, which only the signature-verifying runner middleware sets. platform_ops gets nothing.
--
-- 2. proposal_verify_list_due (0889) now also lists a proposal whose repository is cloud-verified ('runner_verified'): its verifier runs on the
--    person's runner, and our cloud re-reads every cite at the pinned commit, as it already reads that repository for its reviews. A Local-only
--    repository ('runner_local') is still left out: its promise is that our cloud never receives its source files, so it waits for a runner-side
--    check (a later row). The lister's grants are unchanged; only its repository policy and its body name the second mode.
--
-- Expand-only: a role, a table and a function are added; the lister widens to one more mode. Numbered above the highest migration on the code
-- plane (0891) and the claim of an open pull request (0890). Re-check right before the pull request is opened and again before merging.

DO $$
DECLARE
  n text := 'runner_capabilities_definer';
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

CREATE TABLE runner_capabilities (
  runner_id    uuid PRIMARY KEY,
  account_id   uuid NOT NULL,
  capabilities text[] NOT NULL DEFAULT '{}'
    CONSTRAINT runner_capabilities_values_check CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier']::text[])),
  reported_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE
);
ALTER TABLE runner_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_capabilities FORCE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO runner_capabilities_definer;
GRANT SELECT (runner_id, account_id, capabilities, reported_at),
      INSERT (runner_id, account_id, capabilities, reported_at),
      UPDATE (capabilities, reported_at) ON runner_capabilities TO runner_capabilities_definer;
GRANT SELECT (id, account_id, revoked_at) ON runners TO runner_capabilities_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_capabilities_definer;
GRANT SELECT (runner_id, account_id, capabilities, reported_at) ON runner_capabilities TO app_user;

CREATE POLICY tenant_isolation_select ON runner_capabilities FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));
CREATE POLICY runner_capabilities_definer_select ON runner_capabilities FOR SELECT TO runner_capabilities_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_capabilities_definer_insert ON runner_capabilities FOR INSERT TO runner_capabilities_definer WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_capabilities_definer_update ON runner_capabilities FOR UPDATE TO runner_capabilities_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_capabilities_definer_select ON runners FOR SELECT TO runner_capabilities_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_capabilities_definer_select ON accounts FOR SELECT TO runner_capabilities_definer USING (true);

-- ---- ownership bracket (0783's shape), for both definers this file creates or replaces -----------------------------------
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_capabilities_definer', 'proposal_verify_lister'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot ALTER FUNCTION ... OWNER TO %', n, n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
    END LOOP;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_capabilities_definer;

CREATE FUNCTION runner_capabilities_record(p_capabilities text[])
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
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier']))
     OR (SELECT count(*) <> count(DISTINCT c) FROM unnest(p_capabilities) c) THEN
    RAISE EXCEPTION 'runner_capabilities_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.runner_capabilities AS c (runner_id, account_id, capabilities)
  VALUES (raw::uuid, acct, p_capabilities)
  ON CONFLICT (runner_id) DO UPDATE SET capabilities = EXCLUDED.capabilities, reported_at = now();
END;
$$;
REVOKE ALL ON FUNCTION runner_capabilities_record(text[]) FROM PUBLIC;
ALTER FUNCTION runner_capabilities_record(text[]) OWNER TO runner_capabilities_definer;
GRANT EXECUTE ON FUNCTION runner_capabilities_record(text[]) TO app_user;
REVOKE CREATE ON SCHEMA public FROM runner_capabilities_definer;

-- ---- the lister: one more mode ---------------------------------------------------------------------------------------------
DROP POLICY proposal_verify_lister_select ON repos;
CREATE POLICY proposal_verify_lister_select ON repos FOR SELECT TO proposal_verify_lister USING (execution_mode IN ('sandbox', 'runner_verified'));

CREATE OR REPLACE FUNCTION proposal_verify_list_due(p_limit int)
RETURNS TABLE (account_id uuid, proposal_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'proposal_verify_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'proposal_verify_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT d.account_id, d.id
    FROM (
      SELECT p.account_id, p.id, p.created_at,
             row_number() OVER (PARTITION BY p.account_id ORDER BY p.created_at, p.id) AS rn
        FROM public.proposals p
        JOIN public.accounts a ON a.id = p.account_id AND a.deleted_at IS NULL
        JOIN public.repos r ON r.account_id = p.account_id AND r.id = p.repo_id AND r.execution_mode IN ('sandbox', 'runner_verified')
       WHERE p.state = 'new' AND p.owner_process = 'product'
         AND (p.verification = 'pending' OR (p.verification = 'check_failed' AND p.verify_attempts < 3))
    ) d
   WHERE d.rn <= 10
   ORDER BY d.created_at, d.id
   LIMIT p_limit;
END $$;

DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_capabilities_definer', 'proposal_verify_lister'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', n);
    END LOOP;
  END IF;
END
$$;
