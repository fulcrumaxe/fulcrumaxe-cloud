-- D#600 CX-2b: a runner run records the cloud's own assembled sections in the context ledger.
--
-- Until now a runner run's ledger row carried only what the runner sent in `done` (the daemon sends just the repo-map entry), so
-- `GET /runs/{id}/context` answered `sections: []` for it. The cloud knows every section it assembled (code, bytes, hash, trimmed bytes: sizes
-- and a hash, never text), so the dispatch now records them with the same definer, and the runner's `done` adds to that row. Two rules of
-- run_context_ledger_record (0792) had to change for the second write to land on the first:
--
-- 1. sections. 0792 kept the row's sections once it held any, so the runner's map entry could never join the cloud's. Now the row's sections still
--    stay as they are (a repeat of the same sections changes nothing, and a runner cannot overwrite the cloud's figures for any code), with one
--    exception: a `map` entry in a later call replaces the row's `map` in place, or is appended when the row has none (the runner's entry is the
--    map's identity: the hash of the raw text it read). A row with no sections takes the call's, as before. The result stays at 64 entries or
--    fewer. An assembled prompt can hold several sections of one code (a `note` per note, the `boundary` before and after the card), and all of
--    them are kept as sent; the merge only never adds a second `map`.
-- 2. basis. 0792 made `partial` sticky: any later call left a row `partial` unless both were `measured`. The dispatch write is a `partial` row with
--    nothing measured, so the runner's measured `done` would never have made it `measured`. A row that holds nothing measured yet (no figure, no tool
--    bytes, no compaction) takes the next call's basis. A row that holds any measure keeps the old rule. In effect a command that measured nothing
--    is the same as no command yet; the sandbox's resumed commands that did measure something behave as before.
--
-- Nothing else changes: the same signature, owner (run_context_ledger_definer), search_path, ACL (EXECUTE for agent_run_writer only) and shape
-- checks; no table, column or privilege is added; platform_ops is not involved. The body is 0792's with the two rules above. Expand only in effect
-- (one function body replaced, none dropped). A run recorded before this keeps its row as it is: no backfill.
-- Numbered 0869 (main's highest was 0868; no open change holds a migration number); re-check against main's highest right before merging, and
-- migrations merge in number order.

-- Ownership bracket (0868's shape): the migrator needs SET on the role to replace a function it owns, and the role has CREATE on public only for
-- that. Both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'run_context_ledger_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on run_context_ledger_definer; cannot replace run_context_ledger_record';
    END IF;
    GRANT run_context_ledger_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO run_context_ledger_definer;

CREATE OR REPLACE FUNCTION run_context_ledger_record(
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
    SET sections = CASE
          WHEN jsonb_array_length(l.sections) = 0 THEN EXCLUDED.sections
          ELSE (
            -- Rule 1: the row's sections stay as they are, in order, except that a `map` entry in this call replaces the row's `map` in place, or is
            -- appended when the row has none. At most 64 entries (the table's CHECK).
            SELECT COALESCE(jsonb_agg(m.e ORDER BY m.ord), '[]'::jsonb)
            FROM (
              SELECT u.ord, u.e
              FROM (
                SELECT o.ord::bigint AS ord,
                       CASE WHEN o.e ->> 'code' = 'map'
                            THEN COALESCE((SELECT nm.e FROM jsonb_array_elements(EXCLUDED.sections) WITH ORDINALITY AS nm(e, ord) WHERE nm.e ->> 'code' = 'map' ORDER BY nm.ord LIMIT 1), o.e)
                            ELSE o.e END AS e
                FROM jsonb_array_elements(l.sections) WITH ORDINALITY AS o(e, ord)
                UNION ALL
                (SELECT 1000000::bigint, nm.e
                 FROM jsonb_array_elements(EXCLUDED.sections) WITH ORDINALITY AS nm(e, ord)
                 WHERE nm.e ->> 'code' = 'map'
                   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(l.sections) AS oc WHERE oc ->> 'code' = 'map')
                 ORDER BY nm.ord LIMIT 1)
              ) AS u
              ORDER BY u.ord
              LIMIT 64
            ) AS m
          ) END,
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
        -- Rule 2: a row that measured nothing so far takes the new call's basis; otherwise `measured` only while every call was.
        basis = CASE WHEN l.first_turn_input_tokens IS NULL AND l.peak_context_tokens IS NULL AND l.cache_read_tokens IS NULL
                          AND l.cache_write_tokens IS NULL AND l.compactions = 0 AND l.tool_output_bytes = '{}'::jsonb THEN EXCLUDED.basis
                     WHEN l.basis = 'measured' AND EXCLUDED.basis = 'measured' THEN 'measured'
                     ELSE 'partial' END,
        recorded_at = now();
END;
$$;

REVOKE CREATE ON SCHEMA public FROM run_context_ledger_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE run_context_ledger_definer FROM CURRENT_USER;
  END IF;
END
$$;
