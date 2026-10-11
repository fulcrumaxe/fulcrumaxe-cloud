-- D#600 CX-1a: the per-run context ledger. One row per run saying what the run loaded and how big its context grew.
--
-- 1. run_context_ledger, keyed (account_id, run_id), removed with its run (ON DELETE CASCADE).
--      sections            the prompt's sections as an array of {code, bytes, sha256, trimmed_bytes}; code is a closed enum
--      first_turn_input_tokens, peak_context_tokens, cache_read_tokens, cache_write_tokens, memory_tokens
--                          integers, NULL when not measured ("Not recorded" on screen, never 0)
--      tool_output_bytes   an object keyed by a closed tool enum, byte counts
--      compactions         the CLI's compact_boundary events
--      basis               'measured' (per-turn usage seen) or 'partial' (anything less: a gateway run, an older runner, a stream with no usage)
--    Integers and enums only: no prompt text, path or tool input is stored. The money fields stay in runner_run_usage (0768); this table
--    duplicates none of them. Row security is forced and tenant-scoped like runner_run_usage: app_user reads its own account's rows and can
--    write nothing; the only writer is run_context_ledger_record below.
--
-- 2. run_context_ledger_record(...) adds one command's measure to the run's row (creating it on the first call). A resumed run measures each
--    command separately, so a later call merges: first turn and sections stay, the peak is the larger, sums add. It trusts nothing it is
--    passed: the account must be the session's tenant, the run must be that account's, every value is range- and shape-checked, and a
--    section code or tool name outside the closed enums is refused with the message 'invalid_message' (22023) and nothing is written.
--    It is owned by run_context_ledger_definer (NOLOGIN, a member of nothing, column grants for exactly what the body reads and writes,
--    a pinned search_path). EXECUTE goes to agent_run_writer alone: the sandbox target records on the runner login, and no member's session
--    needs to write a ledger. platform_ops gains nothing and a platform_ops session is refused.
--
-- Numbered 0792 (reserved for this PR). It merges after 0783, in number order.

DO $$
DECLARE
  n text := 'run_context_ledger_definer';
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

CREATE TABLE run_context_ledger (
  account_id              uuid NOT NULL,
  run_id                  uuid NOT NULL,
  sections                jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sections) = 'array' AND jsonb_array_length(sections) <= 64),
  first_turn_input_tokens bigint CHECK (first_turn_input_tokens IS NULL OR first_turn_input_tokens BETWEEN 0 AND 1000000000000),
  peak_context_tokens     bigint CHECK (peak_context_tokens IS NULL OR peak_context_tokens BETWEEN 0 AND 1000000000000),
  cache_read_tokens       bigint CHECK (cache_read_tokens IS NULL OR cache_read_tokens BETWEEN 0 AND 1000000000000),
  cache_write_tokens      bigint CHECK (cache_write_tokens IS NULL OR cache_write_tokens BETWEEN 0 AND 1000000000000),
  memory_tokens           bigint CHECK (memory_tokens IS NULL OR memory_tokens BETWEEN 0 AND 1000000000000),
  tool_output_bytes       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tool_output_bytes) = 'object'),
  compactions             integer NOT NULL DEFAULT 0 CHECK (compactions BETWEEN 0 AND 1000000),
  basis                   text NOT NULL CHECK (basis IN ('measured', 'partial')),
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, run_id),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE,
  CHECK (basis = 'partial' OR (first_turn_input_tokens IS NOT NULL AND peak_context_tokens IS NOT NULL))
);

ALTER TABLE run_context_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_context_ledger FORCE ROW LEVEL SECURITY;

-- Readers: the account's own members, through the API. They can write nothing.
GRANT SELECT ON run_context_ledger TO app_user;
CREATE POLICY tenant_isolation ON run_context_ledger FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );

-- The definer role: what the body reads and writes, column by column.
GRANT SELECT (id, account_id) ON agent_runs TO run_context_ledger_definer;
GRANT SELECT, INSERT, UPDATE ON run_context_ledger TO run_context_ledger_definer;
GRANT USAGE ON SCHEMA public TO run_context_ledger_definer;

CREATE POLICY run_context_ledger_definer_select ON agent_runs FOR SELECT TO run_context_ledger_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_context_ledger_definer_select ON run_context_ledger FOR SELECT TO run_context_ledger_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_context_ledger_definer_insert ON run_context_ledger FOR INSERT TO run_context_ledger_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY run_context_ledger_definer_update ON run_context_ledger FOR UPDATE TO run_context_ledger_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

CREATE FUNCTION run_context_ledger_record(
  p_account uuid, p_run uuid, p_sections jsonb,
  p_first bigint, p_peak bigint, p_cache_read bigint, p_cache_write bigint, p_memory bigint,
  p_tool_bytes jsonb, p_compactions integer, p_basis text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_max constant bigint := 1000000000000;
  c_codes constant text[] := ARRAY['card', 'boundary', 'map', 'memory_stable', 'memory_item', 'spec', 'note', 'corrections', 'findings', 'output', 'repo_instructions'];
  c_tools constant text[] := ARRAY['Read', 'Grep', 'Glob', 'LS', 'Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'other'];
  s jsonb;
  t record;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_context_ledger_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account IS NULL OR p_run IS NULL OR p_account IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid THEN
    RAISE EXCEPTION 'run_context_ledger_record: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Shape. Every refusal is the same fixed message: an argument value never reaches an error.
  IF p_basis IS NULL OR p_basis NOT IN ('measured', 'partial')
     OR p_sections IS NULL OR jsonb_typeof(p_sections) <> 'array' OR jsonb_array_length(p_sections) > 64
     OR p_tool_bytes IS NULL OR jsonb_typeof(p_tool_bytes) <> 'object'
     OR p_compactions IS NULL OR p_compactions NOT BETWEEN 0 AND 1000000
     OR (p_basis = 'measured' AND (p_first IS NULL OR p_peak IS NULL))
     OR (p_first IS NOT NULL AND p_first NOT BETWEEN 0 AND c_max)
     OR (p_peak IS NOT NULL AND p_peak NOT BETWEEN 0 AND c_max)
     OR (p_first IS NOT NULL AND p_peak IS NOT NULL AND p_peak < p_first)
     OR (p_cache_read IS NOT NULL AND p_cache_read NOT BETWEEN 0 AND c_max)
     OR (p_cache_write IS NOT NULL AND p_cache_write NOT BETWEEN 0 AND c_max)
     OR (p_memory IS NOT NULL AND p_memory NOT BETWEEN 0 AND c_max) THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR s IN SELECT e FROM jsonb_array_elements(p_sections) AS e LOOP
    IF jsonb_typeof(s) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(s)) <> 4
       OR NOT (s ? 'code' AND s ? 'bytes' AND s ? 'sha256' AND s ? 'trimmed_bytes')
       OR jsonb_typeof(s -> 'code') <> 'string' OR jsonb_typeof(s -> 'sha256') <> 'string'
       OR jsonb_typeof(s -> 'bytes') <> 'number' OR jsonb_typeof(s -> 'trimmed_bytes') <> 'number'
       OR NOT ((s ->> 'code') = ANY (c_codes))
       OR (s ->> 'sha256') !~ '^[0-9a-f]{64}$'
       OR (s ->> 'bytes') !~ '^[0-9]{1,12}$' OR (s ->> 'trimmed_bytes') !~ '^[0-9]{1,12}$' THEN
      RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;
  FOR t IN SELECT k, j FROM jsonb_each(p_tool_bytes) AS x(k, j) LOOP
    IF NOT (t.k = ANY (c_tools)) OR jsonb_typeof(t.j) <> 'number' OR (t.j #>> '{}') !~ '^[0-9]{1,12}$' THEN
      RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;

  PERFORM 1 FROM public.agent_runs r WHERE r.id = p_run AND r.account_id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_context_ledger_record: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.run_context_ledger AS l
    (account_id, run_id, sections, first_turn_input_tokens, peak_context_tokens, cache_read_tokens, cache_write_tokens, memory_tokens, tool_output_bytes, compactions, basis)
  VALUES (p_account, p_run, p_sections, p_first, p_peak, p_cache_read, p_cache_write, p_memory, p_tool_bytes, p_compactions, p_basis)
  ON CONFLICT (account_id, run_id) DO UPDATE
    SET sections = CASE WHEN jsonb_array_length(l.sections) = 0 THEN EXCLUDED.sections ELSE l.sections END,
        first_turn_input_tokens = COALESCE(l.first_turn_input_tokens, EXCLUDED.first_turn_input_tokens),
        peak_context_tokens = CASE WHEN l.peak_context_tokens IS NULL THEN EXCLUDED.peak_context_tokens
                                   WHEN EXCLUDED.peak_context_tokens IS NULL THEN l.peak_context_tokens
                                   ELSE greatest(l.peak_context_tokens, EXCLUDED.peak_context_tokens) END,
        cache_read_tokens = CASE WHEN l.cache_read_tokens IS NULL THEN EXCLUDED.cache_read_tokens
                                 WHEN EXCLUDED.cache_read_tokens IS NULL THEN l.cache_read_tokens
                                 ELSE least(l.cache_read_tokens + EXCLUDED.cache_read_tokens, c_max) END,
        cache_write_tokens = CASE WHEN l.cache_write_tokens IS NULL THEN EXCLUDED.cache_write_tokens
                                  WHEN EXCLUDED.cache_write_tokens IS NULL THEN l.cache_write_tokens
                                  ELSE least(l.cache_write_tokens + EXCLUDED.cache_write_tokens, c_max) END,
        memory_tokens = COALESCE(l.memory_tokens, EXCLUDED.memory_tokens),
        tool_output_bytes = (
          SELECT COALESCE(jsonb_object_agg(m.k, least(m.total, c_max)), '{}'::jsonb)
          FROM (SELECT u.k, sum(u.n) AS total
                FROM (SELECT a.key AS k, (a.value #>> '{}')::numeric AS n FROM jsonb_each(l.tool_output_bytes) AS a
                      UNION ALL
                      SELECT b.key, (b.value #>> '{}')::numeric FROM jsonb_each(EXCLUDED.tool_output_bytes) AS b) AS u
                GROUP BY u.k) AS m
        ),
        compactions = least(l.compactions + EXCLUDED.compactions, 1000000),
        basis = CASE WHEN l.basis = 'measured' AND EXCLUDED.basis = 'measured' THEN 'measured' ELSE 'partial' END,
        recorded_at = now();
END;
$$;

-- The migration role holds the new role (with ADMIN from creating it) only to hand the function over, and the role has CREATE on public
-- only for that transfer; both are reset at the end. platform_ops is not involved at all.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'run_context_ledger_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on run_context_ledger_definer; cannot ALTER FUNCTION ... OWNER TO run_context_ledger_definer';
    END IF;
    GRANT run_context_ledger_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO run_context_ledger_definer;

REVOKE ALL ON FUNCTION run_context_ledger_record(uuid, uuid, jsonb, bigint, bigint, bigint, bigint, bigint, jsonb, integer, text) FROM PUBLIC;
ALTER FUNCTION run_context_ledger_record(uuid, uuid, jsonb, bigint, bigint, bigint, bigint, bigint, jsonb, integer, text) OWNER TO run_context_ledger_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION run_context_ledger_record(uuid, uuid, jsonb, bigint, bigint, bigint, bigint, bigint, jsonb, integer, text) TO agent_run_writer;

REVOKE CREATE ON SCHEMA public FROM run_context_ledger_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE run_context_ledger_definer FROM CURRENT_USER;
  END IF;
END
$$;
