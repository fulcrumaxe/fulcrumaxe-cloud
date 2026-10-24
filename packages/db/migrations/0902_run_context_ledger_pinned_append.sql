-- D#600 CX-5c2: a local runner's `done` can add its pinned-file sections and pin reason notes to the context ledger.
--
-- run_context_ledger_record (0792, 0869, 0870, 0875, 0883) keeps the sections the dispatch write recorded and, from a later call, accepts only a `map` entry. A runner build reads
-- its pinned files on the runner and reports one `pinned` section per file plus the closed reason notes (pin_missing, pin_too_large, pin_excluded, pins_over_budget) in its `done`,
-- and the cloud cannot know them at dispatch, so they were dropped. This replaces the function with the same signature, owner, search_path and ACL, and one change to the sections
-- merge: a later call may append its `pinned` entries when the row has none yet. One shot, like the `map` rule: a second call adds nothing; within the 64-entry cap; every other code
-- (boundary, spec, card, note, ...) in a later call is still dropped and can neither be added nor overwrite the row's. All checks of the body are 0883's. Expand only.
--
-- Numbered 0902 (main's highest is 0900; 0901 is held by an open change). Re-check against main's highest right before merging: migrations merge in number order.

-- Ownership bracket (0869's shape): the migrator needs SET on the role to create the function it will hand over, and the role has CREATE on public only for
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
  p_tool_bytes jsonb, p_compactions integer, p_basis text, p_denied integer DEFAULT NULL,
  p_tool_calls jsonb DEFAULT NULL, p_assembly_ms integer DEFAULT NULL, p_assembly_cold boolean DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_max constant bigint := 1000000000000;
  c_codes constant text[] := ARRAY['card', 'boundary', 'map', 'memory_stable', 'memory_item', 'spec', 'note', 'corrections', 'findings', 'output', 'repo_instructions', 'pinned'];
  c_reasons constant text[] := ARRAY['findings_cap', 'memory_slot', 'over_budget', 'pin_missing', 'pins_over_budget', 'pin_too_large', 'pin_excluded'];
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
     OR (p_memory IS NOT NULL AND p_memory NOT BETWEEN 0 AND c_max)
     OR (p_denied IS NOT NULL AND p_denied NOT BETWEEN 0 AND 1000000)
     OR (p_tool_calls IS NOT NULL AND jsonb_typeof(p_tool_calls) <> 'object')
     OR (p_assembly_ms IS NOT NULL AND p_assembly_ms NOT BETWEEN 0 AND 3600000) THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR s IN SELECT e FROM jsonb_array_elements(p_sections) AS e LOOP
    IF jsonb_typeof(s) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(s)) <> 4 + (s ? 'trimmed_reason')::integer
       OR NOT (s ? 'code' AND s ? 'bytes' AND s ? 'sha256' AND s ? 'trimmed_bytes')
       OR jsonb_typeof(s -> 'code') <> 'string' OR jsonb_typeof(s -> 'sha256') <> 'string'
       OR jsonb_typeof(s -> 'bytes') <> 'number' OR jsonb_typeof(s -> 'trimmed_bytes') <> 'number'
       OR NOT ((s ->> 'code') = ANY (c_codes))
       OR (s ? 'trimmed_reason' AND (jsonb_typeof(s -> 'trimmed_reason') <> 'string' OR NOT ((s ->> 'trimmed_reason') = ANY (c_reasons))))
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

  IF p_tool_calls IS NOT NULL THEN
    FOR t IN SELECT k, j FROM jsonb_each(p_tool_calls) AS x(k, j) LOOP
      IF NOT (t.k = ANY (c_tools)) OR jsonb_typeof(t.j) <> 'number' OR (t.j #>> '{}') !~ '^[0-9]{1,7}$' OR (t.j #>> '{}')::integer > 1000000 THEN
        RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END LOOP;
  END IF;

  PERFORM 1 FROM public.agent_runs r WHERE r.id = p_run AND r.account_id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_context_ledger_record: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.run_context_ledger AS l
    (account_id, run_id, sections, first_turn_input_tokens, peak_context_tokens, cache_read_tokens, cache_write_tokens, memory_tokens, tool_output_bytes, compactions, basis, denied_tool_calls, tool_call_counts, assembly_ms, assembly_cold)
  VALUES (p_account, p_run, p_sections, p_first, p_peak, p_cache_read, p_cache_write, p_memory, p_tool_bytes, p_compactions, p_basis, p_denied, p_tool_calls, p_assembly_ms, p_assembly_cold)
  ON CONFLICT (account_id, run_id) DO UPDATE
    SET sections = CASE
          WHEN jsonb_array_length(l.sections) = 0 THEN EXCLUDED.sections
          ELSE (
            -- Rule 1: the row's sections stay as they are, in order, except that a `map` entry in this call replaces the row's `map` in place, or is
            -- appended when the row has none, and (rule 1b below) `pinned` entries are appended once. At most 64 entries (the table's CHECK).
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
                UNION ALL
                -- Rule 1b (CX-5c2): a runner's `done` may add its `pinned` entries (one per pinned file, and the reason notes) once, when the row has none yet. They are
                -- appended after the row's own entries and the map, in the order sent. A row that already has any `pinned` entry takes none, so a repeat cannot double them.
                -- No other code is added or replaced by this call.
                SELECT 2000000::bigint + np.ord, np.e
                FROM jsonb_array_elements(EXCLUDED.sections) WITH ORDINALITY AS np(e, ord)
                WHERE np.e ->> 'code' = 'pinned'
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(l.sections) AS oc WHERE oc ->> 'code' = 'pinned')
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
        -- Refused tool calls add across a run's commands (a resume is a second command); a call that carries none leaves the row's figure, and a row that
        -- never had one stays null ("Not recorded").
        denied_tool_calls = CASE WHEN l.denied_tool_calls IS NULL THEN EXCLUDED.denied_tool_calls
                                 WHEN EXCLUDED.denied_tool_calls IS NULL THEN l.denied_tool_calls
                                 ELSE least(l.denied_tool_calls + EXCLUDED.denied_tool_calls, 1000000) END,
        -- CX-10a: tool calls add per tool across a run's commands (capped); a call that carries none leaves the row's; a row that never had any stays null. The assembly
        -- time and its cold flag keep the first non-null value (the first command's, like the first turn).
        tool_call_counts = CASE WHEN l.tool_call_counts IS NULL THEN EXCLUDED.tool_call_counts
                                WHEN EXCLUDED.tool_call_counts IS NULL THEN l.tool_call_counts
                                ELSE (
                                  SELECT COALESCE(jsonb_object_agg(m.k, least(m.total, 1000000)), '{}'::jsonb)
                                  FROM (SELECT u.k, sum(u.n) AS total
                                        FROM (SELECT a.key AS k, (a.value #>> '{}')::numeric AS n FROM jsonb_each(l.tool_call_counts) AS a
                                              UNION ALL
                                              SELECT b.key, (b.value #>> '{}')::numeric FROM jsonb_each(EXCLUDED.tool_call_counts) AS b) AS u
                                        GROUP BY u.k) AS m
                                ) END,
        assembly_ms = COALESCE(l.assembly_ms, EXCLUDED.assembly_ms),
        assembly_cold = COALESCE(l.assembly_cold, EXCLUDED.assembly_cold),
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
