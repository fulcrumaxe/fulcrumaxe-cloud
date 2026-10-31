-- DP7-2d (D#7 C26): what the worker step needs from reversal_compensations (0933), and nothing else.
--
--   * The reason_code CHECK gains four codes the compensation step ends with: no_installation (the App is gone from the repository), repo_gone
--     (the item's repository row can no longer be addressed), rerun_would_overwrite_branch (a sandbox rebuild would push to the original branch)
--     and no_person_actor (the reversal was recorded by policy, so no Build again can be filed in a person's name). The ten 0933 codes stay.
--     Widening only: every row 0933 accepted is still accepted, and no data changes.
--   * reversal_compensation_due(limit): the ids the worker may claim, across tenants (the worker is cross-tenant, like the ask sweep). Ids only.
--     A pending row, or a row that failed with tooling_error (a transient failure) while attempts are below the cap. A row that failed with any
--     other code waits for a person: reinstalling the App, for one, does not re-run a no_installation row by itself. Owned by platform_ops like
--     0933's three definers, search_path pinned, EXECUTE for receipt_writer_invoker only, nothing for PUBLIC, refused for a platform_ops login.
-- Expand-only.

ALTER TABLE reversal_compensations DROP CONSTRAINT IF EXISTS reversal_compensations_reason_code_check;
ALTER TABLE reversal_compensations ADD CONSTRAINT reversal_compensations_reason_code_check
  CHECK (reason_code IN ('not_reversible', 'irreversible_effect', 'retraction_unavailable', 'revert_refused', 'rerun_refused', 'state_changed',
                         'head_moved', 'person_managed', 'cap_allowed', 'tooling_error',
                         'no_installation', 'repo_gone', 'rerun_would_overwrite_branch', 'no_person_actor'));

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

CREATE FUNCTION reversal_compensation_due(p_limit integer)
RETURNS TABLE (o_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'reversal_compensation_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'reversal_compensation_due: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT c.id FROM public.reversal_compensations c
   WHERE c.kind IN ('rerun', 'revert_pr') AND c.attempts < 3
     AND (c.state = 'pending' OR (c.state = 'failed' AND c.reason_code = 'tooling_error'))
     AND (SELECT public.account_is_active(c.account_id))
   ORDER BY c.updated_at, c.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION reversal_compensation_due(integer) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION reversal_compensation_due(integer) TO receipt_writer_invoker;
ALTER FUNCTION reversal_compensation_due(integer) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
