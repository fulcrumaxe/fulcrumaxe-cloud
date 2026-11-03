-- D#600 CX-9a: writing and resetting a repository's context budget.
--
-- 1. repo_context_settings.memory_slot_bytes becomes nullable, with CHECK (slot IS NOT NULL OR budget IS NOT NULL). A budget chosen on a repository
--    that never chose a memory slot would otherwise need a slot value stamped into its row, freezing today's default there. NULL in either column
--    means "the default"; a row exists only while at least one of the two is set. Every reader already treats a missing slot as the default.
-- 2. repo_context_settings_apply (the slot's writer, 0796) is replaced: a reset (NULL) now nulls the slot and drops the row only when the budget is
--    NULL too, so resetting the slot no longer deletes a stored budget (the interaction 0870 named).
-- 3. repo_context_budget_apply(p_repo, p_bytes) is new, under the same definer role and the same checks: an owner or admin of an active account,
--    never a platform_ops login. A size outside 4096..2097152 is `invalid_message`; NULL resets. It writes ONE audit row, 'context_budget.changed',
--    in the same transaction, only when the value really changes (an equal value writes nothing). The row carries the repository id and the old and
--    new size, nothing else. The role gains column grants on context_budget_bytes (select, insert, update) and EXECUTE on audit_write.
-- 4. context_rule_save (0876) is replaced with one change: a path starting with '~' is `invalid_path` (was only '~' and '~/...'), the same rule the run side
--    applies (isRuleablePath), so '~foo' can no longer be saved and then fail every run at launch. Body, owner and grants are otherwise 0876's.
-- 5. run_context_ledger_record (0915) is replaced with one change: the closed list of section trimmed reasons gains 'pin_match_limit' (see below).
-- 6. audit_write is replaced whole from 0967 (the newest definition on main), adding only 'context_budget.changed'. CREATE OR REPLACE keeps the
--    owner and grants. Another open migration that also replaces audit_write would drop this entry (last file wins): whoever merges second re-carries it.
--
-- Numbered 0974: main holds up to 0973 and no open change holds a migration. Re-check against main's highest right before merging.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'repo_context_settings_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on repo_context_settings_definer; cannot replace its functions';
    END IF;
    GRANT repo_context_settings_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO repo_context_settings_definer;

ALTER TABLE repo_context_settings
  ALTER COLUMN memory_slot_bytes DROP NOT NULL,
  ADD CONSTRAINT repo_context_settings_not_empty CHECK (memory_slot_bytes IS NOT NULL OR context_budget_bytes IS NOT NULL);
GRANT SELECT (context_budget_bytes), INSERT (context_budget_bytes), UPDATE (context_budget_bytes) ON repo_context_settings TO repo_context_settings_definer;

CREATE OR REPLACE FUNCTION repo_context_settings_apply(p_repo uuid, p_bytes integer)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  v_role text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'repo_context_settings_apply: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'repo_context_settings_apply: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo IS NULL OR (p_bytes IS NOT NULL AND p_bytes NOT BETWEEN 1024 AND 8192) THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.repos r WHERE r.id = p_repo AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repo_context_settings_apply: no such repository' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_bytes IS NULL THEN
    -- A reset nulls the slot; the row goes only when the budget is not set either.
    DELETE FROM public.repo_context_settings s WHERE s.account_id = acct AND s.repo_id = p_repo AND s.context_budget_bytes IS NULL;
    UPDATE public.repo_context_settings s SET memory_slot_bytes = NULL, updated_by = usr, updated_at = now() WHERE s.account_id = acct AND s.repo_id = p_repo;
  ELSE
    INSERT INTO public.repo_context_settings AS s (account_id, repo_id, memory_slot_bytes, updated_by)
    VALUES (acct, p_repo, p_bytes, usr)
    ON CONFLICT (account_id, repo_id) DO UPDATE SET memory_slot_bytes = EXCLUDED.memory_slot_bytes, updated_by = usr, updated_at = now();
  END IF;
END;
$$;

CREATE FUNCTION repo_context_budget_apply(p_repo uuid, p_bytes integer)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  v_role text;
  v_old  integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'repo_context_budget_apply: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'repo_context_budget_apply: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo IS NULL OR (p_bytes IS NOT NULL AND p_bytes NOT BETWEEN 4096 AND 2097152) THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.repos r WHERE r.id = p_repo AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repo_context_budget_apply: no such repository' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT s.context_budget_bytes INTO v_old FROM public.repo_context_settings s WHERE s.account_id = acct AND s.repo_id = p_repo FOR UPDATE;
  IF p_bytes IS NOT DISTINCT FROM v_old THEN
    RETURN;
  END IF;
  IF p_bytes IS NULL THEN
    DELETE FROM public.repo_context_settings s WHERE s.account_id = acct AND s.repo_id = p_repo AND s.memory_slot_bytes IS NULL;
    UPDATE public.repo_context_settings s SET context_budget_bytes = NULL, updated_by = usr, updated_at = now() WHERE s.account_id = acct AND s.repo_id = p_repo;
  ELSE
    INSERT INTO public.repo_context_settings AS s (account_id, repo_id, context_budget_bytes, updated_by)
    VALUES (acct, p_repo, p_bytes, usr)
    ON CONFLICT (account_id, repo_id) DO UPDATE SET context_budget_bytes = EXCLUDED.context_budget_bytes, updated_by = usr, updated_at = now();
  END IF;
  PERFORM public.audit_write('context_budget.changed', jsonb_build_object('repo_id', p_repo, 'from', v_old, 'to', p_bytes));
END;
$$;

REVOKE ALL ON FUNCTION repo_context_budget_apply(uuid, integer) FROM PUBLIC;
ALTER FUNCTION repo_context_budget_apply(uuid, integer) OWNER TO repo_context_settings_definer;
GRANT EXECUTE ON FUNCTION repo_context_budget_apply(uuid, integer) TO app_user;

REVOKE CREATE ON SCHEMA public FROM repo_context_settings_definer;


-- Ownership bracket for replacing context_rule_save (0876's shape; its path check now refuses every path starting with ~, as the run side does): the migration role holds the definer role only for the replacement, and the role has
-- CREATE on public only for that; both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'context_rules_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on context_rules_definer; cannot replace its functions';
    END IF;
    GRANT context_rules_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO context_rules_definer;

CREATE OR REPLACE FUNCTION context_rule_save(p_scope text, p_repo uuid, p_item uuid, p_kind text, p_path text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct     uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr      uuid;
  v_role   text;
  v_id     uuid;
  v_old    text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'context_rule_save: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The caller's own membership row (the policy shows this role no other); the role is re-derived on every call, never taken from the request.
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL
     OR (p_scope = 'repo' AND v_role NOT IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'context_rule_save: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('repo', 'item') OR p_kind IS NULL OR p_kind NOT IN ('pin', 'exclude')
     OR (p_scope = 'repo' AND (p_repo IS NULL OR p_item IS NOT NULL))
     OR (p_scope = 'item' AND (p_item IS NULL OR p_repo IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_path IS NULL OR p_path = '' OR char_length(p_path) > 512
     OR p_path ~ '[[:cntrl:]]' OR p_path ~ ('[' || chr(133) || chr(8232) || chr(8233) || ']') OR strpos(p_path, chr(92)) > 0
     OR p_path ~ '^/' OR p_path ~ '^~' OR p_path ~ '^[A-Za-z]:/'
     OR p_path ~ '(^|/)(\.|\.\.)?(/|$)'
     OR (p_kind = 'pin' AND p_path ~ '[*?]') THEN
    RAISE EXCEPTION 'invalid_path' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_scope = 'repo' THEN
    PERFORM 1 FROM public.repos r WHERE r.id = p_repo AND r.account_id = acct;
  ELSE
    PERFORM 1 FROM public.work_items w WHERE w.id = p_item AND w.account_id = acct;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'context_rule_save: no such repository or item' USING ERRCODE = 'no_data_found';
  END IF;

  -- The rule as it stands, locked, so the audit row names the kind this save replaced. A save that loses a race to insert the same path finds the
  -- winner's row on the second look and takes the update branch.
  FOR i IN 1..2 LOOP
    IF p_scope = 'repo' THEN
      SELECT c.id, c.kind INTO v_id, v_old FROM public.context_rules c
       WHERE c.account_id = acct AND c.scope = 'repo' AND c.repo_id = p_repo AND c.path = p_path FOR UPDATE;
    ELSE
      SELECT c.id, c.kind INTO v_id, v_old FROM public.context_rules c
       WHERE c.account_id = acct AND c.scope = 'item' AND c.work_item_id = p_item AND c.path = p_path FOR UPDATE;
    END IF;
    IF FOUND THEN
      UPDATE public.context_rules c SET kind = p_kind, created_by = usr, created_at = now() WHERE c.id = v_id;
      EXIT;
    END IF;
    v_id := NULL;
    v_old := NULL;
    IF p_scope = 'repo' THEN
      INSERT INTO public.context_rules AS c (account_id, scope, repo_id, kind, path, created_by)
      VALUES (acct, 'repo', p_repo, p_kind, p_path, usr)
      ON CONFLICT (account_id, repo_id, path) WHERE scope = 'repo' DO NOTHING
      RETURNING c.id INTO v_id;
    ELSE
      INSERT INTO public.context_rules AS c (account_id, scope, work_item_id, kind, path, created_by)
      VALUES (acct, 'item', p_item, p_kind, p_path, usr)
      ON CONFLICT (account_id, work_item_id, path) WHERE scope = 'item' DO NOTHING
      RETURNING c.id INTO v_id;
    END IF;
    EXIT WHEN v_id IS NOT NULL;
  END LOOP;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'context_rule_save: could not write the rule' USING ERRCODE = 'serialization_failure';
  END IF;

  PERFORM public.audit_write(
    CASE WHEN v_old IS NOT NULL AND v_old <> p_kind THEN 'context_rule.replaced' ELSE 'context_rule.saved' END,
    jsonb_build_object('scope', p_scope, 'repo_id', p_repo, 'work_item_id', p_item, 'rule_id', v_id, 'path', p_path, 'old_kind', v_old, 'new_kind', p_kind));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION context_rule_save(text, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION context_rule_save(text, uuid, uuid, text, text) TO app_user;

REVOKE CREATE ON SCHEMA public FROM context_rules_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE context_rules_definer FROM CURRENT_USER;
  END IF;
END
$$;


-- run_context_ledger_record (0915's body whole): the only change is 'pin_match_limit' in the closed list of section trimmed reasons, so a run that held pins back
-- only because the exclude matcher reached its work bound can say so apart from a real exclude. Cloud deploys first (the runner never sends it before).
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
  c_codes constant text[] := ARRAY['card', 'boundary', 'map', 'memory_stable', 'memory_item', 'spec', 'note', 'corrections', 'findings', 'output', 'repo_instructions', 'pinned', 'decisions'];
  c_reasons constant text[] := ARRAY['findings_cap', 'memory_slot', 'over_budget', 'pin_missing', 'pins_over_budget', 'pin_too_large', 'pin_excluded', 'pin_match_limit'];
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

-- audit_write: 0967's definition whole, plus 'context_budget.changed'.
CREATE OR REPLACE FUNCTION audit_write(p_action text, p_payload jsonb DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct            uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  who             uuid := current_member_user_id();
  ts              timestamptz := clock_timestamp();
  stamped_payload jsonb := p_payload;
  new_id          uuid;
BEGIN
  IF acct IS NULL THEN
    RAISE EXCEPTION 'audit_write: no app.account_id set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF who IS NULL THEN
    RAISE EXCEPTION 'audit_write: caller is not a verified member of account %', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'audit_write: account % is not active', acct
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The 0967 allowlist carried forward whole, plus the context budget action. NULL fails
  -- closed explicitly (note (b) above) instead of relying on
  -- `NOT (p_action = ANY(...))` evaluating to NULL (falsy for IF) on a
  -- NULL p_action.
  IF p_action IS NULL OR NOT (p_action = ANY (ARRAY[
    'decision_dial_changed',
    'model_connection.connect',
    'model_connection.replace',
    'model_connection.remove',
    'role_settings.mode_changed',
    'role_settings.guard_changed',
    'role_settings.model_changed',
    'run_limits.changed',
    'decision_ask_setting.changed',
    'ask_route.changed',
    'discovery_setting.changed',
    'build_concurrency.changed',
    'envelope.changed',
    'autostart_envelope.changed',
    'envelope_margin.changed',
    'context_rule.saved',
    'context_rule.replaced',
    'context_rule.removed',
    'vercel_connection.connect',
    'vercel_connection.rotate',
    'vercel_connection.remove',
    'plan_writeback_setting.changed',
    'context_budget.changed'
  ])) THEN
    RAISE EXCEPTION 'audit_write: action % is not on the allowlist', p_action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payload IS NOT NULL AND jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'audit_write: payload must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Note (c) above: bounds a single payload's serialized size, and
  -- (D#97 fix round 1) fails closed on any TOAST-compressed argument
  -- regardless of its compressed size.
  IF p_payload IS NOT NULL AND (
    pg_column_compression(p_payload) IS NOT NULL OR pg_column_size(p_payload) > 65536
  ) THEN
    RAISE EXCEPTION 'audit_write: payload exceeds 65536 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Decision (c)/note (a): a caller-supplied `actor`, `account_id` or
  -- `created_at` key inside the payload is overwritten with the stamped
  -- value, never trusted. Every other key (including nested ones) is
  -- stored exactly as sent.
  IF stamped_payload ? 'actor' THEN
    stamped_payload := stamped_payload || jsonb_build_object('actor', to_jsonb(who::text));
  END IF;
  IF stamped_payload ? 'account_id' THEN
    stamped_payload := stamped_payload || jsonb_build_object('account_id', to_jsonb(acct::text));
  END IF;
  IF stamped_payload ? 'created_at' THEN
    stamped_payload := stamped_payload || jsonb_build_object('created_at', to_jsonb(ts));
  END IF;

  INSERT INTO audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, who::text, p_action, stamped_payload, ts)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- CREATE OR REPLACE preserves the owner and grants on an unchanged signature; re-run because they are idempotent (0651's pattern).
REVOKE ALL ON FUNCTION audit_write(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO context_rules_definer;
GRANT EXECUTE ON FUNCTION audit_write(text, jsonb) TO repo_context_settings_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE repo_context_settings_definer FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
