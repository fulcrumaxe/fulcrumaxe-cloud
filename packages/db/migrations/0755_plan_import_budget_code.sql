-- D#483 S3-F2: plan_imports.error_code gains 'request_budget_exhausted', the code an import ends with when its request
-- budget runs out before the author trust lookups or the merged-pull-request read finish. Only the CHECK is replaced
-- (DROP then ADD in one transaction); every existing row already holds one of the old values, so the new CHECK validates
-- against all of them. The value set must equal ImportErrorCode in packages/core/src/plan/persist.ts.
--
-- 0723 is never edited (D#94 R1). The privilege bracket is copied from 0647 (D#81/#92).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

ALTER TABLE plan_imports DROP CONSTRAINT plan_imports_error_code_check;
ALTER TABLE plan_imports
  ADD CONSTRAINT plan_imports_error_code_check CHECK (error_code IN (
    'repo_not_connected', 'app_permission_missing', 'discussions_disabled', 'plan_file_inconsistent',
    'plan_file_too_large', 'token_not_read_only', 'github_unavailable', 'rate_limited_by_github',
    'request_budget_exhausted', 'plan_file_missing', 'plan_file_shape', 'interrupted', 'internal_error'));

-- Close the window opened above, matching 0647's own shape.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
