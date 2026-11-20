-- D#845 ON-BR-4: a `bridge_enable` answered `not_found` by a search that hit its time or entry cap carries `incomplete: true`, so the Connect screen can say the search was cut short.
-- The answer lives in engine_commands.ack_result, a closed jsonb checked by engine_ack_result_ok (1042). That function is the only place that lists the keys, so it is replaced with ONE added
-- key and nothing else: `incomplete`, the JSON boolean true, allowed only with result = 'not_found'. No column, table, grant or policy changes; CREATE OR REPLACE keeps the owner, the pinned
-- search_path and the ACL (the REVOKE and GRANT after it say the same again). Rows already stored have no `incomplete` and stay valid. The constraint is not re-added: it calls the function by name.
--
-- Numbered 1046 by the Team Lead's rule (main's highest is 1044; the open PR for host load holds 1045). Re-check against main right before merging and renumber to stay above its highest.

CREATE OR REPLACE FUNCTION engine_ack_result_ok(p_kind text, p_state text, p_result jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_result IS NULL OR COALESCE(
    p_kind = 'bridge_enable' AND p_state IN ('applied', 'refused')
    AND jsonb_typeof(p_result) = 'object'
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_result) AS k WHERE k NOT IN ('result', 'root_tail', 'candidates', 'skipped', 'incomplete'))
    AND jsonb_typeof(p_result -> 'result') = 'string' AND (p_result ->> 'result') IN ('connected', 'not_found', 'ambiguous', 'refused', 'already_connected')
    AND (NOT p_result ? 'root_tail' OR (jsonb_typeof(p_result -> 'root_tail') = 'string' AND char_length(p_result ->> 'root_tail') BETWEEN 1 AND 512))
    AND (NOT p_result ? 'candidates' OR (jsonb_typeof(p_result -> 'candidates') = 'array' AND jsonb_array_length(p_result -> 'candidates') BETWEEN 1 AND 10))
    AND (NOT p_result ? 'skipped' OR (jsonb_typeof(p_result -> 'skipped') = 'array' AND jsonb_array_length(p_result -> 'skipped') BETWEEN 1 AND 10 AND (p_result ->> 'result') = 'not_found'))
    AND (NOT p_result ? 'incomplete' OR (p_result -> 'incomplete' = 'true'::jsonb AND (p_result ->> 'result') = 'not_found'))
    AND pg_column_size(p_result) <= 16384,
    false);
$$;
REVOKE ALL ON FUNCTION engine_ack_result_ok(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION engine_ack_result_ok(text, text, jsonb) TO app_user;
